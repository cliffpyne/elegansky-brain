// Upload today's unused records the same way SaasAnt does:
//   match customer by exact DisplayName (active first, balance>0 tiebreak)
//   POST unapplied Payment (no LinkedTxn) via QB Batch API → customer credit
//   any customer not found → write to a separate "needs SaasAnt" CSV
//
// Run after the main paid uploads. Uses batch API (30/chunk × 6 parallel)
// for speed. DepositToAccount=785 (Kijichi).

import pg from 'pg';
import fs from 'node:fs';

if (!process.env.DB_URL) throw new Error('DB_URL required');

const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const BATCH_SIZE = 30;
const PARALLEL = 6;
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const TXN_DATE = '2026-06-03';
const DEPOSIT_ACCT = '785';
const OUT_DIR = '/home/clifforddennis/Downloads';

// Source batches: today's unused
const BATCH_KEY_PATTERNS = [
  '03jun-step1v2-%',
];

const db = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
let tokenState = null; let refreshing = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function loadTokens() {
  const r = await db.query(`SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'`);
  const t = r.rows[0].token_json; t.realmId = r.rows[0].realm_id; return t;
}
async function saveTokens(t) { await db.query(`UPDATE app_oauth_tokens SET token_json=$1, updated_at=now() WHERE provider='quickbooks'`, [t]); }
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
async function ensureFresh() { if (tokenExpiringSoon(tokenState)) { if (!refreshing) refreshing = refreshNow().finally(()=>{refreshing=null}); await refreshing; } }
async function q(sql) {
  for (let a=1;a<=6;a++) {
    await ensureFresh();
    try {
      const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=73`, {
        headers:{ Authorization:'Bearer '+tokenState.access_token, Accept:'application/json' }, signal: AbortSignal.timeout(30000) });
      if (r.status === 401) { if (!refreshing) refreshing = refreshNow().finally(()=>{refreshing=null}); await refreshing; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(1500*Math.pow(2,a-1)); continue; }
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,200)}`);
      return r.json();
    } catch (err) { if (a===6) throw err; await sleep(1500*Math.pow(2,a-1)); }
  }
}
async function batchOp(items) {
  for (let a=1;a<=6;a++) {
    await ensureFresh();
    try {
      const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/batch?minorversion=73`, {
        method:'POST', headers:{ Authorization:'Bearer '+tokenState.access_token, Accept:'application/json', 'Content-Type':'application/json' },
        body: JSON.stringify({ BatchItemRequest: items }), signal: AbortSignal.timeout(60000) });
      if (r.status === 401) { if (!refreshing) refreshing = refreshNow().finally(()=>{refreshing=null}); await refreshing; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(1500*Math.pow(2,a-1)); continue; }
      if (!r.ok) throw new Error(`batch ${r.status}: ${(await r.text()).slice(0,200)}`);
      const j = await r.json();
      const byBId = {};
      for (const x of j.BatchItemResponse||[]) byBId[x.bId] = x;
      return items.map(it => byBId[it.bId]);
    } catch (err) { if (a===6) throw err; await sleep(1500*Math.pow(2,a-1)); }
  }
}

tokenState = await loadTokens();

// ── 1. Pull all unused from today's batches ──────────────────────────────
const orClause = BATCH_KEY_PATTERNS.map((_, ix) => `pb.idempotency_key LIKE $${ix+1}`).join(' OR ');
const r = await db.query(
  `SELECT pu.id AS upload_id, pu.bank_ref, pu.customer_name, pu.amount, pb.channel
     FROM payment_uploads pu
     JOIN payment_batches pb ON pb.id=pu.batch_id
    WHERE pu.kind='credit_memo' AND pu.status='unmatched'
      AND (${orClause})
    ORDER BY pu.id`,
  BATCH_KEY_PATTERNS,
);
console.log(`Unused records to process: ${r.rows.length}`);

// ── 2. Resolve customer_id for each via QB Customer query ─────────────────
// Bulk query in chunks. Match exact DisplayName, prefer Active=true,
// tiebreak Balance > 0.
const uniqueNames = [...new Set(r.rows.map(x => x.customer_name).filter(Boolean))];
console.log(`Distinct customer names: ${uniqueNames.length}`);
const nameToCustomerId = {};

for (let i = 0; i < uniqueNames.length; i += 30) {
  const chunk = uniqueNames.slice(i, i + 30);
  const inList = chunk.map(n => `'${n.replace(/'/g, "\\'")}'`).join(',');
  const j = await q(`SELECT Id, DisplayName, Active, Balance FROM Customer WHERE DisplayName IN (${inList}) MAXRESULTS 1000`);
  const all = j.QueryResponse?.Customer || [];
  // Group by DisplayName
  const byName = {};
  for (const cust of all) (byName[cust.DisplayName] ||= []).push(cust);
  for (const name of chunk) {
    const candidates = byName[name] || [];
    if (candidates.length === 0) continue;
    const active = candidates.filter(c => c.Active);
    const pickFrom = active.length ? active : candidates;
    const withBalance = pickFrom.filter(c => Number(c.Balance||0) > 0);
    const chosen = withBalance[0] || pickFrom[0];
    nameToCustomerId[name] = chosen.Id;
  }
}
const matched = uniqueNames.filter(n => nameToCustomerId[n]);
const unmatched = uniqueNames.filter(n => !nameToCustomerId[n]);
console.log(`Matched in QB    : ${matched.length}`);
console.log(`No match in QB   : ${unmatched.length}  → will go to SaasAnt CSV`);

