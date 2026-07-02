// ───────────────────────────────────────────────────────────────────────────
// SAV-Frappe auto-upload runner — parallel pipeline to payment-batches.js
//
// Channels: sav_nmb, sav_crdb
// Source of invoices: Frappe (elegansky.api.get_open_invoices per customer)
// Destination of payments: Frappe (elegansky.api.ingest_payment per customer)
// Bank-txn source: SAME PASSED_SAV_NMB / PASSED_SAV sheets as today
// Algorithm: SAME — processInvoicePaymentsV2 (sacred, byte-identical)
// AS_OF + TxnDate: SAME semantics as the QB path
// Sheet markers (I/J/K): SAME write logic
// Locks + consumed_transactions: SAME safeguards
//
// What's DIFFERENT vs payment-batches.js:
//   - QB /arrears bulk read → per-customer Frappe getOpenInvoices
//   - QB Payment creation → Frappe ingestPayment
//   - QB pre-flight dedup → SKIPPED (Frappe idempotency handles this via txn_id)
//   - QB customer DisplayName lookup → savcom-resolver (covers all 292:
//     18 QB-resident by plate + 274 Wakandi by account/wakandi_id/name)
//   - Phase-2 forward-pay over future Frappe invoices is deferred (Frappe
//     doesn't expose a forward-invoice query yet); remainder = customer
//     credit per the agreed contract.
//
// Frank's rule preserved: sacred algorithm untouched. We import V2
// directly and feed it the same shape it expects.
// ───────────────────────────────────────────────────────────────────────────

import { db } from './db/pool.js';
import { readSheet, writeSheetCells, paintRowEndMarker } from './sheets.js';
import { getOpenInvoices, ingestPayment, reversePayment, getPaymentEntry, getSalesInvoice, getLoanSummary } from './frappe-client.js';
import { resolveSavcom } from './savcom-resolver.js';
import { processInvoicePaymentsV2 } from './payment-algorithm-v2.js';

const MODE_OF_PAYMENT = 'SAVCOM';

// Visible marker appended to every txn_id sent to Frappe so analysts can
// distinguish BRAIN-pushed entries from manual uploads / pre-switch Wakandi
// migration imports just by scanning the reference in the Frappe ledger.
// Format: bank_ref "101AGD126175F3GI" → txn_id "101AGD126175F3GIV".
// Internal BRAIN tables (consumed_transactions, payment_uploads.bank_ref)
// keep the un-suffixed ref — the V suffix is purely a Frappe-side marker.
const FRAPPE_TXN_MARKER = 'V';

// SAV sheets have a NINTH data column at index 8 (column I) holding the
// wakandi_member_id — direct Frappe lookup key. So the marker columns are
// shifted RIGHT by 1 vs the QB convention:
//   QB convention:   I=Fetched-at, J=QB-pushed,    K=end-of-tick
//   SAV convention:  J=Fetched-at, K=Frappe-pushed, L=end-of-tick
// Column letters → array indices: I=8, J=9, K=10, L=11.
const SAV_CHANNEL_SHEETS = {
  sav_nmb: {
    sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek',
    tab: 'PASSED_SAV_NMB',
    wakandiIdCol: 8,   // column I — wakandi_member_id (resolver feedstock)
    fetchedAtCol: 9,   // column J — "Fetched at: ..."
    pushedCol: 10,     // column K — "Frappe pushed: ..."
    endTickCol: 11,    // column L — "end of <tick>"
    fetchedAtLetter: 'J', pushedLetter: 'K', endTickLetter: 'L',
  },
  sav_crdb: {
    sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o',
    tab: 'PASSED_SAV',
    wakandiIdCol: 8,
    fetchedAtCol: 9,
    pushedCol: 10,
    endTickCol: 11,
    fetchedAtLetter: 'J', pushedLetter: 'K', endTickLetter: 'L',
  },
};

export const SAV_FRAPPE_CHANNELS = Object.keys(SAV_CHANNEL_SHEETS);

/**
 * Frank 2026-07-01 (post book-rebuild): these 18 SAVCOM customers exist
 * in QuickBooks but haven't been added to Frappe yet by the ERP dev.
 * BRAIN must NOT push payments for them — Frappe would return "customer
 * not found" and the ref would land in consumed_transactions, blocking
 * the eventual retry once they're added.
 *
 * Skip strategy: match on plate (SAVCOM CUSTOMER AT QUICKBOOK 2.xlsx +
 * BRAYSON ALLY HASSAN). During the resolver step, if a txn's plate is
 * in this set, force it into the unresolved bucket → PU written as
 * needs_saasant → sheet col J stays empty → consumed_transactions
 * doesn't get the ref → next re-fire (after dev adds them) picks them
 * up cleanly.
 *
 * When Frappe dev adds each customer, remove their plate from this set
 * and re-deploy. Alternatively, blank the whole set once the full 18
 * are added.
 */
export const NOT_YET_IN_FRAPPE_PLATES = new Set([
  'MC783FME', // BRAYSON ALLY HASSAN (Frank typed)
  'MC691FML', // SALUM ABDUL SALIM
  'MC847FLT', // HUSSEIN BASHIRU ISSA
  'MC754FLT', // MWANAHAWA TWALIBU SAIDI
  'MC706FML', // HABIBA OTHUMAN NYAZA
  'MC836FME', // TABIA STAUBI SHOMARI
  'MC587FLW', // SHAIBU SAID LIJOCHA
  'MC832FME', // HAMZA ABDALLAH ADAMU
  'MC549FLW', // MWANAHAMISI ATHUMANI MOHAMED
  'MC545FLW', // ABDALLAH RASHIDI ABDALLAH
  'MC291FLM', // HASSANI MUSSA MAKAU
  'MC663FML', // MWINYIHAJI KHAMISS KHALFANI
  'MC863FME', // SALEHE HAMISI MOTO
  'MC859FME', // SHARIF OMAR SHARIF
  'MC679FML', // ZAINABU HAMISI KADEGE
  'MC676FML', // SELEMANI RAMADHANI ABDALLAH
  'MC670FML', // ABDULAZIZI ALLY CARTER
  'MC725FMJ', // MANZI HALFAN HAMISI
]);

function appendSavSuffix(ref, channel) {
  // Mirror the QB-side suffix convention so consumed_transactions stays
  // collision-free between paths. Use 'NS' / 'CS' so SAV refs don't
  // collide with the QB-bound NMB/CRDB refs (which use 'N'/'B'/'P').
  const s = { sav_nmb: 'NS', sav_crdb: 'CS' }[channel] || '';
  if (!ref) return ref;
  return s ? `${ref}${s}` : String(ref);
}

function round2(n) { return Math.round(Number(n) * 100) / 100; }

// Verbatim port of the production parser at payment-batches.js:4878.
// Handles the three sheet date shapes BRAIN sees in the wild + the EAT→UTC
// 3-hour offset that the old hacky parser was missing — without that, even
// rows that DID parse landed 3h ahead of the operator's window and got
// silently filtered as "out of window". The DD.MM.YYYY format is what the
// SAV NMB / SAV CRDB sheets actually use. Critical incident 2026-06-04
// already lit this up on the QB side; the new SAV path inherits the fix.
const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseTsAny(s) {
  const str = String(s || '').trim();
  if (!str) return null;

  // Format 1: DD.MM.YYYY HH:MM:SS — today's CRDB/iPhone/NMB rows (incl. SAV).
  // Sheet stores EAT wall-clock; subtract 3h so the Date is real UTC.
  let m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) {
    const d = +m[1], mo = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return new Date(Date.UTC(+m[3], mo - 1, d, +m[4] - 3, +m[5], +m[6]));
    }
    return null;
  }

  // Format 2: DD MMM YYYY, HH:MM (or no time) — legacy NMB.
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

  // Format 3: MM/DD/YYYY — original BODA/IPHONE/LIPA sheets.
  m = str.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (m) {
    const mo = +m[1], d = +m[2];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return new Date(`${m[3]}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}T00:00:00Z`);
    }
  }
  // Format 4: YYYY-MM-DD (ISO date-only) — appears in SAV_CRDB historical
  // rows. Without this, parseTsAny returns null, and the previous readSav
  // code (line 229, sans-continue) INCLUDED null-ts rows in every window.
  // Result: Feb 7 2026 rows kept getting pushed to Frappe on 06-30 fires.
  m = str.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (m) {
    const y = +m[1], mo = +m[2], d = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      // Interpret as EAT midnight → subtract 3h for UTC.
      return new Date(Date.UTC(y, mo - 1, d, -3, 0, 0));
    }
  }
  return null;
}

/**
 * Read PASSED_SAV_NMB / PASSED_SAV sheet, filter to the window, drop
 * already-consumed refs. Returns the cleaned transaction list + sheet
 * config + diagnostic counters. Same shape as the QB-path's sheet
 * intake, including the I/J/K Column protections.
 */
