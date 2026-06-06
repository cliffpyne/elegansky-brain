// Retry the failed payment_uploads rows for a given batch.
// Calls QB directly with 429 backoff. Updates row status on success.

import pg from 'pg';

const BATCH_ID = process.env.BATCH_ID;
if (!BATCH_ID) throw new Error('BATCH_ID env var required');
const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const CONCURRENCY = 2;
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let tokenState = null;
let refreshing = null;

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

async function createPayment({ customerId, invoiceQbId, amount, memo }) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureFresh();
    const body = {
      CustomerRef: { value: String(customerId) },
      TotalAmt: Number(amount),
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
      await refreshing;
      continue;
    }
    if (r.status === 429 || r.status === 503 || r.status === 500) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500);
      continue;
    }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,150)}`);
    const j = await r.json();
    return { id: j.Payment?.Id, response: j };
  }
  throw new Error('exceeded retries');
}

tokenState = await loadTokens();
console.log('token loaded; realm', tokenState.realmId);

const failed = await db.query(
  `SELECT id, bank_ref, customer_id, invoice_qb_id, invoice_no, amount, memo
   FROM payment_uploads WHERE batch_id=$1 AND status='failed' AND kind='payment'`,
  [BATCH_ID],
);
console.log(`retrying ${failed.rows.length} failed records…`);

let done = 0, stillFailed = 0;
let cursor = 0;
async function worker() {
  while (true) {
    const i = cursor++;
    if (i >= failed.rows.length) return;
    const row = failed.rows[i];
    try {
      const qb = await createPayment({
        customerId: row.customer_id,
        invoiceQbId: row.invoice_qb_id,
        amount: row.amount,
        memo: row.memo,
      });
      await db.query(
        `UPDATE payment_uploads SET status='created', qb_id=$2, qb_response=$3, failure_reason=NULL WHERE id=$1`,
        [row.id, qb.id, JSON.stringify(qb.response)],
      );
      done++;
    } catch (err) {
      stillFailed++;
      await db.query(
        `UPDATE payment_uploads SET failure_reason=$2 WHERE id=$1`,
        [row.id, String(err.message || err).slice(0, 500)],
      );
    }
    if ((done + stillFailed) % 10 === 0) {
      console.log(`  [${done+stillFailed}/${failed.rows.length}] done=${done} still=${stillFailed}`);
    }
  }
}
await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
console.log(`done=${done} still=${stillFailed}`);

if (stillFailed === 0) {
  await db.query(`UPDATE payment_batches SET status='finalized', finalized_at=now(), failure_reason=NULL WHERE id=$1 AND status='pending'`, [BATCH_ID]);
  console.log('batch finalized.');
}
await db.end();
