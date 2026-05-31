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

const { STATEMENT_REPORT_SECRET, SUPABASE_URL } = process.env;

const SUPABASE_JWKS = SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

export function mountPaymentBatchesApi(app, deps) {
  const { qbCreatePayment, qbCreateCreditMemo, qbVoid, ensureQbConnected } = deps;

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
      // Credit memos for the unused side. Skip rows with no customer_id —
      // they're tracked in consumed_transactions but not pushed to QB.
      for (let i = 0; i < body.unused.length; i++) {
        const row = body.unused[i];
        if (!row.customer_id) continue;
        const qb = await qbCreateCreditMemo({
          customerId: row.customer_id,
          amount: Number(row.amount),
          memo: row.memo || '',
        });
        const upload = await recordUpload({
          batchId: batch.id, kind: 'credit_memo', row, qbId: qb.id,
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
      const voids = await voidUploadsBestEffort(ups.rows, qbVoid);
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
      const u = await db().query(
        `SELECT * FROM payment_uploads WHERE batch_id=$1 ORDER BY kind, created_at`,
        [req.params.id],
      );
      res.json({ batch: r.rows[0], uploads: u.rows });
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

async function voidUploadsBestEffort(uploads, qbVoid) {
  const out = [];
  for (const u of uploads) {
    if (!u.qb_id) {
      out.push({ upload_id: u.id, ok: false, reason: 'no qb_id (already failed)' });
      continue;
    }
    try {
      const v = await qbVoid({ kind: u.kind, qbId: u.qb_id });
      await db().query(
        `UPDATE payment_uploads SET status='voided', voided_at=now(), qb_void_response=$2 WHERE id=$1`,
        [u.id, JSON.stringify(v)],
      );
      out.push({ upload_id: u.id, ok: true, qb_id: u.qb_id });
    } catch (err) {
      await db().query(
        `UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`,
        [u.id, String(err.message || err).slice(0, 1000)],
      );
      out.push({ upload_id: u.id, ok: false, qb_id: u.qb_id, reason: err.message });
    }
  }
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
