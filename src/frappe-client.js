// ───────────────────────────────────────────────────────────────────────────
// Frappe ERP client — wraps the two purpose-built methods the ERP dev
// exposed for BRAIN integration:
//
//   GET  elegansky.api.get_open_invoices?customer=<qb_id|plate|name>
//   POST elegansky.api.ingest_payment
//   GET  elegansky.api.reverse_payment?txn_id=<id>
//
// Plus generic GET helpers for the standard /api/resource/* doctype calls
// when we need raw Sales Invoice / Customer / Loan rows.
//
// Rule (Frank 2026-06-28): BRAIN's payment algorithm is the source-of-
// truth for which invoice gets paid by which TZS — same sacred logic as
// the QB push path. We compute the per-invoice allocations on BRAIN and
// send them EXPLICITLY in `allocations`. We DO NOT rely on Frappe's
// auto-FIFO; that would diverge from BRAIN's algorithm and the two
// ledgers would drift.
//
// Env config:
//   FRAPPE_BASE_URL   - e.g. https://erp.eleganskyboda.com
//   FRAPPE_API_TOKEN  - "<api_key>:<api_secret>" (per Frappe convention)
// ───────────────────────────────────────────────────────────────────────────

const DEFAULT_TIMEOUT_MS = 60_000;

function baseUrl() {
  const u = (process.env.FRAPPE_BASE_URL || '').replace(/\/$/, '');
  if (!u) throw new Error('FRAPPE_BASE_URL not set');
  return u;
}

function authHeader() {
  const t = process.env.FRAPPE_API_TOKEN;
  if (!t || !t.includes(':')) {
    throw new Error('FRAPPE_API_TOKEN must be "<api_key>:<api_secret>"');
  }
  return `token ${t}`;
}

function buildQueryString(params) {
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(params || {})) {
    if (v === undefined || v === null) continue;
    sp.set(k, String(v));
  }
  const s = sp.toString();
  return s ? `?${s}` : '';
}

async function callFrappe(method, urlPath, body) {
  const url = `${baseUrl()}${urlPath}`;
  const r = await fetch(url, {
    method,
    headers: {
      'Authorization': authHeader(),
      'Accept': 'application/json',
      ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal: AbortSignal.timeout(DEFAULT_TIMEOUT_MS),
  });
  const text = await r.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!r.ok) {
    // Frappe returns 4xx/5xx with {exception, exc_type, _server_messages} —
    // surface them in a single Error.message so the caller can branch on
    // duplicates / not_found / validation errors uniformly.
    const exc = data?.exception || data?.exc_type || `HTTP ${r.status}`;
    const e = new Error(`Frappe ${r.status}: ${exc}`);
    e.status = r.status;
    e.frappe = data;
    throw e;
  }
  return data;
}

// ── Pull invoices ─────────────────────────────────────────────────────────

/**
 * Return all of one customer's open invoices.
 *   customer = qb_id (string), plate, or exact Frappe customer name.
 * Returns { customer, open_count, total_outstanding, invoices: [...] }.
 * `invoices[i]` = { name, posting_date, due_date, grand_total,
 *                   outstanding_amount, status, eg_installment_kind, ... }.
 */
export async function getOpenInvoices(customer) {
  if (!customer) throw new Error('getOpenInvoices: customer required');
  const r = await callFrappe('GET',
    `/api/method/elegansky.api.get_open_invoices${buildQueryString({ customer: String(customer) })}`);
  // Frappe convention wraps RPC responses in {message: ...}
  return r.message || r;
}

/**
 * Fetch one Sales Invoice's full doc (items, due_date, etc).
 */
export async function getInvoice(name) {
  if (!name) throw new Error('getInvoice: name required');
  const r = await callFrappe('GET',
    `/api/resource/Sales Invoice/${encodeURIComponent(name)}`);
  return r.data || r;
}

// ── Push payments ─────────────────────────────────────────────────────────

