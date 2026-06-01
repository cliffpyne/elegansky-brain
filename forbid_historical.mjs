// Lock all historical bank refs into consumed_transactions so they can't be
// re-uploaded. Per Frank's directive:
//   - NMB:   all rows dated ≤ 31.05.2026 23:59:59 (already uploaded ones stay,
//            this just covers the gaps — anything not yet consumed)
//   - CRDB:  same — all rows dated ≤ 31.05.2026 23:59:59
//   - IPHONE BANK: ALL historical rows (start fresh from 01.06.2026)
//
// Creates one sentinel "forbidden-historical" batch per channel with
// status='finalized'. Inserts only refs not already in consumed_transactions.

import pg from 'pg';

const BASE = 'https://elegansky-brain.onrender.com';
const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');

function suffix(c) { return { bank:'B', iphone_bank:'P', nmbnew:'N' }[c] || ''; }
function appendSuf(t, c) { if (!t) return ''; const s = suffix(c); return s ? t+s : t; }

const parseTs = (s) => {
  const m = String(s||'').trim().match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  return m ? new Date(`${m[3]}-${m[2]}-${m[1]}T${m[4]}:${m[5]}:${m[6]}Z`) : null;
};

async function fetchAllRefs({ sheetId, tab, channel, maxDate }) {
  const r = await (await fetch(`${BASE}/sheets/${sheetId}?range=${tab}!A1:H80000`)).json();
  const s = r.values || [];
  const refs = [];
  for (let i=1; i<s.length; i++) {
    const ref = String(s[i][7] || '').trim();
    if (!ref) continue;
    if (maxDate) {
      const ts = parseTs(s[i][1]);
      if (!ts || ts > maxDate) continue;
    }
    refs.push(appendSuf(ref, channel));
  }
  return [...new Set(refs)];
}

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

// One snapshot id for all sentinel batches (just a pointer, doesn't matter which).
const sr = await db.query(`SELECT id FROM arrears_snapshots ORDER BY created_at DESC LIMIT 1`);
if (!sr.rows.length) throw new Error('no snapshot exists — create one first');
const snapId = sr.rows[0].id;
console.log(`Using snapshot pointer: ${snapId}`);

const TARGETS = [
  {
    label: 'NMB',
    channel: 'nmbnew',
    sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek',
    tab: 'PASSED',
    maxDate: new Date('2026-06-01T00:00:00Z'),
    idem: 'forbidden-historical-nmbnew-le-2026-05-31',
  },
  {
    label: 'BANK CRDB',
    channel: 'bank',
    sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o',
    tab: 'PASSED',
    maxDate: new Date('2026-06-01T00:00:00Z'),
    idem: 'forbidden-historical-bank-le-2026-05-31',
  },
  {
    label: 'IPHONE BANK',
    channel: 'iphone_bank',
    sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ',
    tab: 'BANK_PASSED',
    maxDate: null, // ALL history
    idem: 'forbidden-historical-iphone_bank-all',
  },
];

for (const t of TARGETS) {
  console.log(`\n── ${t.label} (${t.channel}) ──`);

  // Skip if sentinel already exists for this channel/idem.
  const exB = await db.query(`SELECT id FROM payment_batches WHERE idempotency_key=$1`, [t.idem]);
  let batchId;
  if (exB.rows.length) {
    batchId = exB.rows[0].id;
    console.log(`  Sentinel batch exists: ${batchId}`);
  } else {
    const refs = await fetchAllRefs(t);
    console.log(`  Sheet refs collected: ${refs.length}`);
    const ins = await db.query(`INSERT INTO payment_batches (
        idempotency_key, status, arrears_snapshot_id,
        sheet_id, sheet_tab, channel, bank_refs,
        sheet_total, paid_total, unused_total,
        paid_count, unused_count, created_by
      ) VALUES ($1,'finalized',$2,$3,$4,$5,$6,0,0,0,0,0,'forbid-historical')
      RETURNING id`,
      [t.idem, snapId, t.sheetId, t.tab, t.channel, refs]);
    batchId = ins.rows[0].id;
    await db.query(`UPDATE payment_batches SET finalized_at=now() WHERE id=$1`, [batchId]);
    console.log(`  Created sentinel batch: ${batchId}`);
  }

  // Collect refs to lock
  const refs = await fetchAllRefs(t);
  console.log(`  Total refs to consider: ${refs.length}`);

  // Filter out refs already in consumed_transactions
  const existing = new Set();
  const BATCH_CHECK = 5000;
  for (let i = 0; i < refs.length; i += BATCH_CHECK) {
    const chunk = refs.slice(i, i + BATCH_CHECK);
    const ec = await db.query(`SELECT bank_ref FROM consumed_transactions WHERE bank_ref = ANY($1)`, [chunk]);
    ec.rows.forEach(r => existing.add(r.bank_ref));
  }
  console.log(`  Already in consumed_transactions: ${existing.size}`);

  const toLock = refs.filter(r => !existing.has(r));
  console.log(`  Newly forbidden: ${toLock.length}`);

  if (toLock.length === 0) continue;

  // Bulk INSERT — chunks of 1000 per statement
  const CHUNK = 1000;
  for (let i = 0; i < toLock.length; i += CHUNK) {
    const piece = toLock.slice(i, i + CHUNK);
    const tuples = piece.map((_, j) => `($${j*2+1},$${j*2+2})`).join(',');
    const vals = [];
    piece.forEach(r => { vals.push(r, batchId); });
    await db.query(
      `INSERT INTO consumed_transactions (bank_ref, batch_id) VALUES ${tuples} ON CONFLICT DO NOTHING`,
      vals,
    );
  }
  console.log(`  ✓ Inserted ${toLock.length} forbidden rows.`);
}

await db.end();
console.log('\nDONE.');
