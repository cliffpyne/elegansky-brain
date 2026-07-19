// ───────────────────────────────────────────────────────────────────────────
// Payment algorithm V2 — cap-no-overflow + forward-pay baby
//
// Frank 2026-06-28: never overpay any invoice. After paying all due/overdue
// invoices, any leftover money rolls FORWARD onto future invoices (closest
// first → tomorrow, day after, ... until depleted or no more invoices).
// Anything still left = customer credit (Frappe advance / QB unapplied).
//
// Versus the sacred processInvoicePayments (untouched, line 4926 of
// payment-batches.js):
//   - SAME: invoices sorted newest-first, transactions oldest-first
//   - SAME: walk newest → oldest, cap each invoice at its remaining balance
//   - REMOVED: the `txp[0].amount += amt` overflow-to-today line — leftover
//              instead returned per-tx so phase-2 can roll it forward.
//
// Phase 2 (forwardPayLeftover) takes the per-tx leftover, fetches each
// customer's FUTURE invoices (TxnDate > today), and creates additional
// payment lines oldest-first until the credit is gone or invoices are
// exhausted.
//
// Hard rule (Frank 2026-06-28): "no invoice should be paid more than its
// amount supposed to be paid."
// ───────────────────────────────────────────────────────────────────────────

import { qbQuery } from './qb-client.js';

function appendSuf(ref, channel) {
  // Same suffix convention as the sacred path:
  //   nmbnew / nmbnew_sav → N    bank / bank_sav → B    iphone_bank → P
  const m = { nmbnew: 'N', nmbnew_sav: 'N', bank: 'B', bank_sav: 'B', iphone_bank: 'P' };
  const s = m[channel] || '';
  if (!ref) return ref;
  return s ? `${ref}${s}` : String(ref);
}

/**
 * Compute payment splits — cap-no-overflow variant.
 *
 * Inputs match the sacred processInvoicePayments:
 *   invoices: [{customerName, customerPhone, customerId, qbId,
 *               invoiceNumber, invoiceDate, amount}, ...]
 *   transactions: [{customerName, customerPhone, contractName, channel,
 *               transactionId, id, amount, receivedTimestamp,
 *               sheet_row_number}, ...]
 *
 * Returns:
 *   { payments: [...same shape as sacred out[]...],
 *     leftoverPerTx: [{ customerKey, customerName, customerId, qbId,
 *                       channel, transactionId, sheet_row_number,
 *                       leftover, txDate }, ...] }
 *
 * leftoverPerTx is empty when nothing overflowed (every TX consumed by
 * existing invoices). Phase 2 takes it and rolls forward.
 */
