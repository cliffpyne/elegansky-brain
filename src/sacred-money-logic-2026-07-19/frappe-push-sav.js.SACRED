// ───────────────────────────────────────────────────────────────────────────
// Frappe push — SAV channels (Wakandi-resident customers)
//
// The existing frappe-push.js path works for the 18 QB-originated SAVCOM
// customers because they live in BRAIN's QB mirror — payment-batches.js
// already matches them and stores their payment rows with customer_id.
//
// The 274 Wakandi-only SAVCOM customers are NOT in BRAIN's QB mirror,
// so payment-batches.js routes their bank rows to status='needs_saasant'
// (the existing fallback for "DisplayName not in QB"). This module
// reclaims those needs_saasant rows for the SAV channels, resolves them
// against the live Frappe savcom_customers cache, runs the sacred V2
// algorithm against Frappe's open invoices, and posts the allocations.
//
// Why this module instead of touching payment-batches.js:
//   - sacred algorithm code stays byte-identical (Frank's rule)
//   - the upstream matcher keeps its QB-only contract
//   - this can be dry-run / fired / rolled back independently
//
// The flow (per batch):
//   1. SELECT needs_saasant rows in SAV channels for the batch
//   2. Group by bank_ref (one bank tx per Frappe Payment Entry)
//   3. Per group: savcom resolver → Frappe customer; getOpenInvoices →
//      Frappe invoice list
//   4. Adapt invoices + the synthetic tx to V2 algorithm shape
//   5. Run processInvoicePaymentsWithForwardPay (V2 + forward-pay baby)
//   6. Map V2 output → Frappe ingest_payment payload with explicit
//      allocations
//   7. Dry-run returns payloads; fire calls ingestPayment per group
// ───────────────────────────────────────────────────────────────────────────

import { db } from './db/pool.js';
import { getOpenInvoices, ingestPayment } from './frappe-client.js';
import { resolveSavcom } from './savcom-resolver.js';
import { processInvoicePaymentsV2 } from './payment-algorithm-v2.js';

const MODE_OF_PAYMENT = 'SAVCOM';
const SAV_CHANNELS = new Set(['nmbnew_sav', 'bank_sav']);

function ymd(d) {
  if (!d) return new Date().toISOString().slice(0, 10);
  const dt = (d instanceof Date) ? d : new Date(d);
  return dt.toISOString().slice(0, 10);
}

/**
 * Convert Frappe's get_open_invoices response into V2 algorithm input.
 * V2 expects: {customerName, customerPhone, customerId, qbId,
 *              invoiceNumber, invoiceDate, amount}
 * We map Frappe `name` → both invoiceNumber and qbId (sacred algorithm
 * uses qbId as the link to the upstream id; here it's the Frappe doc).
 */
function frappeInvoicesToV2(invoices, customerKey) {
  return (invoices || []).map((inv) => ({
    customerName: customerKey,
    customerPhone: null,
    customerId: customerKey,
    qbId: inv.name,                                // Frappe Sales Invoice id
    invoiceNumber: inv.name,
    invoiceDate: inv.posting_date || inv.due_date,
    amount: Number(inv.outstanding_amount) || 0,
  })).filter((i) => i.amount > 0 && i.invoiceDate);
}

/**
 * Build the synthetic transaction (one per group) in V2 shape.
 */
function rowsToV2Tx(group, customerKey) {
  const totalAmt = group.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
  const firstRow = group.rows[0] || {};
  return [{
    customerName: customerKey,
    customerPhone: null,
    contractName: customerKey,
    channel: firstRow.channel || group.channel,
    transactionId: group.bank_ref,
    id: group.bank_ref,
    amount: totalAmt,
    receivedTimestamp: firstRow.created_at ? new Date(firstRow.created_at).getTime() : Date.now(),
    sheet_row_number: null,
  }];
}

