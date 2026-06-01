// Integration test for the new BRAIN endpoints. Hits live elegansky-brain.
// Cleans up its own test data so we don't pollute consumed_transactions.

import pg from 'pg';

const BASE = 'https://elegansky-brain.onrender.com';
const SECRET = process.env.STATEMENT_REPORT_SECRET;
if (!SECRET) throw new Error('STATEMENT_REPORT_SECRET not set');
const url = process.env.DB_URL;
if (!url) throw new Error('DB_URL not set');

const db = new pg.Client({ connectionString: url, ssl: { rejectUnauthorized: false } });
await db.connect();

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log(`✓ ${name}`); }
  else { fail++; console.log(`✗ ${name}: ${detail}`); }
}

// ── 1. CSV snapshot export ────────────────────────────────────────────────
{
  const snap = await db.query(`SELECT id FROM arrears_snapshots ORDER BY created_at DESC LIMIT 1`);
  const snapId = snap.rows[0].id;
  const r = await fetch(`${BASE}/api/arrears-snapshots/${snapId}/export.csv`);
  const text = await r.text();
  check('1. CSV export status 200', r.status === 200, `got ${r.status}`);
  check('1. CSV content-type', /text\/csv/.test(r.headers.get('content-type') || ''), r.headers.get('content-type'));
  check('1. CSV has header row', text.startsWith('no,customerId,'), text.slice(0, 80));
  check('1. CSV has data rows', text.split('\n').length > 10, `${text.split('\n').length} lines`);
}

// ── 2. Auto-upload dry_run on a future window ─────────────────────────────
// 1-second window far in the future — should be empty. If sheet happens to
// have stray future-dated rows, accept dry_run result and clean up.
{
  const sinceIso = new Date(Date.now() + 365 * 86400_000).toISOString();
  const untilIso = new Date(Date.now() + 365 * 86400_000 + 1000).toISOString();
  const r = await fetch(`${BASE}/api/payment-batches/auto-upload/bank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
    body: JSON.stringify({ since_iso: sinceIso, until_iso: untilIso, dry_run: true }),
  });
  const body = await r.json();
  const okStatus = r.status === 200 || r.status === 202;
  check('2. Future-window auto-upload returns 200/202', okStatus, `${r.status} ${JSON.stringify(body).slice(0,100)}`);
  if (body.skipped) {
    check('2. Skipped reason mentions no rows', /no rows/.test(body.reason||''), JSON.stringify(body));
  } else if (body.dry_run) {
    check('2. Dry-run returned a batch_id', !!body.batch_id, JSON.stringify(body));
    // Cleanup so we don't accumulate test pollution
    await db.query(`DELETE FROM payment_uploads WHERE batch_id=$1`, [body.batch_id]);
    await db.query(`DELETE FROM consumed_transactions WHERE batch_id=$1`, [body.batch_id]);
    await db.query(`DELETE FROM payment_batches WHERE id=$1`, [body.batch_id]);
  } else {
    check('2. Response is recognizable', false, `unexpected body: ${JSON.stringify(body)}`);
  }
}

// ── 2b. Auto-upload concurrent rejection ──────────────────────────────────
// Hard to test reliably because the future-window call returns in ~50ms,
// so a parallel request might miss it. Instead, manually take the lock,
// try the auto-upload, expect 409, then release.
{
  await db.query(
    `INSERT INTO auto_upload_locks (channel, locked_at, holder) VALUES ('bank', now(), 'test-suite') ON CONFLICT (channel) DO UPDATE SET locked_at=now(), holder='test-suite'`,
  );
  const sinceIso = new Date(Date.now() + 60 * 60_000).toISOString();
  const untilIso = new Date(Date.now() + 61 * 60_000).toISOString();
  const r = await fetch(`${BASE}/api/payment-batches/auto-upload/bank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
    body: JSON.stringify({ since_iso: sinceIso, until_iso: untilIso, dry_run: true }),
  });
  const body = await r.json();
  check('2b. Held lock returns 409', r.status === 409, `got ${r.status} ${JSON.stringify(body).slice(0,80)}`);
  check('2b. Error mentions other run', /running/.test(body.error || ''), JSON.stringify(body));
  await db.query(`DELETE FROM auto_upload_locks WHERE channel='bank' AND holder='test-suite'`);
}

