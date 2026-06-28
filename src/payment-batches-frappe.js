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
import { getOpenInvoices, ingestPayment } from './frappe-client.js';
import { resolveSavcom } from './savcom-resolver.js';
import { processInvoicePaymentsV2 } from './payment-algorithm-v2.js';

const MODE_OF_PAYMENT = 'SAVCOM';

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
  return null;
}

/**
 * Read PASSED_SAV_NMB / PASSED_SAV sheet, filter to the window, drop
 * already-consumed refs. Returns the cleaned transaction list + sheet
 * config + diagnostic counters. Same shape as the QB-path's sheet
 * intake, including the I/J/K Column protections.
 */
async function readSavSheetWindow({ channel, sinceIso, untilIso }) {
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
  let maxKRow = 0;
  for (let i = 0; i < sheet.length; i++) {
    const endTick = String(sheet[i][cfg.endTickCol] || '').trim().toLowerCase();
    if (endTick.startsWith('end of ') && !endTick.includes('(dry_run)')) maxKRow = i + 1;
  }

  const txns = [];
  let skippedNoDate = 0, skippedOutOfWindow = 0, skippedAlreadyPushed = 0;
  let includedBadFormat = 0;
  for (let i = 0; i < sheet.length; i++) {
    if (maxKRow > 0 && i + 1 <= maxKRow) { skippedAlreadyPushed++; continue; }
    // "Fetched at" / "Frappe pushed" markers live in shifted columns
    // (J/K instead of I/J) so the wakandi_member_id in col I doesn't trip
    // the "already pushed" check. We ALSO require the marker text to
    // start with the canonical prefix — bare data in the wrong column
    // shouldn't fool the gate.
    const fetched = String(sheet[i][cfg.fetchedAtCol] || '').trim();
    const pushed = String(sheet[i][cfg.pushedCol] || '').trim();
    const fetchedReal = (fetched.startsWith('Fetched at') && !fetched.includes('(DRY_RUN)')) ? fetched : '';
    const pushedReal  = (
      (pushed.startsWith('Frappe pushed') || pushed.startsWith('Frappe pending') || pushed.startsWith('QB pushed'))
      && !pushed.includes('(DRY_RUN)')
    ) ? pushed : '';
    if (fetchedReal || pushedReal) { skippedAlreadyPushed++; continue; }

    const dCell = String(sheet[i][1] || '').trim();
    if (!dCell) { skippedNoDate++; continue; }
    const ts = parseTsAny(dCell);
    if (ts && (ts < winStart || ts >= winEnd)) { skippedOutOfWindow++; continue; }
    if (!ts) includedBadFormat++;
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
      included_bad_format: includedBadFormat,
      intra_window_dupes: intraDupes,
      max_k_row: maxKRow,
    },
  };
}

/**
 * For each unique resolved Frappe customer in the txn list, fetch their
 * open invoices and convert to V2 algorithm shape. Returns invoices[]
 * keyed off the resolved Frappe customer name so V2's customer-grouping
 * lines up with the txn customerName field we'll override.
 */
async function fetchInvoicesForResolvedCustomers(txnsClean) {
  const byCustomer = new Map();
  for (const t of txnsClean) {
    if (!t._resolved) continue;
    const key = t._resolved.customer;
    if (!byCustomer.has(key)) byCustomer.set(key, []);
    byCustomer.get(key).push(t);
  }

  const invoices = [];
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
      if (!inv.posting_date && !inv.due_date) continue;
      invoices.push({
        // V2 keys customers by customerPhone || customerName.toLowerCase().
        // We force-use customerKey so resolved txns and invoices share a
        // grouping key regardless of upstream display-name drift.
        customerName: customerKey,
        customerPhone: null,
        customerId: customerKey,
        qbId: inv.name,              // Frappe Sales Invoice id (used in allocations)
        invoiceNumber: inv.name,
        invoiceDate: inv.posting_date || inv.due_date,
        amount: out,
      });
    }
  }
  return { invoices, customerErrors };
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
} = {}) {
  if (!SAV_FRAPPE_CHANNELS.includes(channel)) {
    throw new Error(`channel must be one of: ${SAV_FRAPPE_CHANNELS.join(', ')}`);
  }
  if (!sinceIso || !untilIso) throw new Error('sinceIso + untilIso required');
  if (!txnDate || !/^\d{4}-\d{2}-\d{2}$/.test(String(txnDate))) {
    throw new Error('txnDate must be YYYY-MM-DD');
  }

  // 1. Sheet intake.
  const { cfg, txns, diagnostics } = await readSavSheetWindow({ channel, sinceIso, untilIso });
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
  const unresolved = [];
  for (const t of txnsClean) {
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

  // 4. Fetch Frappe invoices for resolved customers.
  const { invoices, customerErrors } = await fetchInvoicesForResolvedCustomers(txnsClean);

  // 5. Adapt txns to V2 shape — override customerName with the resolved
  //    Frappe customer key so V2's grouping lines up with the invoices.
  const v2Txns = txnsClean.map((t) => ({
    customerName: t._resolved ? t._resolved.customer : (t.customerName || 'UNRESOLVED'),
    customerPhone: null,
    contractName: t._resolved ? t._resolved.customer : (t.contractName || t.customerName),
    channel: t.channel,
    transactionId: t.transactionId,
    id: t.id,
    amount: t.amount,
    receivedTimestamp: t.receivedTimestamp,
    sheet_row_number: t.sheet_row_number,
    _ref_suffixed: appendSavSuffix(t.transactionId, channel),
  }));

  // 6. Sacred V2 algorithm (cap-no-overflow). No forward-pay phase 2
  //    here — Frappe doesn't expose a forward-invoice query yet, so
  //    leftover becomes a hanging advance per the agreed contract.
  const { payments, leftoverPerTx } = processInvoicePaymentsV2(invoices, v2Txns);
  const paid = payments.filter((p) => !p.isUnused && p.amount > 0);
  const unused = payments.filter((p) => p.isUnused);

  // Phase-1 leftover (overpaid-past-balance) lands as credit too —
  // emit a synthetic "unused" entry per leftover tx so it persists.
  for (const lo of leftoverPerTx) {
    unused.push({
      customerName: lo.customerName,
      invoiceNo: 'UNUSED',
      amount: lo.leftover,
      transactionAmount: lo.leftover,
      memo: lo.transactionId,
      memoWithSuffix: lo.memoWithSuffix || appendSavSuffix(lo.transactionId, channel),
      isUnused: true,
      isCredit: true,
      channel,
      sheet_row_number: lo.sheet_row_number,
    });
  }

  const sumPaid = paid.reduce((s, p) => s + p.amount, 0);
  const sumUnused = unused.reduce((s, p) => s + (p.transactionAmount || p.amount || 0), 0);
  const sheetSum = txnsClean.reduce((s, t) => s + (t.amount || 0), 0);

  // 7. Batch row + lock refs (same table as QB path; channel column
  //    distinguishes them so reporting can filter).
  const bankRefs = [...new Set(txnsClean
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
  for (const t of txnsClean) if (t.sheet_row_number) fetchRows.add(t.sheet_row_number);
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
        txn_id: g.txn_id,
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
        txn_id: u.memoWithSuffix,
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
         WHERE auto_upload_locks.locked_at < now() - interval '5 minutes'
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

    try {
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
      });
      await releaseLock();
      res.json(result);
    } catch (err) {
      await releaseLock();
      console.error('[auto-upload-frappe]', err);
      res.status(500).json({ error: err.message });
    }
  });
}
