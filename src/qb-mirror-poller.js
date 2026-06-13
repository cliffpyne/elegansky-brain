// CDC poller — keeps qb_invoices/qb_payments within ~30 s of QB without
// touching the report hot path. One Render dyno can run this in-process;
// since `cdcSync` is idempotent and the high-water mark sits in Postgres,
// a second instance is harmless (rare, but safe).
//
// Webhooks (Phase 2b) deliver near-instant deltas on top of this. The
// poller is the safety net for any webhook QB drops.

import { cdcSync } from './qb-mirror.js';

const POLL_INTERVAL_MS = 30_000;
const ENTITIES = ['Invoice', 'Payment', 'CreditMemo'];

let _started = false;
let _timer = null;
// In-flight guard PER ENTITY. cdcSync on Payment can take 60-130 s
// (QB SELECT * + 100 nested-line upserts). If a new tick fires while the
// previous is still running we end up with overlapping calls, pool
// exhaustion, and the dyno gets restarted by Render. Skip overlapping ticks.
const _inFlight = { Invoice: false, Payment: false, CreditMemo: false };
let _state = {
  last_ok_at: null,
  last_run_at: null,
  last_error: null,
  invoice_rows: 0,
  payment_rows: 0,
  credit_memo_rows: 0,
  runs: 0,
  skipped: 0,
};

async function syncOne(entity) {
  if (_inFlight[entity]) {
    _state.skipped += 1;
    return;
  }
  _inFlight[entity] = true;
  try {
    const r = await cdcSync(entity);
    if (entity === 'Invoice')         _state.invoice_rows += r.rows;
    else if (entity === 'Payment')    _state.payment_rows += r.rows;
    else                              _state.credit_memo_rows += r.rows;
    _state.last_ok_at = new Date().toISOString();
    _state.last_error = null;
    if (r.rows > 0) {
      console.log(`[qb-mirror-poller] ${entity}: synced ${r.rows} row(s) in ${r.took_ms}ms`);
    }
  } catch (err) {
    _state.last_error = `${entity}: ${err.message}`;
    console.error(`[qb-mirror-poller] ${entity} sync failed:`, err.message);
  } finally {
    _inFlight[entity] = false;
  }
}

function tick() {
  _state.last_run_at = new Date().toISOString();
  // Fire both entities in parallel. The in-flight guard inside syncOne
  // means a slow Payment cycle won't block Invoice ticks from running.
  for (const entity of ENTITIES) syncOne(entity);
  _state.runs += 1;
}

export function startQbMirrorPoller() {
  if (_started) return;
  _started = true;
  // First tick after 5 s so server can settle before its first QB call.
  setTimeout(() => {
    tick();
    _timer = setInterval(tick, POLL_INTERVAL_MS);
  }, 5_000);
  console.log(`[qb-mirror-poller] started, interval=${POLL_INTERVAL_MS}ms`);
}

export function stopQbMirrorPoller() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _started = false;
}

export function getQbMirrorPollerState() {
  return { ..._state, running: _started, interval_ms: POLL_INTERVAL_MS };
}
