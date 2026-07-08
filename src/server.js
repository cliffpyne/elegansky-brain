import 'dotenv/config';
import express from 'express';
import OAuthClient from 'intuit-oauth';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSharedSheets, sheetMetadata, readSheet, serviceAccountEmail, sortTabByDate } from './sheets.js';
import { mountCyclesApi } from './cycles.js';
import { mountSettingsApi } from './settings.js';
import { mountAdminSmsApi } from './admin-sms.js';
import { mountPaymentBatchesApi } from './payment-batches.js';
import { mountNotificationsApi, notifyAdmin } from './notifications.js';
import { db } from './db/pool.js';
import { createRemoteJWKSet, jwtVerify } from 'jose';
import { initQbClient } from './qb-client.js';
import { mountAgentApi } from './agent/api.js';
import { mountOfficerReportsApi } from './officer-reports.js';
import { mountMegaReportApi } from './mega-report.js';
import { mountLoanSetupApi } from './loan-setup.js';
import { startScheduler } from './agent/scheduler.js';
import { mountLimboRecoveryApi, startLimboRecoveryOnBoot } from './limbo-recovery.js';
import { mountQbMirrorApi } from './qb-mirror-api.js';
import { mountM6pmApi, startM6pmWatchers } from './m6pm-automation.js';
import { mountErpApi } from './erp-api.js';
import { mountFrappeWebhookApi } from './frappe-webhook.js';
import { mountFrappePushApi } from './frappe-push.js';
import { mountFrappeSavApi } from './frappe-push-sav.js';
import { mountSavFrappeApi } from './payment-batches-frappe.js';
import { mountSavcomMorningApi } from './savcom-morning.js';
import { startQbMirrorPoller } from './qb-mirror-poller.js';
import { startSnapshotRefresher } from './qb-snapshot-refresher.js';
import { getPrewarmHooks, computeAccountBalanceForSnapshot, computeSheetTotalsForSnapshot } from './mega-report.js';
import { startMegaReportPrewarmer } from './mega-report-prewarmer.js';
import { startAccountBalanceSnapshotter } from './account-balance-snapshotter.js';
import { startSheetTotalsSnapshotter } from './sheet-totals-snapshotter.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const {
  QB_CLIENT_ID,
  QB_CLIENT_SECRET,
  QB_REDIRECT_URI,
  QB_ENVIRONMENT = 'production',
  PORT = 3000,
} = process.env;

if (!QB_CLIENT_ID || !QB_CLIENT_SECRET || !QB_REDIRECT_URI) {
  console.error('Missing required env vars. Copy .env.example to .env and fill it.');
  process.exit(1);
}

const oauthClient = new OAuthClient({
  clientId: QB_CLIENT_ID,
  clientSecret: QB_CLIENT_SECRET,
  environment: QB_ENVIRONMENT,
  redirectUri: QB_REDIRECT_URI,
  timeout: 90000,
});

const API_BASE = QB_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

// QB OAuth tokens live in Postgres (app_oauth_tokens) so they survive Render
// deploys, which wipe the filesystem. One row keyed by provider='quickbooks'.
// A legacy tokens.json is migrated once on startup if it's still on disk.
const TOKEN_PROVIDER = 'quickbooks';
const LEGACY_TOKENS_FILE = 'tokens.json';

async function loadTokens() {
  const r = await db().query(
    `SELECT token_json, realm_id FROM app_oauth_tokens WHERE provider = $1`,
    [TOKEN_PROVIDER],
  );
  if (!r.rows.length) return null;
  const t = r.rows[0].token_json;
  // realm_id was hoisted to its own column for indexability but it's still in
  // token_json too — keep the call sites happy.
  if (!t.realmId && r.rows[0].realm_id) t.realmId = r.rows[0].realm_id;
  return t;
}

async function saveTokens(token) {
  await db().query(
    `INSERT INTO app_oauth_tokens (provider, realm_id, token_json, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (provider) DO UPDATE
       SET realm_id = EXCLUDED.realm_id,
           token_json = EXCLUDED.token_json,
           updated_at = now()`,
    [TOKEN_PROVIDER, token.realmId ?? null, JSON.stringify(token)],
  );
}

// One-time eager bootstrap: pull existing tokens into the oauth client, and
// migrate the legacy tokens.json if it's still on disk (will only ever hit
// once per server install; after that the file is gone).
(async () => {
  try {
    let saved = await loadTokens();
    if (!saved && existsSync(LEGACY_TOKENS_FILE)) {
      const raw = readFileSync(LEGACY_TOKENS_FILE, 'utf-8').trim();
      if (raw) {
        saved = JSON.parse(raw);
        await saveTokens(saved);
        console.log(`Migrated tokens.json → app_oauth_tokens for realm ${saved.realmId}`);
      }
    }
    if (saved) {
      oauthClient.setToken(saved);
      console.log(`Loaded saved tokens for realm ${saved.realmId}`);
    } else {
      console.log('No saved QB tokens — admin must visit /connect.');
    }
  } catch (err) {
    console.error('[bootstrap] failed to load tokens:', err.message);
  }
})();

// CSRF state for OAuth — stored in-memory; for production-scale use Redis or signed cookies.
const pendingStates = new Set();

// Pre-emptive refresh: if the access token is within REFRESH_BUFFER_MS of
// expiry, refresh now even if isAccessTokenValid() still says yes. Intuit's
// access tokens last 1h; we refresh at 50min to leave headroom for long
// loops (like recalls voiding 1000+ payments back-to-back).
const REFRESH_BUFFER_MS = 10 * 60 * 1000;

function accessTokenExpiringSoon(tokens) {
  if (!tokens) return true;
  const acquiredAt = Number(tokens.acquiredAt) || 0;
  const expiresInMs = Number(tokens.expires_in || 0) * 1000;
  if (!acquiredAt || !expiresInMs) return true;
  return Date.now() >= acquiredAt + expiresInMs - REFRESH_BUFFER_MS;
}

async function refreshNow(prevTokens) {
  const refreshed = await oauthClient.refresh();
  const next = refreshed.getJson();
  next.realmId = prevTokens.realmId;
  next.acquiredAt = Date.now();
  await saveTokens(next);
  oauthClient.setToken(next);
  return next;
}

async function ensureFreshToken() {
  const tokens = await loadTokens();
  if (!tokens) throw new Error('Not connected. Visit /connect first.');
  oauthClient.setToken(tokens);
  if (!oauthClient.isAccessTokenValid() || accessTokenExpiringSoon(tokens)) {
    await refreshNow(tokens);
  }
  return oauthClient.getToken();
}

// If a QB call returns 401 despite our pre-emptive refresh (token was
// invalidated server-side, refresh-token rotated, clock skew, etc.), do one
// forced refresh + retry. After that, fail loudly.
async function qbCallWithRetry(makeCall) {
  await ensureFreshToken();
  // Retry sequence: 401 → token refresh (once); 429/500/502/503/Stale Object/
  // network blips → exponential backoff (up to 5 tries, ~22s total).
  // Stale Object Error: linked-entity SyncToken changed mid-write (e.g.
  // operator editing the invoice in the QB UI). Retry resolves it.
  for (let attempt = 1; attempt <= 5; attempt++) {
    try {
      return await makeCall();
    } catch (err) {
      const message = String(err?.message || '');
      const status = err?.intuit_tid ? null : (err?.authResponse?.response?.status ?? err?.response?.status);
      const looks401 = status === 401 || /\b401\b/.test(message) || /HTTP Error/.test(message);
      const looks429 = status === 429 || /\b429\b/.test(message) || /Rate limit/i.test(message);
      const looks5xx = status === 500 || status === 502 || status === 503 || /\b(500|502|503)\b/.test(message);
      const looksStale = /Stale Object Error/i.test(message);
      const looksNet = /ECONNRESET|ETIMEDOUT|UND_ERR|EAI_AGAIN|socket hang up/i.test(message);
      if (looks401 && attempt === 1) {
        console.warn('[qb] 401 — forcing refresh and retrying once');
        const tokens = await loadTokens();
        if (!tokens) throw err;
        await refreshNow(tokens);
        continue;
      }
      if ((looks429 || looks5xx || looksStale || looksNet) && attempt < 5) {
        const reason = looks429 ? '429' : looks5xx ? '5xx' : looksStale ? 'stale' : 'net';
        const backoffMs = 1000 * Math.pow(2, attempt - 1) + Math.random() * 500;
        console.warn(`[qb] ${reason} — backing off ${Math.round(backoffMs)}ms (attempt ${attempt})`);
        await new Promise((r) => setTimeout(r, backoffMs));
        continue;
      }
      throw err;
    }
  }
  throw new Error('qbCallWithRetry: exceeded retries');
}

async function qbQuery(sql) {
  return qbCallWithRetry(async () => {
    const realmId = oauthClient.getToken().realmId;
    const url = `${API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=73`;
    const response = await oauthClient.makeApiCall({
      url,
      headers: { Accept: 'application/json' },
    });
    return response.json;
  });
}

/**
 * POST a body to a QB Online endpoint and return the parsed JSON.
 * Throws on any non-2xx with a message that includes intuit_tid for tracing.
 */
async function qbPost(resourcePath, body) {
  return qbCallWithRetry(async () => {
    const realmId = oauthClient.getToken().realmId;
    // If resourcePath already has a query string (e.g. "payment?operation=delete")
    // append minorversion with `&`, not `?` — the double-? broke void/delete.
    const sep = resourcePath.includes('?') ? '&' : '?';
    const url = `${API_BASE}/v3/company/${realmId}/${resourcePath}${sep}minorversion=73`;
    const response = await oauthClient.makeApiCall({
      url,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });
    if (response.statusCode && response.statusCode >= 400) {
      const tid = response.headers?.intuit_tid || response.intuit_tid;
      const msg = `QB ${resourcePath} HTTP ${response.statusCode}` +
        (tid ? ` (intuit_tid=${tid})` : '') +
        `: ${typeof response.body === 'string' ? response.body.slice(0, 400) : ''}`;
      const err = new Error(msg);
      err.intuit_tid = tid;
      throw err;
    }
    return response.json;
  });
}

async function ensureQbConnected() {
  const tokens = await loadTokens();
  if (!tokens) throw new Error('Not connected. Visit /connect first.');
  await ensureFreshToken();
}

/**
 * Hard requirement (2026-06-07): every QB-write caller must supply txnDate
 * explicitly. The legacy paymentTxnDate() wall-clock function was REMOVED
 * because callers that forgot to pass it silently stamped Payments with
 * server clock time, landing rows on the wrong QB date. Helper kept only
 * to throw a clear error in case any caller still hits the old code path.
 */
function requireTxnDate(txnDate, fnName) {
  if (!txnDate || typeof txnDate !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(txnDate)) {
    throw new Error(`${fnName}: txnDate required (YYYY-MM-DD) — wall-clock fallback removed. got=${JSON.stringify(txnDate)}`);
  }
  return txnDate;
}

// Default DepositToAccountRef for Payments. 785 = "Elegansky Collection AC:Kijichi
// Collection AC" — same account SaasAnt uploads use, so reports group consistently.
// Without this, QB defaults to "Undeposited Funds" (id 793) and the payments
// don't appear in operator's "money received on Kijichi" Account QuickReport.
// Overridable via QB_DEFAULT_DEPOSIT_ACCT_ID for future hierarchy changes.
const DEFAULT_DEPOSIT_ACCT_ID = process.env.QB_DEFAULT_DEPOSIT_ACCT_ID || '785';

/** Create a QB Payment for one bank-txn line against one invoice. */
async function qbCreatePayment({ customerId, invoiceQbId, amount, memo, txnDate }) {
  const body = {
    CustomerRef: { value: String(customerId) },
    TotalAmt: Number(amount),
    PrivateNote: memo || undefined,
    TxnDate: requireTxnDate(txnDate, 'qbCreatePayment'),
    DepositToAccountRef: { value: DEFAULT_DEPOSIT_ACCT_ID },
    Line: [{
      Amount: Number(amount),
      LinkedTxn: [{ TxnId: String(invoiceQbId), TxnType: 'Invoice' }],
    }],
  };
  const json = await qbPost('payment', body);
  return { id: json.Payment?.Id, response: json };
}

/**
 * Create many Payments in a single QB Batch API call (up to 30 per batch).
 * QB throttles each batch as 1 call regardless of size, so this is the fast
 * path for bulk auto-uploads.
 *
 * items: [{ customerId, invoiceQbId, amount, memo }]
 * returns: aligned array of [{ ok, id, response, error }]
 */
/**
 * Create many Invoices in a single QB Batch API call (up to 30 per batch).
 * items: [{ customerId, productServiceId, amount, txnDate, dueDate?, docNumber? }]
 * returns: aligned array of [{ ok, id, response, error }]
 *
 * Use case: new-loan wizard pushing 397 daily invoices for a single
 * borrower. Serial qbCreateInvoice was ~3 sec/row → 20 min for one loan;
 * batch-30 with 4 concurrent batches finishes the same set in <30 sec.
 */
async function qbBatchCreateInvoices(items) {
  if (items.length === 0) return [];
  if (items.length > 30) throw new Error(`qbBatchCreateInvoices: ${items.length} > 30 (QB max)`);
  const body = {
    BatchItemRequest: items.map((it, ix) => ({
      bId: `i${ix}`,
      operation: 'create',
      Invoice: {
        CustomerRef: { value: String(it.customerId) },
        DocNumber: it.docNumber != null ? String(it.docNumber) : undefined,
        TxnDate: it.txnDate,
        DueDate: it.dueDate || it.txnDate,
        Line: [{
          Amount: Number(it.amount),
          DetailType: 'SalesItemLineDetail',
          SalesItemLineDetail: {
            ItemRef: { value: String(it.productServiceId) },
            UnitPrice: Number(it.amount),
            Qty: 1,
          },
        }],
      },
    })),
  };
  const json = await qbPost('batch', body);
  const byBId = {};
  for (const x of json.BatchItemResponse || []) byBId[x.bId] = x;
  return items.map((_, ix) => {
    const resp = byBId[`i${ix}`];
    if (resp?.Invoice?.Id) return { ok: true, id: resp.Invoice.Id, response: resp.Invoice, error: null };
    const fault = resp?.Fault;
    const errMsg = fault?.Error?.[0]?.Detail || fault?.Error?.[0]?.Message || (resp ? JSON.stringify(resp).slice(0, 200) : 'no response');
    return { ok: false, id: null, response: null, error: errMsg };
  });
}

/**
 * Batch-delete entities (Invoice/Estimate/Customer) up to 30 per call.
 * items: [{ entity: 'Invoice'|'Estimate'|'Customer', id, syncToken }]
 * returns: aligned array of [{ ok, error }]
 */
