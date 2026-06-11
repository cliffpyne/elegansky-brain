// CDC poller — keeps qb_invoices/qb_payments within ~30 s of QB without
// touching the report hot path. One Render dyno can run this in-process;
// since `cdcSync` is idempotent and the high-water mark sits in Postgres,
// a second instance is harmless (rare, but safe).
//
// Webhooks (Phase 2b) deliver near-instant deltas on top of this. The
// poller is the safety net for any webhook QB drops.

import { cdcSync } from './qb-mirror.js';

const POLL_INTERVAL_MS = 30_000;
const ENTITIES = ['Invoice', 'Payment'];

let _started = false;
let _timer = null;
let _state = {
  last_ok_at: null,
  last_run_at: null,
  last_error: null,
  invoice_rows: 0,
  payment_rows: 0,
  runs: 0,
};

async function tick() {
  _state.last_run_at = new Date().toISOString();
  for (const entity of ENTITIES) {
    try {
      const r = await cdcSync(entity);
      if (entity === 'Invoice') _state.invoice_rows += r.rows;
      else                       _state.payment_rows += r.rows;
      _state.last_ok_at = new Date().toISOString();
      _state.last_error = null;
      if (r.rows > 0) {
        console.log(`[qb-mirror-poller] ${entity}: synced ${r.rows} row(s) in ${r.took_ms}ms`);
      }
    } catch (err) {
      _state.last_error = `${entity}: ${err.message}`;
      console.error(`[qb-mirror-poller] ${entity} sync failed:`, err.message);
    }
  }
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
