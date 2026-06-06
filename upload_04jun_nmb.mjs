// NMB upload — June 3 16:48 EAT → midnight EAT window.
//   AS_OF    = 2026-06-03  (bank-txn day, ALWAYS yesterday for this run)
//   TxnDate  = 2026-06-04  (post-cutoff books to today)
//
// Three-way split per row:
//   1. paid                    (customer matched + arrears found)  → Payment + LinkedTxn → QB
//   2. unused-with-customer    (customer matched, no arrears)      → unapplied Payment → QB
//   3. unused-no-customer      (no customer match in QB)           → NEEDS_SAASANT CSV (manual)
//
// All consumed refs are locked in consumed_transactions before we finalize.

import pg from 'pg';
import fs from 'node:fs';

const BRAIN_BASE = 'https://elegansky-brain.onrender.com';
const SECRET = process.env.STATEMENT_REPORT_SECRET;
if (!process.env.DB_URL) throw new Error('DB_URL required');
if (!SECRET) throw new Error('STATEMENT_REPORT_SECRET required');

// Configurable window/dates (CLI args override)
const AS_OF = process.argv[2] || '2026-06-03';
const TXN_DATE = process.argv[3] || '2026-06-04';
const SINCE_ISO = process.argv[4] || '2026-06-03T13:48:00Z'; // 16:48 EAT (= 1 min after last consumed 16:47)
const UNTIL_ISO = process.argv[5] || '2026-06-03T21:00:00Z'; // 00:00 EAT next day
const CONFIRM = process.argv.includes('--confirm');

const CHANNEL = 'nmbnew';
const REF_SUFFIX = 'N';
const SHEET_ID = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek';
const SHEET_TAB = 'PASSED';
const DEPOSIT_ACCT = '785';
const SAASANT_CSV = `/home/clifforddennis/Downloads/BRAIN_unused_NEEDS_SAASANT_04jun_nmb.csv`;

const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