async function qbBatchDelete(items) {
  if (items.length === 0) return [];
  if (items.length > 30) throw new Error(`qbBatchDelete: ${items.length} > 30 (QB max)`);
  const body = {
    BatchItemRequest: items.map((it, ix) => ({
      bId: `d${ix}`,
      operation: 'delete',
      [it.entity]: { Id: String(it.id), SyncToken: String(it.syncToken ?? '0') },
    })),
  };
  const json = await qbPost('batch', body);
  const byBId = {};
  for (const x of json.BatchItemResponse || []) byBId[x.bId] = x;
  return items.map((_, ix) => {
    const resp = byBId[`d${ix}`];
    if (resp && !resp.Fault) return { ok: true, error: null };
    const fault = resp?.Fault;
    const errMsg = fault?.Error?.[0]?.Detail || fault?.Error?.[0]?.Message || (resp ? JSON.stringify(resp).slice(0, 200) : 'no response');
    return { ok: false, error: errMsg };
  });
}

async function qbBatchCreatePayments(items) {
  if (items.length === 0) return [];
  if (items.length > 30) throw new Error(`qbBatchCreatePayments: ${items.length} > 30 (QB max)`);
  // Each item MUST carry txnDate (2026-06-07 hard requirement). Scheduler
  // sets this from the tick identity (e.g. kili1615 → today; mawenzi1800 →
  // tomorrow). Heisenberg sets it from the dashboard's date-input field.
  // requireTxnDate throws if any item is missing it.
  const body = {
    BatchItemRequest: items.map((it, ix) => ({
      bId: `b${ix}`,
      operation: 'create',
      Payment: {
        CustomerRef: { value: String(it.customerId) },
        TotalAmt: Number(it.amount),
        PrivateNote: it.memo || undefined,
        TxnDate: requireTxnDate(it.txnDate, 'qbBatchCreatePayments'),
        DepositToAccountRef: { value: DEFAULT_DEPOSIT_ACCT_ID },
        Line: [{ Amount: Number(it.amount), LinkedTxn: [{ TxnId: String(it.invoiceQbId), TxnType: 'Invoice' }] }],
      },
    })),
  };
  const json = await qbPost('batch', body);
  const byBId = {};
  for (const x of json.BatchItemResponse || []) byBId[x.bId] = x;
  return items.map((_, ix) => {
    const resp = byBId[`b${ix}`];
    if (resp?.Payment?.Id) return { ok: true, id: resp.Payment.Id, response: resp.Payment, error: null };
    const fault = resp?.Fault;
    const errMsg = fault?.Error?.[0]?.Detail || fault?.Error?.[0]?.Message || (resp ? JSON.stringify(resp).slice(0, 200) : 'no response');
    return { ok: false, id: null, response: null, error: errMsg };
  });
}

/**
 * Create a QB Payment WITHOUT a LinkedTxn — this becomes an "unapplied
 * payment" sitting as a credit on the customer's tab. Used for the
 * "customer matched but no current arrears" case (per operator rule from
 * 2026-06-04: do NOT use CreditMemo, the customer-credit semantics are
 * the same but unapplied Payment is what Frank's books expect).
 */
async function qbCreateUnappliedPayment({ customerId, amount, memo, txnDate }) {
  const body = {
    CustomerRef: { value: String(customerId) },
    TotalAmt: Number(amount),
    PrivateNote: memo || undefined,
    TxnDate: requireTxnDate(txnDate, 'qbCreateUnappliedPayment'),
    DepositToAccountRef: { value: DEFAULT_DEPOSIT_ACCT_ID },
    // No Line[] → unapplied. Frank verified this is the correct shape.
  };
  const json = await qbPost('payment', body);
  return { id: json.Payment?.Id, response: json };
}

/** Batched variant of qbCreateUnappliedPayment (max 30 ops per call). */
async function qbBatchCreateUnappliedPayments(items) {
  if (items.length === 0) return [];
  if (items.length > 30) throw new Error(`qbBatchCreateUnappliedPayments: ${items.length} > 30`);
  const body = {
    BatchItemRequest: items.map((it, ix) => ({
      bId: `u${ix}`,
      operation: 'create',
      Payment: {
        CustomerRef: { value: String(it.customerId) },
        TotalAmt: Number(it.amount),
        PrivateNote: it.memo || undefined,
        TxnDate: requireTxnDate(it.txnDate, 'qbBatchCreateUnappliedPayments'),
        DepositToAccountRef: { value: DEFAULT_DEPOSIT_ACCT_ID },
      },
    })),
  };
  const json = await qbPost('batch', body);
  const byBId = {};
  for (const x of json.BatchItemResponse || []) byBId[x.bId] = x;
  return items.map((_, ix) => {
    const resp = byBId[`u${ix}`];
    if (resp?.Payment?.Id) return { ok: true, id: resp.Payment.Id, response: resp.Payment, error: null };
    const fault = resp?.Fault;
    const errMsg = fault?.Error?.[0]?.Detail || fault?.Error?.[0]?.Message || (resp ? JSON.stringify(resp).slice(0, 200) : 'no response');
    return { ok: false, id: null, response: null, error: errMsg };
  });
}

/**
 * QB pre-flight dedup: given a list of (customerId, bankRefWithSuffix) tuples
 * we're about to push, ask QB which (customerId, PrivateNote) combinations
 * already exist as a Payment or CreditMemo. Returns a Set of "<custId>|<ref>"
 * strings that the caller MUST exclude from the push.
 *
 * Design constraints discovered via live-API tests on 2026-06-04:
 *   - QBO's PrivateNote field is NOT directly queryable
 *     ("property 'PrivateNote' is not queryable", error 4001).
 *     We can't SELECT WHERE PrivateNote = 'X'. So instead:
 *   - CustomerRef IS queryable (with IN(...) clauses, tested up to 50 ids).
 *   - We fetch all Payments+CreditMemos for these customers in the
 *     relevant date window, then check PrivateNote LOCALLY against our
 *     pending refs.
 *   - Pagination: STARTPOSITION + MAXRESULTS works. We loop until a page
 *     returns fewer than MAXRESULTS rows.
 *   - Voided Payments don't appear in queries — fewer false positives.
 *
 * sinceTxnDate: the earliest TxnDate we want QB to return. Should be far
 * enough back to cover any plausible historical duplicate. Default is
 * 60 days, which is far longer than any realistic bank-statement window.
 *
 * Failure mode: throws on persistent QB errors. Caller decides whether to
 * fail open (push anyway + alert) or fail closed (block batch). We
 * recommend failing OPEN with an SMS to the operator — losing dedup for
 * one batch is far less harmful than blocking legitimate uploads.
 */