export function processInvoicePaymentsV2(invoices, transactions) {
  const usedTx = new Set();
  const invByCust = {};
  invoices.forEach((inv) => {
    const key = inv.customerPhone || inv.customerName.toLowerCase().trim();
    (invByCust[key] ||= []).push(inv);
  });
  // SAME sort as sacred: newest-first per customer.
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
  // SAME sort as sacred: oldest-first transactions.
  Object.keys(txByCust).forEach((k) => txByCust[k].sort((a, b) => (a.receivedTimestamp || 0) - (b.receivedTimestamp || 0)));

  const out = [];
  const leftoverPerTx = [];

  Object.keys(invByCust).forEach((ck) => {
    const ci = invByCust[ck];
    const ct = txByCust[ck] || [];
    if (ct.length === 0) return;
    const ib = ci.map((inv) => ({ inv, remainingBalance: inv.amount, fullyPaid: false }));
    let idx = 0;
    ct.forEach((tx) => {
      let amt = tx.amount;
      let used = false;
      while (amt > 0 && idx < ib.length) {
        const cur = ib[idx];
        if (cur.fullyPaid) { idx++; continue; }
        const pay = Math.min(amt, cur.remainingBalance);
        out.push({
          customerName: cur.inv.customerName,
          invoiceNo: cur.inv.invoiceNumber,
          amount: pay,
          memo: tx.transactionId,
          memoWithSuffix: appendSuf(tx.transactionId, tx.channel),
          channel: tx.channel,
          customerId: cur.inv.customerId,
          qbId: cur.inv.qbId,
          sheet_row_number: tx.sheet_row_number,
        });
        cur.remainingBalance -= pay;
        amt -= pay;
        used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTx.add(tx.transactionId || tx.id);
      // CHANGED vs sacred: no longer tack overflow onto txp[0]. Instead
      // record per-tx leftover so phase 2 can roll it forward.
      if (amt > 0 && used) {
        const sampleInv = ib.find((b) => b.inv) || ib[0];
        leftoverPerTx.push({
          customerKey: ck,
          customerName: sampleInv?.inv?.customerName || tx.customerName || tx.contractName,
          customerId: sampleInv?.inv?.customerId || null,
          qbId: sampleInv?.inv?.qbId || null,
          channel: tx.channel,
          transactionId: tx.transactionId || tx.id,
          memoWithSuffix: appendSuf(tx.transactionId, tx.channel),
          sheet_row_number: tx.sheet_row_number,
          leftover: amt,
          txDate: tx.receivedTimestamp ? new Date(tx.receivedTimestamp).toISOString().slice(0, 10) : null,
        });
      }
    });
  });

  const unused = transactions.filter((t) => !usedTx.has(t.transactionId || t.id));
  unused.forEach((t) => out.push({
    customerName: t.customerName || t.contractName || 'UNKNOWN',
    invoiceNo: 'UNUSED',
    amount: t.amount,
    transactionAmount: t.amount,
    memo: t.transactionId,
    memoWithSuffix: appendSuf(t.transactionId, t.channel),
    isUnused: true,
    channel: t.channel,
    sheet_row_number: t.sheet_row_number,
  }));

  return { payments: out, leftoverPerTx };
}

/**
 * APRUNA-style Frappe allocator — Frank 2026-07-19.
 *
 * Same inputs/outputs as processInvoicePaymentsV2 so it drops in cleanly
 * on Frappe paths (SAVCOM sav_nmb / sav_crdb, plus any future Frappe channel).
 *
 * Difference from V2: sort order per customer.
 *   V2:      invoices NEWEST-first (D0, D-1, D-2, ...)
 *   Frappe:  TODAY (matching physicalDay) → oldest ARREARS → oldest FORWARD
 *            (D0, D-oldest → D-1, D+1 → D+furthest)
 *
 * physicalDay: 'YYYY-MM-DD' EAT day. If null, defaults to today's EAT day.
 *              Used to bucket each customer's invoices into today/arrear/forward.
 *
 * Everything else (cap-no-overflow, per-tx leftover for phase 2, customer
 * match keys, unused tag) is byte-identical to V2.
 */
export function processInvoicePaymentsFrappe(invoices, transactions, physicalDay) {
  const day = physicalDay || (() => {
    const now = new Date();
    const eat = new Date(now.getTime() + 3 * 3600 * 1000);
    return eat.toISOString().slice(0, 10);
  })();
  const usedTx = new Set();
  const invByCust = {};
  invoices.forEach((inv) => {
    const key = inv.customerPhone || inv.customerName.toLowerCase().trim();
    (invByCust[key] ||= []).push(inv);
  });
  // APRUNA sort per customer: TODAY → oldest ARREARS → oldest FORWARD.
  Object.keys(invByCust).forEach((k) => {
    const arr = invByCust[k];
    const today = arr.filter((iv) => (iv.invoiceDate || '') === day)
      .sort((a, b) => String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
    const arrears = arr.filter((iv) => (iv.invoiceDate || '') < day)
      .sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
        || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
    const forward = arr.filter((iv) => (iv.invoiceDate || '') > day)
      .sort((a, b) => (a.invoiceDate || '').localeCompare(b.invoiceDate || '')
        || String(a.invoiceNumber).localeCompare(String(b.invoiceNumber)));
    invByCust[k] = [...today, ...arrears, ...forward];
  });

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
  const leftoverPerTx = [];

  Object.keys(invByCust).forEach((ck) => {
    const ci = invByCust[ck];
    const ct = txByCust[ck] || [];
    if (ct.length === 0) return;
    const ib = ci.map((inv) => ({ inv, remainingBalance: inv.amount, fullyPaid: false }));
    let idx = 0;
    ct.forEach((tx) => {
      let amt = tx.amount;
      let used = false;
      while (amt > 0 && idx < ib.length) {
        const cur = ib[idx];
        if (cur.fullyPaid) { idx++; continue; }
        const pay = Math.min(amt, cur.remainingBalance);
        out.push({
          customerName: cur.inv.customerName,
          invoiceNo: cur.inv.invoiceNumber,
          amount: pay,
          memo: tx.transactionId,
          memoWithSuffix: appendSuf(tx.transactionId, tx.channel),
          channel: tx.channel,
          customerId: cur.inv.customerId,
          qbId: cur.inv.qbId,
          sheet_row_number: tx.sheet_row_number,
        });
        cur.remainingBalance -= pay;
        amt -= pay;
        used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTx.add(tx.transactionId || tx.id);
      if (amt > 0 && used) {
        const sampleInv = ib.find((b) => b.inv) || ib[0];
        leftoverPerTx.push({
          customerKey: ck,
          customerName: sampleInv?.inv?.customerName || tx.customerName || tx.contractName,
          customerId: sampleInv?.inv?.customerId || null,
          qbId: sampleInv?.inv?.qbId || null,
          channel: tx.channel,
          transactionId: tx.transactionId || tx.id,
          memoWithSuffix: appendSuf(tx.transactionId, tx.channel),
          sheet_row_number: tx.sheet_row_number,
          leftover: amt,
          txDate: tx.receivedTimestamp ? new Date(tx.receivedTimestamp).toISOString().slice(0, 10) : null,
        });
      }
    });
  });

  const unused = transactions.filter((t) => !usedTx.has(t.transactionId || t.id));
  unused.forEach((t) => out.push({
    customerName: t.customerName || t.contractName || 'UNKNOWN',
    invoiceNo: 'UNUSED',
    amount: t.amount,
    transactionAmount: t.amount,
    memo: t.transactionId,
    memoWithSuffix: appendSuf(t.transactionId, t.channel),
    isUnused: true,
    channel: t.channel,
    sheet_row_number: t.sheet_row_number,
  }));

  return { payments: out, leftoverPerTx };
}

/**
 * Phase 2 — the forward-pay baby. Takes leftoverPerTx from V2 and rolls
 * each per-tx leftover onto that customer's FUTURE invoices (TxnDate >
 * today, balance > 0), oldest-first (closest day first).
 *
 * Returns:
 *   { forwardPayments: [...same shape as sacred out[]...],
 *     unappliedCredits: [{ customerName, customerId, qbId, channel,
 *                          transactionId, memoWithSuffix,
 *                          sheet_row_number, amount, txDate }, ...] }
 *
 * forwardPayments get appended to the upload's payment list and pushed
 * the same way as Phase 1 payments. unappliedCredits get created as
 * customer-credit payments (no invoice link) — QB → Unapplied Payment,
 * Frappe → hanging advance.
 *
 * Implementation: for each unique customer, ONE QB query for their
 * forward invoices (cached locally), then walk transactions FIFO.
 */
export async function forwardPayLeftover(leftoverPerTx, { todayIso }) {
  if (!Array.isArray(leftoverPerTx) || leftoverPerTx.length === 0) {
    return { forwardPayments: [], unappliedCredits: [] };
  }
  const today = todayIso || new Date().toISOString().slice(0, 10);

  // Group leftover by customer (qbId preferred, fall back to customerKey).
  const byCustomer = new Map();
  for (const lo of leftoverPerTx) {
    const ck = lo.qbId || lo.customerId || lo.customerKey;
    if (!ck) continue;  // can't pay forward without a customer id
    if (!byCustomer.has(ck)) byCustomer.set(ck, { qbId: lo.qbId, customerId: lo.customerId, txs: [] });
    byCustomer.get(ck).txs.push(lo);
  }

  const forwardPayments = [];
  const unappliedCredits = [];

  for (const [ck, info] of byCustomer.entries()) {
    const qbId = info.qbId || info.customerId;
    if (!qbId) {
      info.txs.forEach((lo) => unappliedCredits.push(makeCredit(lo)));
      continue;
    }
    let futureInvs;
    try {
      futureInvs = await fetchFutureInvoices(qbId, today);
    } catch (e) {
      console.error(`[forward-pay] failed to fetch future invoices for ${qbId}:`, e.message);
      info.txs.forEach((lo) => unappliedCredits.push(makeCredit(lo)));
      continue;
    }
    // FIFO going forward: oldest future invoice (closest day) first.
    futureInvs.sort((a, b) => new Date(a.txnDate) - new Date(b.txnDate));
    // Sort txs oldest-first so earliest payments consume forward invoices first.
    info.txs.sort((a, b) => (a.txDate || '').localeCompare(b.txDate || ''));
    let invIdx = 0;
    for (const lo of info.txs) {
      let amt = lo.leftover;
      while (amt > 0 && invIdx < futureInvs.length) {
        const inv = futureInvs[invIdx];
        if (inv.remainingBalance <= 0) { invIdx++; continue; }
        const pay = Math.min(amt, inv.remainingBalance);
        forwardPayments.push({
          customerName: lo.customerName,
          invoiceNo: inv.docNumber,
          amount: pay,
          memo: lo.transactionId,
          memoWithSuffix: lo.memoWithSuffix,
          channel: lo.channel,
          customerId: lo.customerId,
          qbId: lo.qbId,
          qbInvoiceId: inv.id,
          sheet_row_number: lo.sheet_row_number,
          forwardPaid: true,  // tag so the upload logs distinguish phase-2 lines
        });
        inv.remainingBalance -= pay;
        amt -= pay;
        if (inv.remainingBalance <= 1) { inv.remainingBalance = 0; invIdx++; }
      }
      if (amt > 0) {
        // Out of future invoices for this customer — remaining = credit.
        unappliedCredits.push(makeCredit({ ...lo, leftover: amt }));
      }
    }
  }
  return { forwardPayments, unappliedCredits };
}

function makeCredit(lo) {
  return {
    customerName: lo.customerName,
    customerId: lo.customerId,
    qbId: lo.qbId,
    channel: lo.channel,
    transactionId: lo.transactionId,
    memoWithSuffix: lo.memoWithSuffix,
    sheet_row_number: lo.sheet_row_number,
    amount: lo.leftover,
    txDate: lo.txDate,
    isCredit: true,
  };
}

/**
 * One-shot fetch: QB Invoices for a customer with TxnDate > today AND
 * Balance > 0. Returns minimal shape needed for forward-pay.
 *
 * NOTE: hits QB live. Could be mirror-backed later — kept live here so
 * forward-pay always sees the freshest invoice state.
 */
async function fetchFutureInvoices(qbCustomerId, today) {
  const sql = `SELECT Id, TxnDate, DocNumber, TotalAmt, Balance ` +
              `FROM Invoice WHERE CustomerRef = '${qbCustomerId}' ` +
              `AND TxnDate > '${today}' AND Balance > '0' ` +
              `MAXRESULTS 1000`;
  const r = await qbQuery(sql);
  const rows = r.QueryResponse?.Invoice || [];
  return rows.map((i) => ({
    id: String(i.Id),
    txnDate: i.TxnDate,
    docNumber: i.DocNumber,
    totalAmt: Number(i.TotalAmt) || 0,
    remainingBalance: Number(i.Balance) || 0,
  }));
}

/**
 * Drop-in replacement for sacred `processInvoicePayments`.
 *
 * Returns the SAME flat-array shape — array of payment-line records, with
 * `isUnused: true` on entries that the downstream should treat as credit /
 * unapplied. The shape contract is identical so the downstream QB push
 * code in payment-batches.js doesn't need any further change.
 *
 * Internally runs:
 *   1. processInvoicePaymentsV2 (cap-no-overflow) → Phase 1 payments + per-tx leftover
 *   2. forwardPayLeftover (Phase 2)               → Phase 2 forward payments + credits
 *   3. Merges all three streams back into one flat array.
 *
 * The downstream groups records by transactionId (via memoWithSuffix) to
 * build one QB Payment per bank tx — so Phase 1 + Phase 2 lines for the
 * same tx automatically end up on the same Payment with extra Lines, and
 * any unapplied credit on that same Payment appears in QB's UnappliedAmt.
 * Search-by-ref still works (PrivateNote unchanged).
 */
export async function processInvoicePaymentsWithForwardPay(invoices, transactions, opts = {}) {
  const { payments, leftoverPerTx } = processInvoicePaymentsV2(invoices, transactions);

  let forwardPayments = [];
  let unappliedCredits = [];
  if (leftoverPerTx.length > 0) {
    const todayIso = opts.todayIso || new Date().toISOString().slice(0, 10);
    const res = await forwardPayLeftover(leftoverPerTx, { todayIso });
    forwardPayments = res.forwardPayments;
    unappliedCredits = res.unappliedCredits;
  }

  // Merge back into a single flat array matching the sacred-function shape:
  //   - phase 1 payments (already legacy-shape, isUnused undefined → "paid")
  //   - phase 2 forward payments (same shape, with forwardPaid:true tag)
  //   - unapplied credits (isUnused:true so existing "unused" pipeline picks them up)
  return [
    ...payments,
    ...forwardPayments,
    ...unappliedCredits.map((c) => ({
      customerName: c.customerName,
      invoiceNo: 'UNUSED',
      amount: c.amount,
      transactionAmount: c.amount,
      memo: c.transactionId,
      memoWithSuffix: c.memoWithSuffix,
      channel: c.channel,
      customerId: c.customerId,
      qbId: c.qbId,
      sheet_row_number: c.sheet_row_number,
      isUnused: true,
      isCredit: true,  // tag so logs / dashboard can distinguish "matched-customer credit"
                       // from "no-customer-found" UNUSED rows.
    })),
  ];
}
