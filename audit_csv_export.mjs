// Generate the 3 comparison CSV files (paid, unused, unpaid) in the
// SaasAnt format an external AI agent can diff against the
// invoice-payment-app's output.
//
// Args via env:
//   CHANNEL=nmbnew|bank|iphone_bank  (default nmbnew)
//   AS_OF=YYYY-MM-DD                  (default 2026-05-31)
//   WINDOW_DATE=DD.MM.YYYY            (default 31.05.2026, sheet literal date)
//   OUT_DIR=path                       (default /home/clifforddennis/Downloads)
//   MIN_TIME=HH:MM                     (optional, filter rows with time >= MIN_TIME, e.g. 16:18)
//   MAX_TIME=HH:MM                     (optional, filter rows with time <= MAX_TIME)
//   OUT_TAG=string                     (optional, override output filename tag)
//
// File format (per the SaasAnt sample):
//   Payment Date,Customer,Payment Method,Deposit To Account Name,
//   Invoice No,Journal No,Amount,Reference No,Memo,Country Code,Exchange Rate

import { writeFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

const BASE = 'https://elegansky-brain.onrender.com';
const CHANNEL = process.env.CHANNEL || 'nmbnew';
const AS_OF = process.env.AS_OF || '2026-05-31';
const WINDOW_DATE = process.env.WINDOW_DATE || '31.05.2026';
const OUT_DIR = process.env.OUT_DIR || '/home/clifforddennis/Downloads';
const MIN_TIME = process.env.MIN_TIME || null; // "HH:MM" inclusive
const MAX_TIME = process.env.MAX_TIME || null; // "HH:MM" inclusive
// time-of-day → minutes since 00:00 (-1 if unset)
const minMin = MIN_TIME ? (Number(MIN_TIME.split(':')[0]) * 60 + Number(MIN_TIME.split(':')[1] || 0)) : -1;
const maxMin = MAX_TIME ? (Number(MAX_TIME.split(':')[0]) * 60 + Number(MAX_TIME.split(':')[1] || 0)) : 24 * 60;

const SHEETS = {
  nmbnew:      { id: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED' },
  bank:        { id: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o', tab: 'PASSED' },
  iphone_bank: { id: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED' },
};

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseTsAny(s) {
  const str = String(s||'').trim();
  if (!str) return null;
  let m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) { const d=+m[1],mo=+m[2]; if(mo<1||mo>12||d<1||d>31)return null; return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`); }
  m = str.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i);
  if (m) { const idx=MONTH_NAMES.indexOf(m[2].toLowerCase()); if(idx<0)return null; return new Date(`${m[3]}-${String(idx+1).padStart(2,'0')}-${m[1].padStart(2,'0')}T00:00:00Z`); }
  return null;
}
function extractPhone(s) { const m = (s||'').match(/\d{10,}/); return m ? m[0] : null; }
function suffixFor(c) { return { bank:'B', iphone_bank:'P', nmbnew:'N' }[c] || ''; }
function appendSuf(t, c) { const sfx = suffixFor(c); return t ? t + sfx : ''; }

// Multi-plate detection: comma-separated plates like "MC400FUM, MC401FUM, MC402FUM"
// or any cell that has 2+ Tanzanian plate patterns (MC\d{3}\w{3}).
function isMultiPlate(plateCell) {
  if (!plateCell) return false;
  const matches = String(plateCell).match(/M[A-Z]\d{3}[A-Z]{3}/g) || [];
  return matches.length >= 2;
}

// Verbatim algorithm (line-by-line from invoice-payment-app).
function processInvoicePayments(invoices, transactions) {
  const usedTransactions = new Set();
  const invoicesByCustomer = {};
  invoices.forEach((inv) => {
    const key = inv.customerPhone || inv.customerName.toLowerCase().trim();
    (invoicesByCustomer[key] ||= []).push(inv);
  });
  Object.keys(invoicesByCustomer).forEach((k) => invoicesByCustomer[k].sort((a, b) => {
    const dc = new Date(b.invoiceDate) - new Date(a.invoiceDate);
    return dc !== 0 ? dc : b.invoiceNumber.localeCompare(a.invoiceNumber);
  }));
  const transactionsByCustomer = {};
  const seen = new Set();
  transactions.forEach((t) => {
    if (!t.amount) return;
    const uid = `${t.transactionId || t.id}_${t.receivedTimestamp}_${t.amount}`;
    if (seen.has(uid)) return;
    const keys = [t.customerPhone, t.contractName?.toLowerCase().trim(), t.customerName?.toLowerCase().trim()].filter(Boolean);
    const k = keys.find((key) => invoicesByCustomer[key]);
    if (k) { (transactionsByCustomer[k] ||= []).push(t); seen.add(uid); }
  });
  Object.keys(transactionsByCustomer).forEach((k) => transactionsByCustomer[k].sort((a, b) => (a.receivedTimestamp || 0) - (b.receivedTimestamp || 0)));
  const processedPayments = [];
  Object.keys(invoicesByCustomer).forEach((ck) => {
    const ci = invoicesByCustomer[ck]; const ct = transactionsByCustomer[ck] || [];
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
          branch: cur.inv.branch,
          paymentDateMMDDYYYY: tx.paymentDateMMDDYYYY,
        };
        processedPayments.push(rec); txp.push(rec);
        cur.remainingBalance -= pay; amt -= pay; used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTransactions.add(tx.transactionId || tx.id);
      if (amt > 0 && txp.length > 0) txp[0].amount += amt;
    });
  });
  const unused = transactions.filter((t) => !usedTransactions.has(t.transactionId || t.id));
  unused.forEach((t) => processedPayments.push({
    customerName: t.customerName || t.contractName || 'UNKNOWN',
    invoiceNo: 'UNUSED', amount: t.amount, transactionAmount: t.amount,
    memo: t.transactionId, memoWithSuffix: appendSuf(t.transactionId, t.channel),
    isUnused: true, channel: t.channel, branch: null,
    paymentDateMMDDYYYY: t.paymentDateMMDDYYYY,
  }));
  return { paid: processedPayments.filter((p) => !p.isUnused && p.amount > 0), unused: processedPayments.filter((p) => p.isUnused), invoicesByCustomer };
}

// ── Pull arrears (asOf), filter to invoices DueDate ≤ AS_OF ──────────────
// Also apply IP's lower bound (invoice date >= INVOICE_FROM, default 2026-01-01)
// so the matching pool exactly mirrors the invoice-payment-app's export.
const INVOICE_FROM = process.env.INVOICE_FROM || '2026-01-01';
console.log(`Pulling /arrears?asOf=${AS_OF}…  (invoice date floor: ${INVOICE_FROM})`);
const arrears = [];
let start = 1;
while (true) {
  const r = await fetch(`${BASE}/arrears?pageSize=1000&start=${start}&asOf=${AS_OF}`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  const invs = j.invoices || [];
  if (!invs.length) break;
  arrears.push(...invs);
  if (!j.page?.nextStart) break;
  start = j.page.nextStart;
}
const floor = new Date(INVOICE_FROM + 'T00:00:00Z');
const filteredArrears = arrears.filter((inv) => {
  if (new Date(inv.date) < floor) return false;
  // Drop invoices with no DocNumber — IP's pull-from-QB excludes them and the
  // overflow allocation should fold into the first numbered invoice instead.
  if (!inv.no || !String(inv.no).trim()) return false;
  return true;
});
console.log(`  arrears total: ${arrears.length} | after invoice-date floor + DocNumber filter: ${filteredArrears.length}`);

const invoices = filteredArrears.map((inv, i) => ({
  id: i + 1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
  amount: Number(inv.balance) || 0, invoiceDate: inv.date,
  customerPhone: extractPhone(inv.customer || ''),
  customerId: inv.customerId, qbId: inv.qbId,
  branch: inv.branch || 'Kijichi',
}));

// ── Pull sheet, classify rows ─────────────────────────────────────────────
console.log(`Pulling ${CHANNEL} sheet (filter date prefix "${WINDOW_DATE}")…`);
const sh = SHEETS[CHANNEL];
const sr = await (await fetch(`${BASE}/sheets/${sh.id}?range=${sh.tab}!A1:H80000`, { signal: AbortSignal.timeout(60000) })).json();
const sheet = sr.values || [];

const sheetWindow = WINDOW_DATE; // e.g., "31.05.2026"
// Payment Date in MM-DD-YYYY. Defaults to TODAY (matches invoice-payment-app
// which uses the day the SaasAnt file is generated/uploaded). Override via
// PAYMENT_DATE env var if you need a specific date.
function todayMMDDYYYY() {
  const t = new Date();
  return `${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}-${t.getFullYear()}`;
}
const defaultPaymentDate = process.env.PAYMENT_DATE || todayMMDDYYYY();

// First pass — find min/max ROW INDEX of standard-format rows in this window
// (used to scope blank-date / bad-date / multi-plate to "between" rows so
// Frank's drag-drop total in Google Sheets matches our flagged totals).
let minRowIdx = Infinity, maxRowIdx = -1;
for (let i = 1; i < sheet.length; i++) {
  const dCell = String(sheet[i][1] || '').trim();
  if (dCell.startsWith(sheetWindow)) {
    if (i < minRowIdx) minRowIdx = i;
    if (i > maxRowIdx) maxRowIdx = i;
  }
}
console.log(`  ${sheetWindow} rows span sheet row indexes [${minRowIdx} .. ${maxRowIdx}]`);

const inWindowParseable = [];
const flagged_multiPlate = [];
const flagged_blank = [];
const flagged_badDate = [];

for (let i = 1; i < sheet.length; i++) {
  const dCell = String(sheet[i][1] || '').trim();
  const plateCell = String(sheet[i][5] || '').trim();
  const customer = String(sheet[i][6] || '').trim();
  const amount = Number(String(sheet[i][4] || '0').replace(/,/g, '')) || 0;
  const ref = String(sheet[i][7] || '').trim();
  const insideMay31Block = i >= minRowIdx && i <= maxRowIdx;

  // Blank date → operator skip flag. Only count if in the May-31 row block.
  if (!dCell) {
    if (insideMay31Block) {
      flagged_blank.push({ id: sheet[i][0], dCell: '', plateCell, customer, amount, ref });
    }
    continue;
  }
  // Parseable date
  const ts = parseTsAny(dCell);
  if (ts) {
    if (!dCell.startsWith(sheetWindow)) continue; // outside window
    // Optional time-of-day filter (e.g. only after 16:18 EAT for evening
    // batches). dCell is "DD.MM.YYYY HH:MM:SS" — extract HH:MM.
    if (MIN_TIME || MAX_TIME) {
      const tm = dCell.match(/\s(\d{2}):(\d{2}):/);
      const rowMin = tm ? Number(tm[1]) * 60 + Number(tm[2]) : -1;
      if (rowMin < minMin || rowMin > maxMin) continue;
    }
    // IP-verbatim: treat plate cell as the customerPhone matching key (as-is,
    // no extraction). Multi-plate rows flow through normally — they'll either
    // match or land in unused, same as IP. Customer name is the literal cell
    // value — phones glued onto names belong to a different customer key.
    inWindowParseable.push({
      id: sheet[i][0] || `tx-${i}`, channel: CHANNEL,
      customerPhone: plateCell || null,
      customerName: customer, contractName: customer,
      amount, receivedTimestamp: ts.getTime(), transactionId: ref,
      paymentDateMMDDYYYY: defaultPaymentDate,
    });
    continue;
  }
  // Bad date (present but unparseable). Only count if inside the May-31 block
  // so we don't pull in OCR garbage from other days.
  if (insideMay31Block) {
    flagged_badDate.push({ id: sheet[i][0], dCell, plateCell, customer, amount, ref });
  }
}

console.log(`  parseable in-window rows: ${inWindowParseable.length}`);
console.log(`  flagged multi-plate: ${flagged_multiPlate.length}`);
console.log(`  flagged blank-date: ${flagged_blank.length}`);
console.log(`  flagged bad-date: ${flagged_badDate.length}`);

// ── Algorithm ─────────────────────────────────────────────────────────────
const { paid, unused, invoicesByCustomer } = processInvoicePayments(invoices, inWindowParseable);
const sumPaid = paid.reduce((s, p) => s + p.amount, 0);
const sumUnused = unused.reduce((s, p) => s + (p.transactionAmount || p.amount), 0);
const sumFlagged = flagged_multiPlate.reduce((s, r) => s + r.amount, 0)
                 + flagged_blank.reduce((s, r) => s + r.amount, 0)
                 + flagged_badDate.reduce((s, r) => s + r.amount, 0);

console.log(`\nAlgorithm:`);
console.log(`  paid:     ${paid.length} / ${sumPaid.toLocaleString()}`);
console.log(`  unused:   ${unused.length} / ${sumUnused.toLocaleString()}`);
console.log(`  flagged:  ${flagged_multiPlate.length + flagged_blank.length + flagged_badDate.length} / ${sumFlagged.toLocaleString()}`);

// ── Determine unpaid invoices (invoices that didn't receive any payment) ──
const paidInvoiceIds = new Set(paid.map((p) => String(p.qbId)));
const unpaidInvoices = invoices.filter((inv) => !paidInvoiceIds.has(String(inv.qbId)) && inv.amount > 0);

// ── CSV writers (SaasAnt format) ──────────────────────────────────────────
const HEADER = 'Payment Date,Customer,Payment Method,Deposit To Account Name,Invoice No,Journal No,Amount,Reference No,Memo,Country Code,Exchange Rate';
function csvEscape(v) {
  if (v == null) return '';
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
function rowPaid(p) {
  return [
    p.paymentDateMMDDYYYY || defaultPaymentDate,
    p.customerName || '',
    'Cash',
    `${(p.branch || 'Kijichi').replace(/\s+/g, ' ')} Collection AC`,
    p.invoiceNo || '',
    '',
    p.amount,
    '',
    p.memoWithSuffix || '',
    '',
    '',
  ].map(csvEscape).join(',');
}
function rowUnused(u) {
  return [
    u.paymentDateMMDDYYYY || defaultPaymentDate,
    u.customerName || '',
    'Cash',
    'Kijichi Collection AC',
    '',
    '',
    u.transactionAmount || u.amount,
    '',
    u.memoWithSuffix || '',
    '',
    '',
  ].map(csvEscape).join(',');
}
function rowFlagged(f) {
  // Matches the invoice-payment-app's unused style for skipped rows:
  // Customer is "UNKNOWN" (no specific customer because operator flagged it).
  return [
    defaultPaymentDate,
    'UNKNOWN',
    'Cash',
    'Kijichi Collection AC',
    '',
    '',
    f.amount,
    '',
    appendSuf(f.ref, CHANNEL),
    '',
    '',
  ].map(csvEscape).join(',');
}
function rowUnpaidInvoice(inv) {
  // Reuse SaasAnt format with Invoice No filled + amount = the open balance.
  return [
    defaultPaymentDate,
    inv.customerName,
    'Cash',
    `${(inv.branch || 'Kijichi').replace(/\s+/g, ' ')} Collection AC`,
    inv.invoiceNumber,
    '',
    inv.amount, // open balance (not paid by today's txns)
    '',
    '',
    '',
    '',
  ].map(csvEscape).join(',');
}

mkdirSync(OUT_DIR, { recursive: true });
const tag = process.env.OUT_TAG || `${CHANNEL}-${WINDOW_DATE.replace(/\./g, '-')}`;
const paidPath = join(OUT_DIR, `paid_${tag}.csv`);
const unusedPath = join(OUT_DIR, `unused_${tag}.csv`);
const flaggedPath = join(OUT_DIR, `flagged_${tag}.csv`);
const unpaidPath = join(OUT_DIR, `unpaid_${tag}.csv`);

writeFileSync(paidPath, [HEADER, ...paid.map(rowPaid)].join('\n'));
// Combined unused file — algorithm's unused + operator-flagged (multi-plate,
// blank-date, bad-date), all with the same SaasAnt schema. Drops the
// separate flagged file per Frank's "only 3 files" requirement.
const allUnused = [
  ...unused.map(rowUnused),
  ...flagged_multiPlate.map(rowFlagged),
  ...flagged_blank.map(rowFlagged),
  ...flagged_badDate.map(rowFlagged),
];
writeFileSync(unusedPath, [HEADER, ...allUnused].join('\n'));
writeFileSync(unpaidPath, [HEADER, ...unpaidInvoices.map(rowUnpaidInvoice)].join('\n'));

console.log(`\n✓ wrote: ${paidPath}                 (${paid.length} rows)`);
console.log(`✓ wrote: ${unusedPath}               (${allUnused.length} rows = ${unused.length} unused + ${flagged_multiPlate.length + flagged_blank.length + flagged_badDate.length} flagged)`);
console.log(`✓ wrote: ${unpaidPath}               (${unpaidInvoices.length} rows)`);
