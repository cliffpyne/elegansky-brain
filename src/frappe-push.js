// ───────────────────────────────────────────────────────────────────────────
// Frappe push — convert a finalized BRAIN batch's payment rows into
// Frappe ingest_payment calls. Isolated from the existing QB push path
// so this can ship as dry-run-first without any risk to the QB pipeline.
//
// Flow per batch:
//   1. Read the batch's payment_uploads rows (paid + unused).
//   2. Group by bank_ref — one Frappe Payment Entry per bank txn.
//   3. For each group, look up the customer's open invoices on Frappe
//      and map BRAIN's invoice_no → Frappe Sales Invoice name via the
//      qb_doc_number custom field the Frappe dev stamps on import.
//   4. Build the ingest_payment payload: customer, amount, date, txn_id,
//      mode_of_payment, allocations[]. Allocations not mappable are
//      OMITTED — Frappe treats the remainder as customer credit per
//      our agreed contract.
//   5. dryRun=true → return the payloads + per-row diagnostics, no
//      Frappe call. dryRun=false → call ingestPayment per group.
//
// Mode_of_payment:
//   nmbnew_sav, bank_sav  → "SAVCOM"   (single Kijichi Collection mode)
//   anything else fed in  → falls back to "SAVCOM" too (we only route
//                          SAV channels through Frappe today)
//
// Customer resolution: BRAIN sends `customer=<full DisplayName>` verbatim
// per Frank's rule "don't trim plate substrings". Frappe accepts both
// plate and full name; for now we send the name BRAIN has on the row.
// ───────────────────────────────────────────────────────────────────────────

import { db } from './db/pool.js';
import { getOpenInvoices, ingestPayment } from './frappe-client.js';
import { resolveSavcom, getCacheStats, runCoverage } from './savcom-resolver.js';

const MODE_OF_PAYMENT = 'SAVCOM';

function ymdFromTimestamp(ts) {
  if (!ts) return new Date().toISOString().slice(0, 10);
  return new Date(ts).toISOString().slice(0, 10);
}

/**
 * Build the per-bank-txn payloads for one batch. Returns:
 *   [{ bank_ref, customer, customer_lookup_status, amount, date, txn_id,
 *      mode_of_payment, allocations, unmapped_rows, total_alloc }, ...]
 *
 * customer_lookup_status:
 *   'ok'              - Frappe returned open invoices
 *   'no_match'        - Frappe 417, customer not found
 *   'error'           - Frappe call threw (network etc)
 *   'no_customer_id'  - BRAIN row had no customer_name to send
 */
export async function buildFrappePayloadsFromBatch(batchId) {
  const { rows } = await db().query(
    `SELECT id, bank_ref, customer_id, customer_name, invoice_qb_id,
            invoice_no, amount, memo, kind
       FROM payment_uploads
      WHERE batch_id = $1
      ORDER BY bank_ref, id`,
    [batchId],
  );
  if (!rows.length) return [];

  // Group by bank_ref. One Frappe Payment Entry per group.
  const groups = new Map();
  for (const r of rows) {
    const key = String(r.bank_ref || '').trim();
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, {
        bank_ref: key,
        customer_name: r.customer_name,
        customer_id: r.customer_id,
        rows: [],
      });
    }
    groups.get(key).rows.push(r);
  }

  const out = [];
  for (const g of groups.values()) {
    const total = g.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    const memo = g.rows.find((r) => r.memo)?.memo || null;
    // Resolve the customer against Frappe's savcom_customers cache (292
    // total: 18 QB-originated by plate, 274 Wakandi by account/wakandi_id).
    // Without this, Wakandi-only rows would all miss because BRAIN's QB
    // mirror never had them.
    let frappeInvoices = [];
    let lookupStatus = 'ok';
    let resolved = null;       // the cached Frappe customer object on hit
    let resolvedVia = null;    // which signal matched (plate/account/...)
    let frappeCustomerKey = null;  // identifier used in ingest_payment call
    if (g.customer_name) {
      const sample = g.rows[0] || {};
      const reso = await resolveSavcom({
        // BRAIN's stored customer_name already includes the plate for QB
        // rows; the resolver's `name` matcher handles the QB side and
        // `extracted_plate`/`extracted_account` covers free-form bank
        // memos. `freeText` captures memo lines that contain the
        // Wakandi account number verbatim.
        name: g.customer_name,
        freeText: [g.customer_name, sample.memo, g.bank_ref].filter(Boolean).join(' | '),
      });
      if (reso.match) {
        resolved = reso.match;
        resolvedVia = reso.via;
        frappeCustomerKey = reso.match.customer;
      }
      try {
        const r = await getOpenInvoices(frappeCustomerKey || g.customer_name);
        frappeInvoices = r.invoices || [];
      } catch (err) {
        if (err.status === 417) lookupStatus = 'no_match';
        else lookupStatus = `error:${(err.message || '').slice(0, 80)}`;
      }
    } else {
      lookupStatus = 'no_customer_id';
    }

    // Build qb_doc_number → Frappe Sales Invoice name lookup.
    // qb_doc_number is the custom field Frappe stamps on each invoice
    // pointing back to its QB DocNumber.
    const qbDocToFrappeName = new Map();
    for (const inv of frappeInvoices) {
      const qbDoc = String(inv.qb_doc_number || '').trim();
      if (qbDoc) qbDocToFrappeName.set(qbDoc, inv.name);
    }

    const allocations = [];
    const unmapped = [];
    for (const r of g.rows) {
      if (r.kind !== 'payment' || !r.invoice_no) {
        unmapped.push({ reason: 'no_invoice_no', row_id: r.id });
        continue;
      }
      const frappeName = qbDocToFrappeName.get(String(r.invoice_no));
      if (!frappeName) {
        unmapped.push({
          reason: 'invoice_no_not_in_frappe',
          row_id: r.id,
          invoice_no: r.invoice_no,
        });
        continue;
      }
      allocations.push({
        reference_name: frappeName,
        allocated_amount: Number(r.amount) || 0,
      });
    }

    out.push({
      bank_ref: g.bank_ref,
      customer: frappeCustomerKey || g.customer_name,
      customer_brain_name: g.customer_name,
      customer_resolved_via: resolvedVia,
      customer_source: resolved?.source || null,
      customer_lookup_status: lookupStatus,
      amount: total,
      date: ymdFromTimestamp(null),
      txn_id: g.bank_ref,
      mode_of_payment: MODE_OF_PAYMENT,
      allocations,
      total_alloc: allocations.reduce((s, a) => s + a.allocated_amount, 0),
      unmapped_rows: unmapped,
      row_count: g.rows.length,
    });
  }
  return out;
}

