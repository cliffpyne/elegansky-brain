// Frappe → Postgres mirror poller. Same shape as qb-mirror-poller.js.
// Keeps frappe_payments within ~60s of Frappe using CDC on `modified`.
// The frappe-webhook module can also call upsertPayment directly for
// near-instant updates; this poller is the safety net.

import { cdcSyncPayments, backfillPayments } from './frappe-mirror.js';
import { db } from './db/pool.js';

const POLL_INTERVAL_MS = 60_000;

let _started = false;
let _timer = null;
let _inFlight = false;
let _state = {
  last_ok_at: null,
  last_run_at: null,
  last_error: null,
  rows_synced: 0,
  runs: 0,
  skipped: 0,
};

async function ensureBackfilled() {
  const r = await db().query(`SELECT last_backfill_at FROM frappe_mirror_state WHERE entity = $1`, ['PaymentEntry']);
  if (r.rows.length && r.rows[0].last_backfill_at) return; // already backfilled
  console.log('[frappe-mirror-poller] no prior backfill — running initial backfill');
  try {
    const { total } = await backfillPayments();
    console.log(`[frappe-mirror-poller] initial backfill complete: ${total} rows`);
  } catch (err) {
    console.error('[frappe-mirror-poller] initial backfill failed (will retry via cdc):', err.message);
  }
}

async function tick() {
  if (_inFlight) { _state.skipped += 1; return; }
  _inFlight = true;
  _state.last_run_at = new Date().toISOString();
  _state.runs += 1;
  try {
    const r = await cdcSyncPayments();
    _state.rows_synced += r.total;
    _state.last_ok_at = new Date().toISOString();
    _state.last_error = null;
    if (r.total > 0) console.log(`[frappe-mirror-poller] synced ${r.total} row(s), new hwm=${r.new_high_water_mark}`);
  } catch (err) {
    _state.last_error = err.message;
    console.error('[frappe-mirror-poller] sync failed:', err.message);
  } finally {
    _inFlight = false;
  }
}

export function startFrappeMirrorPoller() {
  if (_started) return;
  if (String(process.env.FRAPPE_MIRROR_POLLER_ENABLED || 'true').toLowerCase() === 'false') {
    console.log('[frappe-mirror-poller] disabled via FRAPPE_MIRROR_POLLER_ENABLED=false');
    return;
  }
  _started = true;
  console.log(`[frappe-mirror-poller] armed — polling every ${POLL_INTERVAL_MS / 1000}s`);
  // Backfill on first launch (fire-and-forget so startup isn't blocked).
  ensureBackfilled().catch((e) => console.error('[frappe-mirror-poller] backfill error:', e.message));
  _timer = setInterval(tick, POLL_INTERVAL_MS);
}

export function getFrappeMirrorPollerState() {
  return { started: _started, poll_interval_ms: POLL_INTERVAL_MS, ..._state };
}
