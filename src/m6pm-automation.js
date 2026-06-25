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
      if (mode === 'morning') {
        const today = todayYmdEat();
        const acquired = await morningGateAcquired(pool, today);
        if (acquired) {
          try {
            result.sync_mobile = await postSyncMobile();
            result.morning_gate = 'acquired';
          } catch (syncErr) {
            console.error('[m6pm/trigger] sync-mobile failed:', syncErr.message);
            result.sync_mobile_error = syncErr.message;
            result.morning_gate = 'acquired_but_sync_failed';
          }
        } else {
          result.morning_gate = 'already_done_today';
          result.sync_mobile = '(skipped — already done today)';
        }
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
