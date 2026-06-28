// ───────────────────────────────────────────────────────────────────────────
// Frappe webhook receiver
//
// The Frappe ERP POSTs here whenever the events BRAIN cares about happen:
//   - Payment Entry on_submit / on_cancel  (humans paying / cancelling via UI)
//   - Sales Invoice on_update              (status change)
//
// Auth: shared secret in `X-Frappe-Secret` header. Set FRAPPE_WEBHOOK_SECRET
// on Render to enable. Without the env var, every POST is rejected so
// the endpoint is fail-closed.
//
// Storage: every event is persisted to frappe_webhook_events for audit +
// replay. A nightly job (future) can re-process unprocessed events. For
// now we just receive + ack — the Frappe ledger remains the source of
// truth until BRAIN actually NEEDS to sync.
//
// Returns 200 quickly even on internal errors so Frappe's webhook retry
// queue doesn't pile up. Real failures get logged for ops review.
// ───────────────────────────────────────────────────────────────────────────

const SCHEMA_DDL = `
CREATE TABLE IF NOT EXISTS frappe_webhook_events (
  id          BIGSERIAL PRIMARY KEY,
  received_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  event_name  TEXT,             -- e.g. on_submit / on_cancel / on_update
  doctype     TEXT,             -- e.g. Payment Entry / Sales Invoice
  doc_name    TEXT,             -- the doc id from Frappe
  raw_json    JSONB NOT NULL,   -- full body as Frappe sent it
  processed_at TIMESTAMPTZ      -- null until a downstream job consumes it
);
CREATE INDEX IF NOT EXISTS idx_frappe_webhook_received_at
  ON frappe_webhook_events (received_at DESC);
CREATE INDEX IF NOT EXISTS idx_frappe_webhook_unprocessed
  ON frappe_webhook_events (received_at)
  WHERE processed_at IS NULL;
`;

let _schemaApplied = false;
async function ensureSchema(pool) {
  if (_schemaApplied) return;
  await pool.query(SCHEMA_DDL);
  _schemaApplied = true;
}

export function mountFrappeWebhookApi(app, { pool }) {
  app.post('/api/frappe/webhook', async (req, res) => {
    // 1. Auth — fail closed.
    const expected = process.env.FRAPPE_WEBHOOK_SECRET;
    if (!expected) {
      console.error('[frappe/webhook] FRAPPE_WEBHOOK_SECRET not set — rejecting');
      return res.status(503).json({ error: 'webhook receiver not configured' });
    }
    const provided = req.header('x-frappe-secret') || '';
    if (provided !== expected) {
      return res.status(401).json({ error: 'invalid secret' });
    }
    // 2. Persist the event verbatim. We do this BEFORE any per-event logic
    // so a bug in the handlers can't lose the data.
    try {
      await ensureSchema(pool);
      const body = req.body || {};
      // Frappe Webhook payload shape: top-level fields vary by doctype, plus
      // a sometimes-present `doc` envelope. Extract the most likely fields
      // for indexing without forcing a specific shape.
      const eventName = String(body.event || body.action || req.header('x-frappe-event') || '').slice(0, 80) || null;
      const doctype = String(body.doctype || body?.doc?.doctype || '').slice(0, 120) || null;
      const docName = String(body.name || body?.doc?.name || '').slice(0, 200) || null;
      const inserted = await pool.query(
        `INSERT INTO frappe_webhook_events (event_name, doctype, doc_name, raw_json)
         VALUES ($1, $2, $3, $4::jsonb)
         RETURNING id, received_at`,
        [eventName, doctype, docName, JSON.stringify(body)],
      );
      console.log(`[frappe/webhook] stored event id=${inserted.rows[0].id} doctype=${doctype} doc=${docName} event=${eventName}`);
      res.json({ ok: true, event_id: inserted.rows[0].id });
    } catch (err) {
      // Don't let a downstream error bounce the webhook — Frappe would
      // queue retries and pile up. Log loudly and ack so the producer can
      // move on. Audit shows the missing event.
      console.error('[frappe/webhook] persist error (still acking 200):', err.message);
      res.json({ ok: false, warn: err.message });
    }
  });

  // Read-only inspector for ops debugging — lists the most recent N events.
  // Auth via the shared admin secret BRAIN uses elsewhere.
  app.get('/api/frappe/webhook/recent', async (req, res) => {
    const sharedSecret = process.env.STATEMENT_REPORT_SECRET;
    const hdr = req.header('x-report-secret') || '';
    if (!sharedSecret || hdr !== sharedSecret) {
      return res.status(401).json({ error: 'unauthorized' });
    }
    try {
      const limit = Math.min(parseInt(req.query.limit, 10) || 20, 200);
      const r = await pool.query(
        `SELECT id, received_at, event_name, doctype, doc_name, processed_at
           FROM frappe_webhook_events
          ORDER BY received_at DESC
          LIMIT $1`,
        [limit],
      );
      res.json({ count: r.rows.length, events: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
