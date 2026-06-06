// Re-process today's unmatched payment_uploads against the now-corrected
// /arrears (which previously excluded today's invoices).
//
// For each unmatched row, look up matching customer's invoices in fresh
// arrears, run the verbatim algorithm to allocate the payment, post the
// resulting QB Payment(s), and update the row status from 'unmatched' to
// 'created'.

import pg from 'pg';

const BASE = 'https://elegansky-brain.onrender.com';
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');
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
function expiringSoon(t) {
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
  if (expiringSoon(tokenState)) {
    if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
    await refreshing;
  }
}
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// 16:16 EAT cutoff for TxnDate (mirrors server.js)
function paymentTxnDate() {
  const eat = new Date(Date.now() + 3 * 3600_000);
  const h = eat.getUTCHours(), m = eat.getUTCMinutes();
  if (h > 16 || (h === 16 && m >= 16)) eat.setUTCDate(eat.getUTCDate() + 1);
  return eat.toISOString().slice(0, 10);
}

async function qbCreatePayment({ customerId, invoiceQbId, amount, memo }) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureFresh();
    const body = {
      CustomerRef: { value: String(customerId) },
      TotalAmt: Number(amount),
      PrivateNote: memo || '',
      TxnDate: paymentTxnDate(),
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
    if (r.status === 429 || r.status >= 500) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500);
      continue;
    }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    return { id: j.Payment?.Id, response: j };
  }
  throw new Error('exceeded retries');
}

function extractPhone(s) { const m = String(s||'').match(/\d{10,}/); return m ? m[0] : null; }

tokenState = await loadTokens();

// ── Pull fresh arrears ────────────────────────────────────────────────────
console.log('Pulling fresh /arrears (now includes today-due invoices)…');
const arrears = [];
let start = 1;
while (true) {
  const r = await fetch(`${BASE}/arrears?pageSize=1000&start=${start}`);
  const j = await r.json();
  if (!j.invoices?.length) break;
  arrears.push(...j.invoices);
  if (!j.page?.nextStart) break;
  start = j.page.nextStart;
}
console.log(`  ${arrears.length} invoices`);

// Build per-customer invoice lookup (by phone OR lower-cased leaf name).
const byPhone = new Map();
const byName = new Map();
for (const inv of arrears) {
  const phone = extractPhone(inv.customer || '');
  if (phone) {
    if (!byPhone.has(phone)) byPhone.set(phone, []);
    byPhone.get(phone).push(inv);
  }
  const leaf = String(inv.customerLeaf || '').toLowerCase().trim();
  if (leaf) {
    if (!byName.has(leaf)) byName.set(leaf, []);
    byName.get(leaf).push(inv);
  }
}
// Sort each customer's invoices newest first (algorithm's invariant).
for (const list of byPhone.values()) {
  list.sort((a, b) => (new Date(b.date) - new Date(a.date)) || b.no.localeCompare(a.no));
}
for (const list of byName.values()) {
  list.sort((a, b) => (new Date(b.date) - new Date(a.date)) || b.no.localeCompare(a.no));
}

// ── Pull today's unmatched ────────────────────────────────────────────────
const unmatched = await db.query(
  `SELECT pu.id, pu.batch_id, pu.bank_ref, pu.customer_name, pu.amount, pu.memo
     FROM payment_uploads pu
    WHERE pu.status='unmatched'
      AND pu.created_at::date = '2026-06-01'
    ORDER BY pu.created_at`,
);
console.log(`\nToday's unmatched rows to re-process: ${unmatched.rows.length}`);

// ── Match + post each ─────────────────────────────────────────────────────
let recovered = 0; let stillUnmatched = 0; let failed = 0;
const usedRefs = new Set(); // multiple unmatched rows per ref are rare but possible

for (const row of unmatched.rows) {
  const leaf = String(row.customer_name || '').toLowerCase().trim();
  // Sheet stores customer name in the same column we matched on at upload-time;
  // use that as the lookup key. Phone isn't available in payment_uploads.
  const candidates = byName.get(leaf) || [];
  if (candidates.length === 0) {
    stillUnmatched++;
    continue;
  }
  let remaining = Number(row.amount);
  const allocations = [];
  for (const inv of candidates) {
    if (remaining <= 0) break;
    const pay = Math.min(remaining, Number(inv.balance));
    if (pay <= 0) continue;
    allocations.push({ inv, amount: pay });
    remaining -= pay;
  }
  if (allocations.length === 0) {
    stillUnmatched++;
    continue;
  }
  // Push QB Payment for each allocation
  for (let i = 0; i < allocations.length; i++) {
    const { inv, amount } = allocations[i];
    try {
      const qb = await qbCreatePayment({
        customerId: inv.customerId,
        invoiceQbId: inv.qbId,
        amount,
        memo: row.memo || row.bank_ref,
      });
      if (i === 0) {
        // Update the original unmatched row
        await db.query(
          `UPDATE payment_uploads
              SET status='created', kind='payment',
                  customer_id=$2, invoice_qb_id=$3, invoice_no=$4,
                  amount=$5, qb_id=$6, qb_response=$7,
                  failure_reason=NULL
            WHERE id=$1`,
          [row.id, inv.customerId, inv.qbId, inv.no, amount, qb.id, JSON.stringify(qb.response)],
        );
      } else {
        // Spillover allocation — insert additional row
        await db.query(
          `INSERT INTO payment_uploads (
             batch_id, kind, bank_ref, customer_id, customer_name,
             invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
           ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
          [row.batch_id, row.bank_ref, inv.customerId, row.customer_name,
           inv.qbId, inv.no, amount, row.memo || row.bank_ref, qb.id, JSON.stringify(qb.response)],
        );
      }
      console.log(`  ✓ ${row.bank_ref} | ${row.customer_name} | inv ${inv.no} | ${amount}`);
      recovered++;
    } catch (err) {
      console.log(`  ✗ ${row.bank_ref}: ${(err.message || err).slice(0, 150)}`);
      failed++;
    }
  }
}

console.log(`\nRecovered: ${recovered}  StillUnmatched: ${stillUnmatched}  Failed: ${failed}`);
await db.end();
