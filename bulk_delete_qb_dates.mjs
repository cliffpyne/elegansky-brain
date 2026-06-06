// Bulk-delete every QB Payment dated 2026-05-31 through 2026-06-02
// (the dates BRAIN polluted today). Reads from the pre-saved snapshot
// so we know exactly which qb_ids to hit + can compare against the
// snapshot afterwards.
//
// Concurrency 10 — Intuit's ~500/min ceiling tolerates this if individual
// calls average ~150ms.

import pg from 'pg';
import { readFileSync } from 'node:fs';

const SNAP = process.env.SNAP;
if (!SNAP) throw new Error('SNAP env var (path to qb_payments_may31_to_jun2.json) required');
const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');

const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const CONCURRENCY = 10;

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
async function deleteOne(qbId, syncToken) {
  // First try the snapshot's syncToken; if 400 with Stale Object, refetch.
  for (let pass = 0; pass < 2; pass++) {
    const d = await withRetry(
      () => qbCall(`/v3/company/${tokenState.realmId}/payment?operation=delete&minorversion=73`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ Id: qbId, SyncToken: syncToken }),
      }),
      'delete',
    );
    if (d.ok) return { ok: true };
    const body = await d.text();
    if (/Stale Object|409/.test(body)) {
      // Refetch
      const q = await withRetry(
        () => qbCall(`/v3/company/${tokenState.realmId}/query?query=${encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${qbId}'`)}&minorversion=73`, { headers: { Accept: 'application/json' } }),
        'query',
      );
      if (!q.ok) throw new Error(`requery ${q.status}: ${(await q.text()).slice(0, 150)}`);
      const j = await q.json();
      const p = j.QueryResponse?.Payment?.[0];
      if (!p) return { alreadyGone: true };
      syncToken = p.SyncToken;
      continue;
    }
    if (/Object Not Found|ObjectNotFound|gone/i.test(body) || d.status === 404) {
      return { alreadyGone: true };
    }
    throw new Error(`delete ${d.status}: ${body.slice(0, 150)}`);
  }
  throw new Error('delete: stale loop exceeded');
}

tokenState = await loadTokens();
console.log('Token loaded. Realm:', tokenState.realmId);

const payments = JSON.parse(readFileSync(SNAP, 'utf8'));
console.log(`Loaded ${payments.length} QB Payments from snapshot.`);

let done = 0, alreadyGone = 0, failed = 0;
const startedAt = Date.now();
let cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= payments.length) return;
    const p = payments[i];
    try {
      const r = await deleteOne(p.Id, p.SyncToken);
      if (r.alreadyGone) alreadyGone++;
      else done++;
    } catch (err) {
      failed++;
      console.error(`  ✗ ${p.Id} (${p.TxnDate} ${p.TotalAmt}): ${(err.message || err).toString().slice(0, 120)}`);
    }
    const total = done + alreadyGone + failed;
    if (total % 100 === 0) {
      const el = ((Date.now() - startedAt) / 60_000).toFixed(1);
      const rate = total / Math.max(1, (Date.now() - startedAt) / 1000);
      console.log(`  [${total}/${payments.length}] deleted=${done} alreadyGone=${alreadyGone} failed=${failed} rate=${rate.toFixed(1)}/s elapsed=${el}m`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

await db.end();
console.log(`\nDONE: deleted=${done} alreadyGone=${alreadyGone} failed=${failed}`);
