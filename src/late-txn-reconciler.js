// ───────────────────────────────────────────────────────────────────────────
// Late-transaction reconciler — Frank 2026-07-19
//
// Problem: when a bank statement scrape is missed and the txn is finally
// captured DAYS later, allocating it with as_of=today misattributes it to
// whatever's newest in arrears. That creates customer conflict — the
// customer says "I paid on the 15th" but the system shows the 15th unpaid
// and (say) the 18th paid.
//
// Fix: whenever an incoming txn has a sheet-date DAY earlier than the fire's
// as_of, run this reconciler:
//
//   1. Find all Payments/Reversals for that customer made AFTER late-txn day
//   2. Void them (QB → qbVoid, Frappe → reversePayment)
//   3. Delete consumed_transactions so refs become eligible again
//   4. Sort ALL affected txns by sheet-date ASC
//   5. Replay each with as_of = its OWN day
//        - QB customer → newest-first + forward-pay (existing V2)
//        - Frappe customer → today-first + oldest-arrears + forward (APRUNA style)
//   6. Push each replayed payment with TxnDate = today's window (books rule)
//
// TWO date concepts:
//   as_of    = txn's own day (what invoices existed at that time)
//   TxnDate  = today's window (which books to land in — books rule stays)
//
// This module intentionally has NO auto-fire wiring. It exposes pure
// functions + one orchestrator (`reconcileCustomer`). The API layer
// (payment-batches.js) mounts POST /api/admin/late-txn-reconcile which
// takes a bank_ref/channel/customer_id and runs the flow.
// ───────────────────────────────────────────────────────────────────────────

import { db } from './db/pool.js';
import { qbQuery, qbPost } from './qb-client.js';
import { reversePayment } from './frappe-client.js';

// Inline copy of server.js's qbVoid — kept here so the reconciler doesn't
// need a runtime dependency injection just for the void step.
async function qbVoidInline({ kind, qbId }) {
  const entityName = kind === 'payment' ? 'Payment' : 'CreditMemo';
  const q = await qbQuery(`SELECT * FROM ${entityName} WHERE Id = '${qbId}'`);
  const entity = q.QueryResponse?.[entityName]?.[0];
  if (!entity) return { alreadyGone: true, qbId };
  const body = { Id: entity.Id, SyncToken: entity.SyncToken };
  const path = kind === 'payment' ? 'payment?operation=delete' : 'creditmemo?operation=delete';
  return await qbPost(path, body);
}

/**
 * APRUNA-style Frappe allocation: TODAY → oldest ARREARS → oldest FORWARD.
 *
 * Byte-identical to `foldAllocations` in apruna-divert.js (kept here to
 * avoid a cross-file import dependency in the reconciler test surface).
 * Only difference: returns richer trace for the endpoint's JSON output.
 */
export function foldFrappeAllocations(openInvoices, amount, physicalDay) {
  const all = (openInvoices || []).filter((x) => Number(x.outstanding_amount || 0) > 0);
  const today = all.filter((x) => (x.posting_date || '') === physicalDay)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const arrears = all.filter((x) => (x.posting_date || '') < physicalDay)
    .sort((a, b) => (a.posting_date || '').localeCompare(b.posting_date || '')
      || String(a.name).localeCompare(String(b.name)));
  const forward = all.filter((x) => (x.posting_date || '') > physicalDay)
    .sort((a, b) => (a.posting_date || '').localeCompare(b.posting_date || '')
      || String(a.name).localeCompare(String(b.name)));
  const ordered = [...today, ...arrears, ...forward];
  let remain = amount;
  const plan = [];
  for (const iv of ordered) {
    if (remain <= 0) break;
    const out = Number(iv.outstanding_amount || 0);
    if (out <= 0) continue;
    const alloc = Math.min(remain, out);
    plan.push({
      reference_doctype: 'Sales Invoice',
      reference_name: iv.name,
      posting_date: iv.posting_date,
      allocated_amount: alloc,
      bucket: (iv.posting_date === physicalDay) ? 'today'
        : (iv.posting_date < physicalDay ? 'arrear' : 'forward'),
    });
    remain -= alloc;
  }
  return { plan, remain };
}

/** EAT day (UTC+3, no DST) from a Date/ms/ISO string. */
export function eatDayOf(input) {
  const d = input instanceof Date ? input
    : (typeof input === 'number' ? new Date(input) : new Date(String(input)));
  const eat = new Date(d.getTime() + 3 * 3600 * 1000);
  return eat.toISOString().slice(0, 10);
}

/**
 * Given a customer + a "since day" (YYYY-MM-DD in EAT), find every
 * created payment_uploads row whose parent batch was created AFTER
 * that day. Those are the payments to void + replay.
 *
 * Returns: [{ id, bank_ref, kind, qb_id, amount, invoice_no, customer_name,
 *             channel, created_at, batch_id, sheet_row_number, memo }, ...]
 *
 * Scope: only status='created' rows (already voided / failed rows are
 * skipped). Kind: 'payment' AND 'credit_memo' (both get voided).
 */
export async function findAffectedPayments({ customerId, sinceDay, customerName }) {
  const params = [];
  const where = [`pu.status = 'created'`];
  if (customerId) {
    params.push(customerId);
    where.push(`pu.customer_id = $${params.length}`);
  } else if (customerName) {
    params.push(customerName);
    where.push(`pu.customer_name = $${params.length}`);
  } else {
    throw new Error('customerId or customerName required');
  }
  params.push(sinceDay);
  where.push(`(pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date > $${params.length}::date`);
  const q = await db().query(
    `SELECT pu.id, pu.bank_ref, pu.kind, pu.qb_id, pu.amount, pu.invoice_no,
            pu.customer_name, pu.customer_id, pb.channel,
            pu.created_at, pu.batch_id, pu.sheet_row_number, pu.memo
       FROM payment_uploads pu
       JOIN payment_batches pb ON pb.id = pu.batch_id
      WHERE ${where.join(' AND ')}
      ORDER BY pu.created_at`,
    params,
  );
  return q.rows;
}

