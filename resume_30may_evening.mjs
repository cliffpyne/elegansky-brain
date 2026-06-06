// Resume the cancelled May 30 evening upload.
//
// Cancelled batch (NMB): redo-30may-evening-nmbnew-1780387456336-3a6c7b
//   - 361/479 payments already posted to QB
//   - 118 still to push
//   - SAME arrears snapshot (snapshot_id=6aa502d1-...) used so the
//     algorithm output is deterministic
//
// CRDB: not started by cancelled run, so we pull fresh /arrears + new batch.
//
// Key invariant: skip rows where (bank_ref, invoice_qb_id) already exists
// in payment_uploads for the orphan batch with status='created'.

import pg from 'pg';
import crypto from 'node:crypto';

const BASE = 'https://elegansky-brain.onrender.com';
const SECRET = process.env.STATEMENT_REPORT_SECRET;
if (!process.env.DB_URL || !SECRET) throw new Error('DB_URL + STATEMENT_REPORT_SECRET required');

const TXN_DATE = '2026-06-01';
const TOKEN_REFRESH_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const CONCURRENCY = 2;
const INVOICE_FROM = new Date('2026-01-01T00:00:00Z');

const ORPHAN_NMB_KEY = 'redo-30may-evening-nmbnew-1780387456336-3a6c7b';
const ORPHAN_NMB_SNAPSHOT = '6aa502d1-c0fb-4725-bed8-e3479c45e44f';

