// Upload the 4 sheet rows whose date column was corrupted by the
// transaction-processor regex bug ("20.26.2026 ..." pattern).
//
// Extract real date from message column → use that for window placement.
// Phone/plate is in column 5; algorithm matches against /arrears as usual.
// Direct QB Payment creation (concurrency 2, retry-on-429 like run3).

import pg from 'pg';
import crypto from 'node:crypto';

const BASE = 'https://elegansky-brain.onrender.com';
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

const url = process.env.DB_URL;
const SECRET = process.env.STATEMENT_REPORT_SECRET;
if (!url || !SECRET) throw new Error('DB_URL + STATEMENT_REPORT_SECRET required');

// The 4 rows we want to handle. Sheet + ref + the expected channel suffix.
const TARGETS = [
  { sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED',      channel: 'nmbnew',      ref: '101TPFT261521775', suffix: 'N' },
  { sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED',      channel: 'nmbnew',      ref: '101TPFT261526909', suffix: 'N' },
  { sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED', channel: 'iphone_bank', ref: '101TPFT261521907', suffix: 'P' },
  { sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED', channel: 'iphone_bank', ref: '101TPFT261523243', suffix: 'P' },
];

// Pull the real date out of "Received payment from ... on 01.06.2026 08 12 19!!"
// or similar. We accept multiple in-message formats.
function extractDateFromMessage(msg) {
  if (!msg) return null;
  // "on 01.06.2026 08 12 19" (the corrupted-row pattern)
  let m = msg.match(/\b(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/);
  if (m && +m[2] >= 1 && +m[2] <= 12 && +m[1] >= 1 && +m[1] <= 31) {
    return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`);
  }
  return null;
}

function extractPhone(s) {
  const m = String(s || '').match(/\d{10,}/);
  return m ? m[0] : null;
}

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
async function qbCreatePayment({ customerId, invoiceQbId, amount, memo }) {
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

// Verbatim algorithm (same as run3_upload.mjs)
function processInvoicePayments(invoices, transactions) {
  const usedTx = new Set();
  const invByCust = {};
  invoices.forEach(inv => {
    const key = inv.customerPhone || inv.customerName.toLowerCase().trim();
    (invByCust[key] ||= []).push(inv);
  });
  Object.keys(invByCust).forEach(k => invByCust[k].sort((a, b) => {
    const dc = new Date(b.invoiceDate) - new Date(a.invoiceDate);
    return dc !== 0 ? dc : b.invoiceNumber.localeCompare(a.invoiceNumber);
  }));
  const txByCust = {};
  const seen = new Set();
  transactions.forEach(t => {
    if (!t.amount) return;
    const uid = `${t.transactionId}_${t.receivedTimestamp}_${t.amount}`;
    if (seen.has(uid)) return;
    const keys = [t.customerPhone, t.contractName?.toLowerCase().trim(), t.customerName?.toLowerCase().trim()].filter(Boolean);
    const k = keys.find(key => invByCust[key]);
    if (k) { (txByCust[k] ||= []).push(t); seen.add(uid); }
  });
  Object.keys(txByCust).forEach(k => txByCust[k].sort((a, b) => (a.receivedTimestamp || 0) - (b.receivedTimestamp || 0)));
  const out = [];
  Object.keys(invByCust).forEach(ck => {
    const ci = invByCust[ck]; const ct = txByCust[ck] || [];
    if (ct.length === 0) return;
    const ib = ci.map(inv => ({ inv, remainingBalance: inv.amount, fullyPaid: false }));
    let idx = 0;
    ct.forEach(tx => {
      let amt = tx.amount; let used = false; const txp = [];
      while (amt > 0 && idx < ib.length) {
        const cur = ib[idx];
        if (cur.fullyPaid) { idx++; continue; }
        const pay = Math.min(amt, cur.remainingBalance);
        const rec = { customerName: cur.inv.customerName, invoiceNo: cur.inv.invoiceNumber,
          amount: pay, memo: tx.transactionId, memoWithSuffix: tx.transactionId + tx.suffix,
          channel: tx.channel, customerId: cur.inv.customerId, qbId: cur.inv.qbId };
        out.push(rec); txp.push(rec);
        cur.remainingBalance -= pay; amt -= pay; used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTx.add(tx.transactionId);
      if (amt > 0 && txp.length > 0) txp[0].amount += amt;
    });
  });
  const unused = transactions.filter(t => !usedTx.has(t.transactionId));
  unused.forEach(t => out.push({
    customerName: t.customerName || 'UNKNOWN',
    invoiceNo: 'UNUSED', amount: t.amount, transactionAmount: t.amount,
    memo: t.transactionId, memoWithSuffix: t.transactionId + t.suffix,
    isUnused: true, channel: t.channel,
  }));
  return out;
}

// ── Pull each target row from its sheet + extract real date ───────────────
console.log('1. Fetching the 4 target rows…');
const txns = [];
for (const t of TARGETS) {
  const r = await (await fetch(`${BASE}/sheets/${t.sheetId}?range=${t.tab}!A1:H80000`)).json();
  const s = r.values || [];
  let found = null;
  for (let i = 1; i < s.length; i++) {
    if (String(s[i][7] || '').trim() === t.ref) {
      found = { id: s[i][0], date: s[i][1], msg: s[i][3], amt: s[i][4], plate: s[i][5], name: s[i][6], ref: s[i][7] };
      break;
    }
  }
  if (!found) { console.log(`   ✗ ref ${t.ref} not found in ${t.channel} sheet`); continue; }
  const realDate = extractDateFromMessage(found.msg);
  if (!realDate) { console.log(`   ✗ ref ${t.ref} — couldn't extract date from message`); continue; }
  const phone = extractPhone(found.plate) || extractPhone(found.name) || extractPhone(found.msg);
  txns.push({
    sheetId: t.sheetId, tab: t.tab, channel: t.channel, suffix: t.suffix,
    transactionId: t.ref,
    customerPhone: phone,
    customerName: found.name,
    contractName: found.name,
    amount: Number(String(found.amt || '0').replace(/,/g, '')) || 0,
    receivedTimestamp: realDate.getTime(),
    msg: found.msg.slice(0, 80),
  });
  console.log(`   ✓ ${t.ref} | extracted ${realDate.toISOString()} | phone=${phone} | name=${found.name} | amt=${found.amt}`);
}
if (txns.length === 0) { console.log('Nothing to upload.'); process.exit(0); }

// ── Pull arrears ──────────────────────────────────────────────────────────
console.log('\n2. Pulling /arrears…');
const arrears = [];
let start = 1;
while (true) {
  const r = await fetch(`${BASE}/arrears?pageSize=1000&start=${start}`);
  const j = await r.json();
  const invs = j.invoices || [];
  if (!invs.length) break;
  arrears.push(...invs);
  if (!j.page?.nextStart) break;
  start = j.page.nextStart;
}
console.log(`   ${arrears.length} invoices`);

const invoices = arrears.map((inv, i) => ({
  id: i + 1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
  amount: Number(inv.balance) || 0, invoiceDate: inv.date,
  customerPhone: extractPhone(inv.customer || ''),
  customerId: inv.customerId, qbId: inv.qbId,
}));

// ── Run algorithm ─────────────────────────────────────────────────────────
console.log('\n3. Running algorithm…');
const result = processInvoicePayments(invoices, txns);
const paid = result.filter(p => !p.isUnused && p.amount > 0);
const unused = result.filter(p => p.isUnused);
console.log(`   paid=${paid.length} | unused=${unused.length}`);
paid.forEach(p => console.log(`   PAID  ${p.memoWithSuffix} | ${p.customerName} | inv ${p.invoiceNo} | ${p.amount}`));
unused.forEach(u => console.log(`   UNUSED ${u.memoWithSuffix} | ${u.customerName} | ${u.amount}`));

// ── Snapshot + batch row ──────────────────────────────────────────────────
tokenState = await loadTokens();
console.log('\n4. Storing snapshot + creating batch row…');
const snapResp = await fetch(`${BASE}/api/arrears-snapshots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
  body: JSON.stringify({ as_of: '2026-06-01', data: arrears, created_by: '4-orphan-rows', notes: 'Recovery of 4 rows with corrupted dates' }),
});
const { snapshot } = await snapResp.json();
console.log(`   snapshot.id=${snapshot.id}`);

// One batch per channel
const byChannel = { nmbnew: [], iphone_bank: [] };
txns.forEach(t => byChannel[t.channel].push(t));

for (const channel of Object.keys(byChannel)) {
  const channelTxns = byChannel[channel];
  if (channelTxns.length === 0) continue;
  const cfg = { nmbnew: { sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED' },
                iphone_bank: { sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED' } }[channel];
  const channelResult = processInvoicePayments(invoices, channelTxns);
  const channelPaid = channelResult.filter(p => !p.isUnused && p.amount > 0);
  const channelUnused = channelResult.filter(p => p.isUnused);
  const bankRefs = [...new Set(channelTxns.map(t => t.transactionId + t.suffix))];
  const sheetSum = channelTxns.reduce((s, t) => s + t.amount, 0);
  const sumPaid = channelPaid.reduce((s, p) => s + p.amount, 0);
  const sumUnused = channelUnused.reduce((s, p) => s + p.transactionAmount, 0);
  const idem = `orphan-${channel}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;

  await db.query('BEGIN');
  const ins = await db.query(`INSERT INTO payment_batches (
      idempotency_key, status, arrears_snapshot_id,
      sheet_id, sheet_tab, channel, bank_refs,
      sheet_total, paid_total, unused_total,
      paid_count, unused_count, created_by
    ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'orphan-rows-recovery') RETURNING id`,
    [idem, snapshot.id, cfg.sheetId, cfg.tab, channel, bankRefs, sheetSum, sumPaid, sumUnused, channelPaid.length, channelUnused.length]);
  const batchId = ins.rows[0].id;
  const tuples = bankRefs.map((_, i) => `($${i*2+1},$${i*2+2})`).join(',');
  const vals = []; bankRefs.forEach(r => vals.push(r, batchId));
  await db.query(`INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ${tuples}`, vals);
  await db.query('COMMIT');

  console.log(`\n   ${channel} batch=${batchId}`);

  // Upload paid (concurrency 2)
  let done = 0, failed = 0; let cursor = 0;
  const workers = Array.from({ length: 2 }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= channelPaid.length) return;
      const p = channelPaid[i];
      try {
        const qb = await qbCreatePayment({ customerId: p.customerId, invoiceQbId: p.qbId, amount: p.amount, memo: p.memoWithSuffix });
        await db.query(`INSERT INTO payment_uploads (
            batch_id, kind, bank_ref, customer_id, customer_name,
            invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
          ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
          [batchId, p.memoWithSuffix, p.customerId, p.customerName, p.qbId, p.invoiceNo, p.amount, p.memoWithSuffix, qb.id, JSON.stringify(qb.response)]);
        done++;
        console.log(`     ✓ ${p.memoWithSuffix} → qb_id=${qb.id}`);
      } catch (err) {
        failed++;
        console.log(`     ✗ ${p.memoWithSuffix}: ${(err.message || err).slice(0, 150)}`);
      }
    }
  });
  await Promise.all(workers);

  for (const u of channelUnused) {
    await db.query(`INSERT INTO payment_uploads (
        batch_id, kind, bank_ref, customer_id, customer_name, amount, memo, status
      ) VALUES ($1,'credit_memo',$2,NULL,$3,$4,$5,'unmatched')`,
      [batchId, u.memoWithSuffix, u.customerName, u.transactionAmount, u.memoWithSuffix]);
    console.log(`     – unmatched: ${u.memoWithSuffix} | ${u.customerName} | ${u.transactionAmount}`);
  }

  if (failed === 0) {
    await db.query(`UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`, [batchId]);
    console.log(`   ✓ ${channel} finalized`);
  } else {
    console.log(`   ⚠ ${channel} left pending (${failed} failed)`);
  }
}

await db.end();
console.log('\nDONE.');
