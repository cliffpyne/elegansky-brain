// New-loan wizard: branch onboarding for individual borrowers.
//
// Replaces the SaasAnt CSV pipeline (CUSTOMER DETAIL / ESTIMATE / INVOICE
// files) with a direct QB API flow.
//
// Wizard inputs (per loan, one borrower at a time):
//   - Parent customer id   (chosen via cascading dropdowns: branch → sub → officer)
//   - DisplayName          (free text, operator types whatever — phone in name is fine)
//   - Estimate amount      (total loan)
//   - start_date / end_date
//   - daily_amount         (default 12,500)
//   - product_service_id   (QB Item, default "Motorcycle loan")
//
// Output:
//   - One QB Customer    (skip if same DisplayName under same parent already exists)
//   - One QB Estimate    (skip if amount+date matches existing for that customer)
//   - N QB Invoices      (N = calendar days between start and end inclusive)
//                          DocNumber starts at max(existing)+1, sequential

import { qbQuery } from './qb-client.js';
import { db } from './db/pool.js';

// One-time table create. Safe to call repeatedly.
async function ensureLoanCreationLogTable() {
  await db().query(`
    CREATE TABLE IF NOT EXISTS loan_creation_log (
      id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      idempotency_key TEXT UNIQUE,
      created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      parent_qb_id TEXT,
      customer_qb_id TEXT,
      customer_display_name TEXT,
      customer_was_reused BOOLEAN DEFAULT false,
      estimate_qb_id TEXT,
      estimate_was_reused BOOLEAN DEFAULT false,
      estimate_amount NUMERIC,
      product_service_id TEXT,
      start_date DATE,
      end_date DATE,
      daily_amount NUMERIC,
      invoice_qb_ids TEXT[],
      invoice_doc_numbers TEXT[],
      invoice_count INTEGER,
      total_amount NUMERIC,
      status TEXT,
      error TEXT
    )
  `);
}

function daysBetween(startISO, endISO) {
  const s = new Date(startISO + 'T00:00:00Z');
  const e = new Date(endISO + 'T00:00:00Z');
  if (isNaN(s) || isNaN(e)) return -1;
  const d = Math.round((e - s) / (24 * 60 * 60 * 1000)) + 1;
  return d;
}

