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
import { readSheet, writeSheetCells, paintRowEndMarker, protectMarkerColumns, clearSheetColumn, clearMarkerRowRange, eraseDryRunMarkers, markSheetRowsAsQbDuplicate, deleteSheetRowsAndClearMarkers } from './sheets.js';
import { qbQuery, qbReport, qbPatchPaymentTxnDate } from './qb-client.js';
import { processInvoicePaymentsWithForwardPay } from './payment-algorithm-v2.js';

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

  // Stale-lock reaper (Frank 2026-07-04 kibo1900 incident): the ON CONFLICT
  // stale-reclaim in the acquire path only fires when a NEW caller tries to
  // acquire. If nothing tries for hours, orphan locks sit in the table and
  // the boss sees "17-min stuck lock" in monitoring while everything is
  // actually idle. Runs every 60s + once at boot: drops any lock with
  // locked_at > 5 min ago. Safe because live workers refresh heartbeat
  // every 15s — anything past 5 min IS dead.
  const reapStaleLocks = async () => {
    try {
      const r = await db().query(
        `DELETE FROM auto_upload_locks
          WHERE locked_at < now() - interval '5 minutes'
          RETURNING channel, holder, locked_at`,
      );
      if (r.rows.length) {
        for (const row of r.rows) {
          const ageMin = Math.round((Date.now() - new Date(row.locked_at).getTime()) / 60_000);
          console.warn(`[stale-lock-reaper] cleared ${row.channel} held by ${row.holder} (${ageMin} min stale)`);
        }
      }
    } catch (err) {
      console.error('[stale-lock-reaper] threw:', err.message);
    }
  };
  setTimeout(reapStaleLocks, 10_000);
  setInterval(reapStaleLocks, 60_000);


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
    if (!['nmbnew', 'bank', 'iphone_bank', 'nmbnew_sav', 'bank_sav'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be nmbnew, bank, iphone_bank, nmbnew_sav, or bank_sav' });
    }
    // Hard requirement (2026-06-07): every fire MUST carry an explicit
    // txn_date. No wall-clock fallback — silent defaults previously let
    // wrong-date Payments land in QB when a caller forgot to supply it.
    // Both callers (cron scheduler and heisenberg ad-hoc UI) construct
    // txn_date deliberately per tick identity or operator pick; if either
    // sends without it, that's a caller bug we want LOUD.
    const txnDateFromBody = req.body?.txn_date;
    if (!txnDateFromBody || !/^\d{4}-\d{2}-\d{2}$/.test(String(txnDateFromBody))) {
      return res.status(400).json({
        error: 'txn_date required (YYYY-MM-DD) — wall-clock fallback removed',
        got: txnDateFromBody ?? null,
      });
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
    // Stale-reclaim window: 5 min. Was 30 min, but Render dyno restarts can
    // leave a zombie lock for that long with no batch ever created, blocking
    // operator and agent uploads. 2026-06-11 incident: NMB blocked 18 min by
    // a zombie from a CDC-poller-fix restart.
    const lockResult = await db().query(
      `INSERT INTO auto_upload_locks (channel, locked_at, holder)
       VALUES ($1, now(), $2)
       ON CONFLICT (channel) DO UPDATE
         SET locked_at = now(), holder = EXCLUDED.holder
         WHERE auto_upload_locks.locked_at < now() - interval '90 seconds'
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
      // tickName for created_by attribution — heisenberg / meru0300 / etc.
      // Defaults to 'heisenberg' for ad-hoc fires that omit tick_name.
      const tickName = String(req.body?.tick_name || 'heisenberg').toLowerCase();
      const result = await prepareAutoUpload({
        channel, sinceIso, untilIso, asOf, tickName,
        txnDate: txnDateOverride,
        qbPreflightDedup: dryRun ? null : qbPreflightDedup,
        forceSkipMaxKRow: req.body?.force_skip_max_k_row === true,
        dryRun,
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

        // Dry-run sheet markers (Frank 2026-06-07): write I/J/K with a
        // " (DRY_RUN)" suffix so the operator can SEE the plan in the
        // sheet before committing. The next REAL upload's skip checks
        // ignore "(DRY_RUN)" markers so they don't accidentally lock
        // rows. An Erase button (eraseDryRunMarkers) wipes them.
        try {
          const tickName = String(req.body?.tick_name || 'heisenberg');
          if (result.cfg && result.cfg.sheetId && result.cfg.tab) {
            const fetchedAt = new Date().toISOString();
            const fetchRows = new Set();
            for (const p of result.paid) { if (p.sheet_row_number) fetchRows.add(p.sheet_row_number); }
            for (const u of result.unused) { if (u.sheet_row_number) fetchRows.add(u.sheet_row_number); }
            if (fetchRows.size > 0) {
              const updates = [];
              for (const row of fetchRows) {
                updates.push({ range: `${result.cfg.tab}!I${row}`, value: `Fetched at: ${fetchedAt} (DRY_RUN)` });
                updates.push({ range: `${result.cfg.tab}!J${row}`, value: `DRY_RUN — would push (DRY_RUN)` });
              }
              const r = await writeSheetCells(result.cfg.sheetId, updates);
              console.log(`[dry-run] Column I+J markers written: ${r.updatedCells} cells across ${fetchRows.size} rows in ${result.cfg.tab}`);
              // Paint K marker (yellow row + "end of <tick> (DRY_RUN)") at last row
              const lastRow = Math.max(...fetchRows);
              await paintRowEndMarker(result.cfg.sheetId, result.cfg.tab, lastRow, tickName, { dryRun: true });
              console.log(`[dry-run] Column K end marker painted at row ${lastRow} in ${result.cfg.tab}`);
            }
          }
        } catch (err) {
          console.error('[dry-run] sheet marker write failed (non-fatal):', err.message);
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
      // Fix #3 (Frank 2026-06-29): 30-sec heartbeat keeps locked_at fresh
      // while the bg job is alive. Paired with the new 90-sec stale-reclaim
      // threshold, a crashed bg job frees the lock in 90s instead of 5 min
      // (today's meru0500 zombied for 80 min — that's what this prevents).
      lockHeldForBackground = true;
      const heartbeat = setInterval(() => {
        db().query(
          `UPDATE auto_upload_locks SET locked_at = now() WHERE channel = $1 AND holder = $2`,
          [channel, lockHolder],
        ).catch(() => {});
      }, 30_000);
      setImmediate(() => {
        runAutoUploadBackground({
          batchId: result.batchId,
          paid: result.paid,
          unused: result.unused,
          txnDate: txnDateOverride,
          txnDateByRef: result.replayTxnDateByRef,
          qbCreatePayment,
          qbBatchCreatePayments,
          qbCreateUnappliedPayment,
          qbBatchCreateUnappliedPayments,
          qbBatchLookupCustomers,
          qbCreateCreditMemo,
          cfg: result.cfg,
          tickName: String(req.body?.tick_name || 'heisenberg'),
        })
          .catch((err) => {
            console.error('[auto-upload background]', result.batchId, err);
          })
          .finally(async () => {
            clearInterval(heartbeat);
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

  // ── POST /api/admin/clear-arrears-cache ──────────────────────────────────
  // Frank 2026-06-14: between cross-channel fires that share AS_OF, we need
  // to flush the in-process arrears cache so the next prepareAutoUpload sees
  // QB Payments the prior fire just pushed (otherwise W1's closed invoices
  // appear "still open" to channel 2's matcher → double-pay risk).
  app.post('/api/admin/clear-arrears-cache', requireSecretOrJwt, async (req, res) => {
    const before = _arrearsCache.size;
    _arrearsCache.clear();
    res.json({ ok: true, cleared_entries: before });
  });

  // ── POST /api/payment-batches/start/:channel ─────────────────────────────
  // Frank 2026-06-14: "the start button". Read the channel's sheet, compute
  // the catchup plan (computeCatchupPlan), and execute every window in the
  // plan SEQUENTIALLY using the existing prepareAutoUpload + runAutoUpload-
  // Background pipeline. One channel lock held across the whole sequence —
  // a second click while running gets 409.
  //
  // No human in the loop deciding "what windows do I fire today" — every day
  // is the same code path. K-marker → today produces 0..N windows; we fire
  // them all in order, awaiting each so the K-marker advances correctly
  // between entries.
  //
  // Body: { dry_run?: boolean, tick_name?: string }
  //   tick_name optional — defaults to 'start_button'. Used for Column K
  //   marker AND payment_batches.created_by attribution.
  app.post('/api/payment-batches/start/:channel', requireSecretOrJwt, async (req, res) => {
    const channel = req.params.channel;
    if (!['nmbnew', 'bank', 'iphone_bank', 'nmbnew_sav', 'bank_sav'].includes(channel)) {
      return res.status(400).json({ error: 'channel must be nmbnew, bank, iphone_bank, nmbnew_sav, or bank_sav' });
    }
    const dryRun = req.body?.dry_run === true;
    const buttonTickName = String(req.body?.tick_name || 'start_button').toLowerCase();

    // Same kill-switch logic as the single-window endpoint — JWT bypasses,
    // heisenberg bypasses, otherwise honour app_settings.auto_upload_enabled.
    if (!req.user && buttonTickName !== 'heisenberg' && buttonTickName !== 'start_button') {
      try {
        const r = await db().query(`SELECT value FROM app_settings WHERE key = 'auto_upload_enabled'`);
        const v = r.rows[0]?.value;
        if (v && String(v).toLowerCase() === 'false') {
          return res.status(503).json({
            error: `auto-upload disabled for scheduled-tick automation (app_settings.auto_upload_enabled=false). tick_name='${buttonTickName}'.`,
            remedy: 'fire from dashboard (Supabase JWT) or set auto_upload_enabled=true',
          });
        }
      } catch (err) {
        console.error('[start-channel kill-switch check failed — failing OPEN]:', err.message);
      }
    }

    // Acquire channel lock (5-min stale reclaim same as single-window endpoint).
    const lockHolder = `${process.pid}-${Math.random().toString(36).slice(2, 8)}-start`;
    const lockResult = await db().query(
      `INSERT INTO auto_upload_locks (channel, locked_at, holder)
       VALUES ($1, now(), $2)
       ON CONFLICT (channel) DO UPDATE
         SET locked_at = now(), holder = EXCLUDED.holder
         WHERE auto_upload_locks.locked_at < now() - interval '90 seconds'
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

    let releasedSync = false;
    const releaseLock = async () => {
      if (releasedSync) return;
      releasedSync = true;
      await db().query(
        `DELETE FROM auto_upload_locks WHERE channel=$1 AND holder=$2`,
        [channel, lockHolder],
      ).catch(() => {});
    };

    try {
      // Read sheet + compute plan synchronously (cheap — single sheet read).
      const cfg = CHANNEL_SHEETS[channel];
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:L200000`);
      const sheet = sheetData.values || sheetData.data || [];
      const planResult = computeCatchupPlan({ channel, sheet, nowUtcMs: Date.now() });

      if (planResult.plan.length === 0) {
        await releaseLock();
        return res.status(200).json({
          status: 'up_to_date',
          channel,
          marker: planResult.marker,
          reason: planResult.reason,
        });
      }

      // Hand off to background — the per-entry sequence can take minutes for
      // a multi-day catchup. HTTP returns 202 immediately with the plan so the
      // dashboard can render progress + poll batch states.
      setImmediate(async () => {
        const batchIds = [];
        // Frank 2026-07-21: track MAX row across ALL windows in this session
        // and read cfg (sheetId/tab) once for the final K marker write.
        let sessionMaxRow = 0;
        const cfgAtFireStart = CHANNEL_SHEETS[channel];
        // Fix #3 (Frank 2026-06-29): 30-sec heartbeat keeps locked_at fresh
        // for the WHOLE catchup orchestration (which can span many windows
        // and 5-15 minutes). Paired with the 90-sec stale-reclaim, a dead
        // orchestrator frees the lock in 90s instead of 5+ min.
        const heartbeat = setInterval(() => {
          db().query(
            `UPDATE auto_upload_locks SET locked_at = now() WHERE channel = $1 AND holder = $2`,
            [channel, lockHolder],
          ).catch(() => {});
        }, 30_000);
        try {
          for (let pi = 0; pi < planResult.plan.length; pi++) {
            const entry = planResult.plan[pi];
            const entryTickName = `${buttonTickName}:${entry.tick_label}`;
            // Frank 2026-06-14 rule: invalidate arrears cache between windows.
            // Cache is keyed by asOf. W2 and W3 share asOf=today, so without
            // this clear, W3 would re-use W2's pre-W2-Payment arrears and could
            // re-pay invoices W2 just closed. Cheap (sub-second clear) — the
            // refetch on next prepareAutoUpload call takes 15-25s for ~12k
            // invoices but guarantees correctness.
            if (pi > 0) {
              _arrearsCache.clear();
              console.log(`[start-channel ${channel}] cleared arrears cache before window ${pi + 1}`);
            }
            console.log(`[start-channel ${channel}] (${pi + 1}/${planResult.plan.length}) ${entry.tick_label} window=${entry.since_iso}→${entry.until_iso} as_of=${entry.as_of} txn_date=${entry.txn_date} rows=${entry.row_count}`);

            const result = await prepareAutoUpload({
              channel,
              sinceIso: entry.since_iso,
              untilIso: entry.until_iso,
              asOf: entry.as_of,
              tickName: entryTickName,
              txnDate: entry.txn_date,
              qbPreflightDedup: dryRun ? null : qbPreflightDedup,
              dryRun,
            });
            if (result.skipped) {
              console.log(`[start-channel ${channel}] ${entry.tick_label} skipped: ${result.reason}`);
              continue;
            }
            if (result.aborted) {
              console.error(`[start-channel ${channel}] ${entry.tick_label} ABORTED: ${result.reason}`);
              break; // QB pre-flight failure — stop, don't continue to next windows
            }

            // Safety: same per-fire max as single-window endpoint.
            const maxPaid = Number(process.env.AUTO_UPLOAD_MAX_PAID || 200);
            if (result.paid.length > maxPaid) {
              console.error(`[start-channel ${channel}] ${entry.tick_label} too big: paid=${result.paid.length} > max=${maxPaid} — cleaning up + stopping`);
              await db().query(`DELETE FROM consumed_transactions WHERE batch_id=$1`, [result.batchId]).catch(() => {});
              await db().query(`DELETE FROM payment_batches WHERE id=$1`, [result.batchId]).catch(() => {});
              break;
            }

            batchIds.push(result.batchId);

            if (dryRun) {
              // Frank 2026-06-14 dry-run rule for start-button catchup:
              //   - NO QB calls
              //   - NO sheet Column I / J / K / L writes (preserve for the
              //     real fire later)
              //   - DB rows ARE written (payment_batches + payment_uploads
              //     for both paid AND unused) so the operator can query the
              //     full per-window outcome
              //   - consumed_transactions cleared so refs stay eligible for
              //     the eventual real fire
              await db().query(`DELETE FROM consumed_transactions WHERE batch_id = $1`, [result.batchId]).catch(() => {});
              await db().query(
                `UPDATE payment_batches SET status='finalized', finalized_at=now(),
                   failure_reason='dry_run (start-button catchup; no QB calls; no sheet writes)' WHERE id=$1`,
                [result.batchId],
              ).catch(() => {});
              for (const p of result.paid) {
                await db().query(
                  `INSERT INTO payment_uploads (
                     batch_id, kind, bank_ref, customer_id, customer_name,
                     invoice_qb_id, invoice_no, amount, memo, status
                   ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'dry_run')`,
                  [result.batchId, p.memoWithSuffix, p.customerId, p.customerName,
                   p.qbId, p.invoiceNo, round2(p.amount), p.memoWithSuffix],
                ).catch(() => {});
              }
              for (const u of result.unused) {
                await db().query(
                  `INSERT INTO payment_uploads (
                     batch_id, kind, bank_ref, customer_id, customer_name,
                     amount, memo, status
                   ) VALUES ($1,'credit_memo',$2,NULL,$3,$4,$5,'dry_run')`,
                  [result.batchId, u.memoWithSuffix, u.customerName, round2(u.transactionAmount), u.memoWithSuffix],
                ).catch(() => {});
              }
              continue; // next window
            }

            // REAL push — await runAutoUploadBackground so I/J writes land
            // before the next prepareAutoUpload. K marker is deferred to the
            // end of the whole session (see below) so retro-window K markers
            // don't orphan fresh rows appended later in the sheet.
            await runAutoUploadBackground({
              batchId: result.batchId,
              paid: result.paid,
              unused: result.unused,
              txnDate: entry.txn_date,
              txnDateByRef: result.replayTxnDateByRef,
              qbCreatePayment,
              qbBatchCreatePayments,
              qbCreateUnappliedPayment,
              qbBatchCreateUnappliedPayments,
              qbBatchLookupCustomers,
              qbCreateCreditMemo,
              cfg: result.cfg,
              tickName: entryTickName,
              skipEndOfTickMarker: true,
            }).catch((err) => {
              console.error(`[start-channel ${channel}] ${entry.tick_label} runAutoUploadBackground threw:`, err);
            });
            // Track max processed row for the single final K marker.
            for (const p of (result.paid || [])) {
              if (p.sheet_row_number && p.sheet_row_number > sessionMaxRow) sessionMaxRow = p.sheet_row_number;
            }
            for (const u of (result.unused || [])) {
              if (u.sheet_row_number && u.sheet_row_number > sessionMaxRow) sessionMaxRow = u.sheet_row_number;
            }
          }
          console.log(`[start-channel ${channel}] all ${planResult.plan.length} window(s) done; batches=${batchIds.join(',')}`);
          // Frank 2026-07-21: ONE final K marker at MAX(row) across all
          // windows this session. Prevents per-window K markers from being
          // written on retro rows (whose bank_ts is old but row_number is
          // high because they were appended late) — those markers used to
          // orphan fresh rows sitting below the retro K in the sheet.
          try {
            const firstResult = batchIds.length ? { cfg: cfgAtFireStart } : null;
            const sheetCfg = cfgAtFireStart;
            if (sessionMaxRow > 0 && sheetCfg && sheetCfg.sheetId && sheetCfg.tab) {
              await paintRowEndMarker(sheetCfg.sheetId, sheetCfg.tab, sessionMaxRow, buttonTickName);
              console.log(`[start-channel ${channel}] SESSION-END K marker at row ${sessionMaxRow} tick='end of ${buttonTickName}' on ${sheetCfg.tab}`);
            } else if (sessionMaxRow === 0) {
              console.log(`[start-channel ${channel}] no rows processed across ${planResult.plan.length} window(s) — skipping session-end K marker`);
            }
          } catch (err) {
            console.error(`[start-channel ${channel}] session-end K marker failed (non-fatal):`, err.message);
          }
        } catch (err) {
          console.error(`[start-channel ${channel}] background orchestrator threw:`, err);
        } finally {
          clearInterval(heartbeat);
          await releaseLock();
        }
      });

      res.status(202).json({
        status: dryRun ? 'planning_dry_run' : 'planning',
        channel,
        marker: planResult.marker,
        plan: planResult.plan,
        plan_size: planResult.plan.length,
        reason: planResult.reason,
        message: 'background sequence started; poll /api/payment-batches for batch_ids as they appear',
      });
    } catch (err) {
      console.error('[POST /api/payment-batches/start]', err);
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
      // Never-give-up recall (Frank 2026-06-07): retry every failed void
      // up to MAX_RECALL_ATTEMPTS (default 100, env-overridable). Aggressive
      // mode (?aggressive=1) drops the cap entirely and retries until every
      // single void succeeds, regardless of how many attempts.
      // Each retry round logs to batch_logs so the operator can come back
      // and read the full trail in the batch detail page.
      const isAggressive = req.query?.aggressive === '1' || req.body?.aggressive === true;
      const MAX_RECALL_ATTEMPTS = isAggressive ? Infinity : Number(process.env.MAX_RECALL_ATTEMPTS || 100);
      await logBatch(batchId, 'info', `recall start: ${ups.rows.length} payments to void, mode=${isAggressive ? 'AGGRESSIVE (no cap)' : 'capped @ ' + MAX_RECALL_ATTEMPTS}, reason="${reason}"`, 'recall', { void_count: ups.rows.length, aggressive: isAggressive });
      let voids = await voidUploadsBestEffort(ups.rows, qbVoid);
      let attempt = 1;
      while (attempt < MAX_RECALL_ATTEMPTS) {
        const stillFailed = voids.filter((v) => !v.ok);
        if (!stillFailed.length) {
          console.log(`[recall ${batchId}] all voids succeeded after ${attempt} attempts`);
          await logBatch(batchId, 'info', `all ${ups.rows.length} voids succeeded after ${attempt} attempt(s)`, 'recall', { attempts: attempt });
          break;
        }
        attempt++;
        const capLabel = MAX_RECALL_ATTEMPTS === Infinity ? '∞' : MAX_RECALL_ATTEMPTS;
        console.log(`[recall ${batchId}] attempt ${attempt}/${capLabel}: ${stillFailed.length} voids still failing`);
        await logBatch(batchId, 'warn', `attempt ${attempt}/${capLabel}: ${stillFailed.length} voids still failing — retrying after backoff`, 'recall', { attempt, still_failing: stillFailed.length });
        // Exponential backoff with jitter, capped at 60s.
        // Aggressive mode is more patient — gives QB more time to recover
        // from rate-limit stuns (especially on big batches with hundreds
        // of voids hammering the throttle).
        const baseMs = isAggressive ? 5_000 : 3_000;
        const wait = Math.min(60_000, baseMs * Math.pow(1.6, Math.min(attempt - 1, 8))) + Math.random() * 1000;
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
        console.warn(`[recall ${batchId}] gave up after ${attempt} attempts — ${stuckCount} voids still failing (permanent errors?)`);
        await logBatch(batchId, 'error', `gave up after ${attempt} attempts — ${stuckCount} voids still failing (likely permanent errors: 404 Payment gone, 400 invalid). See payment_uploads.failure_reason for each.`, 'recall', { final_attempts: attempt, stuck_count: stuckCount });
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
          // Frank 2026-07-16: recall must ALSO clear external_consumed_refs
          // for this batch's refs. Previously only consumed_transactions got
          // cleared, so refs stayed cached as "already in QB" via the earlier
          // dup-check even though the QB Payment was just voided. Next fire
          // then reported "all refs already consumed" and dropped ~50 real
          // txns to 3. This delete makes recall symmetric with fire.
          if (batch.bank_refs && batch.bank_refs.length) {
            const extDel = await c.query(
              `DELETE FROM external_consumed_refs WHERE bank_ref = ANY($1)`,
              [batch.bank_refs],
            );
            console.log(`[recall ${batchId}] also cleared ${extDel.rowCount} external_consumed_refs entries`);
          }
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

  // ── POST /api/payment-batches/:id/erase-dry-run-markers ─────────────────
  // Wipe every "(DRY_RUN)" marker BRAIN painted on this batch's sheet tab.
  // Use after operator reviews a dry-run plan visually and either commits
  // (then the real push paints over them) or abandons. Real (non-dry-run)
  // markers — purple rows + plain "end of <tick>" K text — are untouched.
  app.post('/api/payment-batches/:id/erase-dry-run-markers', requireSupabaseJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT sheet_id, sheet_tab FROM payment_batches WHERE id = $1`,
        [req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: 'batch not found' });
      const { sheet_id, sheet_tab } = r.rows[0];
      const result = await eraseDryRunMarkers(sheet_id, sheet_tab);
      res.json({ erased: true, ...result });
    } catch (err) {
      console.error('[POST /api/payment-batches/:id/erase-dry-run-markers]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/admin/erase-dry-run-markers/:channel ──────────────────────
  // Standalone form — wipes dry-run markers across the whole channel tab,
  // independent of which batch painted them. Useful when operator wants to
  // clean up before re-running with different params, without going batch
  // by batch.
  app.post('/api/admin/erase-dry-run-markers/:channel', requireSupabaseJwt, async (req, res) => {
    try {
      const cfg = CHANNEL_SHEETS[req.params.channel];
      if (!cfg) return res.status(400).json({ error: 'bad channel' });
      const result = await eraseDryRunMarkers(cfg.sheetId, cfg.tab);
      res.json({ erased: true, channel: req.params.channel, ...result });
    } catch (err) {
      console.error('[POST /api/admin/erase-dry-run-markers/:channel]', err);
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
      // Arrears snapshot summary (heavy data omitted unless include_snapshot=full)
      const sn = await db().query(
        `SELECT id, as_of, row_count, total_balance, created_at,
                ${req.query.include_snapshot === 'full' ? 'data' : 'NULL::jsonb as data'}
           FROM arrears_snapshots WHERE id=$1`,
        [batch.arrears_snapshot_id],
      );
      // Invoice snapshot (the QB Open-Invoices universe at AS_OF time).
      // Summary fields only by default — pull full data via the dedicated
      // /invoices.xls endpoint when the operator clicks download.
      let invoiceSnapshot = null;
      if (batch.invoice_snapshot_id) {
        const ivs = await db().query(
          `SELECT id, as_of, captured_at, invoice_count, total_balance, date_range_header
             FROM invoice_snapshots WHERE id=$1`,
          [batch.invoice_snapshot_id],
        );
        invoiceSnapshot = ivs.rows[0] || null;
      }
      // Skipped QB duplicates discovered during this batch's pre-flight.
      // We don't have a direct FK from external_consumed_refs to batch — we
      // surface ALL refs found_by this batch's channel since the batch was
      // created. Practical heuristic; cleaner shape comes in a follow-up.
      const sk = await db().query(
        `SELECT bank_ref, customer_id, qb_id, qb_kind, qb_txn_date, found_at, found_by
           FROM external_consumed_refs
          WHERE found_by LIKE $1 AND found_at >= $2 AND found_at <= $3
          ORDER BY found_at DESC
          LIMIT 5000`,
        [
          `auto-upload-${batch.channel}-dup-check%`,
          new Date(new Date(batch.created_at).getTime() - 60_000),
          new Date(new Date(batch.finalized_at || batch.created_at).getTime() + 5 * 60_000),
        ],
      );
      res.json({
        batch,
        uploads: u.rows,
        snapshot: sn.rows[0] || null,
        invoice_snapshot: invoiceSnapshot,
        skipped_duplicates: sk.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/payment-batches/:id/invoices.json ──────────────────────────
  // Full invoice snapshot data (the QB Open Invoices universe at AS_OF).
  // Dashboard fetches this then exports as .xls client-side using the
  // existing xlsx package — same pattern as /arrears page.
  app.get('/api/payment-batches/:id/invoices.json', requireSupabaseJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT iv.id, iv.as_of, iv.invoice_count, iv.total_balance,
                iv.date_range_header, iv.data, iv.captured_at
           FROM payment_batches pb
           JOIN invoice_snapshots iv ON pb.invoice_snapshot_id = iv.id
          WHERE pb.id = $1`,
        [req.params.id],
      );
      if (!r.rows.length) return res.status(404).json({ error: 'invoice snapshot not found for this batch' });
      res.json({ snapshot: r.rows[0] });
    } catch (err) {
      console.error('[GET /api/payment-batches/:id/invoices.json]', err);
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
        const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:H200000`);
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
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K200000`);
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

  // POST /api/admin/patch-batch-txndate
  // Body: { batch_id, new_txn_date }
  // Walks all created PUs in the batch and PATCHes each QB Payment's TxnDate
  // to new_txn_date via QBO sparse update. Repairs heisenberg fires that
  // got wrong TxnDate from wall-clock paymentTxnDate() fallback.
  app.post('/api/admin/patch-batch-txndate', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.body?.batch_id || '');
      const newDate = String(req.body?.new_txn_date || '');
      if (!batchId || !/^\d{4}-\d{2}-\d{2}$/.test(newDate)) {
        return res.status(400).json({ error: 'batch_id + new_txn_date (YYYY-MM-DD) required' });
      }
      const ups = await db().query(
        `SELECT id, qb_id, amount FROM payment_uploads
          WHERE batch_id = $1 AND status = 'created' AND qb_id IS NOT NULL`,
        [batchId],
      );
      const rows = ups.rows;
      const results = [];
      const PAR = 10;
      let idx = 0;
      const worker = async () => {
        while (true) {
          const i = idx++;
          if (i >= rows.length) return;
          const u = rows[i];
          try {
            const r = await qbPatchPaymentTxnDate(u.qb_id, newDate);
            results.push({ pu_id: u.id, qb_id: u.qb_id, amount: u.amount, ...r });
          } catch (err) {
            results.push({ pu_id: u.id, qb_id: u.qb_id, amount: u.amount, ok: false, err: String(err.message || err).slice(0, 200) });
          }
        }
      };
      await Promise.all(Array.from({ length: PAR }, () => worker()));
      const ok = results.filter((r) => r.ok).length;
      const fail = results.filter((r) => !r.ok).length;
      const already = results.filter((r) => r.skipped === 'already_correct').length;
      const missing = results.filter((r) => r.skipped === 'payment_not_found').length;
      res.json({
        batch_id: batchId,
        new_txn_date: newDate,
        total: rows.length,
        ok, fail,
        already_correct: already,
        not_found: missing,
        failures: results.filter((r) => !r.ok).slice(0, 20),
      });
    } catch (err) {
      console.error('[patch-batch-txndate] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/clear-marker-rows
  // Body: { channel, from_row, to_row }
  // Wipes I/J/K marker columns for the given row range on the channel sheet.
  // Use after recalling a batch when the recall left stale "already pushed"
  // markers behind (recall voids QB Payments + releases CT but does NOT
  // touch the sheet's per-row I/J markers or "end of tick" K markers).
  // Without this, the next fire silently skips those rows.
  app.post('/api/admin/clear-marker-rows', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const fromRow = Number(req.body?.from_row);
      const toRow = Number(req.body?.to_row);
      if (!Number.isInteger(fromRow) || !Number.isInteger(toRow) || fromRow < 2 || toRow < fromRow) {
        return res.status(400).json({ error: 'from_row, to_row required (integers ≥2, to≥from)' });
      }
      const cfg = CHANNEL_SHEETS[channel];
      const result = await clearMarkerRowRange(cfg.sheetId, cfg.tab, fromRow, toRow);
      res.json({ channel, from_row: fromRow, to_row: toRow, ...result });
    } catch (err) {
      console.error('[clear-marker-rows] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/release-specific-refs
  // Body: { refs: [suffixed_ref, ...] }
  // Deletes them from consumed_transactions + external_consumed_refs so a fresh
  // dry-run picks them back up. Use ONLY when operator has confirmed those refs
  // are NOT in QB (orphan CT entries from voided/failed prior batches).
  app.post('/api/admin/release-specific-refs', requireSecretOrJwt, async (req, res) => {
    try {
      const refs = Array.isArray(req.body?.refs) ? req.body.refs.map(String) : [];
      if (!refs.length) return res.status(400).json({ error: 'refs[] required' });
      const ct = await db().query(
        `DELETE FROM consumed_transactions WHERE bank_ref = ANY($1::text[]) RETURNING bank_ref`,
        [refs],
      );
      const ext = await db().query(
        `DELETE FROM external_consumed_refs WHERE bank_ref = ANY($1::text[]) RETURNING bank_ref`,
        [refs],
      );
      res.json({
        requested: refs.length,
        ct_released: ct.rowCount,
        ext_released: ext.rowCount,
        ct_refs: ct.rows.map((r) => r.bank_ref),
        ext_refs: ext.rows.map((r) => r.bank_ref),
      });
    } catch (err) {
      console.error('[release-specific-refs] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/dump-sheet-rows-in-window
  // Body: { channel, since_iso, until_iso }
  // Returns every sheet row in the window — row#, timestamp, amount, ref,
  // customer. Used to reconcile against operator's drag-drop totals.
  app.post('/api/admin/dump-sheet-rows-in-window', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const cfg = CHANNEL_SHEETS[channel];
      const winStart = new Date(String(req.body?.since_iso || ''));
      const winEnd = new Date(String(req.body?.until_iso || ''));
      if (isNaN(+winStart) || isNaN(+winEnd)) return res.status(400).json({ error: 'since_iso/until_iso required' });
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K200000`);
      const sheet = sheetData.values || sheetData.data || [];
      const rows = [];
      let total = 0;
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (!ts) continue;
        if (ts < winStart || ts >= winEnd) continue;
        const amt = sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : 0;
        total += amt;
        rows.push({
          row: i + 1,
          ts: dCell,
          amount: amt,
          customer: sheet[i][6] || null,
          ref: sheet[i][7] || null,
        });
      }
      res.json({
        channel,
        window: { since: winStart.toISOString(), until: winEnd.toISOString() },
        row_count: rows.length,
        total,
        rows,
      });
    } catch (err) {
      console.error('[dump-sheet-rows-in-window] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/diag-window-skips
  // Body: { channel, since_iso, until_iso }
  // Mirrors prepareAutoUpload's skip logic and reports the EXACT breakdown of
  // why rows in window are skipped. Critical when BRAIN sees fewer rows than
  // the sheet truth.
  app.post('/api/admin/diag-window-skips', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: 'bad channel' });
      const cfg = CHANNEL_SHEETS[channel];
      const winStart = new Date(String(req.body?.since_iso || ''));
      const winEnd = new Date(String(req.body?.until_iso || ''));
      if (isNaN(+winStart) || isNaN(+winEnd)) return res.status(400).json({ error: 'since_iso/until_iso required' });
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K200000`);
      const sheet = sheetData.values || sheetData.data || [];
      let maxKRow = 0;
      let kSamples = [];
      for (let i = 1; i < sheet.length; i++) {
        const colK = String(sheet[i][10] || '').trim().toLowerCase();
        if (colK.startsWith('end of ')) {
          maxKRow = i + 1;
          if (kSamples.length < 5) kSamples.push({ row: i + 1, k: sheet[i][10] });
        }
      }
      const inWindow = [];
      let skippedKBoundary = 0, skippedIJ = 0;
      let iSet = 0, jSet = 0, bothIJ = 0;
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (!ts) continue;
        if (ts < winStart || ts >= winEnd) continue;
        const rowNum = i + 1;
        const colI = String(sheet[i][8] || '').trim();
        const colJ = String(sheet[i][9] || '').trim();
        const colK = String(sheet[i][10] || '').trim();
        const ref = String(sheet[i][7] || '').trim();
        const amt = sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : 0;
        let skip = null;
        if (maxKRow > 0 && rowNum <= maxKRow) { skip = 'K_boundary'; skippedKBoundary++; }
        else if (colI || colJ) {
          skip = 'I_or_J_set'; skippedIJ++;
          if (colI && colJ) bothIJ++;
          else if (colI) iSet++;
          else jSet++;
        }
        inWindow.push({ row: rowNum, ts: dCell, ref, amount: amt, colI, colJ, colK, skip });
      }
      const passedRows = inWindow.filter((r) => !r.skip);
      const skippedRows = inWindow.filter((r) => r.skip);
      res.json({
        channel,
        window: { since: winStart.toISOString(), until: winEnd.toISOString() },
        max_k_row: maxKRow,
        k_samples: kSamples,
        total_in_window: inWindow.length,
        passed: passedRows.length,
        passed_sum: passedRows.reduce((s, r) => s + r.amount, 0),
        skipped_total: skippedRows.length,
        skipped_K_boundary: skippedKBoundary,
        skipped_I_or_J_set: skippedIJ,
        I_only: iSet, J_only: jSet, both_IJ: bothIJ,
        skipped_sample: skippedRows.slice(0, 5),
      });
    } catch (err) {
      console.error('[diag-window-skips] failed:', err);
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
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K200000`);
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
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:K200000`);
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

  // POST /api/admin/write-sheet-cell
  // Body: { sheet_id, cell_a1 (e.g. "pikipiki records2!D252"), value }
  // Diagnostic passthrough — writes a single cell.
  app.post('/api/admin/write-sheet-cell', requireSecretOrJwt, async (req, res) => {
    try {
      const sheetId = String(req.body?.sheet_id || '');
      const cellA1 = String(req.body?.cell_a1 || '');
      const value = req.body?.value;
      if (!sheetId || !cellA1) return res.status(400).json({ error: 'sheet_id + cell_a1 required' });
      const r = await writeSheetCells(sheetId, [{ range: cellA1, value: String(value ?? '') }]);
      res.json({ ok: true, cell: cellA1, value, updated_cells: r.updatedCells });
    } catch (err) {
      console.error('[write-sheet-cell]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/read-sheet-raw?sheet_id=<>&tab=<>&range=<>
  // Diagnostic passthrough to Google Sheets — used to peek at any tab
  // BRAIN doesn't have a config entry for (e.g. Frank's phone book).
  // Returns { values: [[...],[...],...] }.
  app.get('/api/admin/read-sheet-raw', requireSecretOrJwt, async (req, res) => {
    try {
      const sheetId = String(req.query.sheet_id || '');
      const tab = String(req.query.tab || '');
      const range = String(req.query.range || 'A1:Z10000');
      if (!sheetId || !tab) return res.status(400).json({ error: 'sheet_id + tab required' });
      const data = await readSheet(sheetId, `${tab}!${range}`);
      const values = data.values || data.data || [];
      res.json({ sheet_id: sheetId, tab, range, row_count: values.length, values });
    } catch (err) {
      console.error('[read-sheet-raw]', err);
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
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:J200000`);
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
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:J200000`);
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
      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:J200000`);
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

  // POST /api/admin/retry-batch-failures
  // For a pending batch with status='failed' payment_uploads (most commonly
  // QB timeout casualties), preflight QB to catch latent-success writes
  // (timeout returned but the Payment did land), then retry the rest. If
  // every failed row ends up created → finalize the batch.
  // Body: { batch_id, dry_run?: true, concurrency?: 3 }
  app.post('/api/admin/retry-batch-failures', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.body?.batch_id || '');
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      const dryRun = req.body?.dry_run === true;
      const PAR = Math.max(1, Math.min(8, Number(req.body?.concurrency) || 3));

      let fullId = batchId;
      if (batchId.length < 36) {
        const r = await db().query(`SELECT id FROM payment_batches WHERE id::text LIKE $1 LIMIT 1`, [batchId + '%']);
        if (!r.rows.length) return res.status(404).json({ error: 'batch not found' });
        fullId = r.rows[0].id;
      }

      const batch = (await db().query(
        `SELECT id, channel, status, txn_date FROM payment_batches WHERE id=$1`,
        [fullId],
      )).rows[0];
      if (!batch) return res.status(404).json({ error: 'batch not found' });
      if (!batch.txn_date) return res.status(400).json({ error: 'batch has no txn_date — cannot push' });
      const txnDate = batch.txn_date instanceof Date
        ? batch.txn_date.toISOString().slice(0, 10)
        : String(batch.txn_date).slice(0, 10);

      const failedRows = (await db().query(
        `SELECT id, bank_ref, customer_id, customer_name, invoice_qb_id, amount, kind, failure_reason
           FROM payment_uploads
          WHERE batch_id = $1 AND status = 'failed'
          ORDER BY id`,
        [fullId],
      )).rows;

      if (failedRows.length === 0) {
        return res.json({ batch_id: fullId, attempted: 0, message: 'no failed rows to retry' });
      }

      if (dryRun) {
        return res.json({
          batch_id: fullId,
          channel: batch.channel,
          txn_date: txnDate,
          attempted: failedRows.length,
          dry_run: true,
          sample: failedRows.slice(0, 5).map((r) => ({
            ref: r.bank_ref, amount: Number(r.amount), customer: r.customer_name,
            kind: r.kind, has_invoice: !!r.invoice_qb_id, failure_reason: r.failure_reason,
          })),
        });
      }

      const sinceISO = (() => {
        const d = new Date(txnDate); d.setUTCDate(d.getUTCDate() - 7);
        return d.toISOString().slice(0, 10);
      })();

      let recovered = 0;
      let latentSuccess = 0;
      let stillFailed = 0;
      const stillFailures = [];
      let cursor = 0;

      const worker = async () => {
        while (true) {
          const i = cursor++;
          if (i >= failedRows.length) return;
          const u = failedRows[i];
          try {
            // 1. Preflight: maybe the timeout-failed push actually succeeded server-side
            const q = await qbQuery(
              `SELECT Id, PrivateNote, TotalAmt FROM Payment ` +
              `WHERE CustomerRef = '${String(u.customer_id).replace(/'/g, "''")}' ` +
              `AND TxnDate >= '${sinceISO}' MAXRESULTS 1000`,
            );
            const pmts = q.QueryResponse?.Payment || [];
            const hit = pmts.find((p) => String(p.PrivateNote || '') === u.bank_ref && Number(p.TotalAmt) === Number(u.amount));
            if (hit) {
              await db().query(
                `UPDATE payment_uploads SET status='created', qb_id=$2, failure_reason=NULL WHERE id=$1`,
                [u.id, String(hit.Id)],
              );
              latentSuccess++;
              recovered++;
              continue;
            }

            // 2. Re-push: kind + invoice presence picks the right QB call
            let qb;
            if (u.kind === 'payment' && u.invoice_qb_id) {
              qb = await qbCreatePayment({
                customerId: u.customer_id, invoiceQbId: u.invoice_qb_id,
                amount: Number(u.amount), memo: u.bank_ref, txnDate,
              });
            } else if (u.kind === 'payment' && !u.invoice_qb_id) {
              qb = await qbCreateUnappliedPayment({
                customerId: u.customer_id, amount: Number(u.amount),
                memo: u.bank_ref, txnDate,
              });
            } else {
              qb = await qbCreateCreditMemo({
                customerId: u.customer_id, amount: Number(u.amount),
                memo: u.bank_ref, txnDate,
              });
            }
            if (!qb || !qb.id) throw new Error('no qb id returned');
            await db().query(
              `UPDATE payment_uploads SET status='created', qb_id=$2, qb_response=$3, failure_reason=NULL WHERE id=$1`,
              [u.id, String(qb.id), JSON.stringify(qb.response || {})],
            );
            recovered++;
          } catch (err) {
            stillFailed++;
            const reason = String(err.message || err).slice(0, 500);
            stillFailures.push({ ref: u.bank_ref, amount: Number(u.amount), customer: u.customer_name, reason });
            await db().query(
              `UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`,
              [u.id, reason],
            );
          }
        }
      };
      await Promise.all(Array.from({ length: PAR }, () => worker()));

      // If no failures remain in the batch → finalize
      let batchStatus = batch.status;
      if (stillFailed === 0) {
        const remaining = (await db().query(
          `SELECT COUNT(*)::int AS n FROM payment_uploads WHERE batch_id=$1 AND status='failed'`,
          [fullId],
        )).rows[0].n;
        if (remaining === 0) {
          await db().query(
            `UPDATE payment_batches SET status='finalized', finalized_at=now(), failure_reason=NULL WHERE id=$1`,
            [fullId],
          );
          batchStatus = 'finalized';
        }
      }

      res.json({
        batch_id: fullId,
        channel: batch.channel,
        txn_date: txnDate,
        attempted: failedRows.length,
        recovered,
        latent_success: latentSuccess,
        still_failed: stillFailed,
        still_failures: stillFailures.slice(0, 20),
        batch_status: batchStatus,
      });
    } catch (err) {
      console.error('[retry-batch-failures] failed:', err);
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
  /**
   * GET /api/admin/find-customer-payments?q=<name-fragment>&since=<iso>
   * Returns every payment_uploads row where customer_name ILIKE %q% since
   * the given date. Includes bank_ref, invoice_no, amount, status, batch id,
   * batch created_at. Use to trace a specific customer's payments end-to-end.
   */
  app.get('/api/admin/find-customer-payments', requireSecretOrJwt, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      const since = String(req.query.since || '2026-06-29T00:00:00Z');
      if (!q) return res.status(400).json({ error: 'q required' });
      const rows = await db().query(
        `SELECT pu.bank_ref, pu.customer_name, pu.customer_id, pu.invoice_no,
                pu.amount, pu.status, pu.kind, pu.qb_id, pu.batch_id,
                pb.channel, pb.created_by, pb.created_at
           FROM payment_uploads pu
           JOIN payment_batches pb ON pb.id = pu.batch_id
          WHERE pu.customer_name ILIKE $1
            AND pb.created_at >= $2
          ORDER BY pb.created_at DESC, pu.customer_name
          LIMIT 200`,
        [`%${q}%`, since],
      );
      res.json({ q, since, hits: rows.rows.length, rows: rows.rows });
    } catch (err) {
      console.error('[find-customer-payments]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/sheet-dedup
   * Body: { channel, since_iso?, until_iso?, dry_run? }
   * Scans the channel's passed sheet for duplicate bank_refs (column H).
   * For each ref that appears N>1 times, keeps the FIRST row, marks the
   * other N-1 for deletion, AND clears I/J/K on the kept row so a re-fire
   * can process it fresh. Optionally restricts to rows whose sheet_ts is
   * in [since_iso, until_iso).
   *   - dry_run=true: preview only (default false so operator can execute)
   */
  app.post('/api/admin/sheet-dedup', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) {
        return res.status(400).json({ error: 'bad channel; need one of: ' + Object.keys(CHANNEL_SHEETS).join(',') });
      }
      const cfg = CHANNEL_SHEETS[channel];
      const sinceIso = req.body?.since_iso ? new Date(String(req.body.since_iso)) : null;
      const untilIso = req.body?.until_iso ? new Date(String(req.body.until_iso)) : null;
      const dryRun = req.body?.dry_run === true;

      const sd = await readSheet(cfg.sheetId, `${cfg.tab}!A1:M200000`);
      const sheet = sd.values || sd.data || [];
      const seen = new Map();               // ref → first row number kept
      const rowsToDelete = [];
      const rowsToClearMarkers = new Set();
      let scanned = 0;
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (sinceIso && ts && ts < sinceIso) continue;
        if (untilIso && ts && ts >= untilIso) continue;
        const rawRef = String(sheet[i][7] || '').trim();
        if (!rawRef) continue;
        scanned++;
        const rowNum = i + 1; // 1-based
        if (!seen.has(rawRef)) {
          seen.set(rawRef, rowNum);
        } else {
          // duplicate — delete this row + ensure first row's markers are cleared
          rowsToDelete.push(rowNum);
          rowsToClearMarkers.add(seen.get(rawRef));
        }
      }

      const summary = {
        channel,
        window: sinceIso && untilIso ? {
          since_iso: sinceIso.toISOString(),
          until_iso: untilIso.toISOString(),
        } : null,
        scanned_rows_with_refs: scanned,
        unique_refs: seen.size,
        duplicate_rows_to_delete: rowsToDelete.length,
        first_rows_to_clear_markers: rowsToClearMarkers.size,
      };

      if (dryRun || rowsToDelete.length === 0) {
        return res.json({ dry_run: dryRun, ...summary });
      }

      const del = await deleteSheetRowsAndClearMarkers(
        cfg.sheetId, cfg.tab, rowsToDelete, [...rowsToClearMarkers],
      );
      res.json({ dry_run: false, ...summary, result: del });
    } catch (err) {
      console.error('[sheet-dedup]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/restore-markers
   * Body: { channel, since_iso, until_iso, dry_run? }
   *
   * For every sheet row in the window whose bank_ref is in
   * consumed_transactions BUT whose I/J markers are empty, write:
   *   I = "Fetched at: (restored) <now-iso>"
   *   J = "<qb_id> | <payment_created_at>"  (qb_id from payment_uploads)
   *
   * Use after a bulk dedup + re-fire cycle wiped markers but the underlying
   * QB Payments still exist (Frank's 07-10 sheet cleanup incident).
   * Never writes if the row already has ANY marker in I or J — only fills
   * gaps. Frank 2026-07-10.
   */
  app.post('/api/admin/restore-markers', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) {
        return res.status(400).json({ error: 'bad channel; need one of: ' + Object.keys(CHANNEL_SHEETS).join(',') });
      }
      const cfg = CHANNEL_SHEETS[channel];
      const sinceIso = req.body?.since_iso ? new Date(String(req.body.since_iso)) : null;
      const untilIso = req.body?.until_iso ? new Date(String(req.body.until_iso)) : null;
      if (!sinceIso || !untilIso || isNaN(+sinceIso) || isNaN(+untilIso)) {
        return res.status(400).json({ error: 'since_iso + until_iso required' });
      }
      const dryRun = req.body?.dry_run === true;

      // 1. Read sheet in window, collect rows with a ref but empty I/J.
      const sd = await readSheet(cfg.sheetId, `${cfg.tab}!A1:L200000`);
      const sheet = sd.values || sd.data || [];
      const candidates = []; // {rowNum, ref}
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (!ts || ts < sinceIso || ts >= untilIso) continue;
        const rawRef = String(sheet[i][7] || '').trim();
        if (!rawRef) continue;
        const colI = String(sheet[i][8] || '').trim();
        const colJ = String(sheet[i][9] || '').trim();
        if (colI || colJ) continue; // already has some marker — don't touch
        candidates.push({ rowNum: i + 1, ref: rawRef });
      }

      if (!candidates.length) {
        return res.json({
          dry_run: dryRun,
          channel,
          candidates: 0,
          matched_in_ct: 0,
          unmatched: 0,
          restored: 0,
        });
      }

      // 2. Build both bare + suffixed ref forms (channel suffix N/B).
      const suffix = channel === 'nmbnew' ? 'N' : channel === 'bank' ? 'B' :
                     channel === 'iphone_bank' ? 'I' : '';
      const refPairs = candidates.map((c) => ({ bare: c.ref, suffixed: c.ref + suffix, row: c.rowNum }));
      const allRefs = [
        ...new Set([...refPairs.map((r) => r.bare), ...refPairs.map((r) => r.suffixed)]),
      ];

      // 3. Check which are in consumed_transactions + fetch qb_id from payment_uploads.
      const ctRes = await db().query(
        `SELECT bank_ref FROM consumed_transactions WHERE bank_ref = ANY($1::text[])`,
        [allRefs],
      );
      const consumedRefs = new Set(ctRes.rows.map((r) => r.bank_ref));
      const puRes = await db().query(
        `SELECT DISTINCT ON (bank_ref) bank_ref, qb_id, created_at
           FROM payment_uploads
          WHERE bank_ref = ANY($1::text[]) AND status = 'finalized' AND kind = 'paid' AND qb_id IS NOT NULL
          ORDER BY bank_ref, created_at DESC`,
        [allRefs],
      );
      const qbInfoByRef = new Map();
      for (const r of puRes.rows) {
        qbInfoByRef.set(r.bank_ref, { qb_id: r.qb_id, created_at: r.created_at });
      }

      // 4. Build writes for matched candidates.
      const nowIso = new Date().toISOString();
      const writes = []; // for writeSheetCells: [{range, value}]
      let matched = 0, unmatched = 0;
      const sample = [];
      for (const p of refPairs) {
        const bareHit = consumedRefs.has(p.bare);
        const sufHit = consumedRefs.has(p.suffixed);
        if (!bareHit && !sufHit) { unmatched++; continue; }
        matched++;
        const qbInfo = qbInfoByRef.get(p.bare) || qbInfoByRef.get(p.suffixed);
        const iVal = `Fetched at: (restored) ${nowIso}`;
        const jVal = qbInfo
          ? `${qbInfo.qb_id} | ${new Date(qbInfo.created_at).toISOString()}`
          : `(restored — qb_id unknown) ${nowIso}`;
        writes.push({ range: `${cfg.tab}!I${p.row}`, value: iVal });
        writes.push({ range: `${cfg.tab}!J${p.row}`, value: jVal });
        if (sample.length < 5) sample.push({ row: p.row, ref: p.bare, qb_id: qbInfo?.qb_id ?? null });
      }

      if (dryRun) {
        return res.json({
          dry_run: true,
          channel,
          candidates: candidates.length,
          matched_in_ct: matched,
          unmatched: unmatched,
          restored: 0,
          writes_planned: writes.length,
          sample,
        });
      }

      // 5. Execute the batch write (values.batchUpdate handles hundreds per call).
      const result = await writeSheetCells(cfg.sheetId, writes);
      res.json({
        dry_run: false,
        channel,
        candidates: candidates.length,
        matched_in_ct: matched,
        unmatched: unmatched,
        restored: matched,
        cells_written: result.updatedCells,
        sample,
      });
    } catch (err) {
      console.error('[restore-markers]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * GET /api/admin/apruna/roster
   * Returns the cached APRUNA customer roster (from Frappe's
   * savcom_customers?officer=APRUNA THOMAS BODA). Diagnostic.
   */
  app.get('/api/admin/apruna/roster', requireSecretOrJwt, async (req, res) => {
    try {
      const { getAprunaStats, getAprunaCache } = await import('./apruna-resolver.js');
      const stats = await getAprunaStats();
      if (req.query.full === '1' || req.query.full === 'true') {
        const cache = await getAprunaCache();
        stats.all_plates = Array.from(cache?.byPlate?.keys() || []);
        stats.all_phones = Array.from(cache?.byPhone?.keys() || []);
      }
      res.json(stats);
    } catch (err) {
      console.error('[apruna/roster]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/apruna/push-batch
   * Body: { batch_id, dry_run? }
   * Manually fire APRUNA dual-write for a finalized batch. Used to verify
   * end-to-end with the Frappe engineer before we hook auto-fire into
   * runAutoUploadBackground for every batch. Safe to re-run: Frappe dedupes
   * by txn_id (bank_ref) so second call returns { status: 'duplicate' }.
   */
  app.post('/api/admin/apruna/push-batch', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.body?.batch_id || '').trim();
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      const dryRun = req.body?.dry_run === true;
      const { pushAprunaForBatch } = await import('./apruna-frappe-push.js');
      const result = await pushAprunaForBatch(batchId, { dryRun });
      res.json(result);
    } catch (err) {
      console.error('[apruna/push-batch]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/apruna/refresh
   * Force-refresh the APRUNA roster cache immediately (bypasses TTL). Use
   * after the Frappe engineer adds new APRUNA customers so BRAIN sees them
   * without waiting for the 1-hour TTL.
   */
  app.post('/api/admin/apruna/refresh', requireSecretOrJwt, async (_req, res) => {
    try {
      const { getAprunaCache } = await import('./apruna-resolver.js');
      const cache = await getAprunaCache({ force: true });
      res.json({
        ok: true,
        total_customers: cache.total,
        with_qb_id: cache.byQbId.size,
        fetched_at: new Date(cache.fetchedAt).toISOString(),
      });
    } catch (err) {
      console.error('[apruna/refresh]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/clear-window-markers
   * Body: { channel, since_iso, until_iso, dry_run? }
   * Clears I/J/K on every row in the channel's PASSED sheet whose sheet_ts
   * falls in [since_iso, until_iso). Use to reset a range so a re-fire can
   * process it as fresh — needed after a void because the "end of <tick>"
   * K markers still gate the next fire's maxKRow check.
   */
  app.post('/api/admin/clear-window-markers', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) {
        return res.status(400).json({ error: 'bad channel; need one of: ' + Object.keys(CHANNEL_SHEETS).join(',') });
      }
      const cfg = CHANNEL_SHEETS[channel];
      const sinceIso = req.body?.since_iso ? new Date(String(req.body.since_iso)) : null;
      const untilIso = req.body?.until_iso ? new Date(String(req.body.until_iso)) : null;
      if (!sinceIso || !untilIso || isNaN(+sinceIso) || isNaN(+untilIso)) {
        return res.status(400).json({ error: 'since_iso + until_iso required' });
      }
      const dryRun = req.body?.dry_run === true;
      const sd = await readSheet(cfg.sheetId, `${cfg.tab}!A1:L200000`);
      const sheet = sd.values || sd.data || [];
      const rowsToClear = [];
      for (let i = 1; i < sheet.length; i++) {
        const dCell = String(sheet[i][1] || '').trim();
        if (!dCell) continue;
        const ts = parseTsAny(dCell);
        if (!ts) continue;
        if (ts < sinceIso || ts >= untilIso) continue;
        rowsToClear.push(i + 1);
      }
      if (dryRun || rowsToClear.length === 0) {
        return res.json({ dry_run: dryRun, channel, rows_to_clear: rowsToClear.length });
      }
      const result = await deleteSheetRowsAndClearMarkers(
        cfg.sheetId, cfg.tab, [], rowsToClear,
      );
      res.json({ dry_run: false, channel, rows_cleared: rowsToClear.length, ...result });
    } catch (err) {
      console.error('[clear-window-markers]', err);
      res.status(500).json({ error: err.message });
    }
  });

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
        // Frank 2026-07-02: bit-by-bit reconciliation view. One row per
        // payment_uploads paid line; grouped by bank_ref, this lets the
        // operator see for each bank txn every invoice it paid + amount.
        paid_rows: paid.map((r) => ({
          bank_ref: r.bank_ref,
          customer_name: r.customer_name,
          customer_id: r.customer_id,
          invoice_no: r.invoice_no,
          qb_id: r.qb_id,
          amount: Number(r.amount || 0),
          status: r.status,
        })),
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
      if (!['nmbnew', 'bank', 'iphone_bank', 'nmbnew_sav', 'bank_sav'].includes(channel)) {
        return res.status(400).json({ error: 'channel must be nmbnew | bank | iphone_bank | nmbnew_sav | bank_sav' });
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

  // ── POST /api/admin/backfill-frappe-markers ─────────────────────────────
  // Body: { date: "YYYY-MM-DD"|"all", channels?: ['bank','nmbnew','iphone_bank'],
  //         dry_run?: boolean, only_missing?: boolean }
  //
  // Backfills I + J markers for APRUNA-diverted (Frappe) rows on the sheet.
  // The divert code writes markers going forward (2026-07-20), but rows already
  // in consumed_transactions from prior fires have empty I/J — they LOOK like
  // orphans in the sheet. This endpoint reconciles that.
  //
  // Data source: consumed_transactions rows whose batch_id belongs to a
  // 'frappe_*' channel payment_batches row. Frappe payment_entry_id (for the
  // J value) comes from frappe_payments.name where reference_no = bank_ref.
  // Rows without a mirrored payment_entry get J = "FRAPPE_OK" fallback.
  //
  // dry_run: only reports how many I/J cells WOULD be written per channel.
  // only_missing: default true — never overwrite existing non-empty I/J values.
  app.post('/api/admin/backfill-frappe-markers', requireSecretOrJwt, async (req, res) => {
    try {
      const date = String(req.body?.date || '').trim();
      const dryRun = req.body?.dry_run === true;
      const onlyMissing = req.body?.only_missing !== false; // default true
      const wantChannels = Array.isArray(req.body?.channels) && req.body.channels.length
        ? req.body.channels : ['bank', 'nmbnew', 'iphone_bank'];
      if (!date) return res.status(400).json({ error: 'date required (YYYY-MM-DD or "all")' });

      // 1. Fetch Frappe-diverted refs for the requested date + channels.
      //    apruna-divert writes payment_batches with channel like 'frappe_*'
      //    and idempotency_key 'apruna-divert-{date}-{frappe_channel}'.
      const channelMap = {
        bank: 'frappe_crdb', nmbnew: 'frappe_nmb', iphone_bank: 'frappe_iphone',
      };
      const frappeChannels = wantChannels.map((c) => channelMap[c]).filter(Boolean);
      const dateFilter = date === 'all' ? '' : `AND pb.txn_date = $2::date`;
      const params = [frappeChannels];
      if (date !== 'all') params.push(date);
      const q = await db().query(
        `SELECT ct.bank_ref, ct.consumed_at, pb.channel AS frappe_channel, pb.txn_date
           FROM consumed_transactions ct
           JOIN payment_batches pb ON pb.id = ct.batch_id
          WHERE pb.channel = ANY($1::text[]) ${dateFilter}
          ORDER BY ct.consumed_at`,
        params,
      );
      const consumed = q.rows;
      if (consumed.length === 0) {
        return res.json({ ok: true, date, dry_run: dryRun, message: 'no diverted refs found', consumed_count: 0 });
      }

      // 2. Join with frappe_payments (reference_no = bank_ref) for payment_entry IDs.
      const bankRefs = consumed.map((r) => r.bank_ref);
      const peQ = await db().query(
        `SELECT reference_no, name AS payment_entry FROM frappe_payments
          WHERE reference_no = ANY($1::text[])`,
        [bankRefs],
      );
      const peByRef = new Map(peQ.rows.map((r) => [r.reference_no, r.payment_entry]));

      // 3. Reverse-map bank source: which UI channel + sheet each ref came from.
      const invChannel = {
        frappe_crdb: 'bank', frappe_nmb: 'nmbnew', frappe_iphone: 'iphone_bank',
      };
      const refsByChannel = new Map();
      for (const r of consumed) {
        const ch = invChannel[r.frappe_channel];
        if (!ch || !wantChannels.includes(ch)) continue;
        if (!refsByChannel.has(ch)) refsByChannel.set(ch, []);
        refsByChannel.get(ch).push({
          bank_ref: r.bank_ref,
          consumed_at: r.consumed_at,
          payment_entry: peByRef.get(r.bank_ref) || 'FRAPPE_OK',
        });
      }

      // 4. For each channel, read the sheet + build I/J updates for matched rows.
      const perChannel = [];
      for (const [ch, refs] of refsByChannel) {
        const cfg = CHANNEL_SHEETS[ch];
        if (!cfg) continue;
        const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:L200000`);
        const sheet = sheetData.values || sheetData.data || [];
        // Build ref → row-index lookup. Ref lives in Col H (idx 7).
        const rowByRef = new Map();
        for (let i = 1; i < sheet.length; i++) {
          const r = String(sheet[i][7] || '').trim();
          if (r) rowByRef.set(r, i);
        }
        const updates = [];
        const stats = {
          channel: ch, tab: cfg.tab, refs_in_frappe: refs.length,
          not_found_in_sheet: 0, already_marked: 0, will_write: 0,
          sample_writes: [], sample_not_found: [], sample_already_marked: [],
        };
        for (const r of refs) {
          const idx = rowByRef.get(r.bank_ref);
          if (idx === undefined) {
            stats.not_found_in_sheet++;
            if (stats.sample_not_found.length < 3) stats.sample_not_found.push(r.bank_ref);
            continue;
          }
          const colI = String(sheet[idx][8] || '').trim();
          const colJ = String(sheet[idx][9] || '').trim();
          if (onlyMissing && (colI || colJ)) {
            stats.already_marked++;
            if (stats.sample_already_marked.length < 3) stats.sample_already_marked.push({ ref: r.bank_ref, row: idx + 1, colI, colJ });
            continue;
          }
          const iso = new Date(r.consumed_at).toISOString();
          const iVal = `Fetched at: ${iso} (FRAPPE)`;
          const jVal = `FRAPPE:${r.payment_entry} | ${iso}`;
          updates.push({ range: `${cfg.tab}!I${idx + 1}`, value: iVal });
          updates.push({ range: `${cfg.tab}!J${idx + 1}`, value: jVal });
          stats.will_write++;
          if (stats.sample_writes.length < 5) {
            stats.sample_writes.push({ ref: r.bank_ref, row: idx + 1, I: iVal, J: jVal });
          }
        }
        // 5. Apply (unless dry_run).
        if (!dryRun && updates.length > 0) {
          const w = await writeSheetCells(cfg.sheetId, updates);
          stats.applied_cells = w.updatedCells || updates.length;
        } else {
          stats.applied_cells = 0;
        }
        perChannel.push(stats);
      }

      res.json({
        ok: true, date, dry_run: dryRun, only_missing: onlyMissing,
        total_diverted_refs: consumed.length,
        payment_entries_matched: peQ.rows.length,
        channels: perChannel,
      });
    } catch (err) {
      console.error('[backfill-frappe-markers]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/admin/heisenberg-diag ─────────────────────────────────────
  // Body: { channel, since_iso, until_iso, txn_date?, as_of? }
  //
  // DIAGNOSTIC ONLY — runs prepareAutoUpload's row-selection + skip logic
  // WITHOUT firing anything. Returns:
  //   - skip_reasons: per-row why the fire would (or wouldn't) process it
  //   - K marker: current max K row + its date
  //   - since_iso vs marker: exposes the "markerMs+1 dead zone" bug
  //   - per-row disposition: apruna_divert / qb / dropped
  //
  // Use this to prove why specific unmarked rows are skipped before writing
  // any fix. No side effects.
  app.post('/api/admin/heisenberg-diag', requireSecretOrJwt, async (req, res) => {
    try {
      const channel = String(req.body?.channel || '');
      if (!CHANNEL_SHEETS[channel]) return res.status(400).json({ error: `bad channel; need one of: ${Object.keys(CHANNEL_SHEETS).join(',')}` });
      const cfg = CHANNEL_SHEETS[channel];
      const sinceIsoStr = String(req.body?.since_iso || '');
      const untilIsoStr = String(req.body?.until_iso || '');
      const sinceIso = new Date(sinceIsoStr);
      const untilIso = new Date(untilIsoStr);
      if (isNaN(+sinceIso) || isNaN(+untilIso)) return res.status(400).json({ error: 'since_iso + until_iso required (ISO 8601)' });

      // Optional: focus_refs[] — list of bank_refs to report per-row disposition
      // for regardless of sample-cap. Lets callers prove a SPECIFIC row's fate
      // even when it's buried under thousands of other same-bucket rows (e.g.
      // 8 orphans in a skip_at_or_below_K bucket of ~40k).
      const focusRefs = Array.isArray(req.body?.focus_refs)
        ? req.body.focus_refs.map(String).map((s) => s.trim()).filter(Boolean)
        : [];
      const focusSet = new Set(focusRefs);
      const focusOut = new Map(); // ref → disposition record

      // Optional: simulate_max_k_row — pretend maxKRow is a specific value (or 0
      // to disable the K-skip entirely). Use to replay a historical fire's
      // state before subsequent K markers advanced past the target rows.
      const simulateMaxK = req.body?.simulate_max_k_row;

      const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:L200000`);
      const sheet = sheetData.values || sheetData.data || [];

      // Find maxKRow (mirrors line 5714) — but let caller override via simulate_max_k_row.
      let maxKRow = 0;
      let maxKTick = '';
      let maxKDateB = '';
      for (let i = 1; i < sheet.length; i++) {
        const k = String(sheet[i][10] || '').trim().toLowerCase();
        if (k.startsWith('end of ') && !k.includes('(dry_run)')) {
          maxKRow = i + 1;
          maxKTick = String(sheet[i][10] || '').trim();
          maxKDateB = String(sheet[i][1] || '').trim();
        }
      }
      const realMaxKRow = maxKRow;
      const realMaxKTick = maxKTick;
      const realMaxKDateB = maxKDateB;
      if (Number.isFinite(Number(simulateMaxK))) {
        maxKRow = Math.max(0, Math.floor(Number(simulateMaxK)));
      }

      // Walk every row and classify. Same order of checks as prepareAutoUpload.
      const dispositions = {
        // Fix A (2026-07-20): row-position K skip retired. Kept as an
        // informational bucket so operators can still see which
        // candidates sit above K vs below.
        above_K_row_but_not_skipped_by_position: [],
        skip_has_I_or_J: [],
        skip_has_L_qb_dup: [],
        skip_no_date: 0,
        skip_out_of_window_before: [],
        skip_out_of_window_after: [],
        included_bad_format: [],
        candidate_for_processing: [],
      };
      for (let i = 1; i < sheet.length; i++) {
        const rowNum = i + 1;
        const dCell = String(sheet[i][1] || '').trim();
        const ref = String(sheet[i][7] || '').trim();
        const amt = sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : null;
        const plate = String(sheet[i][5] || '').trim();
        const name = String(sheet[i][6] || '').trim();
        const colI = String(sheet[i][8] || '').trim();
        const colJ = String(sheet[i][9] || '').trim();
        const colL = String(sheet[i][11] || '').trim();
        const summary = { row: rowNum, ref, plate, name, amount: amt, dateB: dCell, colI, colJ, colL };

        const isFocus = ref && focusSet.has(ref);
        // Position vs maxKRow is INFORMATIONAL only (Fix A landed 2026-07-20:
        // prepareAutoUpload no longer skips by row position). Track above_K
        // count so operators can see how many candidates sit above K, but
        // don't skip. Real skip decisions come from per-row I/J/L below.
        const isAboveK = maxKRow > 0 && rowNum <= maxKRow;
        if (isAboveK) {
          if (dispositions.above_K_row_but_not_skipped_by_position.length < 30) {
            dispositions.above_K_row_but_not_skipped_by_position.push(summary);
          }
        }
        const colIReal = colI && !colI.includes('(DRY_RUN)') ? colI : '';
        const colJReal = colJ && !colJ.includes('(DRY_RUN)') ? colJ : '';
        if (colIReal || colJReal) {
          if (dispositions.skip_has_I_or_J.length < 30) dispositions.skip_has_I_or_J.push(summary);
          if (isFocus) focusOut.set(ref, { ...summary, bucket: 'skip_has_I_or_J', reason: `colI or colJ non-empty` });
          continue;
        }
        if (colL.startsWith('QB_DUPLICATE')) {
          if (dispositions.skip_has_L_qb_dup.length < 30) dispositions.skip_has_L_qb_dup.push(summary);
          if (isFocus) focusOut.set(ref, { ...summary, bucket: 'skip_has_L_qb_dup', reason: `colL starts with QB_DUPLICATE` });
          continue;
        }
        if (!dCell) {
          dispositions.skip_no_date++;
          if (isFocus) focusOut.set(ref, { ...summary, bucket: 'skip_no_date', reason: 'colB empty' });
          continue;
        }
        const ts = parseTsAny(dCell);
        if (ts && ts < sinceIso) {
          if (dispositions.skip_out_of_window_before.length < 30) dispositions.skip_out_of_window_before.push({ ...summary, ts: ts.toISOString() });
          if (isFocus) focusOut.set(ref, { ...summary, ts: ts.toISOString(), bucket: 'skip_out_of_window_before', reason: `ts ${ts.toISOString()} < since_iso ${sinceIso.toISOString()}` });
          continue;
        }
        if (ts && ts >= untilIso) {
          if (dispositions.skip_out_of_window_after.length < 30) dispositions.skip_out_of_window_after.push({ ...summary, ts: ts.toISOString() });
          if (isFocus) focusOut.set(ref, { ...summary, ts: ts.toISOString(), bucket: 'skip_out_of_window_after', reason: `ts ${ts.toISOString()} >= until_iso ${untilIso.toISOString()}` });
          continue;
        }
        if (!ts) {
          if (dispositions.included_bad_format.length < 30) dispositions.included_bad_format.push(summary);
        }
        if (dispositions.candidate_for_processing.length < 100) dispositions.candidate_for_processing.push({ ...summary, ts: ts?.toISOString() || null });
        if (isFocus) focusOut.set(ref, { ...summary, ts: ts?.toISOString() || null, bucket: ts ? 'candidate_for_processing' : 'included_bad_format', reason: 'passed all skip checks' });
      }

      // Assemble per-ref focus output preserving input order + reporting refs
      // not found at all (empty ref column or ref not in the sheet).
      const focus_report = focusRefs.map((r) => focusOut.get(r) || { ref: r, bucket: 'not_found_in_sheet', reason: 'ref not present in sheet col H' });

      res.json({
        ok: true, channel, tab: cfg.tab,
        window: { since_iso: sinceIso.toISOString(), until_iso: untilIso.toISOString() },
        max_k_marker: { row: maxKRow, tick: maxKTick, date_b: maxKDateB },
        real_max_k_marker: { row: realMaxKRow, tick: realMaxKTick, date_b: realMaxKDateB },
        simulate_max_k_row_used: Number.isFinite(Number(simulateMaxK)) ? Number(simulateMaxK) : null,
        focus_report: focusRefs.length ? focus_report : null,
        counts: {
          above_K_row_but_not_skipped_by_position: dispositions.above_K_row_but_not_skipped_by_position.length,
          skip_has_I_or_J: dispositions.skip_has_I_or_J.length,
          skip_has_L_qb_dup: dispositions.skip_has_L_qb_dup.length,
          skip_no_date: dispositions.skip_no_date,
          skip_out_of_window_before: dispositions.skip_out_of_window_before.length,
          skip_out_of_window_after: dispositions.skip_out_of_window_after.length,
          included_bad_format: dispositions.included_bad_format.length,
          candidate_for_processing: dispositions.candidate_for_processing.length,
        },
        // Truncated samples per bucket for inspection.
        samples: dispositions,
      });
    } catch (err) {
      console.error('[heisenberg-diag]', err);
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
  // SAVCOM channels — same NMB / CRDB sheets, separate tabs for the
  // SAVCOM book. Same payment algorithm, just different source rows.
  nmbnew_sav:  { sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED_SAV_NMB' },
  bank_sav:    { sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o', tab: 'PASSED_SAV' },
};

// ──────────────────────────────────────────────────────────────────────────
// Catchup planner (Frank 2026-06-14)
//
// Business-day boundary = 16:16 EAT (= 13:16 UTC). Everything 16:16→16:15:59
// of next clock-day belongs to ONE business day for portfolio/reporting.
//
// For a channel's PASSED tab, find the last "end of {tick}" K marker and
// produce the chronologically-ordered list of catchup fires needed to bring
// the channel current. Each fire is a strict (window, AS_OF, payment_date)
// tuple matching operator's rule:
//   - rows in [00:00, 16:15:59] EAT on date D → AS_OF=D, payment_date=D
//   - rows in [16:16, 23:59:59] EAT on date D → AS_OF=D, payment_date=D+1
//
// Windows with ZERO matching sheet rows are pruned (skip-the-empty rule).
// This keeps fires minimal even when a K marker is mid-afternoon and no
// real transactions exist in the orphan window.
//
// DOES NOT touch processInvoicePayments. DOES NOT fire anything by itself
// — pure read-only planner. Caller (orchestrator endpoint or operator)
// decides whether to fire each entry in the returned plan.
// ──────────────────────────────────────────────────────────────────────────
function ymdInEat(utcMs) {
  const dt = new Date(utcMs + 3 * 60 * 60 * 1000);
  return `${dt.getUTCFullYear()}-${String(dt.getUTCMonth() + 1).padStart(2, '0')}-${String(dt.getUTCDate()).padStart(2, '0')}`;
}

function eatYmdHmsToUtcMs(ymd, hh, mm, ss) {
  const [y, mo, d] = ymd.split('-').map(Number);
  return Date.UTC(y, mo - 1, d, hh - 3, mm, ss);
}

function eatDateAfter(ymd) {
  const [y, mo, d] = ymd.split('-').map(Number);
  const n = new Date(Date.UTC(y, mo - 1, d + 1));
  return `${n.getUTCFullYear()}-${String(n.getUTCMonth() + 1).padStart(2, '0')}-${String(n.getUTCDate()).padStart(2, '0')}`;
}

/**
 * computeCatchupPlan({ channel, sheet, nowUtcMs }) → { plan, marker, reason }
 *
 *   plan[i] = {
 *     kind:        'A' | 'B'            // A = business-day-D fire, B = D's tail (business-D+1)
 *     tick_label:  'catchup_<YMD>_<phase>',
 *     since_iso:   ISO (inclusive lower bound),
 *     until_iso:   ISO (exclusive upper bound — matches prepareAutoUpload semantics),
 *     as_of:       'YYYY-MM-DD',
 *     txn_date:    'YYYY-MM-DD',
 *     row_count:   number of sheet rows in this window (always > 0 — empty windows pruned),
 *   }
 *
 *   marker = { row, tick, marker_row_date_raw, marker_row_ymd_eat } | null
 *   reason = short human-readable string
 *
 * If `marker` is null (no K marker ever), plan is [] — caller fires the
 * normal window via the existing prepareAutoUpload path.
 *
 * When marker date = today EAT, the plan contains the INCREMENTAL window
 * from marker timestamp + 1ms → now (covered by the day-walk loop below).
 * Previously this case short-circuited to [], causing scheduled ticks to
 * skip incremental fires (Frank 2026-06-15 hanang0700 bug). The planner is
 * now the single source of windows for both catchup and incremental cases.
 */
// kili1615 business-day resolver — the business day (for QB TxnDate assignment)
// is the EAT calendar date shifted forward one day when now is at or after
// 16:15 EAT. So [16:15 EAT day-1, 16:15 EAT day) all book to `day`.
//
// Frank 2026-07-20 (definitive rule): AS_OF stays as the row's kili day (for
// invoice allocation), but TxnDate (QB) / posting_date (Frappe) tracks the
// PROCESSING WINDOW — the kili day of when we FIRE. This decouples the two:
// as_of picks the right invoices; txn_date lands the payment in the current
// open accounting period, protecting closed-book periods from late fires.
function kiliBusinessDayFromUtcMs(utcMs) {
  const KILI_MIN = 16 * 60 + 15;
  const eat = new Date(utcMs + 3 * 3600 * 1000);
  const totalMin = eat.getUTCHours() * 60 + eat.getUTCMinutes();
  const shifted = totalMin < KILI_MIN ? eat : new Date(eat.getTime() + 86400000);
  return shifted.toISOString().slice(0, 10);
}

export function computeCatchupPlan({ channel, sheet, nowUtcMs }) {
  // ── 1. Find last K marker (= last "end of {tick}" line in column K) ──
  let maxKRow = -1;
  let maxKTick = '';
  for (let i = 1; i < sheet.length; i++) {
    const k = String(sheet[i][10] || '').trim().toLowerCase();
    if (k.startsWith('end of ') && !k.includes('(dry_run)')) {
      maxKRow = i;
      maxKTick = String(sheet[i][10] || '').trim();
    }
  }
  if (maxKRow < 0) return { plan: [], marker: null, reason: 'no K marker — initial state; caller fires the normal window' };

  // ── 2. Parse the marker row's transaction time ──
  const markerRowB = sheet[maxKRow][1];
  const markerDate = parseTsAny(markerRowB);
  if (!markerDate) {
    return {
      plan: [],
      marker: { row: maxKRow + 1, tick: maxKTick, marker_row_date_raw: markerRowB || null, marker_row_ymd_eat: null },
      reason: `K marker row date unparseable: "${markerRowB}"; caller must intervene`,
    };
  }
  const markerMs = markerDate.getTime();
  const markerYmdEat = ymdInEat(markerMs);
  const nowYmdEat = ymdInEat(nowUtcMs);

  const markerSummary = {
    row: maxKRow + 1,
    tick: maxKTick,
    marker_row_date_raw: String(markerRowB || '').trim(),
    marker_row_ymd_eat: markerYmdEat,
  };

  // Frank 2026-06-15: do NOT short-circuit when marker date = today.
  // The day-walk loop below correctly produces the incremental window
  // (marker_ms + 1 → now) when dates = [today]. The previous short-circuit
  // here caused scheduled ticks (hanang0700 et al.) to skip firing
  // payments for transactions added between meru0300 and the current tick.

  // ── 3. Pre-parse every row BELOW the K marker so we can count fast ──
  // Below-marker rows that fail parseTsAny are excluded from window counts
  // (prepareAutoUpload would also exclude them via receivedTimestamp=null
  // bad-format inclusion, but for plan visibility we don't count them).
  const tsBelow = [];
  for (let i = maxKRow + 1; i < sheet.length; i++) {
    const ts = parseTsAny(sheet[i][1]);
    if (!ts) continue;
    tsBelow.push(ts.getTime());
  }
  const countRows = (loInc, hiExc) => {
    let c = 0;
    for (const t of tsBelow) if (t >= loInc && t < hiExc) c++;
    return c;
  };

  // ── 4. Build the ordered list of EAT dates to plan windows for ──
  //
  // Fix B3 (Frank 2026-07-20): the old code walked ONLY forward from
  // markerYmdEat → nowYmdEat, missing rows physically appended BELOW K
  // with sheet-dates from PRIOR business days (bank posts late, puller
  // strict-appends, but the row's txn-date is old). Those rows were
  // skipped as `skippedOutOfWindow` on every subsequent scheduled fire
  // and never recovered because no plan window ever covered their date.
  //
  // New behavior: take EVERY unique EAT date present in below-K rows,
  // UNION with markerYmdEat → nowYmdEat walk (preserves the "fire the
  // current day even if it has zero rows" habit some downstream watchers
  // relied on), sort ascending so retro windows fire OLDEST FIRST — the
  // chronological order matters for the retro-reconciler's void-and-replay
  // logic.
  //
  // Cap dates at nowYmdEat so a bogus future-date row (bank posted with
  // wrong date) doesn't create a plan window in the future.
  const datesSeen = new Set();
  for (const t of tsBelow) {
    const dEat = ymdInEat(t);
    if (dEat <= nowYmdEat) datesSeen.add(dEat);
  }
  let cur = markerYmdEat;
  while (cur <= nowYmdEat) { datesSeen.add(cur); cur = eatDateAfter(cur); }
  const dates = [...datesSeen].sort();

  // Frank 2026-07-20 (definitive): txn_date = firing window's kili day (NOT
  // row's kili day). All windows in one fire share the SAME txn_date =
  // kili day of nowUtcMs. Only as_of varies per window (row's kili day).
  const fireTxnDate = kiliBusinessDayFromUtcMs(nowUtcMs);

  const plan = [];
  for (let di = 0; di < dates.length; di++) {
    const D = dates[di];
    const isFirstD = (di === 0);
    const isLastD = (di === dates.length - 1);

    // Sub-window A: business-day-D portion → [00:00 EAT D, 16:16 EAT D)
    // Fix B (Frank 2026-07-20): first-day lower bound WAS markerMs + 1 which
    // opened a dead zone for rows that arrived at POC AFTER the fire wrote K
    // but with timestamps BEFORE K's own timestamp — 5 orphans on 2026-07-19
    // (rows 37512-37516 in the 6m 39s gap between mawenzi1400 and kili1615:
    // business). Widened to start-of-day EAT for both isFirstD and later days.
    // consumed_transactions + external_consumed_refs + QB-preflight-dedupe
    // still block genuine dupes downstream. TxnDate invariant preserved:
    // window still stops at 16:16 EAT so every row in sub-window A has
    // derived TxnDate = D (< 16:15 = kili rule keeps physical day).
    const aLoInc = eatYmdHmsToUtcMs(D, 0, 0, 0);
    const aHiExc = Math.min(
      eatYmdHmsToUtcMs(D, 16, 16, 0),   // 16:16:00 EAT D (exclusive)
      isLastD ? nowUtcMs + 1 : Number.MAX_SAFE_INTEGER, // never plan beyond now
    );
    if (aLoInc < aHiExc) {
      const c = countRows(aLoInc, aHiExc);
      if (c > 0) {
        plan.push({
          kind: 'A',
          tick_label: `catchup_${D}_business_${D}`,
          since_iso: new Date(aLoInc).toISOString(),
          until_iso: new Date(aHiExc).toISOString(),
          as_of: D,
          txn_date: fireTxnDate, // Frank rule: TxnDate = firing kili day, not row's
          row_count: c,
        });
      }
    }

    // Sub-window B: business-day-(D+1) tail of D → [16:16:00 EAT D, 00:00:00 EAT D+1)
    // Fix B applied to sub-window B too: drop markerMs+1 lower bound (was
    // dead-zoning rows appended below K with ts in 16:16-K-time). Rows in
    // this window have derived TxnDate = D+1 (>= 16:15 = kili rule rolls day).
    const bLoInc = eatYmdHmsToUtcMs(D, 16, 16, 0);
    const bHiExc = Math.min(
      eatYmdHmsToUtcMs(eatDateAfter(D), 0, 0, 0), // 24:00:00 EAT D = 00:00:00 EAT D+1
      isLastD ? nowUtcMs + 1 : Number.MAX_SAFE_INTEGER,
    );
    if (bLoInc < bHiExc) {
      const c = countRows(bLoInc, bHiExc);
      if (c > 0) {
        plan.push({
          kind: 'B',
          tick_label: `catchup_${D}_tail_to_${eatDateAfter(D)}`,
          since_iso: new Date(bLoInc).toISOString(),
          until_iso: new Date(bHiExc).toISOString(),
          as_of: D,
          txn_date: fireTxnDate, // Frank rule: TxnDate = firing kili day, not row's
          row_count: c,
        });
      }
    }
  }

  return {
    plan,
    marker: markerSummary,
    reason: `${plan.length} non-empty window(s) across ${dates.length} day(s) from marker ${markerYmdEat} → today ${nowYmdEat}`,
  };
}


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
  // OLDEST-first transaction order — verbatim from invoice-payment-app.
  // (Briefly flipped to newest-first 2026-06-14 in commit a5007b9 when a
  // 1/359 divergence looked like a sort issue; turned out to be the
  // QB_DUPLICATE Column L marker correctly filtering out an already-
  // pushed ref. Reverted — sacred algorithm restored to original.)
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

// In-process cache for the heavy QB Payment+CreditMemo scan. The scan
// itself is identical regardless of wanted refs, so caching the FULL
// PrivateNote → info Map lets 3-channel fires within the same window
// share one ~30-60s QB scan. Cleared automatically after 5 min.
const _qbScanCache = { hits: null, expires: 0, daysBack: 0 };
const QB_SCAN_TTL_MS = 5 * 60_000;

// Scan QB for any of the supplied suffixed bank_refs that already exist as
// Payment OR CreditMemo PrivateNotes within the last `daysBack` days.
//
// CRITICAL (Frank 2026-06-07): match BOTH the bare ref AND the
// channel-suffixed form. Manual QB entries (typed directly by operator)
// have NO suffix; SaasAnt + BRAIN entries DO. We need to catch both.
//
// wantedBareRefs: bare bank refs straight from the sheet (no suffix)
// channelSuffix:  'N' | 'B' | 'P' | '' (the channel's letter)
// Returns Map<bare_ref, { qb_id, qb_kind, customer_id, txn_date, matched_form }>.
//   matched_form = 'bare' | 'suffixed' (which form QB had it in)
//
// Used by prepareAutoUpload's dup-check step.
async function scanQbForRefDuplicates(wantedBareRefs, channelSuffix, daysBack = 60) {
  if (!wantedBareRefs || wantedBareRefs.length === 0) return new Map();

  // CACHE PATH: the QB scan is identical no matter the wanted set. We cache
  // the FULL PrivateNote → info Map and filter per-caller. 3-channel fires
  // within 5 min share one ~30-60s QB scan. 38× speedup on a meru0300 cycle.
  let allHits;
  if (_qbScanCache.hits && _qbScanCache.expires > Date.now() && _qbScanCache.daysBack === daysBack) {
    allHits = _qbScanCache.hits;
  } else {
    allHits = new Map(); // PrivateNote → info (any non-voided Payment/CreditMemo TxnDate >= cutoff)
    const fromDate = new Date(Date.now() - daysBack * 24 * 60 * 60_000).toISOString().slice(0, 10);
    for (const kind of ['Payment', 'CreditMemo']) {
      let start = 1;
      const PAGE = 1000;
      while (start < 200_000) {
        const sql =
          `SELECT Id, PrivateNote, TotalAmt, TxnDate, CustomerRef FROM ${kind} ` +
          `WHERE TxnDate >= '${fromDate}' ` +
          `STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        const r = await qbQuery(sql);
        const rows = r.QueryResponse?.[kind] || [];
        if (!rows.length) break;
        for (const row of rows) {
          const pn = String(row.PrivateNote || '').trim();
          if (!pn) continue;
          // Skip voided rows (TotalAmt=0 typically means a voided Payment in QB).
          if (kind === 'Payment' && Number(row.TotalAmt || 0) === 0) continue;
          allHits.set(pn, {
            qb_id: String(row.Id),
            qb_kind: kind === 'CreditMemo' ? 'credit_memo' : 'payment',
            customer_id: String(row.CustomerRef?.value || ''),
            txn_date: row.TxnDate || null,
          });
        }
        if (rows.length < PAGE) break;
        start += PAGE;
      }
    }
    _qbScanCache.hits = allHits;
    _qbScanCache.expires = Date.now() + QB_SCAN_TTL_MS;
    _qbScanCache.daysBack = daysBack;
  }

  // Per-caller filter: only keep refs the caller actually wanted, matched
  // against the bare OR suffixed form.
  const hits = new Map();
  for (const r of wantedBareRefs) {
    const bareInfo = allHits.get(r);
    if (bareInfo) { hits.set(r, { ...bareInfo, matched_form: 'bare' }); continue; }
    if (channelSuffix) {
      const sufInfo = allHits.get(r + channelSuffix);
      if (sufInfo) hits.set(r, { ...sufInfo, matched_form: 'suffixed' });
    }
  }
  return hits;
}

// Append one structured log entry to a batch's logs[] jsonb column.
// Fire-and-forget — failures don't block the upload (logged to console).
// Frank uses this trail to debug after-the-fact via the batch detail page.
//
// level: "info" | "warn" | "error"
// source: short string identifying the code path (e.g. "qb-push", "dup-check")
// extra: optional object merged into the log entry for structured fields
async function logBatch(batchId, level, message, source, extra = null) {
  if (!batchId) return;
  try {
    const entry = {
      ts: new Date().toISOString(),
      level,
      message: String(message || '').slice(0, 2000),
      source,
      ...(extra && typeof extra === 'object' ? extra : {}),
    };
    await db().query(
      `UPDATE payment_batches
          SET logs = COALESCE(logs, '[]'::jsonb) || $1::jsonb
        WHERE id = $2`,
      [JSON.stringify(entry), batchId],
    );
  } catch (e) {
    console.error('[logBatch] non-fatal write fail:', e.message);
  }
}

// In-process cache for /arrears — same per-channel meru0300 cycle hits
// this 6 times with identical AS_OF; one fetch then reuse for 5 min.
// Each fetch pages ~12k QB invoices ~15-25s.
const _arrearsCache = new Map(); // asOf → { rows, expires }
const ARREARS_TTL_MS = 5 * 60_000;

async function fetchAllArrears(asOf) {
  const cacheKey = String(asOf || 'NONE');
  const cached = _arrearsCache.get(cacheKey);
  if (cached && cached.expires > Date.now()) return cached.rows;

  const { default: fetchImpl } = { default: globalThis.fetch };
  const base = process.env.SELF_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
  const arrears = [];
  let start = 1;
  const asOfParam = asOf ? `&asOf=${encodeURIComponent(asOf)}` : '';

  // Frank 2026-06-08: QB intermittently returns 500 "Request timeout 30000ms"
  // on specific page boundaries (we saw page 4000 die while 1-3000 + 5000+
  // were healthy). Cause is QB's internal query timeout on that chunk —
  // happens when one customer/invoice in the page triggers a slow lookup.
  //
  // Strategy: retry the SAME page up to 3 times. If still failing, HALVE
  // the pageSize and continue. A 1000-row page that fails will split into
  // two 500-row pages; if those still fail, two 250-row pages each, etc.
  // Bottom floor is 50 rows per call. This trades one slow QB invocation
  // for several fast ones — net same wall time, but completes vs throws.
  while (true) {
    let pageSize = 1000;
    let invs = null;
    let nextStart = null;
    let lastErr = null;
    while (pageSize >= 50) {
      let success = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const r = await fetchImpl(`${base}/arrears?pageSize=${pageSize}&start=${start}${asOfParam}`);
          if (r.ok) {
            const j = await r.json();
            invs = j.invoices || [];
            nextStart = j.page?.nextStart || null;
            success = true;
            if (pageSize < 1000) {
              console.warn(`[fetchAllArrears] start=${start} succeeded at pageSize=${pageSize} (after halving)`);
            }
            break;
          }
          lastErr = `${r.status}: ${(await r.text()).slice(0, 200)}`;
          // 5xx → retry. 4xx → throw immediately (auth/bad-request bugs).
          if (r.status < 500) throw new Error(`arrears ${lastErr}`);
          console.warn(`[fetchAllArrears] start=${start} pageSize=${pageSize} attempt ${attempt}/3 got ${r.status}, retrying`);
          await new Promise((res) => setTimeout(res, 1500 * attempt));
        } catch (e) {
          lastErr = String(e.message || e);
          if (attempt === 3) break;
          console.warn(`[fetchAllArrears] start=${start} pageSize=${pageSize} attempt ${attempt}/3 threw: ${lastErr.slice(0, 120)}`);
          await new Promise((res) => setTimeout(res, 1500 * attempt));
        }
      }
      if (success) break;
      // 3 attempts at this pageSize failed — halve and try again.
      pageSize = Math.max(50, Math.floor(pageSize / 2));
      if (pageSize < 50) break;
      console.warn(`[fetchAllArrears] start=${start} 3 attempts failed at pageSize=${pageSize * 2}, halving to ${pageSize}`);
    }
    if (invs === null) {
      throw new Error(`arrears irrecoverable at start=${start}: ${lastErr || 'unknown'}`);
    }
    if (!invs.length) break;
    arrears.push(...invs);
    if (!nextStart) break;
    start = nextStart;
  }
  _arrearsCache.set(cacheKey, { rows: arrears, expires: Date.now() + ARREARS_TTL_MS });
  if (_arrearsCache.size > 4) {
    const oldest = [...(_arrearsCache.entries())].sort((a, b) => a[1].expires - b[1].expires)[0];
    if (oldest) _arrearsCache.delete(oldest[0]);
  }
  return arrears;
}

// Persist the QB Open-Invoices snapshot that batch <X> was built against.
// Always-on (no toggle). Dedupes by (as_of, captured_at) so 3-channel tick
// fires for the same AS_OF share one row instead of writing 3× ~2MB of jsonb.
//
// We REUSE the `arrears` array prepareAutoUpload already fetched — zero extra
// QB load. The trade-off: snapshot reflects whatever /arrears returns at that
// instant. That's exactly the universe the upload allocated against, which
// is what we want for audit (operator: "show me the invoice list this batch
// chose to apply payments to").
//
// Cache window: 30 min. A tick that fires meru0300 across 3 channels within
// 30 min picks up the same snapshot id. After 30 min we assume the operator's
// triggering a new cycle and want a fresh list.
async function captureInvoiceSnapshot(asOf, arrears) {
  if (!asOf) return null;
  const recent = await db().query(
    `SELECT id FROM invoice_snapshots
      WHERE as_of = $1 AND captured_at > now() - interval '30 minutes'
      ORDER BY captured_at DESC LIMIT 1`,
    [asOf],
  );
  if (recent.rows.length) return recent.rows[0].id;

  // Trim to the .xls-shaped fields (drop branch + customerLeaf — derivable).
  const data = (arrears || []).map((r) => ({
    qbId: r.qbId, date: r.date, dueDate: r.dueDate,
    no: r.no, customer: r.customer, memo: r.memo || '',
    balance: Number(r.balance) || 0, amount: Number(r.amount) || 0,
    status: r.status || 'overdue',
  }));
  const totalBalance = data.reduce((s, r) => s + r.balance, 0);
  // Header line matches Frank's QB-export sample:
  //   "Type: Invoices Status: Open Delivery Method: Any Date: <from> - <asOf>"
  const dates = data.map((r) => r.date).filter(Boolean).sort();
  const fromDate = dates[0] || `${String(asOf).slice(0, 4)}-01-01`;
  const header = `Type: Invoices Status: Open Delivery Method: Any Date: ${fromDate} - ${asOf}`;

  const ins = await db().query(
    `INSERT INTO invoice_snapshots
       (as_of, invoice_count, total_balance, data, date_range_header)
     VALUES ($1,$2,$3,$4,$5) RETURNING id`,
    [asOf, data.length, round2(totalBalance), JSON.stringify(data), header],
  );
  return ins.rows[0].id;
}

async function prepareAutoUpload({ channel, sinceIso, untilIso, asOf, qbPreflightDedup, tickName, txnDate, forceSkipMaxKRow, dryRun = false }) {
  // SAV channels (bank_sav, nmbnew_sav) route to SAVCOM/Frappe — payments
  // NEVER hit QB. Skip QB preflight dedup entirely: it would query QB with
  // SAV customer IDs and (a) waste time (b) fail if any ID isn't a QB
  // customer number (which is common for SAV cohort). Frank 2026-07-20:
  // bank_sav preflight aborted 31 payments today with "Invalid ID" for this
  // exact reason. The SAV path has its own dedup via consumed_transactions
  // and the SAVCOM idempotency layer downstream.
  if (channel === 'bank_sav' || channel === 'nmbnew_sav') {
    qbPreflightDedup = null;
  }
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
  // Column L holds "QB_DUPLICATE <qb_id>" markers when the dup-check
  // discovered a ref already in QB (SaasAnt / manual processor / prior
  // BRAIN run). Read A:L so the skip logic can honor those too.
  const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:L200000`);
  const sheet = sheetData.values || sheetData.data || [];
  // Find the highest row index whose Column K holds a BRAIN end-of-tick
  // marker. Only values that start with "end of " are treated as
  // boundaries — that's BRAIN's exact write format from paintRowEndMarker
  // ("end of meru0300" / "end of heisenberg" / etc). Other stray K data
  // (legacy operator notes, accidental text) is ignored so it can't
  // wedge the entire sheet.
  let maxKRow = 0;
  // Frank 2026-07-01: force_skip_max_k_row lets recall replays fire specific
  // windows whose rows sit below a newer end-of-tick K marker written by a
  // fresh batch. Only used by explicit operator recall path; per-row I/J/L
  // checks below still apply so unrelated rows aren't touched.
  if (!forceSkipMaxKRow) {
    for (let i = 1; i < sheet.length; i++) {
      const colK = String(sheet[i][10] || '').trim().toLowerCase();
      // Ignore "(dry_run)" markers — those are provisional from a dry-run
      // preview, not real boundaries. They get cleared by the Erase button.
      if (colK.startsWith('end of ') && !colK.includes('(dry_run)')) maxKRow = i + 1; // 1-based row number
    }
  }
  const txns = [];
  let skippedNoDate = 0, skippedOutOfWindow = 0, skippedBadFormat = 0, skippedAlreadyPushed = 0;
  // Renamed semantics 2026-06-07: bad-format rows are no longer skipped —
  // they're INCLUDED with receivedTimestamp=null. We keep skippedBadFormat
  // for backwards-compat with callers reading the response (always 0 now).
  let includedBadFormat = 0;
  for (let i = 1; i < sheet.length; i++) {
    // Fix A (Frank 2026-07-20): the "at or below K" position skip has been
    // REMOVED. It relied on the append-only rule which the puller violates
    // occasionally (manual pastes / puller race), causing 3 orphans on
    // 2026-07-19 (rows 37401 SULTANI, 37403 SIMON, 37407 NAMANI). Per-row
    // I / J / L markers are now the sole "already processed" signal — they
    // survive puller reorderings and are per-row precise. Genuine dupes are
    // caught downstream by consumed_transactions + external_consumed_refs
    // + QB preflight (all check by bank_ref, not sheet position).
    //
    // Row-position K skip removed; K remains as a fire-boundary marker
    // for the planner's own use (computeCatchupPlan reads it to plan
    // sub-windows) but no longer as a "silently skip everything above me"
    // gate at row-selection time.
    //
    // Payment-date invariant preserved: this fix does not touch window
    // bounds. Rows still get filtered by [winStart, winEnd) below, which
    // computeCatchupPlan guarantees straddle the kili1615 rule correctly
    // so every accepted row's derived TxnDate matches the fire's TxnDate.
    const colI = String(sheet[i][8] || '').trim();
    const colJ = String(sheet[i][9] || '').trim();
    const colL = String(sheet[i][11] || '').trim();
    // Dry-run markers ("(DRY_RUN)" suffix) are provisional — ignore them
    // so a dry-run preview doesn't lock rows from the next real upload.
    const colIReal = colI && !colI.includes('(DRY_RUN)') ? colI : '';
    const colJReal = colJ && !colJ.includes('(DRY_RUN)') ? colJ : '';
    if (colIReal || colJReal) { skippedAlreadyPushed++; continue; }
    // Column L = "QB_DUPLICATE <qb_id>" → ref is already in QB (came in
    // via SaasAnt / manual processor / prior BRAIN). Skip without
    // re-querying — the dup-check already added it to external_consumed_refs.
    if (colL.startsWith('QB_DUPLICATE')) { skippedAlreadyPushed++; continue; }
    const dCell = String(sheet[i][1] || '').trim();
    if (!dCell) { skippedNoDate++; continue; }
    const ts = parseTsAny(dCell);
    // Bad-format dates (e.g. "20.26.2026" OCR errors): INCLUDE with
    // receivedTimestamp=null per the design rule. Operator OCR errors
    // shouldn't lose transactions silently. Bumped to includedBadFormat
    // counter for reporting so the operator sees how many rows fell back.
    // (Empty dates are still skipped — that's the operator's deliberate
    // skip-flag for multi-plate rows, which is a different intent.)
    // STRICT window: enforce both lower AND upper bound (Frank 2026-06-07,
    // CASTOR parity). Without the lower-bound check BRAIN was picking up
    // rows with very old bank dates (e.g. MAR 2026 FTM refs) that the
    // operator's window didn't intend. CASTOR uses operator's CSV which
    // only includes rows in the chosen window — BRAIN now matches.
    if (ts && (ts < winStart || ts >= winEnd)) { skippedOutOfWindow++; continue; }
    if (!ts) includedBadFormat++;
    txns.push({
      id: sheet[i][0] || `tx-${i + 1}`, channel,
      customerPhone: sheet[i][5] || null, customerName: sheet[i][6] || null, contractName: sheet[i][6] || null,
      amount: sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : null,
      receivedTimestamp: ts ? ts.getTime() : null, transactionId: sheet[i][7] || null,
      // Phase 2: track the actual Google Sheets row number (1-based) so we can
      // write Column I + J back to the right row after processing.
      sheet_row_number: i + 1,
    });
  }
  // APRUNA divert (Frank 2026-07-17): route sender-blacklisted rows to Frappe
  // BEFORE they hit the QB path. Any txn matched to the APRUNA roster (by
  // plate/phone) is pushed to Frappe with sacred-rule allocations and its
  // bank_ref inserted into consumed_transactions. Non-matched rows continue
  // through the existing QB flow unchanged.
  //
  // Feature-flagged via APRUNA_DIVERT_ENABLED env var. Off by default. If any
  // step throws (roster fetch, single-txn push), the offending txn falls
  // through to the QB path — status quo, worst case it lands in FAILED and
  // needs the backfill script.
  try {
    const { divertAprunaTxns } = await import('./apruna-divert.js');
    // Pass the plan-window txnDate so Frappe posting_date matches the row's
    // kili business day (D for sub-window A, D+1 for sub-window B).
    const divert = await divertAprunaTxns(txns, { channel, sheetId: cfg.sheetId, tab: cfg.tab, tickName, txnDate });
    if (divert && Array.isArray(divert.qbTxns)) {
      txns.length = 0; txns.push(...divert.qbTxns);
    }
  } catch (err) {
    console.error(`[apruna-divert] top-level failure — falling through, all txns go to QB: ${err.message}`);
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
  let txnsClean = txns.filter((t) => !forbidden.has(appendSuf(t.transactionId, channel)));
  if (txnsClean.length === 0) return { skipped: true, reason: 'all refs already consumed' };

  // 2b. QB dup-check (Frank 2026-06-07): scan QB Payments + CreditMemos
  // for any ref already pushed from SaasAnt / CASTOR manual processor /
  // manual QB entry / prior BRAIN run whose consumed_transactions got
  // cleaned up. Match is EITHER the bare ref OR the channel-suffixed
  // form — manual QB entries usually have NO suffix, while SaasAnt +
  // BRAIN entries DO. The helper handles both.
  // Hits get:
  //   - persisted to external_consumed_refs (future fires skip without
  //     hitting QB again — stored in the SUFFIXED form so the existing
  //     consumed_transactions / external_consumed_refs check at L4527
  //     picks them up via the same allRefs key)
  //   - sheet row painted GREY + Column L = "QB_DUPLICATE <qb_id>"
  //   - excluded from this batch
  // If ALL refs in the window turn out to be QB dups, we skip the batch
  // entirely (no Payment created, no consumed_transactions inserted) —
  // the next window (e.g. meru0300's window 2) fires normally.
  try {
    const wantedBareRefs = txnsClean.map((t) => t.transactionId).filter(Boolean);
    const chSuffix = suffixOf(channel);
    const qbDupHits = await scanQbForRefDuplicates(wantedBareRefs, chSuffix, 60);
    if (qbDupHits.size > 0) {
      const dupRowMap = new Map();
      for (const t of txnsClean) {
        const bareRef = t.transactionId;
        const hit = qbDupHits.get(bareRef);
        if (!hit) continue;
        if (t.sheet_row_number) dupRowMap.set(t.sheet_row_number, hit.qb_id);
        // Store the SUFFIXED form in external_consumed_refs so the upstream
        // consumed_transactions / external_consumed_refs filter picks it up
        // on the next fire without needing another QB query.
        const sref = appendSuf(bareRef, channel);
        await db().query(
          `INSERT INTO external_consumed_refs (bank_ref, customer_id, qb_id, qb_kind, qb_txn_date, found_by)
           VALUES ($1, $2, $3, $4, $5, $6)
           ON CONFLICT (bank_ref, customer_id) DO NOTHING`,
          [sref, hit.customer_id || 'unknown', hit.qb_id, hit.qb_kind, hit.txn_date || null, `auto-upload-${channel}-dup-check:${hit.matched_form}`],
        );
      }
      if (dupRowMap.size > 0 && cfg.sheetId && cfg.tab) {
        try {
          await markSheetRowsAsQbDuplicate(cfg.sheetId, cfg.tab, dupRowMap);
          const bareCnt = [...qbDupHits.values()].filter((h) => h.matched_form === 'bare').length;
          const sufCnt = [...qbDupHits.values()].filter((h) => h.matched_form === 'suffixed').length;
          console.log(`[qb-dup-check] ${channel}: ${dupRowMap.size} rows grey (${bareCnt} bare-match = manual, ${sufCnt} suffixed-match = SaasAnt/BRAIN)`);
        } catch (e) {
          console.error('[qb-dup-check] sheet marking failed (non-fatal):', e.message);
        }
      }
      txnsClean = txnsClean.filter((t) => !qbDupHits.has(t.transactionId));
      if (txnsClean.length === 0) {
        return {
          skipped: true,
          reason: `all ${qbDupHits.size} refs already in QB — marked grey + persisted`,
          qb_duplicates: qbDupHits.size,
        };
      }
    }
  } catch (err) {
    // Non-fatal — if QB is unreachable, we proceed with the normal flow.
    // consumed_transactions still protects against BRAIN's own re-pushes;
    // the qbPreflightDedup later in the pipeline is the next safety net.
    console.error('[qb-dup-check] scan failed (non-fatal, continuing):', err.message);
  }

  // 2c. Auto-trigger retro-reconcile for late txns (Frank 2026-07-19).
  // A txn is "late" when its physical EAT day precedes the fire's AS_OF day.
  // Physical day < asOf means the row belongs to a business day the fire
  // is not currently owning → we need to void any subsequent payments for
  // that same customer, clear their consumed_transactions, and let the
  // normal allocation re-run.
  //
  // Speed fix (Frank 2026-07-20): the previous version compared physical
  // day against `txnDate` which, in sub-window B (kili tail), equals D+1
  // while physical = D. That flagged EVERY txn as "late" and reconciled
  // hundreds of customers unnecessarily, adding 10-15 min to each fire.
  // Comparing against `asOf` (which does NOT roll with kili) correctly
  // ignores same-business-day txns that just kili-rolled their TxnDate.
  //
  // Fires for BOTH tick auto-uploads AND heisenberg fires — the trigger
  // is DATA-driven (physical day < as_of), not fire-type driven.
  let replayTxnDateByRef = null;
  try {
    const { reconcileCustomer, eatDayOf } = await import('./late-txn-reconciler.js');
    // 2026-07-22 fix: compare against the day the fire is RUNNING, not asOf.
    // Catch-up/heisenberg windows pin asOf to the row's own day, so the old
    // `physical < asOf` trigger could never fire in the recovery flow —
    // which is exactly where retro rows arrive. Result: zero voids ever.
    const fireDay = eatDayOf(new Date());
    const lateByCustomer = new Map();
    for (const t of txnsClean) {
      const ts = t.receivedTimestamp;
      if (!ts) continue;
      const txnDay = eatDayOf(ts);
      if (txnDay >= fireDay) continue;
      const customer = t.customerName || t.contractName || null;
      if (!customer) continue;
      const cur = lateByCustomer.get(customer);
      if (!cur || txnDay < cur) lateByCustomer.set(customer, txnDay);
    }
    // One batched pre-filter keeps overnight-tail fires fast (the old
    // asOf comparison existed because per-customer reconciles added
    // 10-15 min): only customers who actually have created payments
    // uploaded AFTER their late day go through void-and-replay.
    let toReconcile = [];
    if (lateByCustomer.size > 0) {
      const names = [...lateByCustomer.keys()];
      const q = await db().query(
        `SELECT customer_name,
                max((created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date::text) AS max_day
           FROM payment_uploads
          WHERE status = 'created' AND customer_name = ANY($1::text[])
          GROUP BY customer_name`,
        [names],
      );
      const maxDayBy = new Map(q.rows.map((r) => [r.customer_name, r.max_day]));
      toReconcile = names.filter((n) => (maxDayBy.get(n) || '') > lateByCustomer.get(n));
    }
    if (toReconcile.length > 0) {
      console.log(`[retro-reconcile] ${toReconcile.length}/${lateByCustomer.size} late-txn customer(s) have downstream payments to void (fireDay=${fireDay}${dryRun ? ', DRY RUN — no voids' : ''})`);
      const replayRefs = new Set();
      for (const customer of toReconcile) {
        const oldestDay = lateByCustomer.get(customer);
        try {
          // dryRun MUST flow through: a dry-run fire that voids real QB
          // payments (but never replays them) would strand the customer's
          // ledger — that was a live landmine until 2026-07-23.
          const r = await reconcileCustomer({ customerName: customer, sinceDay: oldestDay, dryRun });
          if (dryRun) {
            console.log(`[retro-reconcile] DRY RUN ${customer} since ${oldestDay}: would void ${r.affected_count} payment row(s)`);
            continue;
          }
          const okVoids = (r.void_results || []).filter((v) => v.ok).length;
          const failed = r.void_failures?.length || 0;
          for (const ref of r.ready_to_replay_refs || []) replayRefs.add(ref);
          console.log(`[retro-reconcile] ${customer} since ${oldestDay}: voided=${okVoids} failed=${failed} consumed_cleared=${r.consumed_rows_deleted} replay_refs=${(r.ready_to_replay_refs || []).length}`);
        } catch (err) {
          console.error(`[retro-reconcile] failed for ${customer}: ${err.message}`);
        }
      }
      // Same-fire replay (2026-07-23): the refs we just released were
      // filtered out of txnsClean by the consumed check at selection time.
      // Re-add their rows NOW so this very fire replays them in sheet
      // order — "next fire will pick them up" is a lie for old rows, whose
      // sheet timestamps fall outside every scheduled tick's window (the
      // noon 07-23 reconciles voided 244k TZS that nothing ever replayed).
      if (replayRefs.size > 0) {
        const cleanKeys = new Set(txnsClean.map((t) => appendSuf(t.transactionId, channel)));
        const readd = txns.filter((t) => {
          const suf = appendSuf(t.transactionId, channel);
          return replayRefs.has(suf) && !cleanKeys.has(suf);
        });
        if (readd.length) {
          txnsClean = txns.filter((t) => {
            const suf = appendSuf(t.transactionId, channel);
            return cleanKeys.has(suf) || replayRefs.has(suf);
          });
          console.log(`[retro-reconcile] re-added ${readd.length} released row(s) to this fire for same-fire replay`);
        }
        const inWindow = new Set(txns.map((t) => appendSuf(t.transactionId, channel)));
        const orphans = [...replayRefs].filter((r) => !inWindow.has(r));
        if (orphans.length) {
          console.error(`[retro-reconcile] REPLAY ORPHANS: ${orphans.length} released ref(s) OUTSIDE this window — fire a manual window covering them or they stay unpaid: ${orphans.join(',')}`);
        }
        // Frank 2026-07-23: replayed payments must keep their ORIGINAL
        // TxnDate — reposting a voided 07-22 payment dated today inflates
        // today's collections and drains the original day's ledger. Only
        // the late row itself gets the firing day (e151d0b rule). Map each
        // released ref to its earliest voided generation's batch txn_date;
        // the pusher stamps per-ref dates from this map.
        try {
          const dq = await db().query(
            `SELECT v.bank_ref, min(b.txn_date::date)::text AS orig
               FROM payment_uploads v JOIN payment_batches b ON b.id = v.batch_id
              WHERE v.bank_ref = ANY($1::text[]) AND v.status = 'voided'
              GROUP BY v.bank_ref`,
            [[...replayRefs]],
          );
          replayTxnDateByRef = {};
          for (const row of dq.rows) replayTxnDateByRef[row.bank_ref] = row.orig;
          console.log(`[retro-reconcile] replay TxnDate map: ${dq.rows.map((r) => `${r.bank_ref}→${r.orig}`).join(', ')}`);
        } catch (err) {
          console.error(`[retro-reconcile] replay TxnDate map failed (replays will use fire txnDate — patch after via /api/admin/patch-batch-txndate): ${err.message}`);
        }
      }
    } else if (lateByCustomer.size > 0) {
      console.log(`[retro-reconcile] ${lateByCustomer.size} late txn(s) detected, none with downstream payments — nothing to void (fireDay=${fireDay})`);
    }
  } catch (err) {
    // Non-fatal: if the reconciler module or reconcile step throws, the
    // normal upload proceeds. Worst case: late txn goes UNUSED (same as
    // pre-2026-07-19 behavior). Operator can then run the manual endpoint.
    console.error(`[retro-reconcile] pre-flight step failed (non-fatal): ${err.message}`);
  }

  // 3. Arrears + snapshot (only after we know there's work to do — and
  //    after retro-reconcile so the arrears reflect any newly-un-paid
  //    invoices from the void step above).
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

  // Persist a downloadable QB Open-Invoices snapshot for this AS_OF. Always-on
  // per Frank's spec: every batch (auto + heisenberg) must be replayable from
  // the dashboard via Invoices.xls / Paid.csv / Unused.csv downloads.
  // Reuses the `arrears` array we just fetched — no extra QB load.
  let invoiceSnapshotId = null;
  try {
    invoiceSnapshotId = await captureInvoiceSnapshot(snapshotAsOf, arrears);
  } catch (e) {
    console.error('[captureInvoiceSnapshot] failed (non-fatal):', e.message);
  }

  // 4. Algorithm (Frank 2026-06-28: switched to V2 — cap-no-overflow
  // Phase 1 + forward-pay Phase 2 baby. Sacred processInvoicePayments
  // function at line 4926 is left untouched and unused for instant
  // rollback by swapping the identifier back.)
  const result = await processInvoicePaymentsWithForwardPay(invoices, txnsClean);
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
        // NB: preflight runs BEFORE the payment_batches INSERT at line ~6550,
        // so no batch row / consumed_transactions rows exist yet — nothing to
        // clean up here. Previous cleanup code referenced batchId in TDZ and
        // crashed silently. Just return aborted. (Frank 2026-07-21)
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

  // Frank 2026-07-23 BAND LAW (supersedes e151d0b for prior-band rows):
  // every row is dated by ITS OWN kili band day, derived from its bank
  // timestamp — never the firing day. Firing-day dating dumped 1,850,500
  // TZS of prior-band money into 07-23's ledger slice and broke Frank's
  // drag-drop (marker-to-marker) vs books reconciliation. Rows whose kili
  // day equals the firing day are unaffected (same value). Voided-replay
  // refs keep their original payment day (3d2bf7a rule, set above, wins).
  try {
    // EXCEPTION: operator MANUAL_RECON fires keep their given txn_date.
    const bandLawApplies = !/MANUAL_RECON/i.test(String(tickName || ''));
    for (const t of (bandLawApplies ? txnsClean : [])) {
      if (!t.receivedTimestamp) continue;
      const suf = appendSuf(t.transactionId, channel);
      if (!suf) continue;
      if (replayTxnDateByRef && replayTxnDateByRef[suf]) continue; // replay original date wins
      const ownKiliDay = kiliBusinessDayFromUtcMs(new Date(t.receivedTimestamp).getTime());
      if (ownKiliDay && txnDate && ownKiliDay < txnDate) {
        if (!replayTxnDateByRef) replayTxnDateByRef = {};
        replayTxnDateByRef[suf] = ownKiliDay;
      }
    }
    const mapped = Object.keys(replayTxnDateByRef || {}).length;
    if (mapped > 0) {
      console.log(`[band-law] ${mapped} ref(s) carry non-firing TxnDates (prior-band rows → own kili day, replays → original day)`);
    }
  } catch (err) {
    console.error(`[band-law] own-kili-day mapping failed (rows fall back to fire txnDate): ${err.message}`);
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
         idempotency_key, status, arrears_snapshot_id, invoice_snapshot_id,
         sheet_id, sheet_tab, channel, bank_refs,
         sheet_total, paid_total, unused_total,
         paid_count, unused_count, created_by, txn_date
       ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING id`,
      [idem, snapshotId, invoiceSnapshotId, cfg.sheetId, cfg.tab, channel, bankRefs,
       round2(sheetSum), round2(sumPaid), round2(sumUnused),
       paid.length, unused.length, `auto-upload:${tickName || 'unknown'}`, txnDate || null],
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

  return { skipped: false, batchId, paid, unused, sheetSum, cfg, replayTxnDateByRef };
}

async function runAutoUploadBackground({ batchId, paid, unused, txnDate,
  txnDateByRef, // ref → original TxnDate for retro-replayed refs (Frank 2026-07-23)
  qbCreatePayment, qbBatchCreatePayments,
  qbCreateUnappliedPayment, qbBatchCreateUnappliedPayments,
  qbBatchLookupCustomers,
  qbCreateCreditMemo,  // kept only for fallback in sweep retry
  cfg,  // { sheetId, tab } — used to write Column I + J markers
  tickName,  // 'meru0300' / 'kili1615' / 'heisenberg' (manual button) etc.
  skipEndOfTickMarker, // Frank 2026-07-21: start-channel writes ONE final K at
                       // end of full session (max row across all windows) to
                       // avoid retro-window K markers orphaning fresh rows.
}) {
  await logBatch(batchId, 'info', `runAutoUploadBackground start: paid=${paid.length} unused=${unused.length} txnDate=${txnDate} tick=${tickName || 'unknown'}${txnDateByRef && Object.keys(txnDateByRef).length ? ` replayDates=${Object.keys(txnDateByRef).length}` : ''}`, 'qb-push');
  // Replayed refs keep their original TxnDate; everything else uses the
  // fire's txnDate.
  const dateFor = (ref) => (txnDateByRef && ref && txnDateByRef[ref]) || txnDate;

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
          txnDate: dateFor(p.memoWithSuffix),
        }));
        let results;
        let chunkError = null;
        try {
          results = await qbBatchCreatePayments(items);
        } catch (err) {
          // whole batch hard-failed (after retries) — mark all as failed
          chunkError = String(err.message || err).slice(0, 500);
          results = items.map(() => ({ ok: false, id: null, response: null, error: chunkError }));
        }
        const affectedRows = new Set();
        let chunkOk = 0, chunkFail = 0;
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
            chunkOk++;
          } else {
            failed++;
            chunkFail++;
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
        if (chunkError) {
          await logBatch(batchId, 'error', `paid chunk #${ci} hard-failed: ${chunkError} — all ${chunk.length} rows flagged failed`, 'qb-push', { chunk_index: ci, chunk_size: chunk.length });
        } else if (chunkFail > 0) {
          await logBatch(batchId, 'warn', `paid chunk #${ci}: ${chunkOk}/${chunk.length} ok, ${chunkFail} per-row failures`, 'qb-push', { chunk_index: ci, ok: chunkOk, fail: chunkFail });
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
            txnDate: dateFor(p.memoWithSuffix),
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
            txnDate: dateFor(u.memoWithSuffix),
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

  // ─── Self-healing sweep with NEVER-GIVE-UP retry (Frank 2026-06-07).
  // Hammer any 'failed' rows with exponential backoff up to MAX_SWEEPS
  // attempts (default 100, configurable via AUTO_UPLOAD_MAX_SWEEPS env).
  // 429s and transient 5xx/timeouts are retried indefinitely — for
  // permanent 4xx errors a row keeps re-failing with the same reason
  // until the cap. Each sweep logs to batch_logs so the operator can
  // come back and see the trail.
  const MAX_SWEEPS = Number(process.env.AUTO_UPLOAD_MAX_SWEEPS || 100);
  for (let sweep = 1; sweep <= MAX_SWEEPS && failed > 0; sweep++) {
    const { rows: stillFailed } = await db().query(
      `SELECT id, kind, customer_id, invoice_qb_id, invoice_no, amount, memo,
              bank_ref, customer_name
         FROM payment_uploads
        WHERE batch_id=$1 AND status='failed'
        ORDER BY id`,
      [batchId],
    );
    if (stillFailed.length === 0) { failed = 0; break; }
    console.log(`[auto-upload] sweep ${sweep}/${MAX_SWEEPS}: retrying ${stillFailed.length} failed rows`);
    await logBatch(batchId, 'info', `sweep ${sweep}/${MAX_SWEEPS}: retrying ${stillFailed.length} failed rows`, 'qb-push', { sweep, failed_count: stillFailed.length });
    let sweepCursor = 0;
    let sweepRecovered = 0;
    const sweeper = async () => {
      while (true) {
        const idx = sweepCursor++;
        if (idx >= stillFailed.length) return;
        const u = stillFailed[idx];
        try {
          let qb;
          if (u.kind === 'payment' && u.invoice_qb_id) {
            qb = await qbCreatePayment({
              customerId: u.customer_id, invoiceQbId: u.invoice_qb_id,
              amount: Number(u.amount), memo: u.memo || '',
              txnDate,
            });
          } else if (u.kind === 'payment' && !u.invoice_qb_id && qbCreateUnappliedPayment) {
            qb = await qbCreateUnappliedPayment({
              customerId: u.customer_id, amount: Number(u.amount), memo: u.memo || '',
              txnDate,
            });
          } else {
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
          sweepRecovered++;
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
    if (sweepRecovered > 0) {
      await logBatch(batchId, 'info', `sweep ${sweep} recovered ${sweepRecovered} rows, ${failed} still failing`, 'qb-push', { sweep, recovered: sweepRecovered, still_failed: failed });
    }
    // Exponential backoff: 1.5s → 3s → 6s → 12s → 30s (capped at 60s).
    // 429s are most likely the cause when bulk sweeps keep failing —
    // giving QB room to breathe between sweeps unstuns the throttle.
    if (failed > 0 && sweep < MAX_SWEEPS) {
      const wait = Math.min(60_000, 1500 * Math.pow(2, Math.min(sweep - 1, 5))) + Math.random() * 500;
      await new Promise((r) => setTimeout(r, wait));
    }
  }

  if (failed === 0) {
    await db().query(`UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`, [batchId]);
    console.log(`[auto-upload] batch ${batchId} finalized.`);
    await logBatch(batchId, 'info', `batch finalized: 0 failures, all payments + unused pushed to QB`, 'qb-push');
  } else {
    await db().query(
      `UPDATE payment_batches SET failure_reason=$2 WHERE id=$1`,
      [batchId, `${failed} per-row failures after ${MAX_SWEEPS} sweeps — see payment_uploads.failure_reason`],
    );
    console.log(`[auto-upload] batch ${batchId} left pending with ${failed} failures after ${MAX_SWEEPS} sweeps.`);
    await logBatch(batchId, 'error', `batch left pending: ${failed} per-row failures after ${MAX_SWEEPS} sweeps — see payment_uploads.failure_reason for each`, 'qb-push', { failed_count: failed, max_sweeps: MAX_SWEEPS });
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
  //
  // Frank 2026-07-21: when skipEndOfTickMarker=true (start-channel plan
  // walks), skip the per-window K marker — caller writes ONE K at max row
  // after all windows complete, to prevent retro-window K markers from
  // orphaning fresh rows appended later in the sheet.
  if (skipEndOfTickMarker) {
    return;
  }
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
