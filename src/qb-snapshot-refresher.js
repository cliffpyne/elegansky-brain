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

// 60 s is plenty for the dashboard "≤ 1 min freshness" target and stops
// the refresher from competing with CDC poller every 30 s for the same
// 4-connection pool. Settable via env if Frank wants to dial it.
const REFRESH_INTERVAL_MS = Number(process.env.SNAPSHOT_REFRESH_MS || 60_000);
const HISTORICAL_DAYS_ON_BOOT = 7;
// In-flight guard: a refresh tick under contention can take >30 s; never
// allow two to overlap.
let _inFlight = false;

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
     inv_bucket AS (
       SELECT id,
         CASE
           WHEN due_date < $1 THEN 'arrear'
           WHEN txn_date > $1 THEN 'future'
           ELSE 'today'
         END AS bucket
         FROM qb_invoices
     ),
     pay_lines_today AS (
       SELECT p.customer_id, l.amount, ib.bucket
         FROM qb_payments p
         JOIN qb_payment_lines l ON l.payment_id = p.id
         JOIN inv_bucket ib       ON ib.id = l.linked_invoice_id
        WHERE p.txn_date = $1 AND l.linked_invoice_id IS NOT NULL
     ),
     cm_lines_today AS (
       SELECT m.customer_id, l.amount, ib.bucket
         FROM qb_credit_memos m
         JOIN qb_credit_memo_lines l ON l.credit_memo_id = m.id
         JOIN inv_bucket ib          ON ib.id = l.linked_invoice_id
        WHERE m.txn_date = $1 AND l.linked_invoice_id IS NOT NULL
     ),
     pay_per_officer_gross AS (
       SELECT m.officer_id, m.officer_name,
              COALESCE(SUM(CASE WHEN pl.bucket = 'arrear' THEN pl.amount END), 0) AS arrear_gross,
              COALESCE(SUM(CASE WHEN pl.bucket = 'today'  THEN pl.amount END), 0) AS today_gross,
              COALESCE(SUM(CASE WHEN pl.bucket = 'future' THEN pl.amount END), 0) AS future_gross
         FROM pay_lines_today pl
         JOIN customer_officer_map m ON m.customer_id = pl.customer_id
        GROUP BY m.officer_id, m.officer_name
     ),
     cm_per_officer AS (
       SELECT m.officer_id,
              COALESCE(SUM(CASE WHEN cl.bucket = 'arrear' THEN cl.amount END), 0) AS arrear_cm,
              COALESCE(SUM(CASE WHEN cl.bucket = 'today'  THEN cl.amount END), 0) AS today_cm,
              COALESCE(SUM(CASE WHEN cl.bucket = 'future' THEN cl.amount END), 0) AS future_cm,
              COALESCE(SUM(cl.amount), 0)                                          AS total_cm
         FROM cm_lines_today cl
         JOIN customer_officer_map m ON m.customer_id = cl.customer_id
        GROUP BY m.officer_id
     ),
     pay_unapplied_per_officer AS (
       SELECT m.officer_id,
              COALESCE(SUM(p.total_amt - COALESCE(line_sums.lines_total, 0)), 0) AS unapplied_received
         FROM qb_payments p
         JOIN customer_officer_map m ON m.customer_id = p.customer_id
         LEFT JOIN (
           SELECT payment_id, SUM(amount) AS lines_total
             FROM qb_payment_lines GROUP BY payment_id
         ) line_sums ON line_sums.payment_id = p.id
        WHERE p.txn_date = $1
        GROUP BY m.officer_id
     ),
     disbursement_per_officer AS (
       SELECT m.officer_id,
              COALESCE(SUM(p.total_amt), 0) AS disbursement_total
         FROM qb_purchases p
         JOIN customer_officer_map m ON m.customer_id = p.entity_id
        WHERE p.txn_date = $1 AND p.entity_type = 'Customer'
        GROUP BY m.officer_id
     ),
     pay_per_officer AS (
       SELECT g.officer_id, g.officer_name,
              g.arrear_gross - COALESCE(c.arrear_cm, 0) AS arrear_collected,
              g.today_gross  - COALESCE(c.today_cm, 0)  AS today_invoice_collection,
              g.future_gross - COALESCE(c.future_cm, 0) AS future_invoice_collection
         FROM pay_per_officer_gross g
         LEFT JOIN cm_per_officer c ON c.officer_id = g.officer_id
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
     -- One row per officer; officer_name picked from whichever CTE has it.
     -- Without MAX() and GROUP BY, a UNION of (id, name) and (id, NULL)
     -- would surface two rows for the same officer.
     all_officers AS (
       SELECT officer_id, MAX(officer_name) AS officer_name
         FROM (
           SELECT officer_id, officer_name FROM overdue_per_officer
           UNION ALL
           SELECT officer_id, officer_name FROM pay_per_officer
           UNION ALL
           SELECT officer_id, officer_name FROM today_inv_per_officer
           UNION ALL
           SELECT officer_id, NULL FROM pay_unapplied_per_officer
           UNION ALL
           SELECT officer_id, NULL FROM disbursement_per_officer
         ) u
        GROUP BY officer_id
     )
     INSERT INTO daily_officer_snapshot (
       date, officer_id, officer_name,
       total_invoice_amount, today_balance_remain, open_invoice_count,
       arrears_now, arrears_morning, arrear_collected,
       today_invoice_collection, future_invoice_collection,
       open_invoice_collection,
       unapplied_received, credit_memo_issued, disbursement_total,
       overdue_invoice_count, computed_at
     )
     SELECT
       $1::date,
       a.officer_id,
       -- officer_name may be NULL when officer was discovered only via
       -- unapplied/disbursement CTE — fall back to customer_officer_map.
       COALESCE(a.officer_name, (SELECT MAX(officer_name) FROM customer_officer_map WHERE officer_id = a.officer_id), 'Unknown'),
       COALESCE(t.total_invoice_amount, 0),
       COALESCE(t.today_balance_remain, 0),
       COALESCE(t.open_invoice_count, 0),
       COALESCE(o.arrears_now, 0),
       COALESCE(o.arrears_now, 0) + COALESCE(p.arrear_collected, 0),
       COALESCE(p.arrear_collected, 0),
       COALESCE(p.today_invoice_collection, 0),
       COALESCE(p.future_invoice_collection, 0),
       -- Back-compat: open_invoice_collection = today + future
       COALESCE(p.today_invoice_collection, 0) + COALESCE(p.future_invoice_collection, 0),
       COALESCE(u.unapplied_received, 0),
       COALESCE(cm.total_cm, 0),
       COALESCE(d.disbursement_total, 0),
       COALESCE(o.overdue_count, 0),
       now()
     FROM all_officers a
     LEFT JOIN overdue_per_officer          o  ON o.officer_id  = a.officer_id
     LEFT JOIN pay_per_officer              p  ON p.officer_id  = a.officer_id
     LEFT JOIN today_inv_per_officer        t  ON t.officer_id  = a.officer_id
     LEFT JOIN pay_unapplied_per_officer    u  ON u.officer_id  = a.officer_id
     LEFT JOIN disbursement_per_officer     d  ON d.officer_id  = a.officer_id
     LEFT JOIN cm_per_officer               cm ON cm.officer_id = a.officer_id
     ON CONFLICT (date, officer_id) DO UPDATE SET
       officer_name              = EXCLUDED.officer_name,
       total_invoice_amount      = EXCLUDED.total_invoice_amount,
       today_balance_remain      = EXCLUDED.today_balance_remain,
       open_invoice_count        = EXCLUDED.open_invoice_count,
       arrears_now               = EXCLUDED.arrears_now,
       arrears_morning           = EXCLUDED.arrears_morning,
       arrear_collected          = EXCLUDED.arrear_collected,
       today_invoice_collection  = EXCLUDED.today_invoice_collection,
       future_invoice_collection = EXCLUDED.future_invoice_collection,
       open_invoice_collection   = EXCLUDED.open_invoice_collection,
       unapplied_received        = EXCLUDED.unapplied_received,
       credit_memo_issued        = EXCLUDED.credit_memo_issued,
       disbursement_total        = EXCLUDED.disbursement_total,
       overdue_invoice_count     = EXCLUDED.overdue_invoice_count,
       computed_at               = now()`,
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
  if (_inFlight) return;
  _inFlight = true;
  _state.last_run_at = new Date().toISOString();
  try {
    const today = eatTodayStr();
    const r = await refreshSnapshotForDate(today);
    _state.rows_upserted += r.rows;
    _state.last_ok_at = new Date().toISOString();
    _state.last_error = null;
    _state.refreshes += 1;
    if (r.rows > 0 && _state.refreshes <= 3) {
      console.log(`[snapshot-refresher] ${today}: upserted ${r.rows} officers in ${r.took_ms}ms`);
    }
  } catch (err) {
    _state.last_error = err.message;
    console.error('[snapshot-refresher] tick failed:', err.message);
  } finally {
    _inFlight = false;
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