const TARGETS = [
  { label: 'NMB May 30 evening (resume)', channel: 'nmbnew', sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED', windowDate: '30.05.2026', minTimeMin: 16*60+18, resume: true,  orphanKey: ORPHAN_NMB_KEY, orphanSnapshotId: ORPHAN_NMB_SNAPSHOT },
  // CRDB: fresh batch but using the SAME snapshot as NMB for algorithm
  // consistency across this special 30-may-disaster recovery.
  { label: 'CRDB May 30 evening',         channel: 'bank',   sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o', tab: 'PASSED', windowDate: '30.05.2026', minTimeMin: 16*60+55, resume: false, reuseSnapshotId: ORPHAN_NMB_SNAPSHOT },
];

const MONTH_NAMES = ['jan','feb','mar','apr','may','jun','jul','aug','sep','oct','nov','dec'];
function parseTsAny(s) {
  const str = String(s||'').trim();
  if (!str) return null;
  let m = str.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})$/);
  if (m) { const d=+m[1],mo=+m[2]; if(mo<1||mo>12||d<1||d>31)return null; return new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`); }
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
          customerId: cur.inv.customerId, qbId: cur.inv.qbId };
        txp.push(rec);
        cur.remainingBalance -= pay;
        amt -= pay;
        if (cur.remainingBalance <= 0) { cur.fullyPaid = true; idx++; }
        used = true;
      }
      // overflow → first record gets remainder
      if (amt > 0 && txp.length > 0) txp[0].amount += amt;
      if (used) {
        txp.forEach(r => out.push(r));
        usedTx.add(`${tx.transactionId||tx.id}_${tx.receivedTimestamp}_${tx.amount}`);
      }
    });
  });
  const unused = transactions.filter(t => !usedTx.has(`${t.transactionId||t.id}_${t.receivedTimestamp}_${t.amount}`))
    .map(t => ({ customerName: t.customerName || '(unknown)',
      amount: t.amount || 0, transactionAmount: t.amount || 0,
      memo: t.transactionId, memoWithSuffix: appendSuf(t.transactionId, t.channel),
      customerId: null }));
  return { paid: out, unused };
}

// ── DB + QB token bootstrap ─────────────────────────────────────────────
const db = new pg.Client({ connectionString: process.env.DB_URL, ssl: { rejectUnauthorized: false } });
await db.connect();
let tokenState = null;
async function loadTokens() {
  const r = await db.query(`SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider='quickbooks'`);
  if (!r.rows.length) throw new Error('no QB tokens');
  const t = r.rows[0].token_json; t.realmId = r.rows[0].realm_id;
  return t;
}
async function saveTokens(t) {
  await db.query(`UPDATE app_oauth_tokens SET token_json=$1, realm_id=$2, updated_at=now() WHERE provider='quickbooks'`,
    [t, t.realmId]);
}
function tokenExpiringSoon(t) {
  if (!t) return true;
  const acq = Number(t.acquiredAt) || 0;
  const expMs = Number(t.expires_in || 0) * 1000;
  return !acq || !expMs || Date.now() >= acq + expMs - REFRESH_BUFFER_MS;
}
let refreshing = null;
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
      PrivateNote: memo || '', TxnDate: txnDate,
      Line: [{ Amount: Number(amount), LinkedTxn: [{ TxnId: String(invoiceQbId), TxnType: 'Invoice' }] }],
    };
    const r = await fetch(`${API_BASE}/v3/company/${tokenState.realmId}/payment?minorversion=73`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: 'Bearer ' + tokenState.access_token },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(30000),
    }).catch(err => ({ status: 0, _err: err }));
    if (r.status === 0) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500);
      continue;
    }
    if (r.status === 401) {
      if (!refreshing) refreshing = refreshNow().finally(() => { refreshing = null; });
      await refreshing; continue;
    }
    if (r.status === 429 || r.status >= 500) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500); continue;
    }
    const text = await r.text();
    // Stale Object Error: retry with backoff
    if (!r.ok && /Stale Object Error/i.test(text)) {
      await sleep(1500 * Math.pow(2, attempt - 1) + Math.random() * 500); continue;
    }
    if (!r.ok) throw new Error(`${r.status}: ${text.slice(0,200)}`);
    const j = JSON.parse(text);
    return { id: j.Payment?.Id, response: j };
  }
  throw new Error('exceeded retries');
}

tokenState = await loadTokens();

// ── Per-channel ─────────────────────────────────────────────────────────
for (const tgt of TARGETS) {
  console.log(`\n══ ${tgt.label} ══`);

  // Load arrears: either from saved snapshot (resume) or fresh /arrears (new)
  let filteredArrears;
  let snapshotId;
  let batchId;
  if (tgt.resume) {
    const r = await db.query(`SELECT data FROM arrears_snapshots WHERE id=$1`, [tgt.orphanSnapshotId]);
    filteredArrears = r.rows[0].data;
    snapshotId = tgt.orphanSnapshotId;
    const bRow = await db.query(`SELECT id FROM payment_batches WHERE idempotency_key=$1`, [tgt.orphanKey]);
    batchId = bRow.rows[0].id;
    console.log(`  resuming batch ${tgt.orphanKey.slice(0,40)} (snapshot rows=${filteredArrears.length}, batchId=${batchId.slice(0,8)})`);
  } else if (tgt.reuseSnapshotId) {
    const r = await db.query(`SELECT data FROM arrears_snapshots WHERE id=$1`, [tgt.reuseSnapshotId]);
    filteredArrears = r.rows[0].data;
    snapshotId = tgt.reuseSnapshotId;
    console.log(`  reusing snapshot ${tgt.reuseSnapshotId.slice(0,8)} (rows=${filteredArrears.length})`);
  } else {
    console.log(`  pulling fresh /arrears asOf=2026-05-30…`);
    const all = [];
    let start = 1;
    while (true) {
      const r = await fetch(`${BASE}/arrears?pageSize=1000&start=${start}&asOf=2026-05-30`, { signal: AbortSignal.timeout(60000) });
      const j = await r.json();
      if (!j.invoices?.length) break;
      all.push(...j.invoices);
      if (!j.page?.nextStart) break;
      start = j.page.nextStart;
    }
    filteredArrears = all.filter(i => new Date(i.date) >= INVOICE_FROM && i.no && String(i.no).trim());
    console.log(`  arrears ${all.length} → filtered ${filteredArrears.length}`);
    const sRes = await fetch(`${BASE}/api/arrears-snapshots`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
      body: JSON.stringify({ as_of: '2026-05-30', data: filteredArrears, created_by: 'resume-30may', notes: 'May 30 post-cutoff, posted as June 1' }),
    });
    const { snapshot } = await sRes.json();
    snapshotId = snapshot.id;
  }

  // Pull sheet, filter by date prefix + time-of-day
  const sr = await (await fetch(`${BASE}/sheets/${tgt.sheetId}?range=${tgt.tab}!A1:H80000`, { signal: AbortSignal.timeout(60000) })).json();
  const sheet = sr.values || [];
  const txns = [];
  for (let i=1;i<sheet.length;i++) {
    const dCell = String(sheet[i][1]||'').trim();
    if (!dCell) continue;
    const ts = parseTsAny(dCell);
    if (!ts || !dCell.startsWith(tgt.windowDate)) continue;
    const tm = dCell.match(/\s(\d{2}):(\d{2}):/);
    const rowMin = tm ? Number(tm[1])*60 + Number(tm[2]) : -1;
    if (rowMin < tgt.minTimeMin) continue;
    const plateCell = String(sheet[i][5]||'');
    const customer = String(sheet[i][6]||'');
    const msg = String(sheet[i][3]||'');
    if (isMultiPlate(plateCell)) continue;
    const matchedPhone = extractPhone(plateCell) || extractPhone(customer) || extractPhone(msg);
    txns.push({
      id: sheet[i][0]||`tx-${i}`, channel: tgt.channel,
      customerPhone: matchedPhone || sheet[i][5] || null,
      customerName: customer || null, contractName: customer || null,
      amount: sheet[i][4] ? Number(String(sheet[i][4]).replace(/,/g,'')) : null,
      receivedTimestamp: ts.getTime(), transactionId: sheet[i][7]||null,
    });
  }
  const sheetSum = txns.reduce((s,t)=>s+(t.amount||0),0);
  console.log(`  sheet txns=${txns.length} | sum=${sheetSum.toLocaleString()}`);

  const invoices = filteredArrears.map((inv, i) => ({
    id: i + 1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
    amount: Number(inv.balance) || 0, invoiceDate: inv.date,
    customerPhone: extractPhone(inv.customer || ''),
    customerId: inv.customerId, qbId: inv.qbId,
  }));

  const { paid, unused } = processInvoicePayments(invoices, txns);
  const sumPaid = paid.reduce((s,p)=>s+p.amount,0);
  const sumUnused = unused.reduce((s,u)=>s+u.amount,0);
  console.log(`  paid=${paid.length} (${sumPaid.toLocaleString()}) | unused=${unused.length} (${sumUnused.toLocaleString()})`);

  if (paid.length === 0) { console.log('  nothing to push'); continue; }

  // For resume mode: filter out (bank_ref, invoice_qb_id) pairs already in payment_uploads
  let toPush = paid;
  if (tgt.resume) {
    const done = await db.query(`
      SELECT bank_ref, invoice_qb_id
        FROM payment_uploads
       WHERE batch_id=$1 AND status='created'
    `, [batchId]);
    const doneKey = new Set(done.rows.map(r => `${r.bank_ref}|${r.invoice_qb_id}`));
    toPush = paid.filter(p => !doneKey.has(`${p.memoWithSuffix}|${p.qbId}`));
    console.log(`  already in QB: ${done.rows.length} | to push: ${toPush.length}`);
  } else {
    // Fresh batch: create payment_batches row + lock refs
    const bankRefs = [...new Set(txns.map(t => appendSuf(t.transactionId, tgt.channel)).filter(Boolean))];
    const idem = `resume-30may-${tgt.channel}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
    await db.query('BEGIN');
    const ins = await db.query(`INSERT INTO payment_batches (
        idempotency_key, status, arrears_snapshot_id,
        sheet_id, sheet_tab, channel, bank_refs,
        sheet_total, paid_total, unused_total,
        paid_count, unused_count, created_by
      ) VALUES ($1,'pending',$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'resume-30may-evening') RETURNING id`,
      [idem, snapshotId, tgt.sheetId, tgt.tab, tgt.channel, bankRefs, sheetSum, sumPaid, sumUnused, paid.length, unused.length]);
    batchId = ins.rows[0].id;
    const tuples = bankRefs.map((_, i) => `($${i*2+1},$${i*2+2})`).join(',');
    const vals = []; bankRefs.forEach(r => vals.push(r, batchId));
    await db.query(`INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ${tuples}`, vals);
    await db.query('COMMIT');
    console.log(`  batch.id=${batchId.slice(0,8)} | uploading paid records to QB…`);
  }

  if (toPush.length === 0) {
    console.log('  ✓ nothing left to push for this channel');
  } else {
    let done = 0, failed = 0; let cursor = 0;
    await Promise.all(Array.from({ length: CONCURRENCY }, async () => {
      while (true) {
        const i = cursor++;
        if (i >= toPush.length) return;
        const p = toPush[i];
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
        if ((done+failed) % 25 === 0) console.log(`    [${done+failed}/${toPush.length}] done=${done} failed=${failed}`);
      }
    }));
    console.log(`  ${tgt.label}: done=${done} failed=${failed}`);

    if (failed === 0) {
      await db.query(`UPDATE payment_batches SET status='finalized', finalized_at=now() WHERE id=$1`, [batchId]);
      console.log(`  ✓ batch finalized`);
    } else {
      console.log(`  ⚠ batch left pending (${failed} failures)`);
    }
  }
}

await db.end();
console.log('\nDONE.');