/**
 * Push one payment to Frappe. BRAIN-computed allocations are passed
 * verbatim; Frappe applies them exactly (no auto-FIFO override).
 *
 * Args:
 *   customer        - qb_id | plate | exact name (Frappe resolves)
 *   amount          - number, TZS
 *   date            - "YYYY-MM-DD"
 *   txn_id          - idempotency key (use the sheet row ref)
 *   mode_of_payment - "NMB" | "CRDB" | "SAVCOM NMB" | "SAVCOM CRDB" | "iPhone" | "Cash"
 *   allocations     - [{ reference_name, allocated_amount }] OR undefined for FIFO
 *
 * Returns the Frappe response: { status: "ok" | "duplicate", ... } on
 * success. Throws on hard failure (customer not found, etc).
 */
export async function ingestPayment({
  customer, amount, date, txn_id, mode_of_payment, allocations,
}) {
  if (!customer) throw new Error('ingestPayment: customer required');
  if (!(Number(amount) > 0)) throw new Error('ingestPayment: amount > 0 required');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date || ''))) {
    throw new Error('ingestPayment: date must be YYYY-MM-DD');
  }
  if (!txn_id) throw new Error('ingestPayment: txn_id required (idempotency key)');
  const body = {
    customer: String(customer),
    amount: Number(amount),
    date: String(date),
    txn_id: String(txn_id),
    mode_of_payment: String(mode_of_payment || 'Cash'),
  };
  if (Array.isArray(allocations) && allocations.length) {
    body.allocations = allocations.map((a) => ({
      reference_name: String(a.reference_name),
      allocated_amount: Number(a.allocated_amount),
    }));
  }
  const r = await callFrappe('POST',
    `/api/method/elegansky.api.ingest_payment`, body);
  return r.message || r;
}

/**
 * Get per-customer loan summary — Frappe dev 2026-07-02 endpoint that
 * pre-computes every figure Frank's SMS blast needs.
 *
 * Returns:
 *   {
 *     contract_total, total_paid, outstanding_total,
 *     arrears, today_due, total_due_now,
 *     loan_start_date, original_end_date, current_end_date,
 *     days_moved_forward, installments, first_invoice_date
 *   }
 */
export async function getLoanSummary(customer) {
  if (!customer) throw new Error('getLoanSummary: customer required');
  const r = await callFrappe('GET',
    `/api/method/elegansky.api.get_loan_summary${buildQueryString({ customer: String(customer) })}`);
  return r.message || r;
}

/**
 * Cancel + delete a payment we previously pushed. Idempotent.
 */
export async function reversePayment(txnId) {
  if (!txnId) throw new Error('reversePayment: txnId required');
  const r = await callFrappe('GET',
    `/api/method/elegansky.api.reverse_payment${buildQueryString({ txn_id: String(txnId) })}`);
  return r.message || r;
}

// ── Helpers — generic resource GETs (used for diagnostics / mapping) ─────

export async function listCustomers({ start = 0, pageSize = 0, fields } = {}) {
  const params = { limit_start: start, limit_page_length: pageSize };
  if (Array.isArray(fields) && fields.length) {
    params.fields = JSON.stringify(fields);
  }
  const r = await callFrappe('GET',
    `/api/resource/Customer${buildQueryString(params)}`);
  return r.data || [];
}

export async function pingFrappe() {
  const r = await callFrappe('GET', '/api/method/ping');
  return r.message || r;
}

/**
 * Fetch a Payment Entry by name — returns the full doc with references[]
 * (the invoice allocations) and reference_no (where we put bank_ref+V).
 */
export async function getPaymentEntry(name) {
  if (!name) throw new Error('getPaymentEntry: name required');
  const r = await callFrappe('GET',
    `/api/resource/Payment Entry/${encodeURIComponent(name)}`);
  return r.data || r;
}

/**
 * Fetch a Sales Invoice by name — used by verification path to confirm the
 * allocated invoice's posting_date is past/today (not future) per AS_OF.
 */
export async function getSalesInvoice(name) {
  if (!name) throw new Error('getSalesInvoice: name required');
  const r = await callFrappe('GET',
    `/api/resource/Sales Invoice/${encodeURIComponent(name)}`);
  return r.data || r;
}
