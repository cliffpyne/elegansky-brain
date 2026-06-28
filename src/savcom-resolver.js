// ───────────────────────────────────────────────────────────────────────────
// SAVCOM customer resolver
//
// Backed by Frappe's elegansky.api.savcom_customers endpoint (live 2026-06-28).
// Returns all 292 SAVCOM customers — 18 from QB (carry plate), 274 from
// Wakandi (carry account + wakandi_member_id). Without this cache BRAIN's
// matcher only sees the 18 QB-originated rows because the Wakandi customers
// were never in BRAIN's QB mirror.
//
// Identifier rule per Frappe dev (verbatim from his 2026-06-28 reply):
//   - source:"qb"      → match by plate (preferred) or display_name
//   - source:"wakandi" → match by account, wakandi_member_id, or display_name
//   - phone is empty everywhere right now — do not match on phone
//
// When pushing to ingest_payment / get_open_invoices, Frappe accepts:
//   - <plate>   for QB rows
//   - <account>, <wakandi_member_id>, or <exact name> for Wakandi rows
// We send the resolved customer's `customer` field (Frappe's primary key
// for the row) so resolution is unambiguous.
//
// Cache: in-memory, TTL 1 hour. Refresh is best-effort — if Frappe times
// out we keep serving the stale list rather than returning no_match for
// every row.
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 30_000;
const TTL_MS = 60 * 60 * 1000;

let _cache = null;        // { fetchedAt, byPlate, byAccount, byWakandiId, byNormName, all }
let _inflight = null;

function baseUrl() {
  const u = (process.env.FRAPPE_BASE_URL || '').replace(/\/$/, '');
  if (!u) throw new Error('FRAPPE_BASE_URL not set');
  return u;
}

function authHeader() {
  const t = process.env.FRAPPE_API_TOKEN;
  if (!t || !t.includes(':')) {
    throw new Error('FRAPPE_API_TOKEN must be "<api_key>:<api_secret>"');
  }
  return `token ${t}`;
}

// Normalize a display name for fuzzy-equal comparison:
//   uppercase, strip non-alphanumeric, collapse whitespace. So
//   "BRAYSON ALLY HASSAN MC783FME" and "Brayson  ally hassan MC783FME"
//   both normalize to "BRAYSONALLYHASSANMC783FME".
export function normalizeName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

// Extract plate-like tokens from a string — same rule used elsewhere in
// BRAIN: 3-letter prefix + 3-4 digit middle + 2-3 letter suffix (e.g.
// MC783FME, T123ABC). Returns the FIRST match, or null.
const PLATE_RE = /\b([A-Z]{1,3}\d{2,4}[A-Z]{2,4})\b/;
export function extractPlate(s) {
  if (!s) return null;
  const m = String(s).toUpperCase().match(PLATE_RE);
  return m ? m[1] : null;
}

// Account heuristic: NMB accounts are 12-16 digits, no letters. The
// Wakandi savcom_customers payload puts these directly in the `account`
// field, so we don't need extraction at match time — but we DO need it
// for matching a bank-statement row's REFNUMBER / counterparty fields.
export function extractAccount(s) {
  if (!s) return null;
  const m = String(s).match(/\b(\d{10,16})\b/);
  return m ? m[1] : null;
}

