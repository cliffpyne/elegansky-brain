// Delete the 5 batches we just uploaded (May 31 + June 1 NMB/CRDB/iPhone).
// Concurrency 10, retry on 429/500/stale.

import pg from 'pg';

const BATCH_IDS = [
  'fbb9a9f4-a981-4ef4-aef4-9226c907300b', // NMB May 31
  '62fa5c19-4776-4c8e-bc32-7aca52f8c532', // CRDB May 31
  'e4015507-fa36-456b-b51f-be337cd773a7', // NMB June 1
  'b747c634-f67d-480a-925c-d367a29761ea', // CRDB June 1
  '0cebef16-db44-4e26-b666-f33c27ec5f73', // iPhone June 1
];

const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const CONCURRENCY = 10;

const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');
const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let tokenState = null; let refreshing = null;
async function loadTokens() {
  const r = await db.query("SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'");
  const t = r.rows[0].token_json;
  if (!t.realmId) t.realmId = r.rows[0].realm_id;
  return t;
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
async function qbCall(path, init) {
  await ensureFresh();
  return fetch(`${API_BASE}${path}`, { ...init, headers: { ...(init?.headers || {}), Authorization: 'Bearer ' + tokenState.access_token } });
}
async function withRetry(makeReq, label) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    const r = await makeReq();
    if (r.status === 401) {
      if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
      await refreshing;
      continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(1000 * Math.pow(2, attempt - 1) + Math.random() * 500);
      continue;
    }
    return r;
  }
  throw new Error(`${label}: retries exhausted`);
}
async function deleteOne(qbId) {
  const q = await withRetry(
    () => qbCall(`/v3/company/${tokenState.realmId}/query?query=${encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${qbId}'`)}&minorversion=73`, { headers: { Accept: 'application/json' } }),
    'query',
  );
  if (!q.ok) throw new Error(`query ${q.status}: ${(await q.text()).slice(0, 150)}`);
  const j = await q.json();
  const p = j.QueryResponse?.Payment?.[0];
  if (!p) return { alreadyGone: true };
  const d = await withRetry(
    () => qbCall(`/v3/company/${tokenState.realmId}/payment?operation=delete&minorversion=73`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ Id: p.Id, SyncToken: p.SyncToken }),
    }),
    'delete',
  );
  if (!d.ok) throw new Error(`delete ${d.status}: ${(await d.text()).slice(0, 150)}`);
  return { ok: true };
}

tokenState = await loadTokens();
console.log('Token loaded. Realm:', tokenState.realmId);

const ups = await db.query(
  `SELECT id, qb_id FROM payment_uploads
    WHERE batch_id = ANY($1) AND status='created' AND kind='payment' AND qb_id IS NOT NULL
    ORDER BY created_at`,
  [BATCH_IDS],
);
console.log(`Found ${ups.rows.length} Payments to delete.`);

let done = 0, alreadyGone = 0, failed = 0;
const startedAt = Date.now();
let cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= ups.rows.length) return;
    const row = ups.rows[i];
    try {
      const r = await deleteOne(row.qb_id);
      if (r.alreadyGone) alreadyGone++;
      else done++;
      await db.query(`UPDATE payment_uploads SET status='voided', voided_at=now() WHERE id=$1`, [row.id]);
    } catch (err) {
      failed++;
      await db.query(`UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`, [row.id, String(err.message || err).slice(0, 500)]);
    }
    const total = done + alreadyGone + failed;
    if (total % 100 === 0) {
      const el = ((Date.now() - startedAt) / 60_000).toFixed(1);
      const rate = total / Math.max(1, (Date.now() - startedAt) / 1000);
      console.log(`  [${total}/${ups.rows.length}] deleted=${done} alreadyGone=${alreadyGone} failed=${failed} rate=${rate.toFixed(1)}/s elapsed=${el}m`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

if (failed === 0) {
  await db.query('BEGIN');
  await db.query(`DELETE FROM payment_uploads WHERE batch_id = ANY($1)`, [BATCH_IDS]);
  await db.query(`DELETE FROM consumed_transactions WHERE batch_id = ANY($1)`, [BATCH_IDS]);
  await db.query(`DELETE FROM payment_batches WHERE id = ANY($1)`, [BATCH_IDS]);
  await db.query('COMMIT');
  console.log('═ DB tables wiped for these 5 batches. ═');
} else {
  console.log(`═ ${failed} failed — DB rows left for inspection. ═`);
}
await db.end();
console.log(`\nDONE: deleted=${done} alreadyGone=${alreadyGone} failed=${failed}`);
