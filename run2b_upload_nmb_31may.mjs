// Run 2A: BANK CRDB 31.05.2026 full day (00:00 → 23:59).
// Arrears filter: date ≤ 31.05.2026.

import crypto from 'node:crypto';

const BASE = 'https://elegansky-brain.onrender.com';
const SECRET = process.env.STATEMENT_REPORT_SECRET;
if (!SECRET) throw new Error('STATEMENT_REPORT_SECRET not set');

const CRDB_SHEET = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek'; // NMB
const CHANNEL = 'nmbnew';
const WIN_START = new Date('2026-05-31T00:00:00Z');
const WIN_END   = new Date('2026-06-01T00:00:00Z');
const ARREARS_CUTOFF = new Date('2026-06-01T00:00:00Z');

function getChannelSuffix(c) { return { bank:'B', iphone_bank:'P', nmbnew:'N' }[c] || ''; }
function appendChannelSuffix(t, c) { if (!t) return ''; const s = getChannelSuffix(c); return s ? t+s : t; }
function extractPhone(s) { const m = (s||'').match(/\d{10,}/); return m ? m[0] : null; }

function processInvoicePayments(invoices, transactions) {
  const usedTransactions = new Set();
  const invByCust = {};
  invoices.forEach(inv => {
    const key = inv.customerPhone || inv.customerName.toLowerCase().trim();
    (invByCust[key] ||= []).push(inv);
  });
  Object.keys(invByCust).forEach(k => invByCust[k].sort((a,b) => {
    const dc = new Date(b.invoiceDate) - new Date(a.invoiceDate);
    return dc !== 0 ? dc : b.invoiceNumber.localeCompare(a.invoiceNumber);
  }));
  const txByCust = {};
  const seen = new Set();
  transactions.forEach(t => {
    if (!t.amount) return;
    const uid = `${t.transactionId||t.id}_${t.receivedTimestamp}_${t.amount}`;
    if (seen.has(uid)) return;
    const keys = [t.customerPhone, t.contractName?.toLowerCase().trim(), t.customerName?.toLowerCase().trim()].filter(Boolean);
    const k = keys.find(key => invByCust[key]);
    if (k) { (txByCust[k] ||= []).push(t); seen.add(uid); }
  });
  Object.keys(txByCust).forEach(k => txByCust[k].sort((a,b) => (a.receivedTimestamp||0) - (b.receivedTimestamp||0)));
  const out = [];
  Object.keys(invByCust).forEach(ck => {
    const ci = invByCust[ck]; const ct = txByCust[ck] || [];
    if (ct.length === 0) return;
    const ib = ci.map(inv => ({ inv, remainingBalance: inv.amount, fullyPaid: false }));
    let idx = 0;
    ct.forEach(tx => {
      let amt = tx.amount; let used = false; const txp = [];
      while (amt > 0 && idx < ib.length) {
        const cur = ib[idx];
        if (cur.fullyPaid) { idx++; continue; }
        const pay = Math.min(amt, cur.remainingBalance);
        const rec = { customerName: cur.inv.customerName, invoiceNo: cur.inv.invoiceNumber,
          amount: pay, memo: tx.transactionId, memoWithSuffix: appendChannelSuffix(tx.transactionId, tx.channel),
          channel: tx.channel, customerId: cur.inv.customerId, qbId: cur.inv.qbId };
        out.push(rec); txp.push(rec);
        cur.remainingBalance -= pay; amt -= pay; used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTransactions.add(tx.transactionId || tx.id);
      if (amt > 0 && txp.length > 0) txp[0].amount += amt;
    });
  });
  const unused = transactions.filter(t => !usedTransactions.has(t.transactionId || t.id));
  unused.forEach(t => out.push({
    customerName: t.customerName || t.contractName || 'UNKNOWN',
    invoiceNo: 'UNUSED', amount: t.amount, transactionAmount: t.amount,
    memo: t.transactionId, memoWithSuffix: appendChannelSuffix(t.transactionId, t.channel),
    isUnused: true, channel: t.channel,
  }));
  return out;
}

console.log('1. Pulling /arrears…');
const arrears = [];
let start = 1;
while (true) {
  const r = await fetch(`${BASE}/arrears?pageSize=1000&start=${start}`);
  const j = await r.json();
  const invs = j.invoices || [];
  if (!invs.length) break;
  arrears.push(...invs);
  if (!j.page?.nextStart) break;
  start = j.page.nextStart;
}
const filtered = arrears.filter(i => new Date(i.date) < ARREARS_CUTOFF);
console.log(`   total=${arrears.length} | filter date<2026-06-01: ${filtered.length}`);

const invoices = filtered.map((inv, i) => ({
  id: i+1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
  amount: Number(inv.balance) || 0, invoiceDate: inv.date,
  customerPhone: extractPhone(inv.customer || ''),
  customerId: inv.customerId, qbId: inv.qbId,
}));

console.log('2. Pulling BANK CRDB sheet — window 31.05 full day…');
const sheetResp = await (await fetch(`${BASE}/sheets/${CRDB_SHEET}?range=PASSED!A1:H80000`)).json();
const sheet = sheetResp.values || [];
const parseTs = (s) => { const m = String(s||'').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`) : null; };

// Tally skipped (no-date) rows whose ROW NEIGHBORS dated within window — those are May-31 flagged removals.
function rowSurroundedByMay31(i) {
  let above = null, below = null;
  for (let j=i-1;j>=1;j--) { const t = parseTs(sheet[j][1]); if (t) { above = t; break; } }
  for (let j=i+1;j<sheet.length;j++) { const t = parseTs(sheet[j][1]); if (t) { below = t; break; } }
  const inMay31 = (d) => d && d >= WIN_START && d < WIN_END;
  return inMay31(above) || inMay31(below);
}

const txns = [];
let skipNoDateMay31 = 0; let skipNoDateAmtMay31 = 0;
for (let i=1;i<sheet.length;i++) {
  const dCell = String(sheet[i][1]||'').trim();
  if (!dCell) {
    if (rowSurroundedByMay31(i)) {
      skipNoDateMay31++;
      skipNoDateAmtMay31 += Number(String(sheet[i][4]||'0').replace(/,/g,''))||0;
    }
    continue;
  }
  const ts = parseTs(dCell);
  if (!ts || ts < WIN_START || ts >= WIN_END) continue;
  txns.push({
    id: sheet[i][0]||`bank-${i+1}`, channel: CHANNEL,
    customerPhone: sheet[i][5]||null, customerName: sheet[i][6]||null, contractName: sheet[i][6]||null,
    amount: sheet[i][4] ? Number(sheet[i][4]) : null,
    receivedTimestamp: ts.getTime(), transactionId: sheet[i][7]||null,
  });
}
const sheetSum = txns.reduce((s,t)=>s+(t.amount||0),0);
console.log(`   dated txns in window: ${txns.length} | sum=${sheetSum.toLocaleString()}`);
console.log(`   skipped (no-date, neighbors May 31): ${skipNoDateMay31} | sum=${skipNoDateAmtMay31.toLocaleString()}`);
console.log(`   full sheet (dated + skipped) May 31: ${(sheetSum+skipNoDateAmtMay31).toLocaleString()}`);

console.log('3. Algorithm…');
const result = processInvoicePayments(invoices, txns);
const paid = result.filter(p => !p.isUnused && p.amount > 0);
const unused = result.filter(p => p.isUnused);
const sumPaid = paid.reduce((s,p)=>s+p.amount,0);
const sumUnused = unused.reduce((s,p)=>s+(p.transactionAmount||0),0);
console.log();
console.log('═══ AUDIT — BANK CRDB full 31.05.2026 ═══');
console.log(`  Paid (→ QB Payment):           ${paid.length} | ${sumPaid.toLocaleString()} TZS`);
console.log(`  Unused (no QB customer):       ${unused.length} | ${sumUnused.toLocaleString()} TZS`);
console.log(`  Skipped (no-date flag, May 31):${skipNoDateMay31} | ${skipNoDateAmtMay31.toLocaleString()} TZS`);
console.log(`  ─────────────────────────────────────`);
console.log(`  Algorithm total (paid+unused): ${(sumPaid+sumUnused).toLocaleString()} TZS`);
console.log(`  Full May 31 (incl skipped):    ${(sumPaid+sumUnused+skipNoDateAmtMay31).toLocaleString()} TZS`);
console.log(`  Sheet dated sum:               ${sheetSum.toLocaleString()} TZS  ${sheetSum===(sumPaid+sumUnused)?'✓':'MISMATCH'}`);

if (txns.length === 0) { console.log('No transactions — exiting.'); process.exit(0); }

console.log('4. Storing snapshot…');
const snapResp = await fetch(`${BASE}/api/arrears-snapshots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
  body: JSON.stringify({
    as_of: '2026-05-31', data: filtered,
    created_by: 'catch-up-run2b-nmb-31may',
    notes: 'Run 2B — NMB full 31.05; arrears≤2026-05-31',
  }),
});
if (!snapResp.ok) throw new Error(`snapshot: ${snapResp.status} ${await snapResp.text()}`);
const { snapshot } = await snapResp.json();
console.log(`   snapshot.id=${snapshot.id}`);

