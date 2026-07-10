// ───────────────────────────────────────────────────────────────────────────
// APRUNA THOMAS BODA customer resolver
//
// Backed by Frappe's elegansky.api.savcom_customers?officer=APRUNA THOMAS BODA
// (same endpoint as SAVCOM, just a different officer filter — Frappe dev
// confirmed 2026-07-10 that the officer param already exists on this route).
// Returns 217 customers (as of 2026-07-10) — every one carries qb_id, so the
// map is qb_id → customer and matching is exact 1:1. No plate/wakandi/name
// fuzz needed for APRUNA (those fields are empty for this book).
//
// Cache: in-memory, 1 hour TTL, stale-fallback on refresh error (mirror of
// savcom-resolver.js).
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const TTL_MS = 60 * 60 * 1000;
const OFFICER = 'APRUNA THOMAS BODA';

let _cache = null; // { fetchedAt, byQbId: Map<string, customer>, all }
let _inflight = null;

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
  let missing_qb_id = 0;
  for (const c of list) {
    const qbId = String(c.qb_id || c.eg_qb_id || '').trim();
    if (!qbId) { missing_qb_id++; continue; }
    // Frappe returns the customer's Frappe primary key as `customer` (or `name`).
    // ingest_payment accepts either the qb_id OR the customer name; we cache both
    // so the pusher can send whichever is preferred.
    byQbId.set(qbId, {
      qb_id: qbId,
      customer: c.customer || c.name || null,
      display_name: c.display_name || c.customer_name || null,
      source: c.source || null,
      raw: c,
    });
  }
  return { byQbId, missing_qb_id, total: list.length };
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
      console.log(`[apruna-resolver] cached ${idx.total} customers, ${idx.byQbId.size} with qb_id`
        + (idx.missing_qb_id ? ` (skipped ${idx.missing_qb_id} without qb_id)` : ''));
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
 * Returns { qb_id, customer, display_name, source } or null.
 */
export async function resolveAprunaByQbId(qbId) {
  if (!qbId) return null;
  const cache = await getAprunaCache();
  return cache.byQbId.get(String(qbId)) || null;
}

/** Introspection helper for admin endpoints. */
export async function getAprunaStats() {
  const cache = await getAprunaCache();
  return {
    total_customers: cache.total,
    with_qb_id: cache.byQbId.size,
    missing_qb_id: cache.missing_qb_id,
    fetched_at: new Date(cache.fetchedAt).toISOString(),
    cache_age_seconds: Math.round((Date.now() - cache.fetchedAt) / 1000),
    ttl_seconds: TTL_MS / 1000,
    sample: [...cache.byQbId.values()].slice(0, 5),
  };
}

/** Test-only helper. */
export function _resetCacheForTests() {
  _cache = null;
  _inflight = null;
}
