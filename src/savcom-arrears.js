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
 * Return SAVCOM overdue rows shaped like /arrears' QB enrich() output.
 * Path format matches APRUNA's contract so m6pm's sync_mobile parses
 * BRANCH:OFFICER:CUSTOMER correctly and registers ESTHER SAVCOM as an
 * officer (not as a portfolio holder).
 */
export async function getSavcomOverdueRows() {
  const rows = await fetchSavcomArrears();
  return rows.map((r) => ({
    qbId: `SAVCOM-${r.customer || r.display_name || 'unknown'}`,
    customerId: String(r.customer || ''),
    date: r.oldest_due_date || null,
    dueDate: r.oldest_due_date || null,
    type: 'Invoice',
    no: `SAVCOM-${r.customer || r.display_name || 'unknown'}`,
    customer: `${SAVCOM_BRANCH}:${SAVCOM_OFFICER}:${r.display_name || r.customer}`,
    branch: SAVCOM_BRANCH,
    customerLeaf: String(r.display_name || r.customer || ''),
    memo: `${r.overdue_invoices || 0} overdue invoice(s)`,
    balance: Number(r.total_arrears || 0),
    amount: Number(r.total_arrears || 0),
    status: 'overdue',
  }));
}
