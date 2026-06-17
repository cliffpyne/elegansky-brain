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
  const { qbPost, qbBatchCreateInvoices, qbBatchDelete, requireSecretOrJwt } = deps;

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
      let customers = [];

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
        // Step 2: paginate through all descendants under that FQN, filter to
        // direct children in code. QBO doesn't accept NOT LIKE reliably here,
        // so we fetch pages of 1000 and stop when we've seen all matches.
        const targetDepth = parentFqn.split(':').length + 1;
        const PAGE = 1000;
        const MAX_PAGES = 50; // 50k descendants ceiling; covers a full branch
        const seen = new Map(); // dedupe direct children by id
        for (let p = 0; p < MAX_PAGES; p++) {
          const start = p * PAGE + 1;
          const sql = `SELECT Id, DisplayName, FullyQualifiedName, Active, Job, Level ` +
                      `FROM Customer WHERE Active = true ` +
                      `AND FullyQualifiedName LIKE '${escSql(parentFqn)}:%' ` +
                      `ORDER BY FullyQualifiedName STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
          const pageRes = await qbQuery(sql);
          const items = pageRes.QueryResponse?.Customer || [];
          for (const c of items) {
            if ((c.FullyQualifiedName || '').split(':').length === targetDepth) {
              if (!seen.has(c.Id)) seen.set(c.Id, c);
            }
          }
          if (items.length < PAGE) break;
        }
        customers = Array.from(seen.values()).sort((a, b) =>
          (a.DisplayName || '').localeCompare(b.DisplayName || ''),
        );
      } else {
        let sql;
        if (search) {
          sql = `SELECT Id, DisplayName, FullyQualifiedName, Active, Job, Level ` +
                `FROM Customer WHERE Active = true ` +
                `AND DisplayName LIKE '%${escSql(search)}%' ` +
                `ORDER BY DisplayName MAXRESULTS 200`;
        } else {
          sql = `SELECT Id, DisplayName, FullyQualifiedName, Active, Job, Level ` +
                `FROM Customer WHERE Active = true ORDER BY DisplayName MAXRESULTS 1000`;
        }
        const j = await qbQuery(sql);
        customers = j.QueryResponse?.Customer || [];
        if (!search) {
          const lvl = levelFilter !== null && !isNaN(levelFilter) ? levelFilter : 0;
          customers = customers.filter((c) => Number(c.Level ?? 0) === lvl);
        } else if (levelFilter !== null && !isNaN(levelFilter)) {
          customers = customers.filter((c) => Number(c.Level ?? 0) === levelFilter);
        }
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

      // Per Frank 2026-06-17: drive invoice count from estimate ÷ daily.
      //   dailyCount = floor(estimate / daily)
      //   remainder  = estimate mod daily  (e.g. 3,500 if not divisible)
      //   invoices   = dailyCount × daily + (remainder > 0 ? 1 × remainder : 0)
      //   Σ invoice amounts == estimate_amount EXACTLY.
      const estimate = Number(b.estimate_amount);
      const daily = Number(b.daily_amount);
      const dailyCount = Math.floor(estimate / daily);
      const remainder = estimate - dailyCount * daily;
      const totalInvoices = dailyCount + (remainder > 0 ? 1 : 0);
      const computedEndDate = addDaysISO(b.start_date, totalInvoices - 1);

      const existing = await findCustomerByDisplayName({
        displayName: String(b.display_name).trim(),
        parentId: String(b.parent_id),
      });
      const nextDoc = (await getMaxInvoiceDocNumber()) + 1;

      const samples = [];
      for (let i = 0; i < Math.min(3, totalInvoices); i++) {
        const isRemainder = remainder > 0 && i === totalInvoices - 1;
        samples.push({
          doc_number: String(nextDoc + i),
          txn_date: addDaysISO(b.start_date, i),
          amount: isRemainder ? remainder : daily,
        });
      }
      const totalAmount = dailyCount * daily + remainder;

      res.json({
        ok: true,
        customer: {
          display_name: b.display_name,
          parent_id: b.parent_id,
          existing_qb_id: existing?.Id || null,
          will_be_reused: !!existing,
        },
        estimate: {
          amount: estimate,
          start_date: b.start_date,
          end_date: computedEndDate,
          product_service_id: b.product_service_id,
        },
        invoices: {
          count: totalInvoices,
          daily_count: dailyCount,
          remainder_amount: remainder,
          first_doc_number: String(nextDoc),
          last_doc_number: String(nextDoc + totalInvoices - 1),
          first_date: b.start_date,
          last_date: computedEndDate,
          per_invoice_amount: daily,
          total_amount: totalAmount,
          sample: samples,
        },
        warning: null,
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

      const displayName = String(b.display_name).trim();
      const parentId = String(b.parent_id);
      const dailyAmount = Number(b.daily_amount);
      const estimateAmt = Number(b.estimate_amount);
      const dailyCount = Math.floor(estimateAmt / dailyAmount);
      const remainder = estimateAmt - dailyCount * dailyAmount;
      const totalInvoices = dailyCount + (remainder > 0 ? 1 : 0);
      const computedEndDate = addDaysISO(b.start_date, totalInvoices - 1);
      const totalAmount = dailyCount * dailyAmount + remainder; // == estimateAmt

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
        amount: estimateAmt,
        productServiceId: String(b.product_service_id),
        startDate: b.start_date,
        endDate: computedEndDate,
        memo: b.memo || null,
      });
      const estimateId = String(estimate.Id);

      // 3. Build the full plan: dailyCount × dailyAmount, + 1 × remainder
      //    if estimate isn't perfectly divisible by daily. Push in batches
      //    of 30 with concurrency 4 (~30 sec for 397-row loan).
      let nextDoc = (await getMaxInvoiceDocNumber()) + 1;
      const plan = [];
      for (let i = 0; i < dailyCount; i++) {
        plan.push({
          customerId,
          productServiceId: String(b.product_service_id),
          amount: dailyAmount,
          txnDate: addDaysISO(b.start_date, i),
          docNumber: String(nextDoc + i),
        });
      }
      if (remainder > 0) {
        plan.push({
          customerId,
          productServiceId: String(b.product_service_id),
          amount: remainder,
          txnDate: addDaysISO(b.start_date, dailyCount),
          docNumber: String(nextDoc + dailyCount),
        });
      }
      nextDoc += totalInvoices; // reserve the contiguous range

      const invoiceIds = new Array(plan.length);
      const docNumbers = new Array(plan.length);
      const collisions = [];
      const failures = [];

      // Chunk into batches of 30
      const chunks = [];
      for (let i = 0; i < plan.length; i += 30) {
        chunks.push({ start: i, items: plan.slice(i, i + 30) });
      }
      const CONCURRENCY = 4;
      let cursor = 0;
      const runOne = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= chunks.length) return;
          const { start, items } = chunks[idx];
          try {
            const results = await qbBatchCreateInvoices(items);
            for (let k = 0; k < items.length; k++) {
              const r = results[k];
              if (r.ok) {
                invoiceIds[start + k] = r.id;
                docNumbers[start + k] = items[k].docNumber;
              } else if (/duplicate|6240|already exists/i.test(r.error || '')) {
                collisions.push({ planIdx: start + k, item: items[k] });
              } else {
                failures.push({ doc_number: items[k].docNumber, txn_date: items[k].txnDate, error: String(r.error || '').slice(0, 300) });
              }
            }
          } catch (err) {
            // Whole-batch failure (e.g., network) — record per-item
            const msg = String(err.message || err).slice(0, 300);
            for (let k = 0; k < items.length; k++) {
              failures.push({ doc_number: items[k].docNumber, txn_date: items[k].txnDate, error: 'batch failed: ' + msg });
            }
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => runOne()));

      // Retry any collisions serially with bump-and-try
      for (const c of collisions) {
        let pushed = false;
        let attempts = 0;
        while (!pushed && attempts < 50) {
          attempts++;
          try {
            const res = await qbBatchCreateInvoices([{ ...c.item, docNumber: String(nextDoc) }]);
            const r = res[0];
            if (r.ok) {
              invoiceIds[c.planIdx] = r.id;
              docNumbers[c.planIdx] = String(nextDoc);
              nextDoc++;
              pushed = true;
              break;
            }
            if (/duplicate|6240|already exists/i.test(r.error || '')) {
              nextDoc++;
              continue;
            }
            failures.push({ doc_number: String(nextDoc), txn_date: c.item.txnDate, error: String(r.error || '').slice(0, 300) });
            nextDoc++;
            break;
          } catch (err) {
            failures.push({ doc_number: String(nextDoc), txn_date: c.item.txnDate, error: String(err.message || err).slice(0, 300) });
            nextDoc++;
            break;
          }
        }
      }

      // Strip undefined slots from invoiceIds/docNumbers (planIdx for failed items)
      const finalInvoiceIds = invoiceIds.filter((x) => x);
      const finalDocNumbers = docNumbers.filter((x) => x);
      // Re-bind so the downstream code can use the same names
      invoiceIds.length = 0;
      invoiceIds.push(...finalInvoiceIds);
      docNumbers.length = 0;
      docNumbers.push(...finalDocNumbers);

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
          customerReused, estimateId, false, estimateAmt,
          String(b.product_service_id), b.start_date, computedEndDate, dailyAmount,
          invoiceIds, docNumbers, invoiceIds.length, totalAmount,
          status, failures.length ? JSON.stringify(failures).slice(0, 2000) : null,
        ],
      );

      res.json({
        ok: status !== 'failed',
        status,
        customer: { id: customerId, display_name: displayName, was_reused: customerReused },
        estimate: { id: estimateId, amount: estimateAmt },
        invoices: {
          count: invoiceIds.length,
          planned: totalInvoices,
          first_doc: docNumbers[0] || null,
          last_doc: docNumbers[docNumbers.length - 1] || null,
          total_amount: totalAmount,
          daily_count: dailyCount,
          remainder_amount: remainder,
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

  // ── ADD-INVOICES MODE ──────────────────────────────────────────────────
  // Use when a customer + estimate already exist in QB and you just want to
  // generate the daily invoices from `start_date` to `end_date` (driven by
  // estimate amount when only daily + total are given). Lets the operator
  // stop the SaasAnt-driven recurring invoice cron and continue creating
  // them through BRAIN from where the previous cron left off.

  // GET /api/admin/qb-customer-last-invoice?customer_id=<id>
  //   Returns the latest existing Invoice's DocNumber + TxnDate for this
  //   customer so the wizard can default start_date to the day after.
  app.get('/api/admin/qb-customer-last-invoice', requireSecretOrJwt, async (req, res) => {
    try {
      const customerId = String(req.query.customer_id || '').trim();
      if (!customerId) return res.status(400).json({ error: 'customer_id required' });
      const j = await qbQuery(
        `SELECT Id, DocNumber, TxnDate FROM Invoice ` +
        `WHERE CustomerRef = '${escSql(customerId)}' ` +
        `ORDER BY TxnDate DESC MAXRESULTS 50`,
      );
      const items = j.QueryResponse?.Invoice || [];
      if (!items.length) {
        return res.json({ customer_id: customerId, last: null });
      }
      const newest = items[0];
      // Next-day default for start_date so we don't collide with the
      // existing schedule.
      const nextDay = new Date(newest.TxnDate + 'T00:00:00Z');
      nextDay.setUTCDate(nextDay.getUTCDate() + 1);
      res.json({
        customer_id: customerId,
        last: {
          invoice_qb_id: newest.Id,
          doc_number: newest.DocNumber,
          txn_date: newest.TxnDate,
        },
        suggested_start_date: nextDay.toISOString().slice(0, 10),
      });
    } catch (err) {
      console.error('[qb-customer-last-invoice]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/add-invoices/preview
  // Body: { customer_id, start_date, daily_amount, product_service_id,
  //         remaining_amount?, end_date? }
  // Two modes (one of remaining_amount OR end_date required):
  //   1. remaining_amount mode (preferred per Frank 2026-06-17):
  //        N_full   = floor(remaining / daily)
  //        remainder = remaining mod daily  (e.g. 3,500 if not divisible)
  //        invoices = N_full × daily + (remainder ? 1 × remainder : 0)
  //        Total of invoice amounts = remaining_amount EXACTLY.
  //   2. end_date mode (legacy): N_full = days_between, all × daily.
  app.post('/api/admin/add-invoices/preview', requireSecretOrJwt, async (req, res) => {
    try {
      const b = req.body || {};
      const errs = [];
      if (!b.customer_id) errs.push('customer_id required');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '')) errs.push('start_date (YYYY-MM-DD) required');
      if (!b.daily_amount || Number(b.daily_amount) <= 0) errs.push('daily_amount must be > 0');
      if (!b.product_service_id) errs.push('product_service_id required');
      const hasRemaining = b.remaining_amount != null && Number(b.remaining_amount) > 0;
      const hasEndDate = /^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '');
      if (!hasRemaining && !hasEndDate) errs.push('either remaining_amount or end_date required');
      if (errs.length) return res.status(400).json({ errors: errs });

      const daily = Number(b.daily_amount);
      let dailyCount = 0;
      let remainder = 0;
      if (hasRemaining) {
        const remaining = Number(b.remaining_amount);
        dailyCount = Math.floor(remaining / daily);
        remainder = remaining - dailyCount * daily; // exact subtraction; no fp drift for integer amounts
      } else {
        dailyCount = daysBetween(b.start_date, b.end_date);
        if (dailyCount <= 0) return res.status(400).json({ errors: ['end_date must be on or after start_date'] });
      }
      const totalInvoices = dailyCount + (remainder > 0 ? 1 : 0);
      const totalAmount = dailyCount * daily + remainder;

      // Look up the customer so the operator sees what they picked
      const cj = await qbQuery(
        `SELECT Id, DisplayName, FullyQualifiedName FROM Customer ` +
        `WHERE Id = '${escSql(b.customer_id)}'`,
      );
      const customer = cj.QueryResponse?.Customer?.[0];
      if (!customer) return res.status(404).json({ errors: ['customer not found in QB'] });

      const nextDoc = (await getMaxInvoiceDocNumber()) + 1;
      const samples = [];
      for (let i = 0; i < Math.min(3, totalInvoices); i++) {
        const isRemainder = remainder > 0 && i === totalInvoices - 1;
        samples.push({
          doc_number: String(nextDoc + i),
          txn_date: addDaysISO(b.start_date, i),
          amount: isRemainder ? remainder : daily,
        });
      }
      const endDate = addDaysISO(b.start_date, totalInvoices - 1);

      res.json({
        ok: true,
        mode: hasRemaining ? 'remaining_amount' : 'end_date',
        customer: {
          id: customer.Id,
          display_name: customer.DisplayName,
          full_name: customer.FullyQualifiedName,
        },
        invoices: {
          count: totalInvoices,
          daily_count: dailyCount,
          remainder_amount: remainder,
          first_doc_number: String(nextDoc),
          last_doc_number: String(nextDoc + totalInvoices - 1),
          first_date: b.start_date,
          last_date: endDate,
          per_invoice_amount: daily,
          total_amount: totalAmount,
          sample: samples,
        },
      });
    } catch (err) {
      console.error('[add-invoices/preview]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/admin/add-invoices/execute
  // Body: same as preview + idempotency_key (recommended).
  // Modes: remaining_amount OR end_date — see preview docs for math.
  app.post('/api/admin/add-invoices/execute', requireSecretOrJwt, async (req, res) => {
    const b = req.body || {};
    const idemKey = String(b.idempotency_key || '').trim();
    try {
      const errs = [];
      if (!b.customer_id) errs.push('customer_id required');
      if (!/^\d{4}-\d{2}-\d{2}$/.test(b.start_date || '')) errs.push('start_date required');
      if (!b.daily_amount || Number(b.daily_amount) <= 0) errs.push('daily_amount must be > 0');
      if (!b.product_service_id) errs.push('product_service_id required');
      const hasRemaining = b.remaining_amount != null && Number(b.remaining_amount) > 0;
      const hasEndDate = /^\d{4}-\d{2}-\d{2}$/.test(b.end_date || '');
      if (!hasRemaining && !hasEndDate) errs.push('either remaining_amount or end_date required');
      if (errs.length) return res.status(400).json({ errors: errs });

      if (idemKey) {
        const prior = await db().query(
          `SELECT * FROM loan_creation_log WHERE idempotency_key = $1`,
          [idemKey],
        );
        if (prior.rows.length) {
          return res.json({ ok: true, idempotent_hit: true, log: prior.rows[0] });
        }
      }

      const customerId = String(b.customer_id);
      const dailyAmount = Number(b.daily_amount);
      let dailyCount = 0;
      let remainder = 0;
      if (hasRemaining) {
        const remaining = Number(b.remaining_amount);
        dailyCount = Math.floor(remaining / dailyAmount);
        remainder = remaining - dailyCount * dailyAmount;
      } else {
        dailyCount = daysBetween(b.start_date, b.end_date);
        if (dailyCount <= 0) return res.status(400).json({ errors: ['end_date must be on or after start_date'] });
      }
      const totalInvoices = dailyCount + (remainder > 0 ? 1 : 0);

      // Verify customer exists
      const cj = await qbQuery(
        `SELECT Id, DisplayName FROM Customer WHERE Id = '${escSql(customerId)}'`,
      );
      const customer = cj.QueryResponse?.Customer?.[0];
      if (!customer) return res.status(404).json({ errors: ['customer not found in QB'] });

      // Build plan: dailyCount × dailyAmount, then 1 × remainder if any
      let nextDoc = (await getMaxInvoiceDocNumber()) + 1;
      const plan = [];
      for (let i = 0; i < dailyCount; i++) {
        plan.push({
          customerId,
          productServiceId: String(b.product_service_id),
          amount: dailyAmount,
          txnDate: addDaysISO(b.start_date, i),
          docNumber: String(nextDoc + i),
        });
      }
      if (remainder > 0) {
        plan.push({
          customerId,
          productServiceId: String(b.product_service_id),
          amount: remainder,
          txnDate: addDaysISO(b.start_date, dailyCount),
          docNumber: String(nextDoc + dailyCount),
        });
      }
      nextDoc += totalInvoices;

      // Push in batches of 30 with concurrency (same fast path as new-loan)
      const invoiceIds = new Array(plan.length);
      const docNumbers = new Array(plan.length);
      const collisions = [];
      const failures = [];
      const chunks = [];
      for (let i = 0; i < plan.length; i += 30) {
        chunks.push({ start: i, items: plan.slice(i, i + 30) });
      }
      const CONCURRENCY = 4;
      let cursor = 0;
      const runOne = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= chunks.length) return;
          const { start, items } = chunks[idx];
          try {
            const results = await qbBatchCreateInvoices(items);
            for (let k = 0; k < items.length; k++) {
              const r = results[k];
              if (r.ok) {
                invoiceIds[start + k] = r.id;
                docNumbers[start + k] = items[k].docNumber;
              } else if (/duplicate|6240|already exists/i.test(r.error || '')) {
                collisions.push({ planIdx: start + k, item: items[k] });
              } else {
                failures.push({ doc_number: items[k].docNumber, txn_date: items[k].txnDate, error: String(r.error || '').slice(0, 300) });
              }
            }
          } catch (err) {
            const msg = String(err.message || err).slice(0, 300);
            for (const it of items) failures.push({ doc_number: it.docNumber, txn_date: it.txnDate, error: 'batch failed: ' + msg });
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => runOne()));

      // Bump-and-retry collisions serially
      for (const c of collisions) {
        let pushed = false;
        let attempts = 0;
        while (!pushed && attempts < 50) {
          attempts++;
          try {
            const r = (await qbBatchCreateInvoices([{ ...c.item, docNumber: String(nextDoc) }]))[0];
            if (r.ok) {
              invoiceIds[c.planIdx] = r.id;
              docNumbers[c.planIdx] = String(nextDoc);
              nextDoc++;
              pushed = true;
              break;
            }
            if (/duplicate|6240|already exists/i.test(r.error || '')) {
              nextDoc++;
              continue;
            }
            failures.push({ doc_number: String(nextDoc), txn_date: c.item.txnDate, error: String(r.error || '').slice(0, 300) });
            nextDoc++;
            break;
          } catch (err) {
            failures.push({ doc_number: String(nextDoc), txn_date: c.item.txnDate, error: String(err.message || err).slice(0, 300) });
            nextDoc++;
            break;
          }
        }
      }

      const finalIds = invoiceIds.filter((x) => x);
      const finalDocs = docNumbers.filter((x) => x);
      invoiceIds.length = 0; invoiceIds.push(...finalIds);
      docNumbers.length = 0; docNumbers.push(...finalDocs);

      const status = failures.length === 0 ? 'success' : (invoiceIds.length === 0 ? 'failed' : 'partial');
      const totalAmount = (Math.min(invoiceIds.length, dailyCount) * dailyAmount) +
                          (invoiceIds.length > dailyCount ? remainder : 0);
      const endDate = addDaysISO(b.start_date, totalInvoices - 1);

      // Reuse the loan_creation_log so all wizard activity lives in one place.
      // estimate columns stay null since this mode doesn't create an estimate.
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
          idemKey || null, null, customerId, customer.DisplayName,
          true, null, false, null,
          String(b.product_service_id), b.start_date, b.end_date, dailyAmount,
          invoiceIds, docNumbers, invoiceIds.length, totalAmount,
          status, failures.length ? JSON.stringify(failures).slice(0, 2000) : null,
        ],
      );

      res.json({
        ok: status !== 'failed',
        status,
        customer: { id: customerId, display_name: customer.DisplayName },
        invoices: {
          count: invoiceIds.length,
          planned: days,
          first_doc: docNumbers[0] || null,
          last_doc: docNumbers[docNumbers.length - 1] || null,
          total_amount: totalAmount,
          failures,
        },
        log_id: log.rows[0].id,
      });
    } catch (err) {
      console.error('[add-invoices/execute]', err);
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

  // ── PRECISE RECALL BY LOG ID ──────────────────────────────────────────
  // POST /api/admin/loan/recall-by-log
  // Body: { log_id, dry_run? }
  //
  // Targets ONLY the entities that a specific wizard fire created (from
  // loan_creation_log). Use this for add-invoices recall — it deletes
  // ONLY the invoices added by that batch, not the customer's other
  // invoices that were already in QB.
  //   - Invoices: DELETE each id in log.invoice_qb_ids
  //   - Estimate: DELETE if log has estimate_qb_id (new-loan logs only)
  //   - Customer: deactivate if log estimate_qb_id present AND
  //               customer_was_reused = false (i.e. wizard actually
  //               created the customer this round)
  app.post('/api/admin/loan/recall-by-log', requireSecretOrJwt, async (req, res) => {
    try {
      const logId = String(req.body?.log_id || '').trim();
      if (!logId) return res.status(400).json({ error: 'log_id required' });
      const dryRun = req.body?.dry_run === true;

      const row = (await db().query(
        `SELECT id, customer_qb_id, customer_display_name, customer_was_reused,
                estimate_qb_id, invoice_qb_ids, invoice_count, status
           FROM loan_creation_log WHERE id = $1`,
        [logId],
      )).rows[0];
      if (!row) return res.status(404).json({ error: 'log row not found' });

      const invoiceIds = row.invoice_qb_ids || [];
      const shouldDeleteEstimate = !!row.estimate_qb_id;
      const shouldDeactivateCustomer = !!row.estimate_qb_id && !row.customer_was_reused;

      // Fetch SyncTokens for each invoice we plan to delete (and the estimate)
      const tokens = new Map(); // qb_id → SyncToken
      if (invoiceIds.length > 0) {
        // Paginate via STARTPOSITION using SELECT WHERE Id IN (...)
        // QBO allows up to ~1000 ids per IN; but to be safe, chunk by 200.
        for (let i = 0; i < invoiceIds.length; i += 200) {
          const chunk = invoiceIds.slice(i, i + 200);
          const inList = chunk.map((id) => `'${escSql(id)}'`).join(',');
          const j = await qbQuery(
            `SELECT Id, SyncToken FROM Invoice WHERE Id IN (${inList}) MAXRESULTS 1000`,
          );
          for (const inv of (j.QueryResponse?.Invoice || [])) {
            tokens.set(String(inv.Id), inv.SyncToken);
          }
        }
      }
      let estimateToken = null;
      if (row.estimate_qb_id) {
        const j = await qbQuery(`SELECT Id, SyncToken FROM Estimate WHERE Id = '${escSql(row.estimate_qb_id)}'`);
        const est = j.QueryResponse?.Estimate?.[0];
        if (est) estimateToken = est.SyncToken;
      }
      let customerToken = null;
      if (shouldDeactivateCustomer) {
        const j = await qbQuery(`SELECT Id, SyncToken, Active FROM Customer WHERE Id = '${escSql(row.customer_qb_id)}'`);
        const cust = j.QueryResponse?.Customer?.[0];
        if (cust) customerToken = cust.SyncToken;
      }

      const plan = {
        log_id: row.id,
        customer: { id: row.customer_qb_id, display_name: row.customer_display_name },
        invoices_to_delete: invoiceIds.length,
        invoices_with_token: tokens.size,
        invoices_missing: invoiceIds.length - tokens.size,
        estimate_to_delete: shouldDeleteEstimate ? row.estimate_qb_id : null,
        deactivate_customer: shouldDeactivateCustomer,
      };

      if (dryRun) return res.json({ ok: true, dry_run: true, plan });

      // Delete invoices in batches of 30, concurrency 4
      const invoiceItems = invoiceIds
        .map((id) => ({ entity: 'Invoice', id, syncToken: tokens.get(String(id)) }))
        .filter((it) => it.syncToken != null);
      const chunks = [];
      for (let i = 0; i < invoiceItems.length; i += 30) chunks.push({ start: i, items: invoiceItems.slice(i, i + 30) });
      const deletedInvoices = new Set();
      const failures = [];
      let cursor = 0;
      const runOne = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= chunks.length) return;
          const { items } = chunks[idx];
          try {
            const results = await qbBatchDelete(items);
            for (let k = 0; k < items.length; k++) {
              if (results[k].ok) deletedInvoices.add(items[k].id);
              else failures.push({ id: items[k].id, error: results[k].error });
            }
          } catch (err) {
            const msg = String(err.message || err).slice(0, 300);
            for (const it of items) failures.push({ id: it.id, error: 'batch failed: ' + msg });
          }
        }
      };
      await Promise.all(Array.from({ length: 4 }, () => runOne()));

      // Estimate
      let estimateDeleted = false;
      let estimateError = null;
      if (shouldDeleteEstimate && estimateToken != null) {
        try {
          const r = await qbBatchDelete([{ entity: 'Estimate', id: row.estimate_qb_id, syncToken: estimateToken }]);
          if (r[0]?.ok) estimateDeleted = true;
          else estimateError = r[0]?.error;
        } catch (err) { estimateError = String(err.message || err).slice(0, 200); }
      }

      // Customer
      let customerDeactivated = false;
      let customerError = null;
      if (shouldDeactivateCustomer && customerToken != null && failures.length === 0) {
        try {
          await qbPost('customer', {
            Id: row.customer_qb_id, SyncToken: customerToken, sparse: true, Active: false,
          });
          customerDeactivated = true;
        } catch (err) { customerError = String(err.message || err).slice(0, 300); }
      }

      // Mark the log row as recalled (cheap audit trail)
      try {
        await db().query(
          `UPDATE loan_creation_log SET status = $2, error = $3 WHERE id = $1`,
          [logId, 'recalled', failures.length ? JSON.stringify(failures).slice(0, 2000) : null],
        );
      } catch { /* nbd */ }

      res.json({
        ok: failures.length === 0,
        plan,
        invoices: {
          planned: invoiceIds.length,
          deleted: deletedInvoices.size,
          failure_count: failures.length,
          failures: failures.slice(0, 20),
        },
        estimate: shouldDeleteEstimate
          ? { id: row.estimate_qb_id, deleted: estimateDeleted, error: estimateError }
          : null,
        customer: { id: row.customer_qb_id, deactivated: customerDeactivated, error: customerError },
      });
    } catch (err) {
      console.error('[recall-by-log]', err);
      res.status(500).json({ error: err.message });
    }
  });

  // ── BLAST RECALL BY CUSTOMER ──────────────────────────────────────────
  // POST /api/admin/new-loan/recall
  // Body: { customer_qb_id, dry_run?: true, deactivate_customer?: true }
  //
  // Walks the customer's complete QB footprint (all Invoices + Estimates)
  // and DELETEs them in batches of 30 with concurrency 4 — typical full
  // 397-invoice loan recalls in <30 seconds. Customer can't be DELETEd
  // once it has any history, so it's marked inactive instead (default
  // on; pass deactivate_customer=false to keep it active).
  //
  // QB DELETE on an Invoice fails if a Payment links to it. Brand-new
  // wizard loans have no payments → all DELETEs succeed. If recalling a
  // loan that has received payments, the deletes will partially fail and
  // the response surfaces which invoices got stuck.
  app.post('/api/admin/new-loan/recall', requireSecretOrJwt, async (req, res) => {
    try {
      const customerId = String(req.body?.customer_qb_id || '').trim();
      if (!customerId) return res.status(400).json({ error: 'customer_qb_id required' });
      const dryRun = req.body?.dry_run === true;
      const deactivateCustomer = req.body?.deactivate_customer !== false;

      // 1. Verify customer exists
      const cj = await qbQuery(
        `SELECT Id, DisplayName, SyncToken, Active FROM Customer WHERE Id = '${escSql(customerId)}'`,
      );
      const customer = cj.QueryResponse?.Customer?.[0];
      if (!customer) return res.status(404).json({ error: 'customer not found in QB' });

      // 2. Collect all invoices (paginated — a full loan = 366-400 rows)
      const invoices = [];
      let start = 1;
      while (true) {
        const j = await qbQuery(
          `SELECT Id, DocNumber, TxnDate, TotalAmt, SyncToken FROM Invoice ` +
          `WHERE CustomerRef = '${escSql(customerId)}' ` +
          `STARTPOSITION ${start} MAXRESULTS 1000`,
        );
        const items = j.QueryResponse?.Invoice || [];
        invoices.push(...items);
        if (items.length < 1000) break;
        start += 1000;
      }

      // 3. Collect all estimates
      const estimates = [];
      start = 1;
      while (true) {
        const j = await qbQuery(
          `SELECT Id, TotalAmt, SyncToken FROM Estimate ` +
          `WHERE CustomerRef = '${escSql(customerId)}' ` +
          `STARTPOSITION ${start} MAXRESULTS 1000`,
        );
        const items = j.QueryResponse?.Estimate || [];
        estimates.push(...items);
        if (items.length < 1000) break;
        start += 1000;
      }

      const planSummary = {
        customer: { id: customer.Id, display_name: customer.DisplayName, active: customer.Active },
        invoices_to_delete: invoices.length,
        invoices_total_amount: invoices.reduce((s, i) => s + Number(i.TotalAmt || 0), 0),
        estimates_to_delete: estimates.length,
        estimates_total_amount: estimates.reduce((s, e) => s + Number(e.TotalAmt || 0), 0),
        will_deactivate_customer: deactivateCustomer,
      };

      if (dryRun) {
        return res.json({ ok: true, dry_run: true, plan: planSummary });
      }

      // 4. Delete invoices in batches of 30 with concurrency 4
      const invoiceItems = invoices.map((i) => ({ entity: 'Invoice', id: i.Id, syncToken: i.SyncToken }));
      const invoiceChunks = [];
      for (let i = 0; i < invoiceItems.length; i += 30) invoiceChunks.push({ start: i, items: invoiceItems.slice(i, i + 30) });
      const deletedInvoiceIds = new Set();
      const invoiceFailures = [];
      const CONCURRENCY = 4;
      let cursor = 0;
      const runOne = async () => {
        while (true) {
          const idx = cursor++;
          if (idx >= invoiceChunks.length) return;
          const { start, items } = invoiceChunks[idx];
          try {
            const results = await qbBatchDelete(items);
            for (let k = 0; k < items.length; k++) {
              if (results[k].ok) deletedInvoiceIds.add(items[k].id);
              else invoiceFailures.push({ id: items[k].id, error: results[k].error });
            }
          } catch (err) {
            const msg = String(err.message || err).slice(0, 300);
            for (const it of items) invoiceFailures.push({ id: it.id, error: 'batch failed: ' + msg });
          }
        }
      };
      await Promise.all(Array.from({ length: CONCURRENCY }, () => runOne()));

      // 5. Delete estimates (usually small count, can be a single batch)
      const estimateItems = estimates.map((e) => ({ entity: 'Estimate', id: e.Id, syncToken: e.SyncToken }));
      const deletedEstimateIds = new Set();
      const estimateFailures = [];
      for (let i = 0; i < estimateItems.length; i += 30) {
        const chunk = estimateItems.slice(i, i + 30);
        try {
          const results = await qbBatchDelete(chunk);
          for (let k = 0; k < chunk.length; k++) {
            if (results[k].ok) deletedEstimateIds.add(chunk[k].id);
            else estimateFailures.push({ id: chunk[k].id, error: results[k].error });
          }
        } catch (err) {
          for (const it of chunk) estimateFailures.push({ id: it.id, error: 'batch failed: ' + String(err.message || err).slice(0, 200) });
        }
      }

      // 6. Mark customer inactive (only if no item-delete failures, so a
      //    partial recall doesn't leave a hidden customer that still has
      //    invoices on it)
      let customerDeactivated = false;
      let customerError = null;
      if (deactivateCustomer && invoiceFailures.length === 0 && estimateFailures.length === 0) {
        try {
          await qbPost('customer', {
            Id: customer.Id,
            SyncToken: customer.SyncToken,
            sparse: true,
            Active: false,
          });
          customerDeactivated = true;
        } catch (err) {
          customerError = String(err.message || err).slice(0, 300);
        }
      }

      res.json({
        ok: invoiceFailures.length === 0 && estimateFailures.length === 0,
        customer: {
          id: customer.Id,
          display_name: customer.DisplayName,
          deactivated: customerDeactivated,
          deactivate_error: customerError,
        },
        invoices: {
          planned: invoices.length,
          deleted: deletedInvoiceIds.size,
          failures: invoiceFailures.slice(0, 20),
          failure_count: invoiceFailures.length,
        },
        estimates: {
          planned: estimates.length,
          deleted: deletedEstimateIds.size,
          failures: estimateFailures.slice(0, 10),
          failure_count: estimateFailures.length,
        },
        plan: planSummary,
      });
    } catch (err) {
      console.error('[new-loan/recall]', err);
      res.status(500).json({ error: err.message });
    }
  });
}
