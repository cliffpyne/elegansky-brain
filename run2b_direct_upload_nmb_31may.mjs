// Run 2B (DIRECT mode): NMB 31.05.2026 full day upload via direct QB API.
// Bypasses BRAIN's monolithic POST endpoint which keeps timing out / rolling
// back on transient QB 500s. We do per-record concurrent QB calls with retry,
// then assemble payment_uploads rows. Batch is created in DB up-front + marked
// 'finalized' at the end.

import pg from 'pg';
import crypto from 'node:crypto';

const BASE = 'https://elegansky-brain.onrender.com';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const CONCURRENCY = 5;
const SHEET_ID = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek';
const CHANNEL = 'nmbnew';
const SHEET_TAB = 'PASSED';
const WIN_START = new Date('2026-05-31T00:00:00Z');
const WIN_END   = new Date('2026-06-01T00:00:00Z');
const ARREARS_CUTOFF = new Date('2026-06-01T00:00:00Z');

const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');
const SECRET = process.env.STATEMENT_REPORT_SECRET;

function getChannelSuffix(c) { return { bank:'B', iphone_bank:'P', nmbnew:'N' }[c] || ''; }
function appendChannelSuffix(t, c) { if (!t) return ''; const s = getChannelSuffix(c); return s ? t+s : t; }
function extractPhone(s) { const m = (s||'').match(/\d{10,}/); return m ? m[0] : null; }

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
          amount: pay, memo: tx.transactionId, memoWithSuffix: appendChannelSuffix(tx.transactionId, tx.channel),
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
    memo: t.transactionId, memoWithSuffix: appendChannelSuffix(t.transactionId, t.channel),
    isUnused: true, channel: t.channel,
  }));
  return out;
}

// ── DB / QB ──────────────────────────────────────────────────────────────
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let tokenState = null; let refreshing = null;
async function loadTokens() {
  const r = await db.query("SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'");
  const t = r.rows[0].token_json; if (!t.realmId) t.realmId = r.rows[0].realm_id; return t;
}
async function saveTokens(t) {
  await db.query(`UPDATE app_oauth_tokens SET token_json=$1, realm_id=$2, updated_at=now() WHERE provider='quickbooks'`,
    [JSON.stringify(t), t.realmId ?? null]);
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
  console.log('  ↻ token refreshed');
}
async function ensureFresh() {
  if (tokenExpiringSoon(tokenState)) {
    if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
    await refreshing;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
async function qbCall(path, init) {
  await ensureFresh();
  return fetch(`${API_BASE}${path}`, {
    ...init, headers: { ...(init?.headers||{}), Authorization: 'Bearer ' + tokenState.access_token },
  });
}
async function qbCreatePayment({ customerId, invoiceQbId, amount, memo }) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const body = {
      CustomerRef: { value: customerId }, TotalAmt: amount, PrivateNote: memo || '',
      Line: [{ Amount: amount, LinkedTxn: [{ TxnId: invoiceQbId, TxnType: 'Invoice' }] }],
    };
    const r = await qbCall(`/v3/company/${tokenState.realmId}/payment?minorversion=73`, {
      method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'application/json' }, body: JSON.stringify(body),
    });
    if (r.status === 401) {
      if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
      await refreshing; continue;
    }
    if (r.status === 429 || r.status === 500 || r.status === 502 || r.status === 503) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500); continue;
    }
    if (!r.ok) throw new Error(`payment ${r.status}: ${(await r.text()).slice(0,200)}`);
    const j = await r.json();
    return { id: j.Payment?.Id, response: j };
  }
  throw new Error('payment: exceeded retries');
}

// ── 1. Pull arrears + snapshot ───────────────────────────────────────────
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

console.log('2. Storing snapshot via /api/arrears-snapshots…');
const snapResp = await fetch(`${BASE}/api/arrears-snapshots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
  body: JSON.stringify({
    as_of: '2026-05-31', data: filtered,
    created_by: 'direct-run2b-nmb-31may',
    notes: 'Run 2B direct-mode — NMB full 31.05; arrears≤2026-05-31',
  }),
});
if (!snapResp.ok) throw new Error(`snapshot: ${snapResp.status} ${await snapResp.text()}`);
const { snapshot } = await snapResp.json();
console.log(`   snapshot.id=${snapshot.id}`);

// ── 3. Sheet + algorithm ─────────────────────────────────────────────────
console.log('3. Pulling NMB sheet + running algorithm…');
const sheetResp = await (await fetch(`${BASE}/sheets/${SHEET_ID}?range=${SHEET_TAB}!A1:H80000`)).json();
const sheet = sheetResp.values || [];
const parseTs = (s) => { const m = String(s||'').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`) : null; };
const txns = [];
for (let i=1;i<sheet.length;i++) {
  const ts = parseTs(sheet[i][1]);
  if (!ts || ts < WIN_START || ts >= WIN_END) continue;
  txns.push({
    id: sheet[i][0]||`nmb-${i+1}`, channel: CHANNEL,
    customerPhone: sheet[i][5]||null, customerName: sheet[i][6]||null, contractName: sheet[i][6]||null,
    amount: sheet[i][4] ? Number(sheet[i][4]) : null,
    receivedTimestamp: ts.getTime(), transactionId: sheet[i][7]||null,
  });
}
const invoices = filtered.map((inv, i) => ({
  id: i+1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
  amount: Number(inv.balance) || 0, invoiceDate: inv.date,
  customerPhone: extractPhone(inv.customer || ''),
  customerId: inv.customerId, qbId: inv.qbId,
}));
const result = processInvoicePayments(invoices, txns);
const paid = result.filter(p => !p.isUnused && p.amount > 0);
const unused = result.filter(p => p.isUnused);
const sumPaid = paid.reduce((s,p)=>s+p.amount,0);
const sumUnused = unused.reduce((s,p)=>s+(p.transactionAmount||0),0);
const sheetSum = txns.reduce((s,t)=>s+(t.amount||0),0);
console.log(`   txns=${txns.length} sheet_sum=${sheetSum.toLocaleString()}`);
console.log(`   paid=${paid.length} sum=${sumPaid.toLocaleString()}  unused=${unused.length} sum=${sumUnused.toLocaleString()}`);
console.log(`   match: ${sheetSum === (sumPaid + sumUnused) ? '✓' : 'MISMATCH'}`);

