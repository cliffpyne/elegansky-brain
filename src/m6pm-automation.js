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
async function postSyncMobile(xlsBuffer) {
  // Frank 2026-06-28: send the morning xls as multipart so m6pm parses it
  // INLINE and doesn't depend on in-memory session state. Makes the call
  // safe after any m6pm restart and removes the "session gone" fragility.
  // When xlsBuffer is omitted (e.g. legacy callers), m6pm falls back to
  // the session path — original behavior preserved.
  const form = new FormData();
  if (xlsBuffer) form.append('file', new Blob([xlsBuffer]), 'brain-morning-arrears.xls');
  const r = await fetch(`${M6PM_BASE}/api/sync-mobile`, {
    method: 'POST',
    headers: xlsBuffer
      ? m6pmBrowserHeaders()  // FormData sets its own Content-Type with boundary
      : { ...m6pmBrowserHeaders(), 'Content-Type': 'application/json' },
    body: xlsBuffer ? form : JSON.stringify({}),
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`m6pm /api/sync-mobile ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

/**
 * Trigger m6pm's /api/autofire/send-overdue-sms — the customer-overdue
 * SMS dispatch (the SEND NOTIFICATION tab automated). Posts the morning
 * arrears xls; m6pm internally filters to yesterday's unpaid balances,
 * looks up phones via pikipiki, queues + dispatches via NextSMS, and
 * SMSes admins when the batch completes.
 *
 * Frank 2026-06-28: this is the 3rd leg of the morning ritual after
 * report generation and sync-mobile. Must run ONCE per day, in that order.
 */
async function postSendOverdueSms(xlsBuffer, { dryRun = false } = {}) {
  const form = new FormData();
  form.append('file', new Blob([xlsBuffer]), 'brain-morning-overdue.xls');
  const url = `${M6PM_BASE}/api/autofire/send-overdue-sms${dryRun ? '?dry_run=1' : ''}`;
  const r = await fetch(url, {
    method: 'POST',
    body: form,
    headers: {
      ...m6pmBrowserHeaders(),
      'X-Report-Secret': process.env.STATEMENT_REPORT_SECRET || '',
    },
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`m6pm /api/autofire/send-overdue-sms ${r.status}: ${text.slice(0, 300)}`);
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
      if (mode === 'afternoon') mode = 'noon';
      if (!['morning', 'noon', 'evening', 'heisenberg'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be morning, noon, evening, or heisenberg' });
      }
      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      const includeToday = req.query.includeToday === '1' || req.query.includeToday === 'true';
      // Frank 2026-06-29: rescue flags after /arrears outage left officers
      // waiting on the morning link. source=cache reads the morning_arrears
      // snapshot the autofire already captured at 05:01 EAT so we can keep
      // moving when /arrears is down. fire_all=1 lets a manual trigger
      // chain sync-mobile + send-overdue-sms (the third leg of the morning
      // ritual that normally only the auto path runs).
      const source = String(req.query.source || '').toLowerCase();
      const fireAll = req.query.fire_all === '1' || req.query.fire_all === 'true';
      let arrears;
      let arrearsSource = 'live';
      if (source === 'cache') {
        const ymd = todayYmdEat();
        const r = await pool.query(
          `SELECT value FROM app_settings WHERE key = $1`, [`morning_arrears:${ymd}`]);
        if (!r.rows[0]?.value) {
          return res.status(404).json({ error: `no morning_arrears:${ymd} cache — autofire didn't run yet today` });
        }
        try { arrears = JSON.parse(r.rows[0].value); }
        catch (e) { return res.status(500).json({ error: `cache parse failed: ${e.message}` }); }
        arrearsSource = `cache(morning_arrears:${ymd})`;
      } else {
        arrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: !includeToday });
      }
      const buf = buildArrearsXls(arrears, null);
      const m6pmReports = await postArrearsToM6pm(buf, mode);
      const result = {
        mode,
        arrears_source: arrearsSource,
        excludeToday: !includeToday,
        arrears_count: arrears.length,
        m6pm_reports: m6pmReports,
        sync_mobile: null,
        send_overdue_sms: null,
      };
      // Chain sync-mobile + send-overdue-sms when fire_all=1 (operator
      // override for recovery; sync-mobile wipes officer in-progress so
      // ONLY fire when you mean it).
      const skipSms = req.query.skip_overdue_sms === '1' || req.query.skip_overdue_sms === 'true';
      if (mode === 'morning' && fireAll) {
        try {
          result.sync_mobile = await postSyncMobile(buf);
        } catch (e) {
          result.sync_mobile = { error: String(e.message || e).slice(0, 400) };
        }
        if (skipSms) {
          result.send_overdue_sms = '(SKIPPED — skip_overdue_sms=1)';
        } else {
          try {
            result.send_overdue_sms = await postSendOverdueSms(buf, { dryRun: false });
          } catch (e) {
            result.send_overdue_sms = { error: String(e.message || e).slice(0, 400) };
          }
        }
      } else if (mode === 'morning') {
        result.sync_mobile = '(SKIPPED — pass ?fire_all=1 to chain sync-mobile + send-overdue-sms)';
        result.send_overdue_sms = '(SKIPPED — pass ?fire_all=1 to chain)';
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

  // Dashboard-friendly wrapper: fetch live arrears via fetchAllArrears +
  // seed morning_arrears:<today>. Frank 2026-07-15: dashboard button so
  // an operator can seed the baseline mid-morning without paginating
  // /arrears in the browser.
  app.post('/api/admin/m6pm/save-morning-snapshot-now', requireSecretOrJwt, async (req, res) => {
    try {
      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      const arrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
      const ymd = todayYmdEat();
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
      });
    } catch (err) {
      console.error('[m6pm/save-morning-snapshot-now]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Dashboard-friendly debt-report fire: fetches LIVE arrears (current
  // QB state), builds XLS, posts to m6pm, and broadcasts signed link
  // SMS to admin list. Frank 2026-07-15: /trigger endpoint doesn't send
  // link SMS by default; this closes that gap for the dashboard button.
  app.post('/api/admin/m6pm/fire-debt-report-now', requireSecretOrJwt, async (req, res) => {
    try {
      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      const today = todayYmdEat();
      const arrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
      const buf = buildArrearsXls(arrears, null);
      const m6pmResp = await postArrearsToM6pm(buf, 'morning');
      const link = signedReportUrl({ path: 'page', date: today, name: '*', mode: 'morning' });
      const smsSent = [];
      if (link) {
        const text = `BRAIN Debt report (${today}) ready: ${link}`;
        for (const phone of broadcastPhones()) {
          const r = await sendNextSms(phone, text);
          smsSent.push({ phone, ok: r.ok !== false });
        }
      }
      res.json({
        ok: true,
        date: today,
        arrears_count: arrears.length,
        m6pm_reports: m6pmResp,
        link,
        sms_sent: smsSent,
      });
    } catch (err) {
      console.error('[m6pm/fire-debt-report-now]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Dashboard button: send-overdue-sms to customers based on current
  // arrears. Fetches live arrears, posts XLS to m6pm's
  // /api/autofire/send-overdue-sms which handles per-officer sender
  // routing + NextSMS dispatch. Frank 2026-07-15.
  app.post('/api/admin/m6pm/send-arrear-sms-now', requireSecretOrJwt, async (req, res) => {
    try {
      const dryRun = req.body?.dry_run === true;
      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      const arrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
      const buf = buildArrearsXls(arrears, null);
      const m6pmResp = await postSendOverdueSms(buf, { dryRun });
      res.json({ ok: true, arrears_count: arrears.length, dry_run: dryRun, m6pm: m6pmResp });
    } catch (err) {
      console.error('[m6pm/send-arrear-sms-now]', err);
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

  /**
   * POST /api/admin/m6pm/resend-tick-result
   * Body: { tick: 'kili1615', ymd?: 'YYYY-MM-DD' }
   * Computes today's per-channel paid totals for the named tick and
   * broadcasts the success SMS to the full admin list, BYPASSING the
   * watcher's already-notified gate. Use when a false "no outcome"
   * alarm fired earlier and the real success SMS never went out.
   */
  app.post('/api/admin/m6pm/resend-tick-result', requireSecretOrJwt, async (req, res) => {
    try {
      const tick = String(req.body?.tick || '').trim();
      if (!tick) return res.status(400).json({ error: 'tick required' });
      const ymd = String(req.body?.ymd || todayYmdEat());
      const stats = await pool.query(
        `SELECT channel,
                COALESCE(SUM(paid_count), 0)::int   AS paid_count,
                COALESCE(SUM(paid_total), 0)::numeric AS paid_total,
                COALESCE(SUM(unused_count), 0)::int AS unused_count
           FROM payment_batches
          WHERE created_by LIKE $1
            AND status = 'finalized'
            AND (created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $2::date
          GROUP BY channel
          ORDER BY channel`,
        [`auto-upload:${tick}%`, ymd],
      );
      if (stats.rows.length === 0) {
        return res.status(404).json({ error: `no finalized batches for ${tick} on ${ymd}` });
      }
      const parts = stats.rows.map((r) => {
        const ch = r.channel === 'nmbnew' ? 'NMB'
                 : r.channel === 'bank' ? 'Bnk'
                 : r.channel === 'iphone_bank' ? 'Iph'
                 : r.channel;
        const tzs = Number(r.paid_total) || 0;
        const tzsStr = tzs >= 1_000_000 ? `${(tzs / 1_000_000).toFixed(2)}M`
                     : tzs >= 1_000 ? `${(tzs / 1_000).toFixed(0)}k`
                     : String(tzs);
        return `${ch} ${r.paid_count}p/${tzsStr}`;
      });
      const text = `BRAIN ${tick} ✓ ${parts.join(' ')} (resent)`;
      const sent = [];
      for (const phone of broadcastPhones()) {
        const r = await sendNextSms(phone, text);
        sent.push({ phone, ok: r.ok !== false });
      }
      // Also update notifKey so future watcher iterations don't re-fire.
      const notifKey = `m6pm_tick_notif:${ymd}:${tick}`;
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, 'ok_resend')
           ON CONFLICT (key) DO UPDATE SET value='ok_resend', updated_at=now()`,
        [notifKey],
      );
      res.json({ tick, ymd, text, sent, stats: stats.rows });
    } catch (err) {
      console.error('[m6pm/resend-tick-result]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/app-settings/set
   * Body: { key, value, confirm: 'YES-OVERRIDE' }
   * One-off setter for operational overrides (block a ritual, pre-claim a
   * gate, mark a tick, etc). Requires confirm token to prevent accidental
   * gate flips. Returns previous value for audit.
   */
  app.post('/api/admin/app-settings/set', requireSecretOrJwt, async (req, res) => {
    try {
      const key = String(req.body?.key || '').trim();
      const value = String(req.body?.value || '').trim();
      const confirm = String(req.body?.confirm || '');
      if (!key) return res.status(400).json({ error: 'key required' });
      if (confirm !== 'YES-OVERRIDE') {
        return res.status(400).json({ error: 'confirm must be "YES-OVERRIDE"' });
      }
      const prev = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [key]);
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
        [key, value],
      );
      res.json({ key, new_value: value, previous_value: prev.rows[0]?.value ?? null });
    } catch (err) {
      console.error('[app-settings/set]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/m6pm/rebuild-morning-from-evening
   * Body: { date?: "YYYY-MM-DD", dry_run?: boolean }
   *
   * Frank 2026-07-18: when the frozen morning baseline drifts (e.g. seeded
   * pre-code-change and evening comparison uses post-change /arrears),
   * mathematically rebuild the morning arrears from CURRENT live arrears
   * plus today's per-invoice paid payment_uploads. The reconstructed
   * baseline satisfies: morning_total - evening_total = today's actual
   * collections. Per-officer breakdown stays honest because balance is
   * added back to the actual affected invoices.
   *
   * Payments applied to invoices NOT currently in arrears (invoice was
   * fully paid → dropped) are synthesized as new arrears rows with the
   * payment amount as balance.
   */
  app.post('/api/admin/m6pm/rebuild-morning-from-evening', requireSecretOrJwt, async (req, res) => {
    try {
      const date = String(req.body?.date || todayYmdEat());
      const dryRun = req.body?.dry_run === true;
      const sqlOnly = req.body?.sql_only === true;
      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      if (sqlOnly) {
        const q = await pool.query(
          `SELECT pu.invoice_no, pu.customer_id, pu.customer_name, pu.status, pu.kind, pu.amount,
                  pu.created_at, pb.channel, pb.status AS pb_status
             FROM payment_uploads pu
             JOIN payment_batches pb ON pb.id = pu.batch_id
            WHERE (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $1::date
            ORDER BY pu.created_at DESC LIMIT 20`,
          [date],
        );
        const total = await pool.query(
          `SELECT COUNT(*) AS c,
                  COUNT(*) FILTER (WHERE kind='paid' AND status='created' AND invoice_no IS NOT NULL AND invoice_no <> '') AS c_filter
             FROM payment_uploads pu
            WHERE (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $1::date`,
          [date],
        );
        return res.json({ sample: q.rows, counts: total.rows[0] });
      }
      // 1. Fetch live evening arrears (excludeToday=true = matches
      //    fire-evening-comparison's later pull).
      const evening = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
      // 2. Query today's paid payment_uploads with per-invoice detail.
      //    kind='paid' rows have invoice_no populated. Sum amount per invoice_no.
      // Mirror today-totals's tz + column choice: filter by
      // pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam' (matches how the
      // rest of BRAIN attributes "today's rows"). pu.status='created' is
      // the successful-push state (never 'finalized' — that's a
      // payment_batches value).
      const puRes = await pool.query(
        `SELECT pu.invoice_no, pu.customer_id, pu.customer_name, SUM(pu.amount)::bigint AS total_paid
           FROM payment_uploads pu
          WHERE pu.kind = 'paid'
            AND pu.status = 'created'
            AND pu.invoice_no IS NOT NULL AND pu.invoice_no <> ''
            AND (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $1::date
          GROUP BY pu.invoice_no, pu.customer_id, pu.customer_name`,
        [date],
      );
      // 3. Reconstruct morning: for each paid invoice, add balance back to
      //    the matching arrears row (matched by `no`). If not found, insert
      //    a synthesized row (invoice was fully paid → removed from evening).
      const eveningByNo = new Map();
      for (const row of evening) eveningByNo.set(String(row.no || ''), row);
      const morning = evening.map((row) => ({ ...row }));
      const morningByNo = new Map();
      for (const row of morning) morningByNo.set(String(row.no || ''), row);
      let addedBack = 0;
      let synthesized = 0;
      let totalAddBack = 0;
      for (const p of puRes.rows) {
        const invNo = String(p.invoice_no);
        const paid = Number(p.total_paid) || 0;
        totalAddBack += paid;
        if (morningByNo.has(invNo)) {
          morningByNo.get(invNo).balance = (Number(morningByNo.get(invNo).balance) || 0) + paid;
          addedBack++;
        } else {
          // Synthesize a fresh arrears row for this fully-paid invoice.
          morning.push({
            qbId: null,
            customerId: p.customer_id || null,
            date: null,
            dueDate: null,
            type: 'Invoice',
            no: invNo,
            customer: p.customer_name || '',
            branch: '',
            customerLeaf: p.customer_name || '',
            memo: '(reconstructed morning: invoice fully paid today)',
            balance: paid,
            amount: paid,
            status: 'overdue',
          });
          synthesized++;
        }
      }
      const eveningTotal = evening.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      const morningTotal = morning.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      const key = `morning_arrears:${date}`;
      if (!dryRun) {
        await pool.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, $2)
             ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value, updated_at=now()`,
          [key, JSON.stringify(morning)],
        );
      }
      res.json({
        date,
        dry_run: dryRun,
        evening: { rows: evening.length, total_balance: eveningTotal },
        morning_rebuilt: { rows: morning.length, total_balance: morningTotal },
        payments_applied: { unique_invoices: puRes.rows.length, added_back: addedBack, synthesized },
        total_added_back: totalAddBack,
        expected_collected: morningTotal - eveningTotal,
      });
    } catch (err) {
      console.error('[rebuild-morning-from-evening]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/m6pm/dedup-morning-arrears
   * Body: { date?: "YYYY-MM-DD", dry_run?: boolean }
   *
   * Frank 2026-07-18: when the 05:00 EAT auto-fire didn't run, we reseed
   * morning_arrears from /arrears — but /arrears defaults to
   * excludeToday=false while fetchAllArrears in the evening comparison uses
   * excludeToday=true. The mismatch means morning includes today's
   * due-date rows but evening excludes them, inflating "collected" by ~9-10M.
   *
   * This one-shot endpoint reads the frozen morning_arrears:${date},
   * removes rows whose dueDate === ${date}, and writes the cleaned JSON
   * back so morning-vs-evening compare is like-for-like.
   */
  app.post('/api/admin/m6pm/dedup-morning-arrears', requireSecretOrJwt, async (req, res) => {
    try {
      const date = String(req.body?.date || todayYmdEat());
      const dryRun = req.body?.dry_run === true;
      const key = `morning_arrears:${date}`;
      const r = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [key]);
      if (!r.rows.length) return res.status(404).json({ error: `no ${key} cache` });
      let morning;
      try { morning = JSON.parse(r.rows[0].value); }
      catch (e) { return res.status(500).json({ error: `cache parse failed: ${e.message}` }); }
      if (!Array.isArray(morning)) return res.status(500).json({ error: 'cache value is not an array' });
      const sumBalance = (arr) => arr.reduce((s, row) => s + (Number(row.balance) || 0), 0);
      const before = { count: morning.length, total_balance: sumBalance(morning) };
      // Dedup key: whichever identifier is present — invoice no, then qbId, then ref.
      // Falls back to customer+amount+date if none of those exist. Keeps the FIRST
      // occurrence, discards subsequent duplicates.
      const seen = new Set();
      const filtered = [];
      const dupKeys = {};
      let sampleFieldNames = null;
      for (const row of morning) {
        if (!sampleFieldNames) sampleFieldNames = Object.keys(row);
        const key = String(
          row.no || row.qbId || row.ref
          || `${row.customer || ''}|${row.balance || 0}|${row.date || ''}`
        );
        if (seen.has(key)) {
          dupKeys[key] = (dupKeys[key] || 1) + 1;
          continue;
        }
        seen.add(key);
        filtered.push(row);
      }
      const after = { count: filtered.length, total_balance: sumBalance(filtered) };
      const removed = {
        count: before.count - after.count,
        total_balance: before.total_balance - after.total_balance,
        sample_dup_keys: Object.entries(dupKeys).slice(0, 8).map(([k, n]) => ({ key: k, times: n })),
      };
      if (!dryRun) {
        await pool.query(
          `UPDATE app_settings SET value=$2, updated_at=now() WHERE key=$1`,
          [key, JSON.stringify(filtered)],
        );
      }
      res.json({ date, dry_run: dryRun, before, after, removed, sample_field_names: sampleFieldNames });
    } catch (err) {
      console.error('[dedup-morning-arrears]', err);
      res.status(500).json({ error: err.message });
    }
  });

  /**
   * POST /api/admin/m6pm/fire-evening-comparison
   * Force-fires the kili1615 evening comparison (morning baseline vs live
   * evening arrears) even when kili1615's own tick failed and no batch was
   * labeled 'auto-upload:kili1615*'. Used when a heisenberg catchup filled
   * in the missing kili1615 data. Bypasses the batch-existence check the
   * autofire watcher uses; still requires morning_arrears:<ymd> baseline.
   * Body: { reset_gate?: bool } — set to true to reset the m6pm_evening_fired
   * gate before firing (useful for re-fires).
   */
  app.post('/api/admin/m6pm/fire-evening-comparison', requireSecretOrJwt, async (req, res) => {
    try {
      const today = todayYmdEat();
      // Frank 2026-07-02: accept custom mode so an ad-hoc emergency
      // comparison can fire under a distinct slot (e.g. 'heisenberg')
      // without consuming the evening slot — the auto-evening at 20:00
      // EAT still gets to fire cleanly for the boss's regular report.
      const mode = String(req.body?.mode || 'evening');
      const isEvening = mode === 'evening';
      const gateKey = `m6pm_evening_fired:${today}`;
      if (isEvening && req.body?.reset_gate === true) {
        await pool.query(`DELETE FROM app_settings WHERE key=$1`, [gateKey]);
      }
      // Check morning baseline exists
      const morn = await pool.query(
        `SELECT value FROM app_settings WHERE key = $1`,
        [`morning_arrears:${today}`],
      );
      if (!morn.rows.length) {
        return res.status(400).json({
          error: `no morning baseline for ${today} — seed via /api/admin/m6pm/seed-morning-arrears`,
        });
      }
      const morningArrears = JSON.parse(morn.rows[0].value);
      const morningXls = buildArrearsXls(morningArrears, null);

      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      const eveningArrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
      const eveningXls = buildArrearsXls(eveningArrears, null);

      const m6pmResp = await postComparisonToM6pm(morningXls, eveningXls, mode);

      // Only mark the evening gate when mode is actually 'evening' — an
      // ad-hoc heisenberg comparison must NOT block the real evening fire.
      if (isEvening) {
        await pool.query(
          `INSERT INTO app_settings (key, value) VALUES ($1, 'done')
             ON CONFLICT (key) DO UPDATE SET value='done', updated_at=now()`,
          [gateKey],
        );
      }
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('m6pm_last_report_fire_at', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [new Date().toISOString()],
      );

      const link = signedReportUrl({ path: 'page', date: today, name: '*', mode });
      const morningTotal = morningArrears.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      const eveningTotal = eveningArrears.reduce((s, r) => s + (Number(r.balance) || 0), 0);
      const collected = morningTotal - eveningTotal;
      const fmt = (n) => Math.round(n).toLocaleString('en-US');
      const modeLabel = mode.charAt(0).toUpperCase() + mode.slice(1);
      const text = link
        ? `BRAIN ${modeLabel} comparison (${today}) ready.\nMorning: ${fmt(morningTotal)} TZS\n${modeLabel}: ${fmt(eveningTotal)} TZS\nCollected: ${fmt(collected)} TZS\n${link}`
        : null;
      const smsSent = [];
      if (text) {
        // For non-evening ad-hoc fires, only SMS the master admin (Frank)
        // so we don't spam the whole broadcast list mid-day.
        const recipients = isEvening
          ? broadcastPhones()
          : [process.env.MASTER_ADMIN_PHONE || '255752900450'];
        for (const phone of recipients) {
          const r = await sendNextSms(phone, text);
          smsSent.push({ phone, ok: r.ok !== false });
        }
      }
      res.json({
        ymd: today,
        mode,
        morning_count: morningArrears.length,
        evening_count: eveningArrears.length,
        morning_total_tzs: morningTotal,
        evening_total_tzs: eveningTotal,
        collected_tzs: collected,
        link,
        m6pm_reports: m6pmResp,
        sms_sent: smsSent,
      });
    } catch (err) {
      console.error('[fire-evening-comparison]', err);
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
    // Frank 2026-06-28: trigger off the new meru0500 catchup (added because
    // meru0300 has been failing many mornings in a row). The other ticks
    // remain as fallback so any successful overnight tick still arms the
    // morning ritual.
    triggerTicks: ['meru0500', 'meru0100', 'meru0300', 'hanang0700'],
    minHourEat: 5,        // Frank rule: hold delivery until 05:00 EAT
    forceAtHourEat: 6,    // Frank 2026-06-28: if NO tick has finalized by
                          // 06:00 EAT, fire the morning ritual anyway. The
                          // arrears endpoint reads QB live, so we can still
                          // produce a meaningful report even when all
                          // overnight ticks failed.
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
  { tick: 'meru0500', hour: 5, min: 0 },
  { tick: 'hanang0700', hour: 7, min: 0 },
  { tick: 'loolmalas1000', hour: 10, min: 0 },
  { tick: 'lengai1230', hour: 12, min: 30 },
  { tick: 'mawenzi1400', hour: 14, min: 0 },
  // Frank 2026-07-02: env-driven override for the kili1615 tick until
  // Sunday. Set KILI_HOUR_OVERRIDE=17 KILI_MIN_OVERRIDE=0 to shift the
  // last-tick-of-the-day cutoff to 17:00 EAT. Unset both to revert to
  // the standard 16:15. Label stays 'kili1615' for backward compat with
  // report watchers + comparison endpoints that match on the tick name.
  { tick: 'kili1615',
    hour: Number(process.env.KILI_HOUR_OVERRIDE) || 16,
    min:  Number.isFinite(Number(process.env.KILI_MIN_OVERRIDE))
            ? Number(process.env.KILI_MIN_OVERRIDE) : 15 },
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
// Wait at least this long after scheduled tick before declaring "no worker
// outcome". Bumped 20→35 on 2026-06-30 because kili1615 takes ~27 min
// end-to-end (NMB scrape + CRDB scrape + Frappe per-customer calls + CDC
// poller catch-up) and was false-alarming + suppressing the real success
// SMS that should have followed at +27min. 35 gives 8 min headroom.
// Frank 2026-07-02: raised 35→90 min. The tick-notif watcher used to
// treat "no outcome by +35min" as a failure and blast admins with
// "no worker outcome" SMS. But the QB worker itself has a 10-min retry
// loop and NMB scrapes sometimes take 30+ min under network delay —
// so the 35-min timer was firing FALSE alarms for slow-but-fine ticks.
//
// Contract now: rely on the worker's EXPLICIT outcome.status='fail'
// signal for real failures (fires instantly, message is authoritative).
// The timer alarm here is a very-late BACKSTOP only — kicks in only
// when the worker goes completely silent (probable crash / stuck
// process, needs human eyes). Wording softened accordingly so admins
// know it's an uncertainty flag, not a confirmed failure.
const FAILURE_GRACE_MIN = 90;
const HEARTBEAT_PRE_TICK_MIN = 15; // pre-tick phone-online check
// Heartbeat staleness threshold. Default 10 min — brain-ping APK reports at
// ~3-6 min cadence (battery-friendly), so 5 min generated false-positive
// "phone offline" alerts every time the cadence hit the long end of its
// range. 10 min keeps the 15-min pre-tick warning useful while tolerating
// the APK's natural drift. Override with HEARTBEAT_STALE_MIN env var.
const HEARTBEAT_STALE_MIN = Number(process.env.HEARTBEAT_STALE_MIN || 10);
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
    // Frank 2026-06-28: forceAtHourEat fallback. If NO trigger tick has
    // finalized today AND the clock has passed the force hour, fire the
    // ritual anyway with whatever current arrears we can pull. The arrears
    // endpoint reads QB live, so a meaningful morning report is still
    // produceable even when all overnight upload ticks failed.
    const forced = !recent.rows.length
      && cfg.forceAtHourEat != null
      && eatHour >= cfg.forceAtHourEat;
    if (!recent.rows.length && !forced) continue;

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
      // Fix #1 (Frank 2026-06-29): cache fallback as default. /arrears is a
      // single-point-of-failure for the whole morning chain — if it 500s,
      // the autofire used to fail and officers got no link. Now we try live
      // first, fall back to the most recent morning_arrears cache on any
      // failure (timeout, 500, parse error). Admin SMS notes the fallback.
      let arrears = null;
      let arrearsSource = 'live';
      let arrearsAsOf = today;
      try {
        arrears = await fetchAllArrears({ brainSelfBase, sharedSecret, excludeToday: true });
      } catch (liveErr) {
        console.warn(`[m6pm/autofire] /arrears live failed (${liveErr.message}) — falling back to cache`);
        try {
          const cache = await pool.query(
            `SELECT key, value, updated_at FROM app_settings
              WHERE key LIKE 'morning_arrears:%'
              ORDER BY updated_at DESC LIMIT 1`,
          );
          if (!cache.rows.length) {
            throw new Error(`/arrears down AND no morning_arrears cache exists — cannot continue`);
          }
          arrears = JSON.parse(cache.rows[0].value);
          arrearsSource = `cache(${cache.rows[0].key})`;
          arrearsAsOf = String(cache.rows[0].key).split(':')[1] || today;
          console.warn(`[m6pm/autofire] fell back to ${arrearsSource} (${arrears.length} rows, as_of=${arrearsAsOf})`);
          // Single admin SMS so master sees we degraded BEFORE the link goes out
          try {
            await sendNextSms(
              MASTER_ADMIN_PHONE,
              `BRAIN ${mode} ${today}: /arrears down, fell back to cache ${arrearsAsOf} (${arrears.length} rows). Link still firing.`,
            );
          } catch (_) { /* ignore SMS hiccup */ }
        } catch (cacheErr) {
          console.error(`[m6pm/autofire] cache fallback failed: ${cacheErr.message}`);
          throw cacheErr; // re-throw original failure semantics so outer catch rolls the gate
        }
      }

      // Freebie fix: save morning_arrears BEFORE any m6pm calls so even if
      // postArrearsToM6pm later fails, today's snapshot exists for manual
      // rescue (?source=cache on /trigger). Previously saved AFTER post — a
      // postArrearsToM6pm failure left us with no fallback for the day.
      if (mode === 'morning' && arrearsSource === 'live') {
        try {
          await pool.query(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [`morning_arrears:${today}`, JSON.stringify(arrears)],
          );
          console.log(`[m6pm/autofire] morning arrears JSON saved EARLY (${arrears.length} rows) — survives downstream failures`);
        } catch (e) {
          console.error('[m6pm/autofire] failed to save morning_arrears:', e.message);
        }
      }

      const buf = buildArrearsXls(arrears, null);
      await postArrearsToM6pm(buf, mode);
      let syncResult = null;
      let overdueSmsResult = null;
      if (mode === 'morning') {
        const got = await morningGateAcquired(pool, today);
        if (got) {
          // Step 2 of the morning ritual — sync mobile (refresh officers' app).
          try {
            syncResult = await postSyncMobile(buf);
            console.log(`[m6pm/autofire] mode=${mode} sync-mobile fired (morning gate acquired)`);
          } catch (e) {
            console.error(`[m6pm/autofire] sync-mobile failed:`, e.message);
            syncResult = { error: e.message };
          }
          // Step 3 of the morning ritual — customer overdue SMS (yesterday-only).
          // m6pm /api/autofire/send-overdue-sms internally filters to yesterday's
          // unpaid balances, dispatches via NextSMS in a daemon thread, and
          // SMSes admins on completion. Same morning gate keeps it once-a-day.
          try {
            overdueSmsResult = await postSendOverdueSms(buf);
            console.log(`[m6pm/autofire] mode=${mode} overdue-sms dispatched: batch=${overdueSmsResult.batch_id} eligible=${overdueSmsResult.eligible_count}`);
          } catch (e) {
            console.error(`[m6pm/autofire] overdue-sms failed:`, e.message);
            overdueSmsResult = { error: e.message };
          }
        } else {
          syncResult = '(skipped — morning gate already claimed today)';
          overdueSmsResult = '(skipped — morning gate already claimed today)';
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
        // Fix #2 — stamp dispatch time so morningLinkProbeWatcher knows the
        // link actually went out. If this row isn't here by the probe's
        // deadline, master admin gets a direct "LINK NOT DELIVERED" alert.
        try {
          await pool.query(
            `INSERT INTO app_settings (key, value) VALUES ($1, $2)
               ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
            [`m6pm_link_sms_sent_at:${today}:${mode}`, new Date().toISOString()],
          );
        } catch (e) { console.error('[m6pm/autofire] stamp link-sent failed:', e.message); }
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
  // Frank 2026-07-15: disabled. Only morning debt / noon debt / evening
  // comparison reports go out. Per-heisenberg catch-up reports were spammy.
  return;
  // eslint-disable-next-line no-unreachable
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
    // Column is `received_at` (per CREATE TABLE in phoneHeartbeatWatcher).
    // Earlier `seen_at` query threw silently and dropped phone-stale signals
    // from tick-failure SMS hints — fixed 2026-06-28.
    const r = await pool.query(
      `SELECT received_at FROM phone_heartbeats ORDER BY received_at DESC LIMIT 1`,
    );
    const last = r.rows[0]?.received_at;
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
/**
 * Real "is an upload actively running RIGHT NOW?" probe. Returns true if
 * auto_upload_locks has any row whose locked_at heartbeat is fresh
 * (within the last 2 min — heartbeat cadence is 30s, 90s is the stale
 * reclaim threshold for the upload lock itself).
 *
 * Watcher uses this BEFORE firing "no worker outcome" past +grace, so
 * a still-running upload doesn't get a false-alarm SMS — we'd rather
 * wait an extra few minutes than tell admins a working upload failed.
 */
async function isUploadInFlight(pool) {
  try {
    const r = await pool.query(
      `SELECT channel, locked_at FROM auto_upload_locks
        WHERE locked_at > now() - interval '2 minutes'
        ORDER BY locked_at DESC LIMIT 1`,
    );
    return r.rows[0] || null;
  } catch (_) {
    return null;
  }
}

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
      // No finalized batches yet. Frank 2026-06-28: EVERY tick gets an
      // SMS — no silencing. The text just has to ACCURATELY describe
      // what happened. We combine the worker's self-report with DB
      // state and pick the right wording so boss + admin team know
      // exactly where the gap is.
      if (outcome?.status === 'ok') {
        const rowsSeen = Number(outcome.rows_seen || 0);
        if (rowsSeen > 0) {
          // Worker says ok with rows seen — but DB has no batches yet.
          // Most common cause: BRAIN was restarting when the batch
          // INSERT happened. Tell admins exactly that so they don't
          // panic about scrapers/phone/POC.
          text = `BRAIN ${tick} ⚠ worker ok (${rowsSeen} rows) but no batches persisted — likely BRAIN restart during fire, investigate`;
          resultLabel = 'ok_persistence_drift';
        } else {
          text = `BRAIN ${tick} ✓ no transactions in window`;
          resultLabel = 'ok_empty';
        }
      } else if (outcome?.status === 'fail') {
        // Frank 2026-07-04: drop the "worker:" prefix — the SMS should
        // describe what's wrong on the bank site, not blame the worker.
        // The worker/POC now categorizes failures into human-readable
        // strings like "NMB Download button unresponsive", "CRDB returned
        // empty file", etc. — pass those through verbatim.
        const reason = outcome.reason ? String(outcome.reason).slice(0, 120) : 'reason unrecorded';
        text = `BRAIN ${tick} failed — ${reason}`;
        resultLabel = 'err';
      } else {
        // Frank 2026-07-02: NO timer-based "no outcome" SMS. Ever.
        //
        // Contract: this watcher fires SMS ONLY on the worker's EXPLICIT
        // outcome.status = 'ok' | 'fail' signals. Both arrive via the
        // agent-session outcome recording, and both are authoritative.
        // Real worker failures fire the '✗ worker: reason' SMS in the
        // outcome.status='fail' branch above — instant, accurate, no
        // ambiguity.
        //
        // If the worker goes completely silent (crash, hang, network
        // partition), that's caught by a DIFFERENT alerting path
        // — the worker-liveness heartbeat watcher — which alerts based
        // on actual process state, not a clock. Firing a "no outcome by
        // +Xmin" SMS from this watcher just created false alarms when
        // ticks legitimately ran long (slow NMB scrape, network delay).
        //
        // So: no outcome yet → keep waiting silently. If a real fail
        // eventually arrives, we'll send its SMS then. If it never
        // arrives, worker-liveness catches it.
        await pool.query(`DELETE FROM app_settings WHERE key=$1`, [notifKey]);
        continue;
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
      text = `BRAIN ${tick} passed — ${parts.join(' ')}`;
      resultLabel = 'ok';
    }

    // Frank 2026-07-04: tick-result SMS goes to master admin ONLY (Frank),
    // not the full broadcast list. Reasoning: tick results are noise for
    // the wider admin team; comparison/heisenberg reports still broadcast.
    let anyFailed = false;
    const masterAdminPhone = process.env.MASTER_ADMIN_PHONE || '255752900450';
    const r = await sendNextSms(masterAdminPhone, text);
    if (r.ok === false) anyFailed = true;
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

  // Fix #5 (Frank 2026-06-29): three-strike alert logic. A single missed
  // heartbeat is NOT a real outage — the brain-ping APK has variable
  // cadence (3-6 min between pings, sometimes longer). Today's false-
  // positive at 00:57 EAT fired because ONE gap exceeded 10 min while
  // the phone was actually fine.
  //
  // Two-stage check now:
  //   recent  = any heartbeat in last HEARTBEAT_STALE_MIN (default 20 min)
  //   extended = >= 2 heartbeats in last 2 × HEARTBEAT_STALE_MIN (40 min)
  //
  // Phone is considered offline ONLY when both checks fail — i.e. no recent
  // ping AND not enough pings in the extended window to prove cadence is
  // alive. One slow gap silently passes; real outages still alert.
  //
  // Long-term fix is in the brain-ping repo: APK should ping every 60s
  // (currently 3-6 min variable). When that ships, drop HEARTBEAT_STALE_MIN
  // to 3 min and this watcher catches a true outage in ~3 min.
  const recentHb = await pool.query(
    `SELECT battery_pct, received_at
       FROM phone_heartbeats
      WHERE phone = $1
        AND received_at >= now() - ($2 || ' minutes')::interval
      ORDER BY received_at DESC LIMIT 1`,
    [MASTER_ADMIN_PHONE, String(HEARTBEAT_STALE_MIN)],
  );
  const hasRecent = recentHb.rows.length > 0;
  let phoneOnline = hasRecent;
  let batteryPct = recentHb.rows[0]?.battery_pct ?? null;
  if (!hasRecent) {
    // No recent ping — check the extended window. If we have ≥2 pings in
    // 2×HEARTBEAT_STALE_MIN, the cadence is alive, just slow this cycle.
    const extended = await pool.query(
      `SELECT COUNT(*)::int AS n, MAX(battery_pct) AS bat
         FROM phone_heartbeats
        WHERE phone = $1
          AND received_at >= now() - (($2 * 2) || ' minutes')::interval`,
      [MASTER_ADMIN_PHONE, String(HEARTBEAT_STALE_MIN)],
    );
    if (extended.rows[0]?.n >= 2) {
      phoneOnline = true;
      batteryPct = extended.rows[0]?.bat ?? null;
      // Log so we know the suppression kicked in — helps tuning the
      // threshold without flying blind.
      console.log(`[m6pm/phone-hb] suppressed false-positive: no ping in ${HEARTBEAT_STALE_MIN}min but ${extended.rows[0].n} pings in last ${HEARTBEAT_STALE_MIN * 2}min`);
    }
  }

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
/**
 * Fix #4 (Frank 2026-06-29): one-shot auto-retry on scraper crash.
 *
 * When the worker posts tick_outcome with status:fail and a reason like
 * "nmb_scrapper_failed" (or anything containing "scrap"), BRAIN schedules
 * a single retry at +30 min by setting the existing nmb-pull request flag.
 * POC picks it up and retries; the rest of the chain runs unchanged.
 *
 * Capped at 1 retry per tick per day so a permanently-broken scraper
 * doesn't spin forever. Per-tick, per-day dedup keys:
 *   tick_retry_scheduled:<ymd>:<tick>  - retry_at timestamp written
 *   tick_retry_fired:<ymd>:<tick>      - the nmb-pull flag actually set
 *
 * After firing, also SMSes master admin with the new request time so we
 * know an autonomous retry is in flight (not a silent surprise).
 */
const SCRAPER_RETRY_DELAY_MIN = 30;
async function scraperRetryWatcher({ pool }) {
  const today = todayYmdEat();
  // Find any tick_outcome from today that is status:fail with a scraper reason.
  const fails = await pool.query(
    `SELECT key, value, updated_at FROM app_settings
      WHERE key LIKE $1
      ORDER BY updated_at DESC LIMIT 20`,
    [`tick_outcome:${today}:%`],
  );
  for (const row of fails.rows) {
    let outcome;
    try { outcome = JSON.parse(row.value); } catch { continue; }
    if (outcome?.status !== 'fail') continue;
    const reason = String(outcome.reason || '').toLowerCase();
    if (!reason.includes('scrap')) continue;
    const tick = String(row.key).split(':')[2];
    if (!tick) continue;

    const scheduledKey = `tick_retry_scheduled:${today}:${tick}`;
    const firedKey = `tick_retry_fired:${today}:${tick}`;

    // Step 1: ensure a retry is scheduled with a concrete retry_at time.
    const claim = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING RETURNING value`,
      [scheduledKey, new Date(new Date(row.updated_at).getTime() + SCRAPER_RETRY_DELAY_MIN * 60_000).toISOString()],
    );
    if (claim.rows.length) {
      console.log(`[m6pm/scraper-retry] scheduled retry for ${tick} (reason=${reason})`);
    }

    // Step 2: if retry_at <= now() and not yet fired, fire it.
    const sched = await pool.query(`SELECT value FROM app_settings WHERE key = $1`, [scheduledKey]);
    const retryAt = sched.rows[0]?.value;
    if (!retryAt || new Date(retryAt).getTime() > Date.now()) continue;

    const fireClaim = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO NOTHING RETURNING value`,
      [firedKey, new Date().toISOString()],
    );
    if (!fireClaim.rows.length) continue; // already fired by another instance

    // Set the existing nmb-pull request flag — POC's polling loop picks it
    // up the same way the scheduler would. Downstream (POC complete →
    // BRAIN auto-upload) runs without further wiring.
    try {
      const nowIso = new Date().toISOString();
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_requested_at', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [nowIso],
      );
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_completed_at', '')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      );
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_result_json', '')
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      );
      console.warn(`[m6pm/scraper-retry] FIRED autonomous retry for ${tick} (POC will pick up nmb_pull_requested_at)`);
      try {
        await sendNextSms(
          MASTER_ADMIN_PHONE,
          `BRAIN ${tick} auto-retry fired (${reason}) — POC NMB pull requested at ${nowIso.slice(11,19)}Z. Capped 1/day.`,
        );
      } catch (_) { /* ignore SMS hiccup */ }
    } catch (err) {
      console.error('[m6pm/scraper-retry] retry fire failed:', err.message);
    }
  }
}

/**
 * SAVCOM post-tick watcher (Frank 2026-06-29).
 *
 * After every scheduled QB tick (meru/hanang/loolmalas/lengai/mawenzi/kili
 * /kibo), BRAIN automatically fires the SAV NMB + SAV CRDB auto-upload
 * channels so the Frappe-bound SAVCOM payments stay in sync with the QB
 * tick cadence — without the operator having to fire them by hand.
 *
 * Behaviour:
 *   - For each tick in TICK_SCHEDULE_EAT whose hour/min has passed at least
 *     SAVCOM_POST_TICK_GRACE_MIN minutes ago (default 8 min — give the QB
 *     upload time to finalize first).
 *   - Atomic per-tick-per-day claim via
 *     app_settings.savcom_post_tick:<ymd>:<tick>. First call sets 'firing',
 *     then flips to 'done' on success. A second call same tick same day
 *     is a no-op.
 *   - Fires sav_nmb then sav_crdb via internal HTTP to
 *     /api/payment-batches/auto-upload-frappe/<channel> with from-last
 *     window semantics (server defaults to MAX(consumed.sheet_ts) + 1ms).
 */
const SAVCOM_POST_TICK_GRACE_MIN = Number(process.env.SAVCOM_POST_TICK_GRACE_MIN || 8);

/**
 * Frank's operator convention (verbatim from feedback_asof_for_evening_tail):
 *   bank txns in [00:00, 16:15:59] EAT on date D → AS_OF=D, TxnDate=D
 *   bank txns in [16:16, 23:59:59] EAT on date D → AS_OF=D, TxnDate=D+1
 *
 * For an auto-fire keyed off a SCHEDULED tick (meru/hanang/loolmalas/lengai
 * /mawenzi/kili/kibo), we derive both dates from the TICK's wall-clock
 * hour:min — not from "now" (because the watcher runs T+8min after the
 * tick, and a 14:08 wall-clock would otherwise mis-classify a 14:00 tick
 * as pre-cutoff while the tick really covers some post-cutoff window too).
 *
 * For ticks at or before 16:15 EAT → both AS_OF and TxnDate = today's EAT date.
 * For ticks at or after 16:16 EAT → AS_OF = today's EAT date, TxnDate = tomorrow.
 *
 * The asOf-only filter on the Frappe path then ensures the V2 algorithm
 * only walks invoices due by AS_OF (newest-first), with anything later
 * rolling forward via Phase-2 oldest-first.
 */
function asOfAndTxnDateForTick(hour, min) {
  const ymd = todayYmdEat();
  const tickMin = hour * 60 + min;
  // Same env-var override as the tick schedule — moves the AS_OF/TxnDate
  // cutoff (default 16:16 EAT) so txns received in the extended window
  // still get today's TxnDate. AS_OF_CUTOFF_MIN_OVERRIDE = total minutes
  // since midnight EAT (e.g. 17*60+1 = 1021 for 17:01 cutoff).
  const CUTOFF = Number.isFinite(Number(process.env.AS_OF_CUTOFF_MIN_OVERRIDE))
    ? Number(process.env.AS_OF_CUTOFF_MIN_OVERRIDE)
    : (16 * 60 + 16); // default 16:16 EAT
  if (tickMin < CUTOFF) return { asOf: ymd, txnDate: ymd };
  // tomorrow's date in EAT
  const d = new Date(ymd + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + 1);
  const tomorrow = d.toISOString().slice(0, 10);
  return { asOf: ymd, txnDate: tomorrow };
}

async function fireSavChannel(channel, tickName, brainSelfBase, dateOverride) {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret) {
    console.warn(`[savcom/post-tick] STATEMENT_REPORT_SECRET unset — cannot fire ${channel}`);
    return { skipped: true, reason: 'no_secret' };
  }
  // dateOverride = { asOf, txnDate } from the tick hour/min — falls back
  // to today/today if caller didn't compute (legacy path).
  const today = todayYmdEat();
  const asOf = dateOverride?.asOf || today;
  const txnDate = dateOverride?.txnDate || today;
  const body = JSON.stringify({
    as_of: asOf,
    txn_date: txnDate,
    tick_name: `savcom-auto-${tickName}`,
  });
  const r = await fetch(`${brainSelfBase}/api/payment-batches/auto-upload-frappe/${channel}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Report-Secret': secret },
    body,
    signal: AbortSignal.timeout(10 * 60_000),
  });
  const text = await r.text();
  let parsed; try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 300) }; }
  if (!r.ok) return { ok: false, status: r.status, error: parsed?.error || text.slice(0, 200) };
  return parsed;
}

async function savcomPostTickWatcher({ pool, brainSelfBase }) {
  // Frank 2026-07-02: global kill switch. When savcom_auto_disabled='1',
  // NEITHER the morning ritual NOR any post-tick auto-fire runs. Manual
  // fires via /api/payment-batches/auto-upload-frappe still work (they
  // check a different gate). Flip back to '0' to re-arm auto.
  const autoDisabled = await pool.query(
    `SELECT value FROM app_settings WHERE key='savcom_auto_disabled'`);
  if (autoDisabled.rows[0]?.value === '1') return;
  const today = todayYmdEat();
  const eatNow = new Date(Date.now() + 3 * 3600_000);
  const eatTotalMin = eatNow.getUTCHours() * 60 + eatNow.getUTCMinutes();
  for (const { tick, hour, min } of TICK_SCHEDULE_EAT) {
    const tickTotalMin = hour * 60 + min;
    const minutesSinceTick = eatTotalMin - tickTotalMin;
    if (minutesSinceTick < SAVCOM_POST_TICK_GRACE_MIN) continue;
    // Don't fire ticks that are more than 4h in the past — protects against
    // a stuck/zombie row in app_settings holding the gate from an earlier
    // BRAIN that crashed mid-fire, and also stops a fresh deploy at noon
    // from retroactively trying to fire morning ticks.
    if (minutesSinceTick > 4 * 60) continue;

    const key = `savcom_post_tick:${today}:${tick}`;
    const claim = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, 'firing')
         ON CONFLICT (key) DO NOTHING RETURNING value`,
      [key],
    );
    if (!claim.rows.length) continue; // already claimed by this BRAIN or another instance

    const dateOverride = asOfAndTxnDateForTick(hour, min);
    console.log(`[savcom/post-tick] firing sav_nmb + sav_crdb for ${tick} (T+${minutesSinceTick}min) asOf=${dateOverride.asOf} txnDate=${dateOverride.txnDate}`);
    let summary = { tick, asOf: dateOverride.asOf, txnDate: dateOverride.txnDate, sav_nmb: null, sav_crdb: null };
    try {
      summary.sav_nmb = await fireSavChannel('sav_nmb', tick, brainSelfBase, dateOverride);
    } catch (e) {
      summary.sav_nmb = { error: e.message.slice(0, 200) };
    }
    try {
      summary.sav_crdb = await fireSavChannel('sav_crdb', tick, brainSelfBase, dateOverride);
    } catch (e) {
      summary.sav_crdb = { error: e.message.slice(0, 200) };
    }
    try {
      await pool.query(
        `UPDATE app_settings SET value=$2, updated_at=now() WHERE key=$1`,
        [key, JSON.stringify(summary).slice(0, 4000)],
      );
    } catch (_) { /* gate write best-effort */ }
    console.log(`[savcom/post-tick] ${tick} done`);
  }
}

/**
 * SAVCOM morning auto-fire (Frank 2026-06-29).
 *
 * Fires the SAVCOM morning ritual (Frappe arrears → m6pm report →
 * customer overdue SMS → admin completion + broadcast link) once per
 * day. Mirrors autoFireReportsWatcher but for the Frappe-resident
 * SAVCOM book. The /api/admin/savcom/morning-ritual endpoint already
 * has a per-day idempotency gate (savcom_morning_done:<ymd>), so the
 * watcher just keeps poking at it and the first successful call wins.
 *
 * Trigger window: 05:05 EAT onwards (5 min after the QB morning fire to
 * avoid contending for NextSMS bandwidth) until 06:30 EAT (after that,
 * something's wrong and the operator should fire manually).
 */
async function savcomMorningAutoFireWatcher({ pool, brainSelfBase }) {
  // Frank 2026-07-02: honor the same global kill switch as the post-tick
  // watcher. When savcom_auto_disabled='1', no morning ritual auto-fire.
  const autoDisabled = await pool.query(
    `SELECT value FROM app_settings WHERE key='savcom_auto_disabled'`);
  if (autoDisabled.rows[0]?.value === '1') return;
  const today = todayYmdEat();
  const eatNow = new Date(Date.now() + 3 * 3600_000);
  const eatTotalMin = eatNow.getUTCHours() * 60 + eatNow.getUTCMinutes();
  if (eatTotalMin < 5 * 60 + 5) return;  // before 05:05 EAT
  if (eatTotalMin > 6 * 60 + 30) return; // after 06:30 EAT, give up

  // Check the existing idempotency gate the ritual sets itself.
  const gate = await pool.query(
    `SELECT value FROM app_settings WHERE key=$1`,
    [`savcom_morning_done:${today}`],
  );
  if (gate.rows[0]?.value === 'done') return;

  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret) {
    console.warn('[savcom/morning-autofire] STATEMENT_REPORT_SECRET unset');
    return;
  }
  try {
    const r = await fetch(`${brainSelfBase}/api/admin/savcom/morning-ritual`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Report-Secret': secret },
      signal: AbortSignal.timeout(15 * 60_000),
    });
    const j = await r.json().catch(() => ({}));
    if (j.skipped && j.reason === 'savcom_morning_already_fired_today') {
      console.log('[savcom/morning-autofire] already fired today — gate held by another instance');
    } else {
      console.log(`[savcom/morning-autofire] fired SAVCOM ritual — dispatch ${j?.sms_dispatch?.ok || '?'}/${j?.sms_dispatch?.total || '?'}`);
    }
  } catch (e) {
    console.error('[savcom/morning-autofire]', e.message);
  }
}

/**
 * Fix #2 (Frank 2026-06-29): end-to-end "morning link delivered" probe.
 *
 * The morning ritual's `m6pm_morning_done_ymd` only proves BRAIN started
 * the chain — it gets set BEFORE the SMS broadcast loop. If anything between
 * that flag and the SMS dispatch breaks (NextSMS down, broadcastPhones
 * misconfigured, autofire crashed mid-chain), the operator silently never
 * receives the link and has to notice the gap themselves.
 *
 * Probe: at 05:30 EAT (a 5-min grace after the 05:00 morning fire), check
 * for the dispatch stamp `m6pm_link_sms_sent_at:<today>:morning`. If absent,
 * send ONE direct alert to MASTER_ADMIN_PHONE with the rescue command, then
 * dedup for the day so we don't spam.
 *
 * Same alert deadline applies whether the failure mode is /arrears down,
 * postArrearsToM6pm timeout, NextSMS rejection, or anything else — the
 * probe checks the END state (was an SMS dispatched?), not any individual
 * step.
 */
async function morningLinkProbeWatcher({ pool }) {
  const today = todayYmdEat();
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  const eatTotalMin = eatNow.getUTCHours() * 60 + eatNow.getUTCMinutes();
  // Probe runs only in the 05:30 → 06:30 EAT window. Before 05:30 the
  // autofire still has time to fire the SMS legitimately; after 06:30 the
  // operator is awake anyway and the alert SMS adds nothing.
  const PROBE_START = 5 * 60 + 30;
  const PROBE_END = 6 * 60 + 30;
  if (eatTotalMin < PROBE_START || eatTotalMin > PROBE_END) return;

  // Did the SMS broadcast loop stamp dispatch today? If yes, all good.
  const stamp = await pool.query(
    `SELECT updated_at FROM app_settings WHERE key = $1`,
    [`m6pm_link_sms_sent_at:${today}:morning`],
  );
  if (stamp.rows.length > 0) return;

  // Atomic dedup — only one BRAIN process sends the alert per day.
  const alertKey = `m6pm_morning_link_alert_ymd:${today}`;
  const claim = await pool.query(
    `INSERT INTO app_settings (key, value) VALUES ($1, 'alerted')
       ON CONFLICT (key) DO NOTHING RETURNING value`,
    [alertKey],
  );
  if (!claim.rows.length) return;

  const text = `BRAIN morning ${today}: link SMS NOT DISPATCHED by 05:30 EAT. ` +
    `Rescue: POST /api/admin/m6pm/trigger?mode=morning&source=cache&fire_all=1`;
  try {
    await sendNextSms(MASTER_ADMIN_PHONE, text);
    console.warn(`[m6pm/morning-probe] alert sent to master admin (no link by 05:30 EAT)`);
  } catch (e) {
    console.error('[m6pm/morning-probe] alert SMS failed:', e.message);
  }
}

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
      try { await morningLinkProbeWatcher({ pool }); }
      catch (err) { console.error('[m6pm/morning-probe watcher]', err.message); }
      try { await scraperRetryWatcher({ pool }); }
      catch (err) { console.error('[m6pm/scraper-retry watcher]', err.message); }
      try { await savcomPostTickWatcher({ pool, brainSelfBase: brainBase }); }
      catch (err) { console.error('[savcom/post-tick watcher]', err.message); }
      try { await savcomMorningAutoFireWatcher({ pool, brainSelfBase: brainBase }); }
      catch (err) { console.error('[savcom/morning-autofire watcher]', err.message); }
    } finally {
      running = false;
    }
  };
  // setInterval only — earlier code also called setTimeout(tick, 60_000) which
  // raced with the interval's first tick, causing double-counts in the
  // POC-alert watcher. Single setInterval = one run per 60s, no race.
  setInterval(tick, 60_000);
  console.log('[m6pm/watchers] auto-fire + POC-alert + tick-notif + phone-hb + morning-probe + scraper-retry + savcom-post-tick + savcom-morning-autofire watchers armed (60s, no overlap)');
}
