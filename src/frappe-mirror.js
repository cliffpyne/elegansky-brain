// ───────────────────────────────────────────────────────────────────────────
// Frappe → Postgres mirror (Payment Entry).
//
// Same shape as src/qb-mirror.js. Two jobs:
//   1. backfillPayments()  — initial full pull, paginated by `modified`.
//   2. cdcSyncPayments()   — incremental delta since high-water mark.
//   plus upsertPayment()   — single-row mutator, callable from webhooks.
//
// Frappe pagination via /api/resource/Payment Entry with filters + fields.
// High-water mark: frappe_mirror_state.last_cdc_at for 'PaymentEntry'.
// ───────────────────────────────────────────────────────────────────────────

import { db } from './db/pool.js';

const PAGE = 500;
const CDC_OVERLAP_MS = 5 * 60 * 1000;  // 5 min overlap on every poll

function baseUrl() {
  const u = (process.env.FRAPPE_BASE_URL || '').trim();
  if (!u) throw new Error('FRAPPE_BASE_URL not set');
  return u.replace(/\/+$/, '');
}
function authHeader() {
  const t = (process.env.FRAPPE_API_TOKEN || '').trim();
  if (!t.includes(':')) throw new Error('FRAPPE_API_TOKEN must be "<api_key>:<api_secret>"');
  return { Authorization: `token ${t}` };
}

// ── Upsert ───────────────────────────────────────────────────────────────

/**
 * Upsert one Payment Entry row into frappe_payments.
 * `pe` is a Frappe Payment Entry dict — must have name, party, posting_date,
 * paid_amount. Other fields optional.
 */
export async function upsertPayment(pe, client = db()) {
  await client.query(
    `INSERT INTO frappe_payments
       (name, party, posting_date, paid_amount, mode_of_payment,
        reference_no, docstatus, frappe_modified, mirror_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, now())
     ON CONFLICT (name) DO UPDATE SET
       party            = EXCLUDED.party,
       posting_date     = EXCLUDED.posting_date,
       paid_amount      = EXCLUDED.paid_amount,
       mode_of_payment  = EXCLUDED.mode_of_payment,
       reference_no     = EXCLUDED.reference_no,
       docstatus        = EXCLUDED.docstatus,
       frappe_modified  = EXCLUDED.frappe_modified,
       mirror_synced_at = now()`,
    [
      String(pe.name),
      String(pe.party || ''),
      pe.posting_date || null,
      Number(pe.paid_amount || 0),
      pe.mode_of_payment || null,
      pe.reference_no || null,
      Number.isFinite(Number(pe.docstatus)) ? Number(pe.docstatus) : 1,
      pe.modified || null,
    ],
  );
}

// ── Fetch page from Frappe ───────────────────────────────────────────────

