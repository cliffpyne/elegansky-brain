// Phase 4 — daily_officer_snapshot refresher.
//
// Computes per-(date, officer) aggregates from the mirror tables and upserts
// into daily_officer_snapshot. Today's row is refreshed every 30 s so the
// dashboard reads pre-aggregated rows (instant) instead of joining 50k
// invoices on every page load.
//
// Yesterday + N days back are refreshed once on boot, then sealed (no
// further refreshes unless a CDC delta touches them).
//
// All math is identical to getMirrorOfficerArrearMath / getMirrorOfficerInvoiceTotals
// in officer-reports.js — the refresher just bakes the join once and stores it.

import { db } from './db/pool.js';

const REFRESH_INTERVAL_MS = 30_000;
const HISTORICAL_DAYS_ON_BOOT = 7;

let _started = false;
let _timer = null;
let _state = {
  last_run_at: null,
  last_ok_at: null,
  last_error: null,
  refreshes: 0,
  rows_upserted: 0,
};

/**
 * Refresh a single date's snapshot. Idempotent — safe to run repeatedly.
 * One SQL query computes the full per-officer aggregate, then UPSERTs.
 */
export async function refreshSnapshotForDate(date) {
  const t0 = Date.now();
  const r = await db().query(
    `WITH overdue AS (
       SELECT id, customer_id, balance
         FROM qb_invoices
        WHERE balance > 0 AND due_date < $1
     ),
     overdue_per_officer AS (
       SELECT m.officer_id, m.officer_name,
              COUNT(*)::int                AS overdue_count,
              COALESCE(SUM(o.balance), 0)  AS arrears_now
         FROM overdue o
         JOIN customer_officer_map m ON m.customer_id = o.customer_id
        GROUP BY m.officer_id, m.officer_name
     ),
     pay_lines_today AS (
       SELECT p.customer_id, l.amount,
              (l.linked_invoice_id IN (SELECT id FROM overdue)) AS is_arrear
         FROM qb_payments p
         JOIN qb_payment_lines l ON l.payment_id = p.id
        WHERE p.txn_date = $1 AND l.linked_invoice_id IS NOT NULL
     ),
     pay_per_officer AS (
       SELECT m.officer_id, m.officer_name,
              COALESCE(SUM(CASE WHEN pl.is_arrear THEN pl.amount END), 0) AS arrear_collected,
              COALESCE(SUM(CASE WHEN NOT pl.is_arrear THEN pl.amount END), 0) AS open_invoice_collection
         FROM pay_lines_today pl
         JOIN customer_officer_map m ON m.customer_id = pl.customer_id
        GROUP BY m.officer_id, m.officer_name
     ),
     today_inv_per_officer AS (
       SELECT m.officer_id, m.officer_name,
              COUNT(*)::int                  AS open_invoice_count,
              COALESCE(SUM(i.total_amt), 0)  AS total_invoice_amount,
              COALESCE(SUM(i.balance), 0)    AS today_balance_remain
         FROM qb_invoices i
         JOIN customer_officer_map m ON m.customer_id = i.customer_id
        WHERE i.txn_date = $1
        GROUP BY m.officer_id, m.officer_name
     ),
     all_officers AS (
       SELECT officer_id, officer_name FROM overdue_per_officer
       UNION
       SELECT officer_id, officer_name FROM pay_per_officer
       UNION
       SELECT officer_id, officer_name FROM today_inv_per_officer
     )
     INSERT INTO daily_officer_snapshot (
       date, officer_id, officer_name,
       total_invoice_amount, today_balance_remain, open_invoice_count,
       arrears_now, arrears_morning, arrear_collected, open_invoice_collection,
       overdue_invoice_count, computed_at
     )
     SELECT
       $1::date,
       a.officer_id,
       a.officer_name,
       COALESCE(t.total_invoice_amount, 0),
       COALESCE(t.today_balance_remain, 0),
       COALESCE(t.open_invoice_count, 0),
       COALESCE(o.arrears_now, 0),
       COALESCE(o.arrears_now, 0) + COALESCE(p.arrear_collected, 0),
       COALESCE(p.arrear_collected, 0),
       COALESCE(p.open_invoice_collection, 0),
       COALESCE(o.overdue_count, 0),
       now()
     FROM all_officers a
     LEFT JOIN overdue_per_officer  o ON o.officer_id = a.officer_id
     LEFT JOIN pay_per_officer      p ON p.officer_id = a.officer_id
     LEFT JOIN today_inv_per_officer t ON t.officer_id = a.officer_id
     ON CONFLICT (date, officer_id) DO UPDATE SET
       officer_name             = EXCLUDED.officer_name,
       total_invoice_amount     = EXCLUDED.total_invoice_amount,
       today_balance_remain     = EXCLUDED.today_balance_remain,
       open_invoice_count       = EXCLUDED.open_invoice_count,
       arrears_now              = EXCLUDED.arrears_now,
       arrears_morning          = EXCLUDED.arrears_morning,
       arrear_collected         = EXCLUDED.arrear_collected,
       open_invoice_collection  = EXCLUDED.open_invoice_collection,
       overdue_invoice_count    = EXCLUDED.overdue_invoice_count,
       computed_at              = now()`,
    [date],
  );
  return { date, rows: r.rowCount, took_ms: Date.now() - t0 };
}

function eatTodayStr() {
  const eat = new Date(Date.now() + 3 * 3600_000);
  return eat.toISOString().slice(0, 10);
}

function isoNDaysAgo(n) {
  const d = new Date(Date.now() + 3 * 3600_000 - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

async function tick() {
  _state.last_run_at = new Date().toISOString();
  try {
    const today = eatTodayStr();
    const r = await refreshSnapshotForDate(today);
    _state.rows_upserted += r.rows;
    _state.last_ok_at = new Date().toISOString();
    _state.last_error = null;
    _state.refreshes += 1;
    // Light log to avoid console spam — only when meaningful.
    if (r.rows > 0 && _state.refreshes <= 3) {
      console.log(`[snapshot-refresher] ${today}: upserted ${r.rows} officers in ${r.took_ms}ms`);
    }
  } catch (err) {
    _state.last_error = err.message;
    console.error('[snapshot-refresher] tick failed:', err.message);
  }
}

export function startSnapshotRefresher() {
  if (_started) return;
  _started = true;
  // Boot warmup: refresh today + previous N days once so historical
  // comparisons have data.
  (async () => {
    for (let i = 0; i < HISTORICAL_DAYS_ON_BOOT; i++) {
      try {
        const d = isoNDaysAgo(i);
        const r = await refreshSnapshotForDate(d);
        if (i === 0 || r.rows > 0) {
          console.log(`[snapshot-refresher] boot warmup ${d}: ${r.rows} rows`);
        }
      } catch (e) {
        console.error('[snapshot-refresher] warmup failed', e.message);
      }
    }
    _timer = setInterval(tick, REFRESH_INTERVAL_MS);
    console.log(`[snapshot-refresher] live tick every ${REFRESH_INTERVAL_MS}ms`);
  })();
}

export function stopSnapshotRefresher() {
  if (_timer) clearInterval(_timer);
  _timer = null;
  _started = false;
}

export function getSnapshotRefresherState() {
  return { ..._state, running: _started, interval_ms: REFRESH_INTERVAL_MS };
}
