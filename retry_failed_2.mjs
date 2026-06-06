// Retry the 2 failed Payments from the direct NMB 31 batch.
// Stale Object errors → just re-POST. Update payment_uploads on success.

import pg from 'pg';

const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let tokenState = null;
async function loadTokens() {
  const r = await db.query("SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'");
  const t = r.rows[0].token_json; if (!t.realmId) t.realmId = r.rows[0].realm_id; return t;
}
async function refreshNow() {
  const auth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_REFRESH_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(tokenState.refresh_token),
  });
  const j = await r.json();
  tokenState = { ...j, realmId: tokenState.realmId, acquiredAt: Date.now() };
  await db.query(`UPDATE app_oauth_tokens SET token_json=$1, updated_at=now() WHERE provider='quickbooks'`, [JSON.stringify(tokenState)]);
}

tokenState = await loadTokens();

const failed = await db.query(
  `SELECT id, bank_ref, customer_id, invoice_qb_id, invoice_no, amount, memo
   FROM payment_uploads
   WHERE batch_id IN (SELECT id FROM payment_batches WHERE idempotency_key LIKE 'run2b-direct-nmb-31may-%')
     AND status='failed'`,
);
console.log(`Retrying ${failed.rows.length} failed Payments…`);

let done = 0, stillFailed = 0;
for (const row of failed.rows) {
  const body = {
    CustomerRef: { value: row.customer_id },
    TotalAmt: Number(row.amount),
    PrivateNote: row.memo || '',
    Line: [{ Amount: Number(row.amount), LinkedTxn: [{ TxnId: row.invoice_qb_id, TxnType: 'Invoice' }] }],
  };
  let success = false;
  for (let attempt = 1; attempt <= 4; attempt++) {
    const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/payment?minorversion=73`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + tokenState.access_token },
      body: JSON.stringify(body),
    });
    if (r.status === 401) { await refreshNow(); continue; }
    if (r.ok) {
      const j = await r.json();
      await db.query(
        `UPDATE payment_uploads SET status='created', qb_id=$2, qb_response=$3, failure_reason=NULL WHERE id=$1`,
        [row.id, j.Payment?.Id, JSON.stringify(j)],
      );
      done++; success = true;
      console.log(`  ✓ ${row.bank_ref} → qb_id=${j.Payment?.Id}`);
      break;
    }
    const text = await r.text();
    console.log(`  attempt ${attempt} ${row.bank_ref}: ${r.status} ${text.slice(0,150)}`);
    await new Promise(r => setTimeout(r, 1000 * attempt));
  }
  if (!success) {
    stillFailed++;
    console.log(`  ✗ ${row.bank_ref} still failing`);
  }
}

console.log(`\nRetry result: ${done} succeeded, ${stillFailed} still failing.`);

if (stillFailed === 0) {
  await db.query(
    `UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE idempotency_key LIKE 'run2b-direct-nmb-31may-%'`,
  );
  console.log('═ Batch finalized. ═');
}

await db.end();
