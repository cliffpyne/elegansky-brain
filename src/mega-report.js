// Mega-Report API: 4-section operator report combining QB account balance,
// channel sheet totals, per-officer invoice+arrear collections, and a
// company-wide arrear trend.
//
// Section A — QB Kijichi Collection AC balance
//   live total (now), opening (00:00 EAT of selected day), closing (23:59 EAT)
//
// Section B — Google Sheets totals per channel
//   PASSED tab: rows + total
//   FAILED tab: rows + total
//   UNUSED subset across both: rows whose customer column has "=", "," or empty
//
// Section C — Open invoice + remain per loan officer
//   reuses computeOfficerReport() per day, sums across the filter window
//
// Section D — Open arrear + closing per officer
//   reuses getOfficerArrears(), captures morning baseline at start of window
//
// Filters: day / week (Sun-Sat) / month / date range, single officer or all
// officers, company-wide arrear trend up/down indicator.

import { db } from './db/pool.js';
import { qbQuery, qbReport } from './qb-client.js';
import { readSheet } from './sheets.js';
import {
  computeOfficerReport,
  getOfficerArrears,
} from './officer-reports.js';

// Parent + sub-accounts that operator's Account QuickReport rolls up.
// "Elegansky Collection AC" is the parent; "Kijichi Collection AC" is the
// active sub-account where almost all Payments + Expenses land.
const PARENT_ACCOUNT_NAME = 'Elegansky Collection AC';
const SUB_ACCOUNT_NAMES = ['Kijichi Collection AC'];

// Channel sheet config — same sheet ids as officer-reports & payment-batches.
// Each channel has a PASSED tab, a FAILED tab, and optionally extra tabs
// (e.g. NMB's PASSED_SAV_NMB) that we include in the totals for completeness.
const CHANNEL_TABS = {
  nmbnew: {
    sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek',
    passed: 'PASSED',
    failed: 'FAILED_NMB',
    suffix: 'N',
  },
  nmbnew_sav: {
    sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek',
    passed: 'PASSED_SAV_NMB',
    failed: null,
    suffix: 'N',
  },
  bank: {
    sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o',
    passed: 'PASSED',
    failed: 'FAILED',
    suffix: 'B',
  },
  iphone_bank: {
    sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ',
    passed: 'BANK_PASSED',
    failed: 'BANK_FAILED',
    suffix: 'P',
  },
};

/**
 * Detect whether a sheet row represents an UNUSED transaction — customer
 * column has multi-plate (","), auto-suggestion ("="), or is empty.
 * Operator spec: "auto suggestion have = in them plate and = and name".
 */
function isUnusedRow(plateCol, customerCol) {
  const plate = String(plateCol || '').trim();
  const cust = String(customerCol || '').trim();
  if (!plate && !cust) return true;
  if (plate.includes('=') || cust.includes('=')) return true;
  if (plate.includes(',') || cust.includes(',')) return true;
  return false;
}

function parseAmount(s) {
  return Number(String(s || '').replace(/[, ]/g, '')) || 0;
}

// ── Section A — Account QuickReport-style (Beginning + credits − debits) ─

/**
 * Find the Account row's ending balance from a BalanceSheet report for one
 * named account. Walks the nested Rows tree.
 */
function balanceFromReport(report, accountName) {
  const target = String(accountName).toLowerCase();
  let found = null;
  const walk = (node) => {
    if (!node) return;
    if (Array.isArray(node)) { node.forEach(walk); return; }
    const summary = node.Summary?.ColData;
    if (summary?.[0]?.value && String(summary[0].value).toLowerCase().includes(target)) {
      const val = Number(summary[summary.length - 1]?.value || 0);
      if (!isNaN(val)) found = val;
    }
    const rowData = node.ColData;
    if (Array.isArray(rowData) && rowData[0]?.value && String(rowData[0].value).toLowerCase().includes(target)) {
      const val = Number(rowData[rowData.length - 1]?.value || 0);
      if (!isNaN(val)) found = val;
    }
    if (node.Rows?.Row) walk(node.Rows.Row);
    if (node.Row) walk(node.Row);
  };
  walk(report?.Rows?.Row || report?.Rows || []);
  return found;
}

/**
 * Resolve account names → ids by querying QB Account. Returns { name → id }.
 * Cached process-wide because account ids don't change.
 */
