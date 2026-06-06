// UNDO only the 3 Step 1 batches I just uploaded today (2026-06-03 morning).
// Reason: I used AS_OF=2026-06-03 which pulled June-3 invoices into the
// matching pool. 483/630 payments hit June-3 invoices instead of June-2
// arrears as Frank intended.
//
// Approach: batch-delete via QB /batch endpoint (30 ops/call, 6 parallel).
// Mark payment_uploads as voided, batches as recalled.

import pg from 'pg';

if (!process.env.DB_URL) throw new Error('DB_URL required');

const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const BATCH_SIZE = 30;
const PARALLEL = 6;
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

// EXACTLY the 3 batches I uploaded this morning (Step 1):
const TARGET_BATCH_KEY_PATTERNS = [
  '03jun-step1-bank-%',
  '03jun-step1-nmbnew-%',
  '03jun-step1-iphone_bank-%',
];

const db = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();

let tokenState = null;
let refreshing = null;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function loadTokens() {
  const r = await db.query(`SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'`);
  const t = r.rows[0].token_json;
  t.realmId = r.rows[0].realm_id;
  return t;
}
async function saveTokens(t) {
  await db.query(`UPDATE app_oauth_tokens SET token_json=$1, updated_at=now() WHERE provider='quickbooks'`, [t]);
}
function tokenExpiringSoon(t) {
  const acq = Number(t?.acquiredAt) || 0;
  const expMs = Number(t?.expires_in || 0) * 1000;
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
async function q(sql) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureFresh();
    try {
      const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=73`, {
        headers: { Authorization: 'Bearer ' + tokenState.access_token, Accept: 'application/json' },
        signal: AbortSignal.timeout(30000),
      });
      if (r.status === 401) { if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; }); await refreshing; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * Math.pow(2, attempt-1)); continue; }
      if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,200)}`);
      return r.json();
    } catch (err) {
      if (attempt === 6) throw err;
      await sleep(1500 * Math.pow(2, attempt-1));
    }
  }
  throw new Error('q exceeded retries');
}
async function batchOp(items) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureFresh();
    try {
      const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/batch?minorversion=73`, {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + tokenState.access_token, Accept: 'application/json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ BatchItemRequest: items }),
        signal: AbortSignal.timeout(60000),
      });
      if (r.status === 401) { if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; }); await refreshing; continue; }
      if (r.status === 429 || r.status >= 500) { await sleep(1500 * Math.pow(2, attempt-1)); continue; }
      if (!r.ok) throw new Error(`batch ${r.status}: ${(await r.text()).slice(0,200)}`);
      const j = await r.json();
      const byBId = {};
      for (const x of j.BatchItemResponse || []) byBId[x.bId] = x;
      return items.map(it => byBId[it.bId]);
    } catch (err) {
      if (attempt === 6) throw err;
      await sleep(1500 * Math.pow(2, attempt-1));
    }
  }
  throw new Error('batch exceeded retries');
}

tokenState = await loadTokens();

const orClause = TARGET_BATCH_KEY_PATTERNS.map((_, ix) => `pb.idempotency_key LIKE $${ix+1}`).join(' OR ');
const rows = await db.query(
  `SELECT pu.id AS upload_id, pu.qb_id, pb.idempotency_key, pb.id AS batch_id
     FROM payment_uploads pu
     JOIN payment_batches pb ON pb.id = pu.batch_id
    WHERE pu.status='created' AND pu.qb_id IS NOT NULL AND pu.kind='payment'
      AND (${orClause})`,
  TARGET_BATCH_KEY_PATTERNS,
);
const distinctBatches = [...new Set(rows.rows.map(r => r.idempotency_key))];
console.log(`To delete: ${rows.rows.length} Payments across ${distinctBatches.length} batches:`);
for (const k of distinctBatches) console.log('  ', k);

if (rows.rows.length === 0) { console.log('Nothing to do.'); process.exit(0); }

// Fetch SyncTokens (Payments freshly created today should all have SyncToken=0
// but verify in case of concurrent edits).
const qbIdToSync = {};
const ids = rows.rows.map(r => r.qb_id);
const t0 = Date.now();
for (let i = 0; i < ids.length; i += 100) {
  const chunk = ids.slice(i, i + 100);
  const j = await q(`SELECT Id, SyncToken FROM Payment WHERE Id IN (${chunk.map(id => `'${id}'`).join(',')}) MAXRESULTS 1000`);
  for (const p of j.QueryResponse?.Payment || []) qbIdToSync[p.Id] = p.SyncToken;
}
console.log(`Fetched SyncTokens for ${Object.keys(qbIdToSync).length}/${ids.length} (${((Date.now()-t0)/1000).toFixed(1)}s)`);

// Build delete chunks
const uploadByQbId = {};
const queue = [];
for (const r of rows.rows) {
  uploadByQbId[r.qb_id] = r.upload_id;
  const st = qbIdToSync[r.qb_id];
  if (st === undefined) continue; // not found in QB → already deleted? skip
  queue.push({ qb_id: r.qb_id, syncToken: st });
}
const chunks = [];
for (let i = 0; i < queue.length; i += BATCH_SIZE) chunks.push(queue.slice(i, i + BATCH_SIZE));
console.log(`${chunks.length} batches × ${BATCH_SIZE} ops, ${PARALLEL} in flight → expect ~${Math.ceil(chunks.length / PARALLEL)}s`);

let deleted = 0, failed = 0;
const t1 = Date.now();
let chunkCursor = 0;
const worker = async () => {
  while (true) {
    const ci = chunkCursor++;
    if (ci >= chunks.length) return;
    const chunk = chunks[ci];
    const items = chunk.map((c, ix) => ({
      bId: `c${ci}-${ix}`,
      operation: 'delete',
      Payment: { Id: String(c.qb_id), SyncToken: String(c.syncToken) },
    }));
    let results;
    try {
      results = await batchOp(items);
    } catch (err) {
      for (const c of chunk) {
        failed++;
        await db.query(`UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`,
          [uploadByQbId[c.qb_id], 'undo-step1: ' + String(err.message||err).slice(0,200)]);
      }
      continue;
    }
    for (let i = 0; i < chunk.length; i++) {
      const c = chunk[i]; const r = results[i];
      const upload_id = uploadByQbId[c.qb_id];
      if (r?.Payment?.status === 'Deleted') {
        await db.query(
          `UPDATE payment_uploads SET status='voided', voided_at=now(), qb_void_response=$2 WHERE id=$1`,
          [upload_id, JSON.stringify(r.Payment)],
        );
        deleted++;
      } else {
        failed++;
        const errMsg = r?.Fault?.Error?.[0]?.Detail || r?.Fault?.Error?.[0]?.Message || JSON.stringify(r||{}).slice(0,200);
        await db.query(`UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`, [upload_id, 'undo-step1: ' + errMsg]);
      }
    }
    const elapsed = (Date.now() - t1) / 1000;
    const total = deleted + failed;
    console.log(`  [${total}/${queue.length}] deleted=${deleted} failed=${failed} (${(total/elapsed).toFixed(1)}/s)`);
  }
};
await Promise.all(Array.from({ length: PARALLEL }, () => worker()));
console.log('');
console.log(`DONE — deleted=${deleted} failed=${failed} in ${((Date.now()-t1)/1000).toFixed(1)}s`);

// Mark batches recalled
const batchIds = [...new Set(rows.rows.map(r => r.batch_id))];
await db.query(
  `UPDATE payment_batches SET status='recalled', recalled_at=now(), recalled_by='undo-step1' WHERE id = ANY($1::uuid[])`,
  [batchIds],
);
console.log(`Batches marked recalled: ${batchIds.length}`);
await db.end();
