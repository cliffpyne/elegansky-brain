// Delete SaasAnt-pushed Payments at TxnDate=2026-06-03 that share refs with
// the IP NMB MIDNIGHT PAID 2ND JUNE.csv file. Keep BRAIN-pushed ones.

import pg from 'pg';
import fs from 'node:fs';

if (!process.env.DB_URL) throw new Error('DB_URL required');

const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const BATCH_SIZE = 30;
const PARALLEL = 6;
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const TARGET_TXN_DATE = '2026-06-03';

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
  const r = await fetch(TOKEN_REFRESH_URL, { method: 'POST',
    headers: { Authorization: 'Basic '+auth, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token='+encodeURIComponent(tokenState.refresh_token) });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  tokenState = { ...j, realmId: tokenState.realmId, acquiredAt: Date.now() };
  await saveTokens(tokenState);
}
async function ensureFresh() { if (tokenExpiringSoon(tokenState)) { if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; }); await refreshing; } }
async function q(sql) {
  for (let a=1;a<=6;a++) {
    await ensureFresh();
    try {
      const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=73`,
        { headers:{ Authorization:'Bearer '+tokenState.access_token, Accept:'application/json' }, signal: AbortSignal.timeout(30000) });
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

const refs = new Set(JSON.parse(fs.readFileSync('/tmp/ip_nmb_paid_refs.json','utf8')));
console.log('Distinct refs in IP NMB MIDNIGHT PAID file:', refs.size);

// BRAIN-tracked qb_ids (everything ever) — used as keep-list
const brain = await db.query(`SELECT qb_id FROM payment_uploads WHERE qb_id IS NOT NULL AND status='created'`);
const brainIds = new Set(brain.rows.map(r => r.qb_id));
console.log('BRAIN-tracked qb_ids (all time):', brainIds.size);

// Pull ALL Payments at TxnDate=06-03, filter to (a) refs in IP file, (b) NOT in BRAIN
const all = []; let start = 1;
while (true) {
  const j = await q(`SELECT * FROM Payment WHERE TxnDate='${TARGET_TXN_DATE}' STARTPOSITION ${start} MAXRESULTS 1000`);
  const arr = j.QueryResponse?.Payment || [];
  if (!arr.length) break;
  all.push(...arr);
  if (arr.length < 1000) break;
  start += 1000;
}
console.log(`Total Payments at TxnDate=${TARGET_TXN_DATE}:`, all.length);

const candidates = all.filter(p => {
  const note = String(p.PrivateNote||'').trim();
  return refs.has(note) && !brainIds.has(p.Id);
});
console.log(`SaasAnt duplicates to delete:`, candidates.length, '/', candidates.reduce((s,p)=>s+Number(p.TotalAmt||0),0).toLocaleString(), 'TZS');

if (candidates.length === 0) { console.log('Nothing to delete.'); process.exit(0); }

// Build delete chunks
const queue = candidates.map(p => ({ id: p.Id, syncToken: p.SyncToken }));
const chunks = [];
for (let i = 0; i < queue.length; i += BATCH_SIZE) chunks.push(queue.slice(i, i+BATCH_SIZE));
console.log(`${chunks.length} batches × ${BATCH_SIZE} ops, ${PARALLEL} in flight`);

let deleted=0, failed=0, cur=0;
const t0 = Date.now();
const worker = async () => {
  while (true) {
    const ci = cur++; if (ci >= chunks.length) return;
    const chunk = chunks[ci];
    const items = chunk.map((c, ix) => ({
      bId: `c${ci}-${ix}`, operation: 'delete',
      Payment: { Id: String(c.id), SyncToken: String(c.syncToken) },
    }));
    let results;
    try { results = await batchOp(items); }
    catch (err) { for (let i = 0; i < chunk.length; i++) failed++; continue; }
    for (let i = 0; i < chunk.length; i++) {
      const r = results[i];
      if (r?.Payment?.status === 'Deleted') deleted++;
      else failed++;
    }
    const elapsed = (Date.now() - t0)/1000;
    console.log(`  [${deleted+failed}/${queue.length}] deleted=${deleted} failed=${failed} (${((deleted+failed)/elapsed).toFixed(1)}/s)`);
  }
};
await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
console.log('');
console.log(`DONE — deleted=${deleted} failed=${failed} in ${((Date.now()-t0)/1000).toFixed(1)}s`);
await db.end();
