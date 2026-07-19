// ───────────────────────────────────────────────────────────────────────────
// APRUNA Frappe-only divert
//
// Called by prepareAutoUpload after raw txns are built from the sheet, BEFORE
// the QB path (dedup / QB dup-check / invoice-payment-app / QB Payment).
//
// For each txn: check plate (or phone/memo) against the APRUNA roster. If
// matched, route it to Frappe:
//   - Fetch that customer's open invoices from Frappe
//   - Allocate per sacred rule: TODAY → oldest ARREARS → oldest FORWARD
//     using PHYSICAL payment day (kili1615 doesn't shift bucket key)
//   - POST elegansky.api.ingest_payment with explicit allocations + txn_id
//     (Frappe dedupes on txn_id server-side, retries are safe)
//   - INSERT consumed_transactions so future fires skip this ref
//
// Feature-flagged: only runs when APRUNA_DIVERT_ENABLED === 'true'. Off by
// default. If disabled OR roster fetch throws OR any push throws for a given
// txn, that txn FALLS THROUGH to the QB path (status quo — worst case it
// lands in FAILED and needs backfill).
//
// Non-APRUNA txns are never touched.
// ───────────────────────────────────────────────────────────────────────────

import { db } from './db/pool.js';
import { getAprunaCache, resolveAprunaAny } from './apruna-resolver.js';
import { ingestPayment, getOpenInvoices } from './frappe-client.js';
import { randomUUID } from 'node:crypto';

const KILI_MIN = 16 * 60 + 15; // 16:15 EAT

function isEnabled() {
  return String(process.env.APRUNA_DIVERT_ENABLED || '').toLowerCase() === 'true';
}

function modeForChannel(channel) {
  if (channel === 'nmbnew') return 'NMB';
  if (channel === 'bank') return 'CRDB';
  if (channel === 'iphone_bank') return 'iPhone';
  return 'Cash';
}

// EAT physical day + kili-adjusted TxnDate from a receivedTimestamp (ms).
// If ts is null (bad-format date row), fall back to today's UTC date.
function daysFromTs(ts) {
  const base = ts ? new Date(ts) : new Date();
  const eatMs = base.getTime() + 3 * 3600 * 1000;
  const eat = new Date(eatMs);
  const physical = eat.toISOString().slice(0, 10); // YYYY-MM-DD
  const totalMin = eat.getUTCHours() * 60 + eat.getUTCMinutes();
  let txnDate;
  if (totalMin < KILI_MIN) txnDate = physical;
  else {
    const roll = new Date(eatMs + 86400000);
    txnDate = roll.toISOString().slice(0, 10);
  }
  return { physical, txnDate };
}

function extractPhoneFromMemo(memo) {
  if (!memo) return null;
  const digits = String(memo).replace(/\D/g, '');
  if (digits.length < 9) return null;
  return digits.slice(-9);
}

/**
 * Try to match a txn to an APRUNA customer using the strongest signal first.
 * Returns { entry, matchedVia: 'plate'|'qb_id'|'phone' } or null.
 */
async function matchAprunaTxn(txn) {
  // txn shape (as built in prepareAutoUpload):
  //   customerPhone -> actually plate (col F) per legacy naming
  //   customerName  -> resolved customer name from sheet col G (set by scraper /
  //                    invoice-payment-app during resolution — same string the
  //                    QB DisplayName would be, usually matches Frappe customer
  //                    name exactly for the ~207 old APRUNA without plate).
  //   transactionId -> bank_ref (col H)
  const plate = txn.customerPhone || null; // legacy field carries plate
  const name = txn.customerName || txn.contractName || null;
  const r = await resolveAprunaAny({ plate, name });
  if (r) return { entry: r, matchedVia: plate && r.plate ? 'plate' : 'name' };
  return null;
}

function foldAllocations(openInvoices, amount, physicalDay) {
  const all = (openInvoices || []).filter((x) => Number(x.outstanding_amount || 0) > 0);
  const today   = all.filter((x) => (x.posting_date || '') === physicalDay)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const arrears = all.filter((x) => (x.posting_date || '') < physicalDay)
    .sort((a, b) => (a.posting_date || '').localeCompare(b.posting_date || '') || String(a.name).localeCompare(String(b.name)));
  const forward = all.filter((x) => (x.posting_date || '') > physicalDay)
    .sort((a, b) => (a.posting_date || '').localeCompare(b.posting_date || '') || String(a.name).localeCompare(String(b.name)));
  const ordered = [...today, ...arrears, ...forward];
  let remain = amount;
  const plan = [];
  for (const iv of ordered) {
    if (remain <= 0) break;
    const out = Number(iv.outstanding_amount || 0);
    if (out <= 0) continue;
    const alloc = Math.min(remain, out);
    plan.push({ reference_doctype: 'Sales Invoice', reference_name: iv.name, allocated_amount: alloc });
    remain -= alloc;
  }
  return { plan, remain };
}

