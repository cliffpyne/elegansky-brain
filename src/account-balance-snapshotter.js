// Section A — daily_account_balance snapshotter.
//
// Background loop that computes today's QB BalanceSheet + payments +
// expenses and UPSERTs into daily_account_balance. The mega-report
// getAccountBalance helper reads from this table first, so the dashboard
// hot path is a pure Postgres SELECT (true reporting-only).
//
// Refresh cadence: every 60 s for today, plus the previous N days
// snapped once on boot (historical days don't change after rollover).

import { db } from './db/pool.js';

const REFRESH_INTERVAL_MS = Number(process.env.ACCT_BAL_REFRESH_MS || 60_000);
const HISTORICAL_DAYS_ON_BOOT = 7;

let _started = false;
let _timer = null;
let _inFlight = false;
let _state = {
  last_run_at: null,
  last_ok_at: null,
  last_error: null,
  refreshes: 0,
};

function eatTodayStr() {
  const eat = new Date(Date.now() + 3 * 3600_000);
  return eat.toISOString().slice(0, 10);
}
function isoNDaysAgo(n) {
  const d = new Date(Date.now() + 3 * 3600_000 - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

/**
 * Compute Section A for a date by calling the existing live helper, then
 * upsert into daily_account_balance. Caller supplies the compute hook so
 * this module stays cycle-free (mega-report imports us, not vice versa).
 */
export async function snapshotAccountBalance(date, computeHook) {
  const t0 = Date.now();
  const result = await computeHook(date, date);
  await db().query(
    `INSERT INTO daily_account_balance
       (date, parent_account, opening_balance, closing_live,
        payments_total, payments_count, expenses_total, expenses_count,
        net_movement, computed_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (date) DO UPDATE SET
       parent_account  = EXCLUDED.parent_account,
       opening_balance = EXCLUDED.opening_balance,
       closing_live    = EXCLUDED.closing_live,
       payments_total  = EXCLUDED.payments_total,
       payments_count  = EXCLUDED.payments_count,
       expenses_total  = EXCLUDED.expenses_total,
       expenses_count  = EXCLUDED.expenses_count,
       net_movement    = EXCLUDED.net_movement,
       computed_at     = now()`,
    [
      date,
      result.parent_account || 'Elegansky Collection AC',
      result.opening_balance ?? null,
      result.closing_live ?? null,
      Number(result.payments_in_window?.total || 0),
      Number(result.payments_in_window?.count || 0),
      Number(result.expenses_in_window?.total || 0),
      Number(result.expenses_in_window?.count || 0),
      Number(result.net_movement || 0),
    ],
  );
  return { date, took_ms: Date.now() - t0 };
}

/**
 * Look up a pre-computed row. Returns the same shape the live
 * getAccountBalance returns, or null if no snapshot exists.
 */
export async function getSnapshotAccountBalance(fromDate, toDate) {
  // Single-day window only (snapshot is per-date). Multi-day callers
  // should sum across dates themselves.
  if (fromDate !== toDate) return null;
  const r = await db().query(
    `SELECT date, parent_account, opening_balance, closing_live,
            payments_total, payments_count, expenses_total, expenses_count,
            net_movement, computed_at
       FROM daily_account_balance WHERE date = $1`,
    [fromDate],
  );
  if (!r.rows.length) return null;
  const x = r.rows[0];
  return {
    parent_account: x.parent_account,
    sub_accounts: ['Kijichi Collection AC'],
    account_ids: {},
    opening_as_of: null,
    opening_balance: x.opening_balance == null ? null : Number(x.opening_balance),
    window: { from: fromDate, to: toDate },
    payments_in_window: { total: Number(x.payments_total), count: Number(x.payments_count) },
    expenses_in_window: { total: Number(x.expenses_total), count: Number(x.expenses_count) },
    net_movement: Number(x.net_movement),
    closing_live: x.closing_live == null ? null : Number(x.closing_live),
    _snapshot_computed_at: x.computed_at,
  };
}

async function tick(computeHook) {
  if (_inFlight) return;
  _inFlight = true;
  _state.last_run_at = new Date().toISOString();
  try {
    const today = eatTodayStr();
    const r = await snapshotAccountBalance(today, computeHook);
    _state.last_ok_at = new Date().toISOString();
    _state.last_error = null;
    _state.refreshes += 1;
    if (_state.refreshes <= 2) {
      console.log(`[acct-bal-snapshotter] tick #${_state.refreshes} ${today} in ${r.took_ms}ms`);
    }
  } catch (err) {
    _state.last_error = err.message;
    console.error('[acct-bal-snapshotter] tick failed:', err.message);
  } finally {
    _inFlight = false;
  }
}

export function startAccountBalanceSnapshotter(computeHook) {
  if (_started) return;
  _started = true;
  // Boot warmup — snap today + previous N days, then settle into the
  // tick loop. Sequential to keep QB API pressure low.
  (async () => {
    for (let i = 0; i < HISTORICAL_DAYS_ON_BOOT; i++) {
      try {
        const d = isoNDaysAgo(i);
        const r = await snapshotAccountBalance(d, computeHook);
        if (i === 0 || (_state.refreshes <= 2)) {
          console.log(`[acct-bal-snapshotter] boot warmup ${d} in ${r.took_ms}ms`);
        }
      } catch (e) {
        console.error('[acct-bal-snapshotter] boot warmup failed', e.message);
      }
    }
    _timer = setInterval(() => tick(computeHook), REFRESH_INTERVAL_MS);
    console.log(`[acct-bal-snapshotter] live tick every ${REFRESH_INTERVAL_MS}ms`);
  })();
}

export function getAccountBalanceSnapshotterState() {
  return { ..._state, running: _started, interval_ms: REFRESH_INTERVAL_MS };
}
