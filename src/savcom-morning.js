// ───────────────────────────────────────────────────────────────────────────
// SAVCOM morning ritual — Frappe-native arrears chain
//
// Frank 2026-06-29: a parallel ritual to the QB-side morning fire, but
// the source of truth is Frappe (the new elegansky.api.arrears endpoint).
// Phones come from the pikipiki records2 tab via savcom-phones.js.
//
// Chain (per fire):
//   1. Pull Frappe arrears (officer=ESTHER SAVCOM by default).
//   2. Build an m6pm-compatible xls so officers see a SAVCOM debt report
//      alongside their QB debt reports.
//   3. POST to m6pm /api/generate-debt-reports with mode tag
//      "savcom_morning" so the report file lives on the persistent disk
//      with a clear name + signed link.
//   4. Send a customer overdue SMS to every SAVCOM customer that has a
//      phone in pikipiki records2. SMS body starts with "SAVCOM:" so
//      customers know which loan it's about.
//   5. Send a master-admin completion SMS with "SAVCOM" word so admins
//      know it's the SAVCOM run completing (distinguishable from the
//      regular NMB/CRDB tick SMS).
//
// dry_run=1: chain runs without sending real SMS or hitting Frappe writes.
// Returns the planned payloads + would-send count so the operator can
// eyeball coverage before firing real.
// ───────────────────────────────────────────────────────────────────────────

import * as XLSX from 'xlsx';
import crypto from 'crypto';
import { lookupSavcomPhone, getPhoneCacheStats } from './savcom-phones.js';

const FRAPPE_BASE = () => (process.env.FRAPPE_BASE_URL || '').replace(/\/$/, '');
const FRAPPE_TOKEN = () => process.env.FRAPPE_API_TOKEN || '';
const M6PM_BASE = () => process.env.M6PM_BASE_URL || 'https://elegansky-m6pm.onrender.com';
const NEXTSMS_API = 'https://messaging-service.co.tz/api/sms/v1/text/single';

// Re-use the same master-admin phone the existing watchers use.
const MASTER_ADMIN_PHONE = '255752900450';

// Signed-link config (mirrors signedReportUrl in m6pm-automation.js so the
// admin broadcast link verifies on the m6pm receiver side).
const REPORT_LINK_SECRET = () => process.env.REPORT_LINK_SECRET || '';
const REPORT_LINK_BASE = () => process.env.REPORT_LINK_BASE || 'https://www.eleganskyboda.com';
const REPORT_LINK_TTL_HOURS = 72;

// Admin broadcast list (mirrors broadcastPhones() in m6pm-automation.js).
const DEFAULT_BROADCAST_PHONES = [
  '255752900450', '255719864511', '255785422245', '255713123778',
];
function broadcastPhones() {
  const raw = (process.env.SMS_BROADCAST_PHONES || '').trim();
  if (!raw) return DEFAULT_BROADCAST_PHONES;
  return raw.split(',').map((p) => p.trim()).filter(Boolean);
}

function signedSavcomReportUrl({ date, mode = 'savcom_morning' }) {
  const secret = REPORT_LINK_SECRET();
  if (!secret) return null;
  const exp = Math.floor(Date.now() / 1000) + REPORT_LINK_TTL_HOURS * 3600;
  const payload = `${date}|${mode}|*|${exp}`;
  const sig = crypto.createHmac('sha256', secret).update(payload).digest('hex');
  const u = new URL('/api/p/reports/page', REPORT_LINK_BASE());
  u.searchParams.set('date', date);
  u.searchParams.set('exp', String(exp));
  u.searchParams.set('sig', sig);
  u.searchParams.set('mode', mode);
  return u.toString();
}

// ─── Frappe arrears fetch ──────────────────────────────────────────────────