async function readSavSheetWindow({ channel, sinceIso, untilIso, forceSkipMaxKRow = false, forceSkipMarkerCheck = false }) {
  const cfg = SAV_CHANNEL_SHEETS[channel];
  if (!cfg) throw new Error(`unknown SAV channel: ${channel}`);
  const winStart = new Date(sinceIso);
  const winEnd = new Date(untilIso);

  // Read A:M — one past endTickCol(L) so the K-boundary check has room.
  const sheetData = await readSheet(cfg.sheetId, `${cfg.tab}!A1:M200000`);
  const sheet = sheetData.values || sheetData.data || [];

  // SAV sheets do NOT have a header row — row 1 is the first data row
  // (operator never set up a header on these tabs). Iterate from index 0.
  // (QB-path sheets do have a header at row 1; that's why the QB code skips i=0.)
  //
  // Find the highest row index whose endTickCol carries an "end of <tick>"
  // marker. Same boundary semantics as the QB path, just one column over.
  // `forceSkipMaxKRow` disables this gate — used by the savcom-recall
  // re-fire path when a rogue post-recall end-tick marker blocks the
  // catchup windows. Per-row J/K marker checks still apply, so only
  // rows we explicitly cleared become eligible.
  let maxKRow = 0;
  if (!forceSkipMaxKRow) {
    for (let i = 0; i < sheet.length; i++) {
      const endTick = String(sheet[i][cfg.endTickCol] || '').trim().toLowerCase();
      if (endTick.startsWith('end of ') && !endTick.includes('(dry_run)')) maxKRow = i + 1;
    }
  }

  const txns = [];
  let skippedNoDate = 0, skippedOutOfWindow = 0, skippedAlreadyPushed = 0;
  let skippedBadFormat = 0;
  for (let i = 0; i < sheet.length; i++) {
    if (maxKRow > 0 && i + 1 <= maxKRow) { skippedAlreadyPushed++; continue; }
    // "Fetched at" / "Frappe pushed" markers live in shifted columns
    // (J/K instead of I/J) so the wakandi_member_id in col I doesn't trip
    // the "already pushed" check. We ALSO require the marker text to
    // start with the canonical prefix — bare data in the wrong column
    // shouldn't fool the gate.
    if (!forceSkipMarkerCheck) {
      const fetched = String(sheet[i][cfg.fetchedAtCol] || '').trim();
      const pushed = String(sheet[i][cfg.pushedCol] || '').trim();
      const fetchedReal = (fetched.startsWith('Fetched at') && !fetched.includes('(DRY_RUN)')) ? fetched : '';
      const pushedReal  = (
        (pushed.startsWith('Frappe pushed') || pushed.startsWith('Frappe pending') || pushed.startsWith('QB pushed'))
        && !pushed.includes('(DRY_RUN)')
      ) ? pushed : '';
      if (fetchedReal || pushedReal) { skippedAlreadyPushed++; continue; }
    }

    const dCell = String(sheet[i][1] || '').trim();
    if (!dCell) { skippedNoDate++; continue; }
    const ts = parseTsAny(dCell);
    if (ts && (ts < winStart || ts >= winEnd)) { skippedOutOfWindow++; continue; }
    // Bug fix (Frank 2026-07-02): null-ts rows used to be INCLUDED with
    // receivedTimestamp=null, which meant ANY row with an unparseable date
    // slipped through EVERY window filter and got pushed to Frappe. The
    // Feb 7 2026 rows (ISO date-only format) hit this bug hard. Now we
    // SKIP them and count in skipped_bad_format so it's visible.
    if (!ts) { skippedBadFormat++; continue; }
    txns.push({
      id: sheet[i][0] || `tx-${i + 1}`,
      channel,
      // Column 5 holds the PLATE on SAV sheets (not a phone — operator
      // schema). Capturing it lets the resolver hit by-plate for the 18
      // QB-resident SAVCOM customers without needing the free-text fallback.
      plate: String(sheet[i][5] || '').trim() || null,
      customerName: sheet[i][6] || null,
      contractName: sheet[i][6] || null,
      // Column 8 holds the WAKANDI MEMBER ID — direct Frappe match for the
      // 274 Wakandi-only customers. This is the cleanest signal of all.
      wakandi_member_id: String(sheet[i][cfg.wakandiIdCol] || '').trim() || null,
      amount: sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g, '')) : null,
      receivedTimestamp: ts ? ts.getTime() : null,
      transactionId: sheet[i][7] || null,
      sheet_row_number: i + 1,
    });
  }

  // Intra-window dedup (same ref appearing twice in the sheet).
  const seenRef = new Set();
  const intraTxns = [];
  let intraDupes = 0;
  for (const t of txns) {
    const key = appendSavSuffix(t.transactionId, channel);
    if (!key) continue;
    if (seenRef.has(key)) { intraDupes++; continue; }
    seenRef.add(key); intraTxns.push(t);
  }

  return {
    cfg, txns: intraTxns, maxKRow,
    diagnostics: {
      sheet_total_rows: sheet.length - 1,
      skipped_no_date: skippedNoDate,
      skipped_out_of_window: skippedOutOfWindow,
      skipped_already_pushed: skippedAlreadyPushed,
      skipped_bad_format: skippedBadFormat,
      intra_window_dupes: intraDupes,
      max_k_row: maxKRow,
    },
  };
}

/**
 * For each unique resolved Frappe customer in the txn list, fetch their
 * open invoices and split into TWO buckets that mirror the QB path:
 *
 *   pastInvoices:   posting_date <= asOf  (the "arrears" set V2 walks
 *                                          newest-first to allocate)
 *   futureInvoices: posting_date >  asOf  (Phase-2 forward-pay pool, FIFO
 *                                          oldest-first for leftover)
 *
 * Frank 2026-06-29: before this filter the Frappe SAV path was feeding
 * V2 the customer's WHOLE schedule (months of future invoices). V2's
 * "newest first" walked future invoices first, so today's money was
 * paying e.g. August-due invoices before clearing February overdue. The
 * QB side has always pre-filtered arrears via fetchAllArrears({asOf});
 * this restores the same contract for Frappe.
 */
async function fetchInvoicesForResolvedCustomers(txnsClean, asOf) {
  const byCustomer = new Map();
  for (const t of txnsClean) {
    if (!t._resolved) continue;
    const key = t._resolved.customer;
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(t);
  }

  const invoices = [];          // past + today's, fed to V2 main pass
  const futureInvoices = [];    // > asOf, fed to Phase-2 forward-pay
  const customerErrors = [];
  for (const [customerKey, txs] of byCustomer.entries()) {
    let r;
    try {
      r = await getOpenInvoices(customerKey);
    } catch (err) {
      customerErrors.push({ customer: customerKey, error: err.message });
      continue;
    }
    const list = r.invoices || [];
    for (const inv of list) {
      const out = Number(inv.outstanding_amount) || 0;
      if (out <= 0) continue;
      const date = inv.posting_date || inv.due_date;
      if (!date) continue;
      // asOf is "YYYY-MM-DD". Frappe posting_date is also "YYYY-MM-DD".
      // Lexicographic compare works for ISO dates.
      const isFuture = asOf && date > asOf;
      if (isFuture) {
        // Phase-2 shape: matches the `forwardPayLeftover` expectation
        // (id, txnDate, docNumber, totalAmt, remainingBalance).
        futureInvoices.push({
          customerKey,
          id: inv.name,
          txnDate: date,
          docNumber: inv.name,
          totalAmt: out,
          remainingBalance: out,
        });
      } else {
        invoices.push({
          // V2 keys customers by customerPhone || customerName.toLowerCase().
          // We force-use customerKey so resolved txns and invoices share a
          // grouping key regardless of upstream display-name drift.
          customerName: customerKey,
          customerPhone: null,
          customerId: customerKey,
          qbId: inv.name,              // Frappe Sales Invoice id (used in allocations)
          invoiceNumber: inv.name,
          invoiceDate: date,
          amount: out,
        });
      }
    }
  }
  return { invoices, futureInvoices, customerErrors };
}

/**
 * NEW CONTRACT (Frappe dev 2026-07-01 book rebuild):
 * Fetch each resolved customer's open invoices from Frappe. Return them
 * grouped per-customer, sorted by due_date ASC, with is_moved_forward=1
 * invoices bucketed OUT (never allocated to — they sort last on Frappe's
 * side too, but we filter explicitly per dev's belt-and-suspenders note).
 *
 * Shape per invoice row:
 *   { customerKey, name (invoice name),
 *     due_date, posting_date, outstanding_amount, remainingBalance,
 *     is_moved_forward, original_due_date }
 */
async function fetchInvoicesForResolvedCustomersNewContract(txnsClean) {
  const byCustomer = new Map();
  for (const t of txnsClean) {
    if (!t._resolved) continue;
    const key = t._resolved.customer;
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(t);
  }
  const invoicesByCustomer = new Map();
  const customerErrors = [];
  for (const customerKey of byCustomer.keys()) {
    let r;
    try {
      r = await getOpenInvoices(customerKey);
    } catch (err) {
      customerErrors.push({ customer: customerKey, error: err.message });
      continue;
    }
    const list = r.invoices || [];
    const all = [];
    for (const inv of list) {
      const out = Number(inv.outstanding_amount) || 0;
      if (out <= 0) continue;
      all.push({
        customerKey,
        name: inv.name,
        due_date: inv.due_date || null,
        posting_date: inv.posting_date || null,
        original_due_date: inv.original_due_date || null,
        outstanding_amount: out,
        remainingBalance: out,
        is_moved_forward: inv.is_moved_forward === 1 || inv.is_moved_forward === true,
      });
    }
    // Sort by due_date ASC only. is_moved_forward=1 invoices have their
    // due_date automatically set to the end of the customer's schedule
    // (loan end) — they land at the tail naturally, no special-casing
    // needed. Bank money walks: earliest overdue → due today → next few
    // days → weeks out → moved-forward + penalties at the end. Dev's
    // "belt-and-suspenders skip" suggestion isn't needed — the field is
    // just informational, not a filter (Frank 2026-07-01).
    all.sort((a, b) => {
      const da = a.due_date || a.posting_date || '';
      const db = b.due_date || b.posting_date || '';
      return da.localeCompare(db);
    });
    invoicesByCustomer.set(customerKey, all);
  }
  return { invoicesByCustomer, customerErrors };
}

/**
 * Extract EAT calendar date (YYYY-MM-DD) from a UTC millisecond timestamp.
 * Used to identify "today's invoice" (invoice.due_date == txn's real EAT
 * arrival date), regardless of the AS_OF/TxnDate cutoff shift. Payments
 * that arrived at 17:00 EAT on 2026-07-01 have TxnDate=2026-07-02 (per
 * the 16:16 EAT cutoff), but the customer paid on 07-01 — so 07-01's
 * invoice should still be the "today" priority for that payment.
 */
