// ────────────────────────────────────────────────────────────────────────────
// m6pm automation — glue layer between BRAIN and the m6pm reports system.
//
// m6pm (eleganskyboda.com / elegansky-m6pm.onrender.com) is SACRED and stays
// untouched. This module only:
//   1. Produces a QB-format .xls from BRAIN's live /arrears query
//   2. POSTs it to m6pm's existing /api/generate-debt-reports endpoint after
//      each scheduled tick (morning/noon/evening, plus heisenberg catch-up)
//   3. Triggers m6pm's /api/sync-mobile + notification dispatch ONCE per day
//      after the MORNING report only (Frank's rule — re-sync would void
//      officers' work in flight)
//   4. Shares the report link to the WhatsApp group via m6pm's existing
//      whatsapp-bridge queue
//
// Frank's once-a-day rule (2026-06-25): the morning sync-mobile + officer
// notification happen ONCE per day, after the meru0100 debt report. The
// noon (lengai1230) and evening (kili1615) runs ONLY generate reports —
// they do NOT sync mobile and do NOT send SMS notifications. Re-syncing
// would overwrite officers' in-progress collection work and is destructive.
// ────────────────────────────────────────────────────────────────────────────

import XLSX from 'xlsx';
import crypto from 'node:crypto';

const M6PM_BASE = process.env.M6PM_BASE_URL || 'https://elegansky-m6pm.onrender.com';
const ARREARS_PAGE_SIZE = 1000;
// Public report link config. Shared secret must match m6pm REPORT_LINK_SECRET.
// Links default to 72h TTL — long enough for an admin who gets the SMS at 03:00
// to still click it Monday morning.
const REPORT_LINK_SECRET = process.env.REPORT_LINK_SECRET || '';
const REPORT_LINK_BASE = process.env.REPORT_LINK_BASE || 'https://www.eleganskyboda.com';
const REPORT_LINK_TTL_HOURS = 72;

/**
 * Generate a signed link to the m6pm public report endpoints. The signature
 * is HMAC-SHA256 of `date|name|exp` (legacy) or `date|mode|name|exp` (mode-
 * segmented, since 2026-06-27) — matches m6pm's _verify_report_token.
 *   path  = 'list' (use name='*') or 'file' (use name=filename)
 *   mode  = optional 'morning'|'noon'|'evening'|'heisenberg'. When set, link
 *           page filters to only that mode's frozen files — so a morning
 *           link clicked at noon still shows morning's numbers.
 * Returns null if secret is unset (so the SMS just gets the stats summary
 * instead of a dead link).
 */
function signedReportUrl({ path, date, name, mode = '' }) {
  if (!REPORT_LINK_SECRET) return null;
  const exp = Math.floor(Date.now() / 1000) + REPORT_LINK_TTL_HOURS * 3600;
  // Page + list endpoints share the same signature payload (name='*')
  // because both list a date's files. File downloads have their own
  // signature with the actual filename in the payload.
  const sigName = path === 'file' ? name : '*';
  const payload = mode
    ? `${date}|${mode}|${sigName}|${exp}`
    : `${date}|${sigName}|${exp}`;
  const sig = crypto.createHmac('sha256', REPORT_LINK_SECRET).update(payload).digest('hex');
  const u = new URL(`/api/p/reports/${path}`, REPORT_LINK_BASE);
  u.searchParams.set('date', date);
  if (path === 'file') u.searchParams.set('name', name);
  u.searchParams.set('exp', String(exp));
  u.searchParams.set('sig', sig);
  if (mode) u.searchParams.set('mode', mode);
  return u.toString();
}

/**
 * Internal helper — paginate the /arrears endpoint and return all invoice
 * rows. Calls the BRAIN's own /arrears handler over HTTP using the shared
 * secret so we get the same exact data + customer enrichment without
 * duplicating that 150-line query loop.
 */
async function fetchAllArrears({ asOf, brainSelfBase, sharedSecret, excludeToday = false }) {
  const out = [];
  let start = 1;
  for (;;) {
    const url = new URL('/arrears', brainSelfBase);
    url.searchParams.set('pageSize', String(ARREARS_PAGE_SIZE));
    url.searchParams.set('start', String(start));
    if (asOf) url.searchParams.set('asOf', asOf);
    if (excludeToday) url.searchParams.set('excludeToday', 'true');
    const r = await fetch(url.toString(), {
      headers: { 'X-Report-Secret': sharedSecret },
      signal: AbortSignal.timeout(120_000),
    });
    if (!r.ok) {
      const text = (await r.text()).slice(0, 300);
      throw new Error(`/arrears returned ${r.status}: ${text}`);
    }
    const body = await r.json();
    const invs = body.invoices || [];
    for (const inv of invs) out.push(inv);
    const next = body.page?.nextStart;
    if (!next || invs.length === 0) break;
    start = next;
  }
  return out;
}

/**
 * Format MM/DD/YYYY (matches QB xls export exactly — Frank's exports use
 * US-style dates).
 */
function fmtDateQbStyle(iso) {
  if (!iso) return '';
  const m = String(iso).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return iso;
  return `${m[2]}/${m[3]}/${m[1]}`;
}

/**
 * Build a QB-format .xls binary from BRAIN's arrears.
 *
 * QB xls structure (verified against overduejune25morning.xls 2026-06-25):
 *   Row 0: "Type: Invoices Status: Overdue Date: All"  ← metadata, A1 only
 *   Row 1: Date | Type | No. | Customer | Memo | Balance | Amount | Status
 *   Row 2+: data rows
 *
 * m6pm's parse_quickbooks() searches for the row containing a "Customer"
 * cell as the header, so the metadata row above is harmless. Output is
 * BIFF8 (.xls binary) because m6pm uses xlrd engine which only reads .xls.
 */
