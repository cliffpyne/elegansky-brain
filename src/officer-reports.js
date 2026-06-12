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

const KIJICHI_ACCOUNT_NAME = 'Kijichi Collection AC';

// Channel → sheet config. Matches CHANNEL_SHEETS in payment-batches.js.
const BANK_SHEETS = {
  nmbnew:      { sheetId: '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek', tab: 'PASSED' },
  bank:        { sheetId: '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o', tab: 'PASSED' },
  iphone_bank: { sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED' },
};

/**
 * Compute upload-day start instant (UTC). Upload-day rolls over at 16:15 EAT
 * (kili1615 cutoff). Returns a Date — the boundary BEFORE which txns belong
 * to the previous upload-day, AT/AFTER which they belong to the current one.
 */
function uploadDayStart(now = new Date()) {
  // 16:15 EAT today in UTC = today's 13:15 UTC
  const today1315utc = new Date(Date.UTC(
    now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 13, 15, 0,
  ));
  if (now >= today1315utc) return today1315utc;
  return new Date(today1315utc.getTime() - 24 * 60 * 60 * 1000);
}

/**
 * Parse a "DD.MM.YYYY HH:MM:SS" sheet timestamp string into a Date (EAT→UTC).
 */
function parseSheetTs(s) {
  if (!s) return null;
  const m = String(s).trim().match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  const [, d, mo, y, hh, mm, ss] = m;
  // EAT = UTC+3 → subtract 3 from hour.
  return new Date(Date.UTC(+y, +mo - 1, +d, +hh - 3, +mm, +(ss || 0)));
}

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
  today_balance_remain   numeric       NOT NULL DEFAULT 0,  -- Σ Balance of today's invoices
  cached_at              timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, officer_id)
);
-- Migration for existing rows (added 2026-06-04 evening)
ALTER TABLE officer_invoice_snapshots
  ADD COLUMN IF NOT EXISTS today_balance_remain numeric NOT NULL DEFAULT 0;