const _accountIdCache = new Map(); // name → id
async function getAccountIds(names) {
  const ids = {};
  const need = [];
  for (const name of names) {
    if (_accountIdCache.has(name)) ids[name] = _accountIdCache.get(name);
    else need.push(name);
  }
  for (const name of need) {
    try {
      const r = await qbQuery(`SELECT Id, Name FROM Account WHERE Name = '${name.replace(/'/g, "''")}'`);
      const acct = r.QueryResponse?.Account?.[0];
      if (acct) { ids[name] = acct.Id; _accountIdCache.set(name, acct.Id); }
    } catch { /* skip */ }
  }
  return ids;
}

/**
 * Sum TotalAmt of all Payments WHERE TxnDate in [from, to] AND
 * DepositToAccountRef IN accountIds. Paginated 1000 at a time.
 */
async function sumPaymentsInWindow(accountIds, fromDate, toDate) {
  const targetIds = new Set(accountIds.map(String));
  let total = 0, count = 0;
  const BATCH = 1000;
  let start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT Id, TotalAmt, DepositToAccountRef ` +
      `FROM Payment WHERE TxnDate >= '${fromDate}' AND TxnDate <= '${toDate}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Payment || [];
    for (const p of rows) {
      if (targetIds.has(String(p.DepositToAccountRef?.value || ''))) {
        total += Number(p.TotalAmt || 0); count++;
      }
    }
    if (rows.length < BATCH) break;
    start += BATCH;
  }
  return { total, count };
}

/**
 * Sum TotalAmt of all Purchase ("Expense") transactions WHERE TxnDate in
 * [from, to] AND AccountRef in accountIds. QB calls operator-side Expense
 * entries Purchase records.
 */
async function sumExpensesInWindow(accountIds, fromDate, toDate) {
  const targetIds = new Set(accountIds.map(String));
  let total = 0, count = 0;
  const BATCH = 1000;
  let start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT Id, TotalAmt, AccountRef ` +
      `FROM Purchase WHERE TxnDate >= '${fromDate}' AND TxnDate <= '${toDate}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Purchase || [];
    for (const p of rows) {
      if (targetIds.has(String(p.AccountRef?.value || ''))) {
        total += Number(p.TotalAmt || 0); count++;
      }
    }
    if (rows.length < BATCH) break;
    start += BATCH;
  }
  return { total, count };
}

/**
 * Section A: Account QuickReport-style.
 *  - Beginning balance of Elegansky Collection AC (parent) at start of window
 *  - Sum of all Payments (credits) into Elegansky + sub-accounts
 *  - Sum of all Expenses (debits) out of Elegansky + sub-accounts
 *  - Net movement = credits − debits  ← this matches operator's "Total" row
 *  - Live closing balance (parent + sub-accounts, right now)
 */
async function getAccountBalance(fromDate, toDate) {
  const allNames = [PARENT_ACCOUNT_NAME, ...SUB_ACCOUNT_NAMES];
  const ids = await getAccountIds(allNames);
  const targetIds = Object.values(ids);
  // Beginning balance: parent account's balance at end of (fromDate - 1)
  const prevDay = new Date(fromDate + 'T00:00:00Z');
  prevDay.setUTCDate(prevDay.getUTCDate() - 1);
  const openingAsOf = prevDay.toISOString().slice(0, 10);
  let opening = null, closing_live = null;
  try {
    const openReport = await qbReport('BalanceSheet', { end_date: openingAsOf, start_date: '2020-01-01' });
    opening = balanceFromReport(openReport, PARENT_ACCOUNT_NAME);
    const liveReport = await qbReport('BalanceSheet', { end_date: new Date().toISOString().slice(0, 10), start_date: '2020-01-01' });
    closing_live = balanceFromReport(liveReport, PARENT_ACCOUNT_NAME);
  } catch (err) {
    console.error('[mega-report] BalanceSheet failed:', err.message);
  }
  const [payments, expenses] = await Promise.all([
    sumPaymentsInWindow(targetIds, fromDate, toDate),
    sumExpensesInWindow(targetIds, fromDate, toDate),
  ]);
  const net_movement = payments.total - expenses.total;
  return {
    parent_account: PARENT_ACCOUNT_NAME,
    sub_accounts: SUB_ACCOUNT_NAMES,
    account_ids: ids,
    opening_as_of: openingAsOf,
    opening_balance: opening,
    window: { from: fromDate, to: toDate },
    payments_in_window: payments,
    expenses_in_window: expenses,
    net_movement,
    closing_live,
  };
}