async function qbPreflightDedup({ tuples, sinceTxnDate }) {
  // tuples: [{ customerId: '8334', ref: '101AGD…N' }, …]
  // Group refs by customerId so we can ask QB per-customer.
  //
  // byCust: cid → Map<lookupForm, canonicalSuffixedRef>
  // For each ref we add TWO lookup forms so PrivateNote matches catch
  // both BRAIN writes (PN = ref+suffix) and manual QB writes (PN = bare
  // ref, no suffix). Frank's operators often write iPhone payments by
  // hand using just the TIPS Vodacom ref — without this dual-form match,
  // dedup misses them and the next auto-fire pushes a duplicate.
  const byCust = new Map();
  const SUFFIX_LETTERS = new Set(['N', 'B', 'P']);
  for (const t of tuples) {
    if (!t.customerId || !t.ref) continue;
    if (!byCust.has(t.customerId)) byCust.set(t.customerId, new Map());
    const m = byCust.get(t.customerId);
    // canonical = the suffixed form (what BRAIN writes + what we use as the dedup key)
    if (!m.has(t.ref)) m.set(t.ref, t.ref);
    // also map the bare form (suffix stripped) → canonical, so a manual
    // QB write with PN = bare ref still matches
    const last = t.ref.slice(-1);
    if (SUFFIX_LETTERS.has(last) && t.ref.length > 1) {
      const bare = t.ref.slice(0, -1);
      if (bare && !m.has(bare)) m.set(bare, t.ref);
    }
  }
  if (byCust.size === 0) return { duplicateKeys: new Set(), detail: [] };

  const customerIds = [...byCust.keys()];
  const sinceISO = sinceTxnDate || (() => {
    const d = new Date(); d.setUTCDate(d.getUTCDate() - 60);
    return d.toISOString().slice(0, 10);
  })();

  const duplicateKeys = new Set();   // "<custId>|<ref>"
  const detail = [];                  // [{ customerId, ref, qb_id, qb_kind, qb_txn_date }]

  // Query Payment + CreditMemo for each chunk of ≤50 customers
  const CHUNK = 50;
  for (let i = 0; i < customerIds.length; i += CHUNK) {
    const chunk = customerIds.slice(i, i + CHUNK);
    const inList = chunk.map((id) => "'" + String(id).replace(/'/g, "''") + "'").join(',');

    for (const entity of ['Payment', 'CreditMemo']) {
      let start = 1;
      while (true) {
        const sql = `SELECT Id, PrivateNote, CustomerRef, TxnDate FROM ${entity} ` +
                    `WHERE CustomerRef IN (${inList}) AND TxnDate >= '${sinceISO}' ` +
                    `STARTPOSITION ${start} MAXRESULTS 1000`;
        const j = await qbQuery(sql);
        const items = j.QueryResponse?.[entity] || [];
        for (const x of items) {
          const pn = x.PrivateNote;
          if (!pn) continue;
          const cid = x.CustomerRef?.value;
          if (!cid) continue;
          const refsForThisCust = byCust.get(cid);
          if (!refsForThisCust) continue;
          // matches EITHER the suffixed form (BRAIN-written) OR the bare
          // form (manual QB-written). Canonical = the suffixed ref so the
          // key + external_consumed_refs row stays consistent.
          const canonical = refsForThisCust.get(pn);
          if (!canonical) continue;
          const key = `${cid}|${canonical}`;
          if (duplicateKeys.has(key)) continue;
          duplicateKeys.add(key);
          detail.push({
            customerId: cid,
            ref: canonical,
            qb_id: x.Id,
            qb_kind: entity === 'Payment' ? 'payment' : 'credit_memo',
            qb_txn_date: x.TxnDate,
            matched_via: pn === canonical ? 'suffixed' : 'bare',
          });
        }
        if (items.length < 1000) break;
        start += 1000;
      }
    }
  }
  return { duplicateKeys, detail };
}

/** Batched QB Customer lookup by DisplayName. Returns name → customerId map. */
async function qbBatchLookupCustomers(displayNames) {
  const out = {};
  const unique = [...new Set(displayNames.filter(Boolean))];
  for (let i = 0; i < unique.length; i += 30) {
    const chunk = unique.slice(i, i + 30);
    const inList = chunk.map((n) => `'${String(n).replace(/'/g, "\\'")}'`).join(',');
    const j = await qbQuery(`SELECT Id, DisplayName, Active, Balance FROM Customer WHERE DisplayName IN (${inList}) MAXRESULTS 1000`);
    const all = j.QueryResponse?.Customer || [];
    const byName = {};
    for (const cust of all) (byName[cust.DisplayName] ||= []).push(cust);
    for (const name of chunk) {
      const cands = byName[name] || [];
      if (!cands.length) continue;
      const active = cands.filter((c) => c.Active);
      const pickFrom = active.length ? active : cands;
      const withBal = pickFrom.filter((c) => Number(c.Balance || 0) > 0);
      out[name] = (withBal[0] || pickFrom[0]).Id;
    }
  }
  return out;
}

/** Create a QB Credit Memo (the "unused" side) for one bank-txn line. */
async function qbCreateCreditMemo({ customerId, amount, memo, txnDate }) {
  const body = {
    CustomerRef: { value: String(customerId) },
    PrivateNote: memo || undefined,
    TxnDate: requireTxnDate(txnDate, 'qbCreateCreditMemo'),
    Line: [{
      DetailType: 'SalesItemLineDetail',
      Amount: Number(amount),
      SalesItemLineDetail: {},
      Description: memo || 'Unused — credit memo',
    }],
  };
  const json = await qbPost('creditmemo', body);
  return { id: json.CreditMemo?.Id, response: json };
}

/**
 * Void a QB Payment or CreditMemo. QB requires we re-POST the full
 * resource with operation=void, but in practice just providing { Id,
 * SyncToken } works since we don't need to mutate other fields.
 */
async function qbVoid({ kind, qbId }) {
  // Despite the name, the operation is delete for both Payments and CreditMemos:
  //   - 'void' on a Payment returns 'Unsupported Operation' from QB Online.
  //     For payments, delete removes the record AND restores the linked
  //     invoices' balances, which is exactly what recall wants.
  //   - Same for CreditMemos.
  // QB needs the SyncToken so we fetch the current entity first.
  const entityName = kind === 'payment' ? 'Payment' : 'CreditMemo';
  const q = await qbQuery(`SELECT * FROM ${entityName} WHERE Id = '${qbId}'`);
  const entity = q.QueryResponse?.[entityName]?.[0];
  if (!entity) {
    // Already gone — treat as successfully voided.
    return { alreadyGone: true, qbId };
  }
  const body = { Id: entity.Id, SyncToken: entity.SyncToken };
  const path = kind === 'payment' ? 'payment?operation=delete' : 'creditmemo?operation=delete';
  return await qbPost(path, body);
}

const app = express();
app.set('trust proxy', true); // ngrok / Cloudflare / any reverse proxy
// Worker reports + screenshots can be a few hundred KB. Default 100kb won't fit.
app.use(express.json({ limit: '50mb' }));

// /api/cycles* — statement-pull dashboard data plane.
mountCyclesApi(app);
// /api/settings* — runtime toggles (loop kill switch).
mountSettingsApi(app);
mountAdminSmsApi(app);
// /api/payment-batches*, /api/arrears-snapshots, /api/consumed-transactions
mountPaymentBatchesApi(app, {
  qbCreatePayment, qbBatchCreatePayments,
  qbCreateUnappliedPayment, qbBatchCreateUnappliedPayments,
  qbBatchLookupCustomers,
  qbCreateCreditMemo,
  qbPreflightDedup,
  qbVoid, ensureQbConnected,
});

// Standalone QB client (used by the agent runner). Shares the same DB token
// store as the intuit-oauth client above but has its own fetch-based code
// path. Safe because cron sessions run sequentially.
initQbClient(db());

// ── Notifications + SMS gateway ──────────────────────────────────────────
// The phone APK polls /api/notifications/pending using PHONE_API_KEY and
// forwards each row as an SMS to the recipient list in app_settings.
const PHONE_API_KEY = process.env.PHONE_API_KEY || '';
const STATEMENT_REPORT_SECRET = process.env.STATEMENT_REPORT_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_JWKS = SUPABASE_URL
  ? createRemoteJWKSet(new URL(`${SUPABASE_URL}/auth/v1/.well-known/jwks.json`))
  : null;

function requireSharedSecret(req, res, next) {
  if (!STATEMENT_REPORT_SECRET) return res.status(503).json({ error: 'STATEMENT_REPORT_SECRET not configured' });
  if (req.get('x-report-secret') !== STATEMENT_REPORT_SECRET) return res.status(401).json({ error: 'bad secret' });
  next();
}
async function requireSupabaseJwt(req, res, next) {
  if (!SUPABASE_JWKS) return res.status(503).json({ error: 'SUPABASE_URL not configured' });
  const auth = req.get('authorization') || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  if (!token) return res.status(401).json({ error: 'missing bearer token' });
  try {
    const { payload } = await jwtVerify(token, SUPABASE_JWKS, { issuer: `${SUPABASE_URL}/auth/v1` });
    req.auth = payload;
    next();
  } catch (err) {
    return res.status(401).json({ error: 'invalid token: ' + err.message });
  }
}
function requirePhoneKey(req, res, next) {
  if (!PHONE_API_KEY) return res.status(503).json({ error: 'PHONE_API_KEY not configured' });
  if (req.get('x-phone-key') !== PHONE_API_KEY) return res.status(401).json({ error: 'bad phone key' });
  next();
}
function requireSecretOrJwt(req, res, next) {
  if (req.get('x-report-secret')) return requireSharedSecret(req, res, next);
  return requireSupabaseJwt(req, res, next);
}
mountNotificationsApi(app, { requireSharedSecret, requireSupabaseJwt, requirePhoneKey });
mountAgentApi(app, { requireSharedSecret, requireSupabaseJwt, requirePhoneKey });
mountLimboRecoveryApi(app, { requireSupabaseJwt });
mountOfficerReportsApi(app, { requireSecretOrJwt });
mountMegaReportApi(app, { requireSecretOrJwt });
mountLoanSetupApi(app, { qbPost, qbBatchCreateInvoices, qbBatchCreatePayments, qbBatchDelete, requireSecretOrJwt });
mountQbMirrorApi(app, { requireSecretOrJwt });
mountM6pmApi(app, {
  requireSecretOrJwt,
  sharedSecret: process.env.STATEMENT_REPORT_SECRET,
  pool: db(),
});
mountErpApi(app, { pool: db() });
mountFrappeWebhookApi(app, { pool: db() });
mountFrappePushApi(app, { requireSecretOrJwt });
mountFrappeSavApi(app, { requireSecretOrJwt });
mountSavFrappeApi(app, { requireSecretOrJwt });
mountSavcomMorningApi(app, { requireSecretOrJwt, pool: db() });
startM6pmWatchers({
  pool: db(),
  sharedSecret: process.env.STATEMENT_REPORT_SECRET,
  brainBase: process.env.BRAIN_BASE_URL || 'https://elegansky-brain.onrender.com',
});

// (legacy / homepage removed — the Vite dashboard now owns "/" and the React
// router handles all client-side paths. QB OAuth status moves to /api/qb/status
// for the dashboard to consume in a follow-up.)
app.get('/api/qb/status', async (_req, res) => {
  try {
    const tokens = await loadTokens();
    res.json({ connected: !!tokens, realmId: tokens?.realmId ?? null });
  } catch (err) {
    res.status(500).json({ connected: false, error: err.message });
  }
});

app.get('/connect', (req, res) => {
  const state = randomBytes(16).toString('hex');
  pendingStates.add(state);
  const authUri = oauthClient.authorizeUri({
    scope: [OAuthClient.scopes.Accounting],
    state,
  });
  res.redirect(authUri);
});

app.get('/callback', async (req, res) => {
  console.log('--- /callback hit ---');
  console.log('Query:', req.query);
  try {
    const { state, realmId, code, error, error_description } = req.query;

    if (error) {
      console.error('Intuit returned OAuth error:', error, error_description);
      return res.status(400).send(`<h1>OAuth error from Intuit</h1><p><b>${error}</b>: ${error_description || ''}</p><p><a href="/">Home</a></p>`);
    }
    if (!code) {
      return res.status(400).send('No authorization code in callback.');
    }
    if (!pendingStates.has(state)) {
      console.error('Unknown state:', state, 'pending:', [...pendingStates]);
      return res.status(400).send('Invalid OAuth state (possible CSRF or server restart between /connect and /callback).');
    }
    pendingStates.delete(state);

    // Always reconstruct the URL using the configured redirect URI base — avoids any protocol-mismatch issues behind proxies.
    const baseUrl = new URL(QB_REDIRECT_URI);
    const fullUrl = baseUrl.origin + req.originalUrl;
    console.log('Reconstructed callback URL for token exchange:', fullUrl);

    const authResponse = await oauthClient.createToken(fullUrl);
    const token = authResponse.getJson();
    token.realmId = realmId;
    token.acquiredAt = Date.now();
    await saveTokens(token);
    console.log('✅ Tokens saved for realm', realmId);
    res.send(`<h1>✅ Connected</h1><p>Realm: <code>${realmId}</code></p><p><a href="/">Home</a></p>`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`<h1>OAuth error</h1><pre>${err.message}\n\n${err.stack}</pre><p><a href="/">Home</a></p>`);
  }
});

app.get('/disconnect', async (req, res) => {
  try { await oauthClient.revoke(); } catch (e) { /* token may already be invalid */ }
  await db().query(`DELETE FROM app_oauth_tokens WHERE provider = $1`, [TOKEN_PROVIDER]);
  if (existsSync(LEGACY_TOKENS_FILE)) unlinkSync(LEGACY_TOKENS_FILE);
  res.send(`<h1>Disconnected</h1><p><a href="/">Home</a></p>`);
});

app.get('/invoices', async (req, res) => {
  try {
    const pageSize = Math.min(Number(req.query.pageSize) || 100, 1000);
    const start = Math.max(Number(req.query.start) || 1, 1);
    const result = await qbQuery(`SELECT * FROM Invoice STARTPOSITION ${start} MAXRESULTS ${pageSize}`);
    const invoices = result.QueryResponse?.Invoice ?? [];
    const nextStart = invoices.length === pageSize ? start + pageSize : null;
    res.json({
      page: { start, pageSize, returned: invoices.length, nextStart },
      invoices,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, intuit_tid: err.intuit_tid });
  }
});

/**
 * Customer id → FullyQualifiedName cache.
 *
 * QB's Invoice rows only carry CustomerRef = { value: id, name: leafName },
 * not the full hierarchical "BRANCH:LEADER:GROUP:CUSTOMER" path needed to
 * match the operator's ARREAR.xls. We pull every Customer once and key by
 * id. Refreshed on demand if more than 5 min stale (customer hierarchy
 * changes rarely; invoices reference existing customers).
 */
const CUSTOMER_CACHE = { map: null, builtAt: 0 };
const CUSTOMER_TTL_MS = 5 * 60_000;

async function getCustomerPathMap() {
  if (CUSTOMER_CACHE.map && Date.now() - CUSTOMER_CACHE.builtAt < CUSTOMER_TTL_MS) {
    return CUSTOMER_CACHE.map;
  }
  const map = new Map();
  const PAGE = 1000;
  let start = 1;
  // QB's "Active" filter excludes archived customers; we include both because
  // an active invoice could still reference an archived customer.
  while (start < 200_000) {
    const sql = `SELECT Id, FullyQualifiedName, DisplayName FROM Customer STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
    const r = await qbQuery(sql);
    const customers = r.QueryResponse?.Customer ?? [];
    if (!customers.length) break;
    for (const c of customers) {
      map.set(String(c.Id), c.FullyQualifiedName || c.DisplayName || `Customer ${c.Id}`);
    }
    if (customers.length < PAGE) break;
    start += PAGE;
  }
  CUSTOMER_CACHE.map = map;
  CUSTOMER_CACHE.builtAt = Date.now();
  console.log(`[customers] built cache: ${map.size} customers`);
  return map;
}

/**
 * /arrears — overdue, still-unpaid invoices, equivalent to ARREAR.xls
 *           (Type=Invoices, Status=Overdue, Date=All).
 *
 * QB "overdue" = Balance > 0 AND DueDate < today. We page through QB,
 * enrich each invoice with the customer's full path (BRANCH:LEADER:
 * GROUP:CUSTOMER) using a cached Customer table lookup, and return the
 * .xls schema:
 *
 *   { date, type, no, customer, memo, balance, amount, status, qbId,
 *     dueDate, branch, customerLeaf }
 *
 * Plus aggregate fields (asOf, page) on the envelope.
 *
 * Query params:
 *   ?summary=1       — return only { count, totalBalance, branches } (cheap)
 *   ?pageSize=100    — invoices per page (max 1000)
 *   ?start=1         — STARTPOSITION (1-based)
 *   ?asOf=YYYY-MM-DD — override "today" cutoff
 *   ?branch=<name>   — filter to one branch (matches first ":" segment)
 *   ?q=<text>        — match in customer path OR invoice number (substring)
 */
app.get('/arrears', async (req, res) => {
  try {
    const asOf = (req.query.asOf || new Date().toISOString().slice(0, 10)).toString();
    const wantSummary = req.query.summary === '1' || req.query.summary === 'true';
    const branchFilter = (req.query.branch || '').toString().toLowerCase();
    const qFilter = (req.query.q || '').toString().toLowerCase();
    // ?excludeToday=true → use DueDate < asOf instead of <= asOf.
    // The DEFAULT (<=) is what the payment app needs so today's daily
    // invoices get applied. Reports for officers should use < to match
    // QB's "Overdue" status filter (which excludes today). Frank rule:
    // payment code stays untouched, only the report path passes this flag.
    const excludeToday = req.query.excludeToday === '1' || req.query.excludeToday === 'true';
    const dueOp = excludeToday ? '<' : '<=';

    const customerMap = await getCustomerPathMap();

    /** Enrich one QB Invoice → flat .xls-shaped row. */
    const enrich = (inv) => {
      const customerId = String(inv.CustomerRef?.value ?? '');
      const customer =
        customerMap.get(customerId) || inv.CustomerRef?.name || '(unknown customer)';
      const parts = customer.split(':');
      const branch = parts[0] || '(unknown)';
      const customerLeaf = parts[parts.length - 1] || customer;
      return {
        qbId: inv.Id,
        customerId,
        date: inv.TxnDate,
        dueDate: inv.DueDate,
        type: 'Invoice',
        no: inv.DocNumber || '',
        customer,
        branch,
        customerLeaf,
        memo: inv.CustomerMemo?.value || inv.PrivateNote || '',
        balance: Number(inv.Balance ?? 0),
        amount: Number(inv.TotalAmt ?? 0),
        status: 'overdue',
      };
    };

    const matchesFilters = (row) => {
      if (branchFilter && row.branch.toLowerCase() !== branchFilter) return false;
      if (qFilter && !`${row.customer} ${row.no}`.toLowerCase().includes(qFilter)) return false;
      return true;
    };

    if (wantSummary) {
      // QB doesn't expose SUM(); page-walk the whole filtered set in chunks
      // of 1000 and tally on our side.
      const PAGE = 1000;
      let start = 1;
      let count = 0;
      let totalBalance = 0;
      const branchCounts = {};
      while (start < 200_000) {
        const sql =
          `SELECT Id, DocNumber, TxnDate, DueDate, Balance, TotalAmt, CustomerRef, CustomerMemo ` +
          `FROM Invoice WHERE Balance > '0' AND DueDate ${dueOp} '${asOf}' ` +
          `STARTPOSITION ${start} MAXRESULTS ${PAGE}`;
        const r = await qbQuery(sql);
        const invs = r.QueryResponse?.Invoice ?? [];
        if (!invs.length) break;
        for (const inv of invs) {
          const row = enrich(inv);
          if (!matchesFilters(row)) continue;
          count++;
          totalBalance += row.balance;
          branchCounts[row.branch] = (branchCounts[row.branch] || 0) + 1;
        }
        if (invs.length < PAGE) break;
        start += PAGE;
      }
      return res.json({
        asOf,
        count,
        totalBalance: Math.round(totalBalance * 100) / 100,
        branches: branchCounts,
      });
    }

    // Paginated list. We over-fetch by 50% to absorb filter drop-outs without
    // shipping multiple round-trips for one dashboard page request.
    const pageSize = Math.min(Number(req.query.pageSize) || 100, 1000);
    const start = Math.max(Number(req.query.start) || 1, 1);
    const fetchSize = branchFilter || qFilter ? Math.min(1000, pageSize * 4) : pageSize;
    const sql =
      `SELECT Id, DocNumber, TxnDate, DueDate, Balance, TotalAmt, CustomerRef, CustomerMemo ` +
      `FROM Invoice WHERE Balance > '0' AND DueDate ${dueOp} '${asOf}' ` +
      `STARTPOSITION ${start} MAXRESULTS ${fetchSize}`;
    const r = await qbQuery(sql);
    const raw = r.QueryResponse?.Invoice ?? [];
    const rows = raw.map(enrich).filter(matchesFilters).slice(0, pageSize);
    const nextStart = raw.length === fetchSize ? start + fetchSize : null;
    res.json({
      asOf,
      page: { start, pageSize, returned: rows.length, nextStart },
      invoices: rows,
    });
  } catch (err) {
    console.error('[GET /arrears]', err);
    res.status(500).json({ error: err.message, intuit_tid: err.intuit_tid });
  }
});

// /arrears/customer — server-side lookup for one customer's exact debt.
// Existing /arrears?q= only filters within a single fetched page (client-side
// after over-fetch). This endpoint paginates through the FULL QB result set,
// filters by customer substring, and returns per-invoice rows + aggregates.
//
// Frank's use case: `Give me the exact debt for KIBABUKWA MBIGA PETER`
// without paginating 17 pages client-side.
//
// Query: ?q=<substring, case-insensitive, matches customer or invoice#>
//        &asOf=YYYY-MM-DD             (default: today)
//        &excludeToday=true|false     (default false — payment code path)
app.get('/arrears/customer', async (req, res) => {
  try {
    const q = (req.query.q || '').toString().trim();
    if (!q) return res.status(400).json({ error: 'q= required' });
    const asOf = (req.query.asOf || new Date().toISOString().slice(0, 10)).toString();
    const excludeToday = req.query.excludeToday === '1' || req.query.excludeToday === 'true';
    const dueOp = excludeToday ? '<' : '<=';

    const customerMap = await getCustomerPathMap();
    const qLower = q.toLowerCase();

    const enrich = (inv) => {
      const customerId = String(inv.CustomerRef?.value ?? '');
      const customer =
        customerMap.get(customerId) || inv.CustomerRef?.name || '(unknown customer)';
      const parts = customer.split(':');
      const branch = parts[0] || '(unknown)';
      const customerLeaf = parts[parts.length - 1] || customer;
      return {
        qbId: inv.Id,
        customerId,
        date: inv.TxnDate,
        dueDate: inv.DueDate,
        type: 'Invoice',
        no: inv.DocNumber || '',
        customer,
        branch,
        customerLeaf,
        memo: inv.CustomerMemo?.value || inv.PrivateNote || '',
        balance: Number(inv.Balance ?? 0),
        amount: Number(inv.TotalAmt ?? 0),
      };
    };

    // Page-walk the full QB result set. All-match search (customer or docNum
    // substring) is done in JS because QB SQL LIKE on CustomerRef isn't
    // reliable and DocNumber is a partial-match anyway. Cheap for a single
    // customer lookup — one round trip per 1000 QB rows.
    const PAGE = 1000;
    let startPos = 1;
    const matches = [];
    while (startPos < 200_000) {
      const sql =
        `SELECT Id, DocNumber, TxnDate, DueDate, Balance, TotalAmt, CustomerRef, CustomerMemo ` +
        `FROM Invoice WHERE Balance > '0' AND DueDate ${dueOp} '${asOf}' ` +
        `STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
      const r = await qbQuery(sql);
      const invs = r.QueryResponse?.Invoice ?? [];
      if (!invs.length) break;
      for (const inv of invs) {
        const row = enrich(inv);
        const hay = `${row.customer} ${row.no}`.toLowerCase();
        if (hay.includes(qLower)) matches.push(row);
      }
      if (invs.length < PAGE) break;
      startPos += PAGE;
    }

    matches.sort((a, b) => (a.date || '').localeCompare(b.date || ''));

    // Aggregate per customer (unique customer names among matches).
    const perCustomer = new Map();
    let totalBalance = 0;
    for (const m of matches) {
      const key = m.customer;
      if (!perCustomer.has(key)) {
        perCustomer.set(key, {
          customer: m.customer,
          customerLeaf: m.customerLeaf,
          branch: m.branch,
          invoices: 0,
          open_balance: 0,
          partial_invoices: 0,
        });
      }
      const rec = perCustomer.get(key);
      rec.invoices++;
      rec.open_balance += m.balance;
      if (m.balance !== m.amount) rec.partial_invoices++;
      totalBalance += m.balance;
    }

    res.json({
      asOf,
      q,
      excludeToday,
      total_invoices: matches.length,
      total_open_balance: Math.round(totalBalance * 100) / 100,
      customers: Array.from(perCustomer.values()),
      invoices: matches,
    });
  } catch (err) {
    console.error('[GET /arrears/customer]', err);
    res.status(500).json({ error: err.message, intuit_tid: err.intuit_tid });
  }
});