async function ensureFrappeBatch(channel, txnDate) {
  // Reuse today's frappe channel batch if it exists, else create one.
  const frappeChannel = channel === 'bank' ? 'frappe_crdb'
                       : channel === 'nmbnew' ? 'frappe_nmb'
                       : channel === 'iphone_bank' ? 'frappe_iphone'
                       : 'frappe_other';
  const idem = `apruna-divert-${txnDate}-${frappeChannel}`;
  const existing = await db().query(
    `SELECT id::text FROM payment_batches WHERE idempotency_key = $1`, [idem],
  );
  if (existing.rows.length) return { id: existing.rows[0].id, created: false };
  const id = randomUUID();
  await db().query(
    `INSERT INTO payment_batches (id, idempotency_key, status, sheet_id, sheet_tab, channel, bank_refs, sheet_total, paid_total, unused_total, paid_count, unused_count, txn_date)
     VALUES ($1,$2,'pending','','', $3, ARRAY[]::text[], 0, 0, 0, 0, 0, $4::date)`,
    [id, idem, frappeChannel, txnDate],
  );
  return { id, created: true };
}

/**
 * Split txns[] into aprunaTxns + qbTxns. For each aprunaTxn, do the full
 * Frappe push (allocations + ingest_payment + consumed_transactions). Return
 * both lists so caller keeps qbTxns for the QB path.
 *
 * If the feature flag is off, this is a no-op: returns everything as qbTxns.
 * Any per-txn failure logs + falls through to qbTxns (safest default).
 */
export async function divertAprunaTxns(txns, { channel, sheetId, tab, tickName }) {
  if (!isEnabled()) return { qbTxns: txns, aprunaResults: null, skipped: 'flag_off' };
  if (!Array.isArray(txns) || txns.length === 0) return { qbTxns: txns, aprunaResults: null, skipped: 'empty' };

  let roster;
  try {
    roster = await getAprunaCache();
    if (!roster || roster.byPlate.size === 0) return { qbTxns: txns, aprunaResults: null, skipped: 'empty_roster' };
  } catch (err) {
    console.error(`[apruna-divert] roster fetch failed — falling through to QB: ${err.message}`);
    return { qbTxns: txns, aprunaResults: null, skipped: 'roster_error' };
  }

  const qbTxns = [];
  const results = { matched: 0, pushed: 0, failed: 0, fallthrough: 0, details: [] };
  const mode = modeForChannel(channel);

  for (const t of txns) {
    const m = await matchAprunaTxn(t);
    if (!m) { qbTxns.push(t); continue; }
    results.matched++;

    const { physical, txnDate } = daysFromTs(t.receivedTimestamp);
    const bankRef = t.transactionId;
    if (!bankRef) {
      console.warn(`[apruna-divert] APRUNA match but no bank_ref — falling through to QB: ${JSON.stringify(t).slice(0,120)}`);
      qbTxns.push(t); results.fallthrough++; continue;
    }
    const customer = m.entry.customer || m.entry.display_name;
    const amount = Number(t.amount || 0);
    if (!customer || !amount || amount <= 0) {
      console.warn(`[apruna-divert] missing customer/amount for ref ${bankRef} — falling through to QB`);
      qbTxns.push(t); results.fallthrough++; continue;
    }

    try {
      const inv = await getOpenInvoices(customer);
      const { plan, remain } = foldAllocations(inv?.invoices || [], amount, physical);
      const body = {
        customer, amount, date: txnDate, txn_id: String(bankRef), mode_of_payment: mode,
        allocations: plan.map((a) => ({ reference_doctype: 'Sales Invoice', reference_name: a.reference_name, allocated_amount: a.allocated_amount })),
      };
      const resp = await ingestPayment(body);
      const status = resp?.status || 'ok';
      // consumed_transactions gate
      const batch = await ensureFrappeBatch(channel, txnDate);
      const tsIso = t.receivedTimestamp ? new Date(t.receivedTimestamp).toISOString() : new Date().toISOString();
      await db().query(
        `INSERT INTO consumed_transactions (batch_id, bank_ref, consumed_at, sheet_ts) VALUES ($1,$2,NOW(),$3::timestamptz) ON CONFLICT DO NOTHING`,
        [batch.id, bankRef, tsIso],
      );
      await db().query(
        `UPDATE payment_batches SET bank_refs = array_append(bank_refs, $1), paid_total = paid_total + $2, paid_count = paid_count + 1, sheet_total = sheet_total + $2 WHERE id = $3`,
        [bankRef, amount, batch.id],
      );
      results.pushed++;
      results.details.push({ bank_ref: bankRef, customer, amount, matched_via: m.matchedVia, status, allocs: plan.length, unallocated: remain });
    } catch (err) {
      console.error(`[apruna-divert] push failed for ${bankRef} (${customer}) — falling through to QB: ${err.message}`);
      qbTxns.push(t); results.failed++;
    }
  }

  // Note: apruna-divert-* batches stay in 'pending' — they're per-day
  // rollups that additional fires (evening / heisenberg / catchup) may
  // append to. Reconciliation queries filter by channel prefix 'frappe_'.

  console.log(`[apruna-divert] ${channel} tick=${tickName || '?'}: matched=${results.matched} pushed=${results.pushed} fell_through=${results.fallthrough + results.failed} (qb_txns=${qbTxns.length}/${txns.length})`);
  return { qbTxns, aprunaResults: results };
}