-- Total arrears per officer.
-- Arrears = Σ Balance of every invoice WHERE Balance > 0 AND DueDate < today.
-- Distinct from officer_invoice_snapshots which is just today's billable.
CREATE TABLE IF NOT EXISTS officer_arrears_snapshots (
  snapshot_date          date          NOT NULL,
  officer_id             text          NOT NULL,
  officer_name           text          NOT NULL,
  total_arrears          numeric       NOT NULL,   -- Σ Balance of overdue invoices
  overdue_invoice_count  int           NOT NULL,
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
 * Strip noise from a sheet-entered rider name. Common operator habits:
 *   - phone number tail: "NJAUKA BAKARI MOHAMED 0674299966"
 *   - plate fragments interleaved: "JUMA RASHID HEMED MC 782 EYP"
 * We drop:
 *   - pure-digit tokens
 *   - the literal "MC" token
 *   - any short token that looks like a plate-half (≤4 chars, all caps)
 *     adjacent to an MC/digit token
 *   - trailing punctuation
 */
function cleanRiderName(raw) {
  if (!raw) return '';
  let tokens = String(raw)
    .replace(/MC\s*\d+\s*[A-Z]{0,4}/gi, ' ') // remove embedded plates like "MC 782 EYP"
    .split(/\s+/)
    .map((t) => t.replace(/[^\w]/g, ''))
    .filter((t) => t && /[A-Za-z]/.test(t)) // drop pure-digit tokens
    .filter((t) => t.toUpperCase() !== 'MC'); // bare "MC" leftovers
  return tokens.join(' ').trim();
}

/**
 * Resolve a list of rider names from OFFICE/POLICE to officers via
 * customer_officer_map. Plates from QB don't carry the bike's tag — they
 * live on invoices — so the rider's name is the join key.
 *
 * Returns Map<original_name, { customer_id, officer_id, officer_name } | null>.
 */
async function resolveNamesToOfficers(names) {
  const cleaned = [...new Set(names.map((n) => cleanRiderName(n)).filter(Boolean))];
  if (!cleaned.length) return new Map();

  // Exact (case-insensitive) match on customer_name.
  const params = cleaned;
  const placeholders = cleaned.map((_, i) => `$${i + 1}`).join(',');
  const r = await db().query(
    `SELECT customer_id, customer_name, officer_id, officer_name
       FROM customer_officer_map
      WHERE UPPER(customer_name) IN (${placeholders})`,
    cleaned.map((n) => n.toUpperCase()),
  );

  // Keep first match per cleaned name.
  const byCleaned = new Map();
  for (const row of r.rows) {
    const key = String(row.customer_name).toUpperCase();
    if (!byCleaned.has(key)) {
      byCleaned.set(key, {
        customer_id: row.customer_id,
        customer_name: row.customer_name,
        officer_id: row.officer_id,
        officer_name: row.officer_name,
      });
    }
  }

  // Map back to caller's original names.
  const out = new Map();
  for (const original of names) {
    const cleanedKey = cleanRiderName(original).toUpperCase();
    out.set(original, cleanedKey ? (byCleaned.get(cleanedKey) || null) : null);
  }
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

  const allNames = [...officeRows, ...policeRows].map((r) => r.rider_name).filter(Boolean);
  const resolved = await resolveNamesToOfficers(allNames);

  const rows = [];
  for (const r of officeRows) {
    const m = r.rider_name ? resolved.get(r.rider_name) : null;
    rows.push(['OFFICE', r.rider_name, r.plate || null, m?.customer_id || null, m?.officer_id || null, m?.officer_name || null]);
  }
  for (const r of policeRows) {
    const m = r.rider_name ? resolved.get(r.rider_name) : null;
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
  const unresolved_office = officeRows.filter((r) => !r.rider_name || resolved.get(r.rider_name) == null).length;
  const unresolved_police = policeRows.filter((r) => !r.rider_name || resolved.get(r.rider_name) == null).length;
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

// ── Phase 3 — live invoice totals per officer ───────────────────────────────

/**
 * Pull every open (Balance > 0) invoice from QB and group by officer via
 * customer_officer_map. Sum invoice.TotalAmt — NOT Balance — per Frank's
 * spec 2026-06-04: open is measured against the full invoice face value.
 *
 * Cached in officer_invoice_snapshots with a 5-min TTL so dashboard polling
 * is cheap. Pass force=true to bypass the cache.
 */
export async function refreshOfficerInvoiceTotals({ force = false } = {}) {
  await ensureSchema();
  const date = todayEatDate();

  if (!force) {
    const cached = await db().query(
      `SELECT cached_at FROM officer_invoice_snapshots
        WHERE snapshot_date = $1
        ORDER BY cached_at DESC LIMIT 1`,
      [date],
    );
    if (cached.rows.length) {
      const age_ms = Date.now() - new Date(cached.rows[0].cached_at).getTime();
      if (age_ms < 5 * 60 * 1000) return { cached: true, age_ms };
    }
  }

  // Pull invoices DATED today (TxnDate = today, the week's billable issue).
  // Frank's spec 2026-06-04: "total amount of all the invoices not balance
  // in that specific date". So we filter on TxnDate, not on Balance.
  // TotalAmt is the face value; Balance is what's left. We use TotalAmt.
  const allInvoices = [];
  const BATCH = 1000;
  let start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT Id, CustomerRef, TotalAmt, Balance, TxnDate ` +
      `FROM Invoice WHERE TxnDate = '${date}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Invoice || [];
    allInvoices.push(...rows);
    if (rows.length < BATCH) break;
    start += BATCH;
  }

  // Group by officer. customer_officer_map lookup in one query.
  const customerIds = [...new Set(allInvoices.map((inv) => String(inv.CustomerRef?.value || '')))]
    .filter(Boolean);
  const mapRows = await db().query(
    `SELECT customer_id, officer_id, officer_name
       FROM customer_officer_map
      WHERE customer_id = ANY($1)`,
    [customerIds],
  );
  const cidToOfficer = new Map(mapRows.rows.map((r) => [r.customer_id, r]));

  // Aggregate. Track both TotalAmt (face value, locked) and Balance
  // (live remaining unpaid — drops to 0 when fully paid).
  const perOfficer = new Map();
  let unmapped_count = 0;
  let unmapped_amount = 0;
  for (const inv of allInvoices) {
    const cid = String(inv.CustomerRef?.value || '');
    const amt = Number(inv.TotalAmt || 0);
    const bal = Number(inv.Balance || 0);
    const off = cidToOfficer.get(cid);
    if (!off) {
      unmapped_count++;
      unmapped_amount += amt;
      continue;
    }
    if (!perOfficer.has(off.officer_id)) {
      perOfficer.set(off.officer_id, {
        officer_id: off.officer_id,
        officer_name: off.officer_name,
        total_invoice_amount: 0,
        open_invoice_count: 0,
        today_balance_remain: 0,
      });
    }
    const p = perOfficer.get(off.officer_id);
    p.total_invoice_amount += amt;
    p.today_balance_remain += bal;
    p.open_invoice_count += 1;
  }

  // Persist.
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM officer_invoice_snapshots WHERE snapshot_date = $1', [date]);
    for (const p of perOfficer.values()) {
      await client.query(
        `INSERT INTO officer_invoice_snapshots
           (snapshot_date, officer_id, officer_name, total_invoice_amount, open_invoice_count, today_balance_remain)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [date, p.officer_id, p.officer_name, p.total_invoice_amount, p.open_invoice_count, p.today_balance_remain],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    cached: false,
    snapshot_date: date,
    invoices_scanned: allInvoices.length,
    officers_with_open_invoices: perOfficer.size,
    unmapped_invoices: unmapped_count,
    unmapped_amount,
    grand_total: [...perOfficer.values()].reduce((a, p) => a + p.total_invoice_amount, 0),
  };
}

/**
 * Pull arrears (overdue open balance) per officer.
 * arrears = Σ Balance of every invoice WHERE Balance > 0 AND DueDate < today.
 * Uses Balance (not TotalAmt) because arrears = what's still owed.
 * Cached 30 min — this is heavier than today's totals (scans all old invoices).
 */
export async function refreshOfficerArrears({ force = false } = {}) {
  await ensureSchema();
  const date = todayEatDate();

  if (!force) {
    const cached = await db().query(
      `SELECT cached_at FROM officer_arrears_snapshots
        WHERE snapshot_date = $1
        ORDER BY cached_at DESC LIMIT 1`,
      [date],
    );
    if (cached.rows.length) {
      const age_ms = Date.now() - new Date(cached.rows[0].cached_at).getTime();
      if (age_ms < 30 * 60 * 1000) return { cached: true, age_ms };
    }
  }

  // Scan all overdue invoices via QB pagination.
  const allInvoices = [];
  const BATCH = 1000;
  let start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT Id, CustomerRef, TotalAmt, Balance, DueDate ` +
      `FROM Invoice WHERE Balance > '0' AND DueDate < '${date}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Invoice || [];
    allInvoices.push(...rows);
    if (rows.length < BATCH) break;
    start += BATCH;
  }

  const customerIds = [...new Set(allInvoices.map((inv) => String(inv.CustomerRef?.value || '')))]
    .filter(Boolean);
  const mapRows = await db().query(
    `SELECT customer_id, officer_id, officer_name
       FROM customer_officer_map
      WHERE customer_id = ANY($1)`,
    [customerIds],
  );
  const cidToOfficer = new Map(mapRows.rows.map((r) => [r.customer_id, r]));

  const perOfficer = new Map();
  for (const inv of allInvoices) {
    const cid = String(inv.CustomerRef?.value || '');
    const bal = Number(inv.Balance || 0);
    const off = cidToOfficer.get(cid);
    if (!off) continue;
    if (!perOfficer.has(off.officer_id)) {
      perOfficer.set(off.officer_id, {
        officer_id: off.officer_id,
        officer_name: off.officer_name,
        total_arrears: 0,
        overdue_invoice_count: 0,
      });
    }
    const p = perOfficer.get(off.officer_id);
    p.total_arrears += bal;
    p.overdue_invoice_count += 1;
  }

  const client = await db().connect();
  try {
    await client.query('BEGIN');
    await client.query('DELETE FROM officer_arrears_snapshots WHERE snapshot_date = $1', [date]);
    for (const p of perOfficer.values()) {
      await client.query(
        `INSERT INTO officer_arrears_snapshots
           (snapshot_date, officer_id, officer_name, total_arrears, overdue_invoice_count)
         VALUES ($1, $2, $3, $4, $5)`,
        [date, p.officer_id, p.officer_name, p.total_arrears, p.overdue_invoice_count],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }

  return {
    cached: false,
    snapshot_date: date,
    invoices_scanned: allInvoices.length,
    officers_with_arrears: perOfficer.size,
  };
}

/**
 * Pull invoice totals per officer LIVE from QB for ANY date — no snapshot
 * table dependency. Returns Map<officer_id, { officer_name, total_invoice_amount,
 * today_balance_remain, open_invoice_count }>. Frank's spec 2026-06-07:
 *   - Amount of an invoice is immutable from creation, so total_invoice_amount
 *     is the same whether we query in the morning or evening.
 *   - Balance changes as payments land — so today_balance_remain reflects the
 *     CURRENT balance regardless of which date we're querying.
 * Operator pages no longer need a refresh button to populate snapshots.
 */
export async function getLiveOfficerInvoiceTotals(date) {
  const allInvoices = [];
  const BATCH = 1000;
  let start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT Id, CustomerRef, TotalAmt, Balance, TxnDate ` +
      `FROM Invoice WHERE TxnDate = '${date}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Invoice || [];
    allInvoices.push(...rows);
    if (rows.length < BATCH) break;
    start += BATCH;
  }
  const customerIds = [...new Set(allInvoices.map((inv) => String(inv.CustomerRef?.value || '')))]
    .filter(Boolean);
  const mapRows = customerIds.length ? await db().query(
    `SELECT customer_id, officer_id, officer_name
       FROM customer_officer_map WHERE customer_id = ANY($1)`,
    [customerIds],
  ) : { rows: [] };
  const cidToOfficer = new Map(mapRows.rows.map((r) => [r.customer_id, r]));
  const out = new Map();
  for (const inv of allInvoices) {
    const off = cidToOfficer.get(String(inv.CustomerRef?.value || ''));
    if (!off) continue;
    if (!out.has(off.officer_id)) {
      out.set(off.officer_id, {
        officer_id: off.officer_id,
        officer_name: off.officer_name,
        total_invoice_amount: 0,
        today_balance_remain: 0,
        open_invoice_count: 0,
      });
    }
    const p = out.get(off.officer_id);
    p.total_invoice_amount += Number(inv.TotalAmt || 0);
    p.today_balance_remain += Number(inv.Balance || 0);
    p.open_invoice_count += 1;
  }
  return out;
}

/**
 * Pull arrears (overdue open balance) per officer LIVE from QB for any date.
 * arrears = Σ Balance of every invoice WHERE Balance > 0 AND DueDate < date.
 * QB handles the day-rollover automatically — today's invoices become arrears
 * once their DueDate is past, no manual snapshot needed.
 */
export async function getLiveOfficerArrears(date) {
  const allInvoices = [];
  const BATCH = 1000;
  let start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT Id, CustomerRef, TotalAmt, Balance, DueDate ` +
      `FROM Invoice WHERE Balance > '0' AND DueDate < '${date}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Invoice || [];
    allInvoices.push(...rows);
    if (rows.length < BATCH) break;
    start += BATCH;
  }
  const customerIds = [...new Set(allInvoices.map((inv) => String(inv.CustomerRef?.value || '')))]
    .filter(Boolean);
  const mapRows = customerIds.length ? await db().query(
    `SELECT customer_id, officer_id, officer_name
       FROM customer_officer_map WHERE customer_id = ANY($1)`,
    [customerIds],
  ) : { rows: [] };
  const cidToOfficer = new Map(mapRows.rows.map((r) => [r.customer_id, r]));
  const out = new Map();
  for (const inv of allInvoices) {
    const off = cidToOfficer.get(String(inv.CustomerRef?.value || ''));
    if (!off) continue;
    if (!out.has(off.officer_id)) {
      out.set(off.officer_id, {
        officer_id: off.officer_id,
        officer_name: off.officer_name,
        total_arrears: 0,
        overdue_invoice_count: 0,
      });
    }
    const p = out.get(off.officer_id);
    p.total_arrears += Number(inv.Balance || 0);
    p.overdue_invoice_count += 1;
  }
  return out;
}

/**
 * Frank 2026-06-09 — agent arrear report, no snapshot, no morning/realtime
 * mismatch. One date boundary: midnight EAT.
 *
 * For a given date:
 *   overdue_set         = { Invoice WHERE Balance > 0 AND DueDate < date }
 *                          (the same set whether queried at 6am or 6pm —
 *                           the date boundary IS the calendar day rollover)
 *   arrears_now         = Σ Balance for overdue_set                   (what's still owed RIGHT NOW)
 *   arrear_collected    = Σ Line.Amount for today's QB Payments where
 *                          LinkedTxn invoice ∈ overdue_set            (today's TZS landing on overdue)
 *   open_inv_collection = Σ Line.Amount for today's QB Payments where
 *                          LinkedTxn invoice ∉ overdue_set            (today's TZS landing on today/future invoices)
 *   arrears_morning     = arrears_now + arrear_collected              (derived — what was overdue at midnight)
 *   arrear_pct          = arrear_collected / arrears_morning × 100
 *
 * Identity (guaranteed by construction):
 *   arrear_collected + open_inv_collection = sum(today's payment lines)
 *
 * The OLD code (replaced) computed two different DueDate cutoffs (morning <
 * date, realtime < date+1) which dragged invoices-due-today into the realtime
 * bucket but NOT the morning bucket, producing fake negative collections.
 * This function uses the same cutoff (DueDate < date) consistently and
 * derives the morning baseline from today's actual payments.
 *
 * Returns Map<officer_id, {
 *   officer_id, officer_name,
 *   arrears_now, arrears_morning, arrear_collected, open_invoice_collection,
 *   overdue_invoice_count
 * }>
 */
export async function getLiveOfficerArrearMath(date) {
  // 1. Pull all overdue invoices (DueDate < date, Balance > 0) — paginated.
  const overdueInvoices = [];
  const BATCH = 1000;
  let start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT Id, CustomerRef, Balance, DueDate ` +
      `FROM Invoice WHERE Balance > '0' AND DueDate < '${date}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Invoice || [];
    overdueInvoices.push(...rows);
    if (rows.length < BATCH) break;
    start += BATCH;
  }
  const overdueIdSet = new Set(overdueInvoices.map((inv) => String(inv.Id)));

  // 2. Pull today's QB Payments. SELECT * to get the Line[] / LinkedTxn[] tree
  //    (QB doesn't return nested fields when listed individually).
  const todayPayments = [];
  start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT * FROM Payment WHERE TxnDate = '${date}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Payment || [];
    todayPayments.push(...rows);
    if (rows.length < BATCH) break;
    start += BATCH;
  }

  // 3. Customer → officer map for every customer we touched.
  const customerIds = new Set();
  for (const inv of overdueInvoices) customerIds.add(String(inv.CustomerRef?.value || ''));
  for (const p of todayPayments)     customerIds.add(String(p.CustomerRef?.value || ''));
  customerIds.delete('');
  const mapRows = customerIds.size ? await db().query(
    `SELECT customer_id, officer_id, officer_name
       FROM customer_officer_map WHERE customer_id = ANY($1)`,
    [[...customerIds]],
  ) : { rows: [] };
  const cidToOfficer = new Map(mapRows.rows.map((r) => [r.customer_id, r]));

  // 4. Aggregate per officer.
  const out = new Map();
  const ensure = (off) => {
    if (!out.has(off.officer_id)) {
      out.set(off.officer_id, {
        officer_id: off.officer_id,
        officer_name: off.officer_name,
        arrears_now: 0,
        arrear_collected: 0,
        open_invoice_collection: 0,
        overdue_invoice_count: 0,
      });
    }
    return out.get(off.officer_id);
  };

  // 4a. arrears_now + overdue counts from overdueInvoices.
  for (const inv of overdueInvoices) {
    const off = cidToOfficer.get(String(inv.CustomerRef?.value || ''));
    if (!off) continue;
    const p = ensure(off);
    p.arrears_now += Number(inv.Balance || 0);
    p.overdue_invoice_count += 1;
  }

  // 4b. Bucket today's payment lines by whether their linked invoice was overdue.
  for (const pay of todayPayments) {
    const off = cidToOfficer.get(String(pay.CustomerRef?.value || ''));
    if (!off) continue;
    const p = ensure(off);
    for (const line of pay.Line || []) {
      const amt = Number(line.Amount || 0);
      if (!amt) continue;
      for (const lt of line.LinkedTxn || []) {
        if (lt.TxnType !== 'Invoice') continue;
        if (overdueIdSet.has(String(lt.TxnId))) {
          p.arrear_collected += amt;
        } else {
          p.open_invoice_collection += amt;
        }
      }
    }
  }

  // 4c. Derived: arrears_morning = arrears_now + arrear_collected.
  for (const p of out.values()) {
    p.arrears_morning = p.arrears_now + p.arrear_collected;
  }

  return out;
}


// ──────────────────────────────────────────────────────────────────────────
// MIRROR-BACKED REPORT HELPERS (Phase 3 of the QB mirror migration).
//
// Same Map<officer_id, payload> shape as getLiveOfficerInvoiceTotals /
// getLiveOfficerArrears / getLiveOfficerArrearMath, but reading qb_invoices
// + qb_payments + qb_payment_lines in Postgres instead of QB API.
//
// One SQL query per helper. Sub-100ms when indexes are warm vs 30-120s
// against QB. The mirror is kept current by cdc-poller (every 30s) + QB
// webhooks (real-time), so freshness is <1 min.
// ──────────────────────────────────────────────────────────────────────────

export async function getMirrorOfficerInvoiceTotals(date) {
  const r = await db().query(
    `SELECT m.officer_id, m.officer_name,
            COUNT(*)::int                     AS open_invoice_count,
            COALESCE(SUM(i.total_amt), 0)     AS total_invoice_amount,
            COALESCE(SUM(i.balance), 0)       AS today_balance_remain
       FROM qb_invoices i
       JOIN customer_officer_map m ON m.customer_id = i.customer_id
      WHERE i.txn_date = $1
      GROUP BY m.officer_id, m.officer_name`,
    [date],
  );
  const out = new Map();
  for (const row of r.rows) {
    out.set(row.officer_id, {
      officer_id: row.officer_id,
      officer_name: row.officer_name,
      total_invoice_amount: Number(row.total_invoice_amount),
      today_balance_remain: Number(row.today_balance_remain),
      open_invoice_count: Number(row.open_invoice_count),
    });
  }
  return out;
}

export async function getMirrorOfficerArrears(date) {
  const r = await db().query(
    `SELECT m.officer_id, m.officer_name,
            COUNT(*)::int                   AS overdue_invoice_count,
            COALESCE(SUM(i.balance), 0)     AS total_arrears
       FROM qb_invoices i
       JOIN customer_officer_map m ON m.customer_id = i.customer_id
      WHERE i.balance > 0 AND i.due_date < $1
      GROUP BY m.officer_id, m.officer_name`,
    [date],
  );
  const out = new Map();
  for (const row of r.rows) {
    out.set(row.officer_id, {
      officer_id: row.officer_id,
      officer_name: row.officer_name,
      total_arrears: Number(row.total_arrears),
      overdue_invoice_count: Number(row.overdue_invoice_count),
    });
  }
  return out;
}

/**
 * Snapshot-free agent-arrear math from the mirror. One SQL pass:
 *   - arrears_now             from qb_invoices (balance>0, due_date<date)
 *   - arrear_collected        from qb_payments + qb_payment_lines (txn_date=date,
 *                              linked_invoice_id ∈ overdue set)
 *   - open_invoice_collection from qb_payments + qb_payment_lines (txn_date=date,
 *                              linked_invoice_id ∉ overdue set)
 *   - arrears_morning         derived = arrears_now + arrear_collected
 *
 * Identity guaranteed: arrear_collected + open_invoice_collection = today's
 * total Σ Line.Amount for payments with txn_date = date.
 */
export async function getMirrorOfficerArrearMath(date) {
  // Three-bucket classification of every today's-payment line's linked
  // invoice:
  //   arrear: DueDate < today              (overdue, what Frank calls arrears)
  //   future: TxnDate > today              (prepayment / future installments)
  //   today: anything else                 (today's installments + the rare
  //                                         past-not-overdue case)
  // Identity: arrear_collected + today_invoice_collection +
  // future_invoice_collection = sum of all today's payment lines linked to
  // invoices (per officer-mapped customer). open_invoice_collection is
  // preserved as a back-compat alias = today + future, so older API consumers
  // don't break.
  const r = await db().query(
    `WITH overdue AS (
       SELECT id, customer_id, balance
         FROM qb_invoices
        WHERE balance > 0 AND due_date < $1
     ),
     inv_bucket AS (
       SELECT id,
         CASE
           WHEN due_date < $1 THEN 'arrear'
           WHEN txn_date > $1 THEN 'future'
           ELSE 'today'
         END AS bucket
         FROM qb_invoices
     ),
     overdue_per_officer AS (
       SELECT m.officer_id, m.officer_name,
              COUNT(*)::int                AS overdue_count,
              COALESCE(SUM(o.balance), 0)  AS arrears_now
         FROM overdue o
         JOIN customer_officer_map m ON m.customer_id = o.customer_id
        GROUP BY m.officer_id, m.officer_name
     ),
     pay_lines_today AS (
       SELECT p.customer_id, l.amount, ib.bucket
         FROM qb_payments p
         JOIN qb_payment_lines l ON l.payment_id = p.id
         JOIN inv_bucket ib       ON ib.id = l.linked_invoice_id
        WHERE p.txn_date = $1 AND l.linked_invoice_id IS NOT NULL
     ),
     pay_per_officer AS (
       SELECT m.officer_id, m.officer_name,
              COALESCE(SUM(CASE WHEN pl.bucket = 'arrear' THEN pl.amount END), 0) AS arrear_collected,
              COALESCE(SUM(CASE WHEN pl.bucket = 'today'  THEN pl.amount END), 0) AS today_invoice_collection,
              COALESCE(SUM(CASE WHEN pl.bucket = 'future' THEN pl.amount END), 0) AS future_invoice_collection
         FROM pay_lines_today pl
         JOIN customer_officer_map m ON m.customer_id = pl.customer_id
        GROUP BY m.officer_id, m.officer_name
     )
     SELECT COALESCE(o.officer_id, p.officer_id)              AS officer_id,
            COALESCE(o.officer_name, p.officer_name)          AS officer_name,
            COALESCE(o.arrears_now, 0)                        AS arrears_now,
            COALESCE(o.overdue_count, 0)                      AS overdue_invoice_count,
            COALESCE(p.arrear_collected, 0)                   AS arrear_collected,
            COALESCE(p.today_invoice_collection, 0)           AS today_invoice_collection,
            COALESCE(p.future_invoice_collection, 0)          AS future_invoice_collection
       FROM overdue_per_officer o
       FULL OUTER JOIN pay_per_officer p ON p.officer_id = o.officer_id`,
    [date],
  );
  const out = new Map();
  for (const row of r.rows) {
    const arrears_now = Number(row.arrears_now);
    const arrear_collected = Number(row.arrear_collected);
    const today_invoice_collection = Number(row.today_invoice_collection);
    const future_invoice_collection = Number(row.future_invoice_collection);
    out.set(row.officer_id, {
      officer_id: row.officer_id,
      officer_name: row.officer_name,
      arrears_now,
      arrear_collected,
      today_invoice_collection,
      future_invoice_collection,
      // Back-compat alias — sum of today + future. Older API consumers
      // (older dashboard JS bundles in browser cache) still read this.
      open_invoice_collection: today_invoice_collection + future_invoice_collection,
      overdue_invoice_count: Number(row.overdue_invoice_count),
      arrears_morning: arrears_now + arrear_collected,
    });
  }
  return out;
}

/**
 * Phase 4: Read pre-computed per-(date, officer) aggregates from
 * daily_officer_snapshot. Replaces the multi-day fan-out in mega-report's
 * aggregateOfficers. One SQL query, indexed scan, ~5 ms for any window
 * length.
 *
 * Returns Array<{ date, officer_id, ...all snapshot fields }>.
 */
export async function readDailyOfficerSnapshot(from, to, officerIdFilter) {
  const params = [from, to];
  let officerClause = '';
  if (officerIdFilter) {
    params.push(String(officerIdFilter));
    officerClause = ' AND officer_id = $3';
  }
  const r = await db().query(
    `SELECT date, officer_id, officer_name,
            total_invoice_amount, today_balance_remain, open_invoice_count,
            arrears_now, arrears_morning, arrear_collected,
            today_invoice_collection, future_invoice_collection,
            open_invoice_collection, overdue_invoice_count, computed_at
       FROM daily_officer_snapshot
      WHERE date BETWEEN $1 AND $2${officerClause}
      ORDER BY date, officer_id`,
    params,
  );
  return r.rows.map((row) => ({
    date: row.date,
    officer_id: row.officer_id,
    officer_name: row.officer_name,
    total_invoice_amount: Number(row.total_invoice_amount),
    today_balance_remain: Number(row.today_balance_remain),
    open_invoice_count: Number(row.open_invoice_count),
    arrears_now: Number(row.arrears_now),
    arrears_morning: Number(row.arrears_morning),
    arrear_collected: Number(row.arrear_collected),
    today_invoice_collection: Number(row.today_invoice_collection ?? 0),
    future_invoice_collection: Number(row.future_invoice_collection ?? 0),
    open_invoice_collection: Number(row.open_invoice_collection),
    overdue_invoice_count: Number(row.overdue_invoice_count),
    computed_at: row.computed_at,
  }));
}

export async function getOfficerArrears(snapshotDate) {
  const r = await db().query(
    `SELECT officer_id, officer_name, total_arrears, overdue_invoice_count, cached_at
       FROM officer_arrears_snapshots
      WHERE snapshot_date = $1`,
    [snapshotDate],
  );
  const map = new Map();
  for (const x of r.rows) {
    map.set(x.officer_id, {
      officer_id: x.officer_id,
      officer_name: x.officer_name,
      total_arrears: Number(x.total_arrears),
      overdue_invoice_count: Number(x.overdue_invoice_count),
      cached_at: x.cached_at,
    });
  }
  return map;
}

export async function getOfficerInvoiceTotals(snapshotDate) {
  const r = await db().query(
    `SELECT officer_id, officer_name, total_invoice_amount, open_invoice_count,
            today_balance_remain, cached_at
       FROM officer_invoice_snapshots
      WHERE snapshot_date = $1`,
    [snapshotDate],
  );
  const map = new Map();
  for (const x of r.rows) {
    map.set(x.officer_id, {
      officer_id: x.officer_id,
      officer_name: x.officer_name,
      total_invoice_amount: Number(x.total_invoice_amount),
      open_invoice_count: Number(x.open_invoice_count),
      today_balance_remain: Number(x.today_balance_remain || 0),
      cached_at: x.cached_at,
    });
  }
  return map;
}

// ── Phase 4 — the report ────────────────────────────────────────────────────

const FEE_PER_MOTO = 12_000; // TZS per OFFICE/POLICE motorcycle (Frank's spec)
const GOOD_THRESHOLD_PCT = 81;

// Officers Frank wants hidden from the report (inactive / blocked / not real
// loan officers). Names matched case-insensitively against officer_name.
const EXCLUDED_OFFICER_NAMES = new Set([
  'PERIS THOMAS OKALA',
  'SULEIMAN LUMBWE BODA',
  'DANIEL MTERA RHOBI',
  'HYUVIN RICHARD I BLOCKED',
  'RACHEAL MNZAVAS IPHONE',
  'ZAHARA IPHONE',
  'IGROUP COMPANY LIMITED',
  'MUTESI SANGABO',
  'MUTESI IPHONE BLOCKED',
  'CAROLINE E MATHEW',
  'ASNATH CHARLES',
  'HYUVIN RICHARD',
  'HAPPY MAGARI',
]);
function isExcluded(name) {
  // Collapse runs of whitespace so "MUTESI  IPHONE BLOCKED" (double space)
  // matches "MUTESI IPHONE BLOCKED".
  const norm = String(name || '').trim().toUpperCase().replace(/\s+/g, ' ');
  return EXCLUDED_OFFICER_NAMES.has(norm);
}

/**
 * Compute, for one date, the full officer-collections report:
 *   open       = invoice_total − offline_count × 12,000
 *   collection = today's payments for officer's riders (from payment_uploads)
 *   dueopen    = open − collection
 *   percent    = collection / open × 100  (color band)
 *
 * Reads three already-populated tables:
 *   - officer_invoice_snapshots  (Phase 3 — refresh in cron + on demand)
 *   - officer_offline_motos      (Phase 2 — refresh each morning + on demand)
 *   - payment_uploads + customer_officer_map (Phase 1) for collections — live join
 */
export async function computeOfficerReport(date) {
  await ensureSchema();

  // Today's collections per officer, joined live from payment_uploads.
  const collectionsRes = await db().query(
    `SELECT m.officer_id, m.officer_name,
            COALESCE(SUM(pu.amount), 0) AS collection,
            COUNT(*) AS payment_count
       FROM payment_uploads pu
       JOIN customer_officer_map m ON m.customer_id = pu.customer_id
       JOIN payment_batches pb ON pb.id = pu.batch_id
      WHERE (pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date = $1
        AND pu.status = 'created'
      GROUP BY m.officer_id, m.officer_name`,
    [date],
  );
  const collections = new Map();
  for (const r of collectionsRes.rows) {
    collections.set(r.officer_id, {
      officer_name: r.officer_name,
      collection: Number(r.collection),
      payment_count: Number(r.payment_count),
    });
  }

  const invoiceTotals = await getOfficerInvoiceTotals(date);
  const offlineCounts = await getOfficerOfflineCounts(date);
  const arrears = await getOfficerArrears(date);

  // Union of officer ids across the four sources.
  const officerIds = new Set([
    ...invoiceTotals.keys(),
    ...offlineCounts.keys(),
    ...collections.keys(),
    ...arrears.keys(),
  ]);

  const rows = [];
  for (const id of officerIds) {
    const inv = invoiceTotals.get(id);
    const off = offlineCounts.get(id);
    const col = collections.get(id);
    const arr = arrears.get(id);
    const name = inv?.officer_name || off?.officer_name || arr?.officer_name || col?.officer_name || 'Unknown';
    if (isExcluded(name)) continue; // hidden by operator preference

    const total_invoice_amount = inv?.total_invoice_amount || 0;
    const offline_count = off?.offline_total || 0;
    const open = Math.max(0, total_invoice_amount - offline_count * FEE_PER_MOTO);
    const collection = col?.collection || 0;
    const dueopen = open - collection;
    const percent = open > 0 ? (collection / open) * 100 : null;
    const status = percent == null ? 'no_invoices' :
                   percent >= GOOD_THRESHOLD_PCT ? 'good' : 'bad';

    rows.push({
      officer_id: id,
      officer_name: name,
      total_invoice_amount,
      today_balance_remain: inv?.today_balance_remain || 0,
      open_invoice_count: inv?.open_invoice_count || 0,
      total_arrears: arr?.total_arrears || 0,
      overdue_invoice_count: arr?.overdue_invoice_count || 0,
      office_count: off?.office_count || 0,
      police_count: off?.police_count || 0,
      offline_count,
      offline_adjustment: offline_count * FEE_PER_MOTO,
      open,
      collection,
      payment_count: col?.payment_count || 0,
      dueopen,
      percent: percent == null ? null : Math.round(percent * 100) / 100,
      status,
    });
  }

  rows.sort((a, b) => b.total_invoice_amount - a.total_invoice_amount);

  // Grand totals.
  const grand = rows.reduce((acc, r) => ({
    total_invoice_amount: acc.total_invoice_amount + r.total_invoice_amount,
    today_balance_remain: acc.today_balance_remain + r.today_balance_remain,
    total_arrears: acc.total_arrears + r.total_arrears,
    offline_count: acc.offline_count + r.offline_count,
    offline_adjustment: acc.offline_adjustment + r.offline_adjustment,
    open: acc.open + r.open,
    collection: acc.collection + r.collection,
    dueopen: acc.dueopen + r.dueopen,
  }), { total_invoice_amount: 0, today_balance_remain: 0, total_arrears: 0,
        offline_count: 0, offline_adjustment: 0, open: 0, collection: 0, dueopen: 0 });
  grand.percent = grand.open > 0 ? Math.round((grand.collection / grand.open) * 10000) / 100 : null;
  grand.status = grand.percent == null ? 'no_invoices' :
                 grand.percent >= GOOD_THRESHOLD_PCT ? 'good' : 'bad';

  // Cache freshness — when was each source last pulled?
  const cacheRes = await db().query(
    `SELECT MAX(cached_at) AS last FROM officer_invoice_snapshots WHERE snapshot_date = $1`,
    [date],
  );
  const offlineCacheRes = await db().query(
    `SELECT MAX(cached_at) AS last FROM officer_offline_motos WHERE snapshot_date = $1`,
    [date],
  );
  const arrearsCacheRes = await db().query(
    `SELECT MAX(cached_at) AS last FROM officer_arrears_snapshots WHERE snapshot_date = $1`,
    [date],
  );

  return {
    date,
    per_officer: rows,
    grand_total: grand,
    fresh: {
      invoice_totals_pulled_at: cacheRes.rows[0]?.last || null,
      offline_motos_pulled_at: offlineCacheRes.rows[0]?.last || null,
      arrears_pulled_at: arrearsCacheRes.rows[0]?.last || null,
    },
  };
}

function todayEatDate() {
  // Africa/Dar_es_Salaam is UTC+3 (no DST). Use UTC arithmetic.
  const now = new Date();
  const eat = new Date(now.getTime() + 3 * 60 * 60 * 1000);
  return eat.toISOString().slice(0, 10); // YYYY-MM-DD
}

// ── Day-summary KPIs ───────────────────────────────────────────────────────

/**
 * Sum of QB Payments deposited TODAY into the Kijichi Collection AC account,
 * regardless of source (BRAIN upload, manual, SaasAnt). Uses TxnDate = today.
 */
export async function getKijichiTodayTotal(dateOverride) {
  // Look up the account id once per session.
  const today = dateOverride || todayEatDate();
  const acctRes = await qbQuery(
    `SELECT Id, Name FROM Account WHERE Name = '${KIJICHI_ACCOUNT_NAME.replace(/'/g, "''")}'`,
  );
  const acct = acctRes.QueryResponse?.Account?.[0];
  if (!acct) {
    return { account_name: KIJICHI_ACCOUNT_NAME, account_id: null, date: today,
             rows: 0, total: 0, note: 'account not found in QB' };
  }
  // QBO restriction: DepositToAccountRef is NOT queryable in WHERE.
  // Pull all Payments for today, then filter locally by DepositToAccountRef.
  const all = [];
  const BATCH = 1000;
  let start = 1;
  while (true) {
    const r = await qbQuery(
      `SELECT Id, TotalAmt, TxnDate, DepositToAccountRef ` +
      `FROM Payment WHERE TxnDate = '${today}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${BATCH}`,
    );
    const rows = r.QueryResponse?.Payment || [];
    all.push(...rows);
    if (rows.length < BATCH) break;
    start += BATCH;
  }
  const matched = all.filter((p) => String(p.DepositToAccountRef?.value || '') === String(acct.Id));
  const total = matched.reduce((s, p) => s + Number(p.TotalAmt || 0), 0);
  return {
    account_name: acct.Name,
    account_id: acct.Id,
    date: today,
    rows: matched.length,
    total,
    total_payments_today: all.length,
    note: `filtered ${matched.length} of ${all.length} today's Payments by DepositToAccountRef`,
  };
}

/**
 * Per-channel total from each bank's sheet since the current upload-day-start
 * (last kili1615 cutoff). Reads PASSED tab, parses date col (B), sums amount
 * col (E). Used to show "what's in the sheet since upload day began".
 */
export async function getSheetTotalsSinceUploadDayStart() {
  const start = uploadDayStart(new Date());
  const out = [];
  for (const [channel, cfg] of Object.entries(BANK_SHEETS)) {
    let rows = 0, total = 0;
    try {
      const sheet = await readSheet(cfg.sheetId, `${cfg.tab}!A1:F100000`);
      const data = sheet.values || [];
      for (let i = 1; i < data.length; i++) {
        const r = data[i] || [];
        const ts = parseSheetTs(r[1]);
        if (!ts || ts < start) continue;
        rows++;
        total += Number(String(r[4] || '').replace(/[, ]/g, '')) || 0;
      }
    } catch (e) {
      // Continue with 0 if a sheet read fails.
      console.error('[sheet-totals]', channel, e.message);
    }
    out.push({ channel, rows, total });
  }
  return { upload_day_start: start.toISOString(), by_channel: out };
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

  // POST /api/officer-reports/refresh-invoice-totals
  // FIRE-AND-ACK: returns immediately, scans all open invoices in background.
  // QB scan can take 60–120s for thousands of invoices; this avoids blocking
  // the Render event loop. Poll GET /invoice-totals for completion.
  // Cached for 5 min — pass {force:true} to bypass.
  app.post('/api/officer-reports/refresh-invoice-totals', requireSecretOrJwt, async (req, res) => {
    const force = !!req.body?.force;
    res.json({ ok: true, started: true, note: 'scan running in background — poll GET /invoice-totals' });
    refreshOfficerInvoiceTotals({ force })
      .then((stats) => console.log('[officer-reports] invoice-totals refresh done:', JSON.stringify(stats)))
      .catch((err) => console.error('[officer-reports] invoice-totals refresh failed:', err));
  });

  // POST /api/officer-reports/refresh-arrears
  // Heavy scan — all overdue (Balance>0 AND DueDate<today) invoices.
  // FIRE-AND-ACK, 30-min cache.
  app.post('/api/officer-reports/refresh-arrears', requireSecretOrJwt, async (req, res) => {
    const force = !!req.body?.force;
    res.json({ ok: true, started: true, note: 'arrears scan running in background — poll GET /today' });
    refreshOfficerArrears({ force })
      .then((stats) => console.log('[officer-reports] arrears refresh done:', JSON.stringify(stats)))
      .catch((err) => console.error('[officer-reports] arrears refresh failed:', err));
  });

  // GET /api/officer-reports/invoice-totals?date=YYYY-MM-DD
  app.get('/api/officer-reports/invoice-totals', requireSecretOrJwt, async (req, res) => {
    try {
      await ensureSchema();
      const date = String(req.query.date || todayEatDate());
      const map = await getOfficerInvoiceTotals(date);
      const rows = [...map.values()].sort((a, b) => b.total_invoice_amount - a.total_invoice_amount);
      res.json({ snapshot_date: date, per_officer: rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/officer-reports/today?date=YYYY-MM-DD — THE report
  // Combines Phases 2 + 3 + live payment_uploads collection sum into the
  // per-officer { open, collection, dueopen, percent, status } breakdown.
  // Returns immediately from cached snapshots — never blocks on QB.
  app.get('/api/officer-reports/today', requireSecretOrJwt, async (req, res) => {
    try {
      const date = String(req.query.date || todayEatDate());
      const report = await computeOfficerReport(date);
      res.json(report);
    } catch (err) {
      console.error('[officer-reports] today failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/officer-reports/kijichi-today
  app.get('/api/officer-reports/kijichi-today', requireSecretOrJwt, async (req, res) => {
    try {
      const date = req.query.date ? String(req.query.date) : null;
      const out = await getKijichiTodayTotal(date);
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/officer-reports/sheet-totals-uploadday
  app.get('/api/officer-reports/sheet-totals-uploadday', requireSecretOrJwt, async (req, res) => {
    try {
      const out = await getSheetTotalsSinceUploadDayStart();
      res.json(out);
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
