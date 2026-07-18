// ───────────────────────────────────────────────────────────────────────────
// APRUNA arrears helper (Frappe-side).
//
// The morning arrear snapshot writer used to be QB-only. With apruna-divert
// live, APRUNA THOMAS BODA's cohort collects into Frappe — so any QB-side
// arrear count for him will drift stale. This helper computes APRUNA's real
// arrear position from Frappe's Sales Invoice ledger and lets the snapshot
// writer swap it in for his officer row.
//
// Silent replacement: no report format change, no new officer, no schema
// touch. Just the number is right.
// ───────────────────────────────────────────────────────────────────────────

import { getAprunaCache } from './apruna-resolver.js';

const FETCH_TIMEOUT_MS = 45_000;
const PAGE = 500;

function baseUrl() {
  const u = (process.env.FRAPPE_BASE_URL || '').trim();
  if (!u) throw new Error('FRAPPE_BASE_URL not set');
  return u.replace(/\/+$/, '');
}
function authHeader() {
  const t = (process.env.FRAPPE_API_TOKEN || '').trim();
  if (!t.includes(':')) throw new Error('FRAPPE_API_TOKEN must be "<api_key>:<api_secret>"');
  return { Authorization: `token ${t}` };
}

/**
 * Fetch all overdue Frappe Sales Invoices for the APRUNA roster.
 * Same eligibility rule as the QB path: outstanding_amount > 0 AND
 * due_date < asOf AND docstatus = 1.
 * Returns the raw Frappe rows.
 */
async function fetchOverdueAprunaInvoices(asOf) {
  const roster = await getAprunaCache();
  const parties = new Set();
  for (const e of roster.byPlate.values())  if (e.customer) parties.add(String(e.customer));
  for (const e of roster.byQbId.values())   if (e.customer) parties.add(String(e.customer));
  if (!parties.size) return [];
  const filters = JSON.stringify([
    ['outstanding_amount', '>', 0],
    ['due_date', '<', asOf],
    ['docstatus', '=', 1],
  ]);
  const fields = JSON.stringify(['name', 'customer', 'outstanding_amount', 'grand_total', 'due_date', 'posting_date']);
  let start = 0;
  const out = [];
  while (true) {
    const url = `${baseUrl()}/api/resource/Sales Invoice`
      + `?filters=${encodeURIComponent(filters)}`
      + `&fields=${encodeURIComponent(fields)}`
      + `&order_by=due_date asc`
      + `&limit_start=${start}&limit_page_length=${PAGE}`;
    const r = await fetch(url, { headers: { ...authHeader(), Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`APRUNA arrears fetch HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const page = j.data || [];
    if (!page.length) break;
    for (const inv of page) if (parties.has(String(inv.customer))) out.push(inv);
    if (page.length < PAGE) break;
    start += PAGE;
  }
  return out;
}

/**
 * Return Frappe overdue rows shaped like /arrears' QB enrich() output,
 * so downstream consumers (dashboard, m6pm xls) can consume without a
 * format change.
 */
export async function getAprunaOverdueRows(asOf) {
  const invs = await fetchOverdueAprunaInvoices(asOf);
  return invs.map((inv) => ({
    qbId: inv.name,
    customerId: String(inv.customer || ''),
    date: inv.posting_date,
    dueDate: inv.due_date,
    type: 'Invoice',
    no: inv.name,
    // Match the QB path shape (COUNTRY:OFFICER:CUSTOMER) so branch = APRUNA THOMAS BODA
    customer: `APRUNA THOMAS BODA:${inv.customer}`,
    branch: 'APRUNA THOMAS BODA',
    customerLeaf: String(inv.customer || ''),
    memo: '',
    balance: Number(inv.outstanding_amount || 0),
    amount: Number(inv.grand_total || 0),
    status: 'overdue',
  }));
}

/**
 * Sum outstanding_amount + count invoices for APRUNA-roster customers
 * whose due_date < asOf and docstatus = 1 (submitted).
 *
 * Same semantics as the QB path (Balance > 0 AND DueDate < asOf) so the
 * dashboard shows a like-for-like number.
 *
 * Returns { total_arrears, overdue_invoice_count, sampled_customers }.
 */
export async function getAprunaArrearsSummary(asOf) {
  if (!asOf || !/^\d{4}-\d{2}-\d{2}$/.test(String(asOf))) {
    throw new Error(`getAprunaArrearsSummary: bad asOf ${asOf}`);
  }
  const roster = await getAprunaCache();
  const parties = new Set();
  for (const e of roster.byPlate.values())  if (e.customer) parties.add(String(e.customer));
  for (const e of roster.byQbId.values())   if (e.customer) parties.add(String(e.customer));
  if (!parties.size) return { total_arrears: 0, overdue_invoice_count: 0, sampled_customers: 0 };

  // Page through all overdue invoices then filter to APRUNA roster.
  // Filter server-side by due_date + outstanding_amount + docstatus to cut volume.
  const filters = JSON.stringify([
    ['outstanding_amount', '>', 0],
    ['due_date', '<', asOf],
    ['docstatus', '=', 1],
  ]);
  const fields = JSON.stringify(['name', 'customer', 'outstanding_amount', 'due_date']);
  let start = 0;
  let total = 0;
  let count = 0;
  while (true) {
    const url = `${baseUrl()}/api/resource/Sales Invoice`
      + `?filters=${encodeURIComponent(filters)}`
      + `&fields=${encodeURIComponent(fields)}`
      + `&order_by=name asc`
      + `&limit_start=${start}&limit_page_length=${PAGE}`;
    const r = await fetch(url, {
      headers: { ...authHeader(), Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!r.ok) throw new Error(`APRUNA arrears fetch HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const page = j.data || [];
    if (!page.length) break;
    for (const inv of page) {
      if (!parties.has(String(inv.customer))) continue;
      total += Number(inv.outstanding_amount || 0);
      count++;
    }
    if (page.length < PAGE) break;
    start += PAGE;
  }
  return { total_arrears: total, overdue_invoice_count: count, sampled_customers: parties.size };
}
