// NMB May 31 full day, arrears filtered ?asOf=2026-05-31 so June 1 invoices
// are NOT in the matching pool. Direct QB Payment creation, concurrency 2,
// retry on 429/500.

import pg from 'pg';
import crypto from 'node:crypto';

const BASE = 'https://elegansky-brain.onrender.com';
const SECRET = process.env.STATEMENT_REPORT_SECRET;
const url = process.env.DB_URL;
if (!url || !SECRET) throw new Error('DB_URL + STATEMENT_REPORT_SECRET required');
const SHEET = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek';
const TAB = 'PASSED';
const CHANNEL = 'nmbnew';

const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const CONCURRENCY = 2;

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
function appendSuf(t, c) { const sfx = { bank:'B', iphone_bank:'P', nmbnew:'N' }[c] || ''; return t ? t + sfx : ''; }

function processInvoicePayments(invoices, transactions) {
  const usedTx = new Set();
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
          amount: pay, memo: tx.transactionId, memoWithSuffix: appendSuf(tx.transactionId, tx.channel),
          channel: tx.channel, customerId: cur.inv.customerId, qbId: cur.inv.qbId };
        out.push(rec); txp.push(rec);
        cur.remainingBalance -= pay; amt -= pay; used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTx.add(tx.transactionId || tx.id);
      if (amt > 0 && txp.length > 0) txp[0].amount += amt;
    });
  });
  const unused = transactions.filter(t => !usedTx.has(t.transactionId || t.id));
  unused.forEach(t => out.push({
    customerName: t.customerName || t.contractName || 'UNKNOWN',
    invoiceNo: 'UNUSED', amount: t.amount, transactionAmount: t.amount,
    memo: t.transactionId, memoWithSuffix: appendSuf(t.transactionId, t.channel),
    isUnused: true, channel: t.channel,
  }));
  return out;
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let tokenState = null; let refreshing = null;
async function loadTokens() {
  const r = await db.query("SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'");
  const t = r.rows[0].token_json; if (!t.realmId) t.realmId = r.rows[0].realm_id; return t;
}
async function saveTokens(t) {
  await db.query(`UPDATE app_oauth_tokens SET token_json=$1, updated_at=now() WHERE provider='quickbooks'`, [JSON.stringify(t)]);
}
function tokenExpiringSoon(t) {
  if (!t) return true;
  const acq = Number(t.acquiredAt) || 0;
  const expMs = Number(t.expires_in || 0) * 1000;
  return !acq || !expMs || Date.now() >= acq + expMs - REFRESH_BUFFER_MS;
}
async function refreshNow() {
  const auth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_REFRESH_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(tokenState.refresh_token),
  });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  tokenState = { ...j, realmId: tokenState.realmId, acquiredAt: Date.now() };
  await saveTokens(tokenState);
}
async function ensureFresh() {
  if (tokenExpiringSoon(tokenState)) {
    if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
    await refreshing;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function qbCreatePayment({ customerId, invoiceQbId, amount, memo }) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureFresh();
    const body = {
      CustomerRef: { value: String(customerId) }, TotalAmt: Number(amount),
      PrivateNote: memo || '',
      Line: [{ Amount: Number(amount), LinkedTxn: [{ TxnId: String(invoiceQbId), TxnType: 'Invoice' }] }],
    };
    const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/payment?minorversion=73`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + tokenState.access_token },
      body: JSON.stringify(body),
    });
    if (r.status === 401) {
      if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
      await refreshing; continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500); continue;
    }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,200)}`);
    const j = await r.json();
    return { id: j.Payment?.Id, response: j };
  }
  throw new Error('exceeded retries');
}