const db = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
let tokenState = null; let refreshing = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ── QB helpers (fetch-based, shares DB token store) ───────────────────────
async function loadTokens() {
  const r = await db.query(`SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'`);
  const t = r.rows[0].token_json; t.realmId = r.rows[0].realm_id; return t;
}
async function saveTokens(t) {
  await db.query(`UPDATE app_oauth_tokens SET token_json=$1, updated_at=now() WHERE provider='quickbooks'`, [t]);
}
function tokenExpiringSoon(t) {
  const acq = Number(t?.acquiredAt)||0, expMs = Number(t?.expires_in||0)*1000;
  return !acq || !expMs || Date.now() >= acq + expMs - REFRESH_BUFFER_MS;
}
async function refreshNow() {
  const auth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_REFRESH_URL, { method:'POST',
    headers:{ Authorization:'Basic '+auth, Accept:'application/json', 'Content-Type':'application/x-www-form-urlencoded' },
    body:'grant_type=refresh_token&refresh_token='+encodeURIComponent(tokenState.refresh_token) });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  tokenState = { ...j, realmId: tokenState.realmId, acquiredAt: Date.now() };
  await saveTokens(tokenState);
}
async function ensureFresh() {
  if (tokenExpiringSoon(tokenState)) {
    if (!refreshing) refreshing = refreshNow().finally(()=>{refreshing=null});
    await refreshing;
  }
}
async function qbQuery(sql) {
  for (let a=1;a<=6;a++) {
    await ensureFresh();
    try {
      const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=73`, {
        headers:{ Authorization:'Bearer '+tokenState.access_token, Accept:'application/json' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 401) { if (!refreshing) refreshing = refreshNow().finally(()=>{refreshing=null}); await refreshing; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(1500*Math.pow(2,a-1)); continue; }
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,300)}`);
      return r.json();
    } catch (err) { if (a===6) throw err; await sleep(1500*Math.pow(2,a-1)); }
  }
}
async function qbBatchOp(items) {
  for (let a=1;a<=6;a++) {
    await ensureFresh();
    try {
      const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/batch?minorversion=73`, {
        method:'POST', headers:{ Authorization:'Bearer '+tokenState.access_token, Accept:'application/json', 'Content-Type':'application/json' },
        body: JSON.stringify({ BatchItemRequest: items }), signal: AbortSignal.timeout(60000) });
      if (r.status === 401) { if (!refreshing) refreshing = refreshNow().finally(()=>{refreshing=null}); await refreshing; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(1500*Math.pow(2,a-1)); continue; }
      if (!r.ok) throw new Error(`batch ${r.status}: ${(await r.text()).slice(0,300)}`);
      const j = await r.json();
      const byBId = {}; for (const x of j.BatchItemResponse||[]) byBId[x.bId] = x;
      return items.map(it => byBId[it.bId]);
    } catch (err) { if (a===6) throw err; await sleep(1500*Math.pow(2,a-1)); }
  }
}

tokenState = await loadTokens();

// ── 1. Pull CRDB sheet for window ────────────────────────────────────────
console.log(`Window: ${SINCE_ISO} → ${UNTIL_ISO}  (16:00 → 00:00 EAT)`);
console.log(`AS_OF: ${AS_OF}    TxnDate: ${TXN_DATE}`);
console.log('');
console.log('Pulling CRDB sheet…');
const sh = await (await fetch(`${BRAIN_BASE}/sheets/${SHEET_ID}?range=${SHEET_TAB}!A1:H80000`, { signal: AbortSignal.timeout(60000) })).json();
const rows = sh.values || [];
function parseTs(s) {
  const m = String(s||'').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (!m) return null;
  return new Date(Date.UTC(+m[3], +m[2]-1, +m[1], +m[4]-3, +m[5], +m[6]));  // EAT → UTC
}
const winStart = new Date(SINCE_ISO).getTime();
const winEnd = new Date(UNTIL_ISO).getTime();
const txns = [];
for (let i=1;i<rows.length;i++) {
  const ts = parseTs(rows[i][1]);
  if (!ts) continue;
  if (ts.getTime() < winStart || ts.getTime() >= winEnd) continue;
  const ref = String(rows[i][7]||'').trim();
  if (!ref) continue;
  const amt = Number(String(rows[i][4]||'0').replace(/,/g,''));
  if (!amt) continue;
  txns.push({
    id: rows[i][0] || `tx-${i+1}`,
    channel: CHANNEL,
    customerPhone: rows[i][5] || null,             // plate (matching key #1)
    customerName: String(rows[i][6]||'').trim(),  // name (matching key #3)
    contractName: String(rows[i][6]||'').trim(),
    amount: amt,
    receivedTimestamp: ts.getTime(),
    transactionId: ref,
    // legacy fields kept for back-compat
    ref, refWithSuffix: ref + REF_SUFFIX, receivedAt: rows[i][1],
  });
}
console.log(`  rows in window: ${txns.length}, total: ${txns.reduce((s,t)=>s+t.amount,0).toLocaleString()} TZS`);

// ── 2a. Intra-window dedup (same ref appearing >1× in sheet) ─────────────
const seenInWindow = new Set();
const txnsUnique = [];
let intraDupes = 0; let intraDupeAmt = 0;
for (const t of txns) {
  if (seenInWindow.has(t.refWithSuffix)) { intraDupes++; intraDupeAmt += t.amount; continue; }
  seenInWindow.add(t.refWithSuffix); txnsUnique.push(t);
}
if (intraDupes) console.log(`  intra-window duplicates skipped: ${intraDupes} rows / ${intraDupeAmt.toLocaleString()} TZS`);

// ── 2b. Pre-filter against consumed_transactions ─────────────────────────
const wantedRefs = [...seenInWindow];
const existing = await db.query(`SELECT bank_ref FROM consumed_transactions WHERE bank_ref = ANY($1)`, [wantedRefs]);
const lockedRefs = new Set(existing.rows.map(r => r.bank_ref));
const beforeCount = txnsUnique.length;
const unprocessed = txnsUnique.filter(t => !lockedRefs.has(t.refWithSuffix));
console.log(`  already consumed: ${beforeCount - unprocessed.length} skipped`);
console.log(`  unprocessed remaining: ${unprocessed.length}, total: ${unprocessed.reduce((s,t)=>s+t.amount,0).toLocaleString()} TZS`);

if (unprocessed.length === 0) { console.log('Nothing to do.'); await db.end(); process.exit(0); }

// ── 3. Pull /arrears at AS_OF=yesterday ──────────────────────────────────
console.log(`\nFetching /arrears?asOf=${AS_OF}…`);
const arrears = [];
let start = 1;
while (true) {
  const r = await fetch(`${BRAIN_BASE}/arrears?pageSize=1000&start=${start}&asOf=${AS_OF}`, { signal: AbortSignal.timeout(60000) });
  if (!r.ok) throw new Error(`arrears ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const invs = j.invoices || [];
  if (!invs.length) break;
  arrears.push(...invs);
  if (!j.page?.nextStart) break;
  start = j.page.nextStart;
}
console.log(`  arrears entries: ${arrears.length}`);

// ── 4. Run VERBATIM IP algorithm (ported from BRAIN's processInvoicePayments) ─
function extractPhone(s) { const m = (s||'').match(/\d{10,}/); return m ? m[0] : null; }
function appendSuf(t, c) { const sfx = { bank:'B', iphone_bank:'P', nmbnew:'N' }[c] || ''; return t ? t + sfx : ''; }

const invoices = arrears.map((inv, i) => ({
  id: i + 1,
  customerName: inv.customerLeaf,
  invoiceNumber: inv.no,
  amount: Number(inv.balance) || 0,
  invoiceDate: inv.date,
  customerPhone: extractPhone(inv.customer || ''),
  customerId: inv.customerId,
  qbId: inv.qbId,
}));

function processInvoicePayments(invoices, transactions) {
  const usedTx = new Set();
  const invByCust = {};
  invoices.forEach((inv) => {
    const key = inv.customerPhone || inv.customerName.toLowerCase().trim();
    (invByCust[key] ||= []).push(inv);
  });
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
  Object.keys(txByCust).forEach((k) => txByCust[k].sort((a, b) => (a.receivedTimestamp || 0) - (b.receivedTimestamp || 0)));
  const out = [];
  Object.keys(invByCust).forEach((ck) => {
    const ci = invByCust[ck]; const ct = txByCust[ck] || [];
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
        };
        out.push(rec); txp.push(rec);
        cur.remainingBalance -= pay; amt -= pay; used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTx.add(tx.transactionId || tx.id);
      if (amt > 0 && txp.length > 0) txp[0].amount += amt;
    });
  });
  const unused = transactions.filter((t) => !usedTx.has(t.transactionId || t.id));
  unused.forEach((t) => out.push({
    customerName: t.customerName || t.contractName || 'UNKNOWN',
    invoiceNo: 'UNUSED', amount: t.amount, transactionAmount: t.amount,
    memo: t.transactionId, memoWithSuffix: appendSuf(t.transactionId, t.channel),
    isUnused: true, channel: t.channel,
  }));
  return out;
}