const bankRefs = [...new Set(txns.map(t => appendChannelSuffix(t.transactionId, CHANNEL)).filter(Boolean))];
const paidBody = paid.map(p => ({
  bank_ref: p.memoWithSuffix, customer_id: p.customerId, invoice_qb_id: p.qbId,
  invoice_no: p.invoiceNo, amount: p.amount, memo: p.memoWithSuffix,
}));
const unusedBody = unused.map(u => ({
  bank_ref: u.memoWithSuffix, customer_id: null,
  customer_name: u.customerName, amount: u.transactionAmount, memo: u.memoWithSuffix,
}));

const idemSrc = JSON.stringify({ ch: CHANNEL, win:'31may-full', refs:bankRefs.slice().sort() });
const idem = 'run2b-nmb-31may-' + crypto.createHash('sha256').update(idemSrc).digest('hex').slice(0, 16);

console.log(`5. POSTing /api/payment-batches (idem=${idem})…`);
const upResp = await fetch(`${BASE}/api/payment-batches`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
  body: JSON.stringify({
    idempotency_key: idem, arrears_snapshot_id: snapshot.id,
    sheet_id: CRDB_SHEET, sheet_tab: 'PASSED', channel: CHANNEL,
    bank_refs: bankRefs, paid: paidBody, unused: unusedBody,
    created_by: 'catch-up-run2b',
  }),
});
const upText = await upResp.text();
console.log(`   status=${upResp.status}`);
console.log(`   body=${upText.slice(0, 800)}`);
