// Backfill unmatched-unused rows for NMB Run 1 + CRDB Run 1B into payment_uploads.
//
// Re-derives the unused rows by re-pulling sheet windows and re-running the
// algorithm against the same arrears snapshot used at upload time.

import pg from 'pg';

const BASE = 'https://elegansky-brain.onrender.com';
const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');

function getChannelSuffix(c) { return { bank:'B', iphone_bank:'P', nmbnew:'N' }[c] || ''; }
function appendChannelSuffix(t, c) { if (!t) return ''; const s = getChannelSuffix(c); return s ? t+s : t; }
function extractPhone(s) { const m = (s||'').match(/\d{10,}/); return m ? m[0] : null; }

function processInvoicePayments(invoices, transactions) {
  const used = new Set();
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
  Object.keys(invByCust).forEach(ck => {
    const ci = invByCust[ck]; const ct = txByCust[ck] || [];
    if (ct.length === 0) return;
    const ib = ci.map(inv => ({ inv, remainingBalance: inv.amount, fullyPaid: false }));
    let idx = 0;
    ct.forEach(tx => {
      let amt = tx.amount; let mark = false;
      while (amt > 0 && idx < ib.length) {
        const cur = ib[idx];
        if (cur.fullyPaid) { idx++; continue; }
        const pay = Math.min(amt, cur.remainingBalance);
        cur.remainingBalance -= pay; amt -= pay; mark = true;
        if (cur.remainingBalance <= 1) { cur.fullyPaid = true; idx++; }
      }
      if (mark) used.add(tx.transactionId || tx.id);
    });
  });
  return transactions.filter(t => !used.has(t.transactionId || t.id));
}

async function fetchTransactions({ sheetId, tab, channel, winStart, winEnd }) {
  const sheetResp = await (await fetch(`${BASE}/sheets/${sheetId}?range=${tab}!A1:H80000`)).json();
  const sheet = sheetResp.values || [];
  const parseTs = (s) => { const m = String(s||'').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/); return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`) : null; };
  const out = [];
  for (let i=1;i<sheet.length;i++) {
    const ts = parseTs(sheet[i][1]);
    if (!ts || ts < winStart || ts > winEnd) continue;
    out.push({
      id: sheet[i][0]||`tx-${i+1}`, channel,
      customerPhone: sheet[i][5]||null, customerName: sheet[i][6]||null, contractName: sheet[i][6]||null,
      amount: sheet[i][4] ? Number(sheet[i][4]) : null,
      receivedTimestamp: ts.getTime(), transactionId: sheet[i][7]||null,
    });
  }
  return out;
}

async function backfillBatch(db, { batchIdempKey, sheetId, sheetTab, channel, winStart, winEnd }) {
  const br = await db.query(
    `SELECT id, arrears_snapshot_id FROM payment_batches WHERE idempotency_key=$1`,
    [batchIdempKey],
  );
  if (!br.rows.length) throw new Error(`batch not found: ${batchIdempKey}`);
  const batchId = br.rows[0].id;
  const snapshotId = br.rows[0].arrears_snapshot_id;
  console.log(`\n  batch=${batchIdempKey}  id=${batchId}  snapshot=${snapshotId}`);

  // Existing payment_uploads rows
  const ex = await db.query(`SELECT count(*)::int as n FROM payment_uploads WHERE batch_id=$1 AND status='unmatched'`, [batchId]);
  if (ex.rows[0].n > 0) {
    console.log(`  already has ${ex.rows[0].n} unmatched rows — skipping backfill.`);
    return;
  }

  // Snapshot arrears
  const sr = await db.query(`SELECT data FROM arrears_snapshots WHERE id=$1`, [snapshotId]);
  if (!sr.rows.length) throw new Error('snapshot not found');
  const snapshotData = sr.rows[0].data;
  const invoices = snapshotData.map((inv, i) => ({
    id: i+1, customerName: inv.customerLeaf, invoiceNumber: inv.no,
    amount: Number(inv.balance) || 0, invoiceDate: inv.date,
    customerPhone: extractPhone(inv.customer || ''),
    customerId: inv.customerId, qbId: inv.qbId,
  }));

  // Sheet transactions
  const txns = await fetchTransactions({ sheetId, tab: sheetTab, channel, winStart, winEnd });
  console.log(`  txns in window: ${txns.length}`);

  // Identify unused
  const unused = processInvoicePayments(invoices, txns);
  console.log(`  unused: ${unused.length}`);

  // Insert
  for (const u of unused) {
    const bankRef = appendChannelSuffix(u.transactionId, channel);
    await db.query(
      `INSERT INTO payment_uploads (
         batch_id, kind, bank_ref, customer_id, customer_name,
         amount, memo, status
       ) VALUES ($1,'credit_memo',$2,NULL,$3,$4,$5,'unmatched')`,
      [batchId, bankRef, u.customerName || null, u.amount, bankRef],
    );
  }
  console.log(`  inserted ${unused.length} unmatched rows.`);
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

await backfillBatch(db, {
  batchIdempKey: 'run1-nmb-30may-a5e86e8a94e2b502',
  sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek',
  sheetTab: 'PASSED',
  channel: 'nmbnew',
  winStart: new Date('2026-05-30T16:16:00Z'),
  winEnd:   new Date('2026-05-30T23:55:00Z'),
});

await backfillBatch(db, {
  batchIdempKey: 'run1b-crdb-30may-0180698fa1f2eeac',
  sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o',
  sheetTab: 'PASSED',
  channel: 'bank',
  winStart: new Date('2026-05-30T16:55:00Z'),
  winEnd:   new Date('2026-05-30T23:59:59Z'),
});

await db.end();
console.log('\nDONE.');
