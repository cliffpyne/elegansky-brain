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
import { readSheet } from './sheets.js';
import { qbQuery } from './qb-client.js';

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
  app.post('/api/payment-batches/auto-upload/:channel', requireSharedSecret, async (req, res) => {
    const channel = req.params.channel;
    if (!['nmbnew', 'bank', 'iphone_bank'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be nmbnew, bank, or iphone_bank' });
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
      const result = await prepareAutoUpload({ channel, sinceIso, untilIso, asOf, qbPreflightDedup });
      if (result.skipped) {
        await releaseLock();
        return res.json({ skipped: true, reason: result.reason, since_iso: sinceIso, until_iso: untilIso });
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
      // Retry failed voids up to 3 times with backoff. The single-pass
      // voidUploadsBestEffort lets transient QB errors silently strand
      // Payments — root cause of the 2026-06-05 inflation incident.
      let voids = await voidUploadsBestEffort(ups.rows, qbVoid);
      for (let attempt = 2; attempt <= 3; attempt++) {
        const stillFailed = voids.filter((v) => !v.ok);
        if (!stillFailed.length) break;
        console.log(`[recall ${batchId}] retry attempt ${attempt}: ${stillFailed.length} voids still failing`);
        await new Promise((r) => setTimeout(r, 2000 * attempt)); // 4s, 6s
        // voidUploadsBestEffort expects payment_upload rows — rebuild them.
        const failedUploadIds = new Set(stillFailed.map((v) => v.upload_id));
        const failedUploads = ups.rows.filter((u) => failedUploadIds.has(u.id));
        const retryResults = await voidUploadsBestEffort(failedUploads, qbVoid);
        // Merge: keep the successes, overlay the new attempt
        const retryById = new Map(retryResults.map((r) => [r.upload_id, r]));
        voids = voids.map((v) => v.ok ? v : (retryById.get(v.upload_id) || v));
      }
      const allOk = voids.every((v) => v.ok);

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
              const matching = pmts.filter((p) =>
                String(p.CustomerRef?.value || '') === cid &&
                String(p.PrivateNote || '').trim() === String(br.bank_ref).replace(/[NBP]$/, ''),
              );
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
  const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:H80000`);
  const sheet = sheetData.values || sheetData.data || [];
  const txns = [];
  let skippedNoDate = 0, skippedOutOfWindow = 0, skippedBadFormat = 0;
  for (let i = 1; i < sheet.length; i++) {
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
      try {
        // Hard 60-second timeout so a slow/stuck QB query never blocks
        // the whole pipeline. If the timeout fires we fall through to
        // the catch block which proceeds without dedup + alerts.
        preflight = await Promise.race([
          qbPreflightDedup({ tuples }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('preflight timeout 60s')), 60_000)),
        ]);
      } catch (err) {
        // Fail open — proceed without check, alert operator.
        console.error('[auto-upload] QB pre-flight dedup FAILED — proceeding without check:', err.message);
        try {
          await db().query(
            `INSERT INTO notifications (message, severity, source) VALUES ($1, 'warning', 'auto-upload')`,
            [`QB pre-flight check failed for channel=${channel}. Pushed ${paid.length} paid + ${unused.length} unused WITHOUT cross-checking QB. Manual verification recommended. Error: ${String(err.message || err).slice(0, 200)}`],
          );
        } catch { /* notify enqueue must not crash the pipeline */ }
        preflight = { duplicateKeys: new Set(), detail: [] };
      }

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

  return { skipped: false, batchId, paid, unused, sheetSum };
}

async function runAutoUploadBackground({ batchId, paid, unused, txnDate,
  qbCreatePayment, qbBatchCreatePayments,
  qbCreateUnappliedPayment, qbBatchCreateUnappliedPayments,
  qbBatchLookupCustomers,
  qbCreateCreditMemo,  // kept only for fallback in sweep retry
}) {
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
}
