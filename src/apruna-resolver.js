// ───────────────────────────────────────────────────────────────────────────
// APRUNA THOMAS BODA customer resolver
//
// Backed by Frappe's elegansky.api.savcom_customers?officer=APRUNA THOMAS BODA
// (same endpoint as SAVCOM, just a different officer filter — Frappe dev
// confirmed 2026-07-10 that the officer param already exists on this route).
//
// As of 2026-07-17: Frappe now returns two cohorts under APRUNA THOMAS BODA:
//   - Old cohort (~217): each carries qb_id (dual-write source).
//   - New cohort (32 as of 2026-07-17, growing): Frappe-only, qb_id EMPTY.
//     These are keyed by plate. Frank re-mirrored Frappe so ALL APRUNA
//     customers (old + new) land in Frappe. Routing target: Frappe only,
//     NOT QB (the boss's rule stays: never write to live QB for APRUNA).
//
// The resolver indexes by ALL available signals:
//   - byQbId  (exact match for legacy dual-write path)
//   - byPlate (trimmed, upper-cased — Frappe sometimes stores trailing \t)
//   - byPhone (last-9-digits, canonical form)
//
// Cache: in-memory, 1 hour TTL, stale-fallback on refresh error (mirror of
// savcom-resolver.js).
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const TTL_MS = 60 * 60 * 1000;
const OFFICER = 'APRUNA THOMAS BODA';

let _cache = null; // { fetchedAt, byQbId, byPlate, byPhone, ... }
let _inflight = null;

function cleanPlate(p) {
  return String(p || '').trim().toUpperCase().replace(/\s+/g, '');
}
function cleanPhone9(p) {
  const digits = String(p || '').replace(/\D/g, '');
  if (!digits) return '';
  return digits.startsWith('255') ? digits.slice(3) : digits.slice(-9);
}

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

async function fetchAprunaCustomers() {
  const url = `${baseUrl()}/api/method/elegansky.api.savcom_customers?officer=${encodeURIComponent(OFFICER)}`;
  const r = await fetch(url, {
    headers: { ...authHeader(), Accept: 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!r.ok) {
    const text = await r.text().catch(() => '');
    throw new Error(`apruna_customers HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  const list = data.message || data;
  if (!Array.isArray(list)) throw new Error(`apruna_customers unexpected shape: ${JSON.stringify(data).slice(0, 200)}`);
  return list;
}

function buildIndex(list) {
  const byQbId = new Map();
  const byPlate = new Map();
  const byPhone = new Map();
  let missing_qb_id = 0;
  let frappe_only = 0;
  for (const c of list) {
    const qbId = String(c.qb_id || c.eg_qb_id || '').trim();
    const entry = {
      qb_id: qbId || null,
      customer: c.customer || c.name || null,
      display_name: c.display_name || c.customer_name || null,
      plate: cleanPlate(c.plate),
      phone9: cleanPhone9(c.phone),
      source: c.source || null,
      raw: c,
    };
    if (qbId) byQbId.set(qbId, entry);
    else { missing_qb_id++; if ((entry.source || '') === 'frappe') frappe_only++; }
    if (entry.plate) byPlate.set(entry.plate, entry);
    if (entry.phone9) byPhone.set(entry.phone9, entry);
  }
  return { byQbId, byPlate, byPhone, missing_qb_id, frappe_only, total: list.length };
}

/**
 * Get the cached APRUNA roster. Refreshes when TTL expires; on refresh
 * failure returns stale cache rather than empty so a Frappe hiccup doesn't
 * silently disable dual-write for every payment mid-batch.
 */
export async function getAprunaCache({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && (now - _cache.fetchedAt) < TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const list = await fetchAprunaCustomers();
      const idx = buildIndex(list);
      _cache = { fetchedAt: now, ...idx };
      console.log(`[apruna-resolver] cached ${idx.total} customers — `
        + `byQbId=${idx.byQbId.size} byPlate=${idx.byPlate.size} byPhone=${idx.byPhone.size}`
        + (idx.frappe_only ? ` (${idx.frappe_only} frappe-only, no qb_id)` : ''));
      return _cache;
    } catch (err) {
      if (_cache) {
        console.warn(`[apruna-resolver] refresh failed (${err.message}); serving stale cache from ${new Date(_cache.fetchedAt).toISOString()}`);
        return _cache;
      }
      throw err;
    } finally {
      _inflight = null;
    }
  })();
  return _inflight;
}

/**
 * Look up a single QB customer id in the APRUNA roster.
 * Returns { qb_id, customer, display_name, source, plate, phone9 } or null.
 */
export async function resolveAprunaByQbId(qbId) {
  if (!qbId) return null;
  const cache = await getAprunaCache();
  return cache.byQbId.get(String(qbId)) || null;
}

/**
 * Look up an APRUNA customer by plate. Handles trailing whitespace / case
 * variations. Covers the Frappe-only cohort (32 as of 2026-07-17) whose
 * qb_id is empty, and the legacy cohort where plate is populated.
 */
export async function resolveAprunaByPlate(plate) {
  if (!plate) return null;
  const key = cleanPlate(plate);
  if (!key) return null;
  const cache = await getAprunaCache();
  return cache.byPlate.get(key) || null;
}

/**
 * Look up an APRUNA customer by phone (last-9-digit canonical form).
 * Useful as a backup for CRDB rows where the memo contains the sender phone.
 */
export async function resolveAprunaByPhone(phone) {
  if (!phone) return null;
  const key = cleanPhone9(phone);
  if (!key || key.length < 9) return null;
  const cache = await getAprunaCache();
  return cache.byPhone.get(key) || null;
}

/**
 * Convenience: try qb_id → plate → phone in order. Returns the first hit.
 * Callers on the fire path use this so a single check answers
 * "is this an APRUNA customer that should route to Frappe, not QB?".
 */
export async function resolveAprunaAny({ qb_id, plate, phone } = {}) {
  if (qb_id) {
    const r = await resolveAprunaByQbId(qb_id);
    if (r) return r;
  }
  if (plate) {
    const r = await resolveAprunaByPlate(plate);
    if (r) return r;
  }
  if (phone) {
    const r = await resolveAprunaByPhone(phone);
    if (r) return r;
  }
  return null;
}

/** Introspection helper for admin endpoints. */
export async function getAprunaStats() {
  const cache = await getAprunaCache();
  return {
    total_customers: cache.total,
    with_qb_id: cache.byQbId.size,
    frappe_only: cache.frappe_only || 0,
    by_plate: cache.byPlate.size,
    by_phone: cache.byPhone.size,
    fetched_at: new Date(cache.fetchedAt).toISOString(),
    cache_age_seconds: Math.round((Date.now() - cache.fetchedAt) / 1000),
    ttl_seconds: TTL_MS / 1000,
    sample: [...cache.byPlate.values()].slice(0, 5),
  };
}

/** Test-only helper. */
export function _resetCacheForTests() {
  _cache = null;
  _inflight = null;
}
