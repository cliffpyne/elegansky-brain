// Officer-collections report — the per-loan-officer collection dashboard
// Frank described 2026-06-04.
//
// Loan officers in Frank's microfinance setup are QB parent customers
// sitting at the same hierarchy level as AGRICOLA BODA. Their riders
// (sub-customers) hold the actual loans. The report shows, per officer:
//
//   open       = Σ Invoice.TotalAmt (NOT Balance) of all open invoices
//                under this officer's tree
//                − (OFFICE + POLICE motorcycle count) × 12,000
//   collection = Σ payment_uploads.amount today (Africa/Dar_es_Salaam day)
//                for customers under this officer
//   dueopen    = open − collection
//   percent    = collection / open × 100   (green ≥ 81%, red < 81%)
//
// Phase 1 (this module): the customer→officer map.
// Phase 2: OFFICE/POLICE sheet ingestion.
// Phase 3: live invoice totals per officer (5-min cache).
// Phase 4: the /api/officer-reports/today endpoint.
// Phase 5: dashboard page.

import { db } from './db/pool.js';
import { qbQuery } from './qb-client.js';
import { readSheet } from './sheets.js';

// Frank's tracker sheet (OFFICE / POLICE / TRACKER tabs).
// Override with env OFFICER_TRACKER_SHEET_ID if it ever moves.
const TRACKER_SHEET_ID = process.env.OFFICER_TRACKER_SHEET_ID
  || '1wrM7E9qGKcWJvN4mBwYMpkgp31jlxPGgEYCDsHn0bkc';

// ── Lazy schema (Render has no migration runner — apply on first use) ──────
const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS customer_officer_map (
  customer_id      text          PRIMARY KEY,
  customer_name    text,
  officer_id       text          NOT NULL,
  officer_name     text          NOT NULL,
  qb_level         int,
  cached_at        timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_customer_officer_map_officer
  ON customer_officer_map (officer_id);

CREATE TABLE IF NOT EXISTS officer_offline_motos (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date          NOT NULL,
  source        text          NOT NULL CHECK (source IN ('OFFICE','POLICE')),
  rider_name    text          NOT NULL,
  plate         text,
  customer_id   text,
  officer_id    text,
  officer_name  text,
  cached_at     timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_officer_offline_motos_date_officer
  ON officer_offline_motos (snapshot_date, officer_id);

CREATE TABLE IF NOT EXISTS officer_invoice_snapshots (
  snapshot_date          date          NOT NULL,
  officer_id             text          NOT NULL,
  officer_name           text          NOT NULL,
  total_invoice_amount   numeric       NOT NULL,
  open_invoice_count     int           NOT NULL,
  cached_at              timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, officer_id)
);
`;

let _schemaReady = false;
async function ensureSchema() {
  if (_schemaReady) return;
  await db().query(SCHEMA_DDL);
  _schemaReady = true;
}

// ── Phase 1 — customer→officer mapping ──────────────────────────────────────

/**
 * Discover the officer level by looking up AGRICOLA BODA's hierarchy depth
 * in QB. Officers are defined as "every customer at AGRICOLA BODA's level."
 */
export async function discoverOfficerLevel() {
  const r = await qbQuery("SELECT Id, DisplayName, Level FROM Customer WHERE DisplayName = 'AGRICOLA BODA'");
  const found = r.QueryResponse?.Customer?.[0];
  if (!found) throw new Error("AGRICOLA BODA not found in QB — can't determine officer level");
  return {
    level: Number(found.Level ?? 0),
    referenceOfficer: { id: found.Id, name: found.DisplayName },
  };
}

/**
 * Fetch every active customer from QB via STARTPOSITION pagination.
 * Returns the raw rows; caller resolves the parent chain in memory.
 */
export async function fetchAllCustomers() {
  const all = [];
  const BATCH = 1000;
  let start = 1;
  while (true) {
    // QBO default filter is Active=true. Include inactive too — bikes in
    // OFFICE/POLICE are often riders that got deactivated.
    const r = await qbQuery(
      `SELECT Id, DisplayName, FullyQualifiedName, ParentRef, Level, Active FROM Customer ` +
      `WHERE Active IN (true, false) STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Customer || [];
    all.push(...rows);
    if (rows.length < BATCH) break;
    start += BATCH;
  }
  return all;
}

