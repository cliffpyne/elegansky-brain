import pg from 'pg';

const { Pool } = pg;

/**
 * One Postgres pool shared by every BRAIN endpoint that needs DB.
 * Reads DATABASE_URL (Supabase session pooler) from env. We use the same
 * Supabase project as the disburser so connections stay below the plan limit.
 */
let _pool = null;

export function db() {
  if (_pool) return _pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('DATABASE_URL not set');
  _pool = new Pool({
    connectionString: url,
    ssl: { rejectUnauthorized: false }, // Supabase requires TLS
    // Frank 2026-07-15: bumped max 10→30 + added statement_timeout=5min after
    // kili1615 batch orchestrator died at Postgres default timeout while
    // dashboard requests starved on the small pool. Root cause is a slow
    // arrears query on qb_invoices (needs index) — mitigation is bigger pool
    // + longer per-query budget so orchestrator finishes without competing
    // with API endpoints for slots.
    max: 30,
    idleTimeoutMillis: 30_000,
    // Per-session statement_timeout applies to every query on every checked-out
    // connection — including the async runners. Postgres kills any query
    // exceeding this. 5 min is enough for full arrears + preflight passes.
    statement_timeout: 300_000,
  });
  _pool.on('error', (err) => {
    console.error('[db] pool error', err.message);
  });
  return _pool;
}
