import { createRemoteJWKSet, jwtVerify } from 'jose';
import { db } from './db/pool.js';

// AUTOSORT REMOVED 2026-05-31. The post-cycle read-clear-write pattern was
// racing with the processor's appends and silently wiping newly-appended
// rows. The replacement (per Frank's directive) is sort-before-upload: the
// NMB worker now sorts the CSV's data rows by date BEFORE handing the file
// to the processor, so the processor appends rows already in chronological
// order and no sheet-level sort is ever needed. See eleganskyCrdb commit
// for the worker-side sort. The admin one-shot sort endpoint is still
// available at /api/admin/sort-sheet-by-date for emergency manual use.

const {
  STATEMENT_REPORT_SECRET,
  SUPABASE_URL,
} = process.env;

// Verify Supabase access tokens via the project's JWKS endpoint. Works with
// both the legacy HS256 shared secret AND the new ECC P-256 asymmetric keys
// — Supabase publishes both at /auth/v1/.well-known/jwks.json and the jose
// library picks the right key per token's `kid` header. The JWKSet caches
// in memory + refreshes on key rotation.
const SUPABASE_JWKS = SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

/**
 * Mount the statement-cycles API on the given Express app.
 *
 *   POST /api/cycles      — worker reports a finished cycle (auth: shared secret)
 *   GET  /api/cycles      — dashboard reads recent cycles (auth: Supabase JWT)
 *   GET  /api/cycles/:id  — single cycle with screenshots (auth: Supabase JWT)
 *
 * Both auth modes are required env vars; missing them → 503 with a clear note
 * so the deploy fails loudly instead of silently letting anyone in.
 */
