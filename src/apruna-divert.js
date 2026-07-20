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
import { writeSheetCells } from './sheets.js';
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
export async function divertAprunaTxns(txns, { channel, sheetId, tab, tickName, txnDate: fireTxnDate }) {
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

  // Track sheet-row marker writes so we can batch them at end of loop
  // (one writeSheetCells call for the whole tick vs one per row).
  const markerWrites = []; // { row, payment_entry_id, iso }

  for (const t of txns) {
    const m = await matchAprunaTxn(t);
    if (!m) { qbTxns.push(t); continue; }
    results.matched++;

    // physical = row's bank calendar day EAT (used for allocation ordering:
    // TODAY vs OLDER ARREARS vs FORWARD in foldAllocations).
    // rowTxnDate = row's kili-adjusted date (legacy fallback for callers that
    // don't pass a fire txnDate — Frank 2026-07-20 wants callers to pass the
    // FIRE's txnDate so the Frappe posting_date reflects when we booked,
    // not the row's bank-clock date, so already-closed periods don't get
    // late payments).
    const { physical, txnDate: rowTxnDate } = daysFromTs(t.receivedTimestamp);
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
      // Prefer the caller's fire txnDate (from computeCatchupPlan's kili-adjusted
      // firing business day); fall back to row's own kili-adjusted date if the
      // caller didn't pass one (backwards-compat for pre-2026-07-20 callers).
      const postDate = fireTxnDate || rowTxnDate;
      const body = {
        customer, amount, date: postDate, txn_id: String(bankRef), mode_of_payment: mode,
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
      // Queue sheet I+J marker for this row so operators can SEE Frappe-routed
      // rows on the sheet (previously they showed as unprocessed, causing
      // Frank's 2026-07-19 "why no marker" investigation). Frappe returns
      // { message: { status, payment_entry } } from ingest_payment — fall back
      // to 'FRAPPE_OK' if the shape changes.
      if (t.sheet_row_number) {
        const pe = resp?.payment_entry || resp?.name || resp?.entry || 'FRAPPE_OK';
        markerWrites.push({
          row: t.sheet_row_number,
          payment_entry_id: String(pe),
          iso: new Date().toISOString(),
        });
      }
    } catch (err) {
      console.error(`[apruna-divert] push failed for ${bankRef} (${customer}) — falling through to QB: ${err.message}`);
      qbTxns.push(t); results.failed++;
    }
  }

  // Flush I + J markers for all successfully-diverted rows in one call.
  // Column I: "Fetched at: {iso} (FRAPPE)"  → distinguishes from QB rows
  // Column J: "FRAPPE:{payment_entry} | {iso}"  → sheet-visible landing proof
  // Non-fatal: divert already succeeded server-side and consumed_transactions
  // has the ref — sheet-marker failure just means operators re-see the row.
  if (sheetId && tab && markerWrites.length > 0) {
    const updates = [];
    for (const u of markerWrites) {
      updates.push({ range: `${tab}!I${u.row}`, value: `Fetched at: ${u.iso} (FRAPPE)` });
      updates.push({ range: `${tab}!J${u.row}`, value: `FRAPPE:${u.payment_entry_id} | ${u.iso}` });
    }
    try {
      const r = await writeSheetCells(sheetId, updates);
      console.log(`[apruna-divert] wrote I+J markers for ${markerWrites.length} Frappe rows (${r.updatedCells || '?'} cells) tab=${tab}`);
    } catch (err) {
      console.error(`[apruna-divert] I+J marker-write failed (non-fatal): ${err.message}`);
    }
  }

  // Note: apruna-divert-* batches stay in 'pending' — they're per-day
  // rollups that additional fires (evening / heisenberg / catchup) may
  // append to. Reconciliation queries filter by channel prefix 'frappe_'.

  console.log(`[apruna-divert] ${channel} tick=${tickName || '?'}: matched=${results.matched} pushed=${results.pushed} fell_through=${results.fallthrough + results.failed} (qb_txns=${qbTxns.length}/${txns.length})`);
  return { qbTxns, aprunaResults: results };
}