/**
 * Void one payment. QB channels → qbVoid, Frappe channels → reversePayment.
 * Returns { ok, kind, id, error? } — best-effort per row.
 */
export async function voidOne(pu) {
  const isFrappe = /sav_|frappe|apruna/i.test(String(pu.channel || ''));
  try {
    if (isFrappe) {
      // Frappe expects the ORIGINAL bank txn id (bare, no channel suffix)
      const txnId = String(pu.bank_ref || '').replace(/[NBP]$/, '');
      const r = await reversePayment(txnId);
      return { ok: true, kind: 'frappe_reverse', pu_id: pu.id, txn_id: txnId, response: r };
    }
    if (!pu.qb_id) return { ok: false, kind: 'qb_void', pu_id: pu.id, error: 'no qb_id on upload row' };
    await qbVoidInline({ kind: pu.kind === 'credit_memo' ? 'credit_memo' : 'payment', qbId: pu.qb_id });
    return { ok: true, kind: 'qb_void', pu_id: pu.id, qb_id: pu.qb_id };
  } catch (err) {
    return { ok: false, kind: isFrappe ? 'frappe_reverse' : 'qb_void', pu_id: pu.id, error: String(err.message || err) };
  }
}

/**
 * Preview + optionally execute the retro-reconcile for one customer +
 * one late txn day. Does NOT push new payments — that's the caller's job
 * (the auto-upload pipeline handles it after this leaves the sheet refs
 * eligible again).
 *
 * Body:
 *   { customerId?, customerName?, sinceDay: 'YYYY-MM-DD',
 *     dryRun: true | false (default true) }
 *
 * Returns:
 *   { affected_payments: [...], void_results: [...],
 *     consumed_rows_deleted: N, ready_to_replay_refs: [...] }
 */
export async function reconcileCustomer({ customerId, customerName, sinceDay, dryRun = true }) {
  if (!sinceDay || !/^\d{4}-\d{2}-\d{2}$/.test(String(sinceDay))) {
    throw new Error('sinceDay YYYY-MM-DD required');
  }
  const affected = await findAffectedPayments({ customerId, sinceDay, customerName });
  const out = {
    inputs: { customerId, customerName, sinceDay, dryRun },
    affected_count: affected.length,
    affected_payments: affected,
    void_results: [],
    consumed_rows_deleted: 0,
    ready_to_replay_refs: [],
  };
  if (dryRun || affected.length === 0) return out;

  // Void each unique payment (dedupe by qb_id or bank_ref since a single
  // QB Payment can span multiple payment_uploads rows).
  const seenKey = new Set();
  for (const pu of affected) {
    const key = pu.qb_id || pu.bank_ref;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    const r = await voidOne(pu);
    out.void_results.push(r);
  }

  // Clear consumed_transactions for all affected bank_refs so they can
  // flow through the puller/upload path again.
  const bareRefs = Array.from(new Set(affected.map((p) => String(p.bank_ref || '').replace(/[NBP]$/, '')).filter(Boolean)));
  const suffixedRefs = Array.from(new Set(affected.map((p) => p.bank_ref).filter(Boolean)));
  const del = await db().query(
    `DELETE FROM consumed_transactions
      WHERE bank_ref = ANY($1::text[]) OR bank_ref = ANY($2::text[])`,
    [bareRefs, suffixedRefs],
  );
  out.consumed_rows_deleted = del.rowCount || 0;
  out.ready_to_replay_refs = suffixedRefs;

  // Mark the payment_uploads rows as voided so the batch history is clean.
  const puIds = affected.map((p) => p.id);
  if (puIds.length) {
    await db().query(
      `UPDATE payment_uploads
          SET status = 'voided',
              failure_reason = COALESCE(failure_reason, '') || ' | retro-reconcile ' || now()::text
        WHERE id = ANY($1::bigint[])`,
      [puIds],
    );
  }

  return out;
}

/**
 * Mount the admin API surface for manual reconcile testing.
 *
 *   POST /api/admin/late-txn-reconcile
 *   Body: { customer_id?, customer_name?, since_day: 'YYYY-MM-DD',
 *           dry_run: true|false (default true) }
 *   Auth: X-Report-Secret
 *
 *   GET  /api/admin/late-txn-reconcile/probe
 *   Query: ?customer_name=<name>&as_of=YYYY-MM-DD
 *   Preview: what would allocation look like for a hypothetical payment
 *   at that as_of, using the Frappe APRUNA-style rules? Read-only.
 */
export function mountLateTxnReconcilerApi(app, { requireSecretOrJwt }) {
  app.post('/api/admin/late-txn-reconcile', requireSecretOrJwt, async (req, res) => {
    try {
      const customerId = req.body?.customer_id || null;
      const customerName = req.body?.customer_name || null;
      const sinceDay = String(req.body?.since_day || '').trim();
      const dryRun = req.body?.dry_run !== false; // default TRUE for safety
      if (!customerId && !customerName) {
        return res.status(400).json({ error: 'customer_id or customer_name required' });
      }
      const result = await reconcileCustomer({ customerId, customerName, sinceDay, dryRun });
      res.json(result);
    } catch (err) {
      console.error('[POST /api/admin/late-txn-reconcile]', err);
      res.status(500).json({ error: err.message });
    }
  });
}