async function fetchPage({ filters, orderBy = 'modified asc', start = 0, limit = PAGE }) {
  const fields = ['name', 'party', 'posting_date', 'paid_amount', 'mode_of_payment', 'reference_no', 'docstatus', 'modified'];
  const url = `${baseUrl()}/api/resource/Payment Entry`
    + `?filters=${encodeURIComponent(JSON.stringify(filters || []))}`
    + `&fields=${encodeURIComponent(JSON.stringify(fields))}`
    + `&order_by=${encodeURIComponent(orderBy)}`
    + `&limit_start=${start}&limit_page_length=${limit}`;
  const r = await fetch(url, { headers: { ...authHeader(), Accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`frappe-mirror fetchPage HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const j = await r.json();
  return j.data || [];
}

// ── Backfill ─────────────────────────────────────────────────────────────

/**
 * Initial full pull. Paginates through EVERY Payment Entry, upserting each.
 * Sets frappe_mirror_state high-water mark to the last row's `modified`.
 * Safe to re-run — ON CONFLICT DO UPDATE keeps mirror idempotent.
 */
export async function backfillPayments() {
  let start = 0;
  let total = 0;
  let lastModified = null;
  while (true) {
    const page = await fetchPage({ filters: [], start, limit: PAGE });
    if (!page.length) break;
    for (const pe of page) {
      await upsertPayment(pe);
      if (pe.modified) lastModified = pe.modified;
      total++;
    }
    console.log(`[frappe-mirror] backfill: page start=${start} size=${page.length} (total=${total})`);
    if (page.length < PAGE) break;
    start += PAGE;
  }
  const hwm = lastModified || new Date().toISOString();
  await db().query(
    `INSERT INTO frappe_mirror_state (entity, last_cdc_at, last_backfill_at, rows_synced)
     VALUES ($1, $2::timestamptz, now(), $3)
     ON CONFLICT (entity) DO UPDATE SET
       last_cdc_at      = GREATEST(frappe_mirror_state.last_cdc_at, EXCLUDED.last_cdc_at),
       last_backfill_at = EXCLUDED.last_backfill_at,
       rows_synced      = frappe_mirror_state.rows_synced + EXCLUDED.rows_synced`,
    ['PaymentEntry', hwm, total],
  );
  return { total, high_water_mark: hwm };
}

// ── CDC sync ─────────────────────────────────────────────────────────────

/**
 * Incremental sync. Pulls Payment Entries with `modified` > (last_cdc_at -
 * CDC_OVERLAP_MS). Upserts each. Advances the high-water mark to the max
 * `modified` seen.
 * If no state row exists yet, throws — caller should backfillPayments first.
 */
export async function cdcSyncPayments() {
  const s = await db().query(
    `SELECT last_cdc_at FROM frappe_mirror_state WHERE entity = $1`,
    ['PaymentEntry'],
  );
  if (!s.rows.length) throw new Error('cdcSyncPayments: no frappe_mirror_state row; run backfillPayments first');
  const lastCdcAt = new Date(s.rows[0].last_cdc_at);
  const since = new Date(lastCdcAt.getTime() - CDC_OVERLAP_MS).toISOString();

  let start = 0;
  let total = 0;
  let newHwm = null;
  while (true) {
    const page = await fetchPage({
      filters: [['modified', '>', since]],
      orderBy: 'modified asc',
      start, limit: PAGE,
    });
    if (!page.length) break;
    for (const pe of page) {
      await upsertPayment(pe);
      if (pe.modified && (!newHwm || pe.modified > newHwm)) newHwm = pe.modified;
      total++;
    }
    if (page.length < PAGE) break;
    start += PAGE;
  }
  if (total > 0 && newHwm) {
    await db().query(
      `UPDATE frappe_mirror_state SET last_cdc_at = $1::timestamptz, rows_synced = rows_synced + $2 WHERE entity = $3`,
      [newHwm, total, 'PaymentEntry'],
    );
  }
  return { total, since, new_high_water_mark: newHwm };
}

// ── Reads ────────────────────────────────────────────────────────────────

/**
 * Sum of paid_amount on frappe_payments (docstatus=1 = submitted) for the
 * given party on the given date. Used by the officer/mega comparison to
 * add Frappe payments on top of qb_payments for APRUNA customers.
 */
export async function sumFrappePaidByPartyOnDate(party, ymdDate, client = db()) {
  const r = await client.query(
    `SELECT COALESCE(SUM(paid_amount), 0)::numeric AS total
       FROM frappe_payments
      WHERE party = $1 AND posting_date = $2::date AND docstatus = 1`,
    [party, ymdDate],
  );
  return Number(r.rows[0].total || 0);
}

/**
 * Same for a set of parties (batch lookup), returning Map<party, total>.
 */
export async function sumFrappePaidForPartiesOnDate(parties, ymdDate, client = db()) {
  const m = new Map();
  if (!parties || !parties.length) return m;
  const r = await client.query(
    `SELECT party, COALESCE(SUM(paid_amount), 0)::numeric AS total
       FROM frappe_payments
      WHERE party = ANY($1) AND posting_date = $2::date AND docstatus = 1
      GROUP BY party`,
    [parties, ymdDate],
  );
  for (const row of r.rows) m.set(String(row.party), Number(row.total || 0));
  return m;
}
