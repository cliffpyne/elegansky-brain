// Upload June 3 morning STEP 1 — evening tail of June 2 (after each channel's
// cutoff yesterday → 23:59 EAT yesterday). TxnDate=2026-06-03 (today, since
// the business-day cutoff at 16:15 yesterday turned everything past that
// into today's books).
//
// Algorithm: IP-verbatim. No phone-extraction shortcuts, no multi-plate
// flagging — just newest-invoice-first FIFO per customer name/plate key.
// Future-dated invoices stay out of pool (DueDate ≤ asOf) so SADAT-style
// 2027 invoices land in unused as Frank wants.
//
// Deposit account: 785 (Kijichi Collection AC) — same as SaasAnt pushes.
// Concurrency 8 — proven safe in yesterday's migration.

import pg from 'pg';
import crypto from 'node:crypto';

const BASE = 'https://elegansky-brain.onrender.com';
const SECRET = process.env.STATEMENT_REPORT_SECRET;
const url = process.env.DB_URL;
if (!url || !SECRET) throw new Error('DB_URL + STATEMENT_REPORT_SECRET required');

const AS_OF = '2026-06-03';
const INVOICE_FROM = new Date('2026-01-01T00:00:00Z');
const TXN_DATE = '2026-06-03';
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const CONCURRENCY = 8;

const TARGETS = [
  { label: 'CRDB Jun2 evening tail', channel: 'bank',        sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o', tab: 'PASSED',      windowDate: '02.06.2026', minTimeMin: 16*60 + 4,  maxTimeMin: 23*60 + 59 },
  { label: 'NMB Jun2 evening tail',  channel: 'nmbnew',      sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED',      windowDate: '02.06.2026', minTimeMin: 16*60 + 17, maxTimeMin: 23*60 + 59 },
  { label: 'iPhone Jun2 evening',    channel: 'iphone_bank', sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED', windowDate: '02.06.2026', minTimeMin: 15*60 + 10, maxTimeMin: 23*60 + 59 },
];

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseTsAny(s) {
  const str = String(s||'').trim();
  if (!str) return null;
  let m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) { const d=+m[1],mo=+m[2]; if(mo<1||mo>12||d<1||d>31)return null; return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`); }
  m = str.match(/^(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/i);
  if (m) { const idx=MONTH_NAMES.indexOf(m[2].toLowerCase()); if(idx<0)return null; return new Date(`${m[3]}-${String(idx+1).padStart(2,'0')}-${m[1].padStart(2,'0')}T00:00:00Z`); }
  return null;
}
function extractPhone(s) { const m = (s||'').match(/\d{10,}/); return m ? m[0] : null; }
function appendSuf(t, c) { const sfx = { bank:'B', iphone_bank:'P', nmbnew:'N' }[c] || ''; return t ? t + sfx : ''; }
function isMultiPlate(plateCell) {
  if (!plateCell) return false;
  const matches = String(plateCell).match(/M[A-Z]\d{3}[A-Z]{3}/g) || [];
  return matches.length >= 2;
}

function processInvoicePayments(invoices, transactions) {
  const usedTx = new Set();
  const invByCust = {};
  invoices.forEach(inv => {
    const key = inv.customerPhone || inv.customerName.toLowerCase().trim();
    (invByCust[key] ||= []).push(inv);
  });
  Object.keys(invByCust).forEach(k => invByCust[k].sort((a,b) => {
    const dc = new Date(b.invoiceDate) - new Date(a.invoiceDate);
    return dc !== 0 ? dc : b.invoiceNumber.localeCompare(a.invoiceNumber);
  }));
  const txByCust = {};
  const seen = new Set();
  transactions.forEach(t => {
    if (!t.amount) return;
    const uid = `${t.transactionId||t.id}_${t.receivedTimestamp}_${t.amount}`;
    if (seen.has(uid)) return;
    const keys = [t.customerPhone, t.contractName?.toLowerCase().trim(), t.customerName?.toLowerCase().trim()].filter(Boolean);
    const k = keys.find(key => invByCust[key]);
    if (k) { (txByCust[k] ||= []).push(t); seen.add(uid); }
  });
  Object.keys(txByCust).forEach(k => txByCust[k].sort((a,b) => (a.receivedTimestamp||0) - (b.receivedTimestamp||0)));
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
          amount: pay, memo: tx.transactionId, memoWithSuffix: appendSuf(tx.transactionId, tx.channel),
          channel: tx.channel, customerId: cur.inv.customerId, qbId: cur.inv.qbId };
        out.push(rec); txp.push(rec);
        cur.remainingBalance -= pay; amt -= pay; used = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; cur.remainingBalance = 0; idx++; }
      }
      if (used) usedTx.add(tx.transactionId || tx.id);
      if (amt > 0 && txp.length > 0) txp[0].amount += amt;
    });
  });
  const unused = transactions.filter(t => !usedTx.has(t.transactionId || t.id));
  return {
    paid: out.filter(p => p.amount > 0),
    unused: unused.map(t => ({
      customerName: t.customerName || 'UNKNOWN',
      amount: t.amount, memo: t.transactionId,
      memoWithSuffix: appendSuf(t.transactionId, t.channel),
    })),
  };
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let tokenState = null; let refreshing = null;
async function loadTokens() {
  const r = await db.query("SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'");
  const t = r.rows[0].token_json; if (!t.realmId) t.realmId = r.rows[0].realm_id; return t;
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

async function qbCreatePayment({ customerId, invoiceQbId, amount, memo, txnDate }) {
  for (let attempt = 1; attempt <= 6; attempt++) {
    await ensureFresh();
    const body = {
      CustomerRef: { value: String(customerId) }, TotalAmt: Number(amount),
      PrivateNote: memo || '',
      TxnDate: txnDate,
      DepositToAccountRef: { value: '785' }, // Kijichi Collection AC (else QB defaults to Undeposited Funds)
      Line: [{ Amount: Number(amount), LinkedTxn: [{ TxnId: String(invoiceQbId), TxnType: 'Invoice' }] }],
    };
    const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/payment?minorversion=73`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + tokenState.access_token },
      body: JSON.stringify(body),
    });
    if (r.status === 401) {
      if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
      await refreshing; continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500); continue;
    }
    if (!r.ok) throw new Error(`${r.status}: ${(await r.text()).slice(0,200)}`);
    const j = await r.json();
    return { id: j.Payment?.Id, response: j };
  }
  throw new Error('exceeded retries');
}