/**
 * Push a batch to Frappe. dryRun=true returns the payloads + a "would_post"
 * status without calling Frappe. dryRun=false invokes ingestPayment per
 * payload and returns per-call results.
 */
export async function pushBatchToFrappe(batchId, { dryRun = true } = {}) {
  const payloads = await buildFrappePayloadsFromBatch(batchId);
  if (!payloads.length) {
    return { batch_id: batchId, dry_run: dryRun, payloads: [], note: 'no rows in batch' };
  }
  if (dryRun) {
    return { batch_id: batchId, dry_run: true, payloads };
  }
  // Real fire: one ingest_payment per payload.
  const results = [];
  for (const p of payloads) {
    if (p.customer_lookup_status === 'no_match' || p.customer_lookup_status === 'no_customer_id') {
      results.push({
        bank_ref: p.bank_ref,
        status: 'skipped',
        reason: p.customer_lookup_status,
      });
      continue;
    }
    try {
      const r = await ingestPayment({
        customer: p.customer,
        amount: p.amount,
        date: p.date,
        txn_id: p.txn_id,
        mode_of_payment: p.mode_of_payment,
        allocations: p.allocations,
      });
      results.push({ bank_ref: p.bank_ref, status: r?.status || 'ok', frappe: r });
    } catch (err) {
      results.push({
        bank_ref: p.bank_ref,
        status: 'error',
        error: err.message,
      });
    }
  }
  return { batch_id: batchId, dry_run: false, results };
}

export function mountFrappePushApi(app, { requireSecretOrJwt }) {
  // Dry-run: returns the exact ingest_payment payloads that WOULD be sent
  // to Frappe, including per-row mapping diagnostics. Zero Frappe writes.
  app.post('/api/admin/frappe/dry-run-from-batch', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.query.batch_id || req.body?.batch_id || '').trim();
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      const result = await pushBatchToFrappe(batchId, { dryRun: true });
      res.json(result);
    } catch (err) {
      console.error('[frappe/dry-run-from-batch]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // SAVCOM resolver cache stats — confirms BRAIN has the full 292 loaded.
  // Safe to call from a browser with the admin secret; no Frappe write.
  app.get('/api/admin/savcom/cache', requireSecretOrJwt, async (_req, res) => {
    try {
      res.json(await getCacheStats());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Coverage pre-flight: pass an array of trial rows and see which would
  // resolve / which would miss / which signal matched. Use this BEFORE a
  // real SAV fire to confirm the matcher recognizes today's bank rows.
  //   POST /api/admin/savcom/coverage  body: { rows: [{name, plate, account, freeText}, ...] }
  app.post('/api/admin/savcom/coverage', requireSecretOrJwt, async (req, res) => {
    try {
      const rows = Array.isArray(req.body?.rows) ? req.body.rows : [];
      if (!rows.length) return res.status(400).json({ error: 'rows[] required' });
      res.json(await runCoverage(rows));
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Per-batch coverage: pull every row from a finalized batch and resolve
  // each against the savcom cache. Reports hit/miss without touching
  // Frappe further than the cache load.
  app.get('/api/admin/savcom/coverage-by-batch', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.query.batch_id || '').trim();
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      const { rows } = await db().query(
        `SELECT id, bank_ref, customer_id, customer_name, memo
           FROM payment_uploads
          WHERE batch_id = $1
          ORDER BY id`,
        [batchId],
      );
      const trial = rows.map((r) => ({
        name: r.customer_name,
        freeText: [r.customer_name, r.memo, r.bank_ref].filter(Boolean).join(' | '),
        _row_id: r.id,
        _bank_ref: r.bank_ref,
      }));
      const cov = await runCoverage(trial);
      res.json({ batch_id: batchId, ...cov });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Real fire: posts each payload to Frappe ingest_payment.
  // Idempotency: Frappe dedups by txn_id, so retrying is safe.
  app.post('/api/admin/frappe/fire-batch', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.query.batch_id || req.body?.batch_id || '').trim();
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      const result = await pushBatchToFrappe(batchId, { dryRun: false });
      res.json(result);
    } catch (err) {
      console.error('[frappe/fire-batch]', err);
      res.status(500).json({ error: err.message });
    }
  });
}
