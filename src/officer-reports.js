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
    const r = await qbQuery(
      `SELECT Id, DisplayName, FullyQualifiedName, ParentRef, Level, Active FROM Customer ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
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