// ── 4. Create batch + lock refs ──────────────────────────────────────────
tokenState = await loadTokens();
console.log('4. Creating batch row + locking refs…');
const bankRefs = [...new Set(txns.map(t => appendChannelSuffix(t.transactionId, CHANNEL)).filter(Boolean))];
const idemSrc = JSON.stringify({ ch: CHANNEL, win:'31may-direct', refs: bankRefs.slice().sort() });
const idem = 'run2b-direct-nmb-31may-' + crypto.createHash('sha256').update(idemSrc).digest('hex').slice(0,16);

await db.query('BEGIN');
const ins = await db.query(`INSERT INTO payment_batches (
    idempotency_key, status, arrears_snapshot_id,
    sheet_id, sheet_tab, channel, bank_refs,
    sheet_total, paid_total, unused_total,
    paid_count, unused_count, created_by
  ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING id`,
  [idem, snapshot.id, SHEET_ID, SHEET_TAB, CHANNEL, bankRefs,
   sheetSum, sumPaid, sumUnused, paid.length, unused.length, 'direct-run2b']);
const batchId = ins.rows[0].id;
// Bulk insert consumed_transactions in one statement (one round-trip, fast).
const tuples = bankRefs.map((_, i) => `($${i*2+1},$${i*2+2})`).join(',');
const vals = [];
bankRefs.forEach(r => { vals.push(r, batchId); });
await db.query(`INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ${tuples}`, vals);
await db.query('COMMIT');
console.log(`   batch.id=${batchId} | refs_locked=${bankRefs.length}`);

// ── 5. Upload paid concurrently ──────────────────────────────────────────
console.log(`5. Uploading ${paid.length} Payments via direct QB API (concurrency=${CONCURRENCY})…`);
let done = 0, failed = 0;
const startedAt = Date.now(); let cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= paid.length) return;
    const p = paid[i];
    try {
      const qb = await qbCreatePayment({
        customerId: p.customerId, invoiceQbId: p.qbId, amount: p.amount, memo: p.memoWithSuffix,
      });
      await db.query(`INSERT INTO payment_uploads (
          batch_id, kind, bank_ref, customer_id, customer_name,
          invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
        ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
        [batchId, p.memoWithSuffix, p.customerId, p.customerName,
         p.qbId, p.invoiceNo, p.amount, p.memoWithSuffix, qb.id, JSON.stringify(qb.response)]);
      done++;
    } catch (err) {
      failed++;
      await db.query(`INSERT INTO payment_uploads (
          batch_id, kind, bank_ref, customer_id, customer_name,
          invoice_qb_id, invoice_no, amount, memo, status, failure_reason
        ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'failed',$9)`,
        [batchId, p.memoWithSuffix, p.customerId, p.customerName,
         p.qbId, p.invoiceNo, p.amount, p.memoWithSuffix, String(err.message || err).slice(0, 500)]);
    }
    if ((done+failed) % 25 === 0) {
      const el = ((Date.now()-startedAt)/60_000).toFixed(1);
      const rate = (done+failed) / Math.max(1, (Date.now()-startedAt)/1000);
      console.log(`  [${done+failed}/${paid.length}]  done=${done}  failed=${failed}  rate=${rate.toFixed(1)}/s  elapsed=${el}m`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log(`Paid: done=${done}  failed=${failed}`);

// ── 6. Insert unmatched-unused rows ──────────────────────────────────────
console.log(`6. Inserting ${unused.length} unmatched-unused rows…`);
for (const u of unused) {
  await db.query(`INSERT INTO payment_uploads (
      batch_id, kind, bank_ref, customer_id, customer_name,
      amount, memo, status
    ) VALUES ($1,'credit_memo',$2,NULL,$3,$4,$5,'unmatched')`,
    [batchId, u.memoWithSuffix, u.customerName, u.transactionAmount, u.memoWithSuffix]);
}

// ── 7. Finalize ──────────────────────────────────────────────────────────
if (failed === 0) {
  await db.query(`UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`, [batchId]);
  console.log('═ Batch finalized. ═');
} else {
  console.log(`═ ${failed} failed — batch stays pending. ═`);
}

await db.end();
