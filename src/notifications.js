// BRAIN notifications + SMS gateway.
//
// Three endpoints:
//   POST /api/notifications          — internal code paths fire here
//                                        (auth: X-Report-Secret)
//   GET  /api/notifications/pending  — Android phone APK polls here
//                                        (auth: X-Phone-Key)
//   POST /api/notifications/:id/ack  — phone marks as sent or failed
//                                        (auth: X-Phone-Key)
//
// Plus an admin UI:
//   GET  /api/admin/sms-recipients   — current list (JWT-protected)
//   POST /api/admin/sms-recipients   — replace list
//   POST /api/admin/notifications/test — push a test message
//
// The notifyAdmin() helper is exported for other modules to call.

import { db } from './db/pool.js';

export function notifyAdmin({ message, severity = 'info', source = '' }) {
  // Fire-and-forget. Never throw — a failed notify shouldn't break the
  // calling code path. Logs to console as a fallback.
  if (!message) return Promise.resolve();
  const sev = ['critical', 'warning', 'info'].includes(severity) ? severity : 'info';
  return db()
    .query(
      `INSERT INTO notifications (message, severity, source) VALUES ($1, $2, $3) RETURNING id`,
      [String(message).slice(0, 2000), sev, String(source || '').slice(0, 200)],
    )
    .then((r) => r.rows[0]?.id)
    .catch((err) => {
      console.error('[notifyAdmin] failed to enqueue:', err.message, '|', message);
      return null;
    });
}