/**
 * For each customer at or below the officer level, walk up the parent
 * chain until we reach the officer level. Customers above officer level
 * (e.g. KIJICHI BRANCH) get no officer assignment.
 *
 * Returns Map<customerId, { officerId, officerName, level }>.
 */
export function resolveOfficers(customers, officerLevel) {
  const byId = new Map(customers.map((c) => [String(c.Id), c]));
  const out = new Map();

  function climb(id, seen = new Set()) {
    if (out.has(id)) return out.get(id);
    if (seen.has(id)) return null; // cycle guard
    seen.add(id);
    const c = byId.get(id);
    if (!c) return null;
    const lvl = Number(c.Level ?? 0);
    if (lvl === officerLevel) {
      const m = { officerId: String(c.Id), officerName: c.DisplayName, level: lvl };
      out.set(id, m);
      return m;
    }
    if (lvl < officerLevel) return null;
    const parentId = c.ParentRef?.value ? String(c.ParentRef.value) : null;
    if (!parentId) return null;
    const parentMap = climb(parentId, seen);
    if (!parentMap) return null;
    const m = { officerId: parentMap.officerId, officerName: parentMap.officerName, level: lvl };
    out.set(id, m);
    return m;
  }

  for (const c of customers) climb(String(c.Id));
  return out;
}

/**
 * One-shot rebuild of customer_officer_map. Returns counts.
 */
export async function rebuildCustomerOfficerMap() {
  const { level: officerLevel, referenceOfficer } = await discoverOfficerLevel();
  const customers = await fetchAllCustomers();
  const mapped = resolveOfficers(customers, officerLevel);

  const byId = new Map(customers.map((c) => [String(c.Id), c]));
  const rows = [];
  for (const [id, m] of mapped.entries()) {
    const c = byId.get(id);
    rows.push([id, c?.DisplayName || null, m.officerId, m.officerName, Number(c?.Level ?? 0)]);
  }

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('TRUNCATE TABLE customer_officer_map');
    const CHUNK = 500;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const values = slice
        .map((_, j) => `($${j * 5 + 1}, $${j * 5 + 2}, $${j * 5 + 3}, $${j * 5 + 4}, $${j * 5 + 5})`)
        .join(',');
      const params = slice.flat();
      await client.query(
        `INSERT INTO customer_officer_map (customer_id, customer_name, officer_id, officer_name, qb_level) VALUES ${values}`,
        params,
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Count distinct officers
  const offs = await db().query(
    `SELECT COUNT(DISTINCT officer_id) AS officer_count FROM customer_officer_map`,
  );
  return {
    officer_level: officerLevel,
    reference_officer: referenceOfficer,
    customers_fetched: customers.length,
    customers_mapped: rows.length,
    distinct_officers: Number(offs.rows[0].officer_count),
  };
}

// ── Phase 2 — OFFICE/POLICE sheet ingestion ─────────────────────────────────

/**
 * Read one tab (OFFICE or POLICE) from Frank's tracker sheet.
 * Returns [{ rider_name, plate }] for every data row.
 */
async function readOfflineTab(source) {
  const data = await readSheet(TRACKER_SHEET_ID, `${source}!A1:B5000`);
  const rows = data.values || [];
  // Skip header row (CUSTOMER NAME, PLATE NUMBER).
  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] || [];
    const name = String(r[0] || '').trim();
    const plate = String(r[1] || '').trim().toUpperCase();
    if (!name && !plate) continue; // blank row
    out.push({ rider_name: name, plate });
  }
  return out;
}

/**
 * Resolve a list of plates to (customer_id, officer_id) via customer_officer_map.
 * Matches customer_name ILIKE '%PLATE%' (QB names follow "PLATE=NAME" pattern).
 * Returns Map<plate, { customer_id, officer_id, officer_name } | null>.
 */
