// One-off migration: move BRAIN-posted Payments from "Undeposited Funds"
// (acct 793) → "Elegansky Collection AC:Kijichi Collection AC" (acct 785).
//
// Idempotent + resumable: for each Payment we fetch fresh state; if
// DepositToAccountRef.value is already 785 we skip. So you can interrupt
// and re-run with no consequences.
//
// Concurrency 2 (same as our payment-create writes — well under Intuit's
// rate limit). Retries on 429/500/Stale Object with exponential backoff.

import pg from 'pg';

if (!process.env.DB_URL) throw new Error('DB_URL required');

const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const TARGET_ACCT = '785';   // Kijichi Collection AC
const SOURCE_ACCT = '793';   // Undeposited Funds (current default)
const CONCURRENCY = 8;
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

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

async function qbCall(method, path, body) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureFresh();
    const url = `${API_BASE}/v3/company/${tokenState.realmId}/${path}&minorversion=73`;
    let r;
    try {
      r = await fetch(url, {
        method,
        headers: { Authorization: 'Bearer ' + tokenState.access_token, Accept: 'application/json',
                   ...(body ? { 'Content-Type': 'application/json' } : {}) },
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(30000),
      });
    } catch (err) {
      if (attempt === 6) throw err;
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500);
      continue;
    }
    if (r.status === 401) {
      if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
      await refreshing; continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500);
      continue;
    }
    const txt = await r.text();
    if (!r.ok && /Stale Object Error/i.test(txt) && attempt < 6) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500);
      continue;
    }
    if (!r.ok) throw new Error(`${r.status}: ${txt.slice(0, 300)}`);
    return JSON.parse(txt);
  }
  throw new Error('exceeded retries');
}

tokenState = await loadTokens();

// ── Build the work list ──────────────────────────────────────────────────
const r = await db.query(`
  SELECT DISTINCT pu.qb_id
    FROM payment_uploads pu
   WHERE pu.status='created' AND pu.qb_id IS NOT NULL AND pu.kind='payment'
   ORDER BY pu.qb_id
`);
const allIds = r.rows.map(x => x.qb_id);
console.log(`Total BRAIN-tracked Payments with qb_id: ${allIds.length}`);
console.log(`Migrating DepositToAccountRef ${SOURCE_ACCT} → ${TARGET_ACCT}`);
console.log(`Concurrency: ${CONCURRENCY}\n`);

let done = 0, skipped = 0, failed = 0, cursor = 0;
const failures = [];
const t0 = Date.now();

const worker = async () => {
  while (true) {
    const i = cursor++;
    if (i >= allIds.length) return;
    const qb_id = allIds[i];
    try {
      // 1. Fetch fresh state to get SyncToken + current DepositToAccountRef
      const q = await qbCall('GET',
        `query?query=${encodeURIComponent(`SELECT Id, SyncToken, DepositToAccountRef FROM Payment WHERE Id = '${qb_id}'`)}`);
      const p = q.QueryResponse?.Payment?.[0];
      if (!p) { failed++; failures.push({ qb_id, reason: 'not found in QB' }); continue; }

      // 2. If already on target account, skip
      if (p.DepositToAccountRef?.value === TARGET_ACCT) {
        skipped++;
      } else {
        // 3. Sparse update DepositToAccountRef
        await qbCall('POST', 'payment?', { Id: p.Id, SyncToken: p.SyncToken, sparse: true, DepositToAccountRef: { value: TARGET_ACCT } });
        done++;
      }
    } catch (err) {
      failed++;
      failures.push({ qb_id, reason: String(err.message || err).slice(0, 200) });
    }
    const total = done + skipped + failed;
    if (total % 50 === 0 || total === allIds.length) {
      const elapsed = (Date.now() - t0) / 1000;
      const rate = total / elapsed;
      const eta = (allIds.length - total) / rate;
      console.log(`  [${total}/${allIds.length}] done=${done} skipped=${skipped} failed=${failed}  (${rate.toFixed(1)}/s, ETA ${Math.round(eta)}s)`);
    }
  }
};

await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));

console.log('');
console.log(`DONE — done=${done} skipped(already 785)=${skipped} failed=${failed}`);
if (failures.length) {
  console.log('\nFailures:');
  for (const f of failures.slice(0, 30)) console.log(`  qb_id=${f.qb_id}: ${f.reason}`);
  if (failures.length > 30) console.log(`  …${failures.length - 30} more`);
}
await db.end();
