import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from './db/pool.js';

const { STATEMENT_REPORT_SECRET, SUPABASE_URL } = process.env;

const SUPABASE_JWKS = SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

/**
 * Settings API — runtime toggles persisted in app_settings.
 *
 *   GET  /api/settings                   — admin lists all (Supabase JWT)
 *   GET  /api/settings/:key              — worker / dashboard read (worker can use shared secret OR JWT)
 *   PUT  /api/settings/:key { value }    — admin writes (Supabase JWT)
 *
 * The :key path is locked to a known allowlist so a stolen JWT can't write
 * arbitrary settings.
 */
const ALLOWED_KEYS = new Set([
  'statement_pull_enabled',
  'admin_phones',              // SMS recipient list (dashboard /admin-sms page)
  'sms_recipients',            // legacy key for the same thing
  'agent_scheduler_enabled',   // BRAIN agent scheduler toggle
]);

export function mountSettingsApi(app) {
  app.get('/api/settings', requireAuth, async (_req, res) => {
    try {
      const r = await db().query(
        `SELECT key, value, updated_at, updated_by FROM app_settings ORDER BY key`,
      );
      res.json({ settings: r.rows });
    } catch (err) {
      console.error('[GET /api/settings]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Worker reads /api/settings/:key on each tick start. Accept either the
  // shared secret (worker) OR a Supabase JWT (dashboard preview).
  app.get('/api/settings/:key', requireAuthOrReportSecret, async (req, res) => {
    try {
      if (!ALLOWED_KEYS.has(req.params.key)) {
        return res.status(404).json({ error: 'unknown setting key' });
      }
      const r = await db().query(
        `SELECT key, value, updated_at, updated_by FROM app_settings WHERE key = $1`,
        [req.params.key],
      );
      if (!r.rows.length) return res.status(404).json({ error: 'setting not found' });
      res.json({ setting: r.rows[0] });
    } catch (err) {
      console.error('[GET /api/settings/:key]', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/:key', requireAuth, async (req, res) => {
    try {
      const key = req.params.key;
      if (!ALLOWED_KEYS.has(key)) {
        return res.status(404).json({ error: 'unknown setting key' });
      }
      const value = String(req.body?.value ?? '');
      if (!value) return res.status(400).json({ error: 'value is required' });
      const updatedBy = `admin:${req.user?.email ?? req.user?.id ?? 'unknown'}`;

      const r = await db().query(
        `INSERT INTO app_settings (key, value, updated_by)
         VALUES ($1, $2, $3)
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING key, value, updated_at, updated_by`,
        [key, value, updatedBy],
      );
      res.json({ setting: r.rows[0] });
    } catch (err) {
      console.error('[PUT /api/settings/:key]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Emergency operator-toggle via shared secret (no JWT needed).
  // Body: { key, value } where key is in ALLOWED_KEYS.
  // Use case: scheduler is firing prematurely and operator needs to kill it
  // without going through dashboard auth flow.
  app.post('/api/settings/emergency-set', requireReportSecret, async (req, res) => {
    try {
      const key = String(req.body?.key || '');
      const value = String(req.body?.value ?? '');
      if (!ALLOWED_KEYS.has(key)) return res.status(404).json({ error: 'unknown setting key' });
      const r = await db().query(
        `INSERT INTO app_settings (key, value, updated_by)
         VALUES ($1, $2, 'emergency-shared-secret')
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING key, value, updated_at, updated_by`,
        [key, value],
      );
      res.json({ ok: true, setting: r.rows[0] });
    } catch (err) {
      console.error('[POST /api/settings/emergency-set]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Worker also POSTs here when retries exhaust — auto-disables the loop.
  // Uses the shared X-Report-Secret so the worker can self-toggle without a
  // human JWT. The body is { reason: "..." }.
  app.post('/api/settings/auto-disable-loop', requireReportSecret, async (req, res) => {
    try {
      const reason = String(req.body?.reason ?? 'unspecified');
      const r = await db().query(
        `INSERT INTO app_settings (key, value, updated_by)
         VALUES ('statement_pull_enabled', 'false', $1)
         ON CONFLICT (key) DO UPDATE
           SET value = 'false',
               updated_at = now(),
               updated_by = EXCLUDED.updated_by
         RETURNING key, value, updated_at, updated_by`,
        [`worker:auto-disable: ${reason.slice(0, 200)}`],
      );
      res.json({ ok: true, setting: r.rows[0] });
    } catch (err) {
      console.error('[POST /api/settings/auto-disable-loop]', err);
      res.status(500).json({ error: err.message });
    }
  });
}

function requireReportSecret(req, res, next) {
  if (!STATEMENT_REPORT_SECRET) {
    return res.status(503).json({ error: 'STATEMENT_REPORT_SECRET not configured' });
  }
  const got = req.get('x-report-secret');
  if (got !== STATEMENT_REPORT_SECRET) return res.status(401).json({ error: 'bad secret' });
  next();
}

async function requireAuth(req, res, next) {
  if (!SUPABASE_JWKS) return res.status(503).json({ error: 'SUPABASE_URL not configured' });
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try {
    const { payload } = await jwtVerify(token, SUPABASE_JWKS, {
      issuer: `${SUPABASE_URL}/auth/v1`,
    });
    req.user = { id: payload.sub, email: payload.email, role: payload.role };
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid token: ' + err.message });
  }
}

// For endpoints the worker AND the dashboard both read.
async function requireAuthOrReportSecret(req, res, next) {
  if (req.get('x-report-secret')) return requireReportSecret(req, res, next);
  return requireAuth(req, res, next);
}