// ── Section B — Sheet Totals + Unused ─────────────────────────────────────

/**
 * Read one tab (PASSED or FAILED) and classify rows. Returns aggregate
 * counts + totals + unused subset.
 *
 * Sheet column convention (same as payment-batches.js reads):
 *   A = txn_id      B = timestamp     C = ?
 *   D = description E = amount        F = plate code(s)
 *   G = customer    H = bank_ref
 */
/**
 * Parse "DD.MM.YYYY HH:MM:SS" → Date (treats clock as EAT, returns UTC Date).
 */
function parseSheetTs(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, hh, mm, ss] = m;
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh - 3, +mm, +(ss || 0)));
}

async function readSheetTab(sheetId, tab, windowStart, windowEnd) {
  const out = { rows: 0, total: 0, unused_rows: 0, unused_total: 0 };
  try {
    const sheet = await readSheet(sheetId, `${tab}!A1:H100000`);
    const data = sheet.values || sheet.data || [];
    for (let i = 1; i < data.length; i++) {
      const r = data[i] || [];
      const ts = parseSheetTs(r[1]);
      if (!ts) continue;
      if (windowStart && ts < windowStart) continue;
      if (windowEnd && ts >= windowEnd) continue;
      const amt = parseAmount(r[4]);
      out.rows++;
      out.total += amt;
      if (isUnusedRow(r[5], r[6])) {
        out.unused_rows++;
        out.unused_total += amt;
      }
    }
  } catch (err) {
    console.error('[mega-report] readSheetTab failed:', sheetId, tab, err.message);
  }
  return out;
}

async function getSheetTotals(fromDate, toDate) {
  // Window: [fromDate 00:00 EAT, (toDate + 1 day) 00:00 EAT) in UTC.
  const winStart = new Date(fromDate + 'T00:00:00+03:00');
  const winEndExclusive = new Date(toDate + 'T00:00:00+03:00');
  winEndExclusive.setUTCDate(winEndExclusive.getUTCDate() + 1);
  const byChannel = {};
  let totalPassed = 0, totalFailed = 0, totalUnused = 0;
  for (const [channel, cfg] of Object.entries(CHANNEL_TABS)) {
    const [passed, failed] = await Promise.all([
      readSheetTab(cfg.sheetId, cfg.passed, winStart, winEndExclusive),
      cfg.failed ? readSheetTab(cfg.sheetId, cfg.failed, winStart, winEndExclusive)
                 : Promise.resolve({ rows: 0, total: 0, unused_rows: 0, unused_total: 0 }),
    ]);
    byChannel[channel] = {
      passed: { rows: passed.rows, total: passed.total },
      failed: { rows: failed.rows, total: failed.total },
      // legacy shape kept for backward-compat with v3 dashboard build
      extra_tabs: [],
      extra: { rows: 0, total: 0 },
      unused: {
        passed_rows: passed.unused_rows,
        passed_total: passed.unused_total,
        failed_rows: failed.unused_rows,
        failed_total: failed.unused_total,
        extra_rows: 0,
        extra_total: 0,
        total_rows: passed.unused_rows + failed.unused_rows,
        total_amount: passed.unused_total + failed.unused_total,
      },
    };
    totalPassed += passed.total;
    totalFailed += failed.total;
    totalUnused += passed.unused_total + failed.unused_total;
  }
  return {
    by_channel: byChannel,
    grand_passed_total: totalPassed,
    grand_failed_total: totalFailed,
    grand_unused_total: totalUnused,
  };
}

// ── Section C+D — Officers (invoices, motorcycles, arrears) per range ─────