// ── 3. Auto-upload with bad channel ───────────────────────────────────────
{
  const r = await fetch(`${BASE}/api/payment-batches/auto-upload/invalid_channel`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Report-Secret': SECRET },
    body: JSON.stringify({ dry_run: true }),
  });
  check('3. Invalid channel returns 400', r.status === 400, `got ${r.status}`);
}

// ── 4. Auto-upload no auth → 401 ──────────────────────────────────────────
{
  const r = await fetch(`${BASE}/api/payment-batches/auto-upload/bank`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ dry_run: true }),
  });
  check('4. Missing secret returns 401', r.status === 401, `got ${r.status}`);
}

// ── 5. Recall endpoint still works (just GET to verify route — actual recall is destructive) ────
{
  const finalized = await db.query(
    `SELECT id FROM payment_batches
      WHERE status='finalized' AND idempotency_key LIKE 'run3-iphone_bank-%' LIMIT 1`,
  );
  if (finalized.rows.length) {
    const id = finalized.rows[0].id;
    // POST without auth → 401
    const r = await fetch(`${BASE}/api/payment-batches/${id}/recall`, { method: 'POST' });
    check('5. Recall without auth returns 401', r.status === 401, `got ${r.status}`);
  } else {
    console.log('5. (skipped — no finalized iphone_bank batch to test against)');
  }
}

// ── 6. GET /api/payment-batches/:id without auth → 401 ────────────────────
{
  const b = await db.query(`SELECT id FROM payment_batches LIMIT 1`);
  const id = b.rows[0].id;
  const r = await fetch(`${BASE}/api/payment-batches/${id}`);
  check('6. GET batch without auth returns 401', r.status === 401, `got ${r.status}`);
}

// ── 7. Consumed-transactions endpoint with shared secret ──────────────────
{
  const c = await db.query(`SELECT bank_ref FROM consumed_transactions LIMIT 1`);
  const ref = c.rows[0].bank_ref;
  const r = await fetch(`${BASE}/api/consumed-transactions/${encodeURIComponent(ref)}`, {
    headers: { 'X-Report-Secret': SECRET },
  });
  const body = await r.json();
  check('7. Consumed-ref lookup returns 200', r.status === 200, `${r.status}`);
  check('7. Consumed-ref has bank_ref match', body.bank_ref === ref, `got ${body.bank_ref}`);
  check('7. Consumed-ref has batch_id', !!body.batch_id, JSON.stringify(body));
}

// ── 8. Unknown consumed-ref returns 404 ───────────────────────────────────
{
  const r = await fetch(`${BASE}/api/consumed-transactions/__nonexistent__`, {
    headers: { 'X-Report-Secret': SECRET },
  });
  check('8. Unknown ref returns 404', r.status === 404, `got ${r.status}`);
}

// ── 9. List batches with shared secret rejected (JWT-only) ────────────────
{
  const r = await fetch(`${BASE}/api/payment-batches?limit=5`, {
    headers: { 'X-Report-Secret': SECRET },
  });
  check('9. List batches with secret-only → 401 (JWT required)', r.status === 401, `got ${r.status}`);
}

// ── 10. /arrears pagination consistency ───────────────────────────────────
{
  const r = await fetch(`${BASE}/arrears?pageSize=10&start=1`);
  const j = await r.json();
  check('10. /arrears returns 10', j.invoices?.length === 10, `got ${j.invoices?.length}`);
  check('10. /arrears nextStart correct', j.page?.nextStart === 11, `got ${j.page?.nextStart}`);
}

// ── 11. /health ───────────────────────────────────────────────────────────
{
  const r = await fetch(`${BASE}/api/qb/status`);
  check('11. QB status endpoint reachable', [200, 401, 503].includes(r.status), `got ${r.status}`);
}

console.log();
console.log(`══ Results: ${pass} passed, ${fail} failed ══`);
await db.end();
process.exit(fail === 0 ? 0 : 1);
