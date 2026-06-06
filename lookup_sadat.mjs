// Diagnose: why does hello.xls have 21 SADAT OMARY GEMA invoices but
// /arrears returns 0? Hit QB Query API directly to see the truth.

import pg from 'pg';

const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';

if (!process.env.DB_URL) throw new Error('DB_URL required');

const dbClient = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await dbClient.connect();
const r = await dbClient.query(`SELECT realm_id, token_json FROM app_oauth_tokens WHERE provider='quickbooks' LIMIT 1`);
let tok = r.rows[0]?.token_json;
if (!tok?.refresh_token) throw new Error('no quickbooks tokens in app_oauth_tokens');
tok.realmId = r.rows[0].realm_id;

async function saveTokens(t) {
  await dbClient.query(`UPDATE app_oauth_tokens SET token_json=$1, updated_at=now() WHERE provider='quickbooks'`, [t]);
}
async function refresh() {
  const auth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const r = await fetch(TOKEN_REFRESH_URL, {
    method: 'POST',
    headers: { Authorization: 'Basic ' + auth, Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(tok.refresh_token),
  });
  if (!r.ok) throw new Error(`refresh ${r.status}: ${await r.text()}`);
  const j = await r.json();
  tok = { ...j, realmId: tok.realmId, acquiredAt: Date.now() };
  await saveTokens(tok);
}
await refresh();

async function qbQuery(sql) {
  const url = `${API_BASE}/v3/company/${tok.realmId}/query?query=${encodeURIComponent(sql)}&minorversion=73`;
  const r = await fetch(url, { headers: { Authorization: 'Bearer ' + tok.access_token, Accept: 'application/json' } });
  if (!r.ok) throw new Error(`query ${r.status}: ${(await r.text()).slice(0,300)}`);
  return r.json();
}

// 1. Search Customer by DisplayName for any 'SADAT'
console.log('── Customer query: DisplayName LIKE "%SADAT%" ──');
let q = await qbQuery(`SELECT * FROM Customer WHERE DisplayName LIKE '%SADAT%' MAXRESULTS 50`);
const sadats = q.QueryResponse?.Customer || [];
console.log(`Found ${sadats.length} customers with "SADAT" in DisplayName`);
for (const c of sadats.slice(0, 20)) {
  console.log(`  id=${c.Id}  active=${c.Active}  name="${c.DisplayName}"  parent=${c.ParentRef?.value || '-'}  bal=${c.Balance}`);
}

// 2. Specifically GEMA
console.log('');
console.log('── Customer query: DisplayName LIKE "%GEMA%" ──');
q = await qbQuery(`SELECT * FROM Customer WHERE DisplayName LIKE '%GEMA%' MAXRESULTS 50`);
const gemas = q.QueryResponse?.Customer || [];
console.log(`Found ${gemas.length} customers with "GEMA" in DisplayName`);
for (const c of gemas.slice(0, 20)) {
  console.log(`  id=${c.Id}  active=${c.Active}  name="${c.DisplayName}"  parent=${c.ParentRef?.value || '-'}  bal=${c.Balance}`);
}

// 3. Look up Invoice 932997 (Sadat's most recent per hello.xls)
console.log('');
console.log('── Invoice query: DocNumber=932997 (Sadat\'s May 30 invoice) ──');
q = await qbQuery(`SELECT * FROM Invoice WHERE DocNumber='932997'`);
const inv = q.QueryResponse?.Invoice?.[0];
if (inv) {
  console.log(`  Id=${inv.Id} | TxnDate=${inv.TxnDate} | Customer=${inv.CustomerRef?.name} (id=${inv.CustomerRef?.value})`);
  console.log(`  TotalAmt=${inv.TotalAmt} | Balance=${inv.Balance} | DueDate=${inv.DueDate}`);
} else {
  console.log('  invoice 932997 NOT FOUND');
}

// 4. Same for 931281, 877527
for (const num of ['931281', '877527', '875650']) {
  q = await qbQuery(`SELECT * FROM Invoice WHERE DocNumber='${num}'`);
  const i = q.QueryResponse?.Invoice?.[0];
  if (i) console.log(`  inv ${num}: customer=${i.CustomerRef?.name} (id=${i.CustomerRef?.value}) balance=${i.Balance}`);
  else console.log(`  inv ${num}: NOT FOUND`);
}

await dbClient.end();
