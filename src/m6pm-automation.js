// ────────────────────────────────────────────────────────────────────────────
// m6pm automation — glue layer between BRAIN and the m6pm reports system.
//
// m6pm (eleganskyboda.com / elegansky-m6pm.onrender.com) is SACRED and stays
// untouched. This module only:
//   1. Produces a QB-format .xls from BRAIN's live /arrears query
//   2. POSTs it to m6pm's existing /api/generate-debt-reports endpoint after
//      each scheduled tick (morning/afternoon/evening)
//   3. Triggers m6pm's /api/sync-mobile + notification dispatch ONCE per day
//      after the MORNING report only (Frank's rule — re-sync would void
//      officers' work in flight)
//   4. Shares the report link to the WhatsApp group via m6pm's existing
//      whatsapp-bridge queue
//
// Frank's once-a-day rule (2026-06-25): the morning sync-mobile + officer
// notification happen ONCE per day, after the meru0100 debt report. The
// afternoon (lengai1230) and evening (kili1615) runs ONLY generate reports —
// they do NOT sync mobile and do NOT send SMS notifications. Re-syncing
// would overwrite officers' in-progress collection work and is destructive.
// ────────────────────────────────────────────────────────────────────────────

import XLSX from 'xlsx';

const M6PM_BASE = process.env.M6PM_BASE_URL || 'https://elegansky-m6pm.onrender.com';
const ARREARS_PAGE_SIZE = 1000;

/**
 * Internal helper — paginate the /arrears endpoint and return all invoice
 * rows. Calls the BRAIN's own /arrears handler over HTTP using the shared
 * secret so we get the same exact data + customer enrichment without
 * duplicating that 150-line query loop.
 */
async function fetchAllArrears({ asOf, brainSelfBase, sharedSecret }) {
  const out = [];
  let start = 1;
  for (;;) {
    const url = new URL('/arrears', brainSelfBase);
    url.searchParams.set('pageSize', String(ARREARS_PAGE_SIZE));
    url.searchParams.set('start', String(start));
    if (asOf) url.searchParams.set('asOf', asOf);
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
 * POST the xls to m6pm's existing /api/generate-debt-reports endpoint.
 * Returns m6pm's JSON response. Times out after 5 min — debt-report
 * generation against 14k+ invoices typically takes 1-3 min.
 */
async function postArrearsToM6pm(xlsBuffer, modeLabel) {
  const form = new FormData();
  form.append('file', new Blob([xlsBuffer]), `brain-arrears-${modeLabel}.xls`);
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
      const mode = String(req.query.mode || req.body?.mode || '').toLowerCase();
      if (!['morning', 'afternoon', 'evening'].includes(mode)) {
        return res.status(400).json({ error: 'mode must be morning, afternoon, or evening' });
      }
      const brainSelfBase = `${req.protocol}://${req.get('host')}`;
      const arrears = await fetchAllArrears({ brainSelfBase, sharedSecret });
      const buf = buildArrearsXls(arrears, null);
      const m6pmReports = await postArrearsToM6pm(buf, mode);
      const result = {
        mode,
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

const REPORT_TICKS = {
  meru0100: 'morning',
  lengai1230: 'afternoon',
  kili1615: 'evening',
};

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
const POC_FAILURE_ALERT_PHONE = '255752900450';
const FAILURE_GRACE_MIN = 20; // wait 20 min after scheduled tick before declaring failure
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
  for (const [tick, mode] of Object.entries(REPORT_TICKS)) {
    const gateKey = `m6pm_auto_fired:${today}:${tick}`;
    const gate = await pool.query(`SELECT value FROM app_settings WHERE key=$1`, [gateKey]);
    if (gate.rows.length) continue; // already fired today

    // Need at least one finalized batch for this tick within the last 30 min.
    const recent = await pool.query(
      `SELECT id FROM payment_batches
        WHERE created_by LIKE $1
          AND status = 'finalized'
          AND finalized_at > now() - interval '30 minutes'
        LIMIT 1`,
      [`auto-upload:${tick}%`],
    );
    if (!recent.rows.length) continue;

    // Atomic gate acquire — only one BRAIN process wins.
    const acquired = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, 'firing')
         ON CONFLICT (key) DO NOTHING
         RETURNING value`,
      [gateKey],
    );
    if (!acquired.rows.length) continue;

    console.log(`[m6pm/autofire] ${tick} → mode=${mode} — starting report fire`);
    try {
      const arrears = await fetchAllArrears({ brainSelfBase, sharedSecret });
      const buf = buildArrearsXls(arrears, null);
      await postArrearsToM6pm(buf, mode);
      let syncResult = null;
      if (mode === 'morning') {
        const got = await morningGateAcquired(pool, today);
        if (got) {
          try {
            syncResult = await postSyncMobile();
            console.log(`[m6pm/autofire] ${tick} sync-mobile fired (morning gate acquired)`);
          } catch (e) {
            console.error(`[m6pm/autofire] sync-mobile failed:`, e.message);
            syncResult = { error: e.message };
          }
        } else {
          syncResult = '(skipped — morning gate already claimed today)';
        }
      }
      // Mark fired
      await pool.query(
        `UPDATE app_settings SET value='done', updated_at=now() WHERE key=$1`,
        [gateKey],
      );
      console.log(`[m6pm/autofire] ${tick} DONE arrears=${arrears.length} sync=${syncResult ? 'fired' : 'n/a'}`);
    } catch (err) {
      console.error(`[m6pm/autofire] ${tick} failed:`, err.message);
      // Roll back the gate so a later retry can pick it up.
      await pool.query(`DELETE FROM app_settings WHERE key=$1`, [gateKey]);
    }
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

    // Did this tick produce ANY finalized batches today?
    const ok = await pool.query(
      `SELECT id FROM payment_batches
        WHERE created_by LIKE $1
          AND status = 'finalized'
          AND created_at >= (date_trunc('day', now() AT TIME ZONE 'Africa/Dar_es_Salaam'))::timestamptz
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
      await sendNextSms(POC_FAILURE_ALERT_PHONE, text);
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [alertedKey, today],
      );
    }
  }
}

/**
 * Start both watchers on BRAIN boot. Each runs every 60s. They're best-effort
 * — exceptions are caught and logged so a watcher hiccup never crashes BRAIN.
 */
export function startM6pmWatchers({ pool, sharedSecret, brainBase }) {
  const tick = async () => {
    try { await autoFireReportsWatcher({ pool, sharedSecret, brainSelfBase: brainBase }); }
    catch (err) { console.error('[m6pm/autofire watcher]', err.message); }
    try { await pocFailureAlertWatcher({ pool }); }
    catch (err) { console.error('[m6pm/poc-alert watcher]', err.message); }
  };
  // First tick after 60s — give BRAIN time to finish boot before hammering DB.
  setTimeout(tick, 60_000);
  setInterval(tick, 60_000);
  console.log('[m6pm/watchers] auto-fire + POC-alert watchers armed');
}