const allocOut = processInvoicePayments(invoices, unprocessed);
const paidRaw = allocOut.filter(r => !r.isUnused);
const unusedRaw = allocOut.filter(r => r.isUnused);
console.log(`\nIP-algorithm output:`);
console.log(`  paid  : ${paidRaw.length} allocations / ${paidRaw.reduce((s,p)=>s+p.amount,0).toLocaleString()} TZS`);
console.log(`  unused: ${unusedRaw.length} txns / ${unusedRaw.reduce((s,p)=>s+p.amount,0).toLocaleString()} TZS`);

// Rebuild paid + unused in our pipeline shape
const paid = paidRaw.map(p => ({
  ref: p.memoWithSuffix, customerName: p.customerName,
  customerId: p.customerId, invoiceQbId: p.qbId, invoiceNo: p.invoiceNo,
  amount: p.amount,
}));
const unusedWithCust = [];
const unusedNoCust = [];
// Will resolve customerId via QB lookup below
const _unusedTodo = unusedRaw.map(u => ({
  ref: u.memoWithSuffix, customerName: u.customerName, amount: u.amount, customerId: null,
}));

// ── 5. For unused rows, look up customer in QB ─────────────────────────
const lookupNames = [...new Set(_unusedTodo.map(u => u.customerName))];
console.log(`\nLooking up ${lookupNames.length} unique customer names in QB…`);
const nameToCustomerId = {};
for (let i = 0; i < lookupNames.length; i += 30) {
  const chunk = lookupNames.slice(i, i + 30);
  const inList = chunk.map(n => `'${String(n).replace(/'/g, "\\'")}'`).join(',');
  const j = await qbQuery(`SELECT Id, DisplayName, Active, Balance FROM Customer WHERE DisplayName IN (${inList}) MAXRESULTS 1000`);
  const all = j.QueryResponse?.Customer || [];
  const byName = {};
  for (const cust of all) (byName[cust.DisplayName] ||= []).push(cust);
  for (const name of chunk) {
    const candidates = byName[name] || [];
    if (!candidates.length) continue;
    const active = candidates.filter(c => c.Active);
    const pickFrom = active.length ? active : candidates;
    const withBal = pickFrom.filter(c => Number(c.Balance||0) > 0);
    nameToCustomerId[name] = (withBal[0] || pickFrom[0]).Id;
  }
}
const stillWithCust = [];
for (const u of _unusedTodo) {
  u.customerId = nameToCustomerId[u.customerName];
  if (u.customerId) stillWithCust.push(u);
  else unusedNoCust.push(u);
}
console.log(`  customer matched (push to QB):     ${stillWithCust.length}`);
console.log(`  customer NOT matched (SaasAnt CSV): ${unusedNoCust.length}`);