function eachDateInRange(from, to) {
  const out = [];
  const start = new Date(from + 'T00:00:00Z');
  const end = new Date(to + 'T00:00:00Z');
  for (let d = new Date(start); d <= end; d.setUTCDate(d.getUTCDate() + 1)) {
    out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

/**
 * Aggregate computeOfficerReport across every day in [from, to]. For each
 * officer, sum their per-day metrics into one row.
 *
 * Returns: { officers: [...], grand: {...} }
 */
async function aggregateOfficers(from, to, officerIdFilter) {
  const dates = eachDateInRange(from, to);
  const byOfficer = new Map();
  let grand = {
    total_invoice_amount: 0,
    today_balance_remain: 0,
    open: 0,
    adjustment: 0,
    motos_office: 0,
    motos_police: 0,
    collection: 0,
    arrears_morning: 0,
    arrears_realtime: 0,
  };
  // Morning arrears = baseline on FROM date (start of window).
  const morningArrears = await getOfficerArrears(from);
  // Real-time arrears = freshest snapshot (today) — captured by latest day's
  // computeOfficerReport.
  for (const d of dates) {
    const report = await computeOfficerReport(d);
    for (const row of report.per_officer || report.officers || []) {
      if (officerIdFilter && String(row.officer_id) !== String(officerIdFilter)) continue;
      const morningAmt = Number(morningArrears.get(row.officer_id)?.total_arrears
        || morningArrears.get(row.officer_id)?.amount || 0);
      const cur = byOfficer.get(row.officer_id) || {
        officer_id: row.officer_id,
        officer_name: row.officer_name,
        total_invoice_amount: 0,
        today_balance_remain: 0,
        open: 0,
        adjustment: 0,
        motos_office: 0,
        motos_police: 0,
        collection: 0,
        arrears_morning: morningAmt,
        arrears_realtime: 0,
      };
      cur.total_invoice_amount += Number(row.total_invoice_amount || 0);
      cur.today_balance_remain += Number(row.today_balance_remain || 0);
      cur.open += Number(row.open || 0);
      cur.adjustment += Number(row.offline_adjustment || row.adjustment || 0);
      cur.motos_office += Number(row.office_count || row.motos_office || 0);
      cur.motos_police += Number(row.police_count || row.motos_police || 0);
      cur.collection += Number(row.collection || 0);
      // Real-time arrears = latest day's value (overwrite each iteration).
      cur.arrears_realtime = Number(row.total_arrears || row.arrears || 0);
      byOfficer.set(row.officer_id, cur);
    }
  }
  const officers = Array.from(byOfficer.values()).map((o) => {
    const collected = o.total_invoice_amount - o.today_balance_remain;
    const pct_collected = o.open > 0 ? (collected / o.open) * 100 : null;
    const arrear_collected = o.arrears_morning - o.arrears_realtime;
    const arrear_pct_collected = o.arrears_morning > 0
      ? (arrear_collected / o.arrears_morning) * 100 : null;
    grand.total_invoice_amount += o.total_invoice_amount;
    grand.today_balance_remain += o.today_balance_remain;
    grand.open += o.open;
    grand.adjustment += o.adjustment;
    grand.motos_office += o.motos_office;
    grand.motos_police += o.motos_police;
    grand.collection += o.collection;
    grand.arrears_morning += o.arrears_morning;
    grand.arrears_realtime += o.arrears_realtime;
    return { ...o, collected, pct_collected, arrear_collected, arrear_pct_collected };
  });
  const grandCollected = grand.total_invoice_amount - grand.today_balance_remain;
  const grandArrearCollected = grand.arrears_morning - grand.arrears_realtime;
  return {
    officers: officers.sort((a, b) => (b.open || 0) - (a.open || 0)),
    grand: {
      ...grand,
      collected: grandCollected,
      pct_collected: grand.open > 0 ? (grandCollected / grand.open) * 100 : null,
      arrear_collected: grandArrearCollected,
      arrear_pct_collected: grand.arrears_morning > 0
        ? (grandArrearCollected / grand.arrears_morning) * 100 : null,
    },
  };
}

// ── Filter window helpers ─────────────────────────────────────────────────

function todayEatStr() {
  const eat = new Date(Date.now() + 3 * 3600_000);
  return eat.toISOString().slice(0, 10);
}

/**
 * Resolve a (granularity, anchor) pair into a [from, to] date pair.
 *   day:   anchor → [anchor, anchor]
 *   week:  Sunday-anchored week containing anchor
 *   month: calendar month containing anchor
 *   range: caller provides from + to directly
 */
function resolveWindow({ granularity, anchor, from, to }) {
  const today = todayEatStr();
  const a = anchor || from || today;
  if (granularity === 'day' || !granularity) return { from: a, to: a };
  if (granularity === 'range') return { from: from || a, to: to || a };
  const d = new Date(a + 'T00:00:00Z');
  if (granularity === 'week') {
    const dow = d.getUTCDay(); // 0 = Sunday
    const start = new Date(d); start.setUTCDate(start.getUTCDate() - dow);
    const end = new Date(start); end.setUTCDate(end.getUTCDate() + 6);
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  }
  if (granularity === 'month') {
    const start = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    const end = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
    return { from: start.toISOString().slice(0, 10), to: end.toISOString().slice(0, 10) };
  }
  return { from: a, to: a };
}

// ── HTTP mount ────────────────────────────────────────────────────────────

export function mountMegaReportApi(app, { requireSecretOrJwt }) {
  // GET /api/mega-report?granularity=day|week|month|range&anchor=YYYY-MM-DD&from=&to=&officer_id=
  app.get('/api/mega-report', requireSecretOrJwt, async (req, res) => {
    try {
      const window = resolveWindow({
        granularity: req.query.granularity,
        anchor: req.query.anchor,
        from: req.query.from,
        to: req.query.to,
      });
      const officerId = req.query.officer_id || null;
      const [accountBalance, sheetTotals, officersAgg] = await Promise.all([
        getAccountBalance(window.from, window.to),
        getSheetTotals(window.from, window.to),
        aggregateOfficers(window.from, window.to, officerId),
      ]);
      // Previous-period comparison for arrear trend (same length, immediately prior).
      const fromD = new Date(window.from + 'T00:00:00Z');
      const toD = new Date(window.to + 'T00:00:00Z');
      const days = Math.round((toD - fromD) / (24 * 3600_000)) + 1;
      const prevTo = new Date(fromD); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
      const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
      const prevAgg = await aggregateOfficers(
        prevFrom.toISOString().slice(0, 10),
        prevTo.toISOString().slice(0, 10),
        officerId,
      ).catch(() => ({ grand: { arrears_realtime: 0 } }));
      const curArr = officersAgg.grand.arrears_realtime || 0;
      const prevArr = prevAgg.grand.arrears_realtime || 0;
      const arrear_trend = {
        current: curArr,
        previous: prevArr,
        delta: curArr - prevArr,
        direction: curArr === prevArr ? 'flat' : (curArr > prevArr ? 'up' : 'down'),
        pct_change: prevArr > 0 ? ((curArr - prevArr) / prevArr) * 100 : null,
      };
      res.json({
        window,
        officer_id_filter: officerId,
        section_a_account_balance: accountBalance,
        section_b_sheet_totals: sheetTotals,
        section_c_d_officers: officersAgg,
        section_e_company_arrear_trend: arrear_trend,
        generated_at: new Date().toISOString(),
      });
    } catch (err) {
      console.error('[mega-report] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── In-process caches + request throttle for /api/mega-report/series ────
  // The dashboard pages have ~30 TrendCells each, every hover fans out a
  // week or month of QB queries. Without these guards the QB calls swamp
  // the event loop and Render's health probe gets reset, killing the box.

  // Per-day computed summary, TTL 5 min. Map key = `${date}|${officerId||''}`.
  const _dayCache = new Map();
  const DAY_CACHE_TTL_MS = 5 * 60 * 1000;
  // Coalesce in-flight per-day computations so 30 hovers asking for the
  // same day make exactly ONE QB roundtrip, not 30.
  const _dayInFlight = new Map();

  async function computeDaySummary(date, officerId) {
    const key = `${date}|${officerId || ''}`;
    const cached = _dayCache.get(key);
    if (cached && Date.now() - cached.ts < DAY_CACHE_TTL_MS) return cached.result;
    const existing = _dayInFlight.get(key);
    if (existing) return existing;
    const p = (async () => {
      const [acct, sheets, officers] = await Promise.all([
        getAccountBalance(date, date).catch(() => null),
        getSheetTotals(date, date).catch(() => null),
        aggregateOfficers(date, date, officerId).catch(() => null),
      ]);
      return {
        date,
        account: acct ? {
          payments_total: acct.payments_in_window?.total || 0,
          payments_count: acct.payments_in_window?.count || 0,
          expenses_total: acct.expenses_in_window?.total || 0,
          expenses_count: acct.expenses_in_window?.count || 0,
          net_movement: acct.net_movement || 0,
          opening_balance: acct.opening_balance,
          closing_live: acct.closing_live,
        } : null,
        sheets: sheets ? {
          passed_total: sheets.grand_passed_total || 0,
          failed_total: sheets.grand_failed_total || 0,
          unused_total: sheets.grand_unused_total || 0,
          by_channel: Object.fromEntries(Object.entries(sheets.by_channel).map(([ch, v]) => [ch, {
            passed_total: (v.passed?.total || 0) + (v.extra?.total || 0),
            failed_total: v.failed?.total || 0,
            unused_total: v.unused?.total_amount || 0,
          }])),
        } : null,
        officers: officers ? {
          total_invoice_amount: officers.grand.total_invoice_amount || 0,
          today_balance_remain: officers.grand.today_balance_remain || 0,
          open: officers.grand.open || 0,
          collected: officers.grand.collected || 0,
          pct_collected: officers.grand.pct_collected,
          arrears_morning: officers.grand.arrears_morning || 0,
          arrears_realtime: officers.grand.arrears_realtime || 0,
          arrear_collected: officers.grand.arrear_collected || 0,
          arrear_pct_collected: officers.grand.arrear_pct_collected,
          officer_count: officers.officers.length,
        } : null,
      };
    })();
    _dayInFlight.set(key, p);
    try {
      const result = await p;
      _dayCache.set(key, { result, ts: Date.now() });
      return result;
    } finally {
      _dayInFlight.delete(key);
    }
  }

  // Cheap concurrency limiter for the whole series endpoint. With more than
  // SERIES_LIMIT requests in flight, late ones queue up rather than launching
  // their own QB-call storms.
  const SERIES_LIMIT = 2;
  let _seriesInFlight = 0;
  const _seriesWaiters = [];
  async function acquireSeriesSlot() {
    if (_seriesInFlight < SERIES_LIMIT) { _seriesInFlight++; return; }
    await new Promise((r) => _seriesWaiters.push(r));
    _seriesInFlight++;
  }
  function releaseSeriesSlot() {
    _seriesInFlight--;
    const next = _seriesWaiters.shift();
    if (next) next();
  }

  // GET /api/mega-report/series?from=YYYY-MM-DD&to=YYYY-MM-DD&officer_id=
  // Returns a compact per-day summary across the window. Powers the hover-
  // trend popovers and the click-through monthly/daily detailed views on
  // the dashboard. Each day computes Account Balance + Sheet Totals +
  // Officers in parallel; only the metrics needed by KPI tiles are returned.
  app.get('/api/mega-report/series', requireSecretOrJwt, async (req, res) => {
    try {
      const from = String(req.query.from || '');
      const to = String(req.query.to || '');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
        return res.status(400).json({ error: 'from + to (YYYY-MM-DD) required' });
      }
      const officerId = req.query.officer_id || null;
      const dates = [];
      const fd = new Date(from + 'T00:00:00Z');
      const td = new Date(to + 'T00:00:00Z');
      for (let d = new Date(fd); d <= td; d.setUTCDate(d.getUTCDate() + 1)) {
        dates.push(d.toISOString().slice(0, 10));
      }
      // Hard cap so a careless hover doesn't fan out into hundreds of QB calls.
      if (dates.length > 62) {
        return res.status(400).json({ error: `series range too wide (${dates.length} days, max 62)` });
      }
      await acquireSeriesSlot();
      try {
        // Process dates with limited concurrency (2 at a time inside one
        // request) AND share results across overlapping requests via the
        // memo+coalesce in computeDaySummary.
        const out = new Array(dates.length);
        const CONCURRENCY = 2;
        let idx = 0;
        const worker = async () => {
          while (true) {
            const i = idx++;
            if (i >= dates.length) return;
            const d = dates[i];
            try {
              out[i] = await computeDaySummary(d, officerId);
            } catch (err) {
              out[i] = { date: d, error: err.message };
            }
          }
        };
        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
        res.json({
          from, to, officer_id_filter: officerId,
          days: out,
          generated_at: new Date().toISOString(),
        });
      } finally {
        releaseSeriesSlot();
      }
    } catch (err) {
      console.error('[mega-report/series] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });
}