export function mountCyclesApi(app) {
  // ── POST /api/cycles — worker → BRAIN ────────────────────────────────────
  // Body shape (all fields optional except bank / status / started_at / finished_at):
  // {
  //   bank: "NMB" | "CRDB",
  //   status: "ok" | "fail",
  //   started_at: ISO8601,
  //   finished_at: ISO8601,
  //   worker_id: "render-statement-pull",
  //   stats: {...},                  // processor's stats
  //   processor_response: {...},     // raw processor body
  //   screenshots: ["data:image/png;base64,...", ...]  // up to 3 typically
  //   error_text: "..."              // only on fail
  // }
  app.post('/api/cycles', requireReportSecret, async (req, res) => {
    try {
      const body = req.body ?? {};
      const errors = validateReport(body);
      if (errors.length) return res.status(400).json({ error: errors.join('; ') });

      const startedAt = new Date(body.started_at);
      const finishedAt = new Date(body.finished_at);
      const durationMs = Math.max(0, finishedAt.getTime() - startedAt.getTime());

      // Cap screenshots so a runaway worker can't OOM the table.
      const screenshots = Array.isArray(body.screenshots)
        ? body.screenshots.slice(0, 10).map((s) => String(s).slice(0, 400_000))
        : null;

      const r = await db().query(
        `INSERT INTO statement_cycles (
           started_at, finished_at, duration_ms, worker_id,
           bank, status, stats, processor_response, screenshots, error_text
         )
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING id, reported_at`,
        [
          startedAt, finishedAt, durationMs,
          String(body.worker_id ?? 'unknown'),
          String(body.bank).toUpperCase(),
          String(body.status).toLowerCase(),
          body.stats ? JSON.stringify(body.stats) : null,
          body.processor_response ? JSON.stringify(body.processor_response) : null,
          screenshots,
          body.error_text ? String(body.error_text).slice(0, 4000) : null,
        ],
      );
      res.status(201).json({ ok: true, id: r.rows[0].id, reported_at: r.rows[0].reported_at });

      // Clear the heartbeat row for this worker — the cycle has officially
      // ended (success or fail). The dashboard's live panel then drops it
      // from the running list.
      db().query(`DELETE FROM cycle_heartbeats WHERE worker_id = $1`, [String(body.worker_id ?? 'unknown')])
        .catch((e) => console.warn('[cycles] heartbeat cleanup failed:', e.message));
    } catch (err) {
      console.error('[POST /api/cycles] ', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/cycles/heartbeat — worker emits its current step ───────────
  // Auth: shared secret. Upsert by (bank, worker_id) — one live row per
  // running cycle. The next step replaces the previous; when the cycle ends
  // /api/cycles inserts the final row and the heartbeat is deleted.
  // Body: { bank, worker_id, step_num, current_step }
  app.post('/api/cycles/heartbeat', requireReportSecret, async (req, res) => {
    try {
      const { bank, worker_id, step_num, current_step } = req.body ?? {};
      if (!bank || !worker_id) return res.status(400).json({ error: 'bank + worker_id required' });
      await db().query(
        `INSERT INTO cycle_heartbeats (worker_id, bank, step_num, current_step, last_seen)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (worker_id) DO UPDATE
           SET bank = EXCLUDED.bank,
               step_num = EXCLUDED.step_num,
               current_step = EXCLUDED.current_step,
               last_seen = now()`,
        [worker_id, String(bank).toUpperCase(), Number(step_num) || 0, String(current_step || '').slice(0, 200)],
      );
      res.json({ ok: true });
    } catch (err) {
      console.error('[POST /api/cycles/heartbeat]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/cycles/heartbeats — dashboard polls for active running cycles.
  // Filters out anything stale (>10 min since last_seen) since the worker
  // should ping at least every step; >10 min silence = the cycle died.
  app.get('/api/cycles/heartbeats', requireSupabaseJwt, async (_req, res) => {
    try {
      const r = await db().query(
        `SELECT worker_id, bank, cycle_started_at, step_num, current_step, last_seen,
                EXTRACT(EPOCH FROM (now() - cycle_started_at))::int AS running_seconds,
                EXTRACT(EPOCH FROM (now() - last_seen))::int AS silent_seconds
           FROM cycle_heartbeats
          WHERE last_seen > now() - interval '10 minutes'
          ORDER BY cycle_started_at DESC`,
      );
      res.json({ heartbeats: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── POST /api/cycles/fire — dashboard "fire NMB / fire CRDB" button ──────
  // Auth: Supabase JWT (operator only). Calls Render's Jobs API to spawn a
  // one-off invocation of the standalone runNmbCycle / runCrdbCycle script.
  // Requires RENDER_API_KEY + RENDER_WORKER_SERVICE_ID env vars on BRAIN.
  // Body: { bank: "NMB" | "CRDB" }
  app.post('/api/cycles/fire', requireSupabaseJwt, async (req, res) => {
    try {
      const bank = String(req.body?.bank ?? '').toUpperCase();
      if (bank !== 'NMB' && bank !== 'CRDB') {
        return res.status(400).json({ error: 'bank must be "NMB" or "CRDB"' });
      }
      const apiKey = process.env.RENDER_API_KEY;
      const serviceId = process.env.RENDER_WORKER_SERVICE_ID;
      if (!apiKey || !serviceId) {
        return res.status(503).json({
          error: 'RENDER_API_KEY and RENDER_WORKER_SERVICE_ID env vars not configured on BRAIN',
        });
      }
      const script = bank === 'NMB' ? 'runNmbCycle' : 'runCrdbCycle';
      const r = await fetch(`https://api.render.com/v1/services/${serviceId}/jobs`, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          startCommand: `node dist/statementPull/${script}.js`,
        }),
      });
      const body = await r.text();
      if (!r.ok) {
        return res.status(r.status).json({ error: `Render API ${r.status}: ${body.slice(0, 400)}` });
      }
      let json;
      try { json = JSON.parse(body); } catch { json = { raw: body }; }
      res.json({ ok: true, job: json });
    } catch (err) {
      console.error('[POST /api/cycles/fire]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/cycles — dashboard list ─────────────────────────────────────
  // Query params:
  //   limit  (default 50, max 200)     — page size
  //   offset (default 0)                — for cursor pagination
  //   bank   (NMB|CRDB|all)
  //   status (ok|fail|all)
  //   since  (ISO8601 lower bound on reported_at)
  // Screenshots are NOT returned in list view to keep payload small.
  // Response includes `total` so the dashboard can paginate.
  app.get('/api/cycles', requireSupabaseJwt, async (req, res) => {
    try {
      const limit = Math.min(200, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
      const offset = Math.max(0, parseInt(req.query.offset ?? '0', 10) || 0);
      const bank = String(req.query.bank ?? 'all').toUpperCase();
      const status = String(req.query.status ?? 'all').toLowerCase();
      const since = req.query.since ? new Date(String(req.query.since)) : null;

      const where = [];
      const args = [];
      if (bank === 'NMB' || bank === 'CRDB') { where.push(`bank = $${args.length + 1}`); args.push(bank); }
      if (status === 'ok' || status === 'fail') { where.push(`status = $${args.length + 1}`); args.push(status); }
      if (since && !isNaN(since.getTime())) { where.push(`reported_at >= $${args.length + 1}`); args.push(since); }

      const whereSql = where.length ? 'WHERE ' + where.join(' AND ') : '';
      const listSql = `
        SELECT id, reported_at, started_at, finished_at, duration_ms,
               worker_id, bank, status, stats, processor_response, error_text,
               coalesce(array_length(screenshots, 1), 0) AS screenshot_count
        FROM statement_cycles
        ${whereSql}
        ORDER BY reported_at DESC
        LIMIT ${limit} OFFSET ${offset}
      `;
      const countSql = `SELECT count(*)::int AS total FROM statement_cycles ${whereSql}`;
      const [listR, countR] = await Promise.all([
        db().query(listSql, args),
        db().query(countSql, args),
      ]);
      res.json({
        cycles: listR.rows,
        page: {
          limit,
          offset,
          total: countR.rows[0].total,
          has_more: offset + listR.rows.length < countR.rows[0].total,
        },
      });
    } catch (err) {
      console.error('[GET /api/cycles] ', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/cycles/_summary — last NMB + last CRDB + 24h counts ─────────
  // MUST be registered before /:id below — Express matches in declaration
  // order, so /:id would otherwise swallow /_summary and Postgres rejects
  // "_summary" as a UUID.
  // Drives the top status cards on the dashboard. Cheap query, cached for 5s
  // would be nice later but we just hit the DB each time for v1.
  app.get('/api/cycles/_summary', requireSupabaseJwt, async (_req, res) => {
    try {
      const last = await db().query(`
        SELECT DISTINCT ON (bank) bank, id, reported_at, status, duration_ms, stats, processor_response, error_text
        FROM statement_cycles
        ORDER BY bank, reported_at DESC
      `);
      const counts = await db().query(`
        SELECT bank,
               count(*) FILTER (WHERE status = 'ok')   AS ok_24h,
               count(*) FILTER (WHERE status = 'fail') AS fail_24h
        FROM statement_cycles
        WHERE reported_at >= now() - interval '24 hours'
        GROUP BY bank
      `);
      res.json({ last: last.rows, counts_24h: counts.rows });
    } catch (err) {
      console.error('[GET /api/cycles/_summary] ', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET /api/cycles/:id — single cycle (with screenshots) ────────────────
  // Registered LAST so static sub-paths above (e.g. /_summary) win the match.
  app.get('/api/cycles/:id', requireSupabaseJwt, async (req, res) => {
    try {
      const r = await db().query(`SELECT * FROM statement_cycles WHERE id = $1`, [req.params.id]);
      if (!r.rows.length) return res.status(404).json({ error: 'not found' });
      res.json({ cycle: r.rows[0] });
    } catch (err) {
      console.error('[GET /api/cycles/:id] ', err);
      res.status(500).json({ error: err.message });
    }
  });
}

function requireReportSecret(req, res, next) {
  if (!STATEMENT_REPORT_SECRET) {
    return res.status(503).json({ error: 'STATEMENT_REPORT_SECRET not configured on server' });
  }
  const got = req.get('x-report-secret');
  if (got !== STATEMENT_REPORT_SECRET) return res.status(401).json({ error: 'bad secret' });
  next();
}

async function requireSupabaseJwt(req, res, next) {
  if (!SUPABASE_JWKS) {
    return res.status(503).json({ error: 'SUPABASE_URL not configured on server' });
  }
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

function validateReport(b) {
  const errs = [];
  if (!b.bank || !/^(NMB|CRDB)$/i.test(b.bank)) errs.push('bank must be NMB or CRDB');
  if (!b.status || !/^(ok|fail)$/i.test(b.status)) errs.push('status must be ok or fail');
  if (!b.started_at || isNaN(new Date(b.started_at).getTime())) errs.push('started_at must be ISO8601');
  if (!b.finished_at || isNaN(new Date(b.finished_at).getTime())) errs.push('finished_at must be ISO8601');
  return errs;
}
