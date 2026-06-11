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
    // 4 was too small once the CDC poller + snapshot refresher run
    // alongside report endpoints + the agent. Healthcheck would hang
    // waiting for a connection while CDC held one for >60s, and
    // Render would restart the dyno. 10 leaves headroom even under
    // backfill + CDC + reporting concurrency.
    max: 10,
    idleTimeoutMillis: 30_000,
  });
  _pool.on('error', (err) => {
    console.error('[db] pool error', err.message);
  });
  return _pool;
}