// ── Common: pull /arrears once with filter ────────────────────────────────
console.log(`Pulling /arrears?asOf=${AS_OF} (invoice date floor ${INVOICE_FROM.toISOString().slice(0,10)})…`);
const arrears = [];
let start = 1;
while (true) {
  const r = await fetch(`${BASE}/arrears?pageSize=1000&start=${start}&asOf=${AS_OF}`, { signal: AbortSignal.timeout(60000) });
  const j = await r.json();
  if (!j.invoices?.length) break;
  arrears.push(...j.invoices);
  if (!j.page?.nextStart) break;
  start = j.page.nextStart;
}
const filteredArrears = arrears.filter(i => new Date(i.date) >= INVOICE_FROM && i.no && String(i.no).trim());
console.log(`   arrears ${arrears.length} → filtered ${filteredArrears.length}`);

const invoices = filteredArrears.map((inv, i) => ({
  id: i + 1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
  amount: Number(inv.balance) || 0, invoiceDate: inv.date,
  customerPhone: extractPhone(inv.customer || ''),
  customerId: inv.customerId, qbId: inv.qbId,
}));

// Snapshot
console.log('Storing snapshot…');
const sRes = await fetch(`${BASE}/api/arrears-snapshots`, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
  body: JSON.stringify({ as_of: AS_OF, data: filteredArrears, created_by: '03jun-step1', notes: 'June 3 morning step 1 — June 2 evening tail per channel' }),
});
const { snapshot } = await sRes.json();
console.log(`   snapshot.id=${snapshot.id}`);

tokenState = await loadTokens();