function buildArrearsXls(arrears, asOf) {
  const aoa = [
    [`Type: Invoices Status: Overdue Date: All${asOf ? '   As of ' + asOf : ''}`],
    ['Date', 'Type', 'No.', 'Customer', 'Memo', 'Balance', 'Amount', 'Status'],
  ];
  for (const inv of arrears) {
    aoa.push([
      fmtDateQbStyle(inv.date),
      inv.type || 'Invoice',
      inv.no || '',
      inv.customer || '',
      inv.memo || '',
      Number(inv.balance) || 0,
      Number(inv.amount) || 0,
      inv.status || 'overdue',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Arrears');
  return XLSX.write(wb, { bookType: 'biff8', type: 'buffer' });
}

/**
 * Parse a QB-format .xls buffer back into the same arrears row shape that
 * fetchAllArrears produces. Used to reconstruct a frozen morning baseline
 * (e.g. from Frank's hand-exported overduejuneXXmorning.xls) so the
 * kili1615 evening comparison can diff against it.
 *
 * Returns an array of {date, type, no, customer, memo, balance, amount, status}.
 * Handles both the metadata-row + header-row layout (BRAIN's builder) and
 * QB's own header-only layout.
 */
function parseArrearsXls(xlsBuffer) {
  const wb = XLSX.read(xlsBuffer, { type: 'buffer' });
  const ws = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
  // Find the header row (contains a 'Customer' cell, case-insensitive)
  let headerIdx = -1;
  for (let i = 0; i < Math.min(rows.length, 10); i++) {
    if (rows[i].some((c) => String(c || '').trim().toLowerCase() === 'customer')) {
      headerIdx = i;
      break;
    }
  }
  if (headerIdx < 0) throw new Error('parseArrearsXls: no header row with Customer column');
  const header = rows[headerIdx].map((c) => String(c || '').trim().toLowerCase());
  const col = (name) => header.indexOf(name);
  const ci = { date: col('date'), type: col('type'), no: col('no.') >= 0 ? col('no.') : col('no'), customer: col('customer'), memo: col('memo'), balance: col('balance'), amount: col('amount'), status: col('status') };
  const out = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r.length || r.every((c) => String(c).trim() === '')) continue;
    const get = (idx) => (idx >= 0 ? r[idx] : '');
    const customer = String(get(ci.customer) || '').trim();
    if (!customer) continue;
    out.push({
      date: String(get(ci.date) || '').trim(),
      type: String(get(ci.type) || 'Invoice').trim(),
      no: String(get(ci.no) || '').trim(),
      customer,
      memo: String(get(ci.memo) || '').trim(),
      balance: Number(get(ci.balance) || 0) || 0,
      amount: Number(get(ci.amount) || 0) || 0,
      status: String(get(ci.status) || 'overdue').trim(),
    });
  }
  return out;
}

/**
 * POST the xls to m6pm's existing /api/generate-debt-reports endpoint.
 * Returns m6pm's JSON response. Times out after 5 min — debt-report
 * generation against 14k+ invoices typically takes 1-3 min.
 *
 * modeLabel doubles as the report_mode form field — m6pm tags filenames
 * "{agent}_{date}__{mode}.xlsx" so each fire keeps its own frozen snapshot
 * on the persistent disk (since 2026-06-27 mode segmentation).
 */
async function postArrearsToM6pm(xlsBuffer, modeLabel) {
  const form = new FormData();
  form.append('file', new Blob([xlsBuffer]), `brain-arrears-${modeLabel}.xls`);
  if (modeLabel) form.append('report_mode', modeLabel);
  const r = await fetch(`${M6PM_BASE}/api/generate-debt-reports`, {
    method: 'POST',
    body: form,
    // m6pm sits behind Cloudflare with bot detection — server-to-server fetches
    // without browser-like headers get bounced with Cloudflare code 1010
    // (browser-signature ban). These headers mimic a real Chrome request just
    // enough to pass.
    headers: m6pmBrowserHeaders(),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`m6pm /api/generate-debt-reports ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * POST both morning + evening xls to m6pm's /api/generate-comparison-reports.
 * m6pm diffs them into per-agent comparison files (Morning Amount vs Evening
 * Amount) so officers can see what each customer paid that day.
 *
 * modeLabel is forwarded as report_mode form field so m6pm tags files
 * "{agent}_{date}__{mode}.xlsx" (no COMPARISON_ prefix), keeping the
 * mode-locked-link mechanism uniform with debt reports.
 */
async function postComparisonToM6pm(morningXls, eveningXls, modeLabel) {
  const form = new FormData();
  form.append('morning', new Blob([morningXls]), 'brain-morning.xls');
  form.append('evening', new Blob([eveningXls]), 'brain-evening.xls');
  if (modeLabel) form.append('report_mode', modeLabel);
  const r = await fetch(`${M6PM_BASE}/api/generate-comparison-reports`, {
    method: 'POST',
    body: form,
    headers: m6pmBrowserHeaders(),
    signal: AbortSignal.timeout(10 * 60_000),  // comparison parses 2× xls + builds diff
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`m6pm /api/generate-comparison-reports ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Browser-fingerprint headers for Cloudflare bypass. Cloudflare's "code 1010"
 * banning kicks in when User-Agent looks like a known bot library (node,
 * python-requests, curl). Sending a real-Chrome UA gets us past the default
 * rule. Long-term: whitelist BRAIN's outbound IP in Cloudflare's allow list.
 */
function m6pmBrowserHeaders() {
  return {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/149.0.0.0 Safari/537.36',
    'Accept': '*/*',
    'Accept-Language': 'en-US,en;q=0.9',
    'Origin': M6PM_BASE,
    'Referer': `${M6PM_BASE}/`,
  };
}

/**
 * Trigger m6pm's /api/sync-mobile. This pushes the latest invoice/customer
 * state to officers' phones. CRITICAL: called ONCE per day max — see
 * morningGateAcquired() guard.
 */
async function postSyncMobile() {
  const r = await fetch(`${M6PM_BASE}/api/sync-mobile`, {
    method: 'POST',
    headers: m6pmBrowserHeaders(),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`m6pm /api/sync-mobile ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Once-a-day morning gate. Atomically claims today's morning slot in
 * app_settings — only the first caller succeeds. Returns true if THIS
 * call acquired the gate (caller proceeds with sync + SMS), false if
 * another caller already did it today (caller skips).
 *
 * Stored as app_settings.m6pm_morning_done_ymd = "YYYY-MM-DD".
 */
async function morningGateAcquired(pool, todayYmdEat) {
  const key = 'm6pm_morning_done_ymd';
  const r = await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_at = now()
         WHERE app_settings.value <> EXCLUDED.value
       RETURNING value`,
    [key, todayYmdEat],
  );
  // If the conditional UPDATE was a no-op (already set to today), no row is
  // returned by RETURNING. That means someone else already did it.
  return r.rows.length > 0;
}

/**
 * Compute today's YMD in EAT. EAT is UTC+3 always (no DST in Tanzania).
 */
function todayYmdEat() {
  const eatMs = Date.now() + 3 * 60 * 60 * 1000;
  return new Date(eatMs).toISOString().slice(0, 10);
}

/**
 * Express mount: HTTP endpoints + the tick-finalize trigger hook.
 *
 * Endpoints:
 *   GET  /api/admin/m6pm/arrears-xls           - download the QB-format xls
 *   POST /api/admin/m6pm/trigger?mode=morning  - manual fire (morning/afternoon/evening)
 *   GET  /api/admin/m6pm/morning-gate-state    - inspect the once-a-day flag
 *   POST /api/admin/m6pm/morning-gate-reset    - clear the flag (for testing)
 */
export function mountM6pmApi(app, { requireSecretOrJwt, sharedSecret, pool }) {
  app.get('/api/admin/m6pm/arrears-xls', requireSecretOrJwt, async (req, res) => {
    try {
      const asOf = (req.query.asOf || '').toString() || undefined;
      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      const arrears = await fetchAllArrears({ asOf, brainSelfBase, sharedSecret });
      const buf = buildArrearsXls(arrears, asOf);
      res.type('application/vnd.ms-excel');
      res.setHeader('Content-Disposition', `attachment; filename="brain-arrears-${asOf || todayYmdEat()}.xls"`);
      res.send(buf);
    } catch (err) {
      console.error('[m6pm/arrears-xls]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/m6pm/trigger', requireSecretOrJwt, async (req, res) => {
    try {
      let mode = String(req.query.mode || req.body?.mode || '').toLowerCase();
      // Backward compat: accept legacy 'afternoon' as alias for 'noon' so any
      // existing scripts / curls from before the 2026-06-27 rename still work.
      if (mode === 'afternoon') mode = 'noon';
      if (!['morning', 'noon', 'evening', 'heisenberg'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be morning, noon, evening, or heisenberg' });
      }
      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      // Optional ?includeToday=true escape hatch for debugging; defaults to
      // the same excludeToday=true the production autofire path uses so this
      // /trigger endpoint reproduces what officers will actually see.
      const includeToday = req.query.includeToday === '1' || req.query.includeToday === 'true';
      const arrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: !includeToday });
      const buf = buildArrearsXls(arrears, null);
      const m6pmReports = await postArrearsToM6pm(buf, mode);
      const result = {
        mode,
        excludeToday: !includeToday,
        arrears_count: arrears.length,
        m6pm_reports: m6pmReports,
        sync_mobile: null,
      };
      // SAFETY: the manual /trigger endpoint NEVER fires sync-mobile, even
      // for mode=morning. Frank 2026-06-25: each sync-mobile re-fire WIPES
      // officers' in-progress work. Sync-mobile only fires from the auto
      // path (post-meru0100 hook in production), gated by morningGateAcquired().
      // Manual /trigger is for testing report generation in isolation.
      if (mode === 'morning') {
        result.sync_mobile = '(SKIPPED — manual /trigger never syncs mobile; auto path only)';
        result.morning_gate = '(not touched by manual /trigger)';
      }
      res.json(result);
    } catch (err) {
      console.error('[m6pm/trigger]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/m6pm/morning-gate-state', requireSecretOrJwt, async (_req, res) => {
    const r = await pool.query(
      `SELECT value, updated_at FROM app_settings WHERE key = 'm6pm_morning_done_ymd'`,
    );
    res.json({
      morning_done_ymd: r.rows[0]?.value || null,
      updated_at: r.rows[0]?.updated_at || null,
      today_eat: todayYmdEat(),
    });
  });

  // Seed today's morning_arrears so the kili1615 evening comparison has a
  // real start-of-day baseline. Used when the 05:00 EAT autofire didn't
  // happen (e.g. before mode-segmentation existed) and operator has the
  // morning export.
  //
  // Two accepted shapes:
  //   1. JSON body: {arrears: [{date,type,no,customer,memo,balance,amount,status}, ...], date?: "YYYY-MM-DD"}
  //   2. JSON body: {xls_b64: "...", date?: "YYYY-MM-DD"} — server parses xls
  //
  // Either way the arrears JSON gets persisted in app_settings under
  // morning_arrears:${date}. The kili1615 watcher reads from there.
  app.post('/api/admin/m6pm/seed-morning-arrears', requireSecretOrJwt, async (req, res) => {
    try {
      let arrears;
      if (Array.isArray(req.body?.arrears)) {
        arrears = req.body.arrears;
      } else if (typeof req.body?.xls_b64 === 'string' && req.body.xls_b64.length > 0) {
        const buf = Buffer.from(req.body.xls_b64, 'base64');
        arrears = parseArrearsXls(buf);
      } else {
        return res.status(400).json({
          error: 'POST JSON with either {arrears:[...]} or {xls_b64:"..."}',
        });
      }
      const ymd = (req.body?.date || req.query.date || todayYmdEat()).toString();
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [`morning_arrears:${ymd}`, JSON.stringify(arrears)],
      );
      const totalBalance = arrears.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      res.json({
        ok: true,
        date: ymd,
        rows: arrears.length,
        total_balance: totalBalance,
        message: `morning_arrears:${ymd} seeded — kili1615 evening comparison will use this baseline`,
      });
    } catch (err) {
      console.error('[m6pm/seed-morning-arrears]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Worker self-report: the eleganskyCrdb statement-pull worker POSTs
  // here at the end of each tick run with what it believes it did. The
  // tick-result watcher reads this BEFORE deciding to fire any SMS so a
  // transient BRAIN restart that ate a batch row doesn't read as a tick
  // failure to admins (Frank 2026-06-28 — boss-watches-the-SMS rule).
  //
  // Body shape (all fields optional except tick + status):
  //   {
  //     tick: "loolmalas1000",
  //     status: "ok" | "fail",
  //     rows_seen?: number,        // rows the worker saw on the sheets
  //     channels?: {               // per-channel outcome
  //       nmbnew: "ok"|"fail"|"skip",
  //       bank: "ok"|"fail"|"skip",
  //       iphone_bank: "ok"|"fail"|"skip"
  //     },
  //     reason?: string,           // short error reason when status=fail
  //     finalized_at?: ISO8601
  //   }
  app.post('/api/admin/tick-outcome', requireSecretOrJwt, async (req, res) => {
    try {
      const body = req.body || {};
      const tick = String(body.tick || '').trim();
      const status = String(body.status || '').trim();
      if (!tick) return res.status(400).json({ error: 'tick required' });
      if (!['ok', 'fail'].includes(status)) {
        return res.status(400).json({ error: 'status must be ok or fail' });
      }
      const ymd = todayYmdEat();
      const payload = JSON.stringify({
        tick,
        status,
        rows_seen: Number.isFinite(Number(body.rows_seen)) ? Number(body.rows_seen) : null,
        channels: body.channels && typeof body.channels === 'object' ? body.channels : null,
        reason: body.reason ? String(body.reason).slice(0, 200) : null,
        finalized_at: body.finalized_at ? String(body.finalized_at) : new Date().toISOString(),
      });
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [`tick_outcome:${ymd}:${tick}`, payload],
      );
      res.json({ ok: true, key: `tick_outcome:${ymd}:${tick}` });
    } catch (err) {
      console.error('[tick-outcome]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/m6pm/morning-gate-reset', requireSecretOrJwt, async (_req, res) => {
    await pool.query(
      `DELETE FROM app_settings WHERE key = 'm6pm_morning_done_ymd'`,
    );
    res.json({ ok: true, message: 'morning gate cleared — next morning trigger will sync + notify' });
  });
}

// ────────────────────────────────────────────────────────────────────────────
// AUTO-FIRE WATCHERS
//
// Two crons running in the BRAIN process — both poll every 60s:
//
//   1. autoFireReportsWatcher — when a tick (meru0100 / lengai1230 / kili1615)
//      finalizes its batches, automatically fire m6pm /api/generate-debt-reports
//      with the right mode (morning / afternoon / evening). For MORNING only,
//      the once-a-day gate also triggers /api/sync-mobile so officers' phones
//      get the day's fresh invoice state ONCE per day.
//
//   2. pocFailureAlertWatcher — detects ticks that are >=20 min late with no
//      batches created. Tracks consecutive failures in app_settings. At 3 in
//      a row, sends an SMS to 255752900450 (the boss phone) so the operator
//      can check the POC/relay before the day's collection report goes out
//      with stale numbers.
// ────────────────────────────────────────────────────────────────────────────

// Frank 2026-06-27 redesign: each MODE is gated separately and has a
// failover chain of trigger ticks. The first ticks's finalize "arms" the
// morning report (yesterday is fully closed because meru0100 catches up
// kibo2100→00:00 EAT overnight tail), but the actual report fire is held
// until minHourEat to avoid SMSing admins at 01:10 AM. If the first tick
// fails (NMB POC dies — common pattern), subsequent ticks in triggerTicks
// can still arm the morning fire. The per-mode gate (m6pm_auto_fired:${ymd}:${mode})
// ensures the report fires exactly once per day across all trigger ticks.
//
// kili1615 fires a COMPARISON report (morning vs evening debt), not another
// debt report — handled separately in fireKili1615Comparison() below.
const REPORT_MODES = {
  morning: {
    triggerTicks: ['meru0100', 'meru0300', 'hanang0700'],
    minHourEat: 5,  // Frank rule: hold delivery until 05:00 EAT
  },
  noon: {
    // Frank calls lengai1230 the "noon fire" (12:30 EAT). Internally was
    // "afternoon" up through 2026-06-27, renamed to match his vocabulary.
    triggerTicks: ['lengai1230'],
  },
};

// Heisenberg (manual catch-up) report cooldown. Frank fires heisenberg when a
// scrapper fails so he can recover. After ANY heisenberg-tagged batch
// finalizes, we re-fire the report + SMS — but skip if the last report (of
// any kind: scheduled morning/afternoon OR a previous heisenberg) was less
// than this long ago, so 5 rapid-fire heisenbergs don't spam admins.
const HEISENBERG_COOLDOWN_MS = 30 * 60 * 1000;

// All 9 scheduled ticks with EAT fire time (24h). Used by the failure
// watcher to know which ticks should have produced batches by now.
const TICK_SCHEDULE_EAT = [
  { tick: 'meru0100', hour: 1, min: 0 },
  { tick: 'meru0300', hour: 3, min: 0 },
  { tick: 'hanang0700', hour: 7, min: 0 },
  { tick: 'loolmalas1000', hour: 10, min: 0 },
  { tick: 'lengai1230', hour: 12, min: 30 },
  { tick: 'mawenzi1400', hour: 14, min: 0 },
  { tick: 'kili1615', hour: 16, min: 15 },
  { tick: 'kibo1900', hour: 19, min: 0 },
  { tick: 'kibo2100', hour: 21, min: 0 },
];

const POC_FAILURE_THRESHOLD = 3;
// Master admin = Frank's primary phone. Receives heartbeat-only alerts (15-min
// pre-tick phone-offline check, battery <50%). Broadcast alerts (upload
// success/error, 3-consec-failure) go to BROADCAST_PHONES instead.
const MASTER_ADMIN_PHONE = '255752900450';
// Default broadcast list mirrors m6pm's ADMIN_ALERT_NUMBERS (app.py:3536).
// Override via SMS_BROADCAST_PHONES env var (comma-separated).
const DEFAULT_BROADCAST_PHONES = [
  '255752900450', // CLIFORD DENIS MASUI
  '255719864511', // BIG BOWSSSS
  '255785422245', // MADAM HAPPY
  '255713123778', // FRANK MLAKI
];
function broadcastPhones() {
  const raw = (process.env.SMS_BROADCAST_PHONES || '').trim();
  if (!raw) return DEFAULT_BROADCAST_PHONES;
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}
const FAILURE_GRACE_MIN = 20; // wait 20 min after scheduled tick before declaring failure
const HEARTBEAT_PRE_TICK_MIN = 15; // pre-tick phone-online check
const HEARTBEAT_STALE_MIN = 5; // heartbeat older than this = phone offline
const BATTERY_ALERT_THRESHOLD = 50; // SMS Frank if battery drops below this
const NEXTSMS_API = 'https://messaging-service.co.tz/api/sms/v1/text/single';

/**
 * Send a one-shot SMS via NextSMS. Requires NEXTSMS_USERNAME +
 * NEXTSMS_PASSWORD + NEXTSMS_SENDER_ID env vars (same credentials m6pm
 * uses — set them on BRAIN's Render service). Logs and swallows errors
 * so a watcher cron doesn't crash on transient SMS-gateway hiccups.
 */
async function sendNextSms(phone, text) {
  const user = process.env.NEXTSMS_USERNAME;
  const pass = process.env.NEXTSMS_PASSWORD;
  const sender = process.env.NEXTSMS_SENDER_ID || 'NEXTSMS';
  if (!user || !pass) {
    console.warn('[m6pm/sms] NEXTSMS_USERNAME/PASSWORD not set — skipping SMS');
    return { skipped: true, reason: 'no_credentials' };
  }
  try {
    const auth = Buffer.from(`${user}:${pass}`).toString('base64');
    const r = await fetch(NEXTSMS_API, {
      method: 'POST',
      headers: {
        'Authorization': `Basic ${auth}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ from: sender, to: phone, text }),
      signal: AbortSignal.timeout(30_000),
    });
    const body = await r.text();
    if (!r.ok) {
      console.error(`[m6pm/sms] NextSMS ${r.status}: ${body.slice(0, 200)}`);
      return { ok: false, status: r.status, body: body.slice(0, 200) };
    }
    console.log(`[m6pm/sms] sent to ${phone}: "${text.slice(0, 60)}..."`);
    return { ok: true };
  } catch (err) {
    console.error(`[m6pm/sms] threw:`, err.message);
    return { ok: false, error: err.message };
  }
}

/**
 * Watcher #1: scan finalized batches for the report-fire ticks and
 * trigger the m6pm flow if not already fired today.
 *
 * Sequence per trigger:
 *   1. fetchAllArrears (paginate /arrears for live invoice list)
 *   2. buildArrearsXls (QB-format .xls)
 *   3. postArrearsToM6pm (m6pm generates per-agent debt reports)
 *   4. (morning only, once-a-day) postSyncMobile → officers' phones refresh
 *
 * Idempotency: per-day-per-tick gate in app_settings prevents duplicate
 * fires even if multiple BRAIN processes are running.
 */
async function autoFireReportsWatcher({ pool, sharedSecret, brainSelfBase }) {
  if (process.env.M6PM_AUTO_FIRE !== 'true') return;
  const today = todayYmdEat();
  const eatNow = new Date(Date.now() + 3 * 60 * 60 * 1000);
  const eatHour = eatNow.getUTCHours();

  for (const [mode, cfg] of Object.entries(REPORT_MODES)) {
    const gateKey = `m6pm_auto_fired:${today}:${mode}`;
    const gate = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [gateKey]);
    if (gate.rows.length) continue; // mode already fired today

    // Holdoff: even if a trigger tick has finalized batches, hold the report
    // fire until minHourEat EAT (so admins don't get an SMS at 01:10 AM).
    if (cfg.minHourEat != null && eatHour < cfg.minHourEat) continue;

    // Need at least one trigger tick to have finalized batches today (EAT day,
    // not 30-min window — the report should fire after 05:00 EAT even if
    // meru0100 finalized at 01:08 EAT, 4 hours earlier).
    const tickPatterns = cfg.triggerTicks.map((t) => `auto-upload:${t}%`);
    const recent = await pool.query(
      `SELECT created_by FROM payment_batches
        WHERE status = 'finalized'
          AND created_at >= (
            date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam')
            AT TIME ZONE 'Africa/Dar_es_Salaam'
          )
          AND created_by LIKE ANY ($1::text[])
        LIMIT 1`,
      [tickPatterns],
    );
    if (!recent.rows.length) continue;

    // Atomic gate acquire — only one BRAIN process wins per mode per day.
    const acquired = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, 'firing')
         ON CONFLICT (key) DO NOTHING
         RETURNING value`,
      [gateKey],
    );
    if (!acquired.rows.length) continue;

    const armingTick = (recent.rows[0].created_by || '').match(/auto-upload:([^:]+)/)?.[1] || '?';
    console.log(`[m6pm/autofire] mode=${mode} armed by ${armingTick} — starting report fire (eatHour=${eatHour})`);
    try {
      // excludeToday: officers' reports should match QB's "Overdue" status
      // filter (today's daily invoices not yet overdue). Payment app keeps
      // <= so today's invoices still get applied — that path doesn't go
      // through fetchAllArrears.
      const arrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
      const buf = buildArrearsXls(arrears, null);
      await postArrearsToM6pm(buf, mode);
      // Persist morning arrears JSON so the kili1615 evening comparison can
      // diff against the actual start-of-day baseline. Only saved on the
      // morning fire path. Stored as app_settings value (Postgres TEXT can
      // hold the ~3-5 MB JSON without trouble). Never miss a catchup brother.
      if (mode === 'morning') {
        try {
          await pool.query(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [`morning_arrears:${today}`, JSON.stringify(arrears)],
          );
          console.log(`[m6pm/autofire] morning arrears JSON saved (${arrears.length} rows) for evening comparison`);
        } catch (e) {
          console.error('[m6pm/autofire] failed to save morning_arrears:', e.message);
        }
      }
      let syncResult = null;
      if (mode === 'morning') {
        const got = await morningGateAcquired(pool, today);
        if (got) {
          try {
            syncResult = await postSyncMobile();
            console.log(`[m6pm/autofire] mode=${mode} sync-mobile fired (morning gate acquired)`);
          } catch (e) {
            console.error(`[m6pm/autofire] sync-mobile failed:`, e.message);
            syncResult = { error: e.message };
          }
        } else {
          syncResult = '(skipped — morning gate already claimed today)';
        }
      }
      // Mark fired (per-mode gate) AND update the global last-fire timestamp
      // so heisenberg cooldown sees scheduled fires too.
      await pool.query(
        `UPDATE app_settings SET value='done', updated_at=now() WHERE key=$1`,
        [gateKey],
      );
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('m6pm_last_report_fire_at', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [new Date().toISOString()],
      );
      console.log(`[m6pm/autofire] mode=${mode} DONE arrears=${arrears.length} sync=${syncResult ? 'fired' : 'n/a'}`);

      // SMS-with-link broadcast: send a public download link to all admins
      // so they (and anyone they forward it to) can grab the report file
      // without logging into m6pm. Signed token expires in 72h.
      // Link includes mode= so morning's link at noon still shows morning's
      // frozen files (Frank 2026-06-27 mode-segmentation requirement).
      const link = signedReportUrl({ path: 'page', date: today, name: '*', mode });
      if (link) {
        const modeLabel = mode === 'morning' ? 'Morning' : mode === 'noon' ? 'Noon' : 'Evening';
        const text = `BRAIN ${modeLabel} report (${today}) ready: ${link}`;
        for (const phone of broadcastPhones()) {
          await sendNextSms(phone, text);
        }
        console.log(`[m6pm/autofire] mode=${mode} SMSed report link to ${broadcastPhones().length} admins`);
      } else {
        console.warn(`[m6pm/autofire] mode=${mode} REPORT_LINK_SECRET unset — skipping SMS-with-link`);
      }
    } catch (err) {
      console.error(`[m6pm/autofire] mode=${mode} (armed by ${armingTick}) failed:`, err.message);
      // Roll back the gate so a later retry can pick it up.
      await pool.query(`DELETE FROM app_settings WHERE key=$1`, [gateKey]);
    }
  }

  // Heisenberg-triggered catch-up report. Fires whenever a heisenberg batch
  // finalises AND the last report (of any kind: scheduled morning/afternoon
  // OR a previous heisenberg) was >30 min ago. The cooldown stops rapid-fire
  // heisenbergs from spamming admins with 5 SMSes.
  await maybeFireHeisenbergReport({ pool, sharedSecret, brainSelfBase, today });
  await maybeFireEveningComparison({ pool, sharedSecret, brainSelfBase, today });
}

/**
 * Watcher: when kili1615 finalizes its batches, fire a MORNING vs EVENING
 * comparison report (not another plain debt report). Tonight's evening
 * SMS goes out only ONCE — the comparison shows officers what each
 * customer paid that day. No second evening debt report is sent.
 *
 * Source of morning baseline:
 *   1. Preferred: app_settings.morning_arrears:${date} (saved by autofire)
 *   2. Fallback: if no morning JSON, log + abort (so we never silently
 *      ship a "comparison" with garbage baseline)
 *
 * Sequence:
 *   1. Wait for kili1615 finalize today
 *   2. Per-day gate m6pm_evening_fired:${date}
 *   3. Read morning_arrears JSON, rebuild morning xls
 *   4. fetchAllArrears live → evening xls
 *   5. POST both to m6pm /api/generate-comparison-reports with
 *      report_mode=evening
 *   6. SMS evening link with &mode=evening
 */
async function maybeFireEveningComparison({ pool, sharedSecret, brainSelfBase, today }) {
  if (process.env.M6PM_AUTO_FIRE !== 'true') return;
  const gateKey = `m6pm_evening_fired:${today}`;
  const gate = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [gateKey]);
  if (gate.rows.length) return;

  // Need kili1615 batches finalized today (EAT day).
  const recent = await pool.query(
    `SELECT created_by FROM payment_batches
      WHERE status = 'finalized'
        AND created_at >= (
          date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam')
          AT TIME ZONE 'Africa/Dar_es_Salaam'
        )
        AND created_by LIKE 'auto-upload:kili1615%'
      LIMIT 1`,
  );
  if (!recent.rows.length) return;

  // Atomic claim
  const acquired = await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, 'firing')
       ON CONFLICT (key) DO NOTHING
       RETURNING value`,
    [gateKey],
  );
  if (!acquired.rows.length) return;

  console.log('[m6pm/autofire/evening] kili1615 finalized — building comparison');
  try {
    // Morning baseline — REQUIRED. Never ship a comparison with stale or
    // wrong baseline (Frank's rule 2026-06-27: "office could go mad").
    const morn = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [`morning_arrears:${today}`],
    );
    if (!morn.rows.length) {
      await pool.query(
        `UPDATE app_settings SET value='no_morning_baseline', updated_at=now() WHERE key=$1`,
        [gateKey],
      );
      console.error(`[m6pm/autofire/evening] NO morning baseline saved for ${today} — aborting`);
      const text = `BRAIN evening comparison ABORTED (${today}): no morning baseline. Seed it via /api/admin/m6pm/seed-morning-arrears.`;
      await sendNextSms(MASTER_ADMIN_PHONE, text);
      return;
    }
    const morningArrears = JSON.parse(morn.rows[0].value);
    const morningXls = buildArrearsXls(morningArrears, null);

    const eveningArrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
    const eveningXls = buildArrearsXls(eveningArrears, null);

    await postComparisonToM6pm(morningXls, eveningXls, 'evening');

    // Mark fired + bump last-fire so heisenberg cooldown sees it
    await pool.query(
      `UPDATE app_settings SET value='done', updated_at=now() WHERE key=$1`,
      [gateKey],
    );
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('m6pm_last_report_fire_at', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [new Date().toISOString()],
    );
    console.log(`[m6pm/autofire/evening] DONE morning=${morningArrears.length} evening=${eveningArrears.length}`);

    const link = signedReportUrl({ path: 'page', date: today, name: '*', mode: 'evening' });
    if (link) {
      const morningTotal = morningArrears.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      const eveningTotal = eveningArrears.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      const collected = morningTotal - eveningTotal;
      const fmt = (n) => Math.round(n).toLocaleString('en-US');
      const text =
        `BRAIN Evening comparison (${today}) ready.\n` +
        `Morning: ${fmt(morningTotal)} TZS\n` +
        `Evening: ${fmt(eveningTotal)} TZS\n` +
        `Collected: ${fmt(collected)} TZS\n${link}`;
      for (const phone of broadcastPhones()) {
        await sendNextSms(phone, text);
      }
      console.log(`[m6pm/autofire/evening] SMSed comparison link to ${broadcastPhones().length} admins`);
    }
  } catch (err) {
    console.error('[m6pm/autofire/evening] failed:', err.message);
    await pool.query(`DELETE FROM app_settings WHERE key=$1`, [gateKey]);
  }
}

async function maybeFireHeisenbergReport({ pool, sharedSecret, brainSelfBase, today }) {
  // Any heisenberg-tagged batch finalize in the last 5 min?
  const recent = await pool.query(
    `SELECT id FROM payment_batches
      WHERE created_by LIKE 'auto-upload:heisenberg%'
        AND status = 'finalized'
        AND finalized_at > now() - interval '5 minutes'
      LIMIT 1`,
  );
  if (!recent.rows.length) return;

  // Cooldown check — read last_fire_at and bail if within COOLDOWN.
  const lastRow = await pool.query(
    `SELECT value FROM app_settings WHERE key = 'm6pm_last_report_fire_at'`,
  );
  if (lastRow.rows.length) {
    const lastMs = new Date(lastRow.rows[0].value).getTime();
    const sinceMs = Date.now() - lastMs;
    if (sinceMs < HEISENBERG_COOLDOWN_MS) {
      const minLeft = Math.ceil((HEISENBERG_COOLDOWN_MS - sinceMs) / 60_000);
      console.log(`[m6pm/autofire/heisenberg] cooldown active (${minLeft}min left) — skip`);
      return;
    }
  }

  // Atomic claim: set last_fire_at to NOW BEFORE the fire so a concurrent
  // watcher tick sees the cooldown and bails. If the fire fails we leave
  // the timestamp set — operator can manually re-fire via /api/admin/m6pm/trigger.
  await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ('m6pm_last_report_fire_at', $1)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    [new Date().toISOString()],
  );

  console.log('[m6pm/autofire/heisenberg] cooldown clear — firing catch-up report');
  try {
    const arrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
    const buf = buildArrearsXls(arrears, null);
    // Heisenberg fires are manual catch-ups (Frank fires when a scrapper
    // fails). Tag with own 'heisenberg' mode so the on-disk file doesn't
    // overwrite the scheduled morning/noon frozen snapshots — admins can
    // still open the morning link later and see morning's numbers.
    await postArrearsToM6pm(buf, 'heisenberg');
    const link = signedReportUrl({ path: 'page', date: today, name: '*', mode: 'heisenberg' });
    if (link) {
      const text = `BRAIN catch-up report (${today}) ready: ${link}`;
      for (const phone of broadcastPhones()) {
        await sendNextSms(phone, text);
      }
      console.log(`[m6pm/autofire/heisenberg] DONE arrears=${arrears.length} SMSed ${broadcastPhones().length} admins`);
    }
  } catch (err) {
    console.error('[m6pm/autofire/heisenberg] failed:', err.message);
    // Don't roll back last_fire_at — operator can manually re-fire after
    // fixing whatever broke. Rolling back would cause an infinite retry
    // loop hitting m6pm/QB while the watcher runs every 60s.
  }
}

/**
 * Watcher #2: detect ticks that haven't produced batches by the
 * grace deadline and SMS the boss after 3 consecutive failures. Reset
 * the counter on any success.
 *
 * Stored in app_settings:
 *   m6pm_poc_consec_failures = "N" (count)
 *   m6pm_poc_last_alerted_ymd = "YYYY-MM-DD" (per-day SMS dedup)
 *   m6pm_poc_seen_ticks:${ymd} = comma-separated list of ticks we already
 *                                evaluated today (so we don't double-count)
 */
async function pocFailureAlertWatcher({ pool }) {
  if (process.env.M6PM_POC_ALERTS !== 'true') return;
  const today = todayYmdEat();
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const eatHr = eatNow.getUTCHours();
  const eatMin = eatNow.getUTCMinutes();

  const seenKey = `m6pm_poc_seen_ticks:${today}`;
  const seenRow = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [seenKey]);
  const seen = new Set((seenRow.rows[0]?.value || '').split(',').filter(Boolean));

  for (const { tick, hour, min } of TICK_SCHEDULE_EAT) {
    if (seen.has(tick)) continue;
    // Skip ticks not yet past the grace window.
    const minutesPastTick = (eatHr - hour) * 60 + (eatMin - min);
    if (minutesPastTick < FAILURE_GRACE_MIN) continue;

    // Did this tick produce ANY finalized batches today (EAT midnight,
    // not UTC midnight — earlier code used the wrong cast and missed
    // meru0100 batches that finalize between 01:00 and 03:00 EAT which
    // is "yesterday" in UTC).
    const ok = await pool.query(
      `SELECT id FROM payment_batches
        WHERE created_by LIKE $1
          AND status = 'finalized'
          AND created_at >= (
            date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam')
            AT TIME ZONE 'Africa/Dar_es_Salaam'
          )
        LIMIT 1`,
      [`auto-upload:${tick}%`],
    );

    const seenList = [...seen, tick].join(',');
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [seenKey, seenList],
    );
    seen.add(tick);

    if (ok.rows.length) {
      // Success → reset consecutive-failure counter.
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('m6pm_poc_consec_failures', '0')
           ON CONFLICT (key) DO UPDATE SET value='0', updated_at=now()`,
      );
      console.log(`[m6pm/poc-alert] ${tick} ✓ — reset failure counter`);
      continue;
    }

    // Failure — increment counter atomically.
    const inc = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('m6pm_poc_consec_failures', '1')
         ON CONFLICT (key) DO UPDATE
           SET value = (COALESCE(app_settings.value, '0')::int + 1)::text,
               updated_at = now()
         RETURNING value`,
    );
    const failures = parseInt(inc.rows[0].value, 10);
    console.warn(`[m6pm/poc-alert] ${tick} ❌ — consecutive failures: ${failures}`);

    if (failures >= POC_FAILURE_THRESHOLD) {
      // Per-day dedup so we don't spam the boss with one SMS per tick.
      const alertedKey = 'm6pm_poc_last_alerted_ymd';
      const alerted = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [alertedKey]);
      if (alerted.rows[0]?.value === today) {
        console.log(`[m6pm/poc-alert] already alerted today — skipping`);
        continue;
      }
      const text = `BRAIN: ${failures} consecutive scheduled-tick failures today (${today}). Latest fail: ${tick}. Check POC/relay/phone.`;
      // Broadcast — same list m6pm uses for completion alerts (ADMIN_ALERT_NUMBERS).
      for (const phone of broadcastPhones()) {
        await sendNextSms(phone, text);
      }
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [alertedKey, today],
      );
    }
  }
}

/**
 * Watcher #3: per-tick result SMS to 255752900450. After each scheduled
 * tick's first batches finalize, send ONE SMS summarising paid count +
 * TZS per channel. If no batches by grace deadline (+20 min from tick),
 * send an error SMS instead. Per-tick-per-day dedup so Frank gets exactly
 * one SMS per tick. Env-gated TICK_RESULT_SMS=true.
 *
 * Stored in app_settings:
 *   m6pm_tick_notif:${ymd}:${tick} = "ok" | "err" (mark so we don't re-SMS)
 */
/**
 * Inspect each upstream subsystem and return ONLY the names of the ones
 * that look stale RIGHT NOW. Empty array = all healthy.
 *
 * Frank 2026-06-28: stops the misleading blanket "POC/scrapers/phone"
 * blame in tick-failure SMS — only name a subsystem when its own state
 * timestamps say it's actually stuck.
 *
 * Thresholds match the operational rule of thumb each subsystem already
 * uses elsewhere:
 *   - POC stale  → no successful nmb-pull cycle in 10 min
 *   - phone stale → no heartbeat in 5 min (matches HEARTBEAT_STALE_MIN)
 *
 * Doesn't check the local CRDB / iPhone scrapers because they have no
 * heartbeat row to read; their failure mode is the worker's own log.
 */
async function detectStaleSubsystems(pool) {
  const hints = [];
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = 'nmb_pull_last_ok_completed_at'`,
    );
    const lastOk = r.rows[0]?.value;
    if (lastOk) {
      const ageMin = (Date.now() - new Date(lastOk).getTime()) / 60_000;
      if (ageMin > 10) hints.push(`POC (${Math.floor(ageMin)}m)`);
    } else {
      hints.push('POC (never)');
    }
  } catch (_) { /* ignore — diagnostic SMS shouldn't crash on probe errors */ }
  try {
    const r = await pool.query(
      `SELECT seen_at FROM phone_heartbeats ORDER BY seen_at DESC LIMIT 1`,
    );
    const last = r.rows[0]?.seen_at;
    if (!last) {
      hints.push('phone (never)');
    } else {
      const ageMin = (Date.now() - new Date(last).getTime()) / 60_000;
      if (ageMin > HEARTBEAT_STALE_MIN) hints.push(`phone (${Math.floor(ageMin)}m)`);
    }
  } catch (_) { /* table may not exist yet on first boot — ignore */ }
  return hints;
}

/**
 * Read the worker's self-reported outcome for a tick, if any.
 *
 * The eleganskyCrdb statement-pull worker POSTs to BRAIN's
 * /api/admin/tick-outcome at the end of each tick run with what it
 * believes it did. We store it under app_settings.tick_outcome:<ymd>:<tick>
 * as a small JSON. Watcher reads it BEFORE deciding to fire any SMS so
 * a transient BRAIN restart that ate the batch row doesn't get reported
 * as a tick failure to admins.
 *
 * Returns the parsed outcome, or null when the worker hasn't reported.
 * Legacy worker (pre-2026-06-28) doesn't POST outcomes — watcher then
 * falls back to the row-based behavior (compatible mode).
 */
async function readWorkerOutcome(pool, today, tick) {
  try {
    const r = await pool.query(
      `SELECT value FROM app_settings WHERE key = $1`,
      [`tick_outcome:${today}:${tick}`],
    );
    const raw = r.rows[0]?.value;
    if (!raw) return null;
    return JSON.parse(raw);
  } catch (_) {
    return null;
  }
}

async function tickResultNotifierWatcher({ pool }) {
  if (process.env.TICK_RESULT_SMS !== 'true') return;
  const today = todayYmdEat();
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const eatHr = eatNow.getUTCHours();
  const eatMin = eatNow.getUTCMinutes();

  for (const { tick, hour, min } of TICK_SCHEDULE_EAT) {
    const notifKey = `m6pm_tick_notif:${today}:${tick}`;
    const already = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [notifKey]);
    if (already.rows.length) continue;

    const minutesPastTick = (eatHr - hour) * 60 + (eatMin - min);
    // Hold off until the tick has had time to start (5 min after fire).
    // Reasoning: 4-5 min for scrapers + arrears + push to QB.
    if (minutesPastTick < 5) continue;

    // Roll up paid + unused per channel for this tick today (EAT day).
    const stats = await pool.query(
      `SELECT channel,
              COALESCE(SUM(paid_count), 0)::int   AS paid_count,
              COALESCE(SUM(paid_total), 0)::numeric AS paid_total,
              COALESCE(SUM(unused_count), 0)::int AS unused_count,
              MAX(finalized_at)                   AS last_finalized
         FROM payment_batches
        WHERE created_by LIKE $1
          AND status = 'finalized'
          AND created_at >= (
            date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam')
            AT TIME ZONE 'Africa/Dar_es_Salaam'
          )
        GROUP BY channel
        ORDER BY channel`,
      [`auto-upload:${tick}%`],
    );

    // Pull worker outcome BEFORE the atomic claim. Watcher decisions
    // below depend on the {worker says, DB shows} combo, not just DB.
    const outcome = await readWorkerOutcome(pool, today, tick);

    // Atomic claim — only one BRAIN process sends the SMS.
    const claim = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, 'sending')
         ON CONFLICT (key) DO NOTHING RETURNING value`,
      [notifKey],
    );
    if (!claim.rows.length) continue;

    let text;
    let resultLabel;
    if (stats.rows.length === 0) {
      // No finalized batches yet. Decision tree distinguishes the
      // three cases that all used to fire the same "no batches" SMS:
      //   A. Worker reported ok with rows_seen>0 but DB empty
      //      → transient persistence (e.g. BRAIN restart during fire).
      //         SILENT log; admins do not see panic SMS for our problem.
      //   B. Worker reported ok with rows_seen=0
      //      → no transactions in the window. Legitimate "ok empty".
      //         Send INFO SMS without blaming any subsystem.
      //   C. Worker reported fail (or no outcome and past grace)
      //      → real failure. SMS with the specific subsystem hints.
      if (outcome?.status === 'ok') {
        const rowsSeen = Number(outcome.rows_seen || 0);
        if (rowsSeen > 0) {
          // Case A — silent
          await pool.query(
            `UPDATE app_settings SET value='ok_persistence_drift', updated_at=now() WHERE key=$1`,
            [notifKey],
          );
          console.log(`[m6pm/tick-notif] ${tick} worker says ok rows=${rowsSeen} but DB empty — silent log (transient persistence)`);
          continue;
        }
        // Case B — informational
        text = `BRAIN ${tick} ✓ no transactions in window`;
        resultLabel = 'ok_empty';
      } else {
        // Case C
        if (minutesPastTick < FAILURE_GRACE_MIN) {
          await pool.query(`DELETE FROM app_settings WHERE key=$1`, [notifKey]);
          continue;
        }
      // Frank 2026-06-28: build the suggestion clause from ACTUAL subsystem
      // health checks instead of the blanket "POC/scrapers/phone" blame.
      // Only name a subsystem when its own state says it is stale. Avoids
      // misleading messages (e.g. "check POC" when POC is fine).
      const hints = await detectStaleSubsystems(pool);
      // Prefer the worker's own error reason when it reported one.
      const workerReason = outcome?.status === 'fail' && outcome.reason
        ? ` — worker: ${String(outcome.reason).slice(0, 80)}`
        : '';
      text = hints.length
        ? `BRAIN ${tick} ✗ no batches by +${FAILURE_GRACE_MIN}min — ${hints.join(' + ')} stale${workerReason}`
        : `BRAIN ${tick} ✗ no batches by +${FAILURE_GRACE_MIN}min${workerReason || ' — all subsystems look healthy, investigate worker logs'}`;
      resultLabel = 'err';
      }
    } else {
      const parts = stats.rows.map((r) => {
        const ch = r.channel === 'nmbnew' ? 'NMB'
                 : r.channel === 'bank' ? 'Bnk'
                 : r.channel === 'iphone_bank' ? 'Iph'
                 : r.channel;
        const tzs = Number(r.paid_total) || 0;
        const tzsStr = tzs >= 1_000_000
          ? `${(tzs / 1_000_000).toFixed(2)}M`
          : tzs >= 1_000
          ? `${(tzs / 1_000).toFixed(0)}k`
          : String(tzs);
        return `${ch} ${r.paid_count}p/${tzsStr}`;
      });
      text = `BRAIN ${tick} ✓ ${parts.join(' ')}`;
      resultLabel = 'ok';
    }

    // Broadcast to the full alert list — every tick result (success or
    // error) reaches all admins, matching m6pm's send-notification flow.
    let anyFailed = false;
    for (const phone of broadcastPhones()) {
      const r = await sendNextSms(phone, text);
      if (r.ok === false) anyFailed = true;
    }
    await pool.query(
      `UPDATE app_settings SET value=$2, updated_at=now() WHERE key=$1`,
      [notifKey, resultLabel + (anyFailed ? ':sms_partial' : '')],
    );
    console.log(`[m6pm/tick-notif] ${tick} → ${resultLabel} sms="${text}"`);
  }
}

/**
 * Watcher #4: phone heartbeat — 15 min before every scheduled tick, check
 * the phone_heartbeats table. If no fresh entry (<5 min old) → phone is
 * offline → SMS Frank ONLY (master admin). Also alert Frank ONCE per day
 * when battery drops below 50% so he can plug it in before a tick fires.
 *
 * Per-tick-per-day dedup (offline alert) + per-day dedup (battery alert).
 * The phone-side APK is OWED separately (Frank's plan) — until it POSTs
 * to /api/phone/heartbeat, the table is empty and this watcher correctly
 * surfaces the gap to the master admin before every tick.
 *
 * Stored in app_settings:
 *   m6pm_phone_offline:${ymd}:${tick} = "alerted"
 *   m6pm_phone_battery_alerted_ymd    = "YYYY-MM-DD"
 */
async function phoneHeartbeatWatcher({ pool }) {
  if (process.env.PHONE_HEARTBEAT_ALERTS !== 'true') return;
  const today = todayYmdEat();
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const eatHr = eatNow.getUTCHours();
  const eatMin = eatNow.getUTCMinutes();
  const eatTotalMin = eatHr * 60 + eatMin;

  // Ensure the table exists before querying. Phone APK creates it on first
  // POST too — making it idempotent here means the watcher works cleanly
  // even before the APK has ever checked in (just always flags "offline").
  await pool.query(
    `CREATE TABLE IF NOT EXISTS phone_heartbeats (
       id BIGSERIAL PRIMARY KEY,
       phone TEXT NOT NULL,
       battery_pct INT,
       received_at TIMESTAMPTZ NOT NULL DEFAULT now()
     )`,
  );

  // Find heartbeats for the master admin phone in last HEARTBEAT_STALE_MIN.
  const hb = await pool.query(
    `SELECT battery_pct, received_at
       FROM phone_heartbeats
      WHERE phone = $1
        AND received_at >= now() - ($2 || ' minutes')::interval
      ORDER BY received_at DESC LIMIT 1`,
    [MASTER_ADMIN_PHONE, String(HEARTBEAT_STALE_MIN)],
  );
  const phoneOnline = hb.rows.length > 0;
  const batteryPct = hb.rows[0]?.battery_pct ?? null;

  // 1. Pre-tick offline check: 15 min before each scheduled tick.
  for (const { tick, hour, min } of TICK_SCHEDULE_EAT) {
    const tickTotalMin = hour * 60 + min;
    const minutesUntilTick = tickTotalMin - eatTotalMin;
    // Window: between T-15 and T+0. After T+0 the failure watcher takes over.
    if (minutesUntilTick > HEARTBEAT_PRE_TICK_MIN || minutesUntilTick < 0) continue;
    if (phoneOnline) continue; // good — no alert needed

    const offKey = `m6pm_phone_offline:${today}:${tick}`;
    const claimed = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, 'alerted')
         ON CONFLICT (key) DO NOTHING RETURNING value`,
      [offKey],
    );
    if (!claimed.rows.length) continue;
    const text = `BRAIN: phone 255752900450 offline ${minutesUntilTick}min before ${tick}. OTP relay will fail — bring phone online.`;
    await sendNextSms(MASTER_ADMIN_PHONE, text);
    console.warn(`[m6pm/phone-hb] offline alert sent for ${tick} (T-${minutesUntilTick}min)`);
  }

  // 2. Battery low — once per day, only if phone is online and reporting.
  if (phoneOnline && typeof batteryPct === 'number' && batteryPct < BATTERY_ALERT_THRESHOLD) {
    const batKey = 'm6pm_phone_battery_alerted_ymd';
    const last = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [batKey]);
    if (last.rows[0]?.value !== today) {
      const text = `BRAIN: phone 255752900450 battery at ${batteryPct}% — plug in before next tick.`;
      await sendNextSms(MASTER_ADMIN_PHONE, text);
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [batKey, today],
      );
      console.warn(`[m6pm/phone-hb] battery alert sent (${batteryPct}%)`);
    }
  }
}

/**
 * Start all four watchers on BRAIN boot. Each runs every 60s. They're
 * best-effort — exceptions are caught and logged so a watcher hiccup
 * never crashes BRAIN.
 */
export function startM6pmWatchers({ pool, sharedSecret, brainBase }) {
  let running = false;
  const tick = async () => {
    if (running) return; // prevent overlap if a prior cycle is still in flight
    running = true;
    try {
      try { await autoFireReportsWatcher({ pool, sharedSecret, brainSelfBase: brainBase }); }
      catch (err) { console.error('[m6pm/autofire watcher]', err.message); }
      try { await pocFailureAlertWatcher({ pool }); }
      catch (err) { console.error('[m6pm/poc-alert watcher]', err.message); }
      try { await tickResultNotifierWatcher({ pool }); }
      catch (err) { console.error('[m6pm/tick-notif watcher]', err.message); }
      try { await phoneHeartbeatWatcher({ pool }); }
      catch (err) { console.error('[m6pm/phone-hb watcher]', err.message); }
    } finally {
      running = false;
    }
  };
  // setInterval only — earlier code also called setTimeout(tick, 60_000) which
  // raced with the interval's first tick, causing double-counts in the
  // POC-alert watcher. Single setInterval = one run per 60s, no race.
  setInterval(tick, 60_000);
  console.log('[m6pm/watchers] auto-fire + POC-alert + tick-notif + phone-hb watchers armed (60s, no overlap)');
}
