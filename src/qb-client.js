// Standalone QuickBooks Online client for the agent runner + future tools.
// Uses direct fetch + shared DB token store (NOT the intuit-oauth library
// instance from server.js, to avoid coupling).
//
// Token refresh policy:
//   - Pre-emptive: refresh when access token is within 10 min of expiry.
//   - Reactive: on any 401, force-refresh once and retry.
//   - Single-flight: concurrent calls share one in-flight refresh promise.
//
// IMPORTANT: this module assumes ANTHROPIC_API_KEY and a Postgres
// connection are NOT its concern. Caller passes a pg.Pool/Client via init().

const TOKEN_URL = 'https://oauth.platform.intuit.com/oauth2/v1/tokens/bearer';
const API_BASE = 'https://quickbooks.api.intuit.com';
const REFRESH_BUFFER_MS = 10 * 60 * 1000;
const MINOR_VERSION = 73;

let _db = null;
let _tokens = null;
let _refreshing = null;

export function initQbClient(db) {
  _db = db;
}

async function loadTokens() {
  const r = await _db.query(`SELECT realm_id, token_json FROM app_oauth_tokens WHERE provider='quickbooks'`);
  if (!r.rows.length) throw new Error('No QB tokens in DB; reconnect via BRAIN /connect');
  const t = r.rows[0].token_json;
  t.realmId = r.rows[0].realm_id;
  return t;
}

async function saveTokens(t) {
  await _db.query(
    `UPDATE app_oauth_tokens SET token_json=$1, updated_at=now() WHERE provider='quickbooks'`,
    [t],
  );
}

function isExpiringSoon(t) {
  const acq = Number(t?.acquiredAt) || 0;
  const expMs = Number(t?.expires_in || 0) * 1000;
  if (!acq || !expMs) return true;
  return Date.now() >= acq + expMs - REFRESH_BUFFER_MS;
}

async function refreshOnce() {
  if (!process.env.QB_CLIENT_ID || !process.env.QB_CLIENT_SECRET) {
    throw new Error('QB_CLIENT_ID/QB_CLIENT_SECRET env vars required');
  }
  // Always reload from DB first. The intuit-oauth client in server.js shares this
  // token row and rotates refresh_token on every refresh. Our in-memory copy may
  // be stale and would 400 with invalid_grant if used directly.
  _tokens = await loadTokens();
  if (!isExpiringSoon(_tokens)) return;
  const auth = Buffer.from(`${process.env.QB_CLIENT_ID}:${process.env.QB_CLIENT_SECRET}`).toString('base64');
  const doRefresh = async () => {
    const r = await fetch(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: 'Basic ' + auth,
        Accept: 'application/json',
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(_tokens.refresh_token),
    });
    return r;
  };
  let r = await doRefresh();
  if (!r.ok && r.status === 400) {
    // Re-read DB once more — another process may have rotated mid-call.
    const fresh = await loadTokens();
    if (fresh.refresh_token !== _tokens.refresh_token) {
      _tokens = fresh;
      if (!isExpiringSoon(_tokens)) return;
      r = await doRefresh();
    }
  }
  if (!r.ok) throw new Error(`qb refresh ${r.status}: ${(await r.text()).slice(0, 300)}`);
  const j = await r.json();
  _tokens = { ...j, realmId: _tokens.realmId, acquiredAt: Date.now() };
  await saveTokens(_tokens);
}

async function ensureFresh() {
  if (!_tokens) _tokens = await loadTokens();
  if (!isExpiringSoon(_tokens)) return;
  if (!_refreshing) {
    _refreshing = refreshOnce().finally(() => { _refreshing = null; });
  }
  await _refreshing;
}