// /api/customer-tree — LIVE from QB, no mirror, no computed totals.
// Frank's ERP-Frappe migration helper (2026-07-04): the Frappe engineer
// needs to see the raw QB state for a parent customer + all their child
// customers, with estimates + invoices + payments + credit memos exactly
// as QB has them. Zero recalculation — just the raw docs.
//
// Query:
//   ?parent=APRUNA%20THOMAS%20BODA
//   OR: ?parent_id=<QB Customer Id>
//
// Response:
//   { parent: {…customer…},
//     children: [
//       { customer: {…},
//         estimates: [ …raw QB Estimates… ],
//         invoices: [ …raw QB Invoices… ],
//         payments: [ …raw QB Payments… ],
//         credit_memos: [ …raw QB CreditMemos… ]
//       },
//       …
//     ],
//     asOf: "…ISO…"
//   }
app.get('/api/customer-tree', async (req, res) => {
  try {
    const parentName = (req.query.parent || '').toString().trim();
    const parentId = (req.query.parent_id || '').toString().trim();
    if (!parentName && !parentId) {
      return res.status(400).json({ error: 'parent=<name> or parent_id=<QB id> required' });
    }

    // QBO's query language rejects an explicit column list that names any
    // NESTED/complex field (ParentRef, Line, CustomerRef, BillAddr, ShipAddr,
    // MetaData, PaymentMethodRef, DefaultTaxCodeRef, CurrencyRef, …). Only
    // scalar top-level columns can be named explicitly. `SELECT *` IS valid
    // for single-entity queries and returns EVERY field — including the
    // nested ones we need (ParentRef.value to find children, CustomerRef.value
    // for docs). Frank 2026-07-06 after the Frappe engineer diagnosed the
    // 75ec270 regression: switching to explicit columns brought "Invalid query"
    // because the column list included nested fields — the original SELECT *
    // was never wrong, the WHERE clause was.

    // Extract QBO's real fault detail from an error thrown by intuit-oauth's
    // makeApiCall — bubble it up in the response so future debugging isn't
    // blind. The SDK stashes the raw body under authResponse.body.
    const qbFaultOf = (err) => {
      try {
        const body = err?.authResponse?.body || err?.response?.body || '';
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        const detail = parsed?.Fault?.Error?.[0]?.Detail || parsed?.Fault?.Error?.[0]?.Message;
        return detail || null;
      } catch { return null; }
    };

    // 1. Resolve parent
    let parent;
    const escSql = (s) => String(s).replace(/'/g, "''");
    if (parentId) {
      const r = await qbQuery(
        `SELECT * FROM Customer WHERE Id = '${escSql(parentId)}'`,
      );
      parent = r.QueryResponse?.Customer?.[0];
    } else {
      // Try FullyQualifiedName + DisplayName in ONE query (QB supports OR).
      // If that ever fails, fall through to two separate queries.
      const nEsc = escSql(parentName);
      try {
        const q1 = await qbQuery(
          `SELECT * FROM Customer ` +
          `WHERE FullyQualifiedName = '${nEsc}' OR DisplayName = '${nEsc}' MAXRESULTS 5`,
        );
        parent = q1.QueryResponse?.Customer?.[0];
      } catch { /* fall through to two-query path */ }
      if (!parent) {
        try {
          const qA = await qbQuery(
            `SELECT * FROM Customer WHERE FullyQualifiedName = '${nEsc}' MAXRESULTS 1`,
          );
          parent = qA.QueryResponse?.Customer?.[0];
        } catch { /* ignore */ }
      }
      if (!parent) {
        try {
          const qB = await qbQuery(
            `SELECT * FROM Customer WHERE DisplayName = '${nEsc}' MAXRESULTS 1`,
          );
          parent = qB.QueryResponse?.Customer?.[0];
        } catch { /* ignore */ }
      }
      if (!parent) {
        // Case-insensitive page-walk (max 5 × 1000)
        const target = parentName.toUpperCase();
        let start = 1;
        for (let i = 0; i < 5 && !parent; i++) {
          const q = await qbQuery(
            `SELECT * FROM Customer WHERE Active IN (true, false) ` +
            `STARTPOSITION ${start} MAXRESULTS 1000`,
          );
          const list = q.QueryResponse?.Customer || [];
          if (!list.length) break;
          for (const c of list) {
            const fqn = String(c.FullyQualifiedName || '').toUpperCase();
            const dn = String(c.DisplayName || '').toUpperCase();
            if (fqn === target || dn === target || fqn.endsWith(':' + target)) {
              parent = c;
              break;
            }
          }
          if (list.length < 1000) break;
          start += 1000;
        }
      }
    }
    if (!parent) {
      return res.status(404).json({ error: `customer not found: ${parentName || parentId}` });
    }

    // 2. Find children (Customers with ParentRef.value = parent.Id).
    // QBO's `WHERE ParentRef = 'X'` support is inconsistent — safer to
    // page-walk Customer with Job=true (sub-customers only) and filter
    // client-side. For customers with 1-2k children this is 1-2 QB calls.
    const children = [];
    {
      let start = 1;
      for (let i = 0; i < 10; i++) {
        const q = await qbQuery(
          `SELECT * FROM Customer WHERE Job = true ` +
          `STARTPOSITION ${start} MAXRESULTS 1000`,
        );
        const list = q.QueryResponse?.Customer || [];
        for (const c of list) {
          if (String(c.ParentRef?.value || '') === String(parent.Id)) children.push(c);
        }
        if (list.length < 1000) break;
        start += 1000;
      }
    }
    const allCustomers = [parent, ...children];

    // 3. Fetch estimates + invoices + payments + credit_memos per customer.
    // Per-doc errors surface QBO fault detail so the caller sees exactly
    // which field/token blew up on the affected customer (rather than a
    // generic "Invalid query" collapsing everything).
    const fetchDocsFor = async (customerId) => {
      const idEsc = escSql(customerId);
      const wrap = async (sql) => {
        try { return await qbQuery(sql); }
        catch (e) {
          return { _err: e.message, _fault: qbFaultOf(e), _sql: sql };
        }
      };
      const [est, inv, pay, cm] = await Promise.all([
        wrap(`SELECT * FROM Estimate WHERE CustomerRef = '${idEsc}' MAXRESULTS 1000`),
        wrap(`SELECT * FROM Invoice WHERE CustomerRef = '${idEsc}' MAXRESULTS 1000`),
        wrap(`SELECT * FROM Payment WHERE CustomerRef = '${idEsc}' MAXRESULTS 1000`),
        wrap(`SELECT * FROM CreditMemo WHERE CustomerRef = '${idEsc}' MAXRESULTS 1000`),
      ]);
      return {
        estimates: est.QueryResponse?.Estimate || [],
        invoices: inv.QueryResponse?.Invoice || [],
        payments: pay.QueryResponse?.Payment || [],
        credit_memos: cm.QueryResponse?.CreditMemo || [],
        errors: [est, inv, pay, cm].filter((x) => x._err).map((x) => ({ sql: x._sql, err: x._err, fault: x._fault })),
      };
    };

    const results = [];
    for (const c of allCustomers) {
      const docs = await fetchDocsFor(c.Id);
      results.push({
        customer: c,
        estimates: docs.estimates,
        invoices: docs.invoices,
        payments: docs.payments,
        credit_memos: docs.credit_memos,
        ...(docs.errors.length ? { errors: docs.errors } : {}),
      });
    }

    res.json({
      asOf: new Date().toISOString(),
      parent_id: parent.Id,
      parent_name: parent.FullyQualifiedName || parent.DisplayName,
      customer_count: allCustomers.length,
      tree: results,
    });
  } catch (err) {
    const fault = (() => {
      try {
        const body = err?.authResponse?.body || err?.response?.body || '';
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return parsed?.Fault?.Error?.[0]?.Detail || parsed?.Fault?.Error?.[0]?.Message || null;
      } catch { return null; }
    })();
    console.error('[GET /api/customer-tree]', err.message, 'fault=', fault);
    res.status(500).json({
      error: err.message,
      qb_fault_detail: fault,
      intuit_tid: err.intuit_tid,
    });
  }
});

// /api/customer-migration-plan — per Frank 2026-07-08 for Frappe migration.
// Returns per sub-customer everything Frappe needs to build the customer
// record cleanly without touching the (stale) mirror DB or re-deriving
// anything from raw QB. Rules encoded (Frank locked these in):
//   contract_amount   = sum of Estimates.TotalAmt (NOT sum of invoices —
//                       invoices include penalties + moved-forward + normal
//                       and that confuses the total)
//   daily_rate        = 12,500 TZS hardcoded (business-wide constant)
//   loan_start_date   = min(Invoice.TxnDate)
//   paid_up_to_date   = loan_start + (total_paid / 12,500) days (informational)
//   real_overdue      = pull ACTUAL overdue invoices with real dates + amounts,
//                       do NOT consolidate — Frappe copies each one as-is
//   moved_forward     = TxnDate<=today AND DueDate>today AND balance>0
//   penalty           = TotalAmt != 12,500 AND TotalAmt > 12,500 (e.g. 15k/20k)
//
// Query: ?parent_id=<QB id>  or  ?parent=<name>
const DAILY_RATE_TZS = 12500;
app.get('/api/customer-migration-plan', async (req, res) => {
  try {
    const parentName = (req.query.parent || '').toString().trim();
    const parentId = (req.query.parent_id || '').toString().trim();
    if (!parentName && !parentId) {
      return res.status(400).json({ error: 'parent=<name> or parent_id=<QB id> required' });
    }

    const qbFaultOf = (err) => {
      try {
        const body = err?.authResponse?.body || err?.response?.body || '';
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return parsed?.Fault?.Error?.[0]?.Detail || parsed?.Fault?.Error?.[0]?.Message || null;
      } catch { return null; }
    };
    const escSql = (s) => String(s).replace(/'/g, "''");

    // 1. Resolve parent — same logic as /api/customer-tree.
    let parent;
    if (parentId) {
      const r = await qbQuery(`SELECT * FROM Customer WHERE Id = '${escSql(parentId)}'`);
      parent = r.QueryResponse?.Customer?.[0];
    } else {
      const nEsc = escSql(parentName);
      try {
        const q1 = await qbQuery(
          `SELECT * FROM Customer WHERE FullyQualifiedName = '${nEsc}' OR DisplayName = '${nEsc}' MAXRESULTS 5`,
        );
        parent = q1.QueryResponse?.Customer?.[0];
      } catch { /* fall through */ }
      if (!parent) {
        try {
          const q = await qbQuery(`SELECT * FROM Customer WHERE FullyQualifiedName = '${nEsc}' MAXRESULTS 1`);
          parent = q.QueryResponse?.Customer?.[0];
        } catch { /* ignore */ }
      }
      if (!parent) {
        try {
          const q = await qbQuery(`SELECT * FROM Customer WHERE DisplayName = '${nEsc}' MAXRESULTS 1`);
          parent = q.QueryResponse?.Customer?.[0];
        } catch { /* ignore */ }
      }
    }
    if (!parent) {
      return res.status(404).json({ error: `customer not found: ${parentName || parentId}` });
    }

    // 2. Children walk (Job=true, page + client-side filter by ParentRef.value).
    const children = [];
    {
      let start = 1;
      for (let i = 0; i < 10; i++) {
        const q = await qbQuery(
          `SELECT * FROM Customer WHERE Job = true STARTPOSITION ${start} MAXRESULTS 1000`,
        );
        const list = q.QueryResponse?.Customer || [];
        for (const c of list) {
          if (String(c.ParentRef?.value || '') === String(parent.Id)) children.push(c);
        }
        if (list.length < 1000) break;
        start += 1000;
      }
    }
    const allCustomers = [parent, ...children];

    // 3. Per-customer migration plan.
    const todayISO = new Date().toISOString().slice(0, 10);
    const todayDate = new Date(todayISO + 'T00:00:00Z');
    const addDays = (isoDate, days) => {
      const d = new Date(isoDate + 'T00:00:00Z');
      d.setUTCDate(d.getUTCDate() + Math.floor(days));
      return d.toISOString().slice(0, 10);
    };
    const daysBetween = (aISO, bISO) => {
      const a = new Date(aISO + 'T00:00:00Z').getTime();
      const b = new Date(bISO + 'T00:00:00Z').getTime();
      return Math.round((b - a) / 86400000);
    };
    const num = (v) => Number(v || 0);
    const invShape = (inv) => ({
      qb_id: inv.Id,
      doc_number: inv.DocNumber || null,
      txn_date: inv.TxnDate || null,
      due_date: inv.DueDate || null,
      amount: num(inv.TotalAmt),
      balance: num(inv.Balance),
    });
    const estShape = (e) => ({
      qb_id: e.Id,
      doc_number: e.DocNumber || null,
      txn_date: e.TxnDate || null,
      expiration_date: e.ExpirationDate || null,
      total_amt: num(e.TotalAmt),
    });
    const payShape = (p) => ({
      qb_id: p.Id,
      txn_date: p.TxnDate || null,
      total_amt: num(p.TotalAmt),
      unapplied_amt: num(p.UnappliedAmt),
      payment_ref_num: p.PaymentRefNum || null,
    });

    const buildPlan = async (c) => {
      const idEsc = escSql(c.Id);
      const wrap = async (sql) => {
        try { return await qbQuery(sql); }
        catch (e) { return { _err: e.message, _fault: qbFaultOf(e), _sql: sql }; }
      };
      const [invR, payR, estR] = await Promise.all([
        wrap(`SELECT * FROM Invoice WHERE CustomerRef = '${idEsc}' MAXRESULTS 1000`),
        wrap(`SELECT * FROM Payment WHERE CustomerRef = '${idEsc}' MAXRESULTS 1000`),
        wrap(`SELECT * FROM Estimate WHERE CustomerRef = '${idEsc}' MAXRESULTS 1000`),
      ]);
      const invoices = invR.QueryResponse?.Invoice || [];
      const payments = payR.QueryResponse?.Payment || [];
      const estimates = estR.QueryResponse?.Estimate || [];

      const errors = [invR, payR, estR].filter((x) => x._err)
        .map((x) => ({ sql: x._sql, err: x._err, fault: x._fault }));

      const contract_amount = estimates.reduce((s, e) => s + num(e.TotalAmt), 0);
      const total_paid = payments.reduce((s, p) => s + num(p.TotalAmt), 0);
      const remaining_on_contract = Math.max(0, contract_amount - total_paid);

      // Categorize invoices per Frank's rules (fix 2026-07-08 after Frappe
      // engineer diagnosed the empty moved_forward bucket).
      //
      // "Moved forward" (kusogeza mbele) = officer deferred an unpaid
      // installment. The TxnDate stays at the original scheduled day; the
      // DueDate gets pushed to the end of the schedule (or beyond). So the
      // UNIQUE signal is DueDate > TxnDate (the gap). It's the ONLY thing
      // that changes when an invoice is moved.
      //
      // Normal invoices (including legit end-of-contract ones landing in
      // 2027 when a 397-day schedule runs there) have DueDate == TxnDate.
      // "Future date" alone doesn't identify a moved-forward invoice.
      //
      // Compute earliest_txn first so we can compute original_end_date
      // (loan_start + contract_amount/daily_rate - 1 day) as a corroborating
      // second signal: any unpaid invoice with DueDate > original_end_date
      // has been pushed past the original contract end.
      let earliest_txn = null;
      for (const inv of invoices) {
        const t = inv.TxnDate || null;
        if (t && (!earliest_txn || t < earliest_txn)) earliest_txn = t;
      }
      const contract_days = contract_amount > 0
        ? Math.floor(contract_amount / DAILY_RATE_TZS)
        : 0;
      const original_end_date = (earliest_txn && contract_days > 0)
        ? (() => {
            const d = new Date(earliest_txn + 'T00:00:00Z');
            d.setUTCDate(d.getUTCDate() + Math.max(0, contract_days - 1));
            return d.toISOString().slice(0, 10);
          })()
        : null;

      const real_overdue = [];
      const moved_forward = [];
      const penalty = [];
      for (const inv of invoices) {
        const shape = invShape(inv);
        const bal = shape.balance;
        const amt = shape.amount;
        const txn = shape.txn_date; // 'YYYY-MM-DD' or null
        const due = shape.due_date; // 'YYYY-MM-DD' or null — DO NOT fallback

        if (bal <= 0) continue; // paid/void — no bucket needed

        // Penalty: amount != daily_rate AND > daily_rate. Categorize FIRST
        // (Frank's rule: penalties split from overdue for record-keeping).
        if (amt !== DAILY_RATE_TZS && amt > DAILY_RATE_TZS) {
          penalty.push(shape);
          continue;
        }
        // Moved forward — the UNIQUE signal per Frappe engineer:
        //   Primary : DueDate > TxnDate  (the gap is the fingerprint)
        //   Backup  : DueDate > original_end_date (pushed past contract end)
        // Either signal marks it as moved-forward, even if DueDate <= today
        // (a deferred invoice whose new date has ALSO passed stays labeled
        // moved-forward, not overdue — Frank preserves the deferral history).
        const isMovedForward =
          (txn && due && due > txn) ||
          (original_end_date && due && due > original_end_date);
        if (isMovedForward) {
          moved_forward.push(shape);
          continue;
        }
        // Real overdue — a normal scheduled invoice whose scheduled day
        // already passed unpaid. Requires DueDate<=today AND it wasn't
        // moved (handled above).
        if (due && due <= todayISO) {
          real_overdue.push(shape);
          continue;
        }
        // else: unpaid future-dated invoice (normal, not yet due) — no bucket.
      }

      const real_overdue_sum = real_overdue.reduce((s, i) => s + i.balance, 0);
      const moved_forward_sum = moved_forward.reduce((s, i) => s + i.balance, 0);
      const penalty_sum = penalty.reduce((s, i) => s + i.balance, 0);

      const loan_start_date = earliest_txn;
      const daysPaid = total_paid / DAILY_RATE_TZS;
      const paid_up_to_date = loan_start_date ? addDays(loan_start_date, daysPaid) : null;
      const planned_overdue_days = paid_up_to_date ? Math.max(0, daysBetween(paid_up_to_date, todayISO)) : null;
      const planned_overdue_amount = planned_overdue_days != null ? planned_overdue_days * DAILY_RATE_TZS : null;

      return {
        customer_id: c.Id,
        customer_name: c.FullyQualifiedName || c.DisplayName,
        active: c.Active,
        job: c.Job,
        qb_customer_balance: num(c.Balance),
        qb_customer_balance_with_jobs: num(c.BalanceWithJobs),

        contract_amount,
        total_paid,
        remaining_on_contract,

        daily_rate: DAILY_RATE_TZS,
        loan_start_date,
        paid_up_to_date,
        today: todayISO,

        // Sanity-check figures — should approximately equal real_overdue_sum
        // when the customer is on a strict daily schedule. When they diverge
        // significantly, moved_forward / penalty invoices are in play.
        planned_overdue_days,
        planned_overdue_amount,

        // Frappe copies each of these AT THEIR REAL DATES:
        real_overdue_invoices: real_overdue,
        real_overdue_sum,

        moved_forward_invoices: moved_forward,
        moved_forward_sum,

        penalty_invoices: penalty,
        penalty_sum,

        // Raw source records — Frappe can reference if needed.
        estimates: estimates.map(estShape),
        payments_count: payments.length,
        payments_sample: payments.slice(0, 5).map(payShape),
        invoices_total_count: invoices.length,

        ...(errors.length ? { errors } : {}),
      };
    };

    const migration_plans = [];
    for (const c of allCustomers) {
      const plan = await buildPlan(c);
      migration_plans.push(plan);
    }

    res.json({
      asOf: new Date().toISOString(),
      today: todayISO,
      parent_id: parent.Id,
      parent_name: parent.FullyQualifiedName || parent.DisplayName,
      customer_count: allCustomers.length,
      daily_rate: DAILY_RATE_TZS,
      migration_plans,
    });
  } catch (err) {
    const fault = (() => {
      try {
        const body = err?.authResponse?.body || err?.response?.body || '';
        const parsed = typeof body === 'string' ? JSON.parse(body) : body;
        return parsed?.Fault?.Error?.[0]?.Detail || parsed?.Fault?.Error?.[0]?.Message || null;
      } catch { return null; }
    })();
    console.error('[GET /api/customer-migration-plan]', err.message, 'fault=', fault);
    res.status(500).json({
      error: err.message,
      qb_fault_detail: fault,
      intuit_tid: err.intuit_tid,
    });
  }
});

// /arrears/by-customer — ALL customers with their totals aggregated.
// One request returns every customer that has open arrears, with their
// combined outstanding balance across all open invoices — no per-invoice
// noise, no pagination on the caller's side. Sorted by open_balance desc.
//
// Frank's use case: `list of all the arrears customers already their
// invoice total calculated all together` — 2,965 rows total, one round trip.
//
// Query:
//   ?asOf=YYYY-MM-DD        (default today)
//   &excludeToday=true      (default false)
//   &branch=<exact>         (optional filter, exact lowercase branch match)
app.get('/arrears/by-customer', async (req, res) => {
  try {
    const asOf = (req.query.asOf || new Date().toISOString().slice(0, 10)).toString();
    const excludeToday = req.query.excludeToday === '1' || req.query.excludeToday === 'true';
    const dueOp = excludeToday ? '<' : '<=';
    const branchFilter = (req.query.branch || '').toString().toLowerCase();

    const customerMap = await getCustomerPathMap();

    const PAGE = 1000;
    let startPos = 1;
    const perCustomer = new Map();
    let grandTotal = 0;
    let scannedInvoices = 0;
    while (startPos < 200_000) {
      const sql =
        `SELECT Id, DocNumber, TxnDate, DueDate, Balance, TotalAmt, CustomerRef, CustomerMemo ` +
        `FROM Invoice WHERE Balance > '0' AND DueDate ${dueOp} '${asOf}' ` +
        `STARTPOSITION ${startPos} MAXRESULTS ${PAGE}`;
      const r = await qbQuery(sql);
      const invs = r.QueryResponse?.Invoice ?? [];
      if (!invs.length) break;
      for (const inv of invs) {
        scannedInvoices++;
        const customerId = String(inv.CustomerRef?.value ?? '');
        const customer =
          customerMap.get(customerId) || inv.CustomerRef?.name || '(unknown customer)';
        const parts = customer.split(':');
        const branch = parts[0] || '(unknown)';
        if (branchFilter && branch.toLowerCase() !== branchFilter) continue;
        const customerLeaf = parts[parts.length - 1] || customer;
        const balance = Number(inv.Balance ?? 0);
        const amount = Number(inv.TotalAmt ?? 0);
        const partial = balance !== amount;
        if (!perCustomer.has(customer)) {
          perCustomer.set(customer, {
            customerId,
            customer,
            customerLeaf,
            branch,
            invoices: 0,
            partial_invoices: 0,
            open_balance: 0,
            oldest_due: null,
            newest_due: null,
          });
        }
        const rec = perCustomer.get(customer);
        rec.invoices++;
        rec.open_balance += balance;
        if (partial) rec.partial_invoices++;
        if (!rec.oldest_due || (inv.DueDate && inv.DueDate < rec.oldest_due)) rec.oldest_due = inv.DueDate;
        if (!rec.newest_due || (inv.DueDate && inv.DueDate > rec.newest_due)) rec.newest_due = inv.DueDate;
        grandTotal += balance;
      }
      if (invs.length < PAGE) break;
      startPos += PAGE;
    }

    // Round totals + sort by open_balance descending
    const customers = Array.from(perCustomer.values())
      .map((c) => ({ ...c, open_balance: Math.round(c.open_balance * 100) / 100 }))
      .sort((a, b) => b.open_balance - a.open_balance);

    res.json({
      asOf,
      excludeToday,
      branch: branchFilter || null,
      total_customers: customers.length,
      total_invoices: scannedInvoices,
      total_open_balance: Math.round(grandTotal * 100) / 100,
      customers,
    });
  } catch (err) {
    console.error('[GET /arrears/by-customer]', err);
    res.status(500).json({ error: err.message, intuit_tid: err.intuit_tid });
  }
});

/**
 * /api/qb/activity — list QB Payments and CreditMemos in a time window.
 *
 * Used by the SaasAnt-vs-BRAIN comparison harness (tools/qb-activity.mjs) to
 * see exactly what each upload path created.
 *
 * ?kind=payment|credit_memo|all          (default all)
 *
 * Two filter axes (use one — sinceCreated is what you usually want):
 *   ?since=YYYY-MM-DD&until=YYYY-MM-DD   — Txn date window (what the operator
 *                                          claims the payment was made on)
 *   ?sinceCreated=ISO[&untilCreated=ISO] — when QB actually recorded the row
 *                                          (Metadata.CreateTime). This is the
 *                                          right filter for "what did SaasAnt
 *                                          add to QB since I ran the baseline"
 *
 * Returns Linked-Invoice info too so we can match each Payment to the
 * Invoice(s) it knocked down.
 */
app.get('/api/qb/activity', async (req, res) => {
  try {
    const since = (req.query.since || '').toString();
    const until = (req.query.until || '').toString();
    const sinceCreated = (req.query.sinceCreated || '').toString();
    const untilCreated = (req.query.untilCreated || '').toString();
    const kind = (req.query.kind || 'all').toString().toLowerCase();
    if (!since && !sinceCreated) {
      return res.status(400).json({ error: 'since=YYYY-MM-DD or sinceCreated=ISO required' });
    }

    const clauses = [];
    if (since) clauses.push(`TxnDate >= '${since}'`);
    if (until) clauses.push(`TxnDate <= '${until}'`);
    if (sinceCreated) clauses.push(`Metadata.CreateTime >= '${sinceCreated}'`);
    if (untilCreated) clauses.push(`Metadata.CreateTime <= '${untilCreated}'`);
    const dateClause = `WHERE ${clauses.join(' AND ')}`;

    const out = {
      since: since || null, until: until || null,
      sinceCreated: sinceCreated || null, untilCreated: untilCreated || null,
      payments: [], creditMemos: [],
    };

    if (kind === 'all' || kind === 'payment') {
      const r = await qbQuery(
        `SELECT * FROM Payment ${dateClause} ORDERBY TxnDate STARTPOSITION 1 MAXRESULTS 1000`,
      );
      const items = r.QueryResponse?.Payment ?? [];
      out.payments = items.map((p) => ({
        qbId: p.Id,
        txnDate: p.TxnDate,
        createTime: p.MetaData?.CreateTime,
        customer: { id: p.CustomerRef?.value, name: p.CustomerRef?.name },
        totalAmt: Number(p.TotalAmt ?? 0),
        privateNote: p.PrivateNote || '',
        depositTo: p.DepositToAccountRef?.name || '',
        linkedInvoices: (p.Line ?? []).flatMap((l) =>
          (l.LinkedTxn ?? [])
            .filter((t) => t.TxnType === 'Invoice')
            .map((t) => ({ invoiceId: t.TxnId, amount: Number(l.Amount ?? 0) })),
        ),
      }));
    }

    if (kind === 'all' || kind === 'credit_memo') {
      const r = await qbQuery(
        `SELECT * FROM CreditMemo ${dateClause} ORDERBY TxnDate STARTPOSITION 1 MAXRESULTS 1000`,
      );
      const items = r.QueryResponse?.CreditMemo ?? [];
      out.creditMemos = items.map((cm) => ({
        qbId: cm.Id,
        txnDate: cm.TxnDate,
        createTime: cm.MetaData?.CreateTime,
        customer: { id: cm.CustomerRef?.value, name: cm.CustomerRef?.name },
        totalAmt: Number(cm.TotalAmt ?? 0),
        privateNote: cm.PrivateNote || '',
        remaining: Number(cm.RemainingCredit ?? cm.TotalAmt ?? 0),
      }));
    }

    out.summary = {
      payments: { count: out.payments.length, total: out.payments.reduce((s, p) => s + p.totalAmt, 0) },
      creditMemos: { count: out.creditMemos.length, total: out.creditMemos.reduce((s, c) => s + c.totalAmt, 0) },
    };

    res.json(out);
  } catch (err) {
    console.error('[GET /api/qb/activity]', err);
    res.status(500).json({ error: err.message, intuit_tid: err.intuit_tid });
  }
});

app.get('/summary', async (req, res) => {
  try {
    const [inv, cust, pay, bill] = await Promise.all([
      qbQuery('SELECT COUNT(*) FROM Invoice'),
      qbQuery('SELECT COUNT(*) FROM Customer'),
      qbQuery('SELECT COUNT(*) FROM Payment'),
      qbQuery('SELECT COUNT(*) FROM Bill'),
    ]);
    res.json({
      invoices: inv.QueryResponse?.totalCount ?? 0,
      customers: cust.QueryResponse?.totalCount ?? 0,
      payments: pay.QueryResponse?.totalCount ?? 0,
      bills: bill.QueryResponse?.totalCount ?? 0,
    });
  } catch (err) {
    res.status(500).json({ error: err.message, intuit_tid: err.intuit_tid });
  }
});

// --- Google Sheets endpoints ---

app.get('/sheets', async (req, res) => {
  try {
    const files = await listSharedSheets();
    res.json({
      serviceAccount: serviceAccountEmail(),
      count: files.length,
      files,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/sheets/:id/meta', async (req, res) => {
  try {
    res.json(await sheetMetadata(req.params.id));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/sheets/:id', async (req, res) => {
  try {
    res.json(await readSheet(req.params.id, req.query.range));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/**
 * POST /api/admin/sort-sheet-by-date — one-time housekeeping after the
 * NMB CSV row-order incident. Sorts one tab by date col B with a backup
 * tab created first. Requires shared secret. Use ?dryRun=1 to inspect
 * without writing.
 *
 * Body: { sheet_id: "...", tab: "PASSED", date_col: 1 (optional) }
 */
app.post('/api/admin/sort-sheet-by-date', async (req, res) => {
  // Reuse the shared secret used by the worker / harness tools.
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { sheet_id, tab, date_col } = req.body ?? {};
    if (!sheet_id || !tab) return res.status(400).json({ error: 'sheet_id and tab required' });
    const out = await sortTabByDate(sheet_id, tab, {
      dryRun: req.query.dryRun === '1',
      dateColIndex: date_col != null ? Number(date_col) : 1,
    });
    if (out.error) return res.status(500).json(out);
    res.json(out);
  } catch (err) {
    console.error('[POST /api/admin/sort-sheet-by-date]', err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/admin/nmb-last-passed-date
 *
 * Returns the most recent date stamped in the NMB sheet's PASSED tab,
 * inspecting the last N (default 10) non-empty data rows of date column B.
 * Used by the eleganskyCrdb scraper to compute the gap of missing days
 * before pulling. Date col mirrors sortTabByDate's default (col B = idx 1).
 *
 * Auth: X-Report-Secret header (shared with sort-sheet-by-date).
 * Query: ?rows=N (1..50, default 10).
 * Response: { last_passed_date: "YYYY-MM-DD", rows_inspected, sample: [...] }.
 */
const NMB_PASSED_SHEET_ID = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek';
const NMB_PASSED_TAB = 'PASSED';
const CRDB_PASSED_SHEET_ID = '1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o';
const CRDB_PASSED_TAB = 'PASSED';

function parseSheetDateToYmd(txt) {
  const s = String(txt || '').trim();
  if (!s) return null;
  // "DD.MM.YYYY", "DD/MM/YYYY", or "DD-MM-YYYY" (NMB uses dots, CRDB uses slashes).
  let m = s.match(/^(\d{1,2})[./-](\d{1,2})[./-](\d{4})/);
  if (m) {
    const d = +m[1], mo = +m[2], y = +m[3];
    if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
      return `${y}-${String(mo).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    }
  }
  // "DD Mon YYYY"
  m = s.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]{3,9})[\s\-\/]+(\d{4})/);
  if (m) {
    const MONTHS = { jan:1, feb:2, mar:3, apr:4, may:5, jun:6, jul:7, aug:8, sep:9, oct:10, nov:11, dec:12 };
    const mo = MONTHS[m[2].slice(0,3).toLowerCase()];
    if (mo) return `${m[3]}-${String(mo).padStart(2,'0')}-${String(+m[1]).padStart(2,'0')}`;
  }
  // "YYYY-MM-DD ..."
  m = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})/);
  if (m) {
    return `${m[1]}-${String(+m[2]).padStart(2,'0')}-${String(+m[3]).padStart(2,'0')}`;
  }
  return null;
}

async function lastPassedDateHandler(sheetId, tab, label, req, res) {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const n = Math.min(50, Math.max(1, parseInt(req.query.rows, 10) || 10));
    const { values } = await readSheet(sheetId, `${tab}!B1:B999999`);
    if (!values || values.length < 2) {
      return res.status(404).json({ error: `${tab} tab empty or header-only` });
    }
    const dataRows = values
      .slice(1)
      .filter((r) => r && r[0] && String(r[0]).trim().length)
      .slice(-n);
    if (dataRows.length === 0) {
      return res.status(404).json({ error: 'no non-empty rows in date column' });
    }
    const parsed = [];
    for (const row of dataRows) {
      const ymd = parseSheetDateToYmd(row[0]);
      if (ymd) parsed.push({ raw: String(row[0]).trim(), ymd });
    }
    if (parsed.length === 0) {
      return res.status(422).json({
        error: 'no parseable dates in inspected rows',
        raw_samples: dataRows.map((r) => String(r[0]).slice(0, 60)),
      });
    }
    parsed.sort((a, b) => a.ymd.localeCompare(b.ymd));
    res.json({
      last_passed_date: parsed[parsed.length - 1].ymd,
      rows_inspected: dataRows.length,
      sample: parsed.slice(-5),
    });
  } catch (err) {
    console.error(`[GET /api/admin/${label}-last-passed-date]`, err);
    res.status(500).json({ error: err.message });
  }
}

app.get('/api/admin/nmb-last-passed-date', (req, res) =>
  lastPassedDateHandler(NMB_PASSED_SHEET_ID, NMB_PASSED_TAB, 'nmb', req, res),
);
app.get('/api/admin/crdb-last-passed-date', (req, res) =>
  lastPassedDateHandler(CRDB_PASSED_SHEET_ID, CRDB_PASSED_TAB, 'crdb', req, res),
);

/**
 * GET /api/admin/catchup-plan
 *
 * Read-only diagnostic. For each upload channel, returns the catchup plan
 * computed by payment-batches.js → computeCatchupPlan: the chronologically-
 * ordered list of (window, AS_OF, payment_date) fires needed to bring the
 * channel current with operator's strict 16:16-EAT business-day rule.
 *
 * Windows with zero matching sheet rows are pruned. Empty plan ⇒ no
 * catchup needed (marker already on today's EAT date).
 *
 * Auth: X-Report-Secret.
 */
const ALL_CHANNEL_SHEETS = [
  { channel: 'nmbnew',      sheetId: NMB_PASSED_SHEET_ID,  tab: NMB_PASSED_TAB },
  { channel: 'bank',        sheetId: CRDB_PASSED_SHEET_ID, tab: CRDB_PASSED_TAB },
  { channel: 'iphone_bank', sheetId: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED' },
  // SAVCOM tabs on the NMB / CRDB sheets — share sheetId, separate tab.
  { channel: 'nmbnew_sav',  sheetId: NMB_PASSED_SHEET_ID,  tab: 'PASSED_SAV_NMB' },
  { channel: 'bank_sav',    sheetId: CRDB_PASSED_SHEET_ID, tab: 'PASSED_SAV' },
];

/**
 * GET /api/admin/batch-summary?ids=uuid1,uuid2,uuid3
 *
 * Read-only diagnostic. Returns a small per-batch summary so we can verify
 * orchestrator outcomes via curl + shared secret (the existing /api/payment-
 * batches/:id endpoint requires a Supabase JWT). Pure SELECTs, no writes.
 */
app.get('/api/admin/sheet-row-dump', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const row = parseInt(req.query.row, 10);
    const channel = req.query.channel || 'nmbnew';
    const sheets = { nmbnew: { id: NMB_PASSED_SHEET_ID, tab: NMB_PASSED_TAB }, bank: { id: CRDB_PASSED_SHEET_ID, tab: CRDB_PASSED_TAB }, iphone_bank: { id: '1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ', tab: 'BANK_PASSED' } }[channel];
    if (!sheets || !row) return res.status(400).json({ error: 'channel + row required' });
    const { values } = await readSheet(sheets.id, `${sheets.tab}!A${row}:L${row+2}`);
    res.json({ row, channel, rows: values });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/sheet-ref-lookup', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const refs = String(req.query.refs || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (refs.length === 0) return res.status(400).json({ error: 'refs query param required' });
    const { values } = await readSheet(NMB_PASSED_SHEET_ID, `${NMB_PASSED_TAB}!A1:L200000`);
    const sheet = values || [];
    const out = [];
    // Strip N suffix from refs to match raw bank refs in sheet (which don't have channel suffix)
    const stripped = refs.map(r => r.endsWith('N') ? r.slice(0, -1) : r);
    for (let r = 0; r < refs.length; r++) {
      const exact = refs[r];
      const bare = stripped[r];
      for (let i = 1; i < sheet.length; i++) {
        // Refs may be in column G (idx 6), H (idx 7), or elsewhere — scan all cols
        for (let c = 0; c < sheet[i].length; c++) {
          const v = String(sheet[i][c] || '').trim();
          if (v === exact || v === bare) {
            out.push({
              ref: exact,
              row: i + 1,
              found_in_col: c,
              date_col_b: sheet[i][1],
              full_row: sheet[i].map((x) => String(x || '').slice(0, 60)),
            });
            i = sheet.length; // break outer
            break;
          }
        }
      }
    }
    res.json({ found: out });
  } catch (err) {
    console.error('[GET /api/admin/sheet-ref-lookup]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/batch-uploads-csv', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const id = String(req.query.id || '').trim();
    if (!id) return res.status(400).json({ error: 'id required' });
    const pool = (await import('./db/pool.js')).db();
    const r = (await pool.query(
      `SELECT kind, bank_ref, customer_name, invoice_no, amount, status
         FROM payment_uploads WHERE batch_id = $1::uuid ORDER BY kind, bank_ref, invoice_no`,
      [id],
    )).rows;
    res.type('text/csv');
    res.send('kind,bank_ref,customer_name,invoice_no,amount,status\n' +
      r.map((x) => `${x.kind},${x.bank_ref || ''},"${(x.customer_name || '').replace(/"/g,'""')}",${x.invoice_no || ''},${x.amount},${x.status}`).join('\n'));
  } catch (err) {
    console.error('[GET /api/admin/batch-uploads-csv]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/recent-batches', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const sinceMin = Math.min(720, Math.max(1, parseInt(req.query.since_min, 10) || 60));
    const pool = (await import('./db/pool.js')).db();
    const rows = (await pool.query(
      `SELECT id, channel, created_by, status, paid_count, unused_count, created_at, finalized_at, recalled_at, failure_reason
         FROM payment_batches WHERE created_at > now() - ($1::int || ' min')::interval
         ORDER BY created_at DESC`,
      [sinceMin],
    )).rows;
    res.json({ rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/admin/batch-summary', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const ids = String(req.query.ids || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (ids.length === 0) return res.status(400).json({ error: 'ids query param required (comma-separated UUIDs)' });
    if (ids.length > 50) return res.status(400).json({ error: 'max 50 ids per call' });
    const pool = (await import('./db/pool.js')).db();
    const rows = (await pool.query(
      `SELECT id, channel, created_by, status, paid_count, unused_count,
              failure_reason, created_at, finalized_at
         FROM payment_batches WHERE id = ANY($1::uuid[])
         ORDER BY created_at`,
      [ids],
    )).rows;
    const uploads = (await pool.query(
      `SELECT batch_id, kind, status, COUNT(*)::int AS n, COALESCE(SUM(amount),0)::float AS sum_amount
         FROM payment_uploads WHERE batch_id = ANY($1::uuid[])
         GROUP BY batch_id, kind, status ORDER BY batch_id, kind, status`,
      [ids],
    )).rows;
    const byBatch = {};
    for (const r of rows) byBatch[r.id] = { ...r, uploads: [] };
    for (const u of uploads) {
      if (byBatch[u.batch_id]) byBatch[u.batch_id].uploads.push({ kind: u.kind, status: u.status, n: u.n, sum_amount: u.sum_amount });
    }
    res.json({ batches: ids.map((id) => byBatch[id] || { id, missing: true }) });
  } catch (err) {
    console.error('[GET /api/admin/batch-summary]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/admin/catchup-plan', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const { computeCatchupPlan } = await import('./payment-batches.js');
    const nowUtcMs = Date.now();
    const out = { now_utc_iso: new Date(nowUtcMs).toISOString(), channels: {} };
    for (const { channel, sheetId, tab } of ALL_CHANNEL_SHEETS) {
      const { values } = await readSheet(sheetId, `${tab}!A1:L200000`);
      out.channels[channel] = computeCatchupPlan({ channel, sheet: values || [], nowUtcMs });
    }
    res.json(out);
  } catch (err) {
    console.error('[GET /api/admin/catchup-plan]', err);
    res.status(500).json({ error: err.message });
  }
});

// Worker tick wiring uses this to know when /payment-batches/start/:channel
// background work has fully completed — start endpoint returns 202 and runs
// in setImmediate, so the only way to detect completion is the channel lock
// release (which happens in the orchestrator's finally block).
app.get('/api/admin/auto-upload-lock-status', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) {
    return res.status(401).json({ error: 'unauthorized' });
  }
  try {
    const channel = String(req.query.channel || '').trim();
    if (!channel) return res.status(400).json({ error: 'channel query param required' });
    const pool = (await import('./db/pool.js')).db();
    const row = (await pool.query(
      `SELECT channel, holder, locked_at FROM auto_upload_locks WHERE channel=$1`,
      [channel],
    )).rows[0] || null;
    res.json({ channel, locked: !!row, holder: row?.holder || null, locked_at: row?.locked_at || null });
  } catch (err) {
    console.error('[GET /api/admin/auto-upload-lock-status]', err);
    res.status(500).json({ error: err.message });
  }
});

// Officer-coverage analyzer: breaks down QB Payments for a TxnDate into
// 3 buckets so we can SEE where money goes after "officer-reports collection":
//   in_listed: payment hit a customer mapped to one of the officers
//               currently displayed by /officer-reports (the 11-ish visible)
//   in_other:  payment hit a customer mapped to an officer NOT in the list
//               (excluded per project_officer_report_exclusions, or just not
//                rendered yet)
//   unmapped:  payment hit a customer with no customer_officer_map entry
//
// Pass ?date=YYYY-MM-DD (defaults to today EAT). Defaults the "displayed
// officers" list to the 10 customer-IDs from project memory; pass
// ?display=id1,id2,... to override.
app.get('/api/admin/officer-coverage', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    let date = String(req.query.date || '').trim();
    if (!date) {
      const d = new Date(Date.now() + 3 * 60 * 60 * 1000);
      date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    // Page through QB Payments for the date and group by customer.
    const payments = [];
    let start = 1;
    const pageSize = 200;
    while (true) {
      const sql = `SELECT Id, TotalAmt, TxnDate, CustomerRef, PrivateNote FROM Payment WHERE TxnDate = '${date}' STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
      const j = await qbQuery(sql);
      const rows = (j?.QueryResponse?.Payment) || [];
      payments.push(...rows);
      if (rows.length < pageSize) break;
      start += pageSize;
      if (start > 5000) break;
    }
    const byCustomer = {};
    for (const p of payments) {
      const cid = p?.CustomerRef?.value || 'unknown';
      const amt = Number(p?.TotalAmt || 0);
      if (!byCustomer[cid]) byCustomer[cid] = { customer_id: cid, n: 0, total: 0 };
      byCustomer[cid].n += 1;
      byCustomer[cid].total += amt;
    }
    const customerIds = Object.keys(byCustomer);

    // Look up officer mapping for those customers.
    const pool = (await import('./db/pool.js')).db();
    const mapRows = (await pool.query(
      `SELECT customer_id, officer_id, officer_name FROM customer_officer_map WHERE customer_id = ANY($1::text[])`,
      [customerIds],
    )).rows;
    const officerByCustomer = {};
    for (const r of mapRows) officerByCustomer[r.customer_id] = r;

    // Pull what /officer-reports actually shows so we can flag "in_listed".
    const todayRows = (await pool.query(
      `SELECT DISTINCT officer_id FROM customer_officer_map`,
    )).rows;
    // The actual "displayed" set is whatever /officer-reports/today's per_officer returns.
    // Fetch it for the same date so the 3-way split matches what the dashboard shows.
    let displayedOfficerIds = new Set();
    try {
      const orRes = await fetch(`http://127.0.0.1:${process.env.PORT || 3000}/api/officer-reports/today`, {
        headers: { 'X-Report-Secret': secret },
      });
      if (orRes.ok) {
        const oj = await orRes.json();
        for (const po of (oj?.per_officer || [])) {
          if (po?.officer_id) displayedOfficerIds.add(String(po.officer_id));
        }
      }
    } catch (e) {
      // fallthrough: empty set → everything mapped lands in 'in_other'
    }

    // Aggregate
    const buckets = {
      in_listed: { n_payments: 0, n_customers: 0, total: 0, sample: [] },
      in_other:  { n_payments: 0, n_customers: 0, total: 0, sample: [] },
      unmapped:  { n_payments: 0, n_customers: 0, total: 0, sample: [] },
    };
    for (const cid of customerIds) {
      const cust = byCustomer[cid];
      const off = officerByCustomer[cid];
      let bucket;
      if (!off) bucket = 'unmapped';
      else if (displayedOfficerIds.has(String(off.officer_id))) bucket = 'in_listed';
      else bucket = 'in_other';
      buckets[bucket].n_payments += cust.n;
      buckets[bucket].n_customers += 1;
      buckets[bucket].total += cust.total;
      if (buckets[bucket].sample.length < 5) {
        buckets[bucket].sample.push({
          customer_id: cid,
          officer_id: off?.officer_id || null,
          officer_name: off?.officer_name || null,
          n: cust.n,
          total: cust.total,
        });
      }
    }
    res.json({
      txn_date: date,
      qb_payments_total: payments.length,
      qb_amount_total: payments.reduce((a, p) => a + Number(p?.TotalAmt || 0), 0),
      displayed_officers_count: displayedOfficerIds.size,
      buckets,
    });
  } catch (err) {
    console.error('[GET /api/admin/officer-coverage]', err);
    res.status(500).json({ error: err.message });
  }
});

// QB health check: query QB directly for today's Payments, group by
// DepositToAccountRef, sum totals. Lets us reconcile what we INTENDED
// to push (BRAIN's payment_uploads with status='created') vs what QB
// ACTUALLY shows. A big delta = double-pushes or push failures.
//
// Pass ?date=YYYY-MM-DD (defaults to today EAT). Optionally ?accounts=1
// to also dump the chart of accounts (bank/asset/liability entries).
app.get('/api/admin/qb-health-check', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    let date = String(req.query.date || '').trim();
    if (!date) {
      // Default to today EAT.
      const nowMs = Date.now();
      const eatMs = nowMs + 3 * 60 * 60 * 1000;
      const d = new Date(eatMs);
      date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
    const includeAccounts = String(req.query.accounts || '').trim() === '1';

    // Page through QB Payments for the requested TxnDate.
    const payments = [];
    let start = 1;
    const pageSize = 200;
    while (true) {
      const sql = `SELECT Id, TotalAmt, TxnDate, DepositToAccountRef, CustomerRef, PaymentRefNum FROM Payment WHERE TxnDate = '${date}' STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
      const j = await qbQuery(sql);
      const rows = (j?.QueryResponse?.Payment) || [];
      payments.push(...rows);
      if (rows.length < pageSize) break;
      start += pageSize;
      if (start > 5000) break; // safety rail
    }

    // Aggregate by DepositToAccountRef.
    const byAccount = {};
    let grandTotal = 0;
    for (const p of payments) {
      const acctId = p?.DepositToAccountRef?.value || 'UNDEPOSITED';
      const acctName = p?.DepositToAccountRef?.name || 'Undeposited Funds';
      const key = `${acctId} | ${acctName}`;
      if (!byAccount[key]) byAccount[key] = { account_id: acctId, account_name: acctName, n: 0, total: 0 };
      byAccount[key].n += 1;
      byAccount[key].total += Number(p?.TotalAmt || 0);
      grandTotal += Number(p?.TotalAmt || 0);
    }

    const out = {
      qb_txn_date: date,
      qb_payments_count: payments.length,
      qb_payments_total: grandTotal,
      qb_by_account: Object.values(byAccount).sort((a, b) => b.total - a.total),
    };

    if (includeAccounts) {
      const acctsJ = await qbQuery(`SELECT Id, Name, AccountType, AccountSubType, CurrentBalance, Active FROM Account WHERE Active = true MAXRESULTS 200`);
      out.qb_chart_of_accounts = (acctsJ?.QueryResponse?.Account) || [];
    }

    res.json(out);
  } catch (err) {
    console.error('[GET /api/admin/qb-health-check]', err);
    res.status(500).json({ error: err.message });
  }
});

// NMB-pull coordination — worker on Render (statement-pull) signals the
// hosted NMB POC service (nmb-live-pull) to fire an immediate pull cycle
// at scheduled tick time. The POC normally pulls every 5 min on its own;
// these endpoints let scheduled ticks bypass the 5-min cadence and get
// a fresh pull right before payments fire.
//
// State stored in app_settings:
//   nmb_pull_requested_at   ISO timestamp — worker sets this on /request
//   nmb_pull_completed_at   ISO timestamp — POC sets this on /complete
//   nmb_pull_result_json    JSON          — POC's pull result (passed/skipped/failed counts)
//
// A request is "pending" when requested_at > completed_at (lexicographic
// ISO 8601 string compare is fine here since both come from the same
// clock and never go backwards).
app.post('/api/nmb-pull/request', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_requested_at', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [now],
    );
    // Clear completed flag so polling sees the new request as pending.
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_completed_at', '')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_result_json', '')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );
    res.json({ ok: true, requested_at: now });
  } catch (err) {
    console.error('[POST /api/nmb-pull/request]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/nmb-pull/state', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const rows = (await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('nmb_pull_requested_at','nmb_pull_completed_at','nmb_pull_result_json','nmb_pull_last_ok_completed_at')`,
    )).rows;
    const m = {};
    for (const r of rows) m[r.key] = r.value;
    const requested = m.nmb_pull_requested_at || '';
    const completed = m.nmb_pull_completed_at || '';
    const pending = !!requested && requested > completed;
    let result = null;
    if (m.nmb_pull_result_json) {
      try { result = JSON.parse(m.nmb_pull_result_json); } catch { result = null; }
    }
    res.json({
      requested_at: requested || null,
      completed_at: completed || null,
      last_ok_completed_at: m.nmb_pull_last_ok_completed_at || null,
      pending,
      result,
    });
  } catch (err) {
    console.error('[GET /api/nmb-pull/state]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/nmb-pull/complete', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const now = new Date().toISOString();
    const result = req.body || {};
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_completed_at', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [now],
    );
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_result_json', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(result)],
    );
    // Fix #6 (Frank 2026-06-29): also update updated_at so monitoring
    // queries against app_settings.updated_at reflect the actual last-write
    // time. Without this clause, app_settings rows kept their original
    // INSERT time forever even though VALUE updated every cycle — making
    // last_ok_completed_at LOOK frozen at June 26 when it was actually
    // current (today's value was correct, only the column timestamp lied).
    if (result && result.ok === true) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('nmb_pull_last_ok_completed_at', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [now],
      );
    }
    res.json({ ok: true, completed_at: now });
  } catch (err) {
    console.error('[POST /api/nmb-pull/complete]', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// CRDB pull endpoints — mirror of NMB pull. Statement-pull worker POSTs
// /api/crdb-pull/request to signal the CRDB live-puller service; the puller
// polls /api/crdb-pull/state and completes with /api/crdb-pull/complete.
// Same 4-key state (requested_at / completed_at / result_json /
// last_ok_completed_at) — separate rows so both channels can be in flight
// independently.
// ───────────────────────────────────────────────────────────────────────────

app.post('/api/crdb-pull/request', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const now = new Date().toISOString();
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('crdb_pull_requested_at', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [now],
    );
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('crdb_pull_completed_at', '')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('crdb_pull_result_json', '')
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
    );
    res.json({ ok: true, requested_at: now });
  } catch (err) {
    console.error('[POST /api/crdb-pull/request]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/crdb-pull/state', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const rows = (await pool.query(
      `SELECT key, value FROM app_settings WHERE key IN ('crdb_pull_requested_at','crdb_pull_completed_at','crdb_pull_result_json','crdb_pull_last_ok_completed_at')`,
    )).rows;
    const m = {};
    for (const r of rows) m[r.key] = r.value;
    const requested = m.crdb_pull_requested_at || '';
    const completed = m.crdb_pull_completed_at || '';
    const pending = !!requested && requested > completed;
    let result = null;
    if (m.crdb_pull_result_json) {
      try { result = JSON.parse(m.crdb_pull_result_json); } catch { result = null; }
    }
    res.json({
      requested_at: requested || null,
      completed_at: completed || null,
      last_ok_completed_at: m.crdb_pull_last_ok_completed_at || null,
      pending,
      result,
    });
  } catch (err) {
    console.error('[GET /api/crdb-pull/state]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/crdb-pull/complete', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const now = new Date().toISOString();
    const result = req.body || {};
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('crdb_pull_completed_at', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [now],
    );
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('crdb_pull_result_json', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [JSON.stringify(result)],
    );
    if (result && result.ok === true) {
      await pool.query(
        `INSERT INTO app_settings (key, value) VALUES ('crdb_pull_last_ok_completed_at', $1)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [now],
      );
    }
    res.json({ ok: true, completed_at: now });
  } catch (err) {
    console.error('[POST /api/crdb-pull/complete]', err);
    res.status(500).json({ error: err.message });
  }
});

// ───────────────────────────────────────────────────────────────────────────
// NMB session cookies — Frank's paste-from-browser path to bypass OTP burns.
// Frank logs into NMB manually via his browser once (usually daily), copies
// the site's cookies as JSON, POSTs them here. The NMB puller reads them on
// startup and injects into Playwright, skipping the login+OTP flow entirely.
// After a successful login (either via cookies or fresh OTP), the puller
// POSTs its current cookies back so the next restart uses the freshest set.
// Storage: single row in app_settings under 'nmb_cookies_latest' — value is
// JSON { cookies: [...Playwright cookie objects], saved_at: iso, source: 'browser'|'puller' }.
// ───────────────────────────────────────────────────────────────────────────
app.post('/api/admin/nmb-cookies', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const cookies = Array.isArray(req.body?.cookies) ? req.body.cookies : null;
    if (!cookies || cookies.length === 0) {
      return res.status(400).json({ error: 'body must be { cookies: [...] } with at least one cookie' });
    }
    const source = String(req.body?.source || 'browser');
    const payload = JSON.stringify({
      cookies,
      saved_at: new Date().toISOString(),
      source,
      count: cookies.length,
    });
    const pool = (await import('./db/pool.js')).db();
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('nmb_cookies_latest', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [payload],
    );
    res.json({ ok: true, cookies_saved: cookies.length, source });
  } catch (err) {
    console.error('[POST /api/admin/nmb-cookies]', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/nmb-cookies', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const r = await pool.query(`DELETE FROM app_settings WHERE key='nmb_cookies_latest' RETURNING key`);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error('[DELETE /api/admin/nmb-cookies]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/internal/nmb-cookies', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const r = await pool.query(`SELECT value, updated_at FROM app_settings WHERE key='nmb_cookies_latest'`);
    if (!r.rows.length) return res.status(404).json({ error: 'no cookies stored yet' });
    let payload;
    try { payload = JSON.parse(r.rows[0].value); }
    catch (e) { return res.status(500).json({ error: 'stored cookies unparseable: ' + e.message }); }
    res.json({
      cookies: payload.cookies || [],
      saved_at: payload.saved_at,
      source: payload.source,
      db_updated_at: r.rows[0].updated_at,
    });
  } catch (err) {
    console.error('[GET /api/internal/nmb-cookies]', err);
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/admin/crdb-cookies', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const cookies = Array.isArray(req.body?.cookies) ? req.body.cookies : null;
    if (!cookies || cookies.length === 0) {
      return res.status(400).json({ error: 'body must be { cookies: [...] } with at least one cookie' });
    }
    const source = String(req.body?.source || 'worker');
    const payload = JSON.stringify({
      cookies,
      saved_at: new Date().toISOString(),
      source,
      count: cookies.length,
    });
    const pool = (await import('./db/pool.js')).db();
    await pool.query(
      `INSERT INTO app_settings (key, value) VALUES ('crdb_cookies_latest', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [payload],
    );
    res.json({ ok: true, cookies_saved: cookies.length, source });
  } catch (err) {
    console.error('[POST /api/admin/crdb-cookies]', err);
    res.status(500).json({ error: err.message });
  }
});

app.delete('/api/admin/crdb-cookies', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const r = await pool.query(`DELETE FROM app_settings WHERE key='crdb_cookies_latest' RETURNING key`);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) {
    console.error('[DELETE /api/admin/crdb-cookies]', err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/internal/crdb-cookies', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    const pool = (await import('./db/pool.js')).db();
    const r = await pool.query(`SELECT value, updated_at FROM app_settings WHERE key='crdb_cookies_latest'`);
    if (!r.rows.length) return res.status(404).json({ error: 'no cookies stored yet' });
    let payload;
    try { payload = JSON.parse(r.rows[0].value); }
    catch (e) { return res.status(500).json({ error: 'stored cookies unparseable: ' + e.message }); }
    res.json({
      cookies: payload.cookies || [],
      saved_at: payload.saved_at,
      source: payload.source,
      db_updated_at: r.rows[0].updated_at,
    });
  } catch (err) {
    console.error('[GET /api/internal/crdb-cookies]', err);
    res.status(500).json({ error: err.message });
  }
});

// Phone-side heartbeat — the OTP-relay phone APK POSTs this every ~60s
// with {phone, battery_pct}. m6pm-automation's phoneHeartbeatWatcher reads
// the table 15 min before every scheduled tick and SMSes the master admin
// (255752900450) if the phone is offline or battery <50%.
//
// Auth: PHONE_API_KEY (same key the notifications APK already uses).
// Table is created on first POST so no separate migration is needed.
app.post('/api/phone/heartbeat', requirePhoneKey, async (req, res) => {
  try {
    const phone = String(req.body?.phone || '').replace(/[^0-9]/g, '');
    const batteryPct = req.body?.battery_pct != null ? Number(req.body.battery_pct) : null;
    if (!phone) return res.status(400).json({ error: 'phone required (E.164 digits)' });
    if (batteryPct != null && (Number.isNaN(batteryPct) || batteryPct < 0 || batteryPct > 100)) {
      return res.status(400).json({ error: 'battery_pct must be 0-100' });
    }
    const pool = (await import('./db/pool.js')).db();
    await pool.query(
      `CREATE TABLE IF NOT EXISTS phone_heartbeats (
         id BIGSERIAL PRIMARY KEY,
         phone TEXT NOT NULL,
         battery_pct INT,
         received_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    await pool.query(
      `CREATE INDEX IF NOT EXISTS idx_phone_hb_phone_received ON phone_heartbeats(phone, received_at DESC)`,
    );
    await pool.query(
      `INSERT INTO phone_heartbeats (phone, battery_pct) VALUES ($1, $2)`,
      [phone, batteryPct],
    );
    res.json({ ok: true, received_at: new Date().toISOString() });
  } catch (err) {
    console.error('[POST /api/phone/heartbeat]', err);
    res.status(500).json({ error: err.message });
  }
});

// Read-only inspector for the master admin's latest heartbeat (debug + dashboard).
app.get('/api/phone/heartbeat', requireSecretOrJwt, async (_req, res) => {
  try {
    const pool = (await import('./db/pool.js')).db();
    const r = await pool.query(
      `SELECT phone, battery_pct, received_at FROM phone_heartbeats ORDER BY received_at DESC LIMIT 5`,
    ).catch(() => ({ rows: [] }));
    res.json({ heartbeats: r.rows });
  } catch (err) {
    console.error('[GET /api/phone/heartbeat]', err);
    res.status(500).json({ error: err.message });
  }
});

// 3-way reconciliation: compare BRAIN's payment_uploads vs QB's Payments
// vs the sheet's processed rows for a given TxnDate. Groups by channel
// suffix (N=nmbnew, B=bank, P=iphone_bank — detected from the trailing
// letter of payment_uploads.bank_ref AND QB Payment.PrivateNote).
//
// Pass ?date=YYYY-MM-DD (defaults to today EAT). Returns three side-by-
// side totals per channel suffix so any drift is obvious at a glance.
app.get('/api/admin/three-way-recon', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  try {
    let date = String(req.query.date || '').trim();
    if (!date) {
      const nowMs = Date.now();
      const d = new Date(nowMs + 3 * 60 * 60 * 1000);
      date = `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });

    const pool = (await import('./db/pool.js')).db();

    // ── 1. BRAIN side: sum payment_uploads.amount for the given TxnDate,
    //       grouped by channel + status. We use payment_batches.created_by
    //       to filter, but actually the cleanest is to grab the txnDate
    //       from payment_uploads.memo (kili1615:catchup_<asof>_business_<txn>)
    //       — easier to use batches whose tick_label ends with the date.
    //       Use a join: payment_uploads → payment_batches WHERE
    //       created_by LIKE '%_<date>' (catchup_<asof>_business_<txn> ends
    //       with txn_date).
    const brainRows = (await pool.query(
      `SELECT b.channel, u.status, u.kind, COUNT(*)::int AS n,
              COALESCE(SUM(u.amount), 0)::float AS total
         FROM payment_uploads u
         JOIN payment_batches b ON u.batch_id = b.id
        WHERE b.status = 'finalized'
          AND b.failure_reason IS DISTINCT FROM 'recall'
          AND (b.failure_reason IS NULL OR b.failure_reason NOT ILIKE '%dry_run%')
          AND b.created_by LIKE '%' || $1
        GROUP BY b.channel, u.status, u.kind`,
      [date],
    )).rows;
    const brainByChannel = { nmbnew: { N: 0, count: 0 }, bank: { B: 0, count: 0 }, iphone_bank: { P: 0, count: 0 } };
    for (const r of brainRows) {
      if (r.status !== 'created') continue; // count only QB-pushed
      const ch = r.channel;
      if (!brainByChannel[ch]) continue;
      const suf = { nmbnew: 'N', bank: 'B', iphone_bank: 'P' }[ch];
      brainByChannel[ch][suf] += Number(r.total);
      brainByChannel[ch].count += Number(r.n);
    }

    // ── 2. QB side: query QB for Payments WHERE TxnDate=?, group by suffix
    //       in PrivateNote (the last letter). Pages through.
    const qbPayments = [];
    let start = 1;
    const pageSize = 200;
    while (true) {
      const sql = `SELECT Id, TotalAmt, TxnDate, PrivateNote FROM Payment WHERE TxnDate = '${date}' STARTPOSITION ${start} MAXRESULTS ${pageSize}`;
      const j = await qbQuery(sql);
      const rows = (j?.QueryResponse?.Payment) || [];
      qbPayments.push(...rows);
      if (rows.length < pageSize) break;
      start += pageSize;
      if (start > 5000) break;
    }
    const qbBySuffix = { N: { total: 0, count: 0 }, B: { total: 0, count: 0 }, P: { total: 0, count: 0 }, other: { total: 0, count: 0 } };
    for (const p of qbPayments) {
      const note = String(p?.PrivateNote || '').trim();
      // Split on whitespace, take the FIRST token, then read its last char
      // (the channel suffix). This catches "MC213FLMN | ts" → "MC213FLMN" → "N".
      const firstToken = note.split(/\s/)[0] || '';
      const lastChar = firstToken.slice(-1).toUpperCase();
      const bucket = lastChar === 'N' || lastChar === 'B' || lastChar === 'P' ? lastChar : 'other';
      qbBySuffix[bucket].total += Number(p?.TotalAmt || 0);
      qbBySuffix[bucket].count += 1;
    }

    // ── 3. Compare side-by-side. For each channel suffix, show BRAIN
    //       claimed total vs QB actual total. Delta should be 0 if
    //       everything BRAIN pushed actually landed in QB with the
    //       matching TxnDate.
    const summary = [];
    for (const ch of ['nmbnew', 'bank', 'iphone_bank']) {
      const suf = { nmbnew: 'N', bank: 'B', iphone_bank: 'P' }[ch];
      const brainTotal = brainByChannel[ch][suf];
      const brainCount = brainByChannel[ch].count;
      const qbTotal = qbBySuffix[suf].total;
      const qbCount = qbBySuffix[suf].count;
      summary.push({
        channel: ch,
        suffix: suf,
        brain_count: brainCount,
        brain_total: brainTotal,
        qb_count: qbCount,
        qb_total: qbTotal,
        delta: qbTotal - brainTotal,
      });
    }
    const qbOther = qbBySuffix.other;
    res.json({
      txn_date: date,
      by_channel: summary,
      qb_total_all: qbPayments.reduce((acc, p) => acc + Number(p?.TotalAmt || 0), 0),
      qb_count_all: qbPayments.length,
      qb_other_suffix: { count: qbOther.count, total: qbOther.total, note: 'Payments whose PrivateNote did not end with N/B/P — possibly manual or non-BRAIN entries' },
    });
  } catch (err) {
    console.error('[GET /api/admin/three-way-recon]', err);
    res.status(500).json({ error: err.message });
  }
});

// Tightly-scoped admin tool: delete a dry-run batch + its uploads. Triple
// safety: refuses if the batch isn't marked as dry_run in failure_reason,
// or if ANY of its payment_uploads has a status that isn't 'dry_run'. So a
// real batch (status='created' / 'sent' / 'pending') will never get
// deleted even if the caller pastes the wrong UUID by accident.
app.post('/api/admin/delete-dry-run-batch/:id', async (req, res) => {
  const secret = process.env.STATEMENT_REPORT_SECRET;
  if (!secret || req.header('X-Report-Secret') !== secret) return res.status(401).json({ error: 'unauthorized' });
  const id = String(req.params.id || '').trim();
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    return res.status(400).json({ error: 'id must be a UUID' });
  }
  try {
    const pool = (await import('./db/pool.js')).db();
    // 1. Batch must exist and be a dry-run.
    const batchRow = (await pool.query(
      `SELECT id, channel, status, failure_reason, paid_count, unused_count
         FROM payment_batches WHERE id = $1`, [id])).rows[0];
    if (!batchRow) return res.status(404).json({ error: 'batch not found' });
    const isDryRun = String(batchRow.failure_reason || '').toLowerCase().includes('dry_run');
    if (!isDryRun) {
      return res.status(409).json({
        error: 'batch is not a dry-run (failure_reason does not contain "dry_run")',
        batch: batchRow,
      });
    }
    // 2. EVERY payment_upload row must have status='dry_run'. If ANY has a
    //    different status, refuse — that means a real QB push happened.
    const uploadStatuses = (await pool.query(
      `SELECT status, COUNT(*)::int AS n FROM payment_uploads WHERE batch_id = $1 GROUP BY status`,
      [id],
    )).rows;
    const nonDryRun = uploadStatuses.filter((r) => String(r.status) !== 'dry_run');
    if (nonDryRun.length > 0) {
      return res.status(409).json({
        error: 'batch has payment_uploads with non-dry_run status — refusing to delete',
        upload_statuses: uploadStatuses,
      });
    }
    // 3. Safe to delete. Uploads first (FK), then the batch row.
    const delUploads = await pool.query(`DELETE FROM payment_uploads WHERE batch_id = $1`, [id]);
    const delBatch = await pool.query(`DELETE FROM payment_batches WHERE id = $1`, [id]);
    res.json({
      ok: true,
      batch_id: id,
      channel: batchRow.channel,
      uploads_deleted: delUploads.rowCount,
      batch_deleted: delBatch.rowCount,
      pre_check: { upload_statuses: uploadStatuses, failure_reason: batchRow.failure_reason },
    });
  } catch (err) {
    console.error('[POST /api/admin/delete-dry-run-batch]', err);
    res.status(500).json({ error: err.message });
  }
});

// ── Serve the Vite dashboard (build output) ────────────────────────────────
// `web/dist/` is produced by `npm --prefix web run build`. In production we
// serve it as static assets at root, with SPA fallback so client-side routes
// like /statement-cycles work even when the user reloads.
const DASHBOARD_DIR = path.join(__dirname, '..', 'web', 'dist');
if (existsSync(DASHBOARD_DIR)) {
  console.log(`Dashboard: serving ${DASHBOARD_DIR}`);
  // /assets/* (hashed bundles) cache for 1 year — content-hashed so safe.
  // index.html and other shell files are NOT cached so each page load
  // discovers the new bundle hash without users needing to hard-refresh.
  // Frank 2026-06-13 incident: stale browser cache held a broken bundle
  // for hours after env-var fix.
  app.use(express.static(DASHBOARD_DIR, {
    index: false,
    maxAge: '1d',
    setHeaders(res, filePath) {
      if (filePath.endsWith('index.html') || filePath.endsWith('.html')) {
        res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      }
    },
  }));
  // SPA fallback — anything not already handled by an /api/* / OAuth / QB
  // legacy route gets the React shell so the client router can resolve.
  app.get(
    /^\/(?!api\/|connect$|callback$|disconnect$|invoices$|summary$|sheets(\/|$)).*/,
    (_req, res, next) => {
      const indexFile = path.join(DASHBOARD_DIR, 'index.html');
      if (!existsSync(indexFile)) return next();
      res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
      res.sendFile(indexFile);
    },
  );
} else {
  console.log(`Dashboard: ${DASHBOARD_DIR} not built — skipping static serve`);
}

app.listen(PORT, () => {
  console.log(`EleganskyBrain → http://localhost:${PORT}`);
  console.log(`Environment: ${QB_ENVIRONMENT}`);
  try {
    console.log(`Google Sheets service account: ${serviceAccountEmail()}`);
  } catch (e) {
    console.log(`Google Sheets: not configured (${e.message})`);
  }
  // Autonomous-Claude scheduler — 7 daily ticks, EAT-aware.
  // Set AGENT_SCHEDULER_ENABLED=false to disable (for staging / debug).
  startScheduler();
  // Limbo-batch recovery: release locks from any payment_batches stuck in
  // status='pending' with zero uploads. Runs once 5s after boot. Real
  // incident: NMB 91c0fa9e locked 418 refs after a killed --confirm.
  startLimboRecoveryOnBoot();
  // QB mirror CDC poller — keeps qb_invoices/qb_payments within ~30s of QB
  // so the reporting hot path can read from Postgres (sub-second) instead of
  // QB API (minutes). Set QB_MIRROR_POLLER_ENABLED=false to disable.
  if (process.env.QB_MIRROR_POLLER_ENABLED !== 'false') {
    startQbMirrorPoller();
  }
  // Phase 4 — daily_officer_snapshot refresher. Maintains pre-computed
  // per-(date, officer) aggregates so multi-day windows are instant.
  // Refreshes today every 30 s + previous 7 days on boot.
  if (process.env.QB_SNAPSHOT_REFRESHER_ENABLED !== 'false') {
    startSnapshotRefresher();
  }
  // Mega-report pre-warmer: keeps the 30 s response cache hot for the
  // most-common windows (today, yesterday, current week, last week) so
  // even the first dashboard visitor sees sub-second loads.
  if (process.env.MEGA_REPORT_PREWARMER_ENABLED !== 'false') {
    startMegaReportPrewarmer(getPrewarmHooks());
  }
  // Section A snapshotter: writes Postgres rows so the dashboard's
  // Section A cold-path is also a pure SELECT (not a live QB call).
  if (process.env.ACCT_BAL_SNAPSHOTTER_ENABLED !== 'false') {
    startAccountBalanceSnapshotter(computeAccountBalanceForSnapshot);
  }
  // Section B snapshotter: same idea for sheet totals (per-channel
  // PASSED/FAILED/UNUSED). After warmup, dashboard hot path for the
  // whole report is a pure Postgres SELECT.
  if (process.env.SHEET_TOTALS_SNAPSHOTTER_ENABLED !== 'false') {
    startSheetTotalsSnapshotter(computeSheetTotalsForSnapshot);
  }
});
