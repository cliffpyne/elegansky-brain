/**
 * BRAIN: payment-batches data plane. The bridge that replaces SaasAnt:
 * invoice-payment-app POSTs paid + unused (the output of the sacred matching
 * logic) and BRAIN turns them into QB Payments + CreditMemos under one
 * recallable batch envelope.
 *
 * Critical invariants — never violate:
 *   1. sum(paid) + sum(unused) == BRAIN-side sheet sum  (auto-block mismatch)
 *   2. All-or-nothing: any QB error during upload triggers full rollback
 *      (void what's been posted so far, release consumed refs)
 *   3. Bank refs in CONSUMED state can NEVER be in another active batch
 *   4. Recall is the whole batch; never a single Payment
 *   5. Idempotency: a second POST with the same key returns the first
 *      batch's result instead of running QB twice
 *   6. Re-run after recall uses the STORED arrears snapshot, never today's
 *
 * Routes:
 *   POST /api/arrears-snapshots             — store once per run
 *   POST /api/payment-batches               — atomic upload (the big one)
 *   POST /api/payment-batches/:id/recall    — admin click
 *   POST /api/payment-batches/:id/rerun     — return stored snapshot for redo
 *   GET  /api/payment-batches               — dashboard list
 *   GET  /api/payment-batches/:id           — dashboard drilldown
 *   GET  /api/consumed-transactions/:ref    — caller-side sanity check
 */

import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from './db/pool.js';
import { readSheet, writeSheetCells, paintRowEndMarker, protectMarkerColumns, clearSheetColumn } from './sheets.js';
import { qbQuery, qbReport } from './qb-client.js';

const { STATEMENT_REPORT_SECRET, SUPABASE_URL } = process.env;

const SUPABASE_JWKS = SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