console.log(`\nFinal plan (post lookups):`);
console.log(`  paid:                 ${paid.length} / ${paid.reduce((s,p)=>s+p.amount,0).toLocaleString()} TZS  → Payment + LinkedTxn`);
console.log(`  unused → QB Payment:  ${stillWithCust.length} / ${stillWithCust.reduce((s,p)=>s+p.amount,0).toLocaleString()} TZS  → unapplied Payment`);
console.log(`  unused → SaasAnt CSV: ${unusedNoCust.length} / ${unusedNoCust.reduce((s,p)=>s+p.amount,0).toLocaleString()} TZS`);
const total = paid.reduce((s,p)=>s+p.amount,0) + stillWithCust.reduce((s,p)=>s+p.amount,0) + unusedNoCust.reduce((s,p)=>s+p.amount,0);
console.log(`  reconciles to:        ${total.toLocaleString()} TZS  (input was ${unprocessed.reduce((s,t)=>s+t.amount,0).toLocaleString()})`);

if (!CONFIRM) {
  console.log('');
  console.log('DRY RUN — pass --confirm to push to QB / write CSV / lock refs.');
  await db.end();
  process.exit(0);
}

// ── 6. Create payment_batches row ────────────────────────────────────────
const idemKey = `heisenberg-04jun-nmb-${Date.now()}`;
const sheetSum = unprocessed.reduce((s,t)=>s+t.amount,0);
const paidSum = paid.reduce((s,p)=>s+p.amount,0);
const unusedSum = stillWithCust.reduce((s,p)=>s+p.amount,0) + unusedNoCust.reduce((s,p)=>s+p.amount,0);

// We need an arrears_snapshot_id. Create one.
const snap = await db.query(
  `INSERT INTO arrears_snapshots (as_of, data, row_count, total_balance, created_by, notes)
   VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
  [AS_OF, JSON.stringify(arrears), arrears.length, arrears.reduce((s,a)=>s+Number(a.invoiceBalance||a.balance||0),0).toFixed(2), 'heisenberg-script', 'NMB 16:48 to 00:00 EAT manual upload']
);
const snapshotId = snap.rows[0].id;

const batchRow = await db.query(
  `INSERT INTO payment_batches (idempotency_key, status, arrears_snapshot_id, sheet_id, sheet_tab, channel,
                                bank_refs, sheet_total, paid_total, unused_total, paid_count, unused_count, created_by)
   VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
  [idemKey, snapshotId, SHEET_ID, SHEET_TAB, CHANNEL,
   unprocessed.map(t => t.refWithSuffix), sheetSum, paidSum, unusedSum, paid.length, stillWithCust.length + unusedNoCust.length, 'heisenberg-script']
);
const batchId = batchRow.rows[0].id;
console.log(`\nCreated payment_batch: ${batchId}`);

// Lock refs
for (const t of unprocessed) {
  await db.query(`INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ($1, $2) ON CONFLICT DO NOTHING`, [t.refWithSuffix, batchId]);
}
console.log(`Locked ${unprocessed.length} refs in consumed_transactions.`);

