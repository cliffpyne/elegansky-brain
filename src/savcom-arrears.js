// ───────────────────────────────────────────────────────────────────────────
// SAVCOM arrears helper (Frappe-side).
//
// Parallel to apruna-arrears.js — ESTHER SAVCOM's cohort lives entirely in
// Frappe (no QB counterpart to swap). The m6pm sync_mobile parser expects
// 3-part customer paths (BRANCH:OFFICER:CUSTOMER) to register officers vs
// portfolio holders. Without this injection, ESTHER SAVCOM customers never
// reach the mobile arrears view.
//
// Silent replacement: no report format change, no schema touch. Just
// SAVCOM customers now surface in /arrears' last page.
// ───────────────────────────────────────────────────────────────────────────

const FETCH_TIMEOUT_MS = 60_000;
const SAVCOM_OFFICER = 'ESTHER SAVCOM';
const SAVCOM_BRANCH = 'KIJICHI BRANCH';

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
 * Fetch SAVCOM (ESTHER SAVCOM) arrears via the existing Frappe endpoint
 * used by savcom-morning.js. Returns the parsed .rows array.
 */
async function fetchSavcomArrears() {
  const url = `${baseUrl()}/api/method/elegansky.api.arrears?officer=${encodeURIComponent(SAVCOM_OFFICER)}`;
  const r = await fetch(url, {
    headers: { ...authHeader(), Accept: 'application/json' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!r.ok) throw new Error(`SAVCOM arrears fetch HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const j = await r.json();
  const msg = j.message || j;
  if (!msg || !Array.isArray(msg.rows)) throw new Error(`SAVCOM arrears: unexpected shape: ${JSON.stringify(j).slice(0, 200)}`);
  return msg.rows;
}

/**
 * Fetch every overdue Frappe Sales Invoice belonging to the SAVCOM roster,
 * page-walked — same mechanics as apruna-arrears.fetchOverdueAprunaInvoices.
 *
 * Frank 2026-07-22: ESTHER moves fully into the QB-style pipeline (per-
 * invoice rows) like APRUNA. The old one-summary-row-per-customer shape
 * could not feed the arrears SMS {breakdown} (per-invoice date+amount
 * lines) nor an honest morning-vs-evening comparison diff. Roster comes
 * from the existing elegansky.api.arrears endpoint (it knows who belongs
 * to ESTHER); invoice detail comes from the Sales Invoice resource with
 * the SAME eligibility rule as QB/APRUNA: outstanding_amount > 0 AND
 * due_date < asOf AND docstatus = 1.
 */
const PAGE = 500;

async function fetchOverdueSavcomInvoices(asOf) {
  const roster = await fetchSavcomArrears();          // roster + display names
  const nameById = new Map();
  for (const r of roster) {
    if (r.customer) nameById.set(String(r.customer), String(r.display_name || r.customer));
  }
  if (!nameById.size) return { invoices: [], nameById };
  const filters = JSON.stringify([
    ['outstanding_amount', '>', 0],
    ['due_date', '<', asOf],
    ['docstatus', '=', 1],
  ]);
  const fields = JSON.stringify(['name', 'customer', 'outstanding_amount', 'grand_total', 'due_date', 'posting_date']);
  let start = 0;
  const invoices = [];
  while (true) {
    const url = `${baseUrl()}/api/resource/Sales Invoice`
      + `?filters=${encodeURIComponent(filters)}`
      + `&fields=${encodeURIComponent(fields)}`
      + `&order_by=due_date asc`
      + `&limit_start=${start}&limit_page_length=${PAGE}`;
    const r = await fetch(url, { headers: { ...authHeader(), Accept: 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!r.ok) throw new Error(`SAVCOM invoice fetch HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
    const j = await r.json();
    const page = j.data || [];
    if (!page.length) break;
    // Client-side roster filter, same as APRUNA: the overdue set is shared
    // across every Frappe cohort, so filter to ESTHER's customers here.
    for (const inv of page) if (nameById.has(String(inv.customer))) invoices.push(inv);
    if (page.length < PAGE) break;
    start += PAGE;
  }
  return { invoices, nameById };
}

/**
 * Return SAVCOM overdue rows shaped like /arrears' QB enrich() output —
 * ONE ROW PER INVOICE (since 2026-07-22; used to be one summary row per
 * customer). Path format matches APRUNA's contract so m6pm's sync_mobile
 * parses BRANCH:OFFICER:CUSTOMER correctly and registers ESTHER SAVCOM
 * as an officer (not as a portfolio holder).
 *
 * `asOf` (YYYY-MM-DD) defaults to today-EAT so legacy no-arg callers keep
 * working; report paths should pass their own asOf like they do for APRUNA.
 */
export async function getSavcomOverdueRows(asOf) {
  const day = (asOf && /^\d{4}-\d{2}-\d{2}$/.test(String(asOf)))
    ? String(asOf)
    : new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 10);
  const { invoices, nameById } = await fetchOverdueSavcomInvoices(day);
  return invoices.map((inv) => {
    const display = nameById.get(String(inv.customer)) || String(inv.customer || '');
    return {
      qbId: inv.name,
      customerId: String(inv.customer || ''),
      date: inv.posting_date,
      dueDate: inv.due_date,
      type: 'Invoice',
      no: inv.name,
      customer: `${SAVCOM_BRANCH}:${SAVCOM_OFFICER}:${display}`,
      branch: SAVCOM_BRANCH,
      customerLeaf: display,
      memo: '',
      balance: Number(inv.outstanding_amount || 0),
      amount: Number(inv.grand_total || 0),
      status: 'overdue',
    };
  });
}
