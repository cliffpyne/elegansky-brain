// Bulk-delete 1,074 BRAIN-created QB Payments directly via QB REST API,
// bypassing BRAIN's recall path (which is failing for an unknown reason).
//
// Strategy: load tokens from Postgres; for each upload row, query the Payment
// to get current SyncToken, then POST delete; on success update the
// payment_uploads row in BRAIN's DB to status='voided'; refresh access token
// every ~50 minutes preemptively.

import pg from 'pg';

const BATCH_PREFIX = '6d6c4616';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';

const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

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

async function refresh(token) {
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
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(token.refresh_token),
  });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  const next = { ...j, realmId: token.realmId, acquiredAt: Date.now() };
  await saveTokens(next);
  console.log('  ↻ token refreshed');
  return next;
}

async function ensureFresh(t) {
  if (tokenExpiringSoon(t)) return await refresh(t);
  return t;
}

async function qbCall(path, init, t) {
  t = await ensureFresh(t);
  const r = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: { ...(init?.headers || {}), Authorization: 'Bearer ' + t.access_token },
  });
  return { r, t };
}

async function deleteOne(qbId, t) {
  // 1. Query
  const q = await qbCall(
    `/v3/company/${t.realmId}/query?query=${encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${qbId}'`)}&minorversion=73`,
    { headers: { Accept: 'application/json' } },
    t,
  );
  t = q.t;
  if (q.r.status === 401) {
    t = await refresh(t);
    const q2 = await qbCall(
      `/v3/company/${t.realmId}/query?query=${encodeURIComponent(`SELECT * FROM Payment WHERE Id = '${qbId}'`)}&minorversion=73`,
      { headers: { Accept: 'application/json' } },
      t,
    );
    if (!q2.r.ok) throw new Error(`query ${q2.r.status}: ${(await q2.r.text()).slice(0, 200)}`);
    const j = await q2.r.json();
    const p = j.QueryResponse?.Payment?.[0];
    if (!p) return { t, alreadyGone: true };
    return await doDelete(p, t);
  }
  if (!q.r.ok) throw new Error(`query ${q.r.status}: ${(await q.r.text()).slice(0, 200)}`);
  const j = await q.r.json();
  const p = j.QueryResponse?.Payment?.[0];
  if (!p) return { t, alreadyGone: true };
  return await doDelete(p, t);
}

async function doDelete(payment, t) {
  const d = await qbCall(
    `/v3/company/${t.realmId}/payment?operation=delete&minorversion=73`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ Id: payment.Id, SyncToken: payment.SyncToken }),
    },
    t,
  );
  t = d.t;
  if (!d.r.ok) {
    const body = (await d.r.text()).slice(0, 200);
    throw new Error(`delete ${d.r.status}: ${body}`);
  }
  return { t };
}

// ── Main ─────────────────────────────────────────────────────────────────
let token = await loadTokens();
console.log('Loaded token. Realm:', token.realmId);

const ups = await db.query(
  `SELECT id, qb_id FROM payment_uploads
    WHERE batch_id::text LIKE $1 AND status='created' AND kind='payment'
    ORDER BY created_at`,
  [BATCH_PREFIX + '%'],
);
console.log(`Found ${ups.rows.length} Payments still to delete.`);

let deleted = 0, alreadyGone = 0, failed = 0;
const startedAt = Date.now();

for (let i = 0; i < ups.rows.length; i++) {
  const row = ups.rows[i];
  try {
    const r = await deleteOne(row.qb_id, token);
    token = r.t;
    if (r.alreadyGone) alreadyGone++;
    else deleted++;
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
  if ((i + 1) % 50 === 0 || i === ups.rows.length - 1) {
    const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log(`  [${i + 1}/${ups.rows.length}]  deleted=${deleted}  alreadyGone=${alreadyGone}  failed=${failed}  elapsed=${elapsedMin}m`);
  }
}

// ── Finalize the batch if everything succeeded ──────────────────────────
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
  console.log(`═ ${failed} failed — batch left as finalized for further inspection. ═`);
}

await db.end();
console.log(`\nDONE: deleted=${deleted}  alreadyGone=${alreadyGone}  failed=${failed}`);