// ── 1. Pull arrears with asOf=2026-05-31 ──────────────────────────────────
console.log('1. Pulling /arrears?asOf=2026-05-31…');
const arrears = [];
let start = 1;
while (true) {
  const r = await fetch(`${BASE}/arrears?pageSize=1000&start=${start}&asOf=2026-05-31`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  const invs = j.invoices || [];
  if (!invs.length) break;
  arrears.push(...invs);
  if (!j.page?.nextStart) break;
  start = j.page.nextStart;
}
console.log(`   ${arrears.length} invoices (≤ DueDate 2026-05-31)`);

// ── 2. Save snapshot via API ──────────────────────────────────────────────
console.log('2. Storing snapshot…');
const sRes = await fetch(`${BASE}/api/arrears-snapshots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
  body: JSON.stringify({ as_of: '2026-05-31', data: arrears, created_by: 'redo-nmb-31may-filtered', notes: 'NMB May 31 redo, arrears strictly ≤ May 31' }),
});
const { snapshot } = await sRes.json();
console.log(`   snapshot.id=${snapshot.id}`);

// ── 3. Pull NMB sheet, filter May 31 ──────────────────────────────────────
console.log('3. Pulling NMB sheet + filtering 31.05.2026…');
const sh = await (await fetch(`${BASE}/sheets/${SHEET}?range=${TAB}!A1:H80000`, { signal: AbortSignal.timeout(60000) })).json();
const sheet = sh.values || [];
const winStart = new Date('2026-05-31T00:00:00Z');
const winEnd   = new Date('2026-06-01T00:00:00Z');
const txns = [];
let skippedNoDate = 0;
for (let i=1;i<sheet.length;i++) {
  const dCell = String(sheet[i][1]||'').trim();
  if (!dCell) { skippedNoDate++; continue; }
  const ts = parseTsAny(dCell);
  if (ts && (ts < winStart || ts >= winEnd)) continue;
  if (!ts) continue;
  txns.push({
    id: sheet[i][0]||`tx-${i+1}`, channel: CHANNEL,
    customerPhone: sheet[i][5]||null, customerName: sheet[i][6]||null, contractName: sheet[i][6]||null,
    amount: sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g,'')) : null,
    receivedTimestamp: ts.getTime(), transactionId: sheet[i][7]||null,
  });
}
const sheetSum = txns.reduce((s,t)=>s+(t.amount||0),0);
console.log(`   ${txns.length} NMB rows | sheet_sum=${sheetSum.toLocaleString()} (skipped no-date: ${skippedNoDate})`);

// ── 4. Filter already-consumed refs ──────────────────────────────────────
const allRefs = txns.map(t => appendSuf(t.transactionId, CHANNEL)).filter(Boolean);
const ec = await db.query(`SELECT bank_ref FROM consumed_transactions WHERE bank_ref = ANY($1)`, [allRefs]);
const consumed = new Set(ec.rows.map(r => r.bank_ref));
const txnsClean = txns.filter(t => !consumed.has(appendSuf(t.transactionId, CHANNEL)));
const cleanSum = txnsClean.reduce((s,t)=>s+(t.amount||0),0);
console.log(`   clean (unconsumed): ${txnsClean.length} | sum=${cleanSum.toLocaleString()}`);

// ── 5. Algorithm ─────────────────────────────────────────────────────────
const invoices = arrears.map((inv,i) => ({
  id: i+1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
  amount: Number(inv.balance) || 0, invoiceDate: inv.date,
  customerPhone: extractPhone(inv.customer || ''),
  customerId: inv.customerId, qbId: inv.qbId,
}));

console.log('4. Running algorithm…');
const result = processInvoicePayments(invoices, txnsClean);
const paid = result.filter(p => !p.isUnused && p.amount > 0);
const unused = result.filter(p => p.isUnused);
const sumPaid = paid.reduce((s,p)=>s+p.amount,0);
const sumUnused = unused.reduce((s,p)=>s+(p.transactionAmount||0),0);

console.log();
console.log('═══ NMB MAY 31 AUDIT ═══');
console.log(`  Arrears (≤ May 31 DueDate): ${invoices.length}`);
console.log(`  Sheet transactions:         ${txnsClean.length} | ${cleanSum.toLocaleString()}`);
console.log(`  Paid records (→ QB):        ${paid.length} | ${sumPaid.toLocaleString()}`);
console.log(`  Unused (→ officer review):  ${unused.length} | ${sumUnused.toLocaleString()}`);
console.log(`  Sum (paid + unused):        ${(sumPaid+sumUnused).toLocaleString()} | match sheet=${(sumPaid+sumUnused)===cleanSum?'✓':'MISMATCH'}`);

if (paid.length === 0) { console.log('Nothing to upload.'); process.exit(0); }
if (process.env.DRYRUN === '1') { console.log('DRYRUN=1 — exiting without uploading.'); process.exit(0); }

// ── 6. Create batch + lock refs ──────────────────────────────────────────
tokenState = await loadTokens();
console.log('\n5. Creating batch + locking refs + uploading to QB…');
const bankRefs = [...new Set(txnsClean.map(t => appendSuf(t.transactionId, CHANNEL)).filter(Boolean))];
const idem = `redo-nmb-31may-filtered-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

await db.query('BEGIN');
const ins = await db.query(`INSERT INTO payment_batches (
    idempotency_key, status, arrears_snapshot_id,
    sheet_id, sheet_tab, channel, bank_refs,
    sheet_total, paid_total, unused_total,
    paid_count, unused_count, created_by
  ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'redo-nmb-31may-filtered') RETURNING id`,
  [idem, snapshot.id, SHEET, TAB, CHANNEL, bankRefs, cleanSum, sumPaid, sumUnused, paid.length, unused.length]);
const batchId = ins.rows[0].id;
const tuples = bankRefs.map((_, i) => `($${i*2+1},$${i*2+2})`).join(',');
const vals = []; bankRefs.forEach(r => vals.push(r, batchId));
await db.query(`INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ${tuples}`, vals);
await db.query('COMMIT');
console.log(`   batch.id=${batchId}`);

// ── 7. Upload paid records (concurrency 2 + retry) ───────────────────────
let done = 0, failed = 0; let cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= paid.length) return;
    const p = paid[i];
    try {
      const qb = await qbCreatePayment({ customerId: p.customerId, invoiceQbId: p.qbId, amount: p.amount, memo: p.memoWithSuffix });
      await db.query(`INSERT INTO payment_uploads (
          batch_id, kind, bank_ref, customer_id, customer_name,
          invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
        ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
        [batchId, p.memoWithSuffix, p.customerId, p.customerName, p.qbId, p.invoiceNo, p.amount, p.memoWithSuffix, qb.id, JSON.stringify(qb.response)]);
      done++;
    } catch (err) {
      failed++;
      await db.query(`INSERT INTO payment_uploads (
          batch_id, kind, bank_ref, customer_id, customer_name,
          invoice_qb_id, invoice_no, amount, memo, status, failure_reason
        ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'failed',$9)`,
        [batchId, p.memoWithSuffix, p.customerId, p.customerName, p.qbId, p.invoiceNo, p.amount, p.memoWithSuffix, String(err.message||err).slice(0,500)]);
    }
    if ((done+failed) % 50 === 0) console.log(`  [${done+failed}/${paid.length}] done=${done} failed=${failed}`);
  }
}
await Promise.all(Array.from({length: CONCURRENCY}, () => worker()));
console.log(`Paid: done=${done} failed=${failed}`);

// ── 8. Insert unused (officer review, SaasAnt-format-ready) ──────────────
for (const u of unused) {
  await db.query(`INSERT INTO payment_uploads (
      batch_id, kind, bank_ref, customer_id, customer_name,
      amount, memo, status
    ) VALUES ($1,'credit_memo',$2,NULL,$3,$4,$5,'unmatched')`,
    [batchId, u.memoWithSuffix, u.customerName, u.transactionAmount, u.memoWithSuffix]);
}

if (failed === 0) {
  await db.query(`UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`, [batchId]);
  console.log('═ batch finalized ═');
}

await db.end();
console.log(`\nDONE.`);