async function resolvePlatesToOfficers(plates) {
  const unique = [...new Set(plates.filter(Boolean))];
  if (!unique.length) return new Map();

  // One big query: for every plate, find the customer whose name contains it.
  // We use a CASE statement to attach the plate as label, then GROUP to dedupe.
  const params = [];
  const cases = unique.map((p, i) => {
    params.push('%' + p + '%');
    return `WHEN customer_name ILIKE $${i + 1} THEN $${i + 1}`;
  }).join(' ');
  const orClauses = unique.map((_, i) => `customer_name ILIKE $${i + 1}`).join(' OR ');

  const sql = `
    SELECT
      customer_id, customer_name, officer_id, officer_name,
      (CASE ${cases} END) AS matched_pattern
    FROM customer_officer_map
    WHERE ${orClauses}
  `;
  const r = await db().query(sql, params);

  // matched_pattern is '%PLATE%' — strip the %s back to the plate.
  const out = new Map();
  for (const row of r.rows) {
    const plate = String(row.matched_pattern || '').replace(/^%|%$/g, '');
    // First match wins (ties unlikely; plates are 8 chars unique).
    if (!out.has(plate)) {
      out.set(plate, {
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        officer_id: row.officer_id,
        officer_name: row.officer_name,
      });
    }
  }
  // Plates with no match → set null so caller knows they're unresolved.
  for (const p of unique) if (!out.has(p)) out.set(p, null);
  return out;
}

/**
 * Pull OFFICE and POLICE for a given date (default: today EAT).
 * Replaces any prior snapshot for that date. Returns counts.
 */
