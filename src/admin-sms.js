// Admin SMS queue — message buffer between BRAIN (producer) and the
// always-online relay phone APK (consumer, task #23).
//
// Producers (worker/BRAIN) POST to /api/admin-sms/queue with a message.
// BRAIN looks up admin_phones from app_settings, fans out one row per phone.
//
// Consumer (the APK) polls GET /api/admin-sms/pending, sends each via
// SmsManager.sendTextMessage, then POSTs /api/admin-sms/:id/ack.

import { db } from './db/pool.js';

function requireSharedSecret(req, res, next) {
  const expected = process.env.STATEMENT_REPORT_SECRET;
  if (!expected || req.header('X-Report-Secret') !== expected) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  next();
}

async function getAdminPhones() {
  const r = await db().query(`SELECT value FROM app_settings WHERE key='admin_phones'`);
  if (!r.rows.length) return [];
  return String(r.rows[0].value || '')
    .split(/[,\s]+/)
    .map((p) => p.trim())
    .filter(Boolean);
}

export function mountAdminSmsApi(app) {
  // POST /api/admin-sms/queue — producer enqueues a message for all admins
  // Body: { message: "...", kind: "statement_pull_failure" | ... }
  app.post('/api/admin-sms/queue', requireSharedSecret, async (req, res) => {
    try {
      const { message, kind } = req.body ?? {};
      if (!message || typeof message !== 'string') {
        return res.status(400).json({ error: 'message required' });
      }
      const phones = await getAdminPhones();
      if (!phones.length) {
        // No admins configured → log and 200 (we don't want to wedge the
        // worker because the operator hasn't set a phone yet).
        console.warn('[admin-sms] queue requested but no admin_phones configured');
        return res.json({ queued: 0, note: 'no admin_phones configured' });
      }
      const truncated = String(message).slice(0, 1000);
      const ids = [];
      for (const phone of phones) {
        const r = await db().query(
          `INSERT INTO admin_sms_queue (to_phone, message, kind)
           VALUES ($1, $2, $3) RETURNING id`,
          [phone, truncated, kind || null],
        );
        ids.push(r.rows[0].id);
      }
      res.json({ queued: ids.length, ids });
    } catch (err) {
      console.error('[POST /api/admin-sms/queue]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin-sms/pending — APK polls this; returns up to 20 pending msgs
  app.get('/api/admin-sms/pending', requireSharedSecret, async (_req, res) => {
    try {
      const r = await db().query(
        `SELECT id, to_phone, message, kind, created_at
           FROM admin_sms_queue
          WHERE status='pending'
          ORDER BY created_at ASC LIMIT 20`,
      );
      res.json({ messages: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin-sms/:id/ack — APK acks delivery
  // Body: { ok: true } | { ok: false, reason: "no service" }
  app.post('/api/admin-sms/:id/ack', requireSharedSecret, async (req, res) => {
    try {
      const ok = req.body?.ok !== false;
      const reason = req.body?.reason;
      const meta = req.body?.meta;
      await db().query(
        `UPDATE admin_sms_queue
            SET status=$2, sent_at=now(), failed_reason=$3, ack_meta=$4
          WHERE id=$1`,
        [
          req.params.id,
          ok ? 'sent' : 'failed',
          ok ? null : String(reason || '').slice(0, 500),
          meta ? JSON.stringify(meta) : null,
        ],
      );
      res.json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin-sms — dashboard list view (recent messages, all statuses)
  app.get('/api/admin-sms', requireSharedSecret, async (req, res) => {
    try {
      const limit = Math.min(100, Math.max(1, parseInt(req.query.limit ?? '50', 10) || 50));
      const r = await db().query(
        `SELECT id, created_at, to_phone, message, kind, status, sent_at, failed_reason
           FROM admin_sms_queue ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      res.json({ messages: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