async function fetchSavcomCustomers() {
  const url = `${baseUrl()}/api/method/elegansky.api.savcom_customers`;
  const r = await fetch(url, {
    headers: { 'Authorization': authHeader(), 'Accept': 'application/json' },
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  if (!r.ok) {
    const text = await r.text();
    throw new Error(`savcom_customers HTTP ${r.status}: ${text.slice(0, 200)}`);
  }
  const data = await r.json();
  const list = Array.isArray(data?.message) ? data.message : (Array.isArray(data) ? data : []);
  if (!list.length) throw new Error('savcom_customers returned empty list');
  return list;
}

function buildIndices(list) {
  const byPlate = new Map();
  const byAccount = new Map();
  const byWakandiId = new Map();
  const byNormName = new Map();
  for (const c of list) {
    const plate = (c.plate || '').toString().toUpperCase().trim();
    if (plate) byPlate.set(plate, c);
    const acct = (c.account || '').toString().trim();
    if (acct) byAccount.set(acct, c);
    const wid = (c.wakandi_member_id || '').toString().trim();
    if (wid) byWakandiId.set(wid, c);
    const norm = normalizeName(c.display_name || c.customer || '');
    if (norm) byNormName.set(norm, c);
  }
  return { byPlate, byAccount, byWakandiId, byNormName };
}

// Returns the freshest cache. If stale, attempts a refresh. On refresh
// failure with a stale cache available, keeps serving stale and logs.
export async function getCache({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && (now - _cache.fetchedAt) < TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const list = await fetchSavcomCustomers();
      const idx = buildIndices(list);
      _cache = { fetchedAt: Date.now(), all: list, ...idx };
      console.log(`[savcom-resolver] cached ${list.length} customers ` +
        `(plates=${idx.byPlate.size}, accounts=${idx.byAccount.size}, ` +
        `wakandi_ids=${idx.byWakandiId.size})`);
      return _cache;
    } catch (err) {
      if (_cache) {
        console.error(`[savcom-resolver] refresh failed (${err.message}); ` +
          `serving stale cache age=${Math.round((Date.now()-_cache.fetchedAt)/1000)}s`);
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
 * Resolve a SAVCOM customer from whatever identifiers a sheet row /
 * bank-statement row gives us. Returns the cached Frappe customer
 * object on hit (its `customer` field is the identifier you pass to
 * getOpenInvoices / ingestPayment), or null on miss.
 *
 * Match priority — most specific to least:
 *   1. exact plate (e.g. MC783FME)
 *   2. exact account number (10-16 digits)
 *   3. exact wakandi_member_id
 *   4. normalized name equality (uppercase + alphanumeric only)
 *   5. extracted-plate from a free-text field
 *   6. extracted-account from a free-text field
 *
 * Returns { match, via } where:
 *   match = the cached customer object (null on miss)
 *   via   = which signal matched ('plate'|'account'|'wakandi_id'|'name'|
 *           'extracted_plate'|'extracted_account'|null)
 */
export async function resolveSavcom({ plate, account, wakandi_member_id, name, freeText } = {}) {
  const c = await getCache();
  // 1. exact plate
  if (plate) {
    const hit = c.byPlate.get(String(plate).toUpperCase().trim());
    if (hit) return { match: hit, via: 'plate' };
  }
  // 2. exact account
  if (account) {
    const hit = c.byAccount.get(String(account).trim());
    if (hit) return { match: hit, via: 'account' };
  }
  // 3. exact wakandi id
  if (wakandi_member_id) {
    const hit = c.byWakandiId.get(String(wakandi_member_id).trim());
    if (hit) return { match: hit, via: 'wakandi_id' };
  }
  // 4. normalized name equality
  if (name) {
    const hit = c.byNormName.get(normalizeName(name));
    if (hit) return { match: hit, via: 'name' };
  }
  // 5+6. extracted from free text (counterparty / memo / refnumber line)
  if (freeText) {
    const p = extractPlate(freeText);
    if (p) {
      const hit = c.byPlate.get(p);
      if (hit) return { match: hit, via: 'extracted_plate' };
    }
    const a = extractAccount(freeText);
    if (a) {
      const hit = c.byAccount.get(a);
      if (hit) return { match: hit, via: 'extracted_account' };
    }
    // Also try normalizing the free text against names — handles bank
    // memos that contain the customer name verbatim alongside the txn ref.
    const hitByName = c.byNormName.get(normalizeName(freeText));
    if (hitByName) return { match: hitByName, via: 'name' };
  }
  return { match: null, via: null };
}

// Diagnostics: pull current cache shape without forcing a refresh.
export async function getCacheStats() {
  const c = await getCache();
  let qbCount = 0, wakandiCount = 0;
  for (const row of c.all) {
    if (row.source === 'qb') qbCount++;
    else if (row.source === 'wakandi') wakandiCount++;
  }
  return {
    fetched_at: new Date(c.fetchedAt).toISOString(),
    age_seconds: Math.round((Date.now() - c.fetchedAt) / 1000),
    total: c.all.length,
    by_source: { qb: qbCount, wakandi: wakandiCount },
    indexed: {
      by_plate: c.byPlate.size,
      by_account: c.byAccount.size,
      by_wakandi_id: c.byWakandiId.size,
      by_norm_name: c.byNormName.size,
    },
  };
}

// Run a batch of trial rows through the resolver and return per-row
// outcomes — used by /api/admin/savcom/coverage and ad-hoc audits.
export async function runCoverage(rows) {
  await getCache();
  const out = [];
  let hits = 0, misses = 0;
  const viaCounts = {};
  for (const r of rows) {
    const res = await resolveSavcom(r);
    if (res.match) {
      hits++;
      viaCounts[res.via] = (viaCounts[res.via] || 0) + 1;
      out.push({ input: r, status: 'hit', via: res.via, frappe_customer: res.match.customer });
    } else {
      misses++;
      out.push({ input: r, status: 'miss' });
    }
  }
  return { total: rows.length, hits, misses, hit_rate: rows.length ? hits / rows.length : 0, via_counts: viaCounts, rows: out };
}

// For unit tests / explicit invalidation.
export function _resetCacheForTests() { _cache = null; _inflight = null; }