async function fetchFrappeArrears({ officer = 'ESTHER SAVCOM', minAmount = 0 } = {}) {
  const base = FRAPPE_BASE();
  const token = FRAPPE_TOKEN();
  if (!base) throw new Error('FRAPPE_BASE_URL not set');
  if (!token || !token.includes(':')) throw new Error('FRAPPE_API_TOKEN must be "<api_key>:<api_secret>"');
  const qs = new URLSearchParams();
  if (officer) qs.set('officer', officer);
  if (minAmount > 0) qs.set('min_amount', String(minAmount));
  const url = `${base}/api/method/elegansky.api.arrears${qs.toString() ? '?' + qs.toString() : ''}`;
  const r = await fetch(url, {
    headers: { Authorization: `token ${token}`, Accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`Frappe arrears ${r.status}: ${text.slice(0, 300)}`);
  }
  const data = await r.json();
  const msg = data.message || data;
  if (!msg || !Array.isArray(msg.rows)) throw new Error(`Frappe arrears: unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  return msg;
}

// ─── xls build (m6pm-compatible) ───────────────────────────────────────────

function buildSavcomArrearsXls(arrears, asOf) {
  // m6pm expects this header shape (matches buildArrearsXls in m6pm-automation).
  // We produce ONE row per overdue customer carrying their oldest_due_date
  // + total_arrears. m6pm's debt-report generation groups by Customer and
  // sums, so summary-per-customer works for officers' file.
  const aoa = [
    [`Type: Invoices Status: Overdue Date: All${asOf ? '   As of ' + asOf : ''} (SAVCOM)`],
    ['Date', 'Type', 'No.', 'Customer', 'Memo', 'Balance', 'Amount', 'Status'],
  ];
  for (const r of arrears.rows) {
    aoa.push([
      // Reformat YYYY-MM-DD → MM/DD/YYYY (the format QB exports use, what
      // m6pm's parser expects).
      String(r.oldest_due_date || '').replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$2/$3/$1'),
      'Invoice',
      // Use a synthetic No. — Frappe rolls per-customer, no single invoice no.
      `SAVCOM-${r.customer || r.display_name || 'unknown'}`.slice(0, 60),
      r.display_name || r.customer || '',
      `${r.overdue_invoices || 0} overdue invoice(s)`,
      Number(r.total_arrears) || 0,
      Number(r.total_arrears) || 0,
      'overdue',
    ]);
  }
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'SAVCOM Arrears');
  return XLSX.write(wb, { bookType: 'biff8', type: 'buffer' });
}

// ─── m6pm report upload ────────────────────────────────────────────────────

async function postSavcomReportToM6pm(xlsBuffer, modeLabel = 'savcom_morning') {
  const form = new FormData();
  form.append('file', new Blob([xlsBuffer]), `brain-savcom-${modeLabel}.xls`);
  if (modeLabel) form.append('report_mode', modeLabel);
  const r = await fetch(`${M6PM_BASE()}/api/generate-debt-reports`, {
    method: 'POST',
    body: form,
    signal: AbortSignal.timeout(5 * 60_000),
  });
  const text = await r.text();
  if (!r.ok) throw new Error(`m6pm generate-debt-reports ${r.status}: ${text.slice(0, 300)}`);
  try { return JSON.parse(text); } catch { return { raw: text }; }
}

// ─── NextSMS ───────────────────────────────────────────────────────────────

async function sendNextSms(phone, text) {
  const user = process.env.NEXTSMS_USERNAME;
  const pass = process.env.NEXTSMS_PASSWORD;
  const sender = process.env.NEXTSMS_SENDER_ID || 'NEXTSMS';
  if (!user || !pass) return { skipped: true, reason: 'no_credentials' };
  const auth = Buffer.from(`${user}:${pass}`).toString('base64');
  const r = await fetch(NEXTSMS_API, {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
      Accept: 'application/json',
    },
    body: JSON.stringify({ from: sender, to: String(phone), text: String(text) }),
    signal: AbortSignal.timeout(30_000),
  });
  const j = await r.json().catch(() => ({}));
  const status = j?.messages?.[0]?.status?.description || (r.ok ? 'sent' : 'error');
  return { ok: r.ok, status, response: j };
}

// ─── customer SMS body ─────────────────────────────────────────────────────

function buildCustomerSmsBody({ name, total_arrears, overdue_invoices, oldest_due_date }) {
  // Frank's rule: "SAVCOM" word in the message so customers know what
  // loan it refers to. Kiswahili wording mirrors the existing m6pm
  // overdue SMS style.
  const amt = Number(total_arrears) || 0;
  const amtStr = amt.toLocaleString('en-US');
  const firstName = String(name || '').trim().split(/\s+/)[0] || 'Mteja';
  return `SAVCOM: Habari ${firstName}, una deni la TZS ${amtStr} (${overdue_invoices || 0} invoice). Tafadhali lipa haraka. Asante.`;
}

// ─── full ritual ───────────────────────────────────────────────────────────

export async function runSavcomMorningRitual({
  dryRun = false, officer = 'ESTHER SAVCOM', pool = null, force = false,
} = {}) {
  const ymd = new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10); // EAT date

  // Idempotency gate (Frank 2026-06-29 — after a curl-timeout double-fire
  // sent every customer 2 SMS). Once today's SAVCOM ritual succeeds, the
  // gate row is set and subsequent fires no-op until tomorrow. force=true
  // overrides (e.g. when operator confirms an earlier fire only partial-
  // dispatched and wants to retry).
  const gateKey = `savcom_morning_done:${ymd}`;
  if (pool && !dryRun && !force) {
    const r = await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ($1, 'firing')
         ON CONFLICT (key) DO NOTHING RETURNING value`,
      [gateKey],
    );
    if (!r.rows.length) {
      const existing = await pool.query(`SELECT value, updated_at FROM app_settings WHERE key = $1`, [gateKey]);
      return {
        skipped: true,
        reason: 'savcom_morning_already_fired_today',
        ymd,
        gate_state: existing.rows[0]?.value,
        gate_set_at: existing.rows[0]?.updated_at,
        hint: 'pass force=1 to override (operator confirms previous fire was partial)',
      };
    }
  }

  // 1. Frappe arrears
  const arrears = await fetchFrappeArrears({ officer });
  // 2. xls
  const xlsBuf = buildSavcomArrearsXls(arrears, ymd);
  // 3. m6pm debt report upload (safe both in dry-run and real fire — it
  //    just generates the per-officer file, no SMS to officers).
  let m6pmReport = null;
  try {
    m6pmReport = await postSavcomReportToM6pm(xlsBuf, 'savcom_morning');
  } catch (e) {
    m6pmReport = { error: e.message };
  }

  // 4. Per-customer phone lookup + SMS dispatch.
  const sent = [];
  const skipped = [];
  for (const c of arrears.rows) {
    const lookup = await lookupSavcomPhone({
      plate: c.plate,
      wakandi_member_id: c.wakandi_member_id,
      name: c.display_name || c.customer,
    });
    if (!lookup) {
      skipped.push({
        customer: c.customer,
        display_name: c.display_name,
        plate: c.plate,
        wakandi_member_id: c.wakandi_member_id,
        reason: 'no_phone_in_pikipiki_records2',
        amount: c.total_arrears,
      });
      continue;
    }
    const body = buildCustomerSmsBody({
      name: c.display_name || c.customer,
      total_arrears: c.total_arrears,
      overdue_invoices: c.overdue_invoices,
      oldest_due_date: c.oldest_due_date,
    });
    if (dryRun) {
      sent.push({
        customer: c.display_name || c.customer, phone: lookup.phone, via: lookup.via,
        body, amount: c.total_arrears, dry_run: true,
      });
      continue;
    }
    try {
      const r = await sendNextSms(lookup.phone, body);
      sent.push({
        customer: c.display_name || c.customer, phone: lookup.phone, via: lookup.via,
        status: r?.status, ok: r?.ok, amount: c.total_arrears,
      });
    } catch (e) {
      sent.push({
        customer: c.display_name || c.customer, phone: lookup.phone, via: lookup.via,
        status: 'error', error: String(e.message || e).slice(0, 200),
      });
    }
  }

  const okCount = sent.filter((s) => s.ok || s.dry_run || s.status === 'sent' || s.status === 'Message sent to next instance').length;
  const errCount = sent.length - okCount;
  const totalArrears = arrears.total_arrears || arrears.rows.reduce((s, r) => s + (Number(r.total_arrears) || 0), 0);

  // 5. Admin completion SMS (master admin only — distinguishable from the
  //    general broadcast list so admins know which run finished).
  const adminText = dryRun
    ? `BRAIN SAVCOM ${ymd} DRY-RUN: ${arrears.customers_in_arrears || arrears.rows.length} customers, ${totalArrears.toLocaleString('en-US')} TZS overdue. Would dispatch ${okCount}, skip ${skipped.length} (no phone). Report ${m6pmReport?.error ? 'FAILED' : 'ok'}.`
    : `BRAIN SAVCOM ${ymd} done: ${arrears.customers_in_arrears || arrears.rows.length} customers, ${totalArrears.toLocaleString('en-US')} TZS overdue. SMS sent: ${okCount}, errors: ${errCount}, no-phone: ${skipped.length}. Report ${m6pmReport?.error ? 'FAILED' : 'ok'}.`;
  let adminSms = null;
  if (!dryRun) {
    try { adminSms = await sendNextSms(MASTER_ADMIN_PHONE, adminText); }
    catch (e) { adminSms = { error: e.message }; }
  }

  // 6. Broadcast link SMS to all admins so they (and anyone they forward
  //    to) can pull the SAVCOM debt-report file. Frank 2026-06-29 — same
  //    shape as the regular morning broadcast, distinguished by "SAVCOM"
  //    word in the text.
  let broadcastResults = [];
  if (!dryRun) {
    const link = signedSavcomReportUrl({ date: ymd, mode: 'savcom_morning' });
    if (link) {
      const linkText = `BRAIN SAVCOM morning report (${ymd}) ready: ${link}`;
      for (const phone of broadcastPhones()) {
        try {
          const r = await sendNextSms(phone, linkText);
          broadcastResults.push({ phone, ok: r?.ok, status: r?.status });
        } catch (e) {
          broadcastResults.push({ phone, ok: false, error: String(e.message || e).slice(0, 200) });
        }
      }
    } else {
      broadcastResults = [{ skipped: true, reason: 'REPORT_LINK_SECRET unset' }];
    }
  }

  // 7. Flip gate to 'done' so subsequent calls today no-op (unless force=1).
  if (pool && !dryRun) {
    try {
      await pool.query(
        `UPDATE app_settings SET value='done', updated_at=now() WHERE key=$1`,
        [gateKey],
      );
    } catch (e) { console.error('[savcom/morning] gate flip failed:', e.message); }
  }

  return {
    dry_run: !!dryRun,
    as_of: ymd,
    officer,
    arrears_source: 'frappe(elegansky.api.arrears)',
    customers_in_arrears: arrears.customers_in_arrears || arrears.rows.length,
    total_arrears: totalArrears,
    m6pm_report: m6pmReport,
    sms_dispatch: {
      total: sent.length,
      ok: okCount,
      error: errCount,
      skipped_no_phone: skipped.length,
    },
    admin_sms: adminSms,
    admin_text: adminText,
    broadcast_link_sms: broadcastResults,
    skipped_no_phone_sample: skipped.slice(0, 10),
    sent_sample: sent.slice(0, 5),
  };
}