function addDaysISO(startISO, n) {
  const d = new Date(startISO + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function escSql(s) {
  return String(s).replace(/'/g, "''");
}

export function mountLoanSetupApi(app, deps) {
  const { qbPost, requireSecretOrJwt } = deps;

  // Best-effort table create on mount.
  ensureLoanCreationLogTable().catch((e) =>
    console.error('[loan-setup] ensure table failed:', e.message),
  );

  // ── helpers ────────────────────────────────────────────────────────────

  async function qbCreateCustomer({ displayName, parentId, mobile }) {
    const body = { DisplayName: displayName };
    if (parentId) {
      body.ParentRef = { value: String(parentId) };
      body.Job = true; // sub-customers must be flagged as Jobs in QB
    }
    if (mobile) body.Mobile = { FreeFormNumber: String(mobile) };
    const j = await qbPost('customer', body);
    return j.Customer;
  }

  async function qbCreateEstimate({ customerId, amount, productServiceId, startDate, endDate, memo }) {
    const body = {
      CustomerRef: { value: String(customerId) },
      TxnDate: startDate,
      ExpirationDate: endDate,
      TxnStatus: 'Accepted',
      Line: [{
        Amount: Number(amount),
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: String(productServiceId) },
          UnitPrice: Number(amount),
          Qty: 1,
        },
      }],
    };
    if (memo) body.PrivateNote = memo;
    const j = await qbPost('estimate', body);
    return j.Estimate;
  }

  async function qbCreateInvoice({ customerId, productServiceId, amount, txnDate, dueDate, docNumber }) {
    const body = {
      CustomerRef: { value: String(customerId) },
      DocNumber: String(docNumber),
      TxnDate: txnDate,
      DueDate: dueDate || txnDate,
      Line: [{
        Amount: Number(amount),
        DetailType: 'SalesItemLineDetail',
        SalesItemLineDetail: {
          ItemRef: { value: String(productServiceId) },
          UnitPrice: Number(amount),
          Qty: 1,
        },
      }],
    };
    const j = await qbPost('invoice', body);
    return j.Invoice;
  }

  // Find an existing customer by exact DisplayName under the given parent.
  async function findCustomerByDisplayName({ displayName, parentId }) {
    const safe = escSql(displayName);
    const sql = parentId
      ? `SELECT Id, DisplayName, ParentRef, Active FROM Customer WHERE DisplayName = '${safe}' MAXRESULTS 50`
      : `SELECT Id, DisplayName, ParentRef, Active FROM Customer WHERE DisplayName = '${safe}' MAXRESULTS 50`;
    const j = await qbQuery(sql);
    const candidates = j.QueryResponse?.Customer || [];
    if (!parentId) {
      return candidates.find((c) => !c.ParentRef && c.Active) || null;
    }
    return candidates.find((c) => String(c.ParentRef?.value || '') === String(parentId) && c.Active) || null;
  }

  // Get the current max numeric DocNumber across recent Invoices.
  async function getMaxInvoiceDocNumber() {
    // Pull a generous batch of most-recently-created invoices and take the
    // numeric max across DocNumber. Cheaper than a full scan and correct for
    // sequential-numbering schemes.
    let maxN = 0;
    let start = 1;
    const PAGE = 1000;
    const PAGES = 5; // 5000 most-recent invoices is more than enough headroom
    for (let p = 0; p < PAGES; p++) {
      const j = await qbQuery(
        `SELECT DocNumber FROM Invoice ORDER BY MetaData.CreateTime DESC ` +
        `STARTPOSITION ${start} MAXRESULTS ${PAGE}`,
      );
      const items = j.QueryResponse?.Invoice || [];
      for (const inv of items) {
        const n = parseInt(inv.DocNumber, 10);
        if (!isNaN(n) && n > maxN) maxN = n;
      }
      if (items.length < PAGE) break;
      start += PAGE;
    }
    return maxN;
  }

  // ── routes ─────────────────────────────────────────────────────────────

  // GET /api/admin/qb-customer-children?parent_id=<id>&search=<text>&level=<n>
  //   - parent_id given → direct children of that parent
  //   - search given     → fuzzy match (LIKE) on DisplayName, optional level filter
  //   - neither          → defaults to Level=0 (top-level branches)
  //
  // QBO query limitations (verified the hard way 2026-06-17):
  //   - WHERE ParentRef = 'X'  → "property 'ParentRef' is not queryable"
  //   - WHERE Level = N        → "property 'Level' is not queryable"
  //   - WHERE FullyQualifiedName LIKE 'X:%' → works
  //   - So children lookup goes: parent_id → parent FQN → LIKE 'FQN:%' →
  //     filter in code for direct children (one colon-level deeper).
  app.get('/api/admin/qb-customer-children', requireSecretOrJwt, async (req, res) => {
    try {
      const parentId = String(req.query.parent_id || '').trim();
      const search = String(req.query.search || '').trim();
      const levelFilter = req.query.level !== undefined ? Number(req.query.level) : null;

      let parentFqn = null;
      let sql;
      if (parentId) {
        // Step 1: look up the parent FQN
        const parentRes = await qbQuery(
          `SELECT FullyQualifiedName, Level FROM Customer WHERE Id = '${escSql(parentId)}'`,
        );
        const parent = parentRes.QueryResponse?.Customer?.[0];
        if (!parent) {
          return res.json({ parent_id: parentId, customers: [], error: 'parent not found' });
        }
        parentFqn = parent.FullyQualifiedName;
        // Step 2: all descendants under that FQN — we'll filter to direct children in code
        sql = `SELECT Id, DisplayName, FullyQualifiedName, Active, Job, Level ` +
              `FROM Customer WHERE Active = true ` +
              `AND FullyQualifiedName LIKE '${escSql(parentFqn)}:%' ` +
              `ORDER BY DisplayName MAXRESULTS 1000`;
      } else if (search) {
        sql = `SELECT Id, DisplayName, FullyQualifiedName, Active, Job, Level ` +
              `FROM Customer WHERE Active = true ` +
              `AND DisplayName LIKE '%${escSql(search)}%' ` +
              `ORDER BY DisplayName MAXRESULTS 200`;
      } else {
        sql = `SELECT Id, DisplayName, FullyQualifiedName, Active, Job, Level ` +
              `FROM Customer WHERE Active = true ORDER BY DisplayName MAXRESULTS 1000`;
      }
      const j = await qbQuery(sql);
      let customers = j.QueryResponse?.Customer || [];

      // Filter to DIRECT children only (one colon-level deeper than parent)
      if (parentId && parentFqn) {
        const targetDepth = parentFqn.split(':').length + 1;
        customers = customers.filter((c) =>
          (c.FullyQualifiedName || '').split(':').length === targetDepth,
        );
      }
      // Default top-level: Level=0 in code (Level not WHERE-able)
      if (!parentId && !search) {
        const lvl = levelFilter !== null && !isNaN(levelFilter) ? levelFilter : 0;
        customers = customers.filter((c) => Number(c.Level ?? 0) === lvl);
      } else if (search && levelFilter !== null && !isNaN(levelFilter)) {
        customers = customers.filter((c) => Number(c.Level ?? 0) === levelFilter);
      }

      res.json({
        parent_id: parentId || null,
        parent_fqn: parentFqn,
        search: search || null,
        level: levelFilter,
        customers: customers.map((c) => ({
          id: c.Id,
          name: c.DisplayName,
          full_name: c.FullyQualifiedName || c.DisplayName,
          level: Number(c.Level ?? 0),
          is_job: !!c.Job,
        })),
      });
    } catch (err) {
      console.error('[qb-customer-children]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/qb-items → Product/Service picker
  app.get('/api/admin/qb-items', requireSecretOrJwt, async (req, res) => {
    try {
      const j = await qbQuery(
        `SELECT Id, Name, UnitPrice, Type, Active FROM Item WHERE Active = true ORDER BY Name MAXRESULTS 1000`,
      );
      const items = (j.QueryResponse?.Item || []).map((i) => ({
        id: i.Id,
        name: i.Name,
        default_price: Number(i.UnitPrice || 0),
        type: i.Type,
      }));
      res.json({ items });
    } catch (err) {
      console.error('[qb-items]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/qb-next-invoice-no → max + 1
  app.get('/api/admin/qb-next-invoice-no', requireSecretOrJwt, async (req, res) => {
    try {
      const maxN = await getMaxInvoiceDocNumber();
      res.json({ next: maxN + 1, max_existing: maxN });
    } catch (err) {
      console.error('[qb-next-invoice-no]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/new-loan/preview — read-only what-will-happen
  // Body: { parent_id, display_name, mobile?, estimate_amount, start_date,
  //         end_date, daily_amount, product_service_id }
  app.post('/api/admin/new-loan/preview', requireSecretOrJwt, async (req, res) => {
    try {
      const b = req.body || {};
      const errs = [];
      if (!b.parent_id) errs.push('parent_id required');
      if (!b.display_name) errs.push('display_name required');
      if (!b.estimate_amount || Number(b.estimate_amount) <= 0) errs.push('estimate_amount must be > 0');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '')) errs.push('start_date (YYYY-MM-DD) required');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '')) errs.push('end_date (YYYY-MM-DD) required');
      if (!b.daily_amount || Number(b.daily_amount) <= 0) errs.push('daily_amount must be > 0');
      if (!b.product_service_id) errs.push('product_service_id required');
      if (errs.length) return res.status(400).json({ errors: errs });

      const days = daysBetween(b.start_date, b.end_date);
      if (days <= 0) return res.status(400).json({ errors: ['end_date must be on or after start_date'] });

      const existing = await findCustomerByDisplayName({
        displayName: String(b.display_name).trim(),
        parentId: String(b.parent_id),
      });
      const nextDoc = (await getMaxInvoiceDocNumber()) + 1;

      const samples = [];
      for (let i = 0; i < Math.min(3, days); i++) {
        samples.push({
          doc_number: String(nextDoc + i),
          txn_date: addDaysISO(b.start_date, i),
          amount: Number(b.daily_amount),
        });
      }
      const totalInvoices = days * Number(b.daily_amount);

      res.json({
        ok: true,
        customer: {
          display_name: b.display_name,
          parent_id: b.parent_id,
          existing_qb_id: existing?.Id || null,
          will_be_reused: !!existing,
        },
        estimate: {
          amount: Number(b.estimate_amount),
          start_date: b.start_date,
          end_date: b.end_date,
          product_service_id: b.product_service_id,
        },
        invoices: {
          count: days,
          first_doc_number: String(nextDoc),
          last_doc_number: String(nextDoc + days - 1),
          first_date: b.start_date,
          last_date: b.end_date,
          per_invoice_amount: Number(b.daily_amount),
          total_amount: totalInvoices,
          sample: samples,
        },
        warning: totalInvoices !== Number(b.estimate_amount)
          ? `estimate (${b.estimate_amount}) does not equal daily × days (${totalInvoices})`
          : null,
      });
    } catch (err) {
      console.error('[new-loan/preview]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/new-loan/execute — actually create in QB
  // Body: same as preview + optional idempotency_key (recommended).
  app.post('/api/admin/new-loan/execute', requireSecretOrJwt, async (req, res) => {
    const b = req.body || {};
    const idemKey = String(b.idempotency_key || '').trim();
    try {
      const errs = [];
      if (!b.parent_id) errs.push('parent_id required');
      if (!b.display_name) errs.push('display_name required');
      if (!b.estimate_amount || Number(b.estimate_amount) <= 0) errs.push('estimate_amount must be > 0');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '')) errs.push('start_date required');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '')) errs.push('end_date required');
      if (!b.daily_amount || Number(b.daily_amount) <= 0) errs.push('daily_amount must be > 0');
      if (!b.product_service_id) errs.push('product_service_id required');
      if (errs.length) return res.status(400).json({ errors: errs });

      // Idempotency: if same key already succeeded, return its log row.
      if (idemKey) {
        const prior = await db().query(
          `SELECT * FROM loan_creation_log WHERE idempotency_key = $1`,
          [idemKey],
        );
        if (prior.rows.length) {
          return res.json({ ok: true, idempotent_hit: true, log: prior.rows[0] });
        }
      }

      const days = daysBetween(b.start_date, b.end_date);
      if (days <= 0) return res.status(400).json({ errors: ['end_date must be on or after start_date'] });

      const displayName = String(b.display_name).trim();
      const parentId = String(b.parent_id);
      const dailyAmount = Number(b.daily_amount);
      const totalAmount = days * dailyAmount;

      // 1. Find or create customer
      let customer = await findCustomerByDisplayName({ displayName, parentId });
      let customerReused = !!customer;
      if (!customer) {
        customer = await qbCreateCustomer({
          displayName,
          parentId,
          mobile: b.mobile || null,
        });
      }
      const customerId = String(customer.Id);

      // 2. Create estimate (no dedup check — operator decides; one-per-loan is the design)
      const estimate = await qbCreateEstimate({
        customerId,
        amount: Number(b.estimate_amount),
        productServiceId: String(b.product_service_id),
        startDate: b.start_date,
        endDate: b.end_date,
        memo: b.memo || null,
      });
      const estimateId = String(estimate.Id);

      // 3. Reserve invoice numbers + create one-by-one (sequential).
      //    Collision-proof: on DocNumber conflict, advance + retry.
      let nextDoc = (await getMaxInvoiceDocNumber()) + 1;
      const invoiceIds = [];
      const docNumbers = [];
      const failures = [];
      for (let i = 0; i < days; i++) {
        const txnDate = addDaysISO(b.start_date, i);
        let pushed = false;
        let attempts = 0;
        while (!pushed && attempts < 25) {
          attempts++;
          try {
            const inv = await qbCreateInvoice({
              customerId,
              productServiceId: String(b.product_service_id),
              amount: dailyAmount,
              txnDate,
              docNumber: String(nextDoc),
            });
            invoiceIds.push(String(inv.Id));
            docNumbers.push(String(nextDoc));
            nextDoc++;
            pushed = true;
          } catch (err) {
            const msg = String(err.message || err);
            // Duplicate DocNumber → bump and retry
            if (/duplicate|6240|already exists/i.test(msg)) {
              nextDoc++;
              continue;
            }
            failures.push({ doc_number: String(nextDoc), txn_date: txnDate, error: msg.slice(0, 300) });
            nextDoc++;
            break;
          }
        }
      }

      const status = failures.length === 0 ? 'success' : (invoiceIds.length === 0 ? 'failed' : 'partial');

      // 4. Log
      const log = await db().query(
        `INSERT INTO loan_creation_log (
           idempotency_key, parent_qb_id, customer_qb_id, customer_display_name,
           customer_was_reused, estimate_qb_id, estimate_was_reused, estimate_amount,
           product_service_id, start_date, end_date, daily_amount,
           invoice_qb_ids, invoice_doc_numbers, invoice_count, total_amount,
           status, error
         ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18)
         RETURNING *`,
        [
          idemKey || null, parentId, customerId, displayName,
          customerReused, estimateId, false, Number(b.estimate_amount),
          String(b.product_service_id), b.start_date, b.end_date, dailyAmount,
          invoiceIds, docNumbers, invoiceIds.length, totalAmount,
          status, failures.length ? JSON.stringify(failures).slice(0, 2000) : null,
        ],
      );

      res.json({
        ok: status !== 'failed',
        status,
        customer: { id: customerId, display_name: displayName, was_reused: customerReused },
        estimate: { id: estimateId, amount: Number(b.estimate_amount) },
        invoices: {
          count: invoiceIds.length,
          planned: days,
          first_doc: docNumbers[0] || null,
          last_doc: docNumbers[docNumbers.length - 1] || null,
          total_amount: invoiceIds.length * dailyAmount,
          failures,
        },
        log_id: log.rows[0].id,
      });
    } catch (err) {
      console.error('[new-loan/execute]', err);
      // Attempt to capture the failure in the log table so the operator can see it.
      if (idemKey) {
        try {
          await db().query(
            `INSERT INTO loan_creation_log (idempotency_key, status, error)
             VALUES ($1, 'failed', $2) ON CONFLICT (idempotency_key) DO NOTHING`,
            [idemKey, String(err.message || err).slice(0, 2000)],
          );
        } catch { /* nbd */ }
      }
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/admin/new-loan/log?limit=50 — recent successful loan setups
  app.get('/api/admin/new-loan/log', requireSecretOrJwt, async (req, res) => {
    try {
      const limit = Math.max(1, Math.min(200, parseInt(req.query.limit, 10) || 50));
      const r = await db().query(
        `SELECT id, idempotency_key, created_at, parent_qb_id, customer_qb_id,
                customer_display_name, customer_was_reused, estimate_qb_id,
                estimate_amount, start_date, end_date, daily_amount,
                invoice_count, total_amount, status, error
           FROM loan_creation_log ORDER BY created_at DESC LIMIT $1`,
        [limit],
      );
      res.json({ rows: r.rows });
    } catch (err) {
      console.error('[new-loan/log]', err);
      res.status(500).json({ error: err.message });
    }
  });
}
