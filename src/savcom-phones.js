// ───────────────────────────────────────────────────────────────────────────
// SAVCOM phone lookup — backed by Google Sheet "pikipiki records2" tab
// Sheet ID: 1XFwPITQgZmzZ8lbg8MKD9S4rwHyk2cDOKrcxO7SAjHA
// Tab: pikipiki records2
//
// Columns (1-indexed) per Frank 2026-06-29:
//   A: (empty)
//   B: PLATE NO.          (e.g. MC167FLV)
//   C: NAME               (e.g. ABDALIFA HAMISI MWENDA)
//   D: PHONE              (e.g. 255682003062)
//   E: WAKANDI ID         (e.g. 9633000480)
//
// Records as of 2026-06-29: 269 rows, 268 with phone, 251 with wakandi_id.
// Some QB-source customers have plate but no wakandi_id. One row (ELISANTE
// PATRICK KISAKA) has wakandi_id but no phone yet.
//
// Cache TTL = 1 hour. On refresh failure, stale cache is served rather
// than returning empty so a transient Sheets API hiccup doesn't drop SMS
// dispatch mid-batch.
// ───────────────────────────────────────────────────────────────────────────

import { readSheet } from './sheets.js';

const SHEET_ID = '1XFwPITQgZmzZ8lbg8MKD9S4rwHyk2cDOKrcxO7SAjHA';
const TAB = 'pikipiki records2';
const TTL_MS = 60 * 60 * 1000;

let _cache = null;
let _inflight = null;

function normName(s) {
  return String(s || '').toUpperCase().replace(/[^A-Z0-9]+/g, '');
}

function normPhone(s) {
  // Tanzania phones in the sheet are stored as 12-digit "255..." strings.
  // Strip non-digits, then if it starts with '0' (local) flip to 255.
  const d = String(s || '').replace(/\D+/g, '');
  if (!d) return null;
  if (d.startsWith('255') && d.length === 12) return d;
  if (d.startsWith('0') && d.length === 10) return '255' + d.slice(1);
  if (d.length === 9) return '255' + d;
  return d;
}

async function fetchAndIndex() {
  const r = await readSheet(SHEET_ID, `${TAB}!A1:F500`);
  const rows = r.values || r.data || [];
  const byPlate = new Map();
  const byWakandi = new Map();
  const byName = new Map();
  let all = [];
  // Skip row 1 (header), iterate data rows.
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] || [];
    const plate = String(row[1] || '').trim().toUpperCase();
    const name = String(row[2] || '').trim();
    const phone = normPhone(row[3]);
    const wakandi = String(row[4] || '').trim();
    if (!plate && !name && !phone && !wakandi) continue;
    const rec = { plate, name, phone, wakandi_member_id: wakandi };
    all.push(rec);
    if (plate && phone) byPlate.set(plate, rec);
    if (wakandi && phone) byWakandi.set(wakandi, rec);
    if (name && phone) byName.set(normName(name), rec);
  }
  return {
    fetchedAt: Date.now(),
    all, byPlate, byWakandi, byName,
  };
}

export async function getPhoneCache({ force = false } = {}) {
  const now = Date.now();
  if (!force && _cache && (now - _cache.fetchedAt) < TTL_MS) return _cache;
  if (_inflight) return _inflight;
  _inflight = (async () => {
    try {
      const fresh = await fetchAndIndex();
      _cache = fresh;
      console.log(`[savcom-phones] cached ${fresh.all.length} rows (plates=${fresh.byPlate.size}, wakandi=${fresh.byWakandi.size}, names=${fresh.byName.size})`);
      return fresh;
    } catch (err) {
      if (_cache) {
        console.error(`[savcom-phones] refresh failed (${err.message}); serving stale cache age=${Math.round((Date.now()-_cache.fetchedAt)/1000)}s`);
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
 * Look up a SAVCOM customer's phone from the pikipiki records2 sheet.
 * Match priority: plate (most precise) → wakandi_member_id → name match.
 * Returns null when no phone is on file for any of those identifiers.
 *   { phone: "2557...", via: "plate"|"wakandi_id"|"name", record: {...} }
 */
export async function lookupSavcomPhone({ plate, wakandi_member_id, name } = {}) {
  const cache = await getPhoneCache();
  if (plate) {
    const rec = cache.byPlate.get(String(plate).toUpperCase().trim());
    if (rec?.phone) return { phone: rec.phone, via: 'plate', record: rec };
  }
  if (wakandi_member_id) {
    const rec = cache.byWakandi.get(String(wakandi_member_id).trim());
    if (rec?.phone) return { phone: rec.phone, via: 'wakandi_id', record: rec };
  }
  if (name) {
    const rec = cache.byName.get(normName(name));
    if (rec?.phone) return { phone: rec.phone, via: 'name', record: rec };
  }
  return null;
}

export async function getPhoneCacheStats() {
  const c = await getPhoneCache();
  return {
    fetched_at: new Date(c.fetchedAt).toISOString(),
    age_seconds: Math.round((Date.now() - c.fetchedAt) / 1000),
    total: c.all.length,
    indexed: {
      by_plate: c.byPlate.size,
      by_wakandi_id: c.byWakandi.size,
      by_name: c.byName.size,
    },
  };
}

export function _resetCacheForTests() { _cache = null; _inflight = null; }