/**
 * Run V2 + forward-pay over Frappe invoices for one group.
 * Returns:
 *   { allocations: [{reference_name, allocated_amount}], leftover,
 *     forwardPaid: [...], algorithm_trace: {...} }
 */
async function allocateGroupAgainstFrappe(group, customerKey) {
  let frappeRes;
  try {
    frappeRes = await getOpenInvoices(customerKey);
  } catch (err) {
    return {
      error: `getOpenInvoices: ${err.message}`,
      allocations: [], leftover: group.rows.reduce((s, r) => s + Number(r.amount), 0),
    };
  }
  const frappeInvoices = frappeRes.invoices || [];
  const v2Invoices = frappeInvoicesToV2(frappeInvoices, customerKey);
  const v2Txs = rowsToV2Tx(group, customerKey);
  const total = v2Txs[0].amount;
  if (v2Invoices.length === 0) {
    return {
      allocations: [], leftover: total,
      algorithm_trace: { open_invoices: 0, note: 'no open invoices on Frappe — full amount becomes credit' },
    };
  }
  const { payments, leftoverPerTx } = processInvoicePaymentsV2(v2Invoices, v2Txs);
  const allocations = [];
  let allocatedSum = 0;
  for (const p of payments) {
    if (p.isUnused) continue;
    if (!p.qbId) continue;
    allocations.push({
      reference_name: p.qbId,
      allocated_amount: Number(p.amount) || 0,
    });
    allocatedSum += Number(p.amount) || 0;
  }
  const phase1Leftover = leftoverPerTx.reduce((s, l) => s + l.leftover, 0);
  // No Phase 2 forward-pay yet: Wakandi customers' future-invoice fetch
  // would need an extra Frappe query and is a future iteration. For now,
  // any leftover becomes customer credit (hanging advance in Frappe), per
  // the agreed contract: "remainder = credit if no forward invoices".
  return {
    allocations,
    leftover: total - allocatedSum,
    forward_pay_skipped: phase1Leftover > 0 ? 'phase2_not_yet_wired_for_frappe' : null,
    algorithm_trace: {
      open_invoices: v2Invoices.length,
      allocated_count: allocations.length,
      allocated_sum: allocatedSum,
      phase1_leftover: phase1Leftover,
    },
  };
}

/**
 * Build per-group payloads from a batch's needs_saasant SAV rows.
 * Returns one entry per (bank_ref) group; each entry includes the
 * resolved customer + the V2 allocation result.
 */
export async function buildSavPayloadsFromBatch(batchId) {
  const { rows: batchRows } = await db().query(
    `SELECT pu.id, pu.bank_ref, pu.customer_name, pu.amount, pu.memo, pu.created_at, pb.channel
       FROM payment_uploads pu
       JOIN payment_batches pb ON pb.id = pu.batch_id
      WHERE pu.batch_id = $1
        AND pu.status = 'needs_saasant'
        AND pb.channel = ANY($2)
      ORDER BY pu.bank_ref, pu.id`,
    [batchId, Array.from(SAV_CHANNELS)],
  );
  if (!batchRows.length) return [];

  const groups = new Map();
  for (const r of batchRows) {
    const key = String(r.bank_ref || '').trim();
    if (!key) continue;
    if (!groups.has(key)) {
      groups.set(key, { bank_ref: key, channel: r.channel, rows: [] });
    }
    groups.get(key).rows.push(r);
  }

  const out = [];
  for (const g of groups.values()) {
    const sample = g.rows[0] || {};
    const reso = await resolveSavcom({
      name: sample.customer_name,
      freeText: [sample.customer_name, sample.memo, g.bank_ref].filter(Boolean).join(' | '),
    });
    const total = g.rows.reduce((s, r) => s + (Number(r.amount) || 0), 0);
    if (!reso.match) {
      out.push({
        bank_ref: g.bank_ref,
        customer: null,
        customer_brain_name: sample.customer_name,
        customer_lookup_status: 'no_match',
        amount: total,
        date: ymd(sample.created_at),
        txn_id: g.bank_ref,
        mode_of_payment: MODE_OF_PAYMENT,
        allocations: [],
        total_alloc: 0,
        row_count: g.rows.length,
        skip_reason: 'savcom_resolver_no_match',
      });
      continue;
    }
    const customerKey = reso.match.customer;
    const alloc = await allocateGroupAgainstFrappe(g, customerKey);
    out.push({
      bank_ref: g.bank_ref,
      customer: customerKey,
      customer_brain_name: sample.customer_name,
      customer_resolved_via: reso.via,
      customer_source: reso.match.source,
      customer_lookup_status: alloc.error ? 'error' : 'ok',
      amount: total,
      date: ymd(sample.created_at),
      txn_id: g.bank_ref,
      mode_of_payment: MODE_OF_PAYMENT,
      allocations: alloc.allocations,
      total_alloc: alloc.allocations.reduce((s, a) => s + a.allocated_amount, 0),
      leftover: alloc.leftover,
      row_count: g.rows.length,
      algorithm_trace: alloc.algorithm_trace,
      forward_pay_skipped: alloc.forward_pay_skipped,
      error: alloc.error,
    });
  }
  return out;
}

