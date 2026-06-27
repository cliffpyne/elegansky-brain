// ───────────────────────────────────────────────────────────────────────────
// ERP read-only API — pull endpoints for the external ERP connector.
//
// BRAIN already holds the only QB OAuth token. To let an ERP system view
// QB data without standing up a second QB app (and risking token-rotation
// conflicts), this module exposes two read-only HTTP endpoints that ERP's
// connector calls instead of QB directly:
//
//   GET /erp/qb/customers
//   GET /erp/qb/customer/:qb_id/ledger
//
// Auth: shared bearer token. Set env ERP_PULL_KEY on Render; ERP sends it
// as `Authorization: Bearer <ERP_PULL_KEY>`. No JWT, no Supabase — this
// is a machine-to-machine secret pair, not a user session.
//
// Data sources:
//   - Customer list: live QB Query API (small dataset, called rarely)
//   - Customer ledger: BRAIN's local QB mirror (qb_invoices, qb_payments,
//     qb_payment_lines) for sub-100ms latency; falls back to QB live for
//     the customer's own DisplayName + any uncached payment txn_id.
//
// Read-only contract: this module only does SELECTs and GET-style QB
// queries. It MUST NEVER write to QB or to the mirror.
// ───────────────────────────────────────────────────────────────────────────

import { qbQuery } from './qb-client.js';

function requireErpKey(req, res, next) {
  const expected = process.env.ERP_PULL_KEY;
  if (!expected) {
    return res.status(503).json({ error: 'ERP_PULL_KEY not configured on BRAIN' });
  }
  const hdr = String(req.header('authorization') || '');
  const m = hdr.match(/^Bearer\s+(.+)$/i);
  const provided = m ? m[1].trim() : '';
  if (!provided || provided !== expected) {
    return res.status(401).json({ error: 'invalid or missing bearer token' });
  }
  next();
}

// Best-effort plate extraction from a customer DisplayName. Frank's QB
// names commonly embed the plate like "BRAYSON ALLY HASSAN MC783FME"
// or "BRAYSON ALLY HASSAN T123ABC". Returns null when no plate-like
// token is found.
function plateFromName(displayName) {
  if (!displayName) return null;
  const toks = String(displayName).split(/\s+/);
  for (let i = toks.length - 1; i >= 0; i--) {
    const t = toks[i].trim().toUpperCase();
    if (/^[A-Z]{1,3}[0-9]{2,4}[A-Z]{2,3}$/.test(t)) return t;
  }
  return null;
}

export function mountErpApi(app, { pool }) {
  // List all customers (live QB query).
  app.get('/erp/qb/customers', requireErpKey, async (_req, res) => {
    try {
      const out = [];
      const PAGE = 1000;
      let start = 1;
      for (;;) {
        const sql = `SELECT Id, DisplayName, Active FROM Customer STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        const r = await qbQuery(sql);
        const rows = r.QueryResponse?.Customer || [];
        if (!rows.length) break;
        for (const c of rows) {
          out.push({ qb_id: String(c.Id), name: c.DisplayName || null, active: !!c.Active });
        }
        if (rows.length < PAGE) break;
        start += PAGE;
      }
      res.json(out);
    } catch (err) {
      console.error('[erp/customers]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // Per-customer full ledger from the local mirror, plus live QB lookup
  // for the customer's DisplayName (single small QB call). Mirror is
  // updated by the existing CDC poller, so this is sub-100ms after the
  // initial QB call.
  app.get('/erp/qb/customer/:qb_id/ledger', requireErpKey, async (req, res) => {
    const customerId = String(req.params.qb_id || '').trim();
    if (!/^\d+$/.test(customerId)) {
      return res.status(400).json({ error: 'qb_id must be a numeric Customer Id' });
    }
    try {
      // 1. Customer name — live QB (DisplayName isn't mirrored).
      const cust = await qbQuery(`SELECT Id, DisplayName FROM Customer WHERE Id = '${customerId}'`);
      const display = cust.QueryResponse?.Customer?.[0]?.DisplayName || null;
      if (!display) {
        return res.status(404).json({ error: 'customer not found in QB' });
      }

      // 2. Invoices from the mirror, ordered by txn_date asc.
      const invR = await pool.query(
        `SELECT id, doc_number, txn_date::text AS txn_date, total_amt, balance
           FROM qb_invoices
          WHERE customer_id = $1
          ORDER BY txn_date ASC, id ASC`,
        [customerId],
      );
      const invoices = invR.rows.map((r) => ({
        qb_id: String(r.id),
        doc_number: r.doc_number || null,
        date: r.txn_date,
        amount: Number(r.total_amt) || 0,
        balance: Number(r.balance) || 0,
      }));

      // 3. Payments + allocations from the mirror.
      const payR = await pool.query(
        `SELECT id, txn_date::text AS txn_date, total_amt
           FROM qb_payments
          WHERE customer_id = $1
          ORDER BY txn_date ASC, id ASC`,
        [customerId],
      );
      const paymentIds = payR.rows.map((r) => r.id);
      let allocByPayment = new Map();
      if (paymentIds.length) {
        const allocR = await pool.query(
          `SELECT payment_id, linked_invoice_id, amount
             FROM qb_payment_lines
            WHERE payment_id = ANY ($1::text[])`,
          [paymentIds.map(String)],
        );
        for (const a of allocR.rows) {
          if (!allocByPayment.has(a.payment_id)) allocByPayment.set(a.payment_id, []);
          if (a.linked_invoice_id) {
            allocByPayment.get(a.payment_id).push({
              invoice_qb_id: String(a.linked_invoice_id),
              amount: Number(a.amount) || 0,
            });
          }
        }
      }
      const payments = payR.rows.map((r) => ({
        qb_id: String(r.id),
        date: r.txn_date,
        amount: Number(r.total_amt) || 0,
        txn_id: null,  // not mirrored; ERP can hit QB directly if it needs PaymentRefNum
        allocations: allocByPayment.get(r.id) || [],
      }));

      // 4. Header fields — derived from the mirrored data.
      const startDate = invoices.length ? invoices[0].date : null;
      const totalPayable = invoices.reduce((s, i) => s + i.amount, 0);
      // Disbursement isn't a separate QB field for Frank's boda model;
      // typical convention is the first invoice's amount represents the
      // principal disbursement. Operator can override if a different
      // convention applies.
      const disbursement = invoices.length ? invoices[0].amount : 0;

      res.json({
        plate: plateFromName(display),
        customer_name: display,
        start_date: startDate,
        disbursement,
        total_payable: totalPayable,
        invoices,
        payments,
      });
    } catch (err) {
      console.error('[erp/customer/ledger]', err);
      res.status(500).json({ error: err.message });
    }
  });
}