export function mountPaymentBatchesApi(app, deps) {
  const {
    qbCreatePayment, qbBatchCreatePayments,
    qbCreateUnappliedPayment, qbBatchCreateUnappliedPayments,
    qbBatchLookupCustomers,
    qbCreateCreditMemo,  // kept only for backwards-compat callers; do not use for new work
    qbPreflightDedup,    // strict (customer, ref) dedup against live QB Payment + CreditMemo
    qbVoid, ensureQbConnected,
  } = deps;

  // Startup check: log any pending batches older than 1 hour. Surfaces stuck
  // batches from a previous crash so the operator can investigate. Doesn't
  // auto-rollback — that's deliberate, money has already moved.
  setTimeout(async () => {
    try {
      const r = await db().query(
        `SELECT id, channel, created_at, paid_count
           FROM payment_batches
          WHERE status='pending' AND created_at < now() - interval '1 hour'
          ORDER BY created_at`,
      );
      if (r.rows.length) {
        console.warn(`[startup] ⚠ ${r.rows.length} pending batches stuck > 1h:`);
        for (const row of r.rows) {
          console.warn(`  - ${row.id} (${row.channel}, ${row.paid_count} paid, since ${row.created_at.toISOString()})`);
        }
      }
    } catch (err) {
      console.error('[startup] pending-batches check failed:', err.message);
    }
  }, 5000);


  // ── POST /api/arrears-snapshots ──────────────────────────────────────────
  // One snapshot per run; subsequent batches in the same run share it via id.
  app.post('/api/arrears-snapshots', requireSharedSecret, async (req, res) => {
    try {
      const body = req.body ?? {};
      if (!Array.isArray(body.data)) return res.status(400).json({ error: 'data must be an array' });
      const asOf = body.as_of || new Date().toISOString().slice(0, 10);
      const totalBalance = body.data.reduce((s, r) => s + (Number(r.balance) || 0), 0);

      const r = await db().query(
        `INSERT INTO arrears_snapshots (as_of, data, row_count, total_balance, created_by, notes)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, created_at, row_count, total_balance, as_of`,
        [
          asOf,
          JSON.stringify(body.data),
          body.data.length,
          totalBalance,
          body.created_by || 'invoice-payment-app',
          body.notes || null,
        ],
      );
      res.status(201).json({ snapshot: r.rows[0] });
    } catch (err) {
      console.error('[POST /api/arrears-snapshots]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/payment-batches — THE BIG ONE ──────────────────────────────
  //
  // Body shape:
  // {
  //   idempotency_key:    "sha256-of-payload",
  //   arrears_snapshot_id: "uuid",
  //   sheet_id:           "1rd...",
  //   sheet_tab:          "PASSED",
  //   channel:            "bank" | "iphone_bank" | "nmbnew",
  //   bank_refs:          ["REF:abc...", ...],   ← ALL refs in this batch
  //   paid:    [{ bank_ref, customer_id, invoice_qb_id, invoice_no, amount, memo }],
  //   unused:  [{ bank_ref, customer_id, customer_name, amount, memo }],
  //   created_by: "invoice-payment-app@hostname"
  // }
  //
  // Returns:
  //   201 { batch: {...}, idempotent_replay: false }
  //   200 { batch: {...}, idempotent_replay: true }    ← same key, prior run
  //   400/403/409/422 with { error: "..." }            ← gate failures
  //   500 + rolled_back on QB error mid-flight
  app.post('/api/payment-batches', requireSharedSecret, async (req, res) => {
    const body = req.body ?? {};

    // ── 1. Idempotency ────────────────────────────────────────────────────
    if (!body.idempotency_key || typeof body.idempotency_key !== 'string') {
      return res.status(400).json({ error: 'idempotency_key required' });
    }
    const existing = await db().query(
      `SELECT * FROM payment_batches WHERE idempotency_key = $1`,
      [body.idempotency_key],
    );
    if (existing.rows.length) {
      return res.json({ batch: existing.rows[0], idempotent_replay: true });
    }

    // ── 2. Body validation ────────────────────────────────────────────────
    const v = validateBatchBody(body);
    if (v.error) return res.status(400).json({ error: v.error });

    // ── 3. Allow/deny check ───────────────────────────────────────────────
    const sheetCfg = await getSheetConfig(body.sheet_id);
    if (sheetCfg.denied) return res.status(403).json({ error: sheetCfg.reason });
    if (!sheetCfg.allowed) {
      return res.status(403).json({
        error: `sheet_id ${body.sheet_id} is not in app_settings.sheet_allowlist`,
      });
    }
    if (sheetCfg.config.channel !== body.channel) {
      return res.status(400).json({
        error: `channel ${body.channel} does not match sheet allowlist channel ${sheetCfg.config.channel}`,
      });
    }
    if (sheetCfg.config.tab !== body.sheet_tab) {
      return res.status(400).json({
        error: `sheet_tab ${body.sheet_tab} does not match allowlist tab ${sheetCfg.config.tab}`,
      });
    }

    // ── 4. Consumed-ref check (the gate) ──────────────────────────────────
    const refsSet = Array.from(new Set(body.bank_refs.map(String)));
    const consumedRows = await db().query(
      `SELECT bank_ref, batch_id FROM consumed_transactions WHERE bank_ref = ANY($1)`,
      [refsSet],
    );
    if (consumedRows.rows.length) {
      return res.status(409).json({
        error: 'one or more bank_refs are already in an active batch',
        already_consumed: consumedRows.rows,
      });
    }

    // ── 5. Sheet-side sum (BRAIN's independent check) ────────────────────
    let sheetSum;
    try {
      sheetSum = await sumSheetForRefs({
        sheetId: body.sheet_id,
        tab: body.sheet_tab,
        cfg: sheetCfg.config,
        wantedRefs: refsSet,
        channel: body.channel,
      });
    } catch (err) {
      return res.status(500).json({ error: 'sheet sum failed: ' + err.message });
    }

    const paidTotal = body.paid.reduce((s, r) => s + Number(r.amount || 0), 0);
    const unusedTotal = body.unused.reduce((s, r) => s + Number(r.amount || 0), 0);
    const clientTotal = round2(paidTotal + unusedTotal);
    const brainTotal = round2(sheetSum.total);

    if (sheetSum.missingRefs.length) {
      return res.status(422).json({
        error: 'some bank_refs were not found in the sheet — refusing to upload',
        missing: sheetSum.missingRefs,
      });
    }
    if (clientTotal !== brainTotal) {
      return res.status(422).json({
        error: 'reconciliation mismatch — refusing to upload',
        sheet_total: brainTotal,
        paid_total: round2(paidTotal),
        unused_total: round2(unusedTotal),
        client_total: clientTotal,
        difference: round2(clientTotal - brainTotal),
      });
    }

    // ── 6. QB connection check (cheap — does not call QB) ─────────────────
    try {
      await ensureQbConnected();
    } catch (err) {
      return res.status(503).json({ error: 'QuickBooks not connected: ' + err.message });
    }

    // ── 7. Insert batch row (pending) + lock refs in consumed_transactions ─
    const client = await db().connect();
    let batch;
    try {
      await client.query('BEGIN');
      const b = await client.query(
        `INSERT INTO payment_batches (
           idempotency_key, status, arrears_snapshot_id,
           sheet_id, sheet_tab, channel, bank_refs,
           sheet_total, paid_total, unused_total,
           paid_count, unused_count, created_by
         ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
         RETURNING *`,
        [
          body.idempotency_key, body.arrears_snapshot_id,
          body.sheet_id, body.sheet_tab, body.channel, refsSet,
          brainTotal, round2(paidTotal), round2(unusedTotal),
          body.paid.length, body.unused.length,
          body.created_by || null,
        ],
      );
      batch = b.rows[0];
      // Lock every ref in one shot — fails if anyone snuck in since check.
      for (const ref of refsSet) {
        await client.query(
          `INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ($1, $2)`,
          [ref, batch.id],
        );
      }
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      client.release();
      // Most likely conflict — another caller raced us between step 4 + 7.
      if (err.code === '23505') {
        return res.status(409).json({ error: 'bank_ref race detected — retry' });
      }
      return res.status(500).json({ error: err.message });
    }
    client.release();

    // ── 8. QB calls + per-upload row tracking ─────────────────────────────
    const uploaded = []; // for rollback
    const failed = [];
    try {
      // Payments first.
      for (let i = 0; i < body.paid.length; i++) {
        const row = body.paid[i];
        const qb = await qbCreatePayment({
          customerId: row.customer_id,
          invoiceQbId: row.invoice_qb_id,
          amount: Number(row.amount),
          memo: row.memo || '',
        });
        const upload = await recordUpload({
          batchId: batch.id, kind: 'payment', row, qbId: qb.id,
          qbResponse: qb.response, status: 'created',
        });
        uploaded.push(upload);
      }
      // Unused side: customer-matched rows go to QB as unapplied Payments
      // (Payment without LinkedTxn — Frank's rule from 2026-06-04; CreditMemo
      // is deprecated). Rows without customer_id get queued for SaasAnt.
      for (let i = 0; i < body.unused.length; i++) {
        const row = body.unused[i];
        if (!row.customer_id) {
          await recordUpload({
            batchId: batch.id, kind: 'payment', row, qbId: null,
            qbResponse: null, status: 'needs_saasant',
          });
          continue;
        }
        const qb = await qbCreateUnappliedPayment({
          customerId: row.customer_id,
          amount: Number(row.amount),
          memo: row.memo || '',
        });
        const upload = await recordUpload({
          batchId: batch.id, kind: 'payment', row, qbId: qb.id,
          qbResponse: qb.response, status: 'created',
        });
        uploaded.push(upload);
      }
    } catch (err) {
      // ── ROLLBACK PATH ──
      console.error(`[payment-batches] QB error mid-flight, rolling back`, err);
      const voidResults = await voidUploadsBestEffort(uploaded, qbVoid);
      const c = await db().connect();
      try {
        await c.query('BEGIN');
        await c.query(
          `UPDATE payment_batches SET status='rolled_back', rolled_back_at=now(),
             failure_reason=$2 WHERE id=$1`,
          [batch.id, String(err.message || err).slice(0, 1000)],
        );
        await c.query(`DELETE FROM consumed_transactions WHERE batch_id=$1`, [batch.id]);
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
      } finally {
        c.release();
      }
      const b2 = await db().query(`SELECT * FROM payment_batches WHERE id=$1`, [batch.id]);
      return res.status(500).json({
        error: 'QB upload failed mid-batch — rolled back',
        original_error: err.message,
        batch: b2.rows[0],
        void_results: voidResults,
      });
    }

    // ── 9. Mark finalized ─────────────────────────────────────────────────
    await db().query(
      `UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`,
      [batch.id],
    );
    const b3 = await db().query(`SELECT * FROM payment_batches WHERE id=$1`, [batch.id]);
    res.status(201).json({
      batch: b3.rows[0],
      idempotent_replay: false,
      uploaded_count: uploaded.length,
      payments: uploaded.filter((u) => u.kind === 'payment').length,
      credit_memos: uploaded.filter((u) => u.kind === 'credit_memo').length,
    });
  });

  // ── POST /api/payment-batches/auto-upload/:channel ───────────────────────
  // The hourly cycle's "match-and-post" step. The worker calls this after
  // each statement pull; we run the verbatim invoice-payment-app algorithm
  // against current /arrears + the channel's sheet, then create QB Payments
  // for every match (concurrent + retry) and record unmatched rows for
  // officer review. Returns immediately with the batch id; processing
  // continues in the background so the worker can move on.
  //
  // Body (optional):
  //   { since_iso?: ISO8601, until_iso?: ISO8601 }   — defaults: last 24h
  app.post('/api/payment-batches/auto-upload/:channel', requireSecretOrJwt, async (req, res) => {
    const channel = req.params.channel;
    if (!['nmbnew', 'bank', 'iphone_bank'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be nmbnew, bank, or iphone_bank' });
    }
    // ─── KILL SWITCH (scheduled-tick automation only) ─────────────────
    // app_settings.auto_upload_enabled = 'false' blocks AUTOMATION
    // callers — cron-scheduled agent sessions firing scheduled ticks
    // (meru0300, hanang0700, kili1615, etc).
    //
    // Two bypass paths for operator-initiated fires:
    //   (1) req.user populated by requireSecretOrJwt = direct dashboard
    //       call with Supabase JWT
    //   (2) tick_name === 'heisenberg' = operator-initiated heisenberg
    //       agent session (dashboard → /fire-agent → agent →
    //       run_upload_window tool → here, via shared secret). The
    //       agent's tool layer always passes tick_name=heisenberg for
    //       these so we can recognise the operator-initiated path.
    //
    // Operator policy (2026-06-06): auto_upload_enabled stays FALSE in
    // production until the scheduler architecture is hardened. Manual
    // heisenberg fires from the dashboard remain the only legitimate
    // upload path.
    const tickName = String(req.body?.tick_name || '').toLowerCase();
    const isManualHeisenberg = tickName === 'heisenberg';
    if (!req.user && !isManualHeisenberg) {
      try {
        const r = await db().query(
          `SELECT value FROM app_settings WHERE key = 'auto_upload_enabled'`,
        );
        const v = r.rows[0]?.value;
        if (v && String(v).toLowerCase() === 'false') {
          return res.status(503).json({
            error: `auto-upload disabled for scheduled-tick automation (app_settings.auto_upload_enabled=false). tick_name='${tickName || 'none'}'.`,
            remedy: 'fire from dashboard (Supabase JWT) or via heisenberg agent session, or set auto_upload_enabled=true',
          });
        }
      } catch (err) {
        console.error('[auto-upload kill-switch check failed — failing OPEN]:', err.message);
      }
    }
    const dryRun = req.body?.dry_run === true || process.env.AUTO_UPLOAD_DRY_RUN === 'true';
    const maxPaid = Number(process.env.AUTO_UPLOAD_MAX_PAID || 200);

    // Safety net 1: DB row-based lock per channel. Postgres advisory locks
    // don't survive pgBouncer's transaction pooler (different sessions per
    // query), so we use a sentinel row instead. Stale locks (>30 min old)
    // get reclaimed by the next caller so a crashed worker doesn't block
    // forever.
    const lockHolder = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
    const lockResult = await db().query(
      `INSERT INTO auto_upload_locks (channel, locked_at, holder)
       VALUES ($1, now(), $2)
       ON CONFLICT (channel) DO UPDATE
         SET locked_at = now(), holder = EXCLUDED.holder
         WHERE auto_upload_locks.locked_at < now() - interval '30 minutes'
       RETURNING holder`,
      [channel, lockHolder],
    );
    if (!lockResult.rows.length) {
      const held = await db().query(
        `SELECT holder, locked_at FROM auto_upload_locks WHERE channel=$1`,
        [channel],
      );
      return res.status(409).json({
        error: 'another auto-upload for this channel is already running',
        channel,
        held_by: held.rows[0]?.holder,
        since: held.rows[0]?.locked_at,
      });
    }
    let lockHeldForBackground = false;
    const releaseLock = async () => {
      if (lockHeldForBackground) return;
      await db().query(
        `DELETE FROM auto_upload_locks WHERE channel=$1 AND holder=$2`,
        [channel, lockHolder],
      ).catch(() => {});
    };

    try {
      // Default window = "from latest consumed ref's SHEET-time" (operator
      // rule from 2026-06-04). NOT batch finalized_at clock time. The
      // difference matters: if last upload ran at 12:46 EAT but covered
      // bank txns up to 12:40 EAT, we want to resume at 12:40 EAT, not 12:46.
      // We add +1 ms so the latest-consumed ref itself stays excluded
      // (consumed_transactions check would re-filter it, but this keeps
      // the window math clean).
      // Fallback chain: sheet_ts MAX → batch finalized_at − 5min → 24h ago.
      let sinceIso = req.body?.since_iso;
      if (!sinceIso) {
        const sheetTsRow = await db().query(
          `SELECT MAX(ct.sheet_ts) AS max_ts
             FROM consumed_transactions ct
             JOIN payment_batches pb ON pb.id = ct.batch_id
            WHERE pb.channel = $1 AND ct.sheet_ts IS NOT NULL
              AND pb.status IN ('finalized','pending')`,
          [channel],
        );
        if (sheetTsRow.rows[0]?.max_ts) {
          sinceIso = new Date(new Date(sheetTsRow.rows[0].max_ts).getTime() + 1).toISOString();
        } else {
          const last = await db().query(
            `SELECT finalized_at FROM payment_batches
              WHERE channel=$1 AND status='finalized' AND finalized_at IS NOT NULL
              ORDER BY finalized_at DESC LIMIT 1`,
            [channel],
          );
          sinceIso = last.rows.length
            ? new Date(new Date(last.rows[0].finalized_at).getTime() - 5 * 60_000).toISOString()
            : new Date(Date.now() - 24 * 3600_000).toISOString();
        }
      }
      const untilIso = req.body?.until_iso || new Date(Date.now() + 60_000).toISOString();

      const asOf = req.body?.as_of || null;
      // Optional TxnDate override. When supplied, ALL Payments/CreditMemos in
      // this batch get this date instead of the wall-clock paymentTxnDate().
      // Used by the autonomous scheduler: each named tick (kili1615, etc.)
      // carries its identity's date even when execution is delayed. See
      // BRAIN_BRAIN.md "TxnDate by batch identity".
      const txnDateOverride = req.body?.txn_date || null;
      // Skip the qbPreflightDedup QB-side dup check for dry-runs — it costs
      // 10–30 QB queries (Payment + CreditMemo paginated per chunk of 50
      // customers) and adds 1–3 minutes to a dry-run that isn't going to
      // write anything anyway. Real runs still get the full safety net.
      const result = await prepareAutoUpload({
        channel, sinceIso, untilIso, asOf,
        qbPreflightDedup: dryRun ? null : qbPreflightDedup,
      });
      if (result.skipped) {
        await releaseLock();
        return res.json({
          skipped: true,
          reason: result.reason,
          since_iso: sinceIso,
          until_iso: untilIso,
          // Pass through skip diagnostics from prepareAutoUpload so the
          // operator can see why a window came back empty (K boundary,
          // dates, etc.).
          ...(result.max_k_row != null ? { max_k_row: result.max_k_row } : {}),
          ...(result.sheet_total_rows != null ? { sheet_total_rows: result.sheet_total_rows } : {}),
          ...(result.skipped_already_pushed != null ? { skipped_already_pushed: result.skipped_already_pushed } : {}),
          ...(result.skipped_no_date != null ? { skipped_no_date: result.skipped_no_date } : {}),
          ...(result.skipped_bad_format != null ? { skipped_bad_format: result.skipped_bad_format } : {}),
          ...(result.skipped_out_of_window != null ? { skipped_out_of_window: result.skipped_out_of_window } : {}),
        });
      }
      if (result.aborted) {
        await releaseLock();
        return res.status(503).json({
          aborted: true,
          reason: result.reason,
          detail: result.detail,
          paid_planned: result.paid_planned,
          unused_planned: result.unused_planned,
          message: 'QB pre-flight check failed — upload safely aborted, no Payments created.',
        });
      }

      // Safety net 3: row cap to protect BRAIN's Starter plan memory.
      if (result.paid.length > maxPaid) {
        const c = await db().connect();
        try {
          await c.query('BEGIN');
          await c.query(`DELETE FROM consumed_transactions WHERE batch_id=$1`, [result.batchId]);
          await c.query(`DELETE FROM payment_batches WHERE id=$1`, [result.batchId]);
          await c.query('COMMIT');
        } catch (e) {
          await c.query('ROLLBACK').catch(() => {});
        } finally { c.release(); }
        await releaseLock();
        return res.status(413).json({
          error: 'too many paid records for one auto-upload',
          paid_planned: result.paid.length,
          max: maxPaid,
          hint: 'narrow since_iso/until_iso window or raise AUTO_UPLOAD_MAX_PAID',
        });
      }

      // Safety net 4: dry-run — records the plan but doesn't touch QB.
      // CRITICAL FIX 2026-06-05: prepareAutoUpload inserts into
      // consumed_transactions BEFORE we reach this branch — silently locking
      // those refs from any future real upload. On dry_run we MUST delete
      // them here, otherwise plan-mode agent tests leak refs forever.
      // Incident: 23 NMB morning refs from 04.06 were orphaned in QB until
      // Frank caught it — see project_evening_audit_pending_items.md item #7.
      if (dryRun) {
        await db().query(
          `DELETE FROM consumed_transactions WHERE batch_id = $1`,
          [result.batchId],
        );
        await db().query(
          `UPDATE payment_batches SET status='finalized', finalized_at=now(),
             failure_reason='dry_run — no QB calls; consumed_transactions cleared so refs stay eligible for real upload' WHERE id=$1`,
          [result.batchId],
        );
        for (const p of result.paid) {
          await db().query(
            `INSERT INTO payment_uploads (
               batch_id, kind, bank_ref, customer_id, customer_name,
               invoice_qb_id, invoice_no, amount, memo, status
             ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'dry_run')`,
            [result.batchId, p.memoWithSuffix, p.customerId, p.customerName,
             p.qbId, p.invoiceNo, round2(p.amount), p.memoWithSuffix],
          );
        }
        for (const u of result.unused) {
          await db().query(
            `INSERT INTO payment_uploads (
               batch_id, kind, bank_ref, customer_id, customer_name,
               amount, memo, status
             ) VALUES ($1,'credit_memo',$2,NULL,$3,$4,$5,'dry_run')`,
            [result.batchId, u.memoWithSuffix, u.customerName, round2(u.transactionAmount), u.memoWithSuffix],
          );
        }
        await releaseLock();
        return res.status(202).json({
          dry_run: true,
          batch_id: result.batchId,
          paid_planned: result.paid.length,
          unused_planned: result.unused.length,
          sheet_sum: result.sheetSum,
          since_iso: sinceIso,
          until_iso: untilIso,
        });
      }

      // Real run: hand off to background. Lock stays held; the background
      // task releases it when QB calls finish.
      lockHeldForBackground = true;
      setImmediate(() => {
        runAutoUploadBackground({
          batchId: result.batchId,
          paid: result.paid,
          unused: result.unused,
          txnDate: txnDateOverride,
          qbCreatePayment,
          qbBatchCreatePayments,
          qbCreateUnappliedPayment,
          qbBatchCreateUnappliedPayments,
          qbBatchLookupCustomers,
          qbCreateCreditMemo,
          cfg: result.cfg,
          // tick_name from request body identifies which scheduler tick
          // (or button-fired manual run = 'heisenberg') triggered this fire.
          // Used to paint the last processed sheet row purple + write
          // "end of {tick}" to Column K so the operator can see visually
          // where each tick stopped.
          tickName: String(req.body?.tick_name || 'heisenberg'),
        })
          .catch((err) => {
            console.error('[auto-upload background]', result.batchId, err);
          })
          .finally(async () => {
            await db().query(
              `DELETE FROM auto_upload_locks WHERE channel=$1 AND holder=$2`,
              [channel, lockHolder],
            ).catch(() => {});
          });
      });

      res.status(202).json({
        batch_id: result.batchId,
        paid_planned: result.paid.length,
        unused_planned: result.unused.length,
        sheet_sum: result.sheetSum,
        since_iso: sinceIso,
        until_iso: untilIso,
        message: 'background processing started; poll /api/payment-batches/:id for progress',
      });
    } catch (err) {
      console.error('[POST /api/payment-batches/auto-upload]', err);
      await releaseLock();
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/payment-batches/:id/recall ─────────────────────────────────
  // Either Supabase JWT (operator clicking dashboard button) or shared secret
  // (CLI / service-to-service) is accepted.
  app.post('/api/payment-batches/:id/recall', (req, res, next) => {
    const expected = process.env.STATEMENT_REPORT_SECRET;
    if (expected && req.header('X-Report-Secret') === expected) return next();
    return requireSupabaseJwt(req, res, next);
  }, async (req, res) => {
    try {
      const batchId = req.params.id;
      const reason = String(req.body?.reason ?? 'admin recall');

      const r = await db().query(`SELECT * FROM payment_batches WHERE id=$1`, [batchId]);
      if (!r.rows.length) return res.status(404).json({ error: 'batch not found' });
      const batch = r.rows[0];
      if (batch.status !== 'finalized') {
        return res.status(409).json({ error: `cannot recall batch in status ${batch.status}` });
      }

      const ups = await db().query(
        `SELECT * FROM payment_uploads WHERE batch_id=$1 AND status='created' ORDER BY created_at`,
        [batchId],
      );
      // Keep retrying failed voids until ALL succeed (or hard ceiling of 20
      // attempts to prevent infinite loop on permanent errors). Frank's rule
      // 2026-06-05: "pure recall retry until recalled" — don't leave any
      // Payment stranded silently.
      const MAX_RECALL_ATTEMPTS = 20;
      let voids = await voidUploadsBestEffort(ups.rows, qbVoid);
      for (let attempt = 2; attempt <= MAX_RECALL_ATTEMPTS; attempt++) {
        const stillFailed = voids.filter((v) => !v.ok);
        if (!stillFailed.length) {
          console.log(`[recall ${batchId}] all voids succeeded after ${attempt - 1} attempts`);
          break;
        }
        console.log(`[recall ${batchId}] attempt ${attempt}/${MAX_RECALL_ATTEMPTS}: ${stillFailed.length} voids still failing`);
        // Exponential-ish backoff capped at 30s. 3s, 6s, 10s, 15s, 20s, 25s, 30s, 30s, …
        const wait = Math.min(30_000, 3_000 + (attempt - 2) * 4_000);
        await new Promise((r) => setTimeout(r, wait));
        const failedUploadIds = new Set(stillFailed.map((v) => v.upload_id));
        const failedUploads = ups.rows.filter((u) => failedUploadIds.has(u.id));
        const retryResults = await voidUploadsBestEffort(failedUploads, qbVoid);
        const retryById = new Map(retryResults.map((r) => [r.upload_id, r]));
        voids = voids.map((v) => v.ok ? v : (retryById.get(v.upload_id) || v));
      }
      const allOk = voids.every((v) => v.ok);
      const stuckCount = voids.filter((v) => !v.ok).length;
      if (!allOk) {
        console.warn(`[recall ${batchId}] gave up after ${MAX_RECALL_ATTEMPTS} attempts — ${stuckCount} voids still failing (permanent errors?)`);
      }

      const c = await db().connect();
      try {
        await c.query('BEGIN');
        if (allOk) {
          await c.query(
            `UPDATE payment_batches SET status='recalled', recalled_at=now(),
               recalled_by=$2, failure_reason=$3 WHERE id=$1`,
            [batchId, `admin:${req.user?.email ?? req.user?.id ?? 'unknown'} — ${reason}`, null],
          );
          await c.query(`DELETE FROM consumed_transactions WHERE batch_id=$1`, [batchId]);
        } else {
          // Partial: mark failure but keep refs locked so refs aren't re-batched
          // while half-voided.
          await c.query(
            `UPDATE payment_batches SET failure_reason=$2 WHERE id=$1`,
            [batchId, 'partial recall — some QB voids failed, refs stay locked'],
          );
        }
        await c.query('COMMIT');
      } catch (e) {
        await c.query('ROLLBACK').catch(() => {});
        throw e;
      } finally {
        c.release();
      }

      const b2 = await db().query(`SELECT * FROM payment_batches WHERE id=$1`, [batchId]);
      res.json({ batch: b2.rows[0], voids, all_ok: allOk });
    } catch (err) {
      console.error('[POST /api/payment-batches/:id/recall]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/payment-batches/:id/rerun ──────────────────────────────────
  // Returns the original arrears snapshot + the bank_refs so the
  // invoice-payment-app can rebuild paid/unused against the SAME state and
  // re-POST as a new batch (with a fresh idempotency_key).
  app.post('/api/payment-batches/:id/rerun', requireSupabaseJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT pb.*, asp.data AS snapshot_data, asp.as_of AS snapshot_as_of
           FROM payment_batches pb
           JOIN arrears_snapshots asp ON pb.arrears_snapshot_id = asp.id
          WHERE pb.id = $1`,
        [req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: 'batch not found' });
      const b = r.rows[0];
      if (b.status !== 'recalled') {
        return res.status(409).json({ error: `cannot rerun batch in status ${b.status}` });
      }
      res.json({
        rerun: {
          original_batch_id: b.id,
          sheet_id: b.sheet_id,
          sheet_tab: b.sheet_tab,
          channel: b.channel,
          bank_refs: b.bank_refs,
          arrears_snapshot_id: b.arrears_snapshot_id,
          arrears_as_of: b.snapshot_as_of,
          arrears_snapshot: b.snapshot_data,
        },
      });
    } catch (err) {
      console.error('[POST /api/payment-batches/:id/rerun]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/arrears-snapshots/:id ───────────────────────────────────────
  // Read back a stored snapshot. Used by the SaasAnt-vs-BRAIN comparison
  // harness (tools/diff.mjs). Uses the shared secret so the tools can run
  // without juggling Supabase JWTs.
  app.get('/api/arrears-snapshots/:id', requireSharedSecret, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT id, created_at, as_of, row_count, total_balance, created_by, notes, data
           FROM arrears_snapshots WHERE id = $1`,
        [req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: 'snapshot not found' });
      res.json({ snapshot: r.rows[0] });
    } catch (err) {
      console.error('[GET /api/arrears-snapshots/:id]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/arrears-snapshots (list) ────────────────────────────────────
  app.get('/api/arrears-snapshots', requireSharedSecret, async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const r = await db().query(
        `SELECT id, created_at, as_of, row_count, total_balance, created_by, notes
           FROM arrears_snapshots ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      res.json({ snapshots: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/payment-batches (list) ──────────────────────────────────────
  app.get('/api/payment-batches', requireSupabaseJwt, async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
      const status = req.query.status ? String(req.query.status) : null;
      const where = [];
      const args = [];
      if (status) { where.push(`status = $${args.length + 1}`); args.push(status); }
      const sql = `
        SELECT id, created_at, finalized_at, recalled_at, rolled_back_at, status,
               sheet_id, sheet_tab, channel, paid_total, unused_total,
               sheet_total, paid_count, unused_count, created_by, recalled_by,
               failure_reason
          FROM payment_batches
          ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
          ORDER BY created_at DESC
          LIMIT ${limit}
      `;
      const r = await db().query(sql, args);
      res.json({ batches: r.rows });
    } catch (err) {
      console.error('[GET /api/payment-batches]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/payment-batches/:id', requireSupabaseJwt, async (req, res) => {
    try {
      const r = await db().query(`SELECT * FROM payment_batches WHERE id=$1`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      const batch = r.rows[0];
      const u = await db().query(
        `SELECT * FROM payment_uploads WHERE batch_id=$1 ORDER BY kind, created_at`,
        [req.params.id],
      );
      // Snapshot summary (row_count + total_balance + as_of). Heavy data is
      // omitted by default; client can pass ?include_snapshot=full to get it.
      const sn = await db().query(
        `SELECT id, as_of, row_count, total_balance, created_at,
                ${req.query.include_snapshot === 'full' ? 'data' : 'NULL::jsonb as data'}
           FROM arrears_snapshots WHERE id=$1`,
        [batch.arrears_snapshot_id],
      );
      res.json({ batch, uploads: u.rows, snapshot: sn.rows[0] || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/arrears-snapshots/:id/export.csv ────────────────────────────
  // No-auth (so the dashboard's <a download> works) — snapshots aren't secret.
  app.get('/api/arrears-snapshots/:id/export.csv', async (req, res) => {
    try {
      const r = await db().query(
        `SELECT id, as_of, data, row_count, total_balance FROM arrears_snapshots WHERE id=$1`,
        [req.params.id],
      );
      if (!r.rows.length) return res.status(404).type('text/plain').send('not found');
      const s = r.rows[0];
      const rows = Array.isArray(s.data) ? s.data : [];
      const header = ['no','customerId','customerLeaf','customer','date','dueDate','amount','balance','status','qbId'];
      const esc = (v) => {
        if (v == null) return '';
        const str = String(v);
        return /[",\n]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
      };
      const lines = [header.join(',')];
      for (const inv of rows) {
        lines.push(header.map((h) => esc(inv[h])).join(','));
      }
      res.type('text/csv').attachment(`arrears-snapshot-${s.as_of}-${s.id.slice(0,8)}.csv`).send(lines.join('\n'));
    } catch (err) {
      res.status(500).type('text/plain').send('error: ' + err.message);
    }
  });

  // ── POST /api/admin/backfill-sheet-ts ────────────────────────────────────
  // One-time backfill: populate sheet_ts on every consumed_transactions row
  // by cross-referencing the channel sheets. Used after adding the column.
  app.post('/api/admin/backfill-sheet-ts', requireSecretOrJwt, async (req, res) => {
    try {
      const channels = req.body?.channels || Object.keys(CHANNEL_SHEETS);
      const summary = {};
      for (const ch of channels) {
        const cfg = CHANNEL_SHEETS[ch];
        if (!cfg) { summary[ch] = { error: 'unknown channel' }; continue; }
        const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:H80000`);
        const rows = sheetData.values || sheetData.data || [];
        // ref-without-suffix → sheet ISO string
        const refToSheetTs = new Map();
        for (let i = 1; i < rows.length; i++) {
          const ts = parseTsAny(String(rows[i][1] || '').trim());
          const ref = String(rows[i][7] || '').trim();
          if (ts && ref) refToSheetTs.set(ref + suffixOf(ch), ts.toISOString());
        }
        // Pull all consumed refs for this channel (with NULL sheet_ts only)
        const c = await db().query(
          `SELECT ct.bank_ref FROM consumed_transactions ct
             JOIN payment_batches pb ON pb.id = ct.batch_id
            WHERE pb.channel = $1 AND ct.sheet_ts IS NULL`,
          [ch],
        );
        let updated = 0;
        const BATCH = 1000;
        for (let i = 0; i < c.rows.length; i += BATCH) {
          const chunk = c.rows.slice(i, i + BATCH);
          const cases = [];
          const refs = [];
          for (const row of chunk) {
            const ts = refToSheetTs.get(row.bank_ref);
            if (!ts) continue;
            cases.push(`WHEN '${row.bank_ref}' THEN '${ts}'::timestamptz`);
            refs.push(row.bank_ref);
          }
          if (refs.length === 0) continue;
          await db().query(
            `UPDATE consumed_transactions
                SET sheet_ts = CASE bank_ref ${cases.join(' ')} END
              WHERE bank_ref = ANY($1)`,
            [refs],
          );
          updated += refs.length;
        }
        summary[ch] = { scanned: c.rows.length, sheet_rows: rows.length - 1, updated };
      }
      res.json({ ok: true, summary });
    } catch (err) {
      console.error('[backfill-sheet-ts]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/saasant-pending[.csv] ──────────────────────────────────────
  // Returns rows whose customer didn't match in QB (status='needs_saasant')
  // so the operator can push them via SaasAnt manually. Supports CSV download
  // matching SaasAnt's import schema.
  app.get('/api/saasant-pending', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = req.query.channel ? String(req.query.channel) : null;
      const r = await db().query(
        `SELECT pu.id, pu.bank_ref, pu.customer_name, pu.amount, pu.memo, pu.created_at, pb.channel
           FROM payment_uploads pu
           JOIN payment_batches pb ON pb.id = pu.batch_id
          WHERE pu.status = 'needs_saasant' ${channel ? 'AND pb.channel = $1' : ''}
          ORDER BY pu.created_at`,
        channel ? [channel] : [],
      );
      res.json({ pending: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/saasant-pending.csv', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = req.query.channel ? String(req.query.channel) : null;
      const r = await db().query(
        `SELECT pu.bank_ref, pu.customer_name, pu.amount, pu.memo, pu.created_at, pb.channel
           FROM payment_uploads pu
           JOIN payment_batches pb ON pb.id = pu.batch_id
          WHERE pu.status = 'needs_saasant' ${channel ? 'AND pb.channel = $1' : ''}
          ORDER BY pu.created_at`,
        channel ? [channel] : [],
      );
      const esc = (v) => {
        const s = v == null ? '' : String(v);
        return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
      };
      const HEAD = ['Payment Date', 'Customer', 'Payment Method', 'Deposit To Account Name',
                    'Invoice No', 'Journal No', 'Amount', 'Reference No', 'Memo', 'Country Code', 'Exchange Rate'];
      const lines = [HEAD.map(esc).join(',')];
      for (const x of r.rows) {
        const txnDate = new Date(x.created_at);
        const mmdd = `${String(txnDate.getUTCMonth() + 1).padStart(2,'0')}-${String(txnDate.getUTCDate()).padStart(2,'0')}-${txnDate.getUTCFullYear()}`;
        const memo = String(x.memo || x.bank_ref || '').replace(/[NBP]$/, '');
        lines.push([mmdd, x.customer_name || '', 'Cash', 'Kijichi Collection AC', '', '', x.amount, '', memo, '', ''].map(esc).join(','));
      }
      res.type('text/csv').attachment(`saasant-pending${channel ? '-' + channel : ''}.csv`).send(lines.join('\n'));
    } catch (err) {
      res.status(500).type('text/plain').send('error: ' + err.message);
    }
  });

  // ── GET /api/payment-uploads/today-totals ────────────────────────────────
  // Returns per-channel and per-status totals for a given Africa/Dar_es_Salaam
  // day, plus a grand total. Defaults to today EAT. Used for the daily
  // "what did we push?" view. Auth: X-Report-Secret or JWT.
  // GET /api/admin/qb-double-payment-scan?date=2026-06-05
  // Scans ALL QB Payments for one date, groups by the invoice_id (LinkedTxn).
  // Returns invoices that received >1 Payment = REAL double-payments.
  app.get('/api/admin/qb-double-payment-scan', requireSecretOrJwt, async (req, res) => {
    try {
      const date = String(req.query.date || '');
      if (!date) return res.status(400).json({ error: 'date YYYY-MM-DD required' });
      const all = [];
      const BATCH = 1000;
      let start = 1;
      while (true) {
        const r = await qbQuery(
          `SELECT Id, TotalAmt, TxnDate, PrivateNote, Line, CustomerRef ` +
          `FROM Payment WHERE TxnDate = '${date}' ` +
          `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
        );
        const rows = r.QueryResponse?.Payment || [];
        all.push(...rows);
        if (rows.length < BATCH) break;
        start += BATCH;
      }
      // Group by invoice id
      const invoiceMap = {};
      for (const p of all) {
        for (const l of (p.Line || [])) {
          const inv = l.LinkedTxn?.[0]?.TxnId;
          if (!inv) continue;
          if (!invoiceMap[inv]) invoiceMap[inv] = [];
          invoiceMap[inv].push({
            payment_id: p.Id,
            paid_amount: Number(l.Amount || 0),
            private_note: p.PrivateNote || null,
            customer_id: p.CustomerRef?.value || null,
          });
        }
      }
      const doubles = [];
      let excessRows = 0;
      let excessAmount = 0;
      for (const [invoiceId, payments] of Object.entries(invoiceMap)) {
        if (payments.length > 1) {
          excessRows += payments.length - 1;
          excessAmount += payments.slice(1).reduce((s, p) => s + p.paid_amount, 0);
          if (doubles.length < 50) doubles.push({ invoice_id: invoiceId, payments });
        }
      }
      res.json({
        date,
        total_payments_scanned: all.length,
        total_invoices_paid: Object.keys(invoiceMap).length,
        invoices_with_2plus_payments: Object.values(invoiceMap).filter((v) => v.length > 1).length,
        excess_payment_rows: excessRows,
        excess_amount: excessAmount,
        sample_doubles: doubles,
      });
    } catch (err) {
      console.error('[qb-double-payment-scan] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/void-payments
  // Body: { qb_ids: ["1606530", ...], reason: "stranded duplicates" }
  // Voids each Payment in QB. Processes 8 in parallel for speed (was sequential
  // and timed out on large lists). Single attempt per id — caller should
  // re-poll verify-recall and re-fire the list for any that fail.
  app.post('/api/admin/void-payments', requireSecretOrJwt, async (req, res) => {
    try {
      const qbIds = Array.isArray(req.body?.qb_ids) ? req.body.qb_ids.map(String) : [];
      const reason = String(req.body?.reason || 'admin force-void stranded payment');
      if (!qbIds.length) return res.status(400).json({ error: 'qb_ids[] required' });
      const results = new Array(qbIds.length);
      let cursor = 0;
      const PAR = 8;
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= qbIds.length) return;
          const qbId = qbIds[i];
          let voided = false;
          let lastErr = null;
          try {
            const r = await qbVoid({ kind: 'payment', qbId });
            voided = !!r && (r.ok !== false);
            if (!voided) lastErr = r?.error || 'unknown';
          } catch (err) {
            lastErr = String(err.message || err).slice(0, 300);
          }
          if (voided) {
            const u = await db().query(
              `UPDATE payment_uploads SET status='voided', voided_at=now()
                WHERE qb_id = $1 AND status = 'created'
                RETURNING id, bank_ref`,
              [qbId],
            );
            for (const row of u.rows) {
              await db().query(`DELETE FROM consumed_transactions WHERE bank_ref = $1`, [row.bank_ref]);
            }
            results[i] = { qb_id: qbId, ok: true, updated: u.rowCount };
          } else {
            results[i] = { qb_id: qbId, ok: false, error: lastErr };
          }
        }
      };
      await Promise.all(Array.from({ length: PAR }, () => worker()));
      const summary = {
        total: results.length,
        succeeded: results.filter((r) => r && r.ok).length,
        failed: results.filter((r) => r && !r.ok).length,
      };
      const failures = results.filter((r) => r && !r.ok).slice(0, 10);
      res.json({ summary, reason, sample_failures: failures });
    } catch (err) {
      console.error('[void-payments] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/verify-recall?batch_id=...
  // For a given batch, check QB to see if any Payments with that batch's refs
  // are still active. Returns which refs are surviving and which are clean.
  // SAFE — read-only. Use BEFORE any re-fire to confirm recall fully succeeded.
  app.get('/api/admin/verify-recall', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.query.batch_id || '');
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      // Get all refs that were in this batch via payment_uploads
      const refs = await db().query(
        `SELECT pu.bank_ref, pu.customer_id, pu.status, pu.qb_id, pu.amount
           FROM payment_uploads pu
          WHERE pu.batch_id = $1`,
        [batchId],
      );
      if (!refs.rows.length) return res.json({ batch_id: batchId, refs_count: 0, surviving: [] });
      // Group by customer to minimize QB queries
      const byCustomer = new Map();
      for (const r of refs.rows) {
        if (!r.customer_id) continue;
        if (!byCustomer.has(r.customer_id)) byCustomer.set(r.customer_id, []);
        byCustomer.get(r.customer_id).push(r);
      }
      const surviving = [];
      const customerIds = [...byCustomer.keys()];
      const CHUNK = 50;
      const dateFrom = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      for (let i = 0; i < customerIds.length; i += CHUNK) {
        const chunk = customerIds.slice(i, i + CHUNK);
        const inList = chunk.map((id) => `'${id}'`).join(',');
        try {
          const r = await qbQuery(
            `SELECT Id, PrivateNote, CustomerRef, TotalAmt, TxnDate ` +
            `FROM Payment WHERE CustomerRef IN (${inList}) AND TxnDate >= '${dateFrom}' MAXRESULTS 1000`,
          );
          const pmts = r.QueryResponse?.Payment || [];
          // For each batch ref, see if a Payment in QB matches it
          for (const cid of chunk) {
            const batchRefs = byCustomer.get(cid) || [];
            for (const br of batchRefs) {
              const refRaw = String(br.bank_ref);
              const refBase = refRaw.replace(/[NBP]$/, '');
              const matching = pmts.filter((p) => {
                if (String(p.CustomerRef?.value || '') !== cid) return false;
                const pn = String(p.PrivateNote || '').trim();
                return pn === refRaw || pn === refBase;
              });
              if (matching.length > 0) {
                surviving.push({
                  bank_ref: br.bank_ref,
                  customer_id: cid,
                  batch_upload_status: br.status,
                  qb_payments_still_present: matching.map((m) => ({ qb_id: m.Id, total: Number(m.TotalAmt || 0), txn_date: m.TxnDate })),
                });
              }
            }
          }
        } catch (err) {
          console.error('[verify-recall] customer chunk failed:', err.message);
        }
      }
      res.json({
        batch_id: batchId,
        refs_in_batch: refs.rows.length,
        surviving_count: surviving.length,
        clean: surviving.length === 0,
        surviving,
      });
    } catch (err) {
      console.error('[verify-recall] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/batches-info — bulk metadata lookup for a list of batch ids
  app.post('/api/admin/batches-info', requireSecretOrJwt, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
      // Support partial id prefixes (first 8 chars)
      const params = [];
      let where;
      if (!ids.length) return res.status(400).json({ error: 'ids[] required' });
      if (ids.every((i) => i.length === 36)) {
        params.push(ids);
        where = `id = ANY($1)`;
      } else {
        const ors = ids.map((i, n) => { params.push(i + '%'); return `id::text LIKE $${n+1}`; });
        where = ors.join(' OR ');
      }
      const r = await db().query(
        `SELECT id, channel, status, created_by, recalled_by, failure_reason,
                created_at, finalized_at, recalled_at,
                paid_count, unused_count, paid_total, unused_total
           FROM payment_batches WHERE ${where} ORDER BY created_at`,
        params,
      );
      res.json({ batches: r.rows });
    } catch (err) {
      console.error('[batches-info] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/qb-ref-inflation-scan?date=2026-06-05
  // For each PrivateNote (= bank ref) in today's QB Payments, sums Payment.TotalAmt
  // and compares to the bank deposit amount from consumed_transactions/sheet.
  // Reports refs where QB total > bank deposit (= real money inflation).
  // Also reports which BRAIN batch(es) pushed each problem ref.
  app.get('/api/admin/qb-ref-inflation-scan', requireSecretOrJwt, async (req, res) => {
    try {
      const date = String(req.query.date || '');
      if (!date) return res.status(400).json({ error: 'date YYYY-MM-DD required' });

      // 1. Pull all today's QB Payments
      const all = [];
      const BATCH = 1000;
      let start = 1;
      while (true) {
        const r = await qbQuery(
          `SELECT Id, TotalAmt, TxnDate, PrivateNote, CustomerRef ` +
          `FROM Payment WHERE TxnDate = '${date}' ` +
          `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
        );
        const rows = r.QueryResponse?.Payment || [];
        all.push(...rows);
        if (rows.length < BATCH) break;
        start += BATCH;
      }

      // 2. Group by PrivateNote → list of Payments
      const byRef = {};
      for (const p of all) {
        const ref = String(p.PrivateNote || '').trim();
        if (!ref) continue;
        if (!byRef[ref]) byRef[ref] = [];
        byRef[ref].push({ qb_id: p.Id, total: Number(p.TotalAmt || 0), customer_id: p.CustomerRef?.value });
      }

      // 3. For refs with >1 Payment, fetch bank-deposit amount from sheet via consumed_transactions
      // We look up bank_refs with suffix (N|B|P) since consumed_transactions stores with suffix
      const refsWithDupes = Object.entries(byRef).filter(([, ps]) => ps.length > 1);
      const refKeys = refsWithDupes.flatMap(([ref]) => [ref, ref + 'N', ref + 'B', ref + 'P']);
      const ct = await db().query(
        `SELECT bank_ref, batch_id FROM consumed_transactions WHERE bank_ref = ANY($1)`,
        [refKeys],
      );
      const ctMap = new Map(ct.rows.map((r) => [r.bank_ref, r.batch_id]));

      // 4. Find sheet_amount per ref (from payment_uploads.amount or sheet)
      const pu = await db().query(
        `SELECT bank_ref, amount, batch_id FROM payment_uploads WHERE bank_ref = ANY($1) AND status IN ('created','voided')`,
        [refKeys],
      );
      const puMap = new Map();
      for (const r of pu.rows) {
        if (!puMap.has(r.bank_ref)) puMap.set(r.bank_ref, []);
        puMap.get(r.bank_ref).push({ amount: Number(r.amount), batch_id: r.batch_id });
      }

      // 5. Build report
      const inflated = [];
      let totalInflation = 0;
      const batchHits = {};
      for (const [ref, payments] of refsWithDupes) {
        const qbTotal = payments.reduce((s, p) => s + p.total, 0);
        // Look up the bank_ref in consumed_transactions to find the BRAIN-known amount
        const candidates = [ref, ref + 'N', ref + 'B', ref + 'P'];
        let bankAmount = null;
        let primaryBatch = null;
        for (const c of candidates) {
          if (puMap.has(c)) {
            const rows = puMap.get(c);
            // Use the max amount as the bank deposit (first push)
            bankAmount = Math.max(...rows.map((r) => r.amount));
            primaryBatch = rows[0].batch_id;
            break;
          }
        }
        if (bankAmount == null) continue; // can't determine
        if (qbTotal > bankAmount) {
          const overBy = qbTotal - bankAmount;
          totalInflation += overBy;
          inflated.push({
            ref,
            qb_total: qbTotal,
            bank_amount: bankAmount,
            over_by: overBy,
            qb_payment_count: payments.length,
            qb_payment_ids: payments.map((p) => p.qb_id),
            brain_batch: primaryBatch ? primaryBatch.slice(0, 8) : null,
          });
          if (primaryBatch) {
            const k = primaryBatch.slice(0, 8);
            if (!batchHits[k]) batchHits[k] = { count: 0, over: 0 };
            batchHits[k].count++;
            batchHits[k].over += overBy;
          }
        }
      }

      // Sort batches by impact
      const batchRanking = Object.entries(batchHits)
        .sort((a, b) => b[1].over - a[1].over)
        .map(([batch, stats]) => ({ batch_prefix: batch, refs_affected: stats.count, total_inflation: stats.over }));

      res.json({
        date,
        total_qb_payments: all.length,
        refs_with_inflation: inflated.length,
        total_inflation_amount: totalInflation,
        worst_offenders: inflated
          .sort((a, b) => b.over_by - a.over_by)
          .slice(0, 30),
        batches_responsible: batchRanking,
      });
    } catch (err) {
      console.error('[qb-ref-inflation-scan] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/qb-payments-for-customer?customer_id=10198&date=2026-06-05
  // Returns all QB Payment records for one customer on one date — with their
  // PrivateNote (= bank_ref) and LinkedTxn count. Used to distinguish
  // "12 rows in xlsx" being 12 separate Payments vs 1 Payment paying 12 invoices.
  app.get('/api/admin/qb-payments-for-customer', requireSecretOrJwt, async (req, res) => {
    try {
      const customerId = String(req.query.customer_id || '');
      const date = String(req.query.date || '');
      if (!customerId || !date) return res.status(400).json({ error: 'customer_id + date required' });
      const r = await qbQuery(
        `SELECT Id, TotalAmt, TxnDate, PrivateNote, Line, CustomerRef ` +
        `FROM Payment WHERE CustomerRef = '${customerId}' AND TxnDate = '${date}'`,
      );
      const payments = r.QueryResponse?.Payment || [];
      const summary = payments.map((p) => ({
        qb_id: p.Id,
        total_amt: Number(p.TotalAmt || 0),
        txn_date: p.TxnDate,
        private_note: p.PrivateNote || null,
        linked_txn_count: (p.Line || []).length,
        linked_txn_summary: (p.Line || []).map((l) => ({
          amount: Number(l.Amount || 0),
          txn_type: l.LinkedTxn?.[0]?.TxnType || null,
          txn_id: l.LinkedTxn?.[0]?.TxnId || null,
        })),
      }));
      res.json({ customer_id: customerId, date, count: payments.length, payments: summary });
    } catch (err) {
      console.error('[qb-payments-for-customer] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/brain-upload-timeline
  // Shows when BRAIN started doing real auto-uploads + activity by date.
  app.get('/api/admin/brain-upload-timeline', requireSecretOrJwt, async (req, res) => {
    try {
      const first = await db().query(
        `SELECT MIN(created_at) AS first_pu, COUNT(*) AS total_pus
           FROM payment_uploads WHERE qb_id IS NOT NULL`,
      );
      const byDate = await db().query(
        `SELECT DATE(created_at AT TIME ZONE 'Africa/Dar_es_Salaam') AS d,
                COUNT(*) AS rows,
                COUNT(*) FILTER (WHERE status='created') AS created_rows,
                COUNT(*) FILTER (WHERE status='voided') AS voided_rows,
                COUNT(DISTINCT batch_id) AS batches
           FROM payment_uploads
          WHERE qb_id IS NOT NULL
          GROUP BY 1 ORDER BY 1 ASC`,
      );
      const firstBatch = await db().query(
        `SELECT MIN(created_at) AS first_batch, COUNT(*) AS total_batches
           FROM payment_batches WHERE status IN ('finalized', 'recalled')`,
      );
      res.json({
        first_pu_created_at: first.rows[0]?.first_pu,
        total_pus_ever: Number(first.rows[0]?.total_pus || 0),
        first_batch_created_at: firstBatch.rows[0]?.first_batch,
        total_batches_ever: Number(firstBatch.rows[0]?.total_batches || 0),
        by_eat_date: byDate.rows.map((r) => ({
          eat_date: r.d,
          rows: Number(r.rows),
          created: Number(r.created_rows),
          voided: Number(r.voided_rows),
          batches: Number(r.batches),
        })),
      });
    } catch (err) {
      console.error('[brain-upload-timeline] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/scan-double-pushes
  // Across all time, finds (customer, bank_ref) combinations where BRAIN
  // has 2+ payment_uploads rows with status='created' qb_id set.
  // = candidates for duplicate Payments in QB.
  app.get('/api/admin/scan-double-pushes', requireSecretOrJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT customer_id, bank_ref, COUNT(*) AS dup_count,
                ARRAY_AGG(qb_id) AS qb_ids,
                ARRAY_AGG(amount) AS amounts,
                ARRAY_AGG(batch_id) AS batch_ids,
                MAX(customer_name) AS customer_name
           FROM payment_uploads
          WHERE status = 'created' AND qb_id IS NOT NULL
          GROUP BY customer_id, bank_ref
         HAVING COUNT(*) >= 2
          ORDER BY COUNT(*) DESC
          LIMIT 200`,
      );
      const total_dup_amount = r.rows.reduce((s, x) => {
        const amts = x.amounts || [];
        if (amts.length > 1) {
          for (let i = 1; i < amts.length; i++) s += Number(amts[i] || 0);
        }
        return s;
      }, 0);
      res.json({
        duplicate_groups: r.rows.length,
        approx_excess_amount: total_dup_amount,
        groups: r.rows.map((x) => ({
          customer_id: x.customer_id,
          customer_name: x.customer_name,
          bank_ref: x.bank_ref,
          duplicate_count: Number(x.dup_count),
          qb_ids: x.qb_ids,
          amounts: x.amounts.map(Number),
          batch_ids: (x.batch_ids || []).map((b) => String(b).slice(0, 8)),
        })),
      });
    } catch (err) {
      console.error('[scan-double-pushes] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/verify-dry-run?batch_id=...
  // Reads a dry-run batch's payment_uploads and arrears_snapshot to give
  // the operator full transparency on what would have been pushed:
  //   - count, sum, breakdown by kind (payment vs credit_memo)
  //   - the AS_OF the IP algorithm used (snapshot.as_of)
  //   - distinct customers + invoice dates (so operator can confirm only
  //     invoices DueDate <= AS_OF were matched)
  //   - amount distribution (largest 10 + smallest 10) for outlier review
  //   - PLATE=NAME refs or missing customer_id (anomaly buckets)
  //   - sheet vs DB reconciliation
  app.get('/api/admin/verify-dry-run', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.query.batch_id || '');
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      let fullId = batchId;
      if (batchId.length < 36) {
        const r = await db().query(`SELECT id FROM payment_batches WHERE id::text LIKE $1 LIMIT 1`, [batchId + '%']);
        if (!r.rows.length) return res.status(404).json({ error: 'batch not found' });
        fullId = r.rows[0].id;
      }
      // Note: txn_date is NOT stored on payment_batches — it's applied
      // at QB push time from the request body. Surface what we have.
      // ALSO pull the full snapshot JSON so we can verify the actual
      // invoices used have DueDate <= snapshot_as_of (operator paranoia
      // check — "did it actually only use 3rd June invoices?")
      const batchRow = await db().query(
        `SELECT pb.id, pb.channel, pb.status, pb.created_at, pb.finalized_at,
                pb.failure_reason, pb.idempotency_key,
                pb.sheet_total, pb.paid_total, pb.unused_total,
                pb.arrears_snapshot_id,
                aps.as_of AS snapshot_as_of, aps.created_at AS snapshot_created_at,
                aps.data AS snapshot_data
           FROM payment_batches pb
           LEFT JOIN arrears_snapshots aps ON aps.id = pb.arrears_snapshot_id
          WHERE pb.id = $1`,
        [fullId],
      );
      if (!batchRow.rows.length) return res.status(404).json({ error: 'batch not found' });
      const batch = batchRow.rows[0];

      const pus = await db().query(
        `SELECT id, kind, bank_ref, customer_id, customer_name,
                invoice_qb_id, invoice_no, amount, memo, status
           FROM payment_uploads
          WHERE batch_id = $1
          ORDER BY amount DESC, id`,
        [fullId],
      );

      const paid = pus.rows.filter((r) => r.kind === 'payment');
      const unused = pus.rows.filter((r) => r.kind !== 'payment');
      const paidSum = paid.reduce((s, r) => s + Number(r.amount || 0), 0);
      const unusedSum = unused.reduce((s, r) => s + Number(r.amount || 0), 0);

      // Distinct refs (per bank deposit) — a deposit can split into multiple PUs
      const distinctRefs = new Set(pus.rows.map((r) => r.bank_ref));
      const distinctCustomers = new Set(paid.map((r) => String(r.customer_id || '')).filter(Boolean));

      // Anomalies
      const plateNameRefs = paid.filter((r) => /[A-Z]+[0-9]+=/.test(r.customer_name || ''));
      const missingCustomer = paid.filter((r) => !r.customer_id);
      const missingInvoice = paid.filter((r) => !r.invoice_qb_id);
      const suspiciouslyLarge = [...paid].sort((a, b) => Number(b.amount) - Number(a.amount)).slice(0, 10);
      const suspiciouslySmall = [...paid].filter((r) => Number(r.amount) < 500).slice(0, 10);

      // Customer assignment audit — multi-PU per ref means multi-invoice split
      const refToPus = new Map();
      for (const p of paid) {
        if (!refToPus.has(p.bank_ref)) refToPus.set(p.bank_ref, []);
        refToPus.get(p.bank_ref).push(p);
      }
      const splits = [...refToPus.entries()]
        .filter(([_, list]) => list.length > 1)
        .map(([ref, list]) => ({
          bank_ref: ref,
          split_count: list.length,
          total: list.reduce((s, x) => s + Number(x.amount), 0),
          customer_name: list[0].customer_name,
        }));

      // Build invoice qb_id → DueDate lookup from the snapshot.
      const snapData = batch.snapshot_data || [];
      const invQbToDueDate = new Map();
      for (const inv of snapData) {
        if (inv?.qbId) invQbToDueDate.set(String(inv.qbId), inv.date || inv.dueDate || null);
      }
      // For the matched paid PUs, look up DueDate. Min/max tells us the
      // actual range; > snapshot_as_of would be a bug.
      const usedDueDates = [];
      for (const p of paid) {
        if (!p.invoice_qb_id) continue;
        const d = invQbToDueDate.get(String(p.invoice_qb_id));
        if (d) usedDueDates.push(d);
      }
      usedDueDates.sort();
      const dueDateAudit = {
        snapshot_total_invoices: snapData.length,
        matched_invoices_with_due_date: usedDueDates.length,
        earliest_due_date: usedDueDates[0] || null,
        latest_due_date: usedDueDates[usedDueDates.length - 1] || null,
        violates_as_of: usedDueDates.length > 0
          ? usedDueDates[usedDueDates.length - 1] > batch.snapshot_as_of
          : false,
      };

      res.json({
        batch: {
          id: batch.id,
          channel: batch.channel,
          status: batch.status,
          created_at: batch.created_at,
          finalized_at: batch.finalized_at,
          failure_reason: batch.failure_reason,
          snapshot_as_of: batch.snapshot_as_of,
          snapshot_created_at: batch.snapshot_created_at,
          stored_sheet_total: Number(batch.sheet_total || 0),
          stored_paid_total: Number(batch.paid_total || 0),
          stored_unused_total: Number(batch.unused_total || 0),
        },
        due_date_audit: dueDateAudit,
        totals: {
          paid_count: paid.length,
          paid_total: paidSum,
          unused_count: unused.length,
          unused_total: unusedSum,
          total: paidSum + unusedSum,
          distinct_bank_refs: distinctRefs.size,
          distinct_customers: distinctCustomers.size,
          multi_invoice_splits: splits.length,
        },
        anomalies: {
          plate_name_customers: plateNameRefs.length,
          missing_customer_id: missingCustomer.length,
          missing_invoice_id: missingInvoice.length,
          plate_name_sample: plateNameRefs.slice(0, 5).map((r) => ({
            ref: r.bank_ref, customer: r.customer_name, amount: Number(r.amount),
          })),
          missing_customer_sample: missingCustomer.slice(0, 5).map((r) => ({
            ref: r.bank_ref, customer: r.customer_name, amount: Number(r.amount),
          })),
        },
        amounts: {
          largest_10: suspiciouslyLarge.map((r) => ({
            ref: r.bank_ref, customer: r.customer_name, invoice: r.invoice_no, amount: Number(r.amount),
          })),
          smallest_under_500: suspiciouslySmall.map((r) => ({
            ref: r.bank_ref, customer: r.customer_name, invoice: r.invoice_no, amount: Number(r.amount),
          })),
        },
        splits_sample: splits.slice(0, 10),
        unused_sample: unused.slice(0, 10).map((r) => ({
          ref: r.bank_ref, customer: r.customer_name, amount: Number(r.amount),
        })),
      });
    } catch (err) {
      console.error('[verify-dry-run] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/find-bad-date-rows
  // Body: { channel, anchor_iso }  — anchor_iso is any timestamp within
  // the expected window; we scan a +/- 4h band of rows around its
  // row-number neighbourhood and flag rows whose Column B is empty or
  // unparseable. Returns each bad row's sheet_row_number, raw date text,
  // amount, customer, ref, and the nearest GOOD date above + below.
  // The operator can then drag-drop the date from a neighbour to fix.
  app.post('/api/admin/find-bad-date-rows', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const cfg = CHANNEL_SHEETS[channel];
      const anchorIsoRaw = String(req.body?.anchor_iso || '');
      if (!anchorIsoRaw) return res.status(400).json({ error: 'anchor_iso required' });
      const anchorTs = new Date(anchorIsoRaw);
      if (isNaN(+anchorTs)) return res.status(400).json({ error: 'invalid anchor_iso' });
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K80000`);
      const sheet = sheetData.values || sheetData.data || [];
      // First pass: find rows whose dates parse, mark their row numbers
      // and timestamps. Find the index range around the anchor (rows
      // whose timestamps are within +/- 12 hours of anchor).
      const bandSec = 12 * 3600;
      const goodRows = [];
      const badRowsInBand = [];
      let lastGoodAbove = null;
      const bandStart = anchorTs.getTime() - bandSec * 1000;
      const bandEnd = anchorTs.getTime() + bandSec * 1000;
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        const refCell = String(sheet[i][7] || '').trim();
        const amtCell = sheet[i][4];
        if (dCell) {
          const ts = parseTsAny(dCell);
          if (ts) {
            goodRows.push({ row: i + 1, ts: ts.getTime(), date_raw: dCell });
            if (ts.getTime() <= bandEnd) lastGoodAbove = { row: i + 1, date_raw: dCell, ts: ts.toISOString() };
            continue;
          }
        }
        // Bad row — date is missing or unparseable. Only report if it has
        // a ref AND amount (= a real transaction) AND is in the band.
        if (!refCell || !amtCell) continue;
        // We don't know the timestamp; include it if it sits between
        // good rows whose timestamps bracket the band. Heuristic: count
        // the surrounding good rows' band membership.
        badRowsInBand.push({
          sheet_row: i + 1,
          date_raw: dCell || '(empty)',
          amount: amtCell ? Number(String(amtCell).replace(/,/g, '')) : null,
          customer: sheet[i][6] || null,
          ref: refCell,
          nearest_good_date_above: lastGoodAbove ? {
            row: lastGoodAbove.row, date: lastGoodAbove.date_raw, ts: lastGoodAbove.ts,
          } : null,
        });
      }
      // For each bad row, also attach nearest good date BELOW
      let lastGoodBelow = null;
      for (let bi = badRowsInBand.length - 1; bi >= 0; bi--) {
        const bad = badRowsInBand[bi];
        // Find first good row with row > bad.sheet_row
        const below = goodRows.find((g) => g.row > bad.sheet_row);
        if (below) {
          bad.nearest_good_date_below = {
            row: below.row, date: String(sheet[below.row - 1][1] || ''),
            ts: new Date(below.ts).toISOString(),
          };
        }
      }
      // Filter to bad rows whose neighbour timestamps fall in the band
      const bandBad = badRowsInBand.filter((b) => {
        const a = b.nearest_good_date_above?.ts ? new Date(b.nearest_good_date_above.ts).getTime() : null;
        const z = b.nearest_good_date_below?.ts ? new Date(b.nearest_good_date_below.ts).getTime() : null;
        return (a != null && a >= bandStart && a <= bandEnd)
            || (z != null && z >= bandStart && z <= bandEnd);
      });
      res.json({
        channel,
        sheet_tab: cfg.tab,
        anchor_iso: anchorTs.toISOString(),
        band_hours: 12,
        sheet_total_rows: sheet.length - 1,
        bad_rows_in_band_count: bandBad.length,
        bad_rows_total_anywhere: badRowsInBand.length,
        bad_rows: bandBad.slice(0, 100),
      });
    } catch (err) {
      console.error('[find-bad-date-rows] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/find-already-consumed-refs-in-window
  // Body: { channel, since_iso, until_iso }
  // Lists sheet refs in the window that are ALREADY in consumed_transactions
  // or external_consumed_refs — these are what BRAIN's dry-run drops, causing
  // a sheet_sum smaller than the drag-drop total.
  app.post('/api/admin/find-already-consumed-refs-in-window', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const cfg = CHANNEL_SHEETS[channel];
      const sinceIso = new Date(String(req.body?.since_iso || ''));
      const untilIso = new Date(String(req.body?.until_iso || ''));
      if (isNaN(+sinceIso) || isNaN(+untilIso)) return res.status(400).json({ error: 'since_iso and until_iso required' });
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K80000`);
      const sheet = sheetData.values || sheetData.data || [];
      const rowsInWindow = [];
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (!ts) continue;
        if (ts < sinceIso || ts >= untilIso) continue;
        const ref = String(sheet[i][7] || '').trim();
        if (!ref) continue;
        const suffixed = appendSuf(ref, channel);
        rowsInWindow.push({
          sheet_row: i + 1,
          date: dCell,
          amount: sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : 0,
          customer: sheet[i][6] || null,
          ref,
          suffixed,
        });
      }
      const suffixedRefs = rowsInWindow.map((r) => r.suffixed);
      // Find which of these are in consumed_transactions
      const consumed = await db().query(
        `SELECT bank_ref, batch_id FROM consumed_transactions WHERE bank_ref = ANY($1::text[])`,
        [suffixedRefs],
      );
      const external = await db().query(
        `SELECT bank_ref FROM external_consumed_refs WHERE bank_ref = ANY($1::text[])`,
        [suffixedRefs],
      );
      const consumedMap = new Map(consumed.rows.map((r) => [r.bank_ref, String(r.batch_id).slice(0, 8)]));
      const externalSet = new Set(external.rows.map((r) => r.bank_ref));
      const blocked = rowsInWindow.filter((r) => consumedMap.has(r.suffixed) || externalSet.has(r.suffixed));
      const blockedAmount = blocked.reduce((s, r) => s + r.amount, 0);
      res.json({
        channel,
        window: { since: sinceIso.toISOString(), until: untilIso.toISOString() },
        rows_in_window: rowsInWindow.length,
        blocked_count: blocked.length,
        blocked_total_amount: blockedAmount,
        blocked_rows: blocked.map((r) => ({
          ...r,
          source: consumedMap.has(r.suffixed) ? `consumed_transactions (batch ${consumedMap.get(r.suffixed)})` : 'external_consumed_refs',
        })),
      });
    } catch (err) {
      console.error('[find-already-consumed-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/find-duplicate-refs-in-window
  // Body: { channel, since_iso, until_iso }
  // Reads the channel sheet, finds rows in window, groups by bank_ref
  // (column H), and returns refs appearing 2+ times with their row
  // numbers, dates, amounts, customers. Exactly what BRAIN's intra-window
  // dedup drops.
  app.post('/api/admin/find-duplicate-refs-in-window', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const cfg = CHANNEL_SHEETS[channel];
      const sinceIso = new Date(String(req.body?.since_iso || ''));
      const untilIso = new Date(String(req.body?.until_iso || ''));
      if (isNaN(+sinceIso) || isNaN(+untilIso)) return res.status(400).json({ error: 'since_iso and until_iso required' });
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K80000`);
      const sheet = sheetData.values || sheetData.data || [];
      const refMap = new Map(); // ref → [{row, date, amount, customer}]
      let inWindow = 0;
      let withRef = 0;
      let sumInWindow = 0;
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (!ts) continue;
        if (ts < sinceIso || ts >= untilIso) continue;
        inWindow++;
        const ref = String(sheet[i][7] || '').trim();
        if (!ref) continue;
        withRef++;
        const amt = sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : 0;
        sumInWindow += amt;
        if (!refMap.has(ref)) refMap.set(ref, []);
        refMap.get(ref).push({
          sheet_row: i + 1,
          date: dCell,
          amount: amt,
          customer: sheet[i][6] || null,
        });
      }
      const dupes = [];
      let dupeAmount = 0;
      for (const [ref, list] of refMap) {
        if (list.length > 1) {
          dupes.push({
            ref,
            count: list.length,
            occurrences: list,
            total_amount_in_dupes: list.reduce((s, r) => s + r.amount, 0),
            extra_kept_by_drag_drop: list.slice(1).reduce((s, r) => s + r.amount, 0),
          });
          dupeAmount += list.slice(1).reduce((s, r) => s + r.amount, 0);
        }
      }
      res.json({
        channel,
        window: { since: sinceIso.toISOString(), until: untilIso.toISOString() },
        rows_in_window: inWindow,
        rows_with_ref: withRef,
        unique_refs: refMap.size,
        duplicate_ref_groups: dupes.length,
        sheet_sum_with_dupes: sumInWindow,
        excess_from_dupes: dupeAmount,
        true_sum_after_dedup: sumInWindow - dupeAmount,
        duplicates: dupes,
      });
    } catch (err) {
      console.error('[find-duplicate-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/clear-marker-column
  // Body: { channel, column: 'I' | 'J' | 'K' }
  // Wipes the entire column on the channel sheet. Used to clean stray
  // operator legacy data from marker columns before BRAIN starts using
  // them as locks (e.g. NMB row 66857 had a pre-existing K value
  // blocking the K-boundary check). Protected ranges mean only the
  // service account can do this.
  app.post('/api/admin/clear-marker-column', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const column = String(req.body?.column || '').toUpperCase();
      if (!['I', 'J', 'K'].includes(column)) {
        return res.status(400).json({ error: 'column must be I, J, or K' });
      }
      const cfg = CHANNEL_SHEETS[channel];
      const r = await clearSheetColumn(cfg.sheetId, cfg.tab, column);
      res.json({ channel, sheet_tab: cfg.tab, column, ...r });
    } catch (err) {
      console.error('[clear-marker-column] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/protect-marker-columns
  // Body: { channel } — locks columns I/J/K on the channel sheet so only
  // the BRAIN service account can edit them. Operators with edit access
  // can still touch A-H normally but can't accidentally wipe the
  // Fetched-at / QB-pushed / end-of-tick markers. Run once per channel
  // sheet during setup. Idempotent (returns alreadyExists if re-run).
  app.post('/api/admin/protect-marker-columns', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const cfg = CHANNEL_SHEETS[channel];
      const r = await protectMarkerColumns(cfg.sheetId, cfg.tab);
      res.json({ channel, sheet_tab: cfg.tab, ...r });
    } catch (err) {
      console.error('[protect-marker-columns] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/qb-find-suffixed
  // Body: { channel, since_date: 'YYYY-MM-DD', until_date: 'YYYY-MM-DD' }
  // Queries QB for every active Payment with TxnDate in [since_date,
  // until_date], paginated, and returns those whose PrivateNote ends in
  // the channel's suffix (N/B/P). Use to find BRAIN-pushed ghosts that
  // have no payment_uploads row (so qb-active-by-refs can't help).
  app.post('/api/admin/qb-find-suffixed', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const suffix = { bank: 'B', iphone_bank: 'P', nmbnew: 'N' }[channel];
      const since = String(req.body?.since_date || '').match(/^\d{4}-\d{2}-\d{2}$/);
      const until = String(req.body?.until_date || '').match(/^\d{4}-\d{2}-\d{2}$/);
      if (!since || !until) return res.status(400).json({ error: 'since_date and until_date required (YYYY-MM-DD)' });
      const sinceDate = since[0], untilDate = until[0];
      // Paginate. QB MAXRESULTS=1000 max.
      const PAGE = 1000;
      let start = 1;
      const all = [];
      let pages = 0;
      while (true) {
        pages++;
        const r = await qbQuery(
          `SELECT Id, PrivateNote, TotalAmt, TxnDate, CustomerRef FROM Payment ` +
          `WHERE TxnDate >= '${sinceDate}' AND TxnDate <= '${untilDate}' ` +
          `STARTPOSITION ${start} MAXRESULTS ${PAGE}`,
        );
        const pmts = r.QueryResponse?.Payment || [];
        all.push(...pmts);
        if (pmts.length < PAGE) break;
        start += PAGE;
        if (pages > 30) break; // safety: 30k Payments max
      }
      // Filter by suffix — case-insensitive so a stray lowercase suffix
      // (e.g. operator copy-pasted 'p' instead of 'P') still gets caught.
      const sufLower = suffix.toLowerCase();
      const matching = all
        .filter((p) => {
          const pn = String(p.PrivateNote || '');
          return pn.length > 0 && pn.charAt(pn.length - 1).toLowerCase() === sufLower;
        })
        .map((p) => ({
          qb_id: String(p.Id),
          privateNote: p.PrivateNote,
          amount: Number(p.TotalAmt),
          txnDate: p.TxnDate,
          customerRef: p.CustomerRef?.value,
          customerName: p.CustomerRef?.name,
        }));
      res.json({
        channel,
        since_date: sinceDate,
        until_date: untilDate,
        pages_fetched: pages,
        total_payments_in_range: all.length,
        suffixed_count: matching.length,
        suffixed_total: matching.reduce((s, p) => s + p.amount, 0),
        matching,
      });
    } catch (err) {
      console.error('[qb-find-suffixed] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/qb-active-by-refs
  // Body: { channel, refs: [...] }
  // For each ref (suffixed with channel), queries QB for active Payments
  // whose PrivateNote matches, then cross-references with payment_uploads.
  // Returns per ref:
  //   - qb_active: list of {qb_id, amount, txnDate, customerRef} from QB
  //   - db_voided: list of qb_ids our DB thinks we voided
  //   - silent_void_failures: qb_ids active in QB AND status='voided' in DB
  //                           (= qbVoid said ok but Payment is still alive)
  //   - untracked: qb_ids active in QB but no payment_uploads record
  //                (= manual SaasAnt upload OR untracked BRAIN push)
  app.post('/api/admin/qb-active-by-refs', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel; need one of: ' + Object.keys(CHANNEL_SHEETS).join(',') });
      const refs = Array.isArray(req.body?.refs) ? req.body.refs.map(String).filter(Boolean) : [];
      if (refs.length === 0) return res.status(400).json({ error: 'refs[] required' });
      const suffix = { bank: 'B', iphone_bank: 'P', nmbnew: 'N' }[channel];
      // Normalize: ensure we have both bare and suffixed forms
      const suffixedRefs = refs.map((r) => (suffix && r.endsWith(suffix)) ? r : appendSuf(r, channel));
      // Look up DB records first — we need customer_id per ref to query QB by customer
      const pus = await db().query(
        `SELECT bank_ref, customer_id, qb_id, status FROM payment_uploads
          WHERE bank_ref = ANY($1::text[]) AND qb_id IS NOT NULL`,
        [suffixedRefs],
      );
      const dbByRef = new Map();
      const customerByRef = new Map();
      for (const r of pus.rows) {
        if (!dbByRef.has(r.bank_ref)) dbByRef.set(r.bank_ref, []);
        dbByRef.get(r.bank_ref).push({ qb_id: String(r.qb_id), status: r.status });
        if (r.customer_id) customerByRef.set(r.bank_ref, String(r.customer_id));
      }
      // Query QB: PrivateNote is not directly queryable. Instead query
      // Payment WHERE CustomerRef = X AND TxnDate >= '2026-06-04', then
      // filter results by PrivateNote in code.
      const qbHits = new Map();
      const dateFrom = '2026-06-03';
      for (const sref of suffixedRefs) {
        const customerId = customerByRef.get(sref);
        if (!customerId) {
          qbHits.set(sref, { error: 'no customer_id in payment_uploads — cannot query QB' });
          continue;
        }
        try {
          const r = await qbQuery(
            `SELECT Id, PrivateNote, TotalAmt, TxnDate, CustomerRef FROM Payment WHERE CustomerRef = '${customerId}' AND TxnDate >= '${dateFrom}' MAXRESULTS 1000`,
          );
          const pmts = r.QueryResponse?.Payment || [];
          // Filter client-side by PrivateNote
          const matching = pmts.filter((p) => String(p.PrivateNote || '') === sref).map((p) => ({
            qb_id: String(p.Id),
            privateNote: p.PrivateNote,
            amount: Number(p.TotalAmt),
            txnDate: p.TxnDate,
            customerRef: p.CustomerRef?.value,
            customerName: p.CustomerRef?.name,
          }));
          qbHits.set(sref, matching);
        } catch (err) {
          qbHits.set(sref, { error: String(err.message || err).slice(0, 200) });
        }
      }
      // Assemble per-ref diagnosis
      const results = [];
      for (let i = 0; i < refs.length; i++) {
        const sref = suffixedRefs[i];
        const qb = qbHits.get(sref);
        if (Array.isArray(qb)) {
          const dbRows = dbByRef.get(sref) || [];
          const dbVoidedIds = new Set(dbRows.filter((r) => r.status === 'voided').map((r) => r.qb_id));
          const dbCreatedIds = new Set(dbRows.filter((r) => r.status === 'created').map((r) => r.qb_id));
          const dbAllIds = new Set(dbRows.map((r) => r.qb_id));
          const activeIds = new Set(qb.map((p) => p.qb_id));
          const silentVoidFailures = qb.filter((p) => dbVoidedIds.has(p.qb_id));
          const stillCreated = qb.filter((p) => dbCreatedIds.has(p.qb_id));
          const untracked = qb.filter((p) => !dbAllIds.has(p.qb_id));
          results.push({
            ref: refs[i],
            suffixed_ref: sref,
            qb_active_count: qb.length,
            qb_active: qb,
            db_voided_count: dbVoidedIds.size,
            db_created_count: dbCreatedIds.size,
            silent_void_failures: silentVoidFailures,
            still_in_created_state: stillCreated,
            untracked,
          });
        } else {
          results.push({ ref: refs[i], suffixed_ref: sref, error: qb?.error || 'qb query failed' });
        }
      }
      res.json({ channel, results });
    } catch (err) {
      console.error('[qb-active-by-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/find-refs-in-sheet
  // Body: { channel, refs: [...] }
  // For each ref, returns: sheet row, sheet_ts, amount, customer_name,
  // Column I, Column J, and matching payment_uploads rows (status, qb_id,
  // batch_id). Diagnostic for understanding why a QB Payment exists when
  // the void-by-sheet-window claimed clean. Refs are matched both bare and
  // with channel suffix (e.g. NMB ref + 'N').
  app.post('/api/admin/find-refs-in-sheet', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel; need one of: ' + Object.keys(CHANNEL_SHEETS).join(',') });
      const cfg = CHANNEL_SHEETS[channel];
      const refs = Array.isArray(req.body?.refs) ? req.body.refs.map(String) : [];
      if (refs.length === 0) return res.status(400).json({ error: 'refs[] required' });
      // Build lookup: bare ref → original input ref (so we can also match suffixed form)
      const refSet = new Set();
      const refOrig = new Map();
      for (const r of refs) {
        const trimmed = r.trim();
        if (!trimmed) continue;
        refSet.add(trimmed);
        refOrig.set(trimmed, trimmed);
        // also strip the channel suffix if user passed the suffixed version
        const suf = { bank: 'B', iphone_bank: 'P', nmbnew: 'N' }[channel];
        if (suf && trimmed.endsWith(suf)) {
          const bare = trimmed.slice(0, -1);
          refSet.add(bare);
          refOrig.set(bare, trimmed);
        }
      }
      // 1. Scan the sheet
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:J80000`);
      const sheet = sheetData.values || sheetData.data || [];
      const sheetHits = new Map(); // bareRef → row info
      for (let i = 1; i < sheet.length; i++) {
        const rawRef = String(sheet[i][7] || '').trim();
        if (!rawRef) continue;
        if (refSet.has(rawRef)) {
          const dCell = String(sheet[i][1] || '').trim();
          const ts = parseTsAny(dCell);
          if (!sheetHits.has(rawRef)) sheetHits.set(rawRef, []);
          sheetHits.get(rawRef).push({
            sheet_row: i + 1,
            sheet_ts: ts ? ts.toISOString() : null,
            sheet_ts_raw: dCell,
            amount: sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : null,
            customer_name: sheet[i][6] || null,
            col_i: String(sheet[i][8] || '').trim() || null,
            col_j: String(sheet[i][9] || '').trim() || null,
          });
        }
      }
      // 2. Look up payment_uploads (with channel suffix)
      const suffixedRefs = [...refSet].map((r) => appendSuf(r, channel));
      const pus = await db().query(
        `SELECT id, batch_id, bank_ref, customer_id, customer_name,
                invoice_qb_id, invoice_no, amount, qb_id, status, created_at,
                voided_at, failure_reason
           FROM payment_uploads
          WHERE bank_ref = ANY($1::text[])
          ORDER BY bank_ref, id`,
        [suffixedRefs],
      );
      const pusByRef = new Map();
      for (const r of pus.rows) {
        const bare = r.bank_ref.endsWith({ bank: 'B', iphone_bank: 'P', nmbnew: 'N' }[channel])
          ? r.bank_ref.slice(0, -1) : r.bank_ref;
        if (!pusByRef.has(bare)) pusByRef.set(bare, []);
        pusByRef.get(bare).push({
          id: r.id,
          batch_id: String(r.batch_id).slice(0, 8),
          status: r.status,
          qb_id: r.qb_id,
          amount: Number(r.amount),
          customer_name: r.customer_name,
          created_at: r.created_at,
          voided_at: r.voided_at,
          failure_reason: r.failure_reason ? String(r.failure_reason).slice(0, 150) : null,
        });
      }
      // 3. Assemble per-ref report
      const results = [];
      for (const ref of refs) {
        const trimmed = ref.trim();
        const bare = trimmed.endsWith({ bank: 'B', iphone_bank: 'P', nmbnew: 'N' }[channel])
          ? trimmed.slice(0, -1) : trimmed;
        results.push({
          ref_input: trimmed,
          bare_ref: bare,
          sheet_hits: sheetHits.get(bare) || [],
          payment_uploads: pusByRef.get(bare) || [],
        });
      }
      res.json({ channel, sheet_tab: cfg.tab, results });
    } catch (err) {
      console.error('[find-refs-in-sheet] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/sheet-lock-audit?channel=nmbnew[&since_iso=...&until_iso=...]
  // Reads the channel sheet (cols A:J) and reports each row's I/J state.
  // The four buckets:
  //   - pushed_ok:    I set + J set    (normal — payment landed)
  //   - in_flight:    I set + J empty AND I timestamp < 10 min ago (run still running, leave alone)
  //   - silent_fail:  I set + J empty AND I timestamp ≥ 10 min ago  (FAILURE — payment never made it)
  //   - untouched:    I empty + J empty (in window, never processed)
  //   - anomaly:      I empty + J set   (shouldn't happen — manual edit?)
  // Frank's audit rule: silent_fail rows MUST be re-fired or the books won't balance.
  app.get('/api/admin/sheet-lock-audit', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.query.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel; need one of: ' + Object.keys(CHANNEL_SHEETS).join(',') });
      const cfg = CHANNEL_SHEETS[channel];
      const sinceIso = req.query.since_iso ? new Date(String(req.query.since_iso)) : null;
      const untilIso = req.query.until_iso ? new Date(String(req.query.until_iso)) : null;
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:J80000`);
      const rows = sheetData.values || sheetData.data || [];
      const now = Date.now();
      const STALE_MS = 10 * 60 * 1000;
      const pushed_ok = [];
      const in_flight = [];
      const silent_fail = [];
      const anomaly = [];
      let untouched_in_window = 0;
      for (let i = 1; i < rows.length; i++) {
        const dCell = String(rows[i][1] || '').trim();
        if (!dCell) continue; // empty-date skip rows
        const ts = parseTsAny(dCell);
        if (!ts) continue;
        if (sinceIso && ts < sinceIso) continue;
        if (untilIso && ts >= untilIso) continue;
        const ref = String(rows[i][7] || '').trim();
        const amount = rows[i][4] ? Number(String(rows[i][4]).replace(/,/g, '')) : null;
        const colI = String(rows[i][8] || '').trim();
        const colJ = String(rows[i][9] || '').trim();
        const rec = {
          sheet_row: i + 1, sheet_ts: ts.toISOString(), bank_ref: ref,
          amount, col_i: colI || null, col_j: colJ || null,
        };
        if (colI && colJ) { pushed_ok.push(rec); continue; }
        if (!colI && !colJ) { untouched_in_window++; continue; }
        if (!colI && colJ) { anomaly.push(rec); continue; }
        // colI set, colJ empty
        const m = colI.match(/Fetched at:\s*(\S+)/);
        const fetchedTs = m ? new Date(m[1]).getTime() : 0;
        if (fetchedTs && now - fetchedTs < STALE_MS) in_flight.push(rec);
        else silent_fail.push(rec);
      }
      res.json({
        channel,
        sheet_tab: cfg.tab,
        window: { since_iso: sinceIso?.toISOString() || null, until_iso: untilIso?.toISOString() || null },
        summary: {
          pushed_ok: pushed_ok.length,
          in_flight: in_flight.length,
          silent_fail: silent_fail.length,
          anomaly: anomaly.length,
          untouched_in_window,
        },
        silent_fail,
        in_flight,
        anomaly,
        pushed_ok_sample: pushed_ok.slice(0, 5),
      });
    } catch (err) {
      console.error('[sheet-lock-audit] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/void-by-sheet-window
  // Body: { channel, since_iso, until_iso, dry_run, reason }
  // Recall window: reads the channel sheet, finds every row whose sheet_ts
  // falls in [since_iso, until_iso), maps each row's bank_ref → matching PUs
  // in DB (status='created', qb_id set), and:
  //   - dry_run=true:  returns the plan (count, total amount, sample refs)
  //                    without voiding anything
  //   - dry_run=false: voids each PU in QB, marks status='voided', clears
  //                    Column I and J on the affected sheet rows so the next
  //                    fresh fire reprocesses them
  // SAFETY: ONLY touches PUs we pushed (qb_id set, batch_id set). Manual
  // invoices in QB are never voided because they have no payment_uploads row.
  app.post('/api/admin/void-by-sheet-window', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel; need one of: ' + Object.keys(CHANNEL_SHEETS).join(',') });
      const cfg = CHANNEL_SHEETS[channel];
      const sinceIso = req.body?.since_iso ? new Date(String(req.body.since_iso)) : null;
      const untilIso = req.body?.until_iso ? new Date(String(req.body.until_iso)) : null;
      if (!sinceIso || !untilIso || isNaN(+sinceIso) || isNaN(+untilIso)) {
        return res.status(400).json({ error: 'since_iso and until_iso required (ISO 8601)' });
      }
      const dryRun = req.body?.dry_run !== false; // default to dry_run for safety
      const reason = String(req.body?.reason || 'operator window recall via void-by-sheet-window');

      // 1. Read sheet and collect (sheet_row, bank_ref_with_suffix) for rows in window
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:J80000`);
      const sheet = sheetData.values || sheetData.data || [];
      const refToRow = new Map();           // bank_ref_with_suffix → sheet_row_number
      const rowAmounts = new Map();         // sheet_row_number → amount (for display)
      const rowTs = new Map();              // sheet_row_number → sheet_ts (for display)
      let scannedRows = 0;
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (!ts) continue;
        if (ts < sinceIso || ts >= untilIso) continue;
        scannedRows++;
        const rawRef = String(sheet[i][7] || '').trim();
        if (!rawRef) continue;
        const bankRef = appendSuf(rawRef, channel);
        if (!bankRef) continue;
        const sheetRow = i + 1;
        refToRow.set(bankRef, sheetRow);
        rowAmounts.set(sheetRow, sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : null);
        rowTs.set(sheetRow, ts.toISOString());
      }
      const bankRefs = [...refToRow.keys()];

      // 2. Find matching PUs in DB (only BRAIN pushes with qb_id)
      let pus = { rows: [] };
      if (bankRefs.length > 0) {
        pus = await db().query(
          `SELECT id, batch_id, bank_ref, customer_id, customer_name,
                  invoice_qb_id, invoice_no, amount, qb_id, status, created_at
             FROM payment_uploads
            WHERE bank_ref = ANY($1::text[])
              AND status = 'created'
              AND qb_id IS NOT NULL
            ORDER BY bank_ref, id`,
          [bankRefs],
        );
      }
      const totalAmount = pus.rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      const uniqueRefsHit = new Set(pus.rows.map((r) => r.bank_ref)).size;
      const sheetRowsAffected = new Set();
      for (const r of pus.rows) {
        const row = refToRow.get(r.bank_ref);
        if (row) sheetRowsAffected.add(row);
      }

      if (dryRun) {
        return res.json({
          dry_run: true,
          channel,
          window: { since_iso: sinceIso.toISOString(), until_iso: untilIso.toISOString() },
          scanned_sheet_rows: scannedRows,
          unique_bank_refs_in_window: bankRefs.length,
          unique_bank_refs_with_pus: uniqueRefsHit,
          total_pus_to_void: pus.rows.length,
          total_amount: totalAmount,
          sheet_rows_to_clear: sheetRowsAffected.size,
          sample_pus: pus.rows.slice(0, 10).map((r) => ({
            bank_ref: r.bank_ref, customer_name: r.customer_name,
            amount: Number(r.amount), qb_id: r.qb_id,
            batch_id: String(r.batch_id).slice(0, 8),
          })),
        });
      }

      // 3. REAL RUN — void each PU in QB (parallel, conservative concurrency)
      let voided = 0, voidFailed = 0;
      const failures = [];
      const PAR = 6;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= pus.rows.length) return;
          const u = pus.rows[i];
          try {
            const r = await qbVoid({ kind: 'payment', qbId: u.qb_id });
            const ok = !!r && (r.ok !== false);
            if (ok) {
              await db().query(
                `UPDATE payment_uploads SET status='voided', voided_at=now() WHERE id=$1 AND status='created'`,
                [u.id],
              );
              voided++;
            } else {
              voidFailed++;
              failures.push({ qb_id: u.qb_id, bank_ref: u.bank_ref, error: r?.error || 'unknown' });
            }
          } catch (err) {
            voidFailed++;
            failures.push({ qb_id: u.qb_id, bank_ref: u.bank_ref, error: String(err.message || err).slice(0, 200) });
          }
        }
      };
      await Promise.all(Array.from({ length: PAR }, () => worker()));

      // 4. Clear Column I + J on every affected sheet row so the next fresh
      // fire treats them as untouched and re-pushes them under the new locks.
      let cellsCleared = 0;
      try {
        if (sheetRowsAffected.size > 0) {
          const updates = [];
          for (const row of sheetRowsAffected) {
            updates.push({ range: `${cfg.tab}!I${row}`, value: '' });
            updates.push({ range: `${cfg.tab}!J${row}`, value: '' });
          }
          const r = await writeSheetCells(cfg.sheetId, updates);
          cellsCleared = r.updatedCells || 0;
        }
      } catch (err) {
        console.error('[void-by-sheet-window] clear I/J failed (non-fatal):', err.message);
      }

      res.json({
        dry_run: false,
        channel,
        reason,
        window: { since_iso: sinceIso.toISOString(), until_iso: untilIso.toISOString() },
        scanned_sheet_rows: scannedRows,
        unique_bank_refs_in_window: bankRefs.length,
        attempted_void: pus.rows.length,
        voided,
        void_failed: voidFailed,
        total_amount_voided: pus.rows.filter((_, i) => i < voided).reduce((s, r) => s + Number(r.amount || 0), 0),
        sheet_rows_cleared: sheetRowsAffected.size,
        sheet_cells_cleared: cellsCleared,
        sample_failures: failures.slice(0, 10),
      });
    } catch (err) {
      console.error('[void-by-sheet-window] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/audit-batch-pushes
  // Body: { batch_id }
  // Per-Payment audit of a batch's pushes. For each PU with status='created'
  // and qb_id set: verifies (1) Payment exists in QB, (2) amount matches,
  // (3) no other Payment exists for the same (customer, PrivateNote),
  // (4) deposit account is Kijichi. Returns pass/fail per PU.
  app.post('/api/admin/audit-batch-pushes', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.body?.batch_id || '');
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      let fullId = batchId;
      if (batchId.length < 36) {
        const r = await db().query(`SELECT id FROM payment_batches WHERE id::text LIKE $1 LIMIT 1`, [batchId + '%']);
        if (!r.rows.length) return res.status(404).json({ error: 'batch not found' });
        fullId = r.rows[0].id;
      }
      const r = await db().query(
        `SELECT id, bank_ref, customer_id, customer_name, invoice_qb_id, amount, qb_id
           FROM payment_uploads
          WHERE batch_id = $1 AND status = 'created' AND qb_id IS NOT NULL`,
        [fullId],
      );
      const rows = r.rows;
      // Get Kijichi account id
      const acctRes = await qbQuery(`SELECT Id FROM Account WHERE Name = 'Kijichi Collection AC'`);
      const kijichiId = acctRes.QueryResponse?.Account?.[0]?.Id;
      // Bulk-query QB for each customer's recent Payments (so we can detect dupes)
      const byCust = new Map();
      for (const row of rows) {
        if (!byCust.has(row.customer_id)) byCust.set(row.customer_id, []);
        byCust.get(row.customer_id).push(row);
      }
      const sinceISO = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const failures = [];
      let passCount = 0;
      const PAR = 4;
      let cursor = 0;
      const custList = [...byCust.entries()];
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= custList.length) return;
          const [custId, custRows] = custList[i];
          try {
            const q = await qbQuery(
              `SELECT Id, TotalAmt, PrivateNote, DepositToAccountRef ` +
              `FROM Payment WHERE CustomerRef = '${custId}' AND TxnDate >= '${sinceISO}' MAXRESULTS 1000`,
            );
            const allCustPmts = q.QueryResponse?.Payment || [];
            // Index by PrivateNote
            const byNote = new Map();
            for (const p of allCustPmts) {
              const note = String(p.PrivateNote || '').trim();
              if (!note) continue;
              if (!byNote.has(note)) byNote.set(note, []);
              byNote.get(note).push(p);
            }
            for (const row of custRows) {
              const note = row.bank_ref;
              const matches = byNote.get(note) || [];
              const livePmts = matches.filter((p) => Number(p.TotalAmt || 0) > 0);
              if (livePmts.length === 0) {
                failures.push({ qb_id: row.qb_id, bank_ref: note, reason: 'no live Payment found in QB' });
              } else if (livePmts.length > 1) {
                failures.push({
                  qb_id: row.qb_id, bank_ref: note,
                  reason: `duplicate: ${livePmts.length} Payments found in QB`,
                  duplicate_ids: livePmts.map((p) => p.Id),
                });
              } else {
                const p = livePmts[0];
                if (Number(p.TotalAmt || 0) !== Number(row.amount || 0)) {
                  failures.push({
                    qb_id: row.qb_id, bank_ref: note,
                    reason: `amount mismatch: QB=${p.TotalAmt} vs PU=${row.amount}`,
                  });
                } else if (kijichiId && String(p.DepositToAccountRef?.value || '') !== String(kijichiId)) {
                  failures.push({
                    qb_id: row.qb_id, bank_ref: note,
                    reason: `wrong deposit account: ${p.DepositToAccountRef?.value} (not Kijichi)`,
                  });
                } else {
                  passCount++;
                }
              }
            }
          } catch (err) {
            for (const row of custRows) failures.push({ qb_id: row.qb_id, bank_ref: row.bank_ref, reason: 'qb query error: ' + String(err.message || err).slice(0, 100) });
          }
        }
      };
      await Promise.all(Array.from({ length: PAR }, () => worker()));
      res.json({
        batch_id: fullId,
        total_pushed: rows.length,
        pass: passCount,
        fail: failures.length,
        failures: failures.slice(0, 50),
      });
    } catch (err) {
      console.error('[audit-batch-pushes] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/quickreport?from=YYYY-MM-DD&to=YYYY-MM-DD&account=Kijichi%20Collection%20AC
  // Calls QB's Reports API directly — returns the EXACT same data Frank gets
  // when exporting the "Account QuickReport" from the QB UI (including invoice
  // splits, multi-line Payments, reversal entries like "DOUBLE", etc).
  app.get('/api/admin/quickreport', requireSecretOrJwt, async (req, res) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || from);
      if (!from) return res.status(400).json({ error: 'from=YYYY-MM-DD required' });
      const acctName = String(req.query.account || 'Kijichi Collection AC');
      const acctRes = await qbQuery(
        `SELECT Id, Name FROM Account WHERE Name = '${acctName.replace(/'/g, "''")}'`,
      );
      const acct = acctRes.QueryResponse?.Account?.[0];
      if (!acct) return res.status(404).json({ error: `account "${acctName}" not found` });
      // Call QB Reports API — TransactionList filtered by account
      const report = await qbReport('TransactionList', {
        start_date: from,
        end_date: to,
        accounts: acct.Id,
      });
      // Parse the report rows into a flat structure
      const rowsOut = [];
      function walkRows(rows) {
        for (const row of rows) {
          if (row.type === 'Section' && row.Rows?.Row) {
            walkRows(row.Rows.Row);
          } else if (row.type === 'Data' && row.ColData) {
            rowsOut.push(row.ColData.map((c) => c.value || ''));
          }
        }
      }
      walkRows(report.Rows?.Row || []);
      // Try to identify the Amount column
      const cols = report.Columns?.Column?.map((c) => c.ColTitle || c.ColType) || [];
      const amtIdx = cols.findIndex((c) => /amount/i.test(c));
      let total = 0;
      if (amtIdx >= 0) {
        for (const row of rowsOut) {
          const v = String(row[amtIdx] || '').replace(/[,]/g, '');
          const n = parseFloat(v);
          if (!isNaN(n)) total += n;
        }
      }
      res.json({
        account: acct.Name,
        account_id: acct.Id,
        from, to,
        columns: cols,
        row_count: rowsOut.length,
        amount_col_index: amtIdx,
        total,
        rows: rowsOut,
      });
    } catch (err) {
      console.error('[quickreport] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/chart-of-accounts?from=YYYY-MM-DD&to=YYYY-MM-DD&account=Kijichi%20Collection%20AC
  // Returns one row per Payment line for the date range, matching the structure
  // of Frank's xlsx chart-of-accounts export:
  //   txn_date | qb_id | amount | customer | private_note | created_by | brain_pushed
  // Per-batch verification check #4 (alongside Kijichi-total + inflation + doubles).
  app.get('/api/admin/chart-of-accounts', requireSecretOrJwt, async (req, res) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || from);
      if (!from) return res.status(400).json({ error: 'from=YYYY-MM-DD required' });
      const acctName = String(req.query.account || 'Kijichi Collection AC');
      // Resolve account id
      const acctRes = await qbQuery(
        `SELECT Id, Name FROM Account WHERE Name = '${acctName.replace(/'/g, "''")}'`,
      );
      const acct = acctRes.QueryResponse?.Account?.[0];
      if (!acct) return res.status(404).json({ error: `account "${acctName}" not found` });
      // Pull all Payments in range
      const all = [];
      let start = 1;
      while (true) {
        const r = await qbQuery(
          `SELECT Id, TotalAmt, TxnDate, PrivateNote, CustomerRef, DepositToAccountRef, MetaData ` +
          `FROM Payment WHERE TxnDate >= '${from}' AND TxnDate <= '${to}' ` +
          `STARTPOSITION ${start} MAXRESULTS 1000`,
        );
        const rows = r.QueryResponse?.Payment || [];
        all.push(...rows);
        if (rows.length < 1000) break;
        start += 1000;
      }
      // Filter to this account
      const matched = all.filter((p) => String(p.DepositToAccountRef?.value || '') === String(acct.Id));
      // Bulk customer lookup
      const custIds = [...new Set(matched.map((p) => p.CustomerRef?.value).filter(Boolean))];
      const custMap = {};
      for (let i = 0; i < custIds.length; i += 30) {
        const chunk = custIds.slice(i, i + 30);
        const inList = chunk.map((id) => "'" + String(id).replace(/'/g, "''") + "'").join(',');
        const cr = await qbQuery(`SELECT Id, DisplayName FROM Customer WHERE Id IN (${inList})`);
        for (const c of (cr.QueryResponse?.Customer || [])) custMap[c.Id] = c.DisplayName;
      }
      // Cross-reference with payment_uploads for BRAIN-pushed flag
      const ids = matched.map((p) => String(p.Id));
      const pu = await db().query(
        `SELECT qb_id FROM payment_uploads WHERE qb_id = ANY($1)`,
        [ids],
      );
      const brainIds = new Set(pu.rows.map((r) => String(r.qb_id)));
      const rows = matched.map((p) => ({
        txn_date: p.TxnDate,
        qb_id: p.Id,
        amount: Number(p.TotalAmt || 0),
        customer: custMap[p.CustomerRef?.value] || p.CustomerRef?.value || '?',
        private_note: p.PrivateNote || '',
        create_time: p.MetaData?.CreateTime || null,
        brain_pushed: brainIds.has(String(p.Id)),
      }));
      const totalByDate = {};
      for (const r of rows) {
        totalByDate[r.txn_date] = totalByDate[r.txn_date] || { count: 0, sum: 0, brain: 0, manual: 0 };
        totalByDate[r.txn_date].count++;
        totalByDate[r.txn_date].sum += r.amount;
        if (r.brain_pushed) totalByDate[r.txn_date].brain += r.amount;
        else totalByDate[r.txn_date].manual += r.amount;
      }
      const grand = rows.reduce((s, r) => s + r.amount, 0);
      res.json({
        account: acct.Name,
        account_id: acct.Id,
        from, to,
        count: rows.length,
        grand_total: grand,
        by_date: totalByDate,
        rows,
      });
    } catch (err) {
      console.error('[chart-of-accounts] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/kijichi-payments?date=YYYY-MM-DD
  // Lists every Payment deposited to Kijichi on the given TxnDate with
  // customer name, amount, private_note. Filters out BRAIN-pushed ones
  // so the operator can see only the manually-entered baseline.
  app.get('/api/admin/kijichi-payments', requireSecretOrJwt, async (req, res) => {
    try {
      const date = String(req.query.date || '');
      if (!date) return res.status(400).json({ error: 'date YYYY-MM-DD required' });
      const onlyManual = req.query.only_manual !== 'false';
      // Find Kijichi account id
      const acctRes = await qbQuery(
        `SELECT Id, Name FROM Account WHERE Name = 'Kijichi Collection AC'`,
      );
      const acct = acctRes.QueryResponse?.Account?.[0];
      if (!acct) return res.status(404).json({ error: 'Kijichi account not found' });
      // Pull all Payments for the date
      const all = [];
      let start = 1;
      while (true) {
        const r = await qbQuery(
          `SELECT Id, TotalAmt, TxnDate, PrivateNote, CustomerRef, DepositToAccountRef, MetaData ` +
          `FROM Payment WHERE TxnDate = '${date}' STARTPOSITION ${start} MAXRESULTS 1000`,
        );
        const rows = r.QueryResponse?.Payment || [];
        all.push(...rows);
        if (rows.length < 1000) break;
        start += 1000;
      }
      const matched = all.filter((p) => String(p.DepositToAccountRef?.value || '') === String(acct.Id));
      // Get customer names in bulk
      const custIds = [...new Set(matched.map((p) => p.CustomerRef?.value).filter(Boolean))];
      const custMap = {};
      for (let i = 0; i < custIds.length; i += 30) {
        const chunk = custIds.slice(i, i + 30);
        const inList = chunk.map((id) => "'" + String(id).replace(/'/g, "''") + "'").join(',');
        const cr = await qbQuery(`SELECT Id, DisplayName FROM Customer WHERE Id IN (${inList})`);
        for (const c of (cr.QueryResponse?.Customer || [])) custMap[c.Id] = c.DisplayName;
      }
      // Check which Payments are BRAIN-pushed (have a matching payment_uploads with this qb_id)
      const ids = matched.map((p) => String(p.Id));
      const pu = await db().query(
        `SELECT DISTINCT qb_id FROM payment_uploads WHERE qb_id = ANY($1)`,
        [ids],
      );
      const brainIds = new Set(pu.rows.map((r) => String(r.qb_id)));
      const out = [];
      for (const p of matched) {
        const isBrain = brainIds.has(String(p.Id));
        if (onlyManual && isBrain) continue;
        out.push({
          qb_id: p.Id,
          amount: Number(p.TotalAmt || 0),
          customer: custMap[p.CustomerRef?.value] || p.CustomerRef?.value || '?',
          private_note: p.PrivateNote || '',
          create_time: p.MetaData?.CreateTime,
          is_brain_pushed: isBrain,
        });
      }
      const total = out.reduce((s, x) => s + x.amount, 0);
      res.json({ date, only_manual: onlyManual, count: out.length, total, payments: out });
    } catch (err) {
      console.error('[kijichi-payments] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/restore-voided-batch
  // Body: { batch_id, txn_date? } — txn_date optional, defaults to 2026-06-05
  // Re-creates QB Payments for each voided PU in the batch using the saved
  // customer_id + invoice_qb_id + amount + memo. No IP re-run — exact replay.
  // Used after an over-aggressive recall to restore the previous state exactly.
  app.post('/api/admin/restore-voided-batch', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.body?.batch_id || '');
      const txnDate = String(req.body?.txn_date || '2026-06-05');
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      let fullId = batchId;
      if (batchId.length < 36) {
        const r = await db().query(`SELECT id FROM payment_batches WHERE id::text LIKE $1 LIMIT 1`, [batchId + '%']);
        if (!r.rows.length) return res.status(404).json({ error: 'batch not found' });
        fullId = r.rows[0].id;
      }
      // Optional before_iso filter: only scan PUs created before this time.
      // Prevents re-processing PUs created by THIS very endpoint (which would
      // double-create Payments in QB on retry).
      const beforeIso = req.body?.before_iso ? String(req.body.before_iso) : null;
      const sqlArgs = [fullId];
      let sqlExtra = '';
      if (beforeIso) {
        sqlArgs.push(beforeIso);
        sqlExtra = `AND created_at < $${sqlArgs.length}::timestamptz`;
      }
      const r = await db().query(
        `SELECT id, kind, bank_ref, customer_id, customer_name, invoice_qb_id, invoice_no, amount, memo
           FROM payment_uploads pu
          WHERE batch_id = $1 AND status = 'voided' AND customer_id IS NOT NULL
            ${sqlExtra}
            AND NOT EXISTS (
              SELECT 1 FROM payment_uploads pu2
               WHERE pu2.batch_id = pu.batch_id
                 AND pu2.bank_ref = pu.bank_ref
                 AND pu2.invoice_qb_id IS NOT DISTINCT FROM pu.invoice_qb_id
                 AND pu2.status = 'created'
                 AND pu2.qb_id IS NOT NULL
            )
          ORDER BY id`,
        sqlArgs,
      );
      const rows = r.rows;
      let okCount = 0, failCount = 0;
      const fails = [];
      const PAR = 8;
      let cursor = 0;
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= rows.length) return;
          const row = rows[i];
          try {
            let qb;
            if (row.invoice_qb_id) {
              qb = await qbCreatePayment({
                customerId: row.customer_id,
                invoiceQbId: row.invoice_qb_id,
                amount: Number(row.amount),
                memo: row.memo || row.bank_ref,
                txnDate,
              });
            } else {
              qb = await qbCreateUnappliedPayment({
                customerId: row.customer_id,
                amount: Number(row.amount),
                memo: row.memo || row.bank_ref,
                txnDate,
              });
            }
            await db().query(
              `INSERT INTO payment_uploads (
                 batch_id, kind, bank_ref, customer_id, customer_name,
                 invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
               ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
              [fullId, row.bank_ref, row.customer_id, row.customer_name,
               row.invoice_qb_id, row.invoice_no, row.amount, row.memo,
               qb.id, JSON.stringify(qb.response)],
            );
            // Mark source PU as 'restored' so re-running the endpoint
            // (eg to retry rate-limit failures) does NOT re-process this row
            // and create a duplicate Payment in QB.
            await db().query(
              `UPDATE payment_uploads SET status='restored' WHERE id=$1`,
              [row.id],
            );
            await db().query(
              `INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ($1, $2)
               ON CONFLICT (bank_ref) DO NOTHING`,
              [row.bank_ref, fullId],
            );
            okCount++;
          } catch (err) {
            failCount++;
            if (fails.length < 10) {
              fails.push({ row_id: row.id, bank_ref: row.bank_ref, err: String(err.message || err).slice(0, 200) });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: PAR }, () => worker()));
      await db().query(`UPDATE payment_batches SET status='finalized', recalled_at=NULL WHERE id=$1`, [fullId]);
      res.json({
        batch_id: fullId,
        scanned: rows.length,
        restored_ok: okCount,
        failed: failCount,
        fails,
      });
    } catch (err) {
      console.error('[restore-voided-batch] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/mark-stuck-as-saasant
  // Body: { since_iso: "2026-06-04T13:15:00.000Z" } - required
  // Finds unused PUs (kind='payment' with invoice_no=NULL) that have qb_id=NULL
  // (= push failed/skipped silently) and updates status to 'needs_saasant' so
  // they show up in the /api/saasant-pending CSV export for manual processing.
  // This is the operator-approved policy as of 2026-06-06: anything BRAIN
  // couldn't push to QB goes to needs_saasant for SaasAnt manual upload.
  app.post('/api/admin/mark-stuck-as-saasant', requireSecretOrJwt, async (req, res) => {
    try {
      const sinceIso = String(req.body?.since_iso || '');
      if (!sinceIso) return res.status(400).json({ error: 'since_iso required' });
      const r = await db().query(
        `UPDATE payment_uploads
            SET status = 'needs_saasant',
                failure_reason = COALESCE(failure_reason, 'stuck — customer resolution failed, manual SaasAnt upload required')
          WHERE kind = 'payment'
            AND invoice_no IS NULL
            AND qb_id IS NULL
            AND status = 'created'
            AND created_at >= $1::timestamptz
          RETURNING bank_ref, customer_name, amount, batch_id`,
        [sinceIso],
      );
      const total = r.rows.reduce((s, x) => s + Number(x.amount || 0), 0);
      res.json({
        marked: r.rowCount,
        total_amount: total,
        sample: r.rows.slice(0, 15).map((x) => ({
          ref: x.bank_ref,
          amount: Number(x.amount || 0),
          customer: x.customer_name,
          batch: String(x.batch_id).slice(0, 8),
        })),
      });
    } catch (err) {
      console.error('[mark-stuck-as-saasant] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/release-recalled-batch-cts
  // DELETE every consumed_transactions row whose batch was recalled on/after
  // since_iso. Covers refs with status='needs_saasant', 'failed', or 'voided'
  // that the full-redo missed. Returns count released + sample refs.
  // Body: { since_iso: "2026-06-04T13:15:00.000Z" }
  app.post('/api/admin/release-recalled-batch-cts', requireSecretOrJwt, async (req, res) => {
    try {
      const sinceIso = String(req.body?.since_iso || '');
      if (!sinceIso) return res.status(400).json({ error: 'since_iso required' });
      const r = await db().query(
        `DELETE FROM consumed_transactions ct
          USING payment_batches pb
          WHERE ct.batch_id = pb.id
            AND pb.status = 'recalled'
            AND pb.recalled_at >= $1::timestamptz
          RETURNING ct.bank_ref, ct.batch_id`,
        [sinceIso],
      );
      const byBatch = {};
      for (const row of r.rows) {
        const bid = String(row.batch_id).slice(0, 8);
        byBatch[bid] = (byBatch[bid] || 0) + 1;
      }
      res.json({
        released: r.rowCount,
        by_batch: byBatch,
        sample: r.rows.slice(0, 10).map((x) => x.bank_ref),
      });
    } catch (err) {
      console.error('[release-recalled-batch-cts] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/peek-sheet-window
  // Body: { channel, since_iso, until_iso }
  // Returns EVERY row in the date window with full A-H columns + a running
  // total. Use to compare BRAIN's view of the sheet against operator's
  // visual selection. No CT/PU/preflight filtering — pure sheet read.
  app.post('/api/admin/peek-sheet-window', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || 'nmbnew');
      const sinceIso = String(req.body?.since_iso || '');
      const untilIso = String(req.body?.until_iso || '');
      if (!sinceIso || !untilIso) return res.status(400).json({ error: 'since_iso + until_iso required' });
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const cfg = CHANNEL_SHEETS[channel];
      const winStart = new Date(sinceIso);
      const winEnd = new Date(untilIso);
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:H200000`);
      const sheet = sheetData.values || sheetData.data || [];
      const rows = [];
      let totalAmt = 0, badDateCount = 0, dupeCount = 0;
      const seenRef = new Set();
      const dupes = [];
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (!ts) { badDateCount++; continue; }
        if (ts < winStart || ts >= winEnd) continue;
        const ref = String(sheet[i][7] || '').trim();
        const amt = sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : 0;
        const refKey = ref + (channel === 'nmbnew' ? 'N' : channel === 'bank' ? 'B' : 'P');
        if (ref && seenRef.has(refKey)) {
          dupeCount++;
          dupes.push({ sheet_row: i + 1, col_a: sheet[i][0], ref, amount: amt });
          continue;
        }
        seenRef.add(refKey);
        totalAmt += amt;
        rows.push({
          sheet_row: i + 1,
          col_a: sheet[i][0],
          date: dCell,
          amount: amt,
          plate: sheet[i][5] || '',
          customer: sheet[i][6] || '',
          ref,
        });
      }
      res.json({
        channel,
        window: { since: sinceIso, until: untilIso },
        total_rows_in_window: rows.length,
        total_amount: totalAmt,
        dupes_skipped: dupeCount,
        bad_dates_skipped: badDateCount,
        dupes: dupes.slice(0, 5),
        first_5: rows.slice(0, 5),
        last_5: rows.slice(-5),
      });
    } catch (err) {
      console.error('[peek-sheet-window] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/peek-sheet-refs
  // Body: { channel: "nmbnew", refs: ["101AGD..."] }
  // Reads the channel's sheet and returns the full row for each matching bank_ref
  // (the value in column H). Shows what BRAIN sees so we can debug "missing" refs.
  app.post('/api/admin/peek-sheet-refs', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || 'nmbnew');
      const refs = Array.isArray(req.body?.refs) ? req.body.refs.map(String) : [];
      if (!refs.length) return res.status(400).json({ error: 'refs[] required' });
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const cfg = CHANNEL_SHEETS[channel];
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:H200000`);
      const sheet = sheetData.values || sheetData.data || [];
      // Strip suffix to match against the raw sheet bank_ref (column H)
      const wanted = new Map();
      for (const r of refs) {
        const base = r.replace(/[NBP]$/, '');
        wanted.set(base, r);
      }
      const found = [];
      for (let i = 1; i < sheet.length; i++) {
        const colH = String(sheet[i][7] || '').trim();
        if (wanted.has(colH)) {
          found.push({
            sheet_row_index: i + 1,
            ref_requested: wanted.get(colH),
            row_id: sheet[i][0] || null,
            date_col_B: sheet[i][1] || null,
            channel_col_C: sheet[i][2] || null,
            narration_col_D: (sheet[i][3] || '').toString().slice(0, 80),
            amount_col_E: sheet[i][4] || null,
            plate_col_F: sheet[i][5] || null,
            customer_col_G: sheet[i][6] || null,
            bank_ref_col_H: colH,
          });
          wanted.delete(colH);
        }
      }
      const missing = [...wanted.values()];
      res.json({
        total_rows_read: sheet.length,
        last_data_row_index: sheet.length,
        found,
        not_found_in_sheet: missing,
      });
    } catch (err) {
      console.error('[peek-sheet-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/batch-breakdown?batch_id=<uuid-or-short>
  // Returns paid/unused/failed totals + lists each unused with its assigned
  // customer + amount so the operator can audit the IP algorithm's picks.
  app.get('/api/admin/batch-breakdown', requireSecretOrJwt, async (req, res) => {
    try {
      const id = String(req.query.batch_id || '');
      if (!id) return res.status(400).json({ error: 'batch_id required' });
      // Resolve short id
      let fullId = id;
      if (id.length < 36) {
        const r = await db().query(`SELECT id FROM payment_batches WHERE id::text LIKE $1 LIMIT 1`, [id + '%']);
        if (!r.rows.length) return res.status(404).json({ error: 'batch not found' });
        fullId = r.rows[0].id;
      }
      const batch = await db().query(`SELECT id, channel, status, paid_count, unused_count, sheet_total, paid_total, unused_total, created_at FROM payment_batches WHERE id=$1`, [fullId]);
      if (!batch.rows.length) return res.status(404).json({ error: 'batch not found' });
      const rows = await db().query(
        `SELECT kind, bank_ref, customer_name, customer_id, amount, status, qb_id, invoice_no
           FROM payment_uploads WHERE batch_id = $1 ORDER BY kind, customer_name`,
        [fullId],
      );
      // "Paid" = Payment applied to a specific invoice (invoice_no is set).
      // "Unused" = either CreditMemo OR UnappliedPayment (Payment without invoice).
      const paid = rows.rows.filter((r) => r.kind === 'payment' && r.invoice_no);
      const unused = rows.rows.filter((r) => r.kind === 'credit_memo' || (r.kind === 'payment' && !r.invoice_no));
      const failed = rows.rows.filter((r) => r.status === 'failed');
      const sum = (arr) => arr.reduce((s, r) => s + Number(r.amount || 0), 0);
      res.json({
        batch: batch.rows[0],
        paid: {
          count: paid.length,
          total: sum(paid),
          by_status: paid.reduce((acc, r) => { acc[r.status] = (acc[r.status] || 0) + 1; return acc; }, {}),
        },
        unused: {
          count: unused.length,
          total: sum(unused),
          rows: unused.map((r) => ({
            bank_ref: r.bank_ref,
            customer_name: r.customer_name,
            customer_id: r.customer_id,
            amount: Number(r.amount || 0),
            status: r.status,
            qb_id: r.qb_id,
          })),
        },
        failed: failed.length ? failed.map((r) => ({ bank_ref: r.bank_ref, kind: r.kind, customer_name: r.customer_name, amount: Number(r.amount || 0) })) : [],
      });
    } catch (err) {
      console.error('[batch-breakdown] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/full-redo-window
  // Nuclear option: void every BRAIN-created Payment whose payment_uploads
  // row was created on/after since_iso, then clear all related locks so a
  // fresh fire can start with a 100% clean slate.
  // Body: { since_iso: "2026-06-04T13:15:00.000Z" }  ← required
  app.post('/api/admin/full-redo-window', requireSecretOrJwt, async (req, res) => {
    try {
      const sinceIso = String(req.body?.since_iso || '');
      if (!sinceIso) return res.status(400).json({ error: 'since_iso required' });
      // 1. Find all live BRAIN Payments (status='created', qb_id set) in window
      const r = await db().query(
        `SELECT pu.id, pu.bank_ref, pu.qb_id, pu.kind, pu.amount, pu.batch_id, pb.channel
           FROM payment_uploads pu
           JOIN payment_batches pb ON pb.id = pu.batch_id
          WHERE pu.status = 'created'
            AND pu.qb_id IS NOT NULL
            AND pu.created_at >= $1::timestamptz
          ORDER BY pu.created_at`,
        [sinceIso],
      );
      const rows = r.rows;
      const total = rows.length;
      const byChannel = {};
      for (const x of rows) {
        const c = x.channel || 'unknown';
        byChannel[c] = byChannel[c] || { count: 0, sum: 0 };
        byChannel[c].count++;
        byChannel[c].sum += Number(x.amount || 0);
      }
      // 2. Void each in QB with 8x concurrency
      const PAR = 8;
      let cursor = 0;
      let okCount = 0, failCount = 0;
      const fails = [];
      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= rows.length) return;
          const row = rows[i];
          try {
            await qbVoid({ kind: row.kind === 'credit_memo' ? 'credit_memo' : 'payment', qbId: row.qb_id });
            await db().query(
              `UPDATE payment_uploads SET status='voided', voided_at=now() WHERE id=$1`,
              [row.id],
            );
            okCount++;
          } catch (err) {
            // retry once after 3s
            try {
              await new Promise((r) => setTimeout(r, 3000));
              await qbVoid({ kind: row.kind === 'credit_memo' ? 'credit_memo' : 'payment', qbId: row.qb_id });
              await db().query(
                `UPDATE payment_uploads SET status='voided', voided_at=now() WHERE id=$1`,
                [row.id],
              );
              okCount++;
            } catch (err2) {
              failCount++;
              fails.push({ qb_id: row.qb_id, bank_ref: row.bank_ref, err: String(err2.message || err2).slice(0, 100) });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: PAR }, () => worker()));

      // 3. Cleanup state for every ref touched (whether void succeeded or not —
      //    if void failed, we still need CT released so fresh fire can retry).
      const refs = rows.map((r) => r.bank_ref);
      let ctReleased = 0, extReleased = 0;
      if (refs.length) {
        const ct = await db().query(`DELETE FROM consumed_transactions WHERE bank_ref = ANY($1) RETURNING bank_ref`, [refs]);
        ctReleased = ct.rowCount;
        const ext = await db().query(`DELETE FROM external_consumed_refs WHERE bank_ref = ANY($1) RETURNING bank_ref`, [refs]);
        extReleased = ext.rowCount;
      }
      // 4. Also clear ALL external_consumed_refs added in the window (stale catches).
      const extWindow = await db().query(
        `DELETE FROM external_consumed_refs WHERE found_at >= $1::timestamptz RETURNING bank_ref`,
        [sinceIso],
      );
      // 5. Also DELETE dry_run payment_uploads from the window so they don't confuse later queries
      const dryDel = await db().query(
        `DELETE FROM payment_uploads WHERE status = 'dry_run' AND created_at >= $1::timestamptz RETURNING id`,
        [sinceIso],
      );
      // 6. Mark batches in window as recalled
      const batchIds = [...new Set(rows.map((r) => r.batch_id))];
      let batchesMarked = 0;
      if (batchIds.length) {
        const bm = await db().query(
          `UPDATE payment_batches SET status='recalled', recalled_at=now()
            WHERE id = ANY($1) AND status IN ('finalized', 'pending') RETURNING id`,
          [batchIds],
        );
        batchesMarked = bm.rowCount;
      }
      // 7. Release any auto_upload_locks
      const lockDel = await db().query(`DELETE FROM auto_upload_locks RETURNING channel`);

      res.json({
        scanned_uploads: total,
        by_channel_before: byChannel,
        voided_ok: okCount,
        voided_failed: failCount,
        fails: fails.slice(0, 10),
        consumed_transactions_released: ctReleased,
        external_consumed_refs_released_by_ref: extReleased,
        external_consumed_refs_released_by_window: extWindow.rowCount,
        dry_run_uploads_deleted: dryDel.rowCount,
        batches_marked_recalled: batchesMarked,
        auto_upload_locks_cleared: lockDel.rowCount,
      });
    } catch (err) {
      console.error('[full-redo-window] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/force-release-channel-lock
  // Body: { channel: "nmbnew" | "bank" | "iphone_bank" }
  // Operator-triggered force-release when a lock got orphaned (eg deploy
  // killed the holder mid-run). Lock has 30-min TTL anyway but this is faster.
  app.post('/api/admin/force-release-channel-lock', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!['nmbnew', 'bank', 'iphone_bank'].includes(channel)) {
        return res.status(400).json({ error: 'channel must be nmbnew | bank | iphone_bank' });
      }
      const r = await db().query(
        `DELETE FROM auto_upload_locks WHERE channel = $1 RETURNING holder, locked_at`,
        [channel],
      );
      res.json({ released: r.rowCount, channel, previous: r.rows[0] || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/release-all-orphans-today
  // Bulk version: finds ALL orphaned consumed_transactions rows from batches
  // created in last 24h (where CT row has no matching PU row), verifies QB
  // has no live Payment, and releases the lock.
  app.post('/api/admin/release-all-orphans-today', requireSecretOrJwt, async (req, res) => {
    try {
      const orphans = await db().query(
        `SELECT ct.bank_ref, ct.batch_id, pb.channel, pb.created_at
           FROM consumed_transactions ct
           JOIN payment_batches pb ON pb.id = ct.batch_id
           LEFT JOIN payment_uploads pu
             ON pu.bank_ref = ct.bank_ref AND pu.batch_id = ct.batch_id
          WHERE pb.created_at >= (CURRENT_DATE - INTERVAL '1 day')::timestamptz
            AND pu.id IS NULL
          ORDER BY pb.created_at`,
      );
      const sinceISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      let released = 0, kept = 0, errors = 0;
      const releasedRefs = [];
      const keptRefs = [];
      for (const o of orphans.rows) {
        try {
          const cust = await db().query(
            `SELECT customer_id FROM payment_uploads
              WHERE bank_ref = $1 AND customer_id IS NOT NULL
              LIMIT 1`,
            [o.bank_ref],
          );
          const custId = cust.rows[0]?.customer_id;
          let hasLive = false;
          if (custId) {
            const refBase = o.bank_ref.replace(/[NBP]$/, '');
            const q = await qbQuery(
              `SELECT Id, TotalAmt, PrivateNote FROM Payment ` +
              `WHERE CustomerRef = '${custId}' AND TxnDate >= '${sinceISO}' MAXRESULTS 200`,
            );
            const pmts = q.QueryResponse?.Payment || [];
            for (const p of pmts) {
              const pn = String(p.PrivateNote || '').trim();
              if ((pn === o.bank_ref || pn === refBase) && Number(p.TotalAmt || 0) > 0) {
                hasLive = true; break;
              }
            }
          }
          if (!hasLive) {
            await db().query(`DELETE FROM consumed_transactions WHERE bank_ref = $1 AND batch_id = $2`, [o.bank_ref, o.batch_id]);
            released++;
            if (releasedRefs.length < 20) releasedRefs.push(o.bank_ref);
          } else {
            kept++;
            if (keptRefs.length < 10) keptRefs.push(o.bank_ref);
          }
        } catch (err) {
          errors++;
        }
      }
      res.json({
        examined: orphans.rows.length,
        released, kept, errors,
        sample_released: releasedRefs,
        sample_kept: keptRefs,
      });
    } catch (err) {
      console.error('[release-all-orphans-today] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/release-orphan-consumed-refs
  // Finds consumed_transactions rows from recent batches that have NO matching
  // payment_uploads row (meaning preflight caught the ref and it never got pushed).
  // For each, double-check QB has no live Payment with that PrivateNote, then
  // DELETE the consumed_transactions lock so a fresh upload can re-push.
  //
  // Body: { batch_ids: ["8e2b183c", "c7e6c10f", ...] } — required, only release
  //       locks from these batch IDs (safer than a blanket "today" query).
  app.post('/api/admin/release-orphan-consumed-refs', requireSecretOrJwt, async (req, res) => {
    try {
      const ids = Array.isArray(req.body?.batch_ids) ? req.body.batch_ids.map(String) : [];
      if (!ids.length) return res.status(400).json({ error: 'batch_ids[] required' });
      // Resolve short IDs to UUIDs
      const fullIds = [];
      for (const short of ids) {
        if (short.length >= 36) { fullIds.push(short); continue; }
        const r = await db().query(`SELECT id FROM payment_batches WHERE id::text LIKE $1 LIMIT 1`, [short + '%']);
        if (r.rows.length) fullIds.push(r.rows[0].id);
      }
      if (!fullIds.length) return res.status(400).json({ error: 'no matching batches' });
      // Find orphans
      const orphans = await db().query(
        `SELECT ct.bank_ref, ct.batch_id, pb.channel
           FROM consumed_transactions ct
           JOIN payment_batches pb ON pb.id = ct.batch_id
           LEFT JOIN payment_uploads pu
             ON pu.bank_ref = ct.bank_ref AND pu.batch_id = ct.batch_id
          WHERE ct.batch_id = ANY($1)
            AND pu.id IS NULL`,
        [fullIds],
      );
      // For each orphan, verify no QB Payment with this PrivateNote (= bank_ref)
      // Group by channel for batched lookup
      const sinceISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      let released = 0, kept = 0, errors = 0;
      const releasedRefs = [];
      const keptRefs = [];
      // Build a customer-id lookup from prior payment_uploads (the IP-algorithm
      // already learned the customer for this ref across the day). Best-effort —
      // if we can't find the customer we still release the lock, since the ref
      // is orphaned (no PU row, no QB push happened).
      for (const o of orphans.rows) {
        try {
          // Try to find a customer id from earlier payment_uploads for the same ref
          const cust = await db().query(
            `SELECT customer_id FROM payment_uploads
              WHERE bank_ref = $1 AND customer_id IS NOT NULL
              LIMIT 1`,
            [o.bank_ref],
          );
          const custId = cust.rows[0]?.customer_id;
          let hasLive = false;
          if (custId) {
            const refBase = o.bank_ref.replace(/[NBP]$/, '');
            const q = await qbQuery(
              `SELECT Id, TotalAmt, PrivateNote FROM Payment ` +
              `WHERE CustomerRef = '${custId}' AND TxnDate >= '${sinceISO}' MAXRESULTS 200`,
            );
            const pmts = q.QueryResponse?.Payment || [];
            for (const p of pmts) {
              const pn = String(p.PrivateNote || '').trim();
              if ((pn === o.bank_ref || pn === refBase) && Number(p.TotalAmt || 0) > 0) {
                hasLive = true; break;
              }
            }
          }
          if (!hasLive) {
            await db().query(`DELETE FROM consumed_transactions WHERE bank_ref = $1 AND batch_id = $2`, [o.bank_ref, o.batch_id]);
            released++;
            releasedRefs.push(o.bank_ref);
          } else {
            kept++;
            keptRefs.push(o.bank_ref);
          }
        } catch (err) {
          errors++;
          console.warn(`[release-orphan-consumed-refs] ${o.bank_ref}: ${err.message}`);
        }
      }
      res.json({
        examined: orphans.rows.length,
        released,
        kept,
        errors,
        sample_released: releasedRefs.slice(0, 10),
        sample_kept: keptRefs.slice(0, 5),
      });
    } catch (err) {
      console.error('[release-orphan-consumed-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/cleanup-stale-external-refs
  // For each external_consumed_refs entry added in last 24h, query QB for
  // Payments matching that PrivateNote (= bank_ref) for the recorded customer.
  // If 0 live matches found, the lock is stale (Payment was deleted by recall)
  // — DELETE the row so the next auto-upload can re-push.
  app.post('/api/admin/cleanup-stale-external-refs', requireSecretOrJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT bank_ref, customer_id, qb_id, qb_kind FROM external_consumed_refs
          WHERE found_at >= (CURRENT_DATE - INTERVAL '1 day')::timestamptz`,
      );
      const rows = r.rows;
      let stale = 0, kept = 0, errors = 0;
      const staleRefs = [];
      const sinceISO = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      // Group by customer for fewer QB queries
      const byCust = new Map();
      for (const row of rows) {
        if (!byCust.has(row.customer_id)) byCust.set(row.customer_id, []);
        byCust.get(row.customer_id).push(row);
      }
      for (const [custId, list] of byCust.entries()) {
        try {
          const q = await qbQuery(
            `SELECT Id, TotalAmt, PrivateNote FROM Payment ` +
            `WHERE CustomerRef = '${custId}' AND TxnDate >= '${sinceISO}' MAXRESULTS 500`,
          );
          const pmts = q.QueryResponse?.Payment || [];
          const livePrivateNotes = new Set();
          for (const p of pmts) {
            if (Number(p.TotalAmt || 0) > 0 && p.PrivateNote) {
              livePrivateNotes.add(String(p.PrivateNote).trim());
            }
          }
          for (const row of list) {
            const refBase = row.bank_ref.replace(/[NBP]$/, '');
            const found = livePrivateNotes.has(row.bank_ref) || livePrivateNotes.has(refBase);
            if (!found) {
              await db().query(
                `DELETE FROM external_consumed_refs WHERE bank_ref = $1 AND customer_id = $2`,
                [row.bank_ref, row.customer_id],
              );
              // Also release the consumed_transactions lock — without this the
              // next auto-upload still filters the ref via step 2 (forbidden set).
              // Safe: by this point we've confirmed no live QB Payment exists.
              await db().query(
                `DELETE FROM consumed_transactions WHERE bank_ref = $1`,
                [row.bank_ref],
              );
              stale++;
              staleRefs.push(row.bank_ref);
            } else {
              kept++;
            }
          }
        } catch (err) {
          errors += list.length;
          console.warn(`[cleanup-stale-external-refs] customer ${custId} err: ${err.message}`);
        }
      }
      res.json({
        examined: rows.length,
        deleted_stale: stale,
        kept_real: kept,
        errors,
        sample_deleted: staleRefs.slice(0, 10),
      });
    } catch (err) {
      console.error('[cleanup-stale-external-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/preflight-catches-today
  // Lists external_consumed_refs added today + each ref's QB Payment provenance
  // (qb_id, total, TxnDate, CreatedBy, CreateTime). Used after a fresh upload
  // to explain the gap between sheet_sum and Kijichi-delta.
  app.get('/api/admin/preflight-catches-today', requireSecretOrJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT bank_ref, customer_id, qb_id, qb_kind, qb_txn_date, found_by, found_at
           FROM external_consumed_refs
          WHERE found_at >= (CURRENT_DATE - INTERVAL '1 day')::timestamptz
          ORDER BY found_at DESC`,
      );
      // Enrich with QB details so we can see CreatedBy.
      const out = [];
      const seen = new Set();
      for (const row of r.rows) {
        if (seen.has(row.bank_ref)) continue; // dedupe per ref
        seen.add(row.bank_ref);
        const enriched = {
          bank_ref: row.bank_ref,
          customer_id: row.customer_id,
          qb_id: row.qb_id,
          qb_kind: row.qb_kind,
          qb_txn_date: row.qb_txn_date,
          found_by: row.found_by,
          caught_at: row.found_at,
          qb_total: null,
          qb_created_by: null,
          qb_create_time: null,
        };
        if (row.qb_id && row.qb_kind) {
          try {
            const entityName = row.qb_kind === 'payment' ? 'Payment' : 'CreditMemo';
            const q = await qbQuery(`SELECT Id, TotalAmt, TxnDate, PrivateNote, MetaData FROM ${entityName} WHERE Id = '${row.qb_id}'`);
            const entity = q.QueryResponse?.[entityName]?.[0];
            if (entity) {
              enriched.qb_total = Number(entity.TotalAmt || 0);
              enriched.qb_created_by = entity.MetaData?.CreatedBy || null;
              enriched.qb_create_time = entity.MetaData?.CreateTime || null;
            }
          } catch (err) {
            enriched.qb_error = String(err.message || err).slice(0, 100);
          }
        }
        out.push(enriched);
      }
      const totalAmount = out.reduce((s, r) => s + Number(r.qb_total || 0), 0);
      res.json({
        count: out.length,
        total_amount: totalAmount,
        catches: out,
      });
    } catch (err) {
      console.error('[preflight-catches-today] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/customer-payment-history?customer_id=11789&days=90
  // Returns ALL Payments + CreditMemos for that customer in last N days,
  // showing PrivateNote / CreatedBy / TxnDate so we can see what formats
  // SaasAnt vs BRAIN vs manual entries actually used.
  app.get('/api/admin/customer-payment-history', requireSecretOrJwt, async (req, res) => {
    try {
      const customerId = String(req.query.customer_id || '');
      const days = Math.min(Number(req.query.days) || 90, 365);
      if (!customerId) return res.status(400).json({ error: 'customer_id required' });
      const sinceISO = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
      const out = { customer_id: customerId, since: sinceISO, payments: [], credit_memos: [] };
      for (const entity of ['Payment', 'CreditMemo']) {
        const r = await qbQuery(
          `SELECT Id, TotalAmt, TxnDate, PrivateNote, MetaData ` +
          `FROM ${entity} WHERE CustomerRef = '${customerId}' AND TxnDate >= '${sinceISO}' MAXRESULTS 100`,
        );
        const items = r.QueryResponse?.[entity] || [];
        const bucket = entity === 'Payment' ? out.payments : out.credit_memos;
        for (const p of items) {
          bucket.push({
            qb_id: p.Id,
            total: Number(p.TotalAmt || 0),
            txn_date: p.TxnDate,
            private_note: p.PrivateNote || '',
            created_by: p.MetaData?.CreatedBy || null,
            create_time: p.MetaData?.CreateTime || null,
            last_updated_by: p.MetaData?.LastUpdatedBy || null,
            last_updated_time: p.MetaData?.LastUpdatedTime || null,
          });
        }
      }
      out.payments.sort((a, b) => (b.create_time || '').localeCompare(a.create_time || ''));
      out.credit_memos.sort((a, b) => (b.create_time || '').localeCompare(a.create_time || ''));
      res.json(out);
    } catch (err) {
      console.error('[customer-payment-history] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/diagnose-refs
  // Body: { refs: ["101AGD126155E3DDN", ...] }
  // For each ref:
  //  - Find the customer via consumed_transactions/payment_uploads
  //  - Query QB directly for that customer's Payments matching the ref
  //  - Return: existing Payments + their MetaData.CreatedBy + PrivateNote
  //  - Also show what BRAIN's preflight would see for this ref
  // Use this to figure out WHY duplicates keep getting through preflight.
  app.post('/api/admin/diagnose-refs', requireSecretOrJwt, async (req, res) => {
    try {
      const refs = Array.isArray(req.body?.refs) ? req.body.refs.map(String) : [];
      if (!refs.length) return res.status(400).json({ error: 'refs[] required' });
      const out = [];
      for (const refRaw of refs) {
        const refBase = refRaw.replace(/[NBP]$/, '');
        // 1. Find customer_id from any payment_upload for this ref
        const pu = await db().query(
          `SELECT pu.customer_id, pu.customer_name, pu.bank_ref, pu.batch_id, pu.status, pu.qb_id,
                  pu.amount, pu.invoice_qb_id, pu.invoice_no, pu.created_at, pu.kind
             FROM payment_uploads pu
            WHERE pu.bank_ref LIKE $1
            ORDER BY pu.created_at ASC`,
          [refBase + '%'],
        );
        const brainRows = pu.rows;
        const customerId = brainRows[0]?.customer_id;
        if (!customerId) {
          out.push({ ref: refRaw, status: 'no-customer-known', brain_rows: brainRows });
          continue;
        }
        // 2. Query QB for that customer's Payments + filter locally by PrivateNote
        try {
          const dateFrom = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10);
          const r = await qbQuery(
            `SELECT Id, TotalAmt, TxnDate, PrivateNote, CustomerRef, MetaData ` +
            `FROM Payment WHERE CustomerRef = '${customerId}' AND TxnDate >= '${dateFrom}' MAXRESULTS 100`,
          );
          const allPmts = r.QueryResponse?.Payment || [];
          const matching = allPmts.filter((p) => {
            const pn = String(p.PrivateNote || '').trim();
            return pn === refRaw || pn === refBase;
          });
          out.push({
            ref: refRaw,
            customer_id: customerId,
            customer_name: brainRows[0]?.customer_name || null,
            brain_payment_uploads: brainRows.map((b) => ({
              status: b.status, batch_id: String(b.batch_id || '').slice(0, 8),
              qb_id: b.qb_id, bank_ref: b.bank_ref,
              amount: Number(b.amount || 0),
              invoice_qb_id: b.invoice_qb_id,
              invoice_no: b.invoice_no,
              kind: b.kind,
              created_at: b.created_at,
            })),
            qb_payments_matching_ref: matching.map((p) => ({
              qb_id: p.Id,
              total: Number(p.TotalAmt || 0),
              txn_date: p.TxnDate,
              private_note: p.PrivateNote,
              created_by: p.MetaData?.CreatedBy || p.MetaData?.LastUpdatedBy || null,
              create_time: p.MetaData?.CreateTime || null,
              last_updated_time: p.MetaData?.LastUpdatedTime || null,
            })),
            qb_total_payments_for_customer: allPmts.length,
            qb_match_count: matching.length,
          });
        } catch (err) {
          out.push({ ref: refRaw, customer_id: customerId, qb_query_error: String(err.message || err).slice(0, 200) });
        }
      }
      res.json({ count: out.length, diagnostics: out });
    } catch (err) {
      console.error('[diagnose-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/batch-ref-lookup
  // Body: { refs: ["101AGD...", ...] }
  // Returns status of each ref across consumed_transactions + external_consumed_refs.
  app.post('/api/admin/batch-ref-lookup', requireSecretOrJwt, async (req, res) => {
    try {
      const refs = Array.isArray(req.body?.refs) ? req.body.refs.map(String) : [];
      if (!refs.length) return res.status(400).json({ error: 'refs[] required' });
      // Build a list with each ref + every possible suffix.
      const allKeys = [];
      for (const r of refs) {
        allKeys.push(r);
        for (const sfx of ['N', 'B', 'P']) allKeys.push(r + sfx);
      }
      const ct = await db().query(
        `SELECT bank_ref FROM consumed_transactions WHERE bank_ref = ANY($1)`,
        [allKeys],
      );
      const ec = await db().query(
        `SELECT bank_ref, qb_id, qb_kind, qb_txn_date, found_at FROM external_consumed_refs WHERE bank_ref = ANY($1)`,
        [allKeys],
      );
      const ctSet = new Set(ct.rows.map((r) => r.bank_ref));
      const ecMap = new Map(ec.rows.map((r) => [r.bank_ref, r]));
      const out = refs.map((base) => {
        const candidates = [base, base + 'N', base + 'B', base + 'P'];
        const inCt = candidates.find((c) => ctSet.has(c));
        const inEc = candidates.find((c) => ecMap.has(c));
        return {
          ref: base,
          in_consumed_transactions: inCt || null,
          in_external_consumed_refs: inEc ? ecMap.get(inEc) : null,
        };
      });
      const counts = {
        total: out.length,
        in_consumed: out.filter((x) => x.in_consumed_transactions).length,
        in_external: out.filter((x) => x.in_external_consumed_refs).length,
        clean: out.filter((x) => !x.in_consumed_transactions && !x.in_external_consumed_refs).length,
      };
      // Also pull payment_uploads + batch status for each ref.
      const pu = await db().query(
        `SELECT pu.bank_ref, pu.status AS upload_status, pu.qb_id, pu.batch_id,
                pb.status AS batch_status, pb.recalled_at
           FROM payment_uploads pu
           JOIN payment_batches pb ON pb.id = pu.batch_id
          WHERE pu.bank_ref = ANY($1)`,
        [allKeys],
      );
      const puMap = new Map(pu.rows.map((r) => [r.bank_ref, r]));
      for (const x of out) {
        const cand = [x.ref, x.ref + 'N', x.ref + 'B', x.ref + 'P'];
        const hit = cand.find((c) => puMap.has(c));
        x.payment_upload = hit ? puMap.get(hit) : null;
      }
      res.json({ counts, refs: out });
    } catch (err) {
      console.error('[batch-ref-lookup] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/sheet-ts-hour?pushed_date=YYYY-MM-DD&sheet_date=YYYY-MM-DD&channel=nmbnew
  // Hour-of-day (EAT) distribution of sheet_ts for refs pushed on a given day.
  // Lets us see if any morning-portion (00-16h EAT) refs got TxnDate set as
  // if they were evening tail.
  app.get('/api/admin/sheet-ts-hour', requireSecretOrJwt, async (req, res) => {
    try {
      const pushedDate = String(req.query.pushed_date || '');
      const sheetDate  = String(req.query.sheet_date  || '');
      const channelParam = req.query.channel ? String(req.query.channel) : null;
      if (!pushedDate || !sheetDate) return res.status(400).json({ error: 'pushed_date + sheet_date required' });
      const params = [pushedDate, sheetDate];
      let chFilter = '';
      if (channelParam) { params.push(channelParam); chFilter = `AND pb.channel = $${params.length}`; }
      const r = await db().query(
        `SELECT
            EXTRACT(HOUR FROM (ct.sheet_ts AT TIME ZONE 'Africa/Dar_es_Salaam'))::int  AS eat_hour,
            COUNT(*)                          AS rows,
            COALESCE(SUM(pu.amount), 0)       AS total
          FROM payment_uploads pu
          JOIN payment_batches pb              ON pb.id = pu.batch_id
          LEFT JOIN consumed_transactions ct   ON ct.bank_ref = pu.bank_ref
         WHERE (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $1
           AND (ct.sheet_ts  AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $2
           AND pu.status = 'created'
           ${chFilter}
         GROUP BY 1
         ORDER BY 1 NULLS LAST`,
        params,
      );
      res.json({
        pushed_date: pushedDate,
        sheet_date: sheetDate,
        channel: channelParam,
        by_eat_hour: r.rows.map((row) => ({
          eat_hour: row.eat_hour,
          rows: Number(row.rows),
          total: Number(row.total),
          should_be_txndate: row.eat_hour == null ? null
            : (row.eat_hour < 16 || (row.eat_hour === 16 && false))  // <16:15
                ? sheetDate
                : new Date(new Date(sheetDate).getTime() + 24*60*60*1000).toISOString().slice(0,10),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/release-voided-refs
  // For refs that are 'voided' in payment_uploads but still locked in
  // consumed_transactions (= partial recall left them stranded), delete the
  // consumed_transactions row so the auto-upload can re-push them.
  app.post('/api/admin/release-voided-refs', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = req.body?.batch_id ? String(req.body.batch_id) : null;
      const where = batchId
        ? `WHERE pu.batch_id = $1 AND pu.status = 'voided'`
        : `WHERE pu.status = 'voided'`;
      const params = batchId ? [batchId] : [];
      const result = await db().query(
        `DELETE FROM consumed_transactions
          WHERE bank_ref IN (
            SELECT pu.bank_ref FROM payment_uploads pu ${where}
          )
          RETURNING bank_ref`,
        params,
      );
      res.json({
        ok: true,
        released_count: result.rowCount,
        batch_id_filter: batchId,
        sample: result.rows.slice(0, 10).map((r) => r.bank_ref),
      });
    } catch (err) {
      console.error('[release-voided-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/payment-uploads/asof-audit?pushed_date=YYYY-MM-DD&sheet_date=YYYY-MM-DD&channel=nmbnew
  // For payment_uploads pushed on `pushed_date` with underlying sheet date `sheet_date`,
  // return the AS_OF used (joined via batch → arrears_snapshot).
  // Answers: "for the evening-tail of June 4 pushed today, was AS_OF set to yesterday?"
  app.get('/api/payment-uploads/asof-audit', requireSecretOrJwt, async (req, res) => {
    try {
      const pushedDate = String(req.query.pushed_date || '');
      const sheetDate  = String(req.query.sheet_date  || '');
      const channelParam = req.query.channel ? String(req.query.channel) : null;
      if (!pushedDate || !sheetDate) {
        return res.status(400).json({ error: 'pushed_date + sheet_date required' });
      }
      const params = [pushedDate, sheetDate];
      let chFilter = '';
      if (channelParam) { params.push(channelParam); chFilter = `AND pb.channel = $${params.length}`; }

      const r = await db().query(
        `SELECT
            arr.as_of                                          AS as_of,
            pb.channel                                         AS channel,
            COUNT(*)                                           AS rows,
            COALESCE(SUM(pu.amount), 0)                        AS total
          FROM payment_uploads pu
          JOIN payment_batches pb              ON pb.id = pu.batch_id
          JOIN arrears_snapshots arr           ON arr.id = pb.arrears_snapshot_id
          LEFT JOIN consumed_transactions ct   ON ct.bank_ref = pu.bank_ref
         WHERE (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $1
           AND (ct.sheet_ts  AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $2
           AND pu.status = 'created'
           ${chFilter}
         GROUP BY 1, 2
         ORDER BY 1, 2`,
        params,
      );

      // Also list the actual batch ids implicated (for surgical recall).
      const batches = await db().query(
        `SELECT pb.id, arr.as_of, COUNT(*) AS rows, COALESCE(SUM(pu.amount), 0) AS total,
                pb.status, pb.finalized_at
           FROM payment_uploads pu
           JOIN payment_batches pb              ON pb.id = pu.batch_id
           JOIN arrears_snapshots arr           ON arr.id = pb.arrears_snapshot_id
           LEFT JOIN consumed_transactions ct   ON ct.bank_ref = pu.bank_ref
          WHERE (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $1
            AND (ct.sheet_ts  AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $2
            AND pu.status = 'created'
            ${chFilter}
          GROUP BY pb.id, arr.as_of, pb.status, pb.finalized_at
          ORDER BY pb.finalized_at`,
        params,
      );

      res.json({
        pushed_date: pushedDate,
        sheet_date: sheetDate,
        channel: channelParam,
        breakdown: r.rows.map((row) => ({
          as_of: row.as_of ? new Date(row.as_of).toISOString().slice(0, 10) : null,
          channel: row.channel,
          rows: Number(row.rows),
          total: Number(row.total),
          correct_asof: row.as_of ? (new Date(row.as_of).toISOString().slice(0,10) === sheetDate) : null,
        })),
        batches: batches.rows.map((b) => ({
          batch_id: b.id,
          as_of: b.as_of ? new Date(b.as_of).toISOString().slice(0, 10) : null,
          rows: Number(b.rows),
          total: Number(b.total),
          status: b.status,
          finalized_at: b.finalized_at,
          correct_asof: b.as_of ? (new Date(b.as_of).toISOString().slice(0,10) === sheetDate) : null,
        })),
      });
    } catch (err) {
      console.error('[asof-audit] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/payment-uploads/by-sheet-date?date=YYYY-MM-DD&channel=nmbnew
  // For all payment_uploads created (pushed to QB) on a given EAT day, group by
  // the underlying bank-statement's sheet date (sheet_ts EAT-day) so we can see
  // which actual transaction days got caught up that day. Answers questions like
  // "the 1,565 NMB rows we pushed on 06-04 — which sheet dates did they come from?"
  app.get('/api/payment-uploads/by-sheet-date', requireSecretOrJwt, async (req, res) => {
    try {
      const dayParam = String(req.query.date || '');
      const channelParam = req.query.channel ? String(req.query.channel) : null;
      if (!dayParam) return res.status(400).json({ error: 'date=YYYY-MM-DD required' });

      const params = [dayParam];
      let chFilter = '';
      if (channelParam) {
        params.push(channelParam);
        chFilter = `AND pb.channel = $${params.length}`;
      }

      const r = await db().query(
        `SELECT
           COALESCE(pb.channel, 'unknown')                                 AS channel,
           (ct.sheet_ts AT TIME ZONE 'Africa/Dar_es_Salaam')::date          AS sheet_date,
           COUNT(*)                                                        AS rows,
           COALESCE(SUM(pu.amount), 0)                                     AS total
         FROM payment_uploads pu
         JOIN payment_batches pb        ON pb.id = pu.batch_id
         LEFT JOIN consumed_transactions ct ON ct.bank_ref = pu.bank_ref
         WHERE (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $1
           AND pu.status = 'created'
           ${chFilter}
         GROUP BY 1, 2
         ORDER BY 1, 2 NULLS LAST`,
        params,
      );

      const out = {};
      for (const row of r.rows) {
        const ch = row.channel;
        if (!out[ch]) out[ch] = { channel: ch, by_sheet_date: [], total_rows: 0, total_amount: 0 };
        const sheetDate = row.sheet_date ? new Date(row.sheet_date).toISOString().slice(0, 10) : null;
        out[ch].by_sheet_date.push({ sheet_date: sheetDate, rows: Number(row.rows), total: Number(row.total) });
        out[ch].total_rows += Number(row.rows);
        out[ch].total_amount += Number(row.total);
      }
      res.json({ pushed_on: dayParam, channels: Object.values(out) });
    } catch (err) {
      console.error('[by-sheet-date] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/payment-uploads/today-totals', requireSecretOrJwt, async (req, res) => {
    try {
      const dayParam = req.query.date ? String(req.query.date) : null; // 'YYYY-MM-DD' in EAT
      const dayExpr = dayParam ? `DATE '${dayParam}'` : `(now() AT TIME ZONE 'Africa/Dar_es_Salaam')::date`;

      const byChannelStatus = await db().query(
        `SELECT
           COALESCE(pb.channel, 'unknown')   AS channel,
           pu.status,
           pu.kind,
           COUNT(*)                          AS rows,
           COALESCE(SUM(pu.amount), 0)       AS total
         FROM payment_uploads pu
         JOIN payment_batches pb ON pb.id = pu.batch_id
         WHERE (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = ${dayExpr}
         GROUP BY 1, 2, 3
         ORDER BY 1, 2, 3`,
      );

      // Reshape into per-channel summaries.
      const channels = {};
      for (const r of byChannelStatus.rows) {
        const ch = r.channel;
        if (!channels[ch]) {
          channels[ch] = {
            channel: ch,
            pushed_rows: 0, pushed_amount: 0,
            voided_rows: 0, voided_amount: 0,
            failed_rows: 0, failed_amount: 0,
            needs_saasant_rows: 0, needs_saasant_amount: 0,
            unmatched_rows: 0, unmatched_amount: 0,
            other_rows: 0, other_amount: 0,
            payment_amount: 0, credit_memo_amount: 0,
          };
        }
        const c = channels[ch];
        const rows = Number(r.rows), amt = Number(r.total);
        if (r.status === 'created')             { c.pushed_rows += rows; c.pushed_amount += amt; }
        else if (r.status === 'voided')         { c.voided_rows += rows; c.voided_amount += amt; }
        else if (r.status === 'failed')         { c.failed_rows += rows; c.failed_amount += amt; }
        else if (r.status === 'needs_saasant')  { c.needs_saasant_rows += rows; c.needs_saasant_amount += amt; }
        else if (r.status === 'unmatched')      { c.unmatched_rows += rows; c.unmatched_amount += amt; }
        else                                    { c.other_rows += rows; c.other_amount += amt; }
        if (r.status === 'created' && r.kind === 'payment')        c.payment_amount += amt;
        if (r.status === 'created' && r.kind === 'credit_memo')    c.credit_memo_amount += amt;
      }

      const by_channel = Object.values(channels).sort((a, b) => a.channel.localeCompare(b.channel));
      const grand = by_channel.reduce((acc, c) => ({
        pushed_rows: acc.pushed_rows + c.pushed_rows,
        pushed_amount: acc.pushed_amount + c.pushed_amount,
        voided_rows: acc.voided_rows + c.voided_rows,
        voided_amount: acc.voided_amount + c.voided_amount,
        failed_rows: acc.failed_rows + c.failed_rows,
        failed_amount: acc.failed_amount + c.failed_amount,
        needs_saasant_rows: acc.needs_saasant_rows + c.needs_saasant_rows,
        needs_saasant_amount: acc.needs_saasant_amount + c.needs_saasant_amount,
        unmatched_rows: acc.unmatched_rows + c.unmatched_rows,
        unmatched_amount: acc.unmatched_amount + c.unmatched_amount,
        payment_amount: acc.payment_amount + c.payment_amount,
        credit_memo_amount: acc.credit_memo_amount + c.credit_memo_amount,
      }), {
        pushed_rows: 0, pushed_amount: 0, voided_rows: 0, voided_amount: 0,
        failed_rows: 0, failed_amount: 0, needs_saasant_rows: 0, needs_saasant_amount: 0,
        unmatched_rows: 0, unmatched_amount: 0, payment_amount: 0, credit_memo_amount: 0,
      });

      const dayRow = await db().query(`SELECT ${dayExpr} AS day`);
      res.json({
        date: dayRow.rows[0].day,
        by_channel,
        grand_total: grand,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/consumed-transactions/:ref ──────────────────────────────────
  app.get('/api/consumed-transactions/:ref', requireSecretOrJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT bank_ref, batch_id, consumed_at FROM consumed_transactions WHERE bank_ref=$1`,
        [req.params.ref],
      );
      if (!r.rows.length) return res.status(404).json({ consumed: false });
      res.json({ consumed: true, ...r.rows[0] });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

// ─────────────────────────────────────────────────────────────────────────
// Helpers

function validateBatchBody(b) {
  if (!b.arrears_snapshot_id) return { error: 'arrears_snapshot_id required' };
  if (!b.sheet_id) return { error: 'sheet_id required' };
  if (!b.sheet_tab) return { error: 'sheet_tab required' };
  if (!b.channel) return { error: 'channel required' };
  if (!Array.isArray(b.bank_refs) || !b.bank_refs.length) return { error: 'bank_refs required (non-empty array)' };
  if (!Array.isArray(b.paid)) return { error: 'paid must be an array (can be empty)' };
  if (!Array.isArray(b.unused)) return { error: 'unused must be an array (can be empty)' };
  if (b.paid.length === 0 && b.unused.length === 0) return { error: 'at least one of paid/unused must be non-empty' };
  for (let i = 0; i < b.paid.length; i++) {
    const r = b.paid[i];
    if (!r.bank_ref || !r.customer_id || !r.invoice_qb_id || r.amount == null) {
      return { error: `paid[${i}] missing bank_ref/customer_id/invoice_qb_id/amount` };
    }
  }
  for (let i = 0; i < b.unused.length; i++) {
    const r = b.unused[i];
    if (!r.bank_ref || r.amount == null) {
      return { error: `unused[${i}] missing bank_ref/amount` };
    }
    // customer_id is OPTIONAL on unused — rows where the invoice-payment-app
    // couldn't match the bank txn to a QB customer still need to be tracked
    // in consumed_transactions (so they're not re-uploaded), but they get NO
    // QB CreditMemo (we'd have nowhere to attach it).
  }
  return { error: null };
}

async function getSheetConfig(sheetId) {
  const r = await db().query(
    `SELECT key, value FROM app_settings WHERE key IN ('sheet_allowlist','sheet_denylist')`,
  );
  const settings = Object.fromEntries(r.rows.map((x) => [x.key, x.value]));
  let denylist = [], allowlist = {};
  try { denylist = JSON.parse(settings.sheet_denylist || '[]'); } catch {}
  try { allowlist = JSON.parse(settings.sheet_allowlist || '{}'); } catch {}
  if (denylist.includes(sheetId)) return { denied: true, reason: `sheet_id ${sheetId} is on the deny list` };
  if (!(sheetId in allowlist)) return { allowed: false, denied: false };
  return { allowed: true, config: allowlist[sheetId] };
}

// Mirror of invoice-payment-app's per-channel ref suffix. The CSVs emitted by
// invoice-payment-app carry `${sheet_REFNUMBER}${suffix}` so that the bank_ref
// is globally unique across channels; the raw sheet only has the REFNUMBER.
// We strip the suffix before matching against the sheet, but keep the full
// suffixed ref in consumed_transactions / payment_uploads (canonical id).
const CHANNEL_SUFFIX = {
  lipa: 'L', boda: 'T', iphone: 'G',
  bank: 'B', iphone_bank: 'P', nmbnew: 'N',
};

async function sumSheetForRefs({ sheetId, tab, cfg, wantedRefs, channel }) {
  // Read a generous row window; sheets currently top out ~120k rows.
  const range = `${tab}!A1:Z200000`;
  const data = await readSheet(sheetId, range);
  const rows = data.values || data.data || data;
  const idCol = Number(cfg.idCol ?? 0);
  const amountCol = Number(cfg.amountCol ?? 4);
  const suffix = CHANNEL_SUFFIX[channel] || '';
  // The sheets start with a header row — assume row 0 is the header.
  // Index sheet rows by their raw REFNUMBER; lookups compare the
  // suffix-stripped wanted ref.
  const sheetIndex = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const id = String(row[idCol] ?? '').trim();
    if (!id) continue;
    const amt = Number(String(row[amountCol] ?? '0').replace(/,/g, '')) || 0;
    if (!sheetIndex.has(id)) sheetIndex.set(id, amt);
    else sheetIndex.set(id, sheetIndex.get(id) + amt);
  }
  const found = new Map();
  let total = 0;
  for (const wantedRef of wantedRefs) {
    const naked = suffix && String(wantedRef).endsWith(suffix)
      ? String(wantedRef).slice(0, -suffix.length)
      : String(wantedRef);
    if (sheetIndex.has(naked)) {
      const amt = sheetIndex.get(naked);
      found.set(wantedRef, amt);
      total += amt;
    }
  }
  const missingRefs = [...wantedRefs].filter((r) => !found.has(r));
  return { total, missingRefs, foundCount: found.size };
}

async function recordUpload({ batchId, kind, row, qbId, qbResponse, status }) {
  const r = await db().query(
    `INSERT INTO payment_uploads (
       batch_id, kind, bank_ref, customer_id, customer_name,
       invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
     ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
     RETURNING *`,
    [
      batchId, kind, row.bank_ref, row.customer_id, row.customer_name || null,
      row.invoice_qb_id || null, row.invoice_no || null,
      round2(Number(row.amount)), row.memo || null,
      qbId, qbResponse ? JSON.stringify(qbResponse) : null, status,
    ],
  );
  return r.rows[0];
}

// Parallel best-effort void with retry-on-Stale-Object + 429/500/502/503.
// Replaces the old sequential path that timed out on big batches and
// silently left Payments in QB when one of them got a Stale Object Error.
async function voidUploadsBestEffort(uploads, qbVoid) {
  const out = [];
  const CONCURRENCY = 5;
  const MAX_ATTEMPTS = 5;
  let cursor = 0;

  async function worker() {
    while (true) {
      const i = cursor++;
      if (i >= uploads.length) return;
      const u = uploads[i];
      if (!u.qb_id) {
        out.push({ upload_id: u.id, ok: false, reason: 'no qb_id (already failed)' });
        continue;
      }
      let lastErr = null;
      for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
        try {
          const v = await qbVoid({ kind: u.kind, qbId: u.qb_id });
          await db().query(
            `UPDATE payment_uploads SET status='voided', voided_at=now(), qb_void_response=$2, failure_reason=NULL WHERE id=$1`,
            [u.id, JSON.stringify(v)],
          );
          out.push({ upload_id: u.id, ok: true, qb_id: u.qb_id, attempts: attempt });
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const msg = String(err.message || err);
          // Retry-worthy: rate limit, server error, or stale syncToken.
          const isRetryable =
            /\b(429|500|502|503)\b/.test(msg) ||
            /Stale Object Error/i.test(msg) ||
            /ECONNRESET|ETIMEDOUT|UND_ERR/i.test(msg);
          if (!isRetryable || attempt === MAX_ATTEMPTS) break;
          await new Promise((r) => setTimeout(r, 750 * Math.pow(2, attempt - 1) + Math.random() * 250));
        }
      }
      if (lastErr) {
        await db().query(
          `UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`,
          [u.id, String(lastErr.message || lastErr).slice(0, 1000)],
        );
        out.push({ upload_id: u.id, ok: false, qb_id: u.qb_id, reason: lastErr.message });
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
  return out;
}

function round2(n) {
  return Math.round(Number(n) * 100) / 100;
}

// ── Auth middlewares ─────────────────────────────────────────────────────
function requireSharedSecret(req, res, next) {
  if (!STATEMENT_REPORT_SECRET) {
    return res.status(503).json({ error: 'STATEMENT_REPORT_SECRET not configured' });
  }
  const got = req.get('x-report-secret');
  if (got !== STATEMENT_REPORT_SECRET) return res.status(401).json({ error: 'bad secret' });
  next();
}

async function requireSupabaseJwt(req, res, next) {
  if (!SUPABASE_JWKS) return res.status(503).json({ error: 'SUPABASE_URL not configured' });
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try {
    const { payload } = await jwtVerify(token, SUPABASE_JWKS, {
      issuer: `${SUPABASE_URL}/auth/v1`,
    });
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid token: ' + err.message });
  }
}

function requireSecretOrJwt(req, res, next) {
  if (req.get('x-report-secret')) return requireSharedSecret(req, res, next);
  return requireSupabaseJwt(req, res, next);
}

// ─────────────────────────────────────────────────────────────────────────
// Auto-upload — invoke from /api/payment-batches/auto-upload/:channel.

const CHANNEL_SHEETS = {
  nmbnew:      { sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED' },
  bank:        { sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o', tab: 'PASSED' },
  iphone_bank: { sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED' },
};

function suffixOf(c) { return { bank: 'B', iphone_bank: 'P', nmbnew: 'N' }[c] || ''; }
function appendSuf(t, c) { if (!t) return ''; const s = suffixOf(c); return s ? t + s : t; }
function extractPhone(s) { const m = (s || '').match(/\d{10,}/); return m ? m[0] : null; }

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];

// Accept every format invoice-payment-app accepts. Returns Date or null.
// Returning null = "real garbage, can't tell when this happened" → caller
// MUST skip these (safety: we won't include them in any window).
function parseTsAny(s) {
  const str = String(s || '').trim();
  if (!str) return null;

  // Format 1: DD.MM.YYYY HH:MM:SS — today's CRDB/iPhone/NMB rows
  // CRITICAL: the sheet stores wall-clock time in EAT (UTC+3), NOT UTC.
  // Subtract 3 hours so the returned Date is in real UTC. Without this,
  // window filters like (ts < winEnd) silently miss rows at sheet-time
  // ≥ wall-clock-now-minus-3h. Real failure 2026-06-04: refs at 12:04 EAT
  // (= 09:04 UTC) were parsed as 12:04 UTC and excluded from windows ending
  // at 10:31 UTC. 91 rows / 1.6M TZS silently skipped.
  let m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const d = +m[1], mo = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return new Date(Date.UTC(+m[3], mo - 1, d, +m[4] - 3, +m[5], +m[6]));
    }
    return null;
  }

  // Format 2: DD MMM YYYY, HH:MM  (or DD MMM YYYY without time) — legacy NMB
  // Use the same "literal-as-UTC" interpretation as format 1 so windows
  // compare apples-to-apples; otherwise a "01 Jun 2026" row would land at
  // 21:00 UTC May 31 and silently miss any window starting at June 1 UTC.
  m = str.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})(?:[,\s]+(\d{1,2}):(\d{2})(?:\s*(am|pm))?)?(?:\s*\(EAT\))?$/i);
  if (m) {
    const d = m[1].padStart(2, '0');
    const monIdx = MONTH_NAMES.indexOf(m[2].toLowerCase());
    if (monIdx < 0) return null;
    const mo = String(monIdx + 1).padStart(2, '0');
    let h = m[4] ? +m[4] : 0;
    const mins = m[5] || '00';
    if (m[6] && m[6].toLowerCase() === 'pm' && h < 12) h += 12;
    if (m[6] && m[6].toLowerCase() === 'am' && h === 12) h = 0;
    return new Date(`${m[3]}-${mo}-${d}T${String(h).padStart(2,'0')}:${mins}:00Z`);
  }

  // Format 3: MM/DD/YYYY — original BODA/IPHONE/LIPA sheets
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return new Date(`${m[3]}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00Z`);
    }
  }
  return null;
}

// Verbatim invoice-payment-app algorithm. Keep in sync with run3_upload.mjs.
function processInvoicePayments(invoices, transactions) {
  const usedTx = new Set();
  const invByCust = {};
  invoices.forEach((inv) => {
    const key = inv.customerPhone || inv.customerName.toLowerCase().trim();
    (invByCust[key] ||= []).push(inv);
  });
  Object.keys(invByCust).forEach((k) => invByCust[k].sort((a, b) => {
    const dc = new Date(b.invoiceDate) - new Date(a.invoiceDate);
    return dc !== 0 ? dc : b.invoiceNumber.localeCompare(a.invoiceNumber);
  }));
  const txByCust = {};
  const seen = new Set();
  transactions.forEach((t) => {
    if (!t.amount) return;
    const uid = `${t.transactionId || t.id}_${t.receivedTimestamp}_${t.amount}`;
    if (seen.has(uid)) return;
    const keys = [t.customerPhone, t.contractName?.toLowerCase().trim(), t.customerName?.toLowerCase().trim()].filter(Boolean);
    const k = keys.find((key) => invByCust[key]);
    if (k) { (txByCust[k] ||= []).push(t); seen.add(uid); }
  });
  Object.keys(txByCust).forEach((k) => txByCust[k].sort((a, b) => (a.receivedTimestamp || 0) - (b.receivedTimestamp || 0)));
  const out = [];
  Object.keys(invByCust).forEach((ck) => {
    const ci = invByCust[ck]; const ct = txByCust[ck] || [];
    if (ct.length === 0) return;
    const ib = ci.map((inv) => ({ inv, remainingBalance: inv.amount, fullyPaid: false }));
    let idx = 0;
    ct.forEach((tx) => {
      let amt = tx.amount; let used = false; const txp = [];
      while (amt > 0 && idx < ib.length) {
        const cur = ib[idx];
        if (cur.fullyPaid) { idx++; continue; }
        const pay = Math.min(amt, cur.remainingBalance);
        const rec = {
          customerName: cur.inv.customerName, invoiceNo: cur.inv.invoiceNumber,
          amount: pay, memo: tx.transactionId, memoWithSuffix: appendSuf(tx.transactionId, tx.channel),
          channel: tx.channel, customerId: cur.inv.customerId, qbId: cur.inv.qbId,
          sheet_row_number: tx.sheet_row_number,
        };
        out.push(rec); txp.push(rec);
        cur.remainingBalance -= pay; amt -= pay; used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTx.add(tx.transactionId || tx.id);
      if (amt > 0 && txp.length > 0) txp[0].amount += amt;
    });
  });
  const unused = transactions.filter((t) => !usedTx.has(t.transactionId || t.id));
  unused.forEach((t) => out.push({
    customerName: t.customerName || t.contractName || 'UNKNOWN',
    invoiceNo: 'UNUSED', amount: t.amount, transactionAmount: t.amount,
    memo: t.transactionId, memoWithSuffix: appendSuf(t.transactionId, t.channel),
    isUnused: true, channel: t.channel,
    sheet_row_number: t.sheet_row_number,
  }));
  return out;
}

async function fetchAllArrears(asOf) {
  const { default: fetchImpl } = { default: globalThis.fetch };
  const base = process.env.SELF_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
  const arrears = [];
  let start = 1;
  const asOfParam = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';
  while (true) {
    const r = await fetchImpl(`${base}/arrears?pageSize=1000&start=${start}${asOfParam}`);
    if (!r.ok) throw new Error(`arrears ${r.status}: ${await r.text()}`);
    const j = await r.json();
    const invs = j.invoices || [];
    if (!invs.length) break;
    arrears.push(...invs);
    if (!j.page?.nextStart) break;
    start = j.page.nextStart;
  }
  return arrears;
}

async function prepareAutoUpload({ channel, sinceIso, untilIso, asOf, qbPreflightDedup }) {
  const cfg = CHANNEL_SHEETS[channel];
  const winStart = new Date(sinceIso);
  const winEnd = new Date(untilIso);

  // 1. Sheet rows FIRST (cheap) — bail early if window is empty before we
  //    burn a /arrears pull (which is multi-second on a 14k row DB).
  //
  //    Two date-shape categories matter, and they get DIFFERENT treatment:
  //      a. EMPTY date cell → operator's "skip me" flag (Frank uses this to
  //         hide multi-plate / auto-suggest rows). Always SKIP, never
  //         auto-process, never lock.
  //      b. PRESENT-but-unparseable date (e.g. "20.26.2026" OCR error) →
  //         permissive: include with receivedTimestamp=null so the next
  //         auto-upload picks them up. consumed_transactions locks them
  //         after processing so they never run twice.
  //
  //    Window filter only applies to rows with a real parseable timestamp.
  // Read columns A:K — Column K holds the "end of {tick_name}" purple
  // marker written at the end of each auto-upload fire. Operator rule
  // (2026-06-06): rows are always APPENDED at the bottom of the sheet,
  // never inserted above. So the highest row number with a Column K
  // marker is the boundary — any row at or below that row is already
  // processed; anything BELOW it is fresh and eligible.
  //
  // I/J markers still get written per-row for observability (audit can
  // spot silent failures via sheet-lock-audit), but they are NO LONGER
  // used to gate processing. K is the single source of truth.
  const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K80000`);
  const sheet = sheetData.values || sheetData.data || [];
  // Find the highest row index whose Column K holds a BRAIN end-of-tick
  // marker. Only values that start with "end of " are treated as
  // boundaries — that's BRAIN's exact write format from paintRowEndMarker
  // ("end of meru0300" / "end of heisenberg" / etc). Other stray K data
  // (legacy operator notes, accidental text) is ignored so it can't
  // wedge the entire sheet.
  let maxKRow = 0;
  for (let i = 1; i < sheet.length; i++) {
    const colK = String(sheet[i][10] || '').trim().toLowerCase();
    if (colK.startsWith('end of ')) maxKRow = i + 1; // 1-based row number
  }
  const txns = [];
  let skippedNoDate = 0, skippedOutOfWindow = 0, skippedBadFormat = 0, skippedAlreadyPushed = 0;
  for (let i = 1; i < sheet.length; i++) {
    // Belt + suspenders: skip if ANY of three signals says "already processed"
    //   (a) Row is at or below the last Column K "end of tick" marker
    //       (= prior fire's boundary; rows are appended at bottom only)
    //   (b) Column I (Fetched at) is set on this row
    //   (c) Column J (QB pushed) is set on this row
    // K is the primary fast check, I/J are per-row safety nets in case the
    // K marker got deleted (operator error or malicious). Only way to defeat
    // all three: delete I, J, AND K from the same row.
    if (maxKRow > 0 && i + 1 <= maxKRow) { skippedAlreadyPushed++; continue; }
    const colI = String(sheet[i][8] || '').trim();
    const colJ = String(sheet[i][9] || '').trim();
    if (colI || colJ) { skippedAlreadyPushed++; continue; }
    const dCell = String(sheet[i][1] || '').trim();
    if (!dCell) { skippedNoDate++; continue; }
    const ts = parseTsAny(dCell);
    if (!ts) { skippedBadFormat++; continue; }
    if (ts < winStart || ts >= winEnd) { skippedOutOfWindow++; continue; }
    txns.push({
      id: sheet[i][0] || `tx-${i + 1}`, channel,
      customerPhone: sheet[i][5] || null, customerName: sheet[i][6] || null, contractName: sheet[i][6] || null,
      amount: sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : null,
      receivedTimestamp: ts.getTime(), transactionId: sheet[i][7] || null,
      // Phase 2: track the actual Google Sheets row number (1-based) so we can
      // write Column I + J back to the right row after processing.
      sheet_row_number: i + 1,
    });
  }
  // Intra-window dedup: same ref appearing twice in the sheet (operator moves
  // rows around when reconciling). Keep first occurrence per ref+channel.
  const seenRef = new Set();
  const intraTxns = [];
  let intraDupes = 0;
  for (const t of txns) {
    const key = appendSuf(t.transactionId, channel);
    if (!key) continue;
    if (seenRef.has(key)) { intraDupes++; continue; }
    seenRef.add(key); intraTxns.push(t);
  }
  txns.length = 0; txns.push(...intraTxns);
  if (txns.length === 0) {
    return {
      skipped: true,
      reason: 'no rows in window',
      skipped_no_date: skippedNoDate,
      skipped_bad_format: skippedBadFormat,
      skipped_out_of_window: skippedOutOfWindow,
      skipped_already_pushed: skippedAlreadyPushed,
      max_k_row: maxKRow,
      sheet_total_rows: sheet.length - 1,
    };
  }

  // 2. Filter out refs already in OUR DB:
  //    a) consumed_transactions — refs from any prior BRAIN batch
  //    b) external_consumed_refs — refs we've seen in QB via a non-BRAIN
  //       path (SaasAnt etc.), surfaced by previous QB pre-flights
  const allRefs = txns.map((t) => appendSuf(t.transactionId, channel)).filter(Boolean);
  const forbidden = new Set();
  const CH = 5000;
  for (let i = 0; i < allRefs.length; i += CH) {
    const chunk = allRefs.slice(i, i + CH);
    const ec = await db().query(`SELECT bank_ref FROM consumed_transactions WHERE bank_ref = ANY($1)`, [chunk]);
    ec.rows.forEach((r) => forbidden.add(r.bank_ref));
    const ext = await db().query(`SELECT bank_ref FROM external_consumed_refs WHERE bank_ref = ANY($1)`, [chunk]);
    ext.rows.forEach((r) => forbidden.add(r.bank_ref));
  }
  const txnsClean = txns.filter((t) => !forbidden.has(appendSuf(t.transactionId, channel)));
  if (txnsClean.length === 0) return { skipped: true, reason: 'all refs already consumed' };

  // 3. Arrears + snapshot (only after we know there's work to do).
  const arrears = await fetchAllArrears(asOf);
  const invoices = arrears.map((inv, i) => ({
    id: i + 1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
    amount: Number(inv.balance) || 0, invoiceDate: inv.date,
    customerPhone: extractPhone(inv.customer || ''),
    customerId: inv.customerId, qbId: inv.qbId,
  }));
  // FIX 2026-06-05: persist the actual asOf used (not today's date).
  // Without this fix, the audit endpoint can't tell wrong-AS_OF batches from
  // right-AS_OF batches because every snapshot reads "as_of=today".
  // If caller didn't pass an asOf, derive it from the LATEST sheet_ts EAT-day
  // in this batch's window — that's the "the bank ledger date the txns are
  // actually from" rule per Frank's memory (feedback-asof-for-evening-tail.md).
  let snapshotAsOf = asOf;
  if (!snapshotAsOf) {
    // Derive: max sheet_ts of the cleaned txns, EAT-day.
    const maxTs = txnsClean.reduce((m, t) => {
      const ts = t.sheet_ts || t.sheetTs || null;
      if (!ts) return m;
      const d = new Date(ts);
      return (!m || d > m) ? d : m;
    }, null);
    if (maxTs) {
      // Convert to EAT calendar day (UTC+3, no DST).
      const eat = new Date(maxTs.getTime() + 3 * 60 * 60 * 1000);
      snapshotAsOf = eat.toISOString().slice(0, 10);
    } else {
      snapshotAsOf = new Date().toISOString().slice(0, 10);
    }
  }
  const snapInsert = await db().query(
    `INSERT INTO arrears_snapshots (as_of, data, row_count, total_balance, created_by, notes)
     VALUES ($1,$2,$3,$4,$5,$6) RETURNING id`,
    [
      snapshotAsOf, JSON.stringify(arrears), arrears.length,
      arrears.reduce((s, r) => s + (Number(r.balance) || 0), 0),
      `auto-upload-${channel}`, `auto cycle since=${sinceIso} asOf=${snapshotAsOf}`,
    ],
  );
  const snapshotId = snapInsert.rows[0].id;

  // 4. Algorithm
  const result = processInvoicePayments(invoices, txnsClean);
  let paid = result.filter((p) => !p.isUnused && p.amount > 0);
  let unused = result.filter((p) => p.isUnused);

  // 4b. STRICT QB pre-flight dedup. Operator rule 2026-06-04: we must
  // never push a (customer, ref) combo that already exists as a Payment
  // OR CreditMemo in QB — regardless of how it got there (SaasAnt, manual,
  // legacy BRAIN run before consumed_transactions existed, etc.).
  //
  // Fail-mode: if the QB query itself errors persistently, we SMS the
  // operator and proceed WITHOUT the check (better than blocking a
  // legitimate upload). Local consumed_transactions is still the
  // primary guard.
  if (qbPreflightDedup && paid.length + unused.length > 0) {
    // Collect (customerId, ref) tuples we're about to push.
    // For paid rows: each has customerId from the IP algorithm.
    // For unused rows: customerId may be absent (gets looked up later in
    // runAutoUploadBackground). For now we only check the ones we KNOW
    // the customer for — that's the IP-algorithm-matched ones.
    const tuples = [];
    for (const p of paid) {
      if (p.customerId && p.memoWithSuffix) {
        tuples.push({ customerId: String(p.customerId), ref: p.memoWithSuffix });
      }
    }
    for (const u of unused) {
      if (u.customerId && u.memoWithSuffix) {
        tuples.push({ customerId: String(u.customerId), ref: u.memoWithSuffix });
      }
    }

    if (tuples.length > 0) {
      let preflight;
      let preflightFailed = false;
      try {
        // Retry preflight up to 3 times with backoff before giving up. Each
        // attempt has a 120-second timeout (QB queries can be slow when
        // hundreds of customers are scanned).
        let lastErr = null;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            preflight = await Promise.race([
              qbPreflightDedup({ tuples }),
              new Promise((_, rej) => setTimeout(() => rej(new Error('preflight timeout 120s')), 120_000)),
            ]);
            lastErr = null;
            break;
          } catch (err) {
            lastErr = err;
            console.warn(`[auto-upload] QB pre-flight attempt ${attempt}/3 failed: ${err.message}`);
            if (attempt < 3) await new Promise((r) => setTimeout(r, 3000 * attempt));
          }
        }
        if (lastErr) throw lastErr;
      } catch (err) {
        // FAIL CLOSED 2026-06-05: previously fail-open silently — that allowed
        // the 7.74M inflation incident. Now we ABORT the entire upload with
        // an alert. Better to skip a tick than push duplicates.
        preflightFailed = true;
        console.error('[auto-upload] QB pre-flight dedup FAILED after 3 attempts — ABORTING upload:', err.message);
        try {
          await db().query(
            `INSERT INTO notifications (message, severity, source) VALUES ($1, 'critical', 'auto-upload')`,
            [`BRAIN ABORTED upload for channel=${channel}: QB pre-flight check failed 3× (${String(err.message || err).slice(0, 150)}). ${paid.length} paid + ${unused.length} unused NOT pushed. Retry the upload window manually after QB recovers.`],
          );
        } catch { /* notify enqueue must not crash the pipeline */ }
        // Delete the batch + consumed_transactions so refs stay eligible for retry.
        try {
          await db().query(`DELETE FROM consumed_transactions WHERE batch_id = $1`, [batchId]);
          await db().query(`DELETE FROM payment_batches WHERE id = $1`, [batchId]);
        } catch (e) { console.error('[auto-upload] cleanup after preflight-fail:', e.message); }
        return {
          aborted: true,
          reason: 'qb-preflight-failed',
          detail: String(err.message || err).slice(0, 200),
          paid_planned: paid.length,
          unused_planned: unused.length,
        };
      }
      if (preflightFailed) return { aborted: true };

      if (preflight.duplicateKeys.size > 0) {
        // Persist what we found so a future batch's step 2 catches them fast.
        for (const d of preflight.detail) {
          await db().query(
            `INSERT INTO external_consumed_refs (bank_ref, customer_id, qb_id, qb_kind, qb_txn_date, found_by)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (bank_ref, customer_id) DO NOTHING`,
            [d.ref, d.customerId, d.qb_id, d.qb_kind, d.qb_txn_date || null, `auto-upload-${channel}`],
          );
        }

        // Filter paid + unused to drop the duplicates.
        const keep = (r) => {
          if (!r.customerId || !r.memoWithSuffix) return true;
          return !preflight.duplicateKeys.has(String(r.customerId) + '|' + r.memoWithSuffix);
        };
        const droppedPaid = paid.length;
        const droppedUnused = unused.length;
        paid = paid.filter(keep);
        unused = unused.filter(keep);
        console.log(
          `[auto-upload] QB pre-flight: dropped ${droppedPaid - paid.length} paid + ` +
          `${droppedUnused - unused.length} unused (already in QB). ` +
          `${preflight.detail.length} (customer, ref) combos surfaced; logged to external_consumed_refs.`,
        );

        if (preflight.detail.length > 0) {
          try {
            await db().query(
              `INSERT INTO notifications (message, severity, source) VALUES ($1, 'info', 'auto-upload')`,
              [`QB pre-flight on channel=${channel} caught ${preflight.detail.length} (customer, ref) combos already in QB — skipped from push, locked in external_consumed_refs.`],
            );
          } catch { /* nbd */ }
        }
      }
    }
  }

  const sumPaid = paid.reduce((s, p) => s + p.amount, 0);
  const sumUnused = unused.reduce((s, p) => s + (p.transactionAmount || 0), 0);
  const sheetSum = txnsClean.reduce((s, t) => s + (t.amount || 0), 0);

  // 5. Batch row + lock refs
  const bankRefs = [...new Set(txnsClean.map((t) => appendSuf(t.transactionId, channel)).filter(Boolean))];
  const idem = `auto-${channel}-${Date.now()}-` + Math.random().toString(36).slice(2, 8);
  const client = await db().connect();
  let batchId;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO payment_batches (
         idempotency_key, status, arrears_snapshot_id,
         sheet_id, sheet_tab, channel, bank_refs,
         sheet_total, paid_total, unused_total,
         paid_count, unused_count, created_by
       ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [idem, snapshotId, cfg.sheetId, cfg.tab, channel, bankRefs,
       round2(sheetSum), round2(sumPaid), round2(sumUnused),
       paid.length, unused.length, `auto-upload`],
    );
    batchId = ins.rows[0].id;
    // Build ref → sheet-time map so we can populate consumed_transactions.sheet_ts
    // (operator-mandated 2026-06-04: "from_last" must mean "from latest consumed
    // ref's sheet-time", not "from last batch's clock time").
    const refToSheetTs = new Map();
    for (const t of txnsClean) {
      const suf = appendSuf(t.transactionId, channel);
      if (suf && t.receivedTimestamp) refToSheetTs.set(suf, new Date(t.receivedTimestamp).toISOString());
    }
    const tuples = bankRefs.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(',');
    const vals = []; bankRefs.forEach((r) => { vals.push(r, batchId, refToSheetTs.get(r) || null); });
    await client.query(`INSERT INTO consumed_transactions (bank_ref, batch_id, sheet_ts) VALUES ${tuples}`, vals);
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();

  return { skipped: false, batchId, paid, unused, sheetSum, cfg };
}

async function runAutoUploadBackground({ batchId, paid, unused, txnDate,
  qbCreatePayment, qbBatchCreatePayments,
  qbCreateUnappliedPayment, qbBatchCreateUnappliedPayments,
  qbBatchLookupCustomers,
  qbCreateCreditMemo,  // kept only for fallback in sweep retry
  cfg,  // { sheetId, tab } — used to write Column I + J markers
  tickName,  // 'meru0300' / 'kili1615' / 'heisenberg' (manual button) etc.
}) {
  // ─── Per-payment J-marker state (cumulative across chunks) ────────────
  // rowToQbIds maps sheet_row_number -> [qb_id, qb_id, ...] for that row.
  // Multi-invoice splits accumulate IDs as their Payments land. Each chunk
  // worker, after processing its slice, flushes the FULL cumulative list
  // for each affected row. This is crash-safe at chunk granularity and
  // converges to the right value regardless of worker interleaving.
  const rowToQbIds = new Map();
  const refToRow = new Map();
  for (const p of paid) {
    if (p.memoWithSuffix && p.sheet_row_number) refToRow.set(p.memoWithSuffix, p.sheet_row_number);
  }
  for (const u of unused) {
    if (u.memoWithSuffix && u.sheet_row_number) refToRow.set(u.memoWithSuffix, u.sheet_row_number);
  }
  async function flushJForRows(affectedRows) {
    if (!cfg || !cfg.sheetId || !cfg.tab || affectedRows.size === 0) return;
    const updates = [];
    const ts = new Date().toISOString();
    for (const row of affectedRows) {
      const ids = rowToQbIds.get(row) || [];
      if (ids.length === 0) continue;
      updates.push({
        range: `${cfg.tab}!J${row}`,
        value: `${ids.join(',')} | ${ts}`,
      });
    }
    if (updates.length === 0) return;
    try {
      await writeSheetCells(cfg.sheetId, updates);
    } catch (err) {
      console.error('[auto-upload] Column J chunk-flush failed (non-fatal):', err.message);
    }
  }
  function recordJ(sheet_row_number, qb_id) {
    if (!sheet_row_number || !qb_id) return;
    if (!rowToQbIds.has(sheet_row_number)) rowToQbIds.set(sheet_row_number, []);
    rowToQbIds.get(sheet_row_number).push(String(qb_id));
  }

  // ─── Phase 4: write Column I "Fetched at" markers BEFORE QB pushes ─────
  // Race-condition protection: if a second auto-upload fires while this one
  // is mid-flight (e.g. operator double-clicks, or two crons overlap), the
  // second run reads Column I on each row and skips it. Without this, both
  // runs would push the same Payments to QB.
  try {
    if (cfg && cfg.sheetId && cfg.tab) {
      const fetchedAt = new Date().toISOString();
      const fetchRows = new Set();
      for (const p of paid) { if (p.sheet_row_number) fetchRows.add(p.sheet_row_number); }
      for (const u of unused) { if (u.sheet_row_number) fetchRows.add(u.sheet_row_number); }
      if (fetchRows.size > 0) {
        const updates = [];
        for (const row of fetchRows) {
          updates.push({
            range: `${cfg.tab}!I${row}`,
            value: `Fetched at: ${fetchedAt}`,
          });
        }
        const r = await writeSheetCells(cfg.sheetId, updates);
        console.log(`[auto-upload] Column I markers written: ${r.updatedCells} cells across ${updates.length} rows in ${cfg.tab}`);
      }
    } else {
      console.log('[auto-upload] no cfg.sheetId/tab passed — skipping Column I pre-write');
    }
  } catch (err) {
    console.error('[auto-upload] Column I pre-write failed (non-fatal, continuing):', err.message);
  }

  // Use QB Batch API: each batch packs up to 30 ops and counts as 1
  // throttle hit, so we can run several batches concurrently for ~100/s
  // effective throughput vs ~5/s with per-record posts. Falls back to
  // per-record if qbBatchCreatePayments is not wired.
  const BATCH_SIZE = 30;
  const PARALLEL_BATCHES = 6;
  let failed = 0;

  if (qbBatchCreatePayments && paid.length > 0) {
    const chunks = [];
    for (let i = 0; i < paid.length; i += BATCH_SIZE) chunks.push(paid.slice(i, i + BATCH_SIZE));
    let chunkCursor = 0;
    const worker = async () => {
      while (true) {
        const ci = chunkCursor++;
        if (ci >= chunks.length) return;
        const chunk = chunks[ci];
        const items = chunk.map((p) => ({
          customerId: p.customerId, invoiceQbId: p.qbId,
          amount: Number(p.amount), memo: p.memoWithSuffix || '',
          txnDate,
        }));
        let results;
        try {
          results = await qbBatchCreatePayments(items);
        } catch (err) {
          // whole batch hard-failed (after retries) — mark all as failed
          results = items.map(() => ({ ok: false, id: null, response: null, error: String(err.message || err).slice(0, 500) }));
        }
        const affectedRows = new Set();
        for (let i = 0; i < chunk.length; i++) {
          const p = chunk[i]; const r = results[i];
          if (r.ok) {
            await db().query(
              `INSERT INTO payment_uploads (
                 batch_id, kind, bank_ref, customer_id, customer_name,
                 invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
               ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
              [batchId, p.memoWithSuffix, p.customerId, p.customerName,
               p.qbId, p.invoiceNo, round2(p.amount), p.memoWithSuffix,
               r.id, JSON.stringify(r.response)],
            );
            recordJ(p.sheet_row_number, r.id);
            if (p.sheet_row_number) affectedRows.add(p.sheet_row_number);
          } else {
            failed++;
            await db().query(
              `INSERT INTO payment_uploads (
                 batch_id, kind, bank_ref, customer_id, customer_name,
                 invoice_qb_id, invoice_no, amount, memo, status, failure_reason
               ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'failed',$9)`,
              [batchId, p.memoWithSuffix, p.customerId, p.customerName,
               p.qbId, p.invoiceNo, round2(p.amount), p.memoWithSuffix,
               String(r.error || 'unknown').slice(0, 500)],
            );
          }
        }
        // Per-chunk J flush — only rows whose Payment actually landed in QB
        // get marked. Failed rows leave J empty so the audit can spot them.
        await flushJForRows(affectedRows);
      }
    };
    await Promise.all(Array.from({ length: PARALLEL_BATCHES }, () => worker()));
  } else {
    // Per-record fallback for when batch API isn't available (e.g. older
    // deps, or unit tests). Concurrency 2 — same as the original safe path.
    let cursor = 0;
    const worker = async () => {
      while (true) {
        const i = cursor++;
        if (i >= paid.length) return;
        const p = paid[i];
        try {
          const qb = await qbCreatePayment({
            customerId: p.customerId, invoiceQbId: p.qbId,
            amount: Number(p.amount), memo: p.memoWithSuffix || '',
            txnDate,
          });
          await db().query(
            `INSERT INTO payment_uploads (
               batch_id, kind, bank_ref, customer_id, customer_name,
               invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
             ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
            [batchId, p.memoWithSuffix, p.customerId, p.customerName,
             p.qbId, p.invoiceNo, round2(p.amount), p.memoWithSuffix,
             qb.id, JSON.stringify(qb.response)],
          );
          recordJ(p.sheet_row_number, qb.id);
          if (p.sheet_row_number) await flushJForRows(new Set([p.sheet_row_number]));
        } catch (err) {
          failed++;
          await db().query(
            `INSERT INTO payment_uploads (
               batch_id, kind, bank_ref, customer_id, customer_name,
               invoice_qb_id, invoice_no, amount, memo, status, failure_reason
             ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'failed',$9)`,
            [batchId, p.memoWithSuffix, p.customerId, p.customerName,
             p.qbId, p.invoiceNo, round2(p.amount), p.memoWithSuffix,
             String(err.message || err).slice(0, 500)],
          );
        }
      }
    };
    await Promise.all(Array.from({ length: 2 }, () => worker()));
  }

  // ─── Unused — three-way split (operator rule from 2026-06-04) ──────────
  // (1) Look up QB customer by DisplayName for any unused row missing customerId.
  // (2) Has customerId → push as Payment-without-LinkedTxn (= unapplied credit).
  // (3) No customerId after lookup → status='needs_saasant', no QB write.
  // No more CreditMemos in this code path.
  if (unused.length > 0) {
    const lookupNames = [...new Set(
      unused.filter((u) => !u.customerId).map((u) => u.customerName).filter(Boolean),
    )];
    let nameToCustomerId = {};
    if (lookupNames.length && qbBatchLookupCustomers) {
      try { nameToCustomerId = await qbBatchLookupCustomers(lookupNames); }
      catch (err) { console.error('[auto-upload] customer-lookup failed:', err.message); }
    }
    const matchedUnused = [];
    const unmatchedUnused = [];
    for (const u of unused) {
      if (!u.customerId) u.customerId = nameToCustomerId[u.customerName];
      if (u.customerId) matchedUnused.push(u);
      else unmatchedUnused.push(u);
    }
    console.log(`[auto-upload] unused split: matched-to-QB=${matchedUnused.length}, no-match=${unmatchedUnused.length}`);

    // Matched → batch push as Payment-no-LinkedTxn (unapplied credit)
    if (matchedUnused.length > 0 && qbBatchCreateUnappliedPayments) {
      const UCHUNK = 30;
      const UPAR = 6;
      const ucks = [];
      for (let i = 0; i < matchedUnused.length; i += UCHUNK) ucks.push(matchedUnused.slice(i, i + UCHUNK));
      let ucursor = 0;
      const uworker = async () => {
        while (true) {
          const ci = ucursor++;
          if (ci >= ucks.length) return;
          const chunk = ucks[ci];
          const items = chunk.map((u) => ({
            customerId: u.customerId,
            amount: Number(u.transactionAmount),
            memo: u.memoWithSuffix || '',
            txnDate,
          }));
          let results;
          try { results = await qbBatchCreateUnappliedPayments(items); }
          catch (err) {
            results = items.map(() => ({ ok: false, id: null, response: null, error: String(err.message || err).slice(0, 500) }));
          }
          const affectedRowsU = new Set();
          for (let i = 0; i < chunk.length; i++) {
            const u = chunk[i]; const r = results[i];
            if (r.ok) {
              await db().query(
                `INSERT INTO payment_uploads (
                   batch_id, kind, bank_ref, customer_id, customer_name,
                   amount, memo, qb_id, qb_response, status
                 ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'created')`,
                [batchId, u.memoWithSuffix, u.customerId, u.customerName,
                 round2(u.transactionAmount), u.memoWithSuffix, r.id, JSON.stringify(r.response)],
              );
              recordJ(u.sheet_row_number, r.id);
              if (u.sheet_row_number) affectedRowsU.add(u.sheet_row_number);
            } else {
              failed++;
              await db().query(
                `INSERT INTO payment_uploads (
                   batch_id, kind, bank_ref, customer_id, customer_name,
                   amount, memo, status, failure_reason
                 ) VALUES ($1,'payment',$2,$3,$4,$5,$6,'failed',$7)`,
                [batchId, u.memoWithSuffix, u.customerId, u.customerName,
                 round2(u.transactionAmount), u.memoWithSuffix,
                 String(r.error || 'unknown').slice(0, 500)],
              );
            }
          }
          await flushJForRows(affectedRowsU);
        }
      };
      await Promise.all(Array.from({ length: UPAR }, () => uworker()));
    }

    // Unmatched → queue for SaasAnt (no QB write, status='needs_saasant')
    for (const u of unmatchedUnused) {
      await db().query(
        `INSERT INTO payment_uploads (
           batch_id, kind, bank_ref, customer_id, customer_name,
           amount, memo, status, failure_reason
         ) VALUES ($1,'payment',$2,NULL,$3,$4,$5,'needs_saasant',$6)`,
        [batchId, u.memoWithSuffix, u.customerName, round2(u.transactionAmount), u.memoWithSuffix,
         'customer DisplayName not found in QB; manual SaasAnt push required'],
      );
    }
  }

  // ─── Self-healing sweep: hammer any 'failed' rows up to 3 more times
  // before giving up. Catches Stale Object Errors that slipped past the
  // per-call retry budget (e.g. operator was editing the same invoice in
  // QB UI), plus any other transient blips. Only finalize when failed=0.
  for (let sweep = 1; sweep <= 3 && failed > 0; sweep++) {
    const { rows: stillFailed } = await db().query(
      `SELECT id, kind, customer_id, invoice_qb_id, invoice_no, amount, memo,
              bank_ref, customer_name
         FROM payment_uploads
        WHERE batch_id=$1 AND status='failed'
        ORDER BY id`,
      [batchId],
    );
    if (stillFailed.length === 0) { failed = 0; break; }
    console.log(`[auto-upload] sweep ${sweep}/3: retrying ${stillFailed.length} failed rows`);
    let sweepCursor = 0;
    const sweeper = async () => {
      while (true) {
        const idx = sweepCursor++;
        if (idx >= stillFailed.length) return;
        const u = stillFailed[idx];
        try {
          let qb;
          if (u.kind === 'payment' && u.invoice_qb_id) {
            // Paid → Payment with LinkedTxn
            qb = await qbCreatePayment({
              customerId: u.customer_id, invoiceQbId: u.invoice_qb_id,
              amount: Number(u.amount), memo: u.memo || '',
              txnDate,
            });
          } else if (u.kind === 'payment' && !u.invoice_qb_id && qbCreateUnappliedPayment) {
            // Unapplied (no invoice match) → Payment without LinkedTxn
            qb = await qbCreateUnappliedPayment({
              customerId: u.customer_id, amount: Number(u.amount), memo: u.memo || '',
              txnDate,
            });
          } else {
            // Legacy kind='credit_memo' from the single-row manual endpoint
            qb = await qbCreateCreditMemo({
              customerId: u.customer_id, amount: Number(u.amount), memo: u.memo || '',
              txnDate,
            });
          }
          await db().query(
            `UPDATE payment_uploads
                SET status='created', qb_id=$2, qb_response=$3, failure_reason=NULL
              WHERE id=$1`,
            [u.id, qb.id, JSON.stringify(qb.response)],
          );
          failed--;
          // Sweep-recovered PU: map bank_ref → sheet_row_number and mark J.
          const sheetRow = refToRow.get(u.bank_ref);
          if (sheetRow) {
            recordJ(sheetRow, qb.id);
            await flushJForRows(new Set([sheetRow]));
          }
        } catch (err) {
          await db().query(
            `UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`,
            [u.id, String(err.message || err).slice(0, 500)],
          );
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, () => sweeper()));
    // Small pause between sweeps so any in-flight operator edits commit.
    if (failed > 0 && sweep < 3) await new Promise((r) => setTimeout(r, 1500));
  }

  if (failed === 0) {
    await db().query(`UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`, [batchId]);
    console.log(`[auto-upload] batch ${batchId} finalized.`);
  } else {
    await db().query(
      `UPDATE payment_batches SET failure_reason=$2 WHERE id=$1`,
      [batchId, `${failed} per-row failures after 3 sweeps — see payment_uploads.failure_reason`],
    );
    console.log(`[auto-upload] batch ${batchId} left pending with ${failed} failures after 3 sweeps.`);
  }

  // J markers are flushed per-chunk (and per sweep success) above. No
  // end-of-run flush — operator rule: J reflects PER-PAYMENT QB success,
  // not batch completion. Rows with I set + J empty after this point are
  // genuine failures and surface in the sheet-lock audit endpoint.

  // ─── Column K + purple row marker for tick fire boundary ──────────────
  // Operator rule: paint the LAST processed sheet row purple (A through
  // K) and write "end of {tick_name}" into Column K. Lets the operator see
  // visually on the sheet where each tick stopped. Applies to scheduler
  // ticks (kili1615, mawenzi1800, etc.) and manual button fires ('heisenberg').
  try {
    if (cfg && cfg.sheetId && cfg.tab && tickName) {
      const allRows = [];
      for (const p of paid) { if (p.sheet_row_number) allRows.push(p.sheet_row_number); }
      for (const u of unused) { if (u.sheet_row_number) allRows.push(u.sheet_row_number); }
      if (allRows.length > 0) {
        const lastRow = Math.max(...allRows);
        await paintRowEndMarker(cfg.sheetId, cfg.tab, lastRow, tickName);
        console.log(`[auto-upload] painted row ${lastRow} purple + K='end of ${tickName}' on ${cfg.tab}`);
      } else {
        console.log(`[auto-upload] no rows processed — skipping end-of-tick marker`);
      }
    }
  } catch (err) {
    console.error('[auto-upload] paint end-of-tick marker failed (non-fatal):', err.message);
  }
}