// ── 3. Split rows into "push to QB" vs "needs SaasAnt" ────────────────────
const toPush = [];
const toSaasant = [];
for (const x of r.rows) {
  const cid = nameToCustomerId[x.customer_name];
  if (cid) toPush.push({ ...x, customerId: cid });
  else toSaasant.push(x);
}
console.log('');
console.log(`To push via BRAIN : ${toPush.length} rows / ${toPush.reduce((s,x)=>s+Number(x.amount),0).toLocaleString()} TZS`);
console.log(`To SaasAnt CSV   : ${toSaasant.length} rows / ${toSaasant.reduce((s,x)=>s+Number(x.amount),0).toLocaleString()} TZS`);

// ── 4. APPEND the unmatched into the master SaasAnt CSV ───────────────────
if (toSaasant.length) {
  const HEADER = ['Payment Date','Customer','Payment Method','Deposit To Account Name','Invoice No','Journal No','Amount','Reference No','Memo','Country Code','Exchange Rate'];
  const csv = (a) => a.map(v => { const s = String(v??''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g,'""') + '"' : s; }).join(',');
  const out = `${OUT_DIR}/BRAIN_unused_NEEDS_SAASANT_03jun.csv`;
  const fresh = !fs.existsSync(out) || fs.statSync(out).size === 0;
  const stream = fs.createWriteStream(out, { flags: 'a' });
  if (fresh) stream.write(csv(HEADER) + '\n');
  for (const x of toSaasant) {
    const memo = x.bank_ref.replace(/[NBP]$/, '');
    stream.write(csv(['06-03-2026', x.customer_name||'', 'Cash', 'Kijichi Collection AC', '', '', String(x.amount), '', memo, '', '']) + '\n');
  }
  await new Promise((res) => stream.end(res));
  console.log(`  → appended ${toSaasant.length} rows to ${out}`);
}

// ── 5. Push via QB Batch API as unapplied Payments ────────────────────────
if (toPush.length === 0) {
  console.log('Nothing to push.');
  await db.end();
  process.exit(0);
}

const chunks = [];
for (let i = 0; i < toPush.length; i += BATCH_SIZE) chunks.push(toPush.slice(i, i + BATCH_SIZE));
console.log(`Pushing ${chunks.length} batches × ${BATCH_SIZE} (parallel ${PARALLEL})…`);

let pushed = 0, failed = 0; let cursor = 0;
const t0 = Date.now();
const worker = async () => {
  while (true) {
    const ci = cursor++; if (ci >= chunks.length) return;
    const chunk = chunks[ci];
    const items = chunk.map((p, ix) => ({
      bId: `c${ci}-${ix}`,
      operation: 'create',
      Payment: {
        CustomerRef: { value: String(p.customerId) },
        TotalAmt: Number(p.amount),
        PrivateNote: p.bank_ref,
        TxnDate: TXN_DATE,
        DepositToAccountRef: { value: DEPOSIT_ACCT },
        // No Line[] → becomes unapplied customer credit (same as SaasAnt
        // "Receive Payment" with no Invoice No).
      },
    }));
    let results;
    try { results = await batchOp(items); }
    catch (err) {
      for (const p of chunk) {
        failed++;
        await db.query(`UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`, [p.upload_id, 'unused-push: ' + String(err.message||err).slice(0,200)]);
      }
      continue;
    }
    for (let i = 0; i < chunk.length; i++) {
      const p = chunk[i]; const r = results[i];
      if (r?.Payment?.Id) {
        await db.query(
          `UPDATE payment_uploads
              SET status='created', kind='payment', qb_id=$2, qb_response=$3,
                  customer_id=$4, failure_reason=NULL
            WHERE id=$1`,
          [p.upload_id, r.Payment.Id, JSON.stringify(r.Payment), String(p.customerId)],
        );
        pushed++;
      } else {
        failed++;
        const errMsg = r?.Fault?.Error?.[0]?.Detail || r?.Fault?.Error?.[0]?.Message || JSON.stringify(r||{}).slice(0,200);
        await db.query(`UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`, [p.upload_id, 'unused-push: ' + errMsg]);
      }
    }
    const el = (Date.now() - t0) / 1000;
    console.log(`  [${pushed+failed}/${toPush.length}] pushed=${pushed} failed=${failed} (${((pushed+failed)/el).toFixed(1)}/s, ${el.toFixed(1)}s)`);
  }
};
await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
console.log('');
console.log(`DONE — pushed=${pushed} failed=${failed} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
await db.end();
