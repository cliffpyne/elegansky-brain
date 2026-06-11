// Section B — daily_sheet_totals snapshotter.
//
// Background loop that computes Section B sheet totals (PASSED/FAILED/
// UNUSED rows + amounts per channel) and UPSERTs into daily_sheet_totals.
// mega-report's getSheetTotals reads from this table first, falling back
// to live Google Sheets only on miss.
//
// Refresh cadence: every 60 s for today + previous N days on boot.

import { db } from './db/pool.js';

const REFRESH_INTERVAL_MS = Number(process.env.SHEET_TOTALS_REFRESH_MS || 60_000);
const HISTORICAL_DAYS_ON_BOOT = 7;

let _started = false;
let _timer = null;
let _inFlight = false;
let _state = { last_run_at: null, last_ok_at: null, last_error: null, refreshes: 0 };

function eatTodayStr() { const eat = new Date(Date.now() + 3 * 3600_000); return eat.toISOString().slice(0, 10); }
function isoNDaysAgo(n) { const d = new Date(Date.now() + 3 * 3600_000 - n * 86_400_000); return d.toISOString().slice(0, 10); }

export async function snapshotSheetTotalsForDate(date, computeHook) {
  const t0 = Date.now();
  const result = await computeHook(date, date);
  // Persist one row per channel.
  for (const [channel, v] of Object.entries(result.by_channel || {})) {
    const passedT = Number((v.passed?.total || 0) + (v.extra?.total || 0));
    const failedT = Number(v.failed?.total || 0);
    const passedR = Number((v.passed?.rows || 0) + (v.extra?.rows || 0));
    const failedR = Number(v.failed?.rows || 0);
    const unusedT = Number(v.unused?.total_amount || 0);
    const unusedR = Number(v.unused?.total_rows || 0);
    await db().query(
      `INSERT INTO daily_sheet_totals
         (date, channel, passed_rows, passed_total, failed_rows, failed_total, unused_rows, unused_total, computed_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
       ON CONFLICT (date, channel) DO UPDATE SET
         passed_rows = EXCLUDED.passed_rows,
         passed_total = EXCLUDED.passed_total,
         failed_rows = EXCLUDED.failed_rows,
         failed_total = EXCLUDED.failed_total,
         unused_rows = EXCLUDED.unused_rows,
         unused_total = EXCLUDED.unused_total,
         computed_at = now()`,
      [date, channel, passedR, passedT, failedR, failedT, unusedR, unusedT],
    );
  }
  return { date, channels: Object.keys(result.by_channel || {}).length, took_ms: Date.now() - t0 };
}

/**
 * Reconstruct the getSheetTotals shape from the per-channel rows. Returns
 * null if no rows for this date (caller falls back to live read).
 */
export async function getSnapshotSheetTotals(fromDate, toDate) {
  if (fromDate !== toDate) return null;
  const r = await db().query(
    `SELECT channel, passed_rows, passed_total, failed_rows, failed_total,
            unused_rows, unused_total
       FROM daily_sheet_totals WHERE date = $1`,
    [fromDate],
  );
  if (!r.rows.length) return null;
  const by_channel = {};
  let totalPassed = 0, totalFailed = 0, totalUnused = 0;
  for (const x of r.rows) {
    const pT = Number(x.passed_total), fT = Number(x.failed_total), uT = Number(x.unused_total);
    by_channel[x.channel] = {
      sheet_id: null,
      passed: { rows: Number(x.passed_rows), total: pT },
      failed: { rows: Number(x.failed_rows), total: fT },
      extra_tabs: [], extra: { rows: 0, total: 0 },
      unused: {
        passed_rows: 0, passed_total: 0, failed_rows: 0, failed_total: 0,
        extra_rows: 0, extra_total: 0,
        total_rows: Number(x.unused_rows), total_amount: uT,
      },
    };
    totalPassed += pT; totalFailed += fT; totalUnused += uT;
  }
  return { by_channel, grand_passed_total: totalPassed, grand_failed_total: totalFailed, grand_unused_total: totalUnused };
}

async function tick(computeHook) {
  if (_inFlight) return;
  _inFlight = true;
  _state.last_run_at = new Date().toISOString();
  try {
    const today = eatTodayStr();
    const r = await snapshotSheetTotalsForDate(today, computeHook);
    _state.last_ok_at = new Date().toISOString();
    _state.last_error = null;
    _state.refreshes += 1;
    if (_state.refreshes <= 2) console.log(`[sheet-totals-snapshotter] tick #${_state.refreshes} ${today} ${r.channels} channels in ${r.took_ms}ms`);
  } catch (err) {
    _state.last_error = err.message;
    console.error('[sheet-totals-snapshotter] tick failed:', err.message);
  } finally {
    _inFlight = false;
  }
}

export function startSheetTotalsSnapshotter(computeHook) {
  if (_started) return;
  _started = true;
  (async () => {
    for (let i = 0; i < HISTORICAL_DAYS_ON_BOOT; i++) {
      try {
        const d = isoNDaysAgo(i);
        const r = await snapshotSheetTotalsForDate(d, computeHook);
        if (i === 0 || _state.refreshes <= 1) {
          console.log(`[sheet-totals-snapshotter] boot warmup ${d} ${r.channels} channels in ${r.took_ms}ms`);
        }
      } catch (e) {
        console.error('[sheet-totals-snapshotter] boot warmup failed', e.message);
      }
    }
    _timer = setInterval(() => tick(computeHook), REFRESH_INTERVAL_MS);
    console.log(`[sheet-totals-snapshotter] live tick every ${REFRESH_INTERVAL_MS}ms`);
  })();
}

export function getSheetTotalsSnapshotterState() {
  return { ..._state, running: _started, interval_ms: REFRESH_INTERVAL_MS };
}