export async function refreshOfflineMotos(snapshotDate = null) {
  await ensureSchema();
  const date = snapshotDate || todayEatDate();

  const [officeRows, policeRows] = await Promise.all([
    readOfflineTab('OFFICE'),
    readOfflineTab('POLICE'),
  ]);

  const allPlates = [...officeRows, ...policeRows].map((r) => r.plate).filter(Boolean);
  const resolved = await resolvePlatesToOfficers(allPlates);

  const rows = [];
  for (const r of officeRows) {
    const m = r.plate ? resolved.get(r.plate) : null;
    rows.push(['OFFICE', r.rider_name, r.plate || null, m?.customer_id || null, m?.officer_id || null, m?.officer_name || null]);
  }
  for (const r of policeRows) {
    const m = r.plate ? resolved.get(r.plate) : null;
    rows.push(['POLICE', r.rider_name, r.plate || null, m?.customer_id || null, m?.officer_id || null, m?.officer_name || null]);
  }

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM officer_offline_motos WHERE snapshot_date = $1', [date]);
    const CHUNK = 200;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const slice = rows.slice(i, i + CHUNK);
      const values = slice.map((_, j) => {
        const b = j * 6;
        return `($1, $${b + 2}, $${b + 3}, $${b + 4}, $${b + 5}, $${b + 6}, $${b + 7})`;
      }).join(',');
      const params = [date, ...slice.flat()];
      await client.query(
        `INSERT INTO officer_offline_motos
           (snapshot_date, source, rider_name, plate, customer_id, officer_id, officer_name)
         VALUES ${values}`,
        params,
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  // Stats
  const office_count = officeRows.length;
  const police_count = policeRows.length;
  const unresolved_office = officeRows.filter((r) => !r.plate || resolved.get(r.plate) == null).length;
  const unresolved_police = policeRows.filter((r) => !r.plate || resolved.get(r.plate) == null).length;
  return {
    snapshot_date: date,
    office_count,
    police_count,
    total: office_count + police_count,
    unresolved_office,
    unresolved_police,
  };
}

/**
 * Per-officer offline counts for a given date.
 * Used by the report endpoint to compute open = invoice_total − count × 12000.
 */
export async function getOfficerOfflineCounts(snapshotDate) {
  const r = await db().query(
    `SELECT officer_id, officer_name,
            COUNT(*) FILTER (WHERE source='OFFICE') AS office_count,
            COUNT(*) FILTER (WHERE source='POLICE') AS police_count
       FROM officer_offline_motos
      WHERE snapshot_date = $1 AND officer_id IS NOT NULL
      GROUP BY officer_id, officer_name`,
    [snapshotDate],
  );
  const map = new Map();
  for (const x of r.rows) {
    map.set(x.officer_id, {
      officer_id: x.officer_id,
      officer_name: x.officer_name,
      office_count: Number(x.office_count),
      police_count: Number(x.police_count),
      offline_total: Number(x.office_count) + Number(x.police_count),
    });
  }
  return map;
}

function todayEatDate() {
  // Africa/Dar_es_Salaam is UTC+3 (no DST). Use UTC arithmetic.
  const now = new Date();
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return eat.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── HTTP mount ──────────────────────────────────────────────────────────────

export function mountOfficerReportsApi(app, { requireSecretOrJwt }) {
  // POST /api/officer-reports/rebuild-map
  // Rebuilds customer_officer_map from QB. Run on demand or after major
  // QB-side reorganizations. Returns counts.
  app.post('/api/officer-reports/rebuild-map', requireSecretOrJwt, async (req, res) => {
    try {
      const t0 = Date.now();
      await ensureSchema();
      const stats = await rebuildCustomerOfficerMap();
      res.json({ ok: true, took_ms: Date.now() - t0, ...stats });
    } catch (err) {
      console.error('[officer-reports] rebuild-map failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/officer-reports/officers
  // Lists the discovered officers with their rider counts.
  app.get('/api/officer-reports/officers', requireSecretOrJwt, async (req, res) => {
    try {
      await ensureSchema();
      const r = await db().query(
        `SELECT officer_id, officer_name, COUNT(*) AS rider_count
           FROM customer_officer_map
          GROUP BY officer_id, officer_name
          ORDER BY officer_name`,
      );
      res.json({
        count: r.rows.length,
        officers: r.rows.map((x) => ({
          officer_id: x.officer_id,
          officer_name: x.officer_name,
          rider_count: Number(x.rider_count),
        })),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/officer-reports/refresh-offline-motos
  // Reads OFFICE + POLICE tabs, resolves plates → officers, persists for the
  // given snapshot_date (defaults to today EAT). Replaces prior snapshot for
  // that date. Should be invoked once each morning (cron) and again whenever
  // operations changes the sheet.
  app.post('/api/officer-reports/refresh-offline-motos', requireSecretOrJwt, async (req, res) => {
    try {
      const date = req.body?.snapshot_date || null;
      const t0 = Date.now();
      const stats = await refreshOfflineMotos(date);
      res.json({ ok: true, took_ms: Date.now() - t0, ...stats });
    } catch (err) {
      console.error('[officer-reports] refresh-offline-motos failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/officer-reports/offline-motos?date=YYYY-MM-DD
  // Returns per-officer office+police counts for a given day.
  app.get('/api/officer-reports/offline-motos', requireSecretOrJwt, async (req, res) => {
    try {
      await ensureSchema();
      const date = String(req.query.date || todayEatDate());
      const map = await getOfficerOfflineCounts(date);
      const rows = [...map.values()].sort((a, b) => b.offline_total - a.offline_total);
      const unresolved = await db().query(
        `SELECT source, rider_name, plate FROM officer_offline_motos
          WHERE snapshot_date = $1 AND officer_id IS NULL
          ORDER BY source, rider_name`,
        [date],
      );
      res.json({
        snapshot_date: date,
        per_officer: rows,
        unresolved: unresolved.rows,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/officer-reports/qb-find?q=MC198EWK — debug: live QB Customer search
  app.get('/api/officer-reports/qb-find', requireSecretOrJwt, async (req, res) => {
    try {
      const q = String(req.query.q || '').trim();
      if (!q) return res.status(400).json({ error: 'q required' });
      const escaped = q.replace(/'/g, "''");
      const sql = `SELECT Id, DisplayName, FullyQualifiedName, ParentRef, Level, Active ` +
                  `FROM Customer WHERE DisplayName LIKE '%${escaped}%' AND Active IN (true, false) MAXRESULTS 10`;
      const r = await qbQuery(sql);
      res.json({
        query: sql,
        rows: r.QueryResponse?.Customer || [],
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/officer-reports/customer/:id — debug: who does this customer roll up to?
  app.get('/api/officer-reports/customer/:id', requireSecretOrJwt, async (req, res) => {
    try {
      await ensureSchema();
      const r = await db().query(
        `SELECT * FROM customer_officer_map WHERE customer_id = $1`,
        [String(req.params.id)],
      );
      if (!r.rows.length) return res.status(404).json({ error: 'not in map (try rebuild-map first)' });
      res.json(r.rows[0]);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