// ── Per channel ───────────────────────────────────────────────────────────
for (const tgt of TARGETS) {
  console.log(`\n══ ${tgt.label} ══`);
  // Sheet
  const sr = await (await fetch(`${BASE}/sheets/${tgt.sheetId}?range=${tgt.tab}!A1:H80000`, { signal: AbortSignal.timeout(60000) })).json();
  const sheet = sr.values || [];
  const txns = [];
  for (let i=1;i<sheet.length;i++) {
    const dCell = String(sheet[i][1]||'').trim();
    if (!dCell) continue;
    const ts = parseTsAny(dCell);
    if (!ts || !dCell.startsWith(tgt.windowDate)) continue;
    // Time-of-day filter: only rows >= cutoff for this channel.
    const tm = dCell.match(/\s(\d{2}):(\d{2}):/);
    const rowMin = tm ? Number(tm[1]) * 60 + Number(tm[2]) : -1;
    if (rowMin < tgt.minTimeMin) continue;
    if (tgt.maxTimeMin != null && rowMin > tgt.maxTimeMin) continue;
    // IP-verbatim: plate cell as customerPhone (no extraction from name or
    // message), multi-plate rows flow through normally, name is literal cell.
    const plateCell = String(sheet[i][5]||'');
    const customer = String(sheet[i][6]||'');
    txns.push({
      id: sheet[i][0]||`tx-${i}`, channel: tgt.channel,
      customerPhone: plateCell || null,
      customerName: customer || null, contractName: customer || null,
      amount: sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g,'')) : null,
      receivedTimestamp: ts.getTime(), transactionId: sheet[i][7]||null,
    });
  }
  const sheetSum = txns.reduce((s,t)=>s+(t.amount||0),0);
  console.log(`  sheet txns=${txns.length} | sum=${sheetSum.toLocaleString()}`);

  const { paid, unused } = processInvoicePayments(invoices, txns);
  const sumPaid = paid.reduce((s,p)=>s+p.amount,0);
  const sumUnused = unused.reduce((s,u)=>s+u.amount,0);
  console.log(`  paid=${paid.length} (${sumPaid.toLocaleString()}) | unused=${unused.length} (${sumUnused.toLocaleString()})`);

  if (paid.length === 0) { console.log('  nothing to upload'); continue; }

  // Create batch + lock refs (BRAIN bookkeeping)
  const bankRefs = [...new Set(txns.map(t => appendSuf(t.transactionId, tgt.channel)).filter(Boolean))];
  const idem = `03jun-step1-${tgt.channel}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
  await db.query('BEGIN');
  const ins = await db.query(`INSERT INTO payment_batches (
      idempotency_key, status, arrears_snapshot_id,
      sheet_id, sheet_tab, channel, bank_refs,
      sheet_total, paid_total, unused_total,
      paid_count, unused_count, created_by
    ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'03jun-step1') RETURNING id`,
    [idem, snapshot.id, tgt.sheetId, tgt.tab, tgt.channel, bankRefs, sheetSum, sumPaid, sumUnused, paid.length, unused.length]);
  const batchId = ins.rows[0].id;
  const tuples = bankRefs.map((_, i) => `($${i*2+1},$${i*2+2})`).join(',');
  const vals = []; bankRefs.forEach(r => vals.push(r, batchId));
  await db.query(`INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ${tuples}`, vals);
  await db.query('COMMIT');
  console.log(`  batch.id=${batchId} | uploading paid records to QB…`);

  // Upload paid concurrently
  let done = 0, failed = 0; let cursor = 0;
  await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
    while (true) {
      const i = cursor++;
      if (i >= paid.length) return;
      const p = paid[i];
      try {
        const qb = await qbCreatePayment({ customerId: p.customerId, invoiceQbId: p.qbId, amount: p.amount, memo: p.memoWithSuffix, txnDate: TXN_DATE });
        await db.query(`INSERT INTO payment_uploads (
            batch_id, kind, bank_ref, customer_id, customer_name,
            invoice_qb_id, invoice_no, amount, memo, qb_id, qb_response, status
          ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,$9,$10,'created')`,
          [batchId, p.memoWithSuffix, p.customerId, p.customerName, p.qbId, p.invoiceNo, p.amount, p.memoWithSuffix, qb.id, JSON.stringify(qb.response)]);
        done++;
      } catch (err) {
        failed++;
        await db.query(`INSERT INTO payment_uploads (
            batch_id, kind, bank_ref, customer_id, customer_name,
            invoice_qb_id, invoice_no, amount, memo, status, failure_reason
          ) VALUES ($1,'payment',$2,$3,$4,$5,$6,$7,$8,'failed',$9)`,
          [batchId, p.memoWithSuffix, p.customerId, p.customerName, p.qbId, p.invoiceNo, p.amount, p.memoWithSuffix, String(err.message||err).slice(0,500)]);
      }
      if ((done+failed) % 50 === 0) console.log(`    [${done+failed}/${paid.length}] done=${done} failed=${failed}`);
    }
  }));
  console.log(`  ${tgt.label}: done=${done} failed=${failed}`);

  // Mark unused (Frank uploads these via SaasAnt) — record for tracking
  for (const u of unused) {
    await db.query(`INSERT INTO payment_uploads (
        batch_id, kind, bank_ref, customer_id, customer_name,
        amount, memo, status
      ) VALUES ($1,'credit_memo',$2,NULL,$3,$4,$5,'unmatched')`,
      [batchId, u.memoWithSuffix, u.customerName, u.amount, u.memoWithSuffix]);
  }

  if (failed === 0) {
    await db.query(`UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`, [batchId]);
    console.log(`  ✓ batch finalized`);
  } else {
    console.log(`  ⚠ batch left pending (${failed} failures to retry)`);
  }
}

await db.end();
console.log('\nDONE.');