export function mountNotificationsApi(app, { requireSharedSecret, requireSupabaseJwt, requirePhoneKey }) {
  // ── Internal: enqueue a notification ────────────────────────────────────
  app.post('/api/notifications', requireSharedSecret, async (req, res) => {
    try {
      const { message, severity, source } = req.body || {};
      if (!message) return res.status(400).json({ error: 'message required' });
      const sev = ['critical', 'warning', 'info'].includes(severity) ? severity : 'info';
      const r = await db().query(
        `INSERT INTO notifications (message, severity, source) VALUES ($1, $2, $3) RETURNING id`,
        [String(message).slice(0, 2000), sev, String(source || '').slice(0, 200)],
      );
      res.json({ id: r.rows[0].id, status: 'pending' });
    } catch (err) {
      console.error('[POST /api/notifications]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Phone: poll pending notifications ──────────────────────────────────
  // Atomically transitions pending → sending so two phones can't claim the
  // same notification. Phone has SENDING_TIMEOUT_MS to ACK or it's reclaimed.
  app.get('/api/notifications/pending', requirePhoneKey, async (_req, res) => {
    try {
      // First reclaim any 'sending' rows older than 5 minutes (stuck phone)
      await db().query(
        `UPDATE notifications SET status='pending', picked_up_at=NULL
          WHERE status='sending' AND picked_up_at < now() - INTERVAL '5 minutes'`,
      );

      // Atomically claim up to 50 pending rows. Recipients are managed via
      // the dashboard /admin-sms page which writes to app_settings.admin_phones.
      // The dashboard saves as a plain comma/newline-separated string (NOT
      // JSON), so we read as text and split. Legacy sms_recipients was a JSON
      // array — handle both shapes.
      const rcp = await db().query(
        `SELECT key, value FROM app_settings
          WHERE key IN ('admin_phones', 'sms_recipients')
          ORDER BY CASE key WHEN 'admin_phones' THEN 0 ELSE 1 END
          LIMIT 1`,
      );
      let recipients = [];
      if (rcp.rows.length) {
        const raw = String(rcp.rows[0].value || '').trim();
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) recipients = parsed.map((p) => String(p).trim()).filter(Boolean);
        } catch {
          // Not JSON — treat as comma/whitespace-separated.
          recipients = raw.split(/[,\s]+/).map((p) => p.trim()).filter(Boolean);
        }
      }

      const r = await db().query(
        `UPDATE notifications
            SET status='sending', picked_up_at=now(), sms_to=$1
          WHERE id IN (
            SELECT id FROM notifications
             WHERE status='pending'
             ORDER BY
               CASE severity WHEN 'critical' THEN 1 WHEN 'warning' THEN 2 ELSE 3 END,
               created_at
             FOR UPDATE SKIP LOCKED
             LIMIT 50
          )
          RETURNING id, message, severity, source, created_at, sms_to`,
        [recipients],
      );
      res.json({ recipients, pending: r.rows });
    } catch (err) {
      console.error('[GET /api/notifications/pending]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Phone: acknowledge ─────────────────────────────────────────────────
  app.post('/api/notifications/:id/ack', requirePhoneKey, async (req, res) => {
    try {
      const id = req.params.id;
      const { status, device_id, failure_reason } = req.body || {};
      if (status === 'sent') {
        await db().query(
          `UPDATE notifications
              SET status='sent', sent_at=now(), ack_device_id=$2
            WHERE id=$1`,
          [id, String(device_id || '').slice(0, 200)],
        );
      } else if (status === 'failed') {
        // Bump retry_count. After 5 retries, leave it as failed.
        const upd = await db().query(
          `UPDATE notifications
              SET status = CASE WHEN retry_count >= 4 THEN 'failed' ELSE 'pending' END,
                  retry_count = retry_count + 1,
                  failed_at = CASE WHEN retry_count >= 4 THEN now() ELSE failed_at END,
                  failure_reason = $3,
                  picked_up_at = NULL,
                  ack_device_id = $2
            WHERE id=$1
            RETURNING status, retry_count`,
          [id, String(device_id || '').slice(0, 200), String(failure_reason || '').slice(0, 500)],
        );
        return res.json({ ok: true, new_status: upd.rows[0]?.status, retry_count: upd.rows[0]?.retry_count });
      } else {
        return res.status(400).json({ error: 'status must be "sent" or "failed"' });
      }
      res.json({ ok: true });
    } catch (err) {
      console.error('[POST /api/notifications/:id/ack]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin: list recent notifications (for dashboard inbox) ─────────────
  app.get('/api/notifications', requireSupabaseJwt, async (req, res) => {
    try {
      const limit = Math.min(Number(req.query.limit) || 50, 500);
      const status = req.query.status ? String(req.query.status) : null;
      const severity = req.query.severity ? String(req.query.severity) : null;
      const where = [];
      const args = [];
      if (status) { args.push(status); where.push(`status = $${args.length}`); }
      if (severity) { args.push(severity); where.push(`severity = $${args.length}`); }
      const sql = `
        SELECT id, message, severity, source, status, retry_count, created_at,
               picked_up_at, sent_at, failed_at, failure_reason, sms_to, ack_device_id
          FROM notifications
         ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
         ORDER BY created_at DESC
         LIMIT ${limit}`;
      const r = await db().query(sql, args);
      res.json({ notifications: r.rows });
    } catch (err) {
      console.error('[GET /api/notifications]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin: manage SMS recipient list ───────────────────────────────────
  app.get('/api/admin/sms-recipients', requireSupabaseJwt, async (_req, res) => {
    try {
      const r = await db().query(
        `SELECT value::jsonb AS list, updated_at, updated_by
           FROM app_settings WHERE key='sms_recipients'`,
      );
      const row = r.rows[0];
      res.json({
        recipients: Array.isArray(row?.list) ? row.list : [],
        updated_at: row?.updated_at,
        updated_by: row?.updated_by,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.post('/api/admin/sms-recipients', requireSupabaseJwt, async (req, res) => {
    try {
      const { recipients } = req.body || {};
      if (!Array.isArray(recipients)) {
        return res.status(400).json({ error: 'recipients must be an array' });
      }
      // Normalize: trim, dedupe, only digits/+
      const cleaned = [...new Set(
        recipients
          .map((r) => String(r).trim())
          .filter((r) => /^\+?\d{7,15}$/.test(r))
      )];
      const updatedBy = req.auth?.sub || 'unknown';
      await db().query(
        `INSERT INTO app_settings (key, value, updated_by, updated_at)
         VALUES ('sms_recipients', $1, $2, now())
         ON CONFLICT (key) DO UPDATE
           SET value = EXCLUDED.value,
               updated_by = EXCLUDED.updated_by,
               updated_at = now()`,
        [JSON.stringify(cleaned), updatedBy],
      );
      res.json({ recipients: cleaned, updated_at: new Date().toISOString() });
    } catch (err) {
      console.error('[POST /api/admin/sms-recipients]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── Admin: push a test notification ────────────────────────────────────
  app.post('/api/admin/notifications/test', requireSupabaseJwt, async (req, res) => {
    try {
      const message = String(req.body?.message || 'BRAIN test notification — operator-triggered').slice(0, 500);
      const severity = req.body?.severity || 'info';
      const id = await notifyAdmin({ message, severity, source: 'manual-test' });
      res.json({ id, message, severity });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
