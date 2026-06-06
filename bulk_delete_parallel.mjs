// Parallel bulk-delete: 10 concurrent QB Payment deletes.
// Same algorithm as bulk_delete_payments.mjs but with a worker pool.

import pg from 'pg';

const BATCH_PREFIX = 'a341c6bc';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const CONCURRENCY = 5;

const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let tokenState = null;
let refreshing = null;

async function loadTokens() {
  const r = await db.query("SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'");
  if (!r.rows.length) throw new Error('no QB tokens');
  const t = r.rows[0].token_json;
  if (!t.realmId) t.realmId = r.rows[0].realm_id;
  return t;
}

async function saveTokens(t) {
  await db.query(
    `UPDATE app_oauth_tokens SET token_json=$1, realm_id=$2, updated_at=now() WHERE provider='quickbooks'`,
    [JSON.stringify(t), t.realmId ?? null],
  );
}

function tokenExpiringSoon(t) {
  if (!t) return true;
  const acq = Number(t.acquiredAt) || 0;
  const expMs = Number(t.expires_in || 0) * 1000;
  if (!acq || !expMs) return true;
  return Date.now() >= acq + expMs - REFRESH_BUFFER_MS;
}

async function refreshNow() {
  const clientId = process.env.QB_CLIENT_ID;
  const clientSecret = process.env.QB_CLIENT_SECRET;
  if (!clientId || !clientSecret) throw new Error('QB_CLIENT_ID / QB_CLIENT_SECRET env vars not set');
  const auth = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const r = await fetch(TOKEN_REFRESH_URL, {
    method: 'POST',
    headers: {
      Authorization: 'Basic ' + auth,
      Accept: 'application/json',
      'Content-Type': 'application/x-www-form-urlencoded',
    },
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

async function qbCall(path, init) {
  await ensureFresh();
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: 'Bearer ' + tokenState.access_token },
  });
  return r;
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callWithRetry(makeReq, label) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const r = await makeReq();
    if (r.status === 401) {
      if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
      await refreshing;
      continue;
    }
    if (r.status === 429) {
      const backoff = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
      await sleep(backoff);
      continue;
    }
    return r;
  }
  throw new Error(`${label}: exceeded retries`);
}

async function deleteOne(qbId) {
  const r = await callWithRetry(
    () => qbCall(
      `/v3/company/${tokenState.realmId}/query?query=${encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${qbId}'`)}&minorversion=73`,
      { headers: { Accept: 'application/json' } },
    ),
    'query',
  );
  if (!r.ok) throw new Error(`query ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const p = j.QueryResponse?.Payment?.[0];
  if (!p) return { alreadyGone: true };
  const d = await callWithRetry(
    () => qbCall(
      `/v3/company/${tokenState.realmId}/payment?operation=delete&minorversion=73`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ Id: p.Id, SyncToken: p.SyncToken }),
      },
    ),
    'delete',
  );
  if (!d.ok) throw new Error(`delete ${d.status}: ${(await d.text()).slice(0, 200)}`);
  return { ok: true };
}

// ── Main ─────────────────────────────────────────────────────────────────
tokenState = await loadTokens();
console.log('Loaded token. Realm:', tokenState.realmId);

const ups = await db.query(
  `SELECT id, qb_id FROM payment_uploads
    WHERE batch_id::text LIKE $1 AND status='created' AND kind='payment'
    ORDER BY created_at`,
  [BATCH_PREFIX + '%'],
);
console.log(`Found ${ups.rows.length} Payments still to delete. Concurrency=${CONCURRENCY}.`);

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
      await db.query(
        `UPDATE payment_uploads SET status='voided', voided_at=now() WHERE id=$1`,
        [row.id],
      );
    } catch (err) {
      failed++;
      await db.query(
        `UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`,
        [row.id, String(err.message || err).slice(0, 500)],
      );
    }
    const total = done + alreadyGone + failed;
    if (total % 25 === 0) {
      const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
      const rate = total / Math.max(1, (Date.now() - startedAt) / 1000);
      console.log(`  [${total}/${ups.rows.length}]  deleted=${done}  alreadyGone=${alreadyGone}  failed=${failed}  rate=${rate.toFixed(1)}/s  elapsed=${elapsedMin}m`);
    }
  }
}

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

if (failed === 0) {
  await db.query(
    `UPDATE payment_batches SET status='recalled', recalled_at=now(),
       recalled_by='direct-qb-bulk-delete', failure_reason=NULL
     WHERE id::text LIKE $1`,
    [BATCH_PREFIX + '%'],
  );
  await db.query(
    `DELETE FROM consumed_transactions WHERE batch_id IN
       (SELECT id FROM payment_batches WHERE id::text LIKE $1)`,
    [BATCH_PREFIX + '%'],
  );
  console.log('═ Batch marked recalled, consumed_transactions cleared. ═');
} else {
  console.log(`═ ${failed} failed — left as-is for inspection. ═`);
}

await db.end();
console.log(`\nDONE: deleted=${done}  alreadyGone=${alreadyGone}  failed=${failed}`);