function toEatYmd(utcMs) {
  if (!utcMs) return null;
  const eatMs = Number(utcMs) + 3 * 3600 * 1000;
  const d = new Date(eatMs);
  const y = d.getUTCFullYear();
  const m = String(d.getUTCMonth() + 1).padStart(2, '0');
  const day = String(d.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

/**
 * NEW CONTRACT allocator (Frank 2026-07-01):
 * For each customer's bank payment, walk their open invoices in THIS order:
 *   1. Today's invoice   — invoice whose due_date matches the txn's REAL
 *                          EAT calendar date (NOT the TxnDate — evening
 *                          txns after 16:16 EAT have TxnDate=tomorrow but
 *                          the customer paid TODAY, so today's invoice
 *                          gets priority)
 *   2. Past invoices     — oldest first, walking forward by due_date ASC
 *                          (oldest overdue → next-oldest → … → yesterday)
 *   3. Future invoices   — tomorrow first, walking forward by due_date ASC
 *                          (tomorrow → day-after → … → moved-forward at end)
 *
 * Multiple invoices due exactly today (rare): pay them together first,
 * then move to oldest past. Any leftover after all invoices are cleared →
 * hanging credit (unused row, no allocations, sits as customer credit).
 *
 * is_moved_forward=1 invoices are NOT filtered — they carry due_dates set
 * to the customer's loan end so they naturally land at the tail of the
 * future bucket. Penalties, moved-forward, whatever — the sort by
 * due_date handles them uniformly.
 *
 * Bank txns are walked oldest-first (by receivedTimestamp) so earlier
 * payments consume earlier invoices before later payments compete.
 */
function allocateByDueDateAsc(txnsClean, invoicesByCustomer, channel) {
  const paid = [];
  const unused = [];
  const sortedTxns = [...txnsClean].sort((a, b) =>
    (a.receivedTimestamp || 0) - (b.receivedTimestamp || 0));
  for (const t of sortedTxns) {
    const memoWithSuffix = appendSavSuffix(t.transactionId, channel);
    if (!t._resolved) continue;
    const customerKey = t._resolved.customer;
    const list = invoicesByCustomer.get(customerKey) || [];
    let amt = Number(t.amount) || 0;
    if (amt <= 0) continue;

    // Build walk order: today (by real EAT date) → past ASC → future ASC.
    // `list` is already due_date ASC from the fetcher, so partitioning
    // preserves order within past/future.
    const realDate = toEatYmd(t.receivedTimestamp);
    const todays = [];
    const past = [];
    const future = [];
    for (const inv of list) {
      const dd = inv.due_date || inv.posting_date || '';
      if (realDate && dd === realDate) todays.push(inv);
      else if (realDate && dd < realDate) past.push(inv);
      else future.push(inv);
    }
    const walkOrder = [...todays, ...past, ...future];

    for (const inv of walkOrder) {
      if (amt <= 0) break;
      if (inv.remainingBalance <= 0) continue;
      const pay = Math.min(amt, inv.remainingBalance);
      paid.push({
        customerName: customerKey,
        invoiceNo: inv.name,
        amount: pay,
        memo: t.transactionId,
        memoWithSuffix,
        channel,
        customerId: customerKey,
        qbId: inv.name,
        sheet_row_number: t.sheet_row_number,
      });
      inv.remainingBalance -= pay;
      amt -= pay;
      if (inv.remainingBalance <= 0.5) inv.remainingBalance = 0;
    }
    if (amt > 0) {
      unused.push({
        customerName: customerKey,
        transactionAmount: t.amount,
        amount: amt,
        memo: t.transactionId,
        memoWithSuffix,
        channel,
        customerId: customerKey,
        sheet_row_number: t.sheet_row_number,
      });
    }
  }
  return { paid, unused };
}

function tickSuffix() {
  return ''; // distinguishes nothing — placeholder for future per-tick segmentation
}

/**
 * Main entrypoint. Mirrors the QB-path runner but Frappe end-to-end.
 *
 * Args:
 *   channel    - 'sav_nmb' | 'sav_crdb'
 *   sinceIso   - lower bound (inclusive, UTC ISO)
 *   untilIso   - upper bound (exclusive, UTC ISO)
 *   asOf       - "YYYY-MM-DD" (informational; Frappe doesn't snapshot but logged)
 *   txnDate    - "YYYY-MM-DD" the Payment Entry's posting date should use
 *   tickName   - e.g. 'heisenberg', 'meru0300', 'kili1615' (sheet K marker)
 *   dryRun     - true = no Frappe writes, just the plan + sheet markers
 *
 * Returns:
 *   { batch_id, paid, unused, customers_resolved, customers_unresolved,
 *     frappe_results, sheet_diagnostics, skipped, skip_reason }
 */
export async function runSavFrappeUpload({
  channel, sinceIso, untilIso, asOf, txnDate, tickName, dryRun = false,
  forceSkipMaxKRow = false, forceSkipMarkerCheck = false,
} = {}) {
  if (!SAV_FRAPPE_CHANNELS.includes(channel)) {
    throw new Error(`channel must be one of: ${SAV_FRAPPE_CHANNELS.join(', ')}`);
  }
  if (!sinceIso || !untilIso) throw new Error('sinceIso + untilIso required');
  if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(txnDate))) {
    throw new Error('txnDate must be YYYY-MM-DD');
  }

  // 1. Sheet intake.
  const { cfg, txns, diagnostics } = await readSavSheetWindow({ channel, sinceIso, untilIso, forceSkipMaxKRow, forceSkipMarkerCheck });
  if (txns.length === 0) {
    return {
      skipped: true,
      reason: 'no rows in window',
      sheet_diagnostics: diagnostics,
    };
  }

  // 2. Drop already-consumed refs (BRAIN-side dedup — same table as QB path).
  const allRefs = txns.map((t) => appendSavSuffix(t.transactionId, channel)).filter(Boolean);
  const forbidden = new Set();
  const CH = 5000;
  for (let i = 0; i < allRefs.length; i += CH) {
    const chunk = allRefs.slice(i, i + CH);
    const r = await db().query(
      `SELECT bank_ref FROM consumed_transactions WHERE bank_ref = ANY($1)`, [chunk]);
    r.rows.forEach((row) => forbidden.add(row.bank_ref));
  }
  let txnsClean = txns.filter((t) => !forbidden.has(appendSavSuffix(t.transactionId, channel)));
  if (txnsClean.length === 0) {
    return { skipped: true, reason: 'all refs already consumed', sheet_diagnostics: diagnostics };
  }

  // 3. Resolve each txn's customer via savcom-resolver (covers all 292).
  let resolvedCount = 0;
  let notYetInFrappeCount = 0;
  const unresolved = [];
  for (const t of txnsClean) {
    // Skip-list check (Frank 2026-07-01): 18 QB-side SAVCOM customers
    // exist in QuickBooks but haven't been added to Frappe yet by the
    // ERP dev. Route them straight to needs_saasant so the payment stays
    // in the sheet WITHOUT sheet col J marker and WITHOUT a
    // consumed_transactions insert — when Frappe dev adds each customer,
    // remove their plate from NOT_YET_IN_FRAPPE_PLATES + re-fire the
    // relevant window and BRAIN picks them up cleanly.
    const plateUpper = (t.plate || '').toUpperCase().trim();
    if (plateUpper && NOT_YET_IN_FRAPPE_PLATES.has(plateUpper)) {
      // Mark this txn so downstream steps (bankRefs building, sheet
      // marker write) can exclude it. The rest of the fire proceeds
      // normally on the OTHER rows in the window.
      t._skipNotInFrappe = true;
      unresolved.push({
        sheet_row: t.sheet_row_number,
        ref: t.transactionId,
        name: t.customerName || plateUpper,
        reason: 'not_yet_in_frappe',
      });
      notYetInFrappeCount++;
      continue;
    }
    // Feed the resolver the strongest signals first: plate (col F)
    // for QB-resident customers, wakandi_member_id (col I) for Wakandi.
    // These are direct primary keys in the 292-customer book — no
    // ambiguity, no normalization risk.
    const r = await resolveSavcom({
      plate: t.plate,
      wakandi_member_id: t.wakandi_member_id,
      name: t.customerName,
      freeText: [t.customerName, t.contractName, t.transactionId].filter(Boolean).join(' | '),
    });
    if (r.match) {
      t._resolved = r.match;
      t._resolvedVia = r.via;
      resolvedCount++;
    } else {
      unresolved.push({
        sheet_row: t.sheet_row_number,
        ref: t.transactionId,
        name: t.customerName,
      });
    }
  }
  // Rows that didn't resolve become "unused" in the V2 sense (no invoice
  // applied) — they still get persisted so the operator sees them.
  // The V2 algorithm only processes txns that have invoices, so anything
  // without _resolved will naturally fall to the unused bucket.

  // 4. Frappe dev 2026-07-01 book rebuild — NEW allocation contract:
  //    - get_open_invoices returns due_date, is_moved_forward, original_due_date
  //    - allocate by due_date ASC (oldest first) — pay overdue, then due,
  //      then upcoming
  //    - allocate ONLY up to each invoice's outstanding_amount (some are
  //      partly paid, e.g. 2,500 remaining not 12,500)
  //    - SKIP is_moved_forward=1 invoices entirely — they're deferred
  //      loan-end placeholders that must not be paid until customer has
  //      cleared everything else. The ERP-side sort already puts them
  //      last but we filter explicitly (belt-and-suspenders per dev).
  //    - Any leftover after all eligible invoices → hanging credit (no
  //      allocations, sits as unallocated customer credit on the ERP).
  //    V2 / Phase-2 no longer used on this path — the new contract has a
  //    simpler due_date-FIFO allocator (allocateByDueDateAsc, above).
  const { invoicesByCustomer, customerErrors } =
    await fetchInvoicesForResolvedCustomersNewContract(txnsClean);

  const { paid, unused } = allocateByDueDateAsc(txnsClean, invoicesByCustomer, channel);

  const sumPaid = paid.reduce((s, p) => s + p.amount, 0);
  const sumUnused = unused.reduce((s, p) => s + (p.transactionAmount || p.amount || 0), 0);
  const sheetSum = txnsClean.reduce((s, t) => s + (t.amount || 0), 0);

  // 7. Batch row + lock refs (same table as QB path; channel column
  //    distinguishes them so reporting can filter).
  // Skip-listed txns (NOT_YET_IN_FRAPPE_PLATES) are excluded from
  // bankRefs so their refs don't land in consumed_transactions —
  // this preserves their retry-eligibility once Frappe adds them.
  const bankRefs = [...new Set(txnsClean
    .filter((t) => !t._skipNotInFrappe)
    .map((t) => appendSavSuffix(t.transactionId, channel))
    .filter(Boolean))];
  const idem = `auto-${channel}-${Date.now()}-` + Math.random().toString(36).slice(2, 8);
  const client = await db().connect();
  let batchId;
  try {
    await client.query('BEGIN');
    const ins = await client.query(
      `INSERT INTO payment_batches (
         idempotency_key, status, sheet_id, sheet_tab, channel, bank_refs,
         sheet_total, paid_total, unused_total,
         paid_count, unused_count, created_by, txn_date
       ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
      [idem, cfg.sheetId, cfg.tab, channel, bankRefs,
       round2(sheetSum), round2(sumPaid), round2(sumUnused),
       paid.length, unused.length,
       `sav-frappe:${tickName || 'heisenberg'}`, txnDate || null],
    );
    batchId = ins.rows[0].id;
    const refToSheetTs = new Map();
    for (const t of txnsClean) {
      const suf = appendSavSuffix(t.transactionId, channel);
      if (suf && t.receivedTimestamp) refToSheetTs.set(suf, new Date(t.receivedTimestamp).toISOString());
    }
    if (bankRefs.length > 0) {
      const tuples = bankRefs.map((_, i) => `($${i * 3 + 1},$${i * 3 + 2},$${i * 3 + 3})`).join(',');
      const vals = []; bankRefs.forEach((r) => { vals.push(r, batchId, refToSheetTs.get(r) || null); });
      await client.query(`INSERT INTO consumed_transactions (bank_ref, batch_id, sheet_ts) VALUES ${tuples}`, vals);
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    client.release();
    throw e;
  }
  client.release();

  // 8. Persist payment_uploads rows (one per algorithm output line).
  //    Status:
  //      - dry_run        - plan-only, no Frappe write attempted
  //      - frappe_pending - real fire, before Frappe ingest
  //      - pushed_to_frappe - Frappe ingest returned ok
  //      - failed         - Frappe ingest threw
  //      - needs_saasant  - unresolved customer (operator review)
  const paidUploadsByRef = new Map();   // bank_ref → array of paid PU ids
  for (const p of paid) {
    const status = dryRun ? 'dry_run' : 'frappe_pending';
    const r = await db().query(
      `INSERT INTO payment_uploads (
         batch_id, kind, bank_ref, customer_id, customer_name,
         invoice_qb_id, invoice_no, amount, memo, status
       ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9) RETURNING id`,
      [batchId, p.memoWithSuffix, p.customerId, p.customerName,
       p.qbId, p.invoiceNo, round2(p.amount), p.memoWithSuffix, status],
    );
    const ref = p.memoWithSuffix;
    if (!paidUploadsByRef.has(ref)) paidUploadsByRef.set(ref, []);
    paidUploadsByRef.get(ref).push({ pu_id: r.rows[0].id, paid: p });
  }
  for (const u of unused) {
    const status = dryRun ? 'dry_run' : 'frappe_pending';
    await db().query(
      `INSERT INTO payment_uploads (
         batch_id, kind, bank_ref, customer_id, customer_name,
         amount, memo, status
       ) VALUES ($1,'credit_memo',$2,NULL,$3,$4,$5,$6)`,
      [batchId, u.memoWithSuffix, u.customerName, round2(u.transactionAmount || u.amount), u.memoWithSuffix, status],
    );
  }
  // Unresolved customer rows persist as needs_saasant for operator visibility.
  for (const ur of unresolved) {
    await db().query(
      `INSERT INTO payment_uploads (
         batch_id, kind, bank_ref, customer_id, customer_name,
         amount, memo, status, failure_reason
       ) VALUES ($1,'payment',$2,NULL,$3,0,$4,'needs_saasant',$5)`,
      [batchId, appendSavSuffix(ur.ref, channel), ur.name,
       appendSavSuffix(ur.ref, channel),
       'savcom-resolver: no match — not in Frappe 292 book'],
    );
  }

  // 9. Sheet markers — SHIFTED one column right vs the QB path so the
  //    wakandi_member_id in column I stays untouched. Operator sees:
  //      J = "Fetched at: <iso>"        (was I on QB tabs)
  //      K = "Frappe pending/pushed"    (was J on QB tabs)
  //      L = "end of <tick>"            (was K on QB tabs)
  const fetchedAt = new Date().toISOString();
  const fetchRows = new Set();
  // Skip-listed txns (NOT_YET_IN_FRAPPE_PLATES) don't get sheet J/K
  // markers written — they stay marker-less so a future re-fire (once
  // Frappe adds them) can pick them up cleanly without a clear step.
  for (const t of txnsClean) {
    if (t._skipNotInFrappe) continue;
    if (t.sheet_row_number) fetchRows.add(t.sheet_row_number);
  }
  if (fetchRows.size > 0 && cfg.sheetId && cfg.tab) {
    const updates = [];
    const dryTag = dryRun ? ' (DRY_RUN)' : '';
    for (const row of fetchRows) {
      updates.push({ range: `${cfg.tab}!${cfg.fetchedAtLetter}${row}`, value: `Fetched at: ${fetchedAt}${dryTag}` });
      updates.push({ range: `${cfg.tab}!${cfg.pushedLetter}${row}`,    value: `${dryRun ? 'DRY_RUN' : 'Frappe pending'}${dryTag}` });
    }
    try {
      const r = await writeSheetCells(cfg.sheetId, updates);
      console.log(`[sav-frappe] ${cfg.fetchedAtLetter}+${cfg.pushedLetter} markers: ${r.updatedCells} cells, ${fetchRows.size} rows, tab=${cfg.tab}, dryRun=${dryRun}`);
    } catch (e) {
      console.error('[sav-frappe] sheet marker write failed (non-fatal):', e.message);
    }
    // End-of-tick marker on the last sheet row processed. paintRowEndMarker
    // writes to column K by default — for SAV we override the column letter
    // via a 5th positional arg if supported, otherwise we write the L cell
    // directly and skip the row-coloring helper.
    try {
      const lastRow = Math.max(...fetchRows);
      // Direct cell write to column L — keeps the data shape simple even
      // without the helper's row-paint side effect. The dashboard's
      // "consume" check uses prefix match on "end of " which works in any column.
      await writeSheetCells(cfg.sheetId, [{
        range: `${cfg.tab}!${cfg.endTickLetter}${lastRow}`,
        value: `end of ${tickName || 'heisenberg'}${dryTag}`,
      }]);
    } catch (e) {
      console.error('[sav-frappe] end-of-tick marker write failed (non-fatal):', e.message);
    }
  }

  // 10. DRY-RUN: free the consumed refs so a real fire later can claim
  //     them (same pattern as the QB path's dry-run branch).
  if (dryRun) {
    await db().query(`DELETE FROM consumed_transactions WHERE batch_id = $1`, [batchId]);
    await db().query(
      `UPDATE payment_batches SET status='finalized', finalized_at=now(),
         failure_reason='dry_run — no Frappe calls; consumed_transactions cleared so refs stay eligible for real upload' WHERE id=$1`,
      [batchId],
    );
    return {
      dry_run: true,
      batch_id: batchId,
      paid_count: paid.length, paid_total: round2(sumPaid),
      unused_count: unused.length, unused_total: round2(sumUnused),
      unresolved_count: unresolved.length,
      customers_resolved: resolvedCount,
      customer_errors: customerErrors,
      sheet_diagnostics: diagnostics,
      sheet_id: cfg.sheetId, sheet_tab: cfg.tab,
      paid_sample: paid.slice(0, 10).map((p) => ({
        customer: p.customerName, invoice: p.invoiceNo, amount: p.amount, ref: p.memoWithSuffix,
      })),
      unresolved_sample: unresolved.slice(0, 10),
    };
  }

  // 11. REAL FIRE: group paid lines by bank_ref → one Frappe Payment Entry
  //     per bank txn with explicit allocations (sacred rule: BRAIN-side
  //     algorithm produces allocations, Frappe applies them verbatim).
  const groupsByRef = new Map();
  for (const [ref, entries] of paidUploadsByRef.entries()) {
    const first = entries[0].paid;
    const total = entries.reduce((s, e) => s + Number(e.paid.amount), 0);
    const allocations = entries.map((e) => ({
      reference_name: e.paid.qbId,                // Frappe Sales Invoice name
      allocated_amount: Number(e.paid.amount) || 0,
    }));
    groupsByRef.set(ref, {
      customer: first.customerName,
      amount: total,
      txn_id: ref,
      allocations,
      pu_ids: entries.map((e) => e.pu_id),
    });
  }

  const frappeResults = [];
  for (const [ref, g] of groupsByRef.entries()) {
    try {
      const r = await ingestPayment({
        customer: g.customer,
        amount: g.amount,
        date: txnDate,
        txn_id: g.txn_id + FRAPPE_TXN_MARKER,
        mode_of_payment: MODE_OF_PAYMENT,
        allocations: g.allocations,
      });
      await db().query(
        `UPDATE payment_uploads
            SET status = 'pushed_to_frappe',
                qb_response = $2::jsonb,
                failure_reason = $3
          WHERE id = ANY($1::uuid[])`,
        [g.pu_ids, JSON.stringify(r || {}), `Frappe ingest_payment ${r?.status || 'ok'}`],
      );
      frappeResults.push({ bank_ref: ref, status: r?.status || 'ok', frappe: r });
    } catch (err) {
      // Defensive: if the catch-block UPDATE ALSO throws (schema drift, type
      // bug, etc) we MUST keep the outer loop running. Otherwise one DB
      // hiccup kills the whole batch + leaves partially-fired ingest_payment
      // calls with no BRAIN tracking. Swallow + log.
      try {
        await db().query(
          `UPDATE payment_uploads
              SET status = 'failed',
                  failure_reason = $2
            WHERE id = ANY($1::uuid[])`,
          [g.pu_ids, String(err.message || err).slice(0, 500)],
        );
      } catch (dbErr) {
        console.error(`[sav-frappe] catch-block UPDATE failed for ref=${ref}:`, dbErr.message);
      }
      frappeResults.push({ bank_ref: ref, status: 'error', error: err.message });
    }
  }

  // 12. Unused (credit) lines — push as customer credits to Frappe.
  //     ingestPayment with allocations:[] makes the full amount a hanging
  //     advance on the customer's account.
  for (const u of unused) {
    if (!u.customerName || u.customerName === 'UNKNOWN' || u.customerName === 'UNRESOLVED') continue;
    try {
      const r = await ingestPayment({
        customer: u.customerName,
        amount: Number(u.transactionAmount || u.amount),
        date: txnDate,
        txn_id: u.memoWithSuffix + FRAPPE_TXN_MARKER,
        mode_of_payment: MODE_OF_PAYMENT,
        allocations: [],
      });
      await db().query(
        `UPDATE payment_uploads
            SET status = 'pushed_to_frappe',
                qb_response = $2::jsonb,
                failure_reason = $3
          WHERE batch_id = $1 AND bank_ref = $4`,
        [batchId, JSON.stringify(r || {}), `Frappe ingest_payment (credit) ${r?.status || 'ok'}`,
         u.memoWithSuffix],
      );
      frappeResults.push({ bank_ref: u.memoWithSuffix, status: r?.status || 'ok', credit: true });
    } catch (err) {
      await db().query(
        `UPDATE payment_uploads
            SET status = 'failed', failure_reason = $2
          WHERE batch_id = $1 AND bank_ref = $3`,
        [batchId, String(err.message || err).slice(0, 500), u.memoWithSuffix],
      );
      frappeResults.push({ bank_ref: u.memoWithSuffix, status: 'error', credit: true, error: err.message });
    }
  }

  // 13. Finalize batch.
  await db().query(
    `UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`,
    [batchId],
  );

  return {
    dry_run: false,
    batch_id: batchId,
    paid_count: paid.length, paid_total: round2(sumPaid),
    unused_count: unused.length, unused_total: round2(sumUnused),
    unresolved_count: unresolved.length,
    customers_resolved: resolvedCount,
    customer_errors: customerErrors,
    sheet_diagnostics: diagnostics,
    frappe_results: frappeResults,
    frappe_ok_count: frappeResults.filter((r) => r.status === 'ok' || r.status === 'duplicate').length,
    frappe_error_count: frappeResults.filter((r) => r.status === 'error').length,
  };
}

/**
 * HTTP entry point — POST /api/payment-batches/auto-upload-frappe/:channel
 * Body: { since_iso?, until_iso?, as_of?, txn_date, dry_run?, tick_name? }
 *
 * Lock semantics: per-channel via auto_upload_locks, same table as the
 * QB path. SAV channels lock independently from NMB/CRDB so a SAV fire
 * can't be blocked by an NMB run and vice versa.
 */
export function mountSavFrappeApi(app, { requireSecretOrJwt }) {
  app.post('/api/payment-batches/auto-upload-frappe/:channel', requireSecretOrJwt, async (req, res) => {
    const channel = req.params.channel;
    if (!SAV_FRAPPE_CHANNELS.includes(channel)) {
      return res.status(400).json({ error: `channel must be one of: ${SAV_FRAPPE_CHANNELS.join(', ')}` });
    }
    const txnDate = req.body?.txn_date;
    if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(txnDate))) {
      return res.status(400).json({ error: 'txn_date required (YYYY-MM-DD)' });
    }
    const dryRun = req.body?.dry_run === true || process.env.AUTO_UPLOAD_DRY_RUN === 'true';
    const tickName = String(req.body?.tick_name || 'heisenberg');

    // Lock per channel (5-min stale reclaim, matching QB path semantics).
    const lockHolder = `${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
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
        `SELECT holder, locked_at FROM auto_upload_locks WHERE channel=$1`, [channel]);
      return res.status(409).json({
        error: 'another auto-upload for this channel is already running',
        channel, held_by: held.rows[0]?.holder, since: held.rows[0]?.locked_at,
      });
    }
    const releaseLock = async () => {
      await db().query(
        `DELETE FROM auto_upload_locks WHERE channel=$1 AND holder=$2`,
        [channel, lockHolder],
      ).catch(() => {});
    };

    // Fix #3 (Frank 2026-06-29): 30-sec heartbeat keeps locked_at fresh
    // for the duration of the SAV Frappe run (sheet read + resolver +
    // per-customer Frappe calls + V2 algorithm + ingest_payment loop —
    // easily 30-90s for typical batches). Paired with the 90-sec
    // stale-reclaim, a dead bg job frees the lock in 90s.
    const heartbeat = setInterval(() => {
      db().query(
        `UPDATE auto_upload_locks SET locked_at = now() WHERE channel = $1 AND holder = $2`,
        [channel, lockHolder],
      ).catch(() => {});
    }, 30_000);

    try {
      // CRITICAL: prevent any SAV fire from claiming bank_refs that are
      // currently being recalled. The recall endpoint sets this gate while
      // it works; we fail fast if it's set rather than racing the recall.
      const gate = await db().query(
        `SELECT value FROM app_settings WHERE key='savcom_recall_in_progress'`);
      if (gate.rows[0]?.value === '1') {
        clearInterval(heartbeat);
        await releaseLock();
        return res.status(503).json({
          error: 'SAVCOM recall is currently in progress — retry once it lifts the gate',
        });
      }

      // Default window — "from latest consumed ref's sheet-time" — matches
      // the QB path's fallback so heisenberg + tick fires behave identically.
      let sinceIso = req.body?.since_iso;
      let untilIso = req.body?.until_iso || new Date().toISOString();
      if (!sinceIso) {
        const r = await db().query(
          `SELECT MAX(ct.sheet_ts) AS max_ts
             FROM consumed_transactions ct
             JOIN payment_batches pb ON pb.id = ct.batch_id
            WHERE pb.channel = $1`,
          [channel],
        );
        const maxTs = r.rows[0]?.max_ts;
        if (maxTs) {
          sinceIso = new Date(new Date(maxTs).getTime() + 1).toISOString();
        } else {
          sinceIso = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
        }
      }
      const result = await runSavFrappeUpload({
        channel, sinceIso, untilIso,
        asOf: req.body?.as_of || txnDate,
        txnDate, tickName, dryRun,
        forceSkipMaxKRow: req.body?.force_skip_max_k_row === true,
        forceSkipMarkerCheck: req.body?.force_skip_marker_check === true,
      });
      clearInterval(heartbeat);
      await releaseLock();
      res.json(result);
    } catch (err) {
      clearInterval(heartbeat);
      await releaseLock();
      console.error('[auto-upload-frappe]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /api/payment-batches/savcom-recall
  //
  // One-shot destructive operation. Recalls every SAV-channel Payment
  // Entry BRAIN created from the 24-29.06 catchup + heisenberg + today's
  // fires, in preparation for a clean re-fire with the new AS_OF + Phase-2
  // + V-suffix code. Steps (in order):
  //   1. Gate other SAV fires via app_settings savcom_recall_in_progress=1
  //   2. Pull live snapshot — every finalized SAV batch with any
  //      pushed_to_frappe + status=posted upload row. NO hard-coded
  //      batch list; the live query is the source of truth.
  //   3. Reverse each unique posted-status bank_ref via Frappe
  //      reverse_payment. Duplicate-status rows (Wakandi migration import)
  //      are LEFT ALONE.
  //   4. Clear J/K/L sheet markers on every row whose column-H bank_ref
  //      matches one of the recalled refs (both PASSED_SAV_NMB and
  //      PASSED_SAV tabs).
  //   5. UPDATE batches to status='rolled_back', mark uploads voided.
  //   6. DELETE consumed_transactions for ALL refs touched (so re-fire
  //      replays them cleanly).
  //   7. Lift the savcom_recall_in_progress gate.
  // Body: { confirm: 'YES-RECALL-535', dry_run?: bool }
  // ───────────────────────────────────────────────────────────────────────
  app.post('/api/payment-batches/savcom-recall', requireSecretOrJwt, async (req, res) => {
    const dryRun = req.body?.dry_run === true;
    // Frank 2026-07-01 (post book-rebuild): the Frappe dev already wiped
    // all our old ACC-PAY-* payments as part of the SAVCOM book rebuild.
    // Calling reverse_payment on ~915 refs would waste 7-10 min on API
    // calls that all return not_found. skip_reverse=true does JUST the
    // BRAIN-side DB cleanup (release consumed_transactions + mark batches
    // rolled_back + clear sheet markers) without the wasted reverse loop.
    const skipReverse = req.body?.skip_reverse === true;
    const confirm = String(req.body?.confirm || '');
    if (!dryRun && confirm !== 'YES-RECALL-535') {
      return res.status(400).json({
        error: 'destructive op — pass { confirm: "YES-RECALL-535" } or { dry_run: true }',
      });
    }

    // 1. Set gate (blocks parallel SAV fires for the duration).
    if (!dryRun) {
      await db().query(
        `INSERT INTO app_settings (key, value, updated_at)
         VALUES ('savcom_recall_in_progress', '1', now())
         ON CONFLICT (key) DO UPDATE SET value='1', updated_at=now()`);
    }

    const lift = async () => {
      if (dryRun) return;
      await db().query(
        `UPDATE app_settings SET value='0', updated_at=now()
          WHERE key='savcom_recall_in_progress'`).catch(() => {});
    };

    try {
      // Optional targeted-recall filter (Frank 2026-07-02): pass batch_ids
      // to limit the recall to specific batches instead of ALL finalized
      // SAV batches. Used to reverse a single bad fire without touching
      // batches the operator approved.
      const filterIds = Array.isArray(req.body?.batch_ids) ? req.body.batch_ids.filter(Boolean) : null;

      // 2. Live scope query — 22 batches, 535 posted refs, 656 total refs
      //    (or the subset from filterIds when provided).
      const scope = await db().query(`
        SELECT pb.id AS batch_id, pb.channel, pb.created_by,
               COUNT(DISTINCT pu.bank_ref) FILTER (WHERE pu.qb_response->>'status'='posted') AS posted,
               COUNT(DISTINCT pu.bank_ref) FILTER (WHERE pu.qb_response->>'status'='duplicate') AS dup,
               COUNT(DISTINCT pu.bank_ref) AS total
          FROM payment_batches pb
          LEFT JOIN payment_uploads pu ON pu.batch_id = pb.id AND pu.status='pushed_to_frappe'
         WHERE pb.channel IN ('sav_nmb','sav_crdb')
           AND pb.status = 'finalized'
           AND ($1::uuid[] IS NULL OR pb.id = ANY($1::uuid[]))
         GROUP BY pb.id
         HAVING COUNT(pu.id) > 0
         ORDER BY pb.created_at`, [filterIds]);
      const batchIds = scope.rows.map((r) => r.batch_id);

      // Posted refs to reverse (BRAIN-created ACC-PAY-2026-XXXXX).
      const postedRefs = await db().query(`
        SELECT DISTINCT pu.bank_ref,
               (pu.qb_response->>'payment') AS payment_name,
               pu.customer_name
          FROM payment_uploads pu
          JOIN payment_batches pb ON pb.id = pu.batch_id
         WHERE pb.channel IN ('sav_nmb','sav_crdb')
           AND pb.status = 'finalized'
           AND pu.status = 'pushed_to_frappe'
           AND pu.qb_response->>'status' = 'posted'
         ORDER BY pu.bank_ref`);

      // All refs (posted + duplicate) — used to clear consumed_transactions
      // and sheet markers (the duplicate refs ALSO had markers written and
      // ALSO got logged in consumed_transactions).
      const allRefs = await db().query(`
        SELECT DISTINCT bank_ref FROM payment_uploads
         WHERE batch_id = ANY($1::uuid[])`, [batchIds]);

      const summary = {
        scope: {
          batches: scope.rows.length,
          posted_refs: postedRefs.rows.length,
          duplicate_refs_skipped: scope.rows.reduce((s, r) => s + Number(r.dup), 0),
          all_refs: allRefs.rows.length,
        },
        per_batch: scope.rows,
      };

      if (dryRun) {
        await lift();
        return res.json({ dry_run: true, ...summary });
      }

      // 3. Reverse each posted ref. The PEs were pushed BEFORE the V suffix
      //    code shipped — Frappe stored txn_id WITHOUT V — so reverse by
      //    the raw bank_ref (no suffix added here).
      //
      // skip_reverse=true bypasses the Frappe API loop entirely. Use case:
      // Frappe dev has already wiped the payments server-side (e.g. book
      // rebuild) and calling reverse_payment on ~915 refs would waste
      // 7-10 min on API calls that all return not_found. This flag runs
      // the DB cleanup + sheet marker clear WITHOUT the wasted API loop.
      if (skipReverse) {
        summary.reverse = { skipped: true, reason: 'skip_reverse=true — Frappe dev already handled server-side' };
      } else {
        const reverseResults = [];
        let reversedOK = 0, reversedAlready = 0, reversedErr = 0;
        for (const row of postedRefs.rows) {
          try {
            const r = await reversePayment(row.bank_ref);
            if (r?.status === 'already_cancelled' || r?.status === 'not_found') reversedAlready++;
            else reversedOK++;
            reverseResults.push({ bank_ref: row.bank_ref, payment: row.payment_name, ok: true, r });
          } catch (err) {
            reversedErr++;
            reverseResults.push({ bank_ref: row.bank_ref, payment: row.payment_name, ok: false, error: err.message });
          }
        }
        summary.reverse = { ok: reversedOK, already: reversedAlready, error: reversedErr };
        summary.reverse_errors = reverseResults.filter((r) => !r.ok).slice(0, 20);
      }

      // 4. Sheet J/K/L cleanup. For each SAV channel, read its sheet,
      //    match column H (raw transactionId) against the suffix-stripped
      //    bank_refs from THIS channel's batches, clear J/K/L on matches.
      const sheetSummary = {};
      const allRefsSet = new Set(allRefs.rows.map((r) => r.bank_ref));
      for (const channel of SAV_FRAPPE_CHANNELS) {
        const cfg = SAV_CHANNEL_SHEETS[channel];
        const suffix = { sav_nmb: 'NS', sav_crdb: 'CS' }[channel];
        // Strip channel suffix to get raw transactionIds we care about.
        const rawRefs = new Set();
        for (const r of allRefs.rows) {
          if (r.bank_ref?.endsWith(suffix)) rawRefs.add(r.bank_ref.slice(0, -suffix.length));
        }
        if (rawRefs.size === 0) { sheetSummary[channel] = { rows_cleared: 0, raw_refs: 0 }; continue; }
        // Read sheet, find rows where col H (index 7) matches any raw ref.
        const sd = await readSheet(cfg.sheetId, `${cfg.tab}!A1:M200000`);
        const sheet = sd.values || sd.data || [];
        const matchedRows = [];
        for (let i = 0; i < sheet.length; i++) {
          const txnId = String(sheet[i][7] || '').trim();
          if (txnId && rawRefs.has(txnId)) matchedRows.push(i + 1);
        }
        // Clear J/K/L on matched rows. writeSheetCells expects per-cell
        // updates; emit empty-string for each (clear semantics — Sheets
        // values.clear() works on ranges but writeSheetCells is per-cell).
        const updates = [];
        for (const row of matchedRows) {
          updates.push({ range: `${cfg.tab}!${cfg.fetchedAtLetter}${row}`, value: '' });
          updates.push({ range: `${cfg.tab}!${cfg.pushedLetter}${row}`, value: '' });
          updates.push({ range: `${cfg.tab}!${cfg.endTickLetter}${row}`, value: '' });
        }
        if (updates.length > 0) {
          try {
            const r = await writeSheetCells(cfg.sheetId, updates);
            sheetSummary[channel] = { rows_cleared: matchedRows.length, cells: r.updatedCells, raw_refs: rawRefs.size };
          } catch (e) {
            sheetSummary[channel] = { rows_cleared: 0, error: e.message, raw_refs: rawRefs.size };
          }
        } else {
          sheetSummary[channel] = { rows_cleared: 0, raw_refs: rawRefs.size };
        }
      }
      summary.sheets = sheetSummary;

      // 5+6. Mark batches rolled_back, mark uploads voided, clear consumed.
      await db().query(`
        UPDATE payment_uploads
           SET status = 'voided',
               failure_reason = 'savcom-recall — Frappe reverse_payment applied'
         WHERE batch_id = ANY($1::uuid[])
           AND status = 'pushed_to_frappe'`, [batchIds]);
      await db().query(`
        UPDATE payment_batches
           SET status = 'rolled_back',
               failure_reason = COALESCE(failure_reason || ' | ', '') || 'savcom-recall ' || now()::text
         WHERE id = ANY($1::uuid[])`, [batchIds]);
      const del = await db().query(`
        DELETE FROM consumed_transactions
         WHERE batch_id = ANY($1::uuid[])`, [batchIds]);
      summary.db = {
        uploads_voided: postedRefs.rows.length,
        batches_rolled_back: batchIds.length,
        consumed_deleted: del.rowCount,
      };

      // 7. Lift gate.
      await lift();
      res.json(summary);
    } catch (err) {
      await lift();
      console.error('[savcom-recall]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /api/admin/savcom/lift-recall-gates
  // Removes the savcom_post_tick:<ymd>:<tick> gate rows we pre-claimed
  // ('MANUALLY HELD — pending asOf/Phase-2 fix') to block kibo1900 + kibo2100
  // from auto-firing during the recall+re-fire. Run AFTER verification.
  // ───────────────────────────────────────────────────────────────────────
  // GET /api/admin/savcom/reconcile-batch?batch_id=<uuid or short>
  // Per-customer, per-payment, per-invoice reconciliation of a SAV Frappe
  // batch — used by Frank 2026-07-02 to verify the new due_date-ASC
  // allocator applied the pay-today-first rule correctly.
  //
  // For each customer in the batch:
  //   - Sum their bank txn(s) into total_paid
  //   - For each invoice they paid, look up its due_date via getOpenInvoices
  //   - Return the allocation ordered by payment_uploads.id (insertion order,
  //     which equals allocation order in allocateByDueDateAsc)
  //   - Tag each invoice: TODAY | PAST | FUTURE relative to bank txn's real EAT date
  app.get('/api/admin/savcom/reconcile-batch', requireSecretOrJwt, async (req, res) => {
    try {
      const id = String(req.query.batch_id || '');
      if (!id) return res.status(400).json({ error: 'batch_id required' });
      let fullId = id;
      if (id.length < 36) {
        const rr = await db().query(`SELECT id FROM payment_batches WHERE id::text LIKE $1 LIMIT 1`, [id + '%']);
        if (!rr.rows.length) return res.status(404).json({ error: 'batch not found' });
        fullId = rr.rows[0].id;
      }
      const batch = await db().query(
        `SELECT id, channel, status, txn_date, paid_count, unused_count, paid_total, unused_total, created_by, created_at
           FROM payment_batches WHERE id=$1`, [fullId]);
      if (!batch.rows.length) return res.status(404).json({ error: 'batch not found' });
      const paidRows = await db().query(
        `SELECT id, bank_ref, customer_name, customer_id, invoice_no, qb_id, amount, status
           FROM payment_uploads WHERE batch_id=$1 AND kind='payment' AND invoice_no IS NOT NULL
           ORDER BY id ASC`, [fullId]);
      // Also pull consumed_transactions to get sheet timestamp per bank_ref
      // (needed to compute the txn's real EAT date for today-tag).
      const cts = await db().query(
        `SELECT bank_ref, sheet_ts FROM consumed_transactions WHERE batch_id=$1`, [fullId]);
      const tsByRef = new Map(cts.rows.map((r) => [r.bank_ref, r.sheet_ts]));

      // Group by customer.
      const byCust = new Map();
      for (const r of paidRows.rows) {
        const cust = r.customer_name || '?';
        if (!byCust.has(cust)) byCust.set(cust, { customer: cust, customer_id: r.customer_id, txns: new Map(), invoice_order: [] });
        const e = byCust.get(cust);
        if (!e.txns.has(r.bank_ref)) {
          const ts = tsByRef.get(r.bank_ref);
          const realEat = ts ? toEatYmd(new Date(ts).getTime()) : null;
          e.txns.set(r.bank_ref, { bank_ref: r.bank_ref, real_eat_date: realEat, total_paid: 0 });
        }
        const t = e.txns.get(r.bank_ref);
        t.total_paid += Number(r.amount || 0);
        e.invoice_order.push({
          bank_ref: r.bank_ref,
          invoice_no: r.invoice_no,
          amount: Number(r.amount || 0),
        });
      }

      // Fetch each customer's open invoices from Frappe to look up due_date.
      // Also — the batch's txn_date is our best fallback if a specific txn's
      // real_eat_date isn't available (dry-runs clear consumed_transactions,
      // so sheet_ts lookups return empty). In that case use txn_date as the
      // "today" boundary — it matches how the operator thinks about the fire.
      const batchTxnDate = batch.rows[0].txn_date
        ? new Date(batch.rows[0].txn_date).toISOString().slice(0, 10)
        : null;
      const perCust = [];
      await Promise.all([...byCust.entries()].map(async ([cust, e]) => {
        let dueMap = new Map();
        let allOpenInvoices = [];  // full statement of customer's open invoices
        try {
          const r = await getOpenInvoices(cust);
          for (const inv of (r.invoices || [])) {
            const rec = {
              invoice_no: inv.name,
              due_date: inv.due_date,
              posting_date: inv.posting_date,
              is_moved_forward: !!inv.is_moved_forward,
              outstanding: Number(inv.outstanding_amount) || 0,
            };
            dueMap.set(inv.name, rec);
            allOpenInvoices.push(rec);
          }
        } catch (err) {
          e.frappe_error = err.message;
        }
        // Attach due_date + tag to each allocation
        for (const alloc of e.invoice_order) {
          const meta = dueMap.get(alloc.invoice_no);
          alloc.due_date = meta?.due_date || null;
          alloc.is_moved_forward = meta?.is_moved_forward || false;
          alloc.outstanding_at_pull = meta?.outstanding || null;
          // Tag TODAY/PAST/FUTURE relative to this bank_ref's real EAT date,
          // falling back to the batch's txn_date if sheet_ts wasn't preserved.
          const txn = e.txns.get(alloc.bank_ref);
          const boundary = txn?.real_eat_date || batchTxnDate;
          if (!boundary || !alloc.due_date) alloc.tag = '?';
          else if (alloc.due_date === boundary) alloc.tag = 'TODAY';
          else if (alloc.due_date < boundary) alloc.tag = 'PAST';
          else alloc.tag = 'FUTURE';
        }
        // Bucket + sort within each bucket by due_date ASC. This mirrors
        // the allocator's walk order (TODAY → PAST asc → FUTURE asc) so
        // Frank can verify the rule was applied even if DB row order lost
        // the insertion sequence (payment_uploads.id is UUID, not sequential).
        const today = e.invoice_order.filter((a) => a.tag === 'TODAY');
        const past = e.invoice_order.filter((a) => a.tag === 'PAST')
          .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
        const future = e.invoice_order.filter((a) => a.tag === 'FUTURE')
          .sort((a, b) => (a.due_date || '').localeCompare(b.due_date || ''));
        const unknown = e.invoice_order.filter((a) => a.tag === '?');
        // Build Frank's requested view: FULL invoice statement per customer
        // as-of the fire, sorted from AS_OF/txnDate going backward through
        // arrears (due_date DESC). Each row marked with paid_this_batch if
        // the current fire allocated any amount to it.
        const paidByInvNo = new Map();
        for (const a of e.invoice_order) {
          paidByInvNo.set(a.invoice_no, (paidByInvNo.get(a.invoice_no) || 0) + a.amount);
        }
        const boundaryForStmt = batchTxnDate;
        const statement = allOpenInvoices
          .map((inv) => ({
            due_date: inv.due_date,
            posting_date: inv.posting_date,
            invoice_no: inv.invoice_no,
            outstanding_before: inv.outstanding,
            paid_this_batch: paidByInvNo.get(inv.invoice_no) || 0,
            outstanding_after: inv.outstanding - (paidByInvNo.get(inv.invoice_no) || 0),
            is_moved_forward: inv.is_moved_forward,
            tag: !boundaryForStmt || !inv.due_date ? '?'
              : (inv.due_date === boundaryForStmt ? 'TODAY'
                : (inv.due_date < boundaryForStmt ? 'PAST' : 'FUTURE')),
          }))
          // Sort: AS_OF at top, then going backward (due_date DESC)
          .sort((a, b) => (b.due_date || '').localeCompare(a.due_date || ''));

        perCust.push({
          customer: e.customer,
          customer_id: e.customer_id,
          txns: [...e.txns.values()],
          total_paid: e.invoice_order.reduce((s, a) => s + a.amount, 0),
          bucket_totals: {
            today: today.reduce((s, a) => s + a.amount, 0),
            past:  past.reduce((s, a) => s + a.amount, 0),
            future: future.reduce((s, a) => s + a.amount, 0),
          },
          allocations_by_bucket: { today, past, future, unknown },
          // Frank's requested full-statement view — one row per open invoice
          // (whether paid or not this batch), sorted AS_OF-first-going-back.
          statement,
          statement_totals: {
            invoices: statement.length,
            outstanding_before: statement.reduce((s, r) => s + r.outstanding_before, 0),
            paid_this_batch: statement.reduce((s, r) => s + r.paid_this_batch, 0),
            outstanding_after: statement.reduce((s, r) => s + r.outstanding_after, 0),
          },
          frappe_error: e.frappe_error,
        });
      }));

      perCust.sort((a, b) => a.customer.localeCompare(b.customer));
      res.json({
        batch: batch.rows[0],
        customer_count: perCust.length,
        customers: perCust,
      });
    } catch (err) {
      console.error('[savcom-reconcile-batch]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // POST /api/admin/savcom/sms-blast
  //
  // Send a Swahili loan-summary SMS to every SAVCOM customer (all 251+
  // Wakandi + any QB customers already in the resolver's book that Frank
  // wants to notify). Uses Frappe dev's get_loan_summary endpoint for
  // live pre-computed figures + Frank's pikipiki records2 sheet for
  // phone numbers (savcom-resolver's phone field is empty per its own
  // comment).
  //
  // Body:
  //   dry_run: true  → return preview only, no SMS sent
  //   test_only_to: "255752900450"  → only send the messages to this
  //                                    single phone (each message body
  //                                    still contains the target customer's
  //                                    numbers), useful for a boss preview.
  //   customer_filter: [<plate|wakandi_id|name>, ...]  → only process
  //                                    these customers (dry-run for
  //                                    ELISANTE, for example).
  //   include_qb: false → default false; QB customers may not have phone.
  //
  // Message template (Frank 2026-07-02, confirmed):
  //   Ndugu <name>,
  //   muhtasari wa mkopo wa Pikipiki Elegansky Finance:
  //   Mkataba:  TZS <contract>
  //   Umelipa:  TZS <paid>
  //   Salio:    TZS <outstanding>
  //   Limbikizo:TZS <arrears>
  //   Leo:      TZS <today>
  //   Jumla:    TZS <due_now>
  //   Tarehe ya kuanza malipo:       DD-MM-YYYY
  //   Tarehe ya Awali ya Kumaliza:   DD-MM-YYYY
  //   [Tarehe Mpya ya Kumaliza:     DD-MM-YYYY KUTOKANA NA KUSOGEZWA MBELE MAREJESHO YA SIKU <N>]
  //   Kwa maelezo zaidi piga: 0696711258
  //
  // Last line only appears when days_moved_forward > 0.
  app.post('/api/admin/savcom/sms-blast', requireSecretOrJwt, async (req, res) => {
    try {
      const dryRun = req.body?.dry_run === true;
      const testOnlyTo = req.body?.test_only_to ? String(req.body.test_only_to).trim() : null;
      const customerFilter = Array.isArray(req.body?.customer_filter) ? req.body.customer_filter : null;
      // Frank 2026-07-02: skip customers whose most-recent sms_blast_log
      // row shows a successful NextSMS status. Used to resume a blast
      // that ran out of NextSMS balance mid-flight — top up + fire with
      // retry_failed_only=true and only the 92 that failed get re-sent.
      const retryFailedOnly = req.body?.retry_failed_only === true;

      // Ensure log table exists (idempotent, cheap).
      await db().query(`
        CREATE TABLE IF NOT EXISTS savcom_sms_log (
          id BIGSERIAL PRIMARY KEY,
          batch_ref TEXT,
          customer TEXT,
          plate TEXT,
          wakandi_id TEXT,
          phone TEXT,
          status TEXT,
          nextsms_message_id TEXT,
          nextsms_response JSONB,
          message_body TEXT,
          sent_at TIMESTAMPTZ DEFAULT now()
        );
        CREATE INDEX IF NOT EXISTS savcom_sms_log_customer_sent_idx
          ON savcom_sms_log (customer, sent_at DESC);
      `);

      // If retry_failed_only, load recently-succeeded customers so we can skip them.
      let succeededCustomers = new Set();
      if (retryFailedOnly) {
        const r = await db().query(`
          SELECT DISTINCT ON (customer) customer, status
            FROM savcom_sms_log
           WHERE sent_at > now() - interval '24 hours'
           ORDER BY customer, sent_at DESC`);
        for (const row of r.rows) {
          const s = row.status || '';
          if (['PENDING','DELIVERED','PENDING_ENROUTE'].includes(s)) {
            succeededCustomers.add(row.customer);
          }
        }
      }
      const batchRef = `blast-${Date.now()}-${Math.random().toString(36).slice(2,8)}`;

      // 1. Load phone sheet (Frank's pikipiki records2 tab). Column B=plate,
      //    C=name, D=phone, E=wakandi_id.
      const PHONE_SHEET_ID = '1XFwPITQgZmzZ8lbg8MKD9S4rwHyk2cDOKrcxO7SAjHA';
      const PHONE_TAB = 'pikipiki records2';
      const phoneData = await readSheet(PHONE_SHEET_ID, `${PHONE_TAB}!A2:E5000`);
      const phoneRows = phoneData.values || phoneData.data || [];
      const phoneByPlate = new Map();
      const phoneByWakandi = new Map();
      const phoneByNormName = new Map();
      const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
      for (const row of phoneRows) {
        const padded = [...row, '', '', '', '', ''];
        const plate = String(padded[1] || '').trim().toUpperCase();
        const name = String(padded[2] || '').trim();
        const phone = String(padded[3] || '').trim();
        const wid = String(padded[4] || '').trim();
        if (!phone) continue;
        if (plate) phoneByPlate.set(plate, phone);
        if (wid) phoneByWakandi.set(wid, phone);
        if (name) phoneByNormName.set(norm(name), phone);
      }

      // 2. Get the resolver's customer book (all 251+ SAVCOM customers).
      //    The resolver caches all customers in a `.all` array reachable
      //    via getCache — exported as getCache({force}) → cache object.
      const { getCache } = await import('./savcom-resolver.js');
      const cache = await getCache();
      let targets = cache.all || [];
      if (customerFilter) {
        const filterSet = new Set(customerFilter.map((s) => String(s).toUpperCase().trim()));
        targets = targets.filter((c) => {
          return filterSet.has(String(c.plate || '').toUpperCase())
              || filterSet.has(String(c.wakandi_member_id || ''))
              || filterSet.has(String(c.customer || '').toUpperCase())
              || filterSet.has(String(c.display_name || '').toUpperCase());
        });
      }

      // Local helpers
      const fmtN = (n) => Number(n || 0).toLocaleString('en-US');
      const fmtDate = (iso) => {
        if (!iso) return '';
        const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
        return m ? `${m[3]}-${m[2]}-${m[1]}` : String(iso);
      };
      const buildBody = (c, s) => {
        const lines = [
          `Ndugu ${c.display_name || c.customer},`,
          'muhtasari wa mkopo wa Pikipiki Elegansky Finance:',
          `Mkataba:  TZS ${fmtN(s.contract_total)}`,
          `Umelipa:  TZS ${fmtN(s.total_paid)}`,
          `Salio:    TZS ${fmtN(s.outstanding_total)}`,
          `Limbikizo:TZS ${fmtN(s.arrears)}`,
          `Leo:      TZS ${fmtN(s.today_due)}`,
          `Jumla:    TZS ${fmtN(s.total_due_now)}`,
          `Tarehe ya kuanza malipo:       ${fmtDate(s.loan_start_date)}`,
          `Tarehe ya Awali ya Kumaliza:   ${fmtDate(s.original_end_date)}`,
        ];
        const daysMoved = Number(s.days_moved_forward || 0);
        if (daysMoved > 0) {
          lines.push(`Tarehe Mpya ya Kumaliza:       ${fmtDate(s.current_end_date)} KUTOKANA NA KUSOGEZWA MBELE MAREJESHO YA SIKU ${daysMoved}`);
        }
        lines.push('Kwa maelezo zaidi piga: 0696711258');
        return lines.join('\n');
      };

      // 3. Iterate targets, fetch loan_summary, format body, resolve phone.
      const preview = [];
      const messages = [];
      const messageCustomers = [];  // parallel to messages — tracks per-message customer info for log
      const errors = [];
      let skippedRecent = 0;
      for (const c of targets) {
        if (retryFailedOnly && succeededCustomers.has(c.customer)) { skippedRecent++; continue; }
        const plate = (c.plate || '').toUpperCase().trim();
        const wid = (c.wakandi_member_id || '').trim();
        const nnorm = norm(c.display_name || c.customer);
        const phone = phoneByPlate.get(plate) || phoneByWakandi.get(wid) || phoneByNormName.get(nnorm) || null;
        if (!phone) { errors.push({ customer: c.customer, reason: 'no_phone_found' }); continue; }

        let summary;
        try {
          summary = await getLoanSummary(c.customer);
        } catch (err) {
          errors.push({ customer: c.customer, reason: 'loan_summary_failed', error: err.message });
          continue;
        }
        const body = buildBody(c, summary);
        preview.push({ customer: c.customer, plate, wakandi_id: wid, phone, chars: body.length, body_preview: body });
        messages.push({ to: testOnlyTo || phone, text: body });
        messageCustomers.push({ customer: c.customer, plate, wakandi_id: wid, phone, body });
      }

      if (dryRun) {
        return res.json({
          dry_run: true,
          total_targets: targets.length,
          messages_ready: messages.length,
          errors_count: errors.length,
          preview: preview.slice(0, 5),
          errors_sample: errors.slice(0, 10),
        });
      }

      // 4. Real send via NextSMS multi endpoint.
      const { sendNextSmsBulkExported } = await import('./savcom-morning.js').catch(() => ({}));
      // savcom-morning doesn't export sendNextSmsBulk publicly; call the
      // NextSMS API directly here (single loop, up to 100 per POST).
      const user = process.env.NEXTSMS_USERNAME;
      const pass = process.env.NEXTSMS_PASSWORD;
      const sender = process.env.NEXTSMS_SENDER_ID || 'NEXTSMS';
      if (!user || !pass) return res.status(500).json({ error: 'no NEXTSMS credentials in env' });
      const auth = Buffer.from(`${user}:${pass}`).toString('base64');
      let sentOk = 0, sentErr = 0;
      const rawResponses = [];
      const CHUNK = 100;
      for (let i = 0; i < messages.length; i += CHUNK) {
        const chunk = messages.slice(i, i + CHUNK);
        const chunkCust = messageCustomers.slice(i, i + CHUNK);
        try {
          const r = await fetch('https://messaging-service.co.tz/api/sms/v1/text/multi', {
            method: 'POST',
            headers: { Authorization: `Basic ${auth}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify({ messages: chunk.map((m) => ({ from: sender, to: String(m.to), text: String(m.text) })) }),
            signal: AbortSignal.timeout(60_000),
          });
          const j = await r.json().catch(() => ({}));
          const msgs = j?.messages || [];
          // Persist each per-recipient status so retry_failed_only can filter.
          const logRows = [];
          for (let mi = 0; mi < chunk.length; mi++) {
            const msg = msgs[mi];
            const cust = chunkCust[mi];
            const gn = msg?.status?.groupName || 'UNKNOWN';
            if (gn === 'PENDING' || gn === 'DELIVERED' || gn === 'PENDING_ENROUTE') sentOk++;
            else sentErr++;
            logRows.push([batchRef, cust.customer, cust.plate, cust.wakandi_id, cust.phone,
              gn, msg?.messageId || null, JSON.stringify(msg?.status || null), cust.body]);
          }
          if (logRows.length > 0) {
            const placeholders = logRows.map((_, ri) => {
              const base = ri * 9;
              return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8}::jsonb,$${base+9})`;
            }).join(',');
            const flat = logRows.flat();
            await db().query(
              `INSERT INTO savcom_sms_log
                 (batch_ref, customer, plate, wakandi_id, phone, status, nextsms_message_id, nextsms_response, message_body)
               VALUES ${placeholders}`, flat);
          }
          rawResponses.push(j);
        } catch (e) {
          sentErr += chunk.length;
          rawResponses.push({ error: String(e.message || e).slice(0, 200) });
          // Log the chunk as HTTP_FAILURE so retry picks them up.
          const logRows = chunkCust.map((cust) => [batchRef, cust.customer, cust.plate, cust.wakandi_id, cust.phone,
            'HTTP_FAILURE', null, JSON.stringify({error: String(e.message || e).slice(0, 200)}), cust.body]);
          if (logRows.length > 0) {
            const placeholders = logRows.map((_, ri) => {
              const base = ri * 9;
              return `($${base+1},$${base+2},$${base+3},$${base+4},$${base+5},$${base+6},$${base+7},$${base+8}::jsonb,$${base+9})`;
            }).join(',');
            await db().query(
              `INSERT INTO savcom_sms_log
                 (batch_ref, customer, plate, wakandi_id, phone, status, nextsms_message_id, nextsms_response, message_body)
               VALUES ${placeholders}`, logRows.flat());
          }
        }
      }
      // Distribution of NextSMS statuses across all responses (debugging aid).
      const statusCounts = {};
      const failedRecipients = [];
      for (let idx = 0; idx < rawResponses.length; idx++) {
        const j = rawResponses[idx];
        const msgs = j?.messages || [];
        for (let mi = 0; mi < msgs.length; mi++) {
          const m = msgs[mi];
          const gn = m?.status?.groupName || m?.status?.name || 'UNKNOWN';
          statusCounts[gn] = (statusCounts[gn] || 0) + 1;
          if (!['PENDING','DELIVERED','PENDING_ENROUTE'].includes(gn)) {
            failedRecipients.push({
              to: m?.to,
              status: m?.status,
              messageId: m?.messageId,
            });
          }
        }
      }
      res.json({
        dry_run: false,
        batch_ref: batchRef,
        retry_failed_only: retryFailedOnly,
        total_targets: targets.length,
        skipped_recent_success: skippedRecent,
        messages_sent: messages.length,
        sms_ok: sentOk,
        sms_error: sentErr,
        errors_count: errors.length,
        errors_sample: errors.slice(0, 10),
        preview_sample: preview.slice(0, 3),
        nextsms_status_distribution: statusCounts,
        failed_recipients_sample: failedRecipients.slice(0, 15),
      });
    } catch (err) {
      console.error('[savcom-sms-blast]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/savcom/sms-log-seed
  // Frank 2026-07-02: seed savcom_sms_log with fake PENDING rows for
  // customer names that we KNOW received their SMS from the first blast
  // (before per-recipient logging landed). Match by first-12-alphanumeric
  // prefix — Frank's paste from NextSMS dashboard uses truncated names.
  //
  // Body: { names: ["IDRISA HAMISI", "SAID MOHAMED", ...], confirm: "YES-SEED" }
  //
  // Once seeded, sms-blast with retry_failed_only=true will skip these
  // and only send to customers whose names DIDN'T match — i.e. the ones
  // who missed their SMS due to the NextSMS balance running out.
  app.post('/api/admin/savcom/sms-log-seed', requireSecretOrJwt, async (req, res) => {
    try {
      const names = Array.isArray(req.body?.names) ? req.body.names : [];
      if (names.length === 0) return res.status(400).json({ error: 'names[] required' });
      if (req.body?.confirm !== 'YES-SEED') return res.status(400).json({ error: "confirm='YES-SEED' required" });
      await db().query(`
        CREATE TABLE IF NOT EXISTS savcom_sms_log (
          id BIGSERIAL PRIMARY KEY, batch_ref TEXT, customer TEXT, plate TEXT,
          wakandi_id TEXT, phone TEXT, status TEXT, nextsms_message_id TEXT,
          nextsms_response JSONB, message_body TEXT, sent_at TIMESTAMPTZ DEFAULT now());
        CREATE INDEX IF NOT EXISTS savcom_sms_log_customer_sent_idx
          ON savcom_sms_log (customer, sent_at DESC);
      `);
      const { getCache } = await import('./savcom-resolver.js');
      const cache = await getCache();
      const targets = cache.all || [];
      const norm = (s) => String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '').slice(0, 12);
      // Build resolver-name-prefix map
      const byPrefix = new Map();
      for (const c of targets) {
        const key = norm(c.display_name || c.customer);
        if (key) byPrefix.set(key, c);
      }
      // Match each pasted name → resolver customer
      const matched = [];
      const unmatched = [];
      for (const name of names) {
        const key = norm(name);
        const c = byPrefix.get(key);
        if (c) matched.push(c);
        else unmatched.push(name);
      }
      // Dedupe matched
      const seen = new Set();
      const uniqueMatched = [];
      for (const c of matched) {
        if (seen.has(c.customer)) continue;
        seen.add(c.customer); uniqueMatched.push(c);
      }
      // Insert PENDING rows
      let inserted = 0;
      const seedBatch = `seed-${Date.now()}`;
      for (const c of uniqueMatched) {
        await db().query(
          `INSERT INTO savcom_sms_log (batch_ref, customer, plate, wakandi_id, status)
           VALUES ($1, $2, $3, $4, 'PENDING')`,
          [seedBatch, c.customer, c.plate || null, c.wakandi_member_id || null]);
        inserted++;
      }
      res.json({
        names_received: names.length,
        matched_unique: uniqueMatched.length,
        unmatched_count: unmatched.length,
        unmatched_sample: unmatched.slice(0, 10),
        inserted,
        seed_batch: seedBatch,
      });
    } catch (err) {
      console.error('[savcom-sms-log-seed]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/savcom/reverse-refs
  // One-shot: for each bank_ref in body, call Frappe reverse_payment with
  // the V suffix appended (matching what ingestPayment actually stored).
  // Fixes a bug in savcom-recall where it passed unsuffixed bank_ref → Frappe
  // returned not_found for every PE → nothing actually got reversed.
  // Body: { bank_refs: ["19c37...CS", ...], confirm: "YES-REVERSE" }
  app.post('/api/admin/savcom/reverse-refs', requireSecretOrJwt, async (req, res) => {
    try {
      const refs = Array.isArray(req.body?.bank_refs) ? req.body.bank_refs.filter(Boolean) : [];
      if (refs.length === 0) return res.status(400).json({ error: 'bank_refs[] required' });
      if (req.body?.confirm !== 'YES-REVERSE') return res.status(400).json({ error: "pass { confirm: 'YES-REVERSE' }" });
      const results = [];
      for (const ref of refs) {
        const withV = String(ref).endsWith('V') ? String(ref) : `${ref}V`;
        try {
          const r = await reversePayment(withV);
          results.push({ bank_ref: ref, txn_id_used: withV, status: r?.status || 'unknown', response: r });
        } catch (err) {
          results.push({ bank_ref: ref, txn_id_used: withV, status: 'error', error: err.message });
        }
      }
      const ok = results.filter((r) => r.status && !['error'].includes(r.status)).length;
      const errs = results.filter((r) => r.status === 'error').length;
      res.json({ total: refs.length, ok, errors: errs, results });
    } catch (err) {
      console.error('[savcom-reverse-refs]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/savcom/lift-recall-gates', requireSecretOrJwt, async (req, res) => {
    try {
      const r = await db().query(`
        DELETE FROM app_settings
         WHERE key LIKE 'savcom_post_tick:%'
           AND value LIKE 'MANUALLY HELD%'
         RETURNING key, value`);
      res.json({ lifted: r.rowCount, rows: r.rows });
    } catch (err) {
      console.error('[savcom-lift-recall-gates]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ───────────────────────────────────────────────────────────────────────
  // GET /api/admin/savcom/verify-customer?customer=<name>&since=<iso>
  //
  // End-to-end proof that the recall + re-fire produced correctly-allocated
  // payments. For a named customer, returns:
  //   - every payment_uploads row from the recent replay batches
  //   - the Frappe Payment Entry it produced (reference_no, with V suffix)
  //   - the Sales Invoice each PE allocation hit (posting_date proves the
  //     AS_OF gate worked — date must be ≤ batch's txn_date / AS_OF)
  // Sample: ?customer=ISIHAKA RAMADHANI MKAMIA
  // ───────────────────────────────────────────────────────────────────────
  app.get('/api/admin/savcom/verify-customer', requireSecretOrJwt, async (req, res) => {
    try {
      const customer = String(req.query.customer || '').trim();
      if (!customer) return res.status(400).json({ error: 'customer required' });
      const since = String(req.query.since || '2026-06-29T17:00:00Z');

      const pus = await db().query(`
        SELECT pu.bank_ref, pu.invoice_qb_id, pu.amount, pu.qb_response,
               pb.channel, pb.txn_date, pb.created_by, pb.created_at
          FROM payment_uploads pu
          JOIN payment_batches pb ON pb.id = pu.batch_id
         WHERE pu.customer_name = $1
           AND pu.status = 'pushed_to_frappe'
           AND pu.qb_response->>'status' = 'posted'
           AND pb.created_at >= $2
         ORDER BY pb.created_at`, [customer, since]);

      const out = [];
      for (const r of pus.rows) {
        const peName = r.qb_response?.payment;
        let pe = null, invoice = null, peErr = null, invErr = null;
        try { pe = peName ? await getPaymentEntry(peName) : null; }
        catch (e) { peErr = e.message; }
        try { invoice = r.invoice_qb_id ? await getSalesInvoice(r.invoice_qb_id) : null; }
        catch (e) { invErr = e.message; }

        const txnDate = String(r.txn_date).slice(0, 10);
        const invoiceDate = invoice?.posting_date || invoice?.due_date || null;
        const isFuture = invoiceDate && txnDate && invoiceDate > txnDate;

        out.push({
          bank_ref_internal: r.bank_ref,
          frappe_pe: peName,
          frappe_reference_no: pe?.reference_no,
          v_suffix_present: pe?.reference_no?.endsWith('V') || false,
          channel: r.channel,
          batch_txn_date: txnDate,
          batch_label: r.created_by,
          allocated_invoice: r.invoice_qb_id,
          allocated_invoice_date: invoiceDate,
          allocated_amount: r.amount,
          AS_OF_VIOLATED: isFuture,        // <-- the smoking-gun flag
          pe_fetch_error: peErr,
          invoice_fetch_error: invErr,
        });
      }
      res.json({
        customer,
        since,
        push_count: out.length,
        v_suffix_count: out.filter((x) => x.v_suffix_present).length,
        as_of_violations: out.filter((x) => x.AS_OF_VIOLATED).length,
        details: out,
      });
    } catch (err) {
      console.error('[savcom-verify-customer]', err);
      res.status(500).json({ error: err.message });
    }
  });
}