// ─── API mount ─────────────────────────────────────────────────────────────

export function mountSavcomMorningApi(app, { requireSecretOrJwt, pool }) {
  // Main entry — operator fires the full SAVCOM ritual.
  // ?force=1 overrides the per-day idempotency gate (operator confirms a
  // prior fire only partial-dispatched and wants to retry).
  app.post('/api/admin/savcom/morning-ritual', requireSecretOrJwt, async (req, res) => {
    try {
      const dryRun = req.query.dry_run === '1' || req.body?.dry_run === true;
      const force = req.query.force === '1' || req.body?.force === true;
      const officer = String(req.query.officer || req.body?.officer || 'ESTHER SAVCOM');
      const result = await runSavcomMorningRitual({ dryRun, officer, pool, force });
      res.json(result);
    } catch (err) {
      console.error('[savcom/morning-ritual]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Phone-lookup proxy for the Frappe dev (Path B per Frank's choice
  // 2026-06-29). Frappe queries this instead of reading the sheet
  // directly. Gated by STATEMENT_REPORT_SECRET so we don't leak phones.
  app.get('/api/savcom/phone-lookup', async (req, res) => {
    const secret = process.env.STATEMENT_REPORT_SECRET;
    const hdr = req.header('x-report-secret') || req.query.secret;
    if (!secret || hdr !== secret) {
      return res.status(401).json({ error: 'unauthorized — pass X-Report-Secret header or ?secret' });
    }
    try {
      const r = await lookupSavcomPhone({
        plate: req.query.plate,
        wakandi_member_id: req.query.wakandi_id || req.query.wakandi_member_id,
        name: req.query.name,
      });
      if (!r) return res.status(404).json({ found: false });
      res.json({ found: true, phone: r.phone, via: r.via, record: r.record });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // Cache stats — useful when the sheet's been updated and we want to
  // know if BRAIN's seen the change yet.
  app.get('/api/admin/savcom/phone-cache', requireSecretOrJwt, async (_req, res) => {
    try { res.json(await getPhoneCacheStats()); }
    catch (err) { res.status(500).json({ error: err.message }); }
  });
}