async function call(method, path, body) {
  for (let attempt = 1; attempt <= 5; attempt++) {
    await ensureFresh();
    try {
      const sep = path.includes('?') ? '&' : '?';
      const url = `${API_BASE}/v3/company/${_tokens.realmId}/${path}${sep}minorversion=${MINOR_VERSION}`;
      const headers = {
        Authorization: 'Bearer ' + _tokens.access_token,
        Accept: 'application/json',
      };
      if (body) headers['Content-Type'] = 'application/json';
      const r = await fetch(url, {
        method,
        headers,
        body: body ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(60000),
      });
      if (r.status === 401 && attempt === 1) {
        if (!_refreshing) _refreshing = refreshOnce().finally(() => { _refreshing = null; });
        await _refreshing;
        continue;
      }
      if ((r.status === 429 || r.status >= 500) && attempt < 5) {
        await new Promise((res) => setTimeout(res, 1500 * Math.pow(2, attempt - 1)));
        continue;
      }
      if (!r.ok) {
        const tid = r.headers.get('intuit_tid');
        const text = (await r.text()).slice(0, 500);
        const err = new Error(`QB ${method} ${path} ${r.status}${tid ? ' (intuit_tid=' + tid + ')' : ''}: ${text}`);
        err.intuit_tid = tid;
        err.status = r.status;
        throw err;
      }
      return await r.json();
    } catch (err) {
      const m = String(err.message || '');
      const looksTransient = /ECONNRESET|ETIMEDOUT|UND_ERR|EAI_AGAIN|socket hang up|AbortError/i.test(m);
      if (looksTransient && attempt < 5) {
        await new Promise((res) => setTimeout(res, 1500 * Math.pow(2, attempt - 1)));
        continue;
      }
      throw err;
    }
  }
  throw new Error('qb-client: retry budget exhausted');
}

export async function qbQuery(sql) {
  return call('GET', `query?query=${encodeURIComponent(sql)}`);
}

export async function qbGet(entity, id) {
  return call('GET', `${entity.toLowerCase()}/${id}`);
}

export async function qbPost(path, body) {
  return call('POST', path, body);
}

/**
 * Sparse-update a Payment's TxnDate. Repair tool for Payments whose
 * TxnDate was set wrong by the wall-clock paymentTxnDate() fallback
 * (heisenberg fires that bypassed the per-row sheet_ts logic).
 *
 * Returns { ok, qbId, old_txn_date?, new_txn_date?, skipped? }.
 */
export async function qbPatchPaymentTxnDate(qbId, newTxnDate) {
  const q = await qbQuery(`SELECT * FROM Payment WHERE Id = '${qbId}'`);
  const p = q.QueryResponse?.Payment?.[0];
  if (!p) return { ok: false, qbId, skipped: 'payment_not_found' };
  if (p.TxnDate === newTxnDate) return { ok: true, qbId, skipped: 'already_correct', txn_date: p.TxnDate };
  const body = { Id: p.Id, SyncToken: p.SyncToken, sparse: true, TxnDate: newTxnDate };
  await qbPost('payment', body);
  return { ok: true, qbId, old_txn_date: p.TxnDate, new_txn_date: newTxnDate };
}

// Reports API: returns same data as QB UI reports (TransactionList,
// GeneralLedger, etc). Use this when matching QB's Account QuickReport
// exports byte-for-byte is required.
export async function qbReport(reportName, params = {}) {
  const qs = Object.entries(params)
    .filter(([_, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${k}=${encodeURIComponent(String(v))}`)
    .join('&');
  const path = `reports/${reportName}${qs ? '?' + qs : ''}`;
  return call('GET', path);
}

export async function qbBatch(operations) {
  // operations: [{ bId, operation, entityType, entity }]
  // QBO format: BatchItemRequest[] with the entityType as the property key.
  if (!Array.isArray(operations) || operations.length === 0) return { BatchItemResponse: [] };
  if (operations.length > 30) throw new Error('qbBatch: max 30 ops per call');
  const items = operations.map((op) => ({
    bId: op.bId,
    operation: op.operation,
    [op.entityType]: op.entity,
  }));
  return call('POST', 'batch', { BatchItemRequest: items });
}