// ── 7. Push paid via batch API ───────────────────────────────────────────
console.log('\nPushing paid (Payment + LinkedTxn) via QB Batch API…');
async function pushPayments(items, withLinkedTxn, label) {
  const CHUNK = 30; const PAR = 6;
  let cursor = 0; let pushed = 0; let failed = 0;
  const chunks = []; for (let i=0;i<items.length;i+=CHUNK) chunks.push(items.slice(i,i+CHUNK));
  const t0 = Date.now();
  const worker = async () => {
    while (true) {
      const ci = cursor++; if (ci >= chunks.length) return;
      const chunk = chunks[ci];
      const ops = chunk.map((p, ix) => ({
        bId: `${label}-${ci}-${ix}`, operation: 'create',
        Payment: {
          CustomerRef: { value: String(p.customerId) },
          TotalAmt: Number(p.amount),
          PrivateNote: p.ref,
          TxnDate: TXN_DATE,
          DepositToAccountRef: { value: DEPOSIT_ACCT },
          ...(withLinkedTxn ? {
            Line: [{ Amount: Number(p.amount), LinkedTxn: [{ TxnId: String(p.invoiceQbId), TxnType: 'Invoice' }] }]
          } : {}),
        }
      }));
      let results;
      try { results = await qbBatchOp(ops); }
      catch (err) {
        for (const p of chunk) {
          failed++;
          await db.query(`INSERT INTO payment_uploads (batch_id, kind, bank_ref, customer_id, customer_name, invoice_qb_id, invoice_no, amount, memo, status, failure_reason)
                          VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'failed',$9)`,
            [batchId, p.ref, String(p.customerId), p.customerName || null, p.invoiceQbId || null, p.invoiceNo || null, p.amount, p.ref, String(err.message).slice(0,300)]);
        }
        continue;
      }
      for (let i = 0; i < chunk.length; i++) {
        const p = chunk[i]; const r = results[i];
        if (r?.Payment?.Id) {
          await db.query(`INSERT INTO payment_uploads (batch_id, kind, bank_ref, customer_id, customer_name, invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status)
                          VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
            [batchId, p.ref, String(p.customerId), p.customerName || null, p.invoiceQbId || null, p.invoiceNo || null, p.amount, p.ref, r.Payment.Id, JSON.stringify(r.Payment)]);
          pushed++;
        } else {
          failed++;
          const errMsg = r?.Fault?.Error?.[0]?.Detail || r?.Fault?.Error?.[0]?.Message || JSON.stringify(r||{}).slice(0,200);
          await db.query(`INSERT INTO payment_uploads (batch_id, kind, bank_ref, customer_id, customer_name, invoice_qb_id, invoice_no, amount, memo, status, failure_reason)
                          VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'failed',$9)`,
            [batchId, p.ref, String(p.customerId), p.customerName || null, p.invoiceQbId || null, p.invoiceNo || null, p.amount, p.ref, errMsg]);
        }
      }
      const el = (Date.now()-t0)/1000;
      console.log(`  ${label} [${pushed+failed}/${items.length}] pushed=${pushed} failed=${failed} (${el.toFixed(1)}s)`);
    }
  };
  await Promise.all(Array.from({length:PAR}, ()=>worker()));
  return { pushed, failed };
}

const paidResult = paid.length ? await pushPayments(paid, true, 'paid') : { pushed:0, failed:0 };
const unusedResult = stillWithCust.length ? await pushPayments(stillWithCust, false, 'unusedwc') : { pushed:0, failed:0 };
console.log(`Paid             : ${paidResult.pushed} pushed / ${paidResult.failed} failed`);
console.log(`Unused (to QB)   : ${unusedResult.pushed} pushed / ${unusedResult.failed} failed`);

// ── 8. Write unusedNoCust to NEEDS_SAASANT CSV ───────────────────────────
if (unusedNoCust.length) {
  const HEADER = ['Payment Date','Customer','Payment Method','Deposit To Account Name','Invoice No','Journal No','Amount','Reference No','Memo','Country Code','Exchange Rate'];
  const csv = (a) => a.map(v => { const s = String(v??''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }).join(',');
  const fresh = !fs.existsSync(SAASANT_CSV) || fs.statSync(SAASANT_CSV).size === 0;
  const stream = fs.createWriteStream(SAASANT_CSV, { flags: 'a' });
  if (fresh) stream.write(csv(HEADER) + '\n');
  const txnDateMmdd = TXN_DATE.slice(5,7) + '-' + TXN_DATE.slice(8,10) + '-' + TXN_DATE.slice(0,4);
  for (const u of unusedNoCust) {
    const memo = u.ref.replace(/[NBP]$/,'');
    stream.write(csv([txnDateMmdd, u.customerName, 'Cash', 'Kijichi Collection AC', '', '', u.amount, '', memo, '', '']) + '\n');
  }
  await new Promise(res => stream.end(res));
  console.log(`SaasAnt CSV    : appended ${unusedNoCust.length} rows → ${SAASANT_CSV}`);
}

// ── 9. Finalize batch ────────────────────────────────────────────────────
await db.query(`UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`, [batchId]);
console.log(`\nFinalized batch ${batchId}.`);
await db.end();
