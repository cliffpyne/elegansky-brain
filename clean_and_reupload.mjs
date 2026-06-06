// After bulk-deleting all QB Payments dated May 31 → June 2:
//   1. Wipe BRAIN's local trace of those batches (payment_uploads,
//      consumed_transactions, payment_batches) so refs are FREE again.
//      Keep the 'forbid-historical' sentinels — they protect old refs.
//   2. Fire 4 fresh auto-uploads (NMB May 31, CRDB May 31, NMB June 1 till
//      17:01 EAT, CRDB June 1 till 15:31 EAT).
//   3. (Optional, controlled by INCLUDE_IPHONE=true env) iPhone Bank similar.

import pg from 'pg';

const BASE = 'https://elegansky-brain.onrender.com';
const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');
const SECRET = process.env.STATEMENT_REPORT_SECRET;
if (!SECRET) throw new Error('STATEMENT_REPORT_SECRET not set');
const INCLUDE_IPHONE = process.env.INCLUDE_IPHONE === 'true';

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

// ── Step 1: identify + wipe the batches BRAIN created since May 30 ────────
//
// We DO NOT touch the forbid-historical sentinels (they lock old refs).
const channels = INCLUDE_IPHONE ? ['nmbnew', 'bank', 'iphone_bank'] : ['nmbnew', 'bank'];

const batchesToWipe = await db.query(
  `SELECT id, idempotency_key, channel, created_by
     FROM payment_batches
    WHERE created_at::date >= '2026-05-30'
      AND channel = ANY($1)
      AND COALESCE(created_by, '') <> 'forbid-historical'
      AND idempotency_key NOT LIKE 'forbidden-historical-%'`,
  [channels],
);
console.log(`Batches to wipe: ${batchesToWipe.rows.length}`);
batchesToWipe.rows.forEach(b => console.log(`  - ${b.idempotency_key.slice(0, 50).padEnd(52)} (${b.channel}) ${b.created_by || ''}`));

const ids = batchesToWipe.rows.map(b => b.id);
if (ids.length === 0) {
  console.log('(nothing to wipe)');
} else {
  await db.query('BEGIN');
  const u = await db.query(`DELETE FROM payment_uploads WHERE batch_id = ANY($1)`, [ids]);
  const ct = await db.query(`DELETE FROM consumed_transactions WHERE batch_id = ANY($1)`, [ids]);
  const b = await db.query(`DELETE FROM payment_batches WHERE id = ANY($1)`, [ids]);
  await db.query(`DELETE FROM auto_upload_locks WHERE channel = ANY($1)`, [channels]);
  await db.query('COMMIT');
  console.log(`Wiped: payment_uploads=${u.rowCount} consumed_transactions=${ct.rowCount} payment_batches=${b.rowCount}`);
}

// ── Step 2: re-fire 4 auto-uploads ────────────────────────────────────────
// Sheet timestamps are stored literal (parser treats DD.MM.YYYY HH:MM:SS
// as UTC), so the window bounds are simply the literal "EAT day" interpreted
// as UTC.
const runs = [
  { label: 'NMB May 31 full day',       channel: 'nmbnew', since: '2026-05-31T00:00:00Z', until: '2026-06-01T00:00:00Z' },
  { label: 'CRDB May 31 full day',      channel: 'bank',   since: '2026-05-31T00:00:00Z', until: '2026-06-01T00:00:00Z' },
  { label: 'NMB June 1 → 17:01 EAT',    channel: 'nmbnew', since: '2026-06-01T00:00:00Z', until: '2026-06-01T17:01:00Z' },
  { label: 'CRDB June 1 → 15:31 EAT',   channel: 'bank',   since: '2026-06-01T00:00:00Z', until: '2026-06-01T15:31:00Z' },
];
if (INCLUDE_IPHONE) {
  runs.push({ label: 'iPhone May 31 full day', channel: 'iphone_bank', since: '2026-05-31T00:00:00Z', until: '2026-06-01T00:00:00Z' });
  runs.push({ label: 'iPhone June 1 → 17:01 EAT', channel: 'iphone_bank', since: '2026-06-01T00:00:00Z', until: '2026-06-01T17:01:00Z' });
}

console.log(`\nFiring ${runs.length} auto-uploads…`);
for (const r of runs) {
  console.log(`\n── ${r.label} ──`);
  // Clear any stale lock just in case
  await db.query(`DELETE FROM auto_upload_locks WHERE channel = $1`, [r.channel]);
  let body, http;
  try {
    const resp = await fetch(`${BASE}/api/payment-batches/auto-upload/${r.channel}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
      body: JSON.stringify({ since_iso: r.since, until_iso: r.until }),
      signal: AbortSignal.timeout(180_000),
    });
    http = resp.status;
    body = await resp.json().catch(() => ({}));
  } catch (err) {
    console.log(`  ✗ HTTP error: ${(err.message || err).toString().slice(0, 200)}`);
    continue;
  }
  if (body.skipped) {
    console.log(`  skipped: ${body.reason}`);
  } else if (body.batch_id) {
    console.log(`  ✓ batch_id=${body.batch_id} | paid_planned=${body.paid_planned} | unused_planned=${body.unused_planned} | sheet_sum=${(body.sheet_sum || 0).toLocaleString()}`);
  } else {
    console.log(`  HTTP=${http} body=${JSON.stringify(body).slice(0, 300)}`);
  }
}

await db.end();
console.log('\nDONE — background QB Payment creation is in flight per batch.');