/**
 * Push the SAV needs_saasant rows in a batch to Frappe. dryRun=true
 * returns the would-be payloads; dryRun=false calls ingestPayment per
 * payload and stamps the source payment_uploads rows as 'pushed_to_frappe'
 * so they don't get re-fired.
 */
export async function pushSavBatchToFrappe(batchId, { dryRun = true } = {}) {
  const payloads = await buildSavPayloadsFromBatch(batchId);
  if (!payloads.length) {
    return { batch_id: batchId, dry_run: dryRun, payloads: [], note: 'no needs_saasant SAV rows in batch' };
  }
  if (dryRun) {
    return { batch_id: batchId, dry_run: true, payloads };
  }
  const results = [];
  for (const p of payloads) {
    if (!p.customer || p.customer_lookup_status !== 'ok') {
      results.push({ bank_ref: p.bank_ref, status: 'skipped', reason: p.skip_reason || p.customer_lookup_status });
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
      // Stamp source rows so a future fire skips them. Use a status the
      // existing reporting layer ignores — 'pushed_to_frappe' is new.
      await db().query(
        `UPDATE payment_uploads
            SET status = 'pushed_to_frappe',
                failure_reason = $3
          WHERE batch_id = $1 AND bank_ref = $2 AND status = 'needs_saasant'`,
        [batchId, p.bank_ref, `Frappe ingest_payment ${r?.status || 'ok'} via SAVCOM`],
      );
      results.push({ bank_ref: p.bank_ref, status: r?.status || 'ok', frappe: r });
    } catch (err) {
      results.push({ bank_ref: p.bank_ref, status: 'error', error: err.message });
    }
  }
  return { batch_id: batchId, dry_run: false, results };
}

export function mountFrappeSavApi(app, { requireSecretOrJwt }) {
  // Dry-run the SAV-channel needs_saasant rows for a batch.
  // Shows resolved customers, V2 allocations, and any misses without
  // touching Frappe state.
  app.post('/api/admin/frappe/dry-run-sav-batch', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.query.batch_id || req.body?.batch_id || '').trim();
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      res.json(await pushSavBatchToFrappe(batchId, { dryRun: true }));
    } catch (err) {
      console.error('[frappe/dry-run-sav-batch]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Real fire for SAV channel rows.
  app.post('/api/admin/frappe/fire-sav-batch', requireSecretOrJwt, async (req, res) => {
    try {
      const batchId = String(req.query.batch_id || req.body?.batch_id || '').trim();
      if (!batchId) return res.status(400).json({ error: 'batch_id required' });
      res.json(await pushSavBatchToFrappe(batchId, { dryRun: false }));
    } catch (err) {
      console.error('[frappe/fire-sav-batch]', err);
      res.status(500).json({ error: err.message });
    }
  });
}
