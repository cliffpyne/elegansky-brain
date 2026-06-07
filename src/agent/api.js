// HTTP API for the autonomous Claude agent.
//
// Endpoints:
//   POST /api/agent/run             — fire a new session (auth: X-Report-Secret)
//                                      body: { trigger, triggerContext, mode? }
//   POST /api/sms-inbox             — phone APK posts inbound SMS here
//                                      (auth: X-Phone-Key)
//                                      body: { from, message }
//                                      → enqueues sms_inbox row → spawns session
//   GET  /api/agent/sessions        — list recent sessions (JWT)
//   GET  /api/agent/sessions/:id    — session detail + message stream (JWT)
//
// The /run endpoint is called by Render Cron Jobs on schedule. Each cron
// passes its own trigger string ('cron:03:00') and context (window, AS_OF).

import { db } from '../db/pool.js';
import { runSession } from './runner.js';
import { notifyAdmin } from '../notifications.js';

export function mountAgentApi(app, { requireSharedSecret, requireSupabaseJwt, requirePhoneKey }) {
  // Accept EITHER X-Report-Secret (cron/CLI) OR Supabase JWT (dashboard).
  const agentRunAuth = (req, res, next) => {
    const secret = process.env.STATEMENT_REPORT_SECRET;
    if (secret && req.get('x-report-secret') === secret) return next();
    return requireSupabaseJwt(req, res, next);
  };

  // ── Fire an agent session ────────────────────────────────────────────────
  app.post('/api/agent/run', agentRunAuth, async (req, res) => {
    const { trigger = 'manual', triggerContext = {}, mode = 'execute', parentSessionId = null } = req.body || {};
    if (!['plan', 'execute'].includes(mode)) return res.status(400).json({ error: 'mode must be plan|execute' });
    try {
      // Run fire-and-acknowledge: respond with sessionId immediately, let the
      // loop run async. Render cron only cares about HTTP 200.
      const pool = db();
      const seedRow = await pool.query(
        `INSERT INTO agent_sessions (trigger, trigger_context, mode, model, parent_session_id)
         VALUES ($1, $2, $3, 'pending-spawn', $4) RETURNING id`,
        [trigger, JSON.stringify(triggerContext), mode, parentSessionId],
      );
      const seedId = seedRow.rows[0].id;
      res.json({ ok: true, seed_session_id: seedId, note: 'spawning async; poll /api/agent/sessions/:id for status' });

      // Spawn the real session in background. The seed row above is unused —
      // we just needed an id to return synchronously. Drop it after.
      runSession({ db: pool, trigger, triggerContext, mode, parentSessionId })
        .then(async (r) => {
          await pool.query(`DELETE FROM agent_sessions WHERE id=$1`, [seedId]);
          console.log(`[agent] session ${r.sessionId} ${r.status} — turns=${r.turns} cost=$${r.cost_usd}`);
        })
        .catch(async (err) => {
          console.error('[agent] runSession threw:', err);
          await pool.query(
            `UPDATE agent_sessions SET status='errored', error_text=$2, ended_at=now() WHERE id=$1`,
            [seedId, String(err.message || err).slice(0, 1000)],
          );
          notifyAdmin({
            message: `BRAIN agent errored on ${trigger}: ${String(err.message || err).slice(0, 200)}`,
            severity: 'critical',
            source: 'agent:spawn',
          });
        });
    } catch (err) {
      console.error('[agent/run] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Inbound SMS from the phone APK ────────────────────────────────────────
  // The APK posts here whenever Frank texts the gateway. We enqueue the
  // message in sms_inbox and spawn an agent session to handle it.
  app.post('/api/sms-inbox', requirePhoneKey, async (req, res) => {
    const { from, message } = req.body || {};
    if (!from || !message) return res.status(400).json({ error: 'from + message required' });
    try {
      const pool = db();
      const inboxRow = await pool.query(
        `INSERT INTO sms_inbox (from_number, message) VALUES ($1, $2) RETURNING id`,
        [String(from), String(message).slice(0, 2000)],
      );
      const inboxId = inboxRow.rows[0].id;
      res.json({ ok: true, inbox_id: inboxId, note: 'spawning agent session' });

      // Spawn session with trigger='sms:ask'
      runSession({
        db: pool,
        trigger: 'sms:ask',
        triggerContext: { from, message, inbox_id: inboxId },
        mode: 'execute',
      })
        .then(async (r) => {
          await pool.query(
            `UPDATE sms_inbox SET processed=true, processed_at=now(), spawned_session_id=$2 WHERE id=$1`,
            [inboxId, r.sessionId],
          );
        })
        .catch(async (err) => {
          console.error('[sms-inbox] session errored:', err);
          notifyAdmin({
            message: `BRAIN couldn't handle your SMS: ${String(err.message || err).slice(0, 100)}`,
            severity: 'warning',
            source: 'agent:sms-error',
          });
        });
    } catch (err) {
      console.error('[sms-inbox] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Dashboard reads ──────────────────────────────────────────────────────
  app.get('/api/agent/sessions', requireSupabaseJwt, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 200);
      // FILTER seed rows (model='pending-spawn') — these are short-lived
      // placeholders that exist only between the sync HTTP response and the
      // real session insert. Showing them in the dashboard made every fire
      // look like a double-fire (Frank case 2026-06-07). They get deleted
      // automatically when the real session finishes.
      const r = await db().query(
        `SELECT id, trigger, trigger_context, mode, model, status, summary, stats,
                input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cost_usd,
                started_at, ended_at
           FROM agent_sessions
          WHERE model IS DISTINCT FROM 'pending-spawn'
          ORDER BY started_at DESC LIMIT $1`,
        [limit],
      );
      res.json({ sessions: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/agent/sessions/:id', requireSupabaseJwt, async (req, res) => {
    try {
      const sess = await db().query(`SELECT * FROM agent_sessions WHERE id=$1`, [req.params.id]);
      if (!sess.rows.length) return res.status(404).json({ error: 'not found' });
      const msgs = await db().query(
        `SELECT id, role, kind, payload, created_at FROM agent_session_messages WHERE session_id=$1 ORDER BY id`,
        [req.params.id],
      );
      res.json({ session: sess.rows[0], messages: msgs.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // ── GET / POST scheduler toggle (dashboard button) ───────────────────────
  app.get('/api/agent/scheduler', requireSupabaseJwt, async (req, res) => {
    try {
      const r = await db().query(`SELECT value, updated_at, updated_by FROM app_settings WHERE key = 'agent_scheduler_enabled'`);
      const enabled = r.rows.length === 0 ? true : String(r.rows[0].value).toLowerCase() === 'true';
      res.json({
        enabled,
        env_master_switch: process.env.AGENT_SCHEDULER_ENABLED !== 'false',
        last_changed: r.rows[0]?.updated_at || null,
        last_changed_by: r.rows[0]?.updated_by || null,
      });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/admin/abort-running-agents
  // Body: { older_than_seconds? }  default 60
  // Marks any agent_sessions row in status='running' that was started more
  // than {older_than_seconds} ago as 'aborted'. Use to clean stuck sessions
  // from the dashboard list when an upload hung. The actual Node process
  // running runSession may still be in flight in memory but won't be able
  // to update DB once we mark aborted — and the lock release happens in
  // the auto-upload endpoint's release path regardless.
  app.post('/api/admin/abort-running-agents', requireSupabaseJwt, async (req, res) => {
    try {
      const olderThanSeconds = Number(req.body?.older_than_seconds || 60);
      const result = await db().query(
        `UPDATE agent_sessions
            SET status='aborted',
                ended_at=now(),
                error_text=COALESCE(error_text,'')
                  || ' [admin abort: stuck >' || $1 || 's]'
          WHERE status='running'
            AND started_at < now() - ($1 || ' seconds')::interval
          RETURNING id, trigger, started_at`,
        [String(olderThanSeconds)],
      );
      res.json({
        ok: true,
        aborted_count: result.rowCount,
        threshold_seconds: olderThanSeconds,
        sample: result.rows.slice(0, 10).map((r) => ({
          id: String(r.id).slice(0, 8),
          trigger: r.trigger,
          started: r.started_at,
        })),
      });
    } catch (err) {
      console.error('[abort-running-agents] failed:', err);
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/agent/scheduler', requireSupabaseJwt, async (req, res) => {
    try {
      const value = req.body?.enabled === true ? 'true' : 'false';
      const who = req.body?.by || 'dashboard';
      await db().query(
        `INSERT INTO app_settings (key, value, updated_by) VALUES ('agent_scheduler_enabled', $1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = now()`,
        [value, who],
      );
      res.json({ ok: true, enabled: value === 'true' });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // ── Cost roll-up (last 30 days) ──────────────────────────────────────────
  app.get('/api/agent/cost-summary', requireSupabaseJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT
           date_trunc('day', started_at)::date AS day,
           COUNT(*)               AS sessions,
           SUM(input_tokens)      AS in_tok,
           SUM(output_tokens)     AS out_tok,
           SUM(cache_read_tokens) AS cache_read,
           SUM(cache_write_tokens) AS cache_write,
           SUM(cost_usd)          AS cost_usd
         FROM agent_sessions
         WHERE started_at > now() - interval '30 days'
         GROUP BY 1 ORDER BY 1 DESC`,
      );
      res.json({ days: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
