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
import { db } from './db/pool.js';

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
  try {
    return await makeCall();
  } catch (err) {
    const status = err?.intuit_tid ? null : (err?.authResponse?.response?.status ?? err?.response?.status);
    const message = String(err?.message || '');
    const looks401 = status === 401 || /401/.test(message) || /HTTP Error/.test(message);
    if (!looks401) throw err;
    console.warn('[qb] 401 after token-check — forcing refresh and retrying once');
    const tokens = await loadTokens();
    if (!tokens) throw err;
    await refreshNow(tokens);
    return await makeCall();
  }
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
    const url = `${API_BASE}/v3/company/${realmId}/${resourcePath}?minorversion=73`;
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

/** Create a QB Payment for one bank-txn line against one invoice. */
async function qbCreatePayment({ customerId, invoiceQbId, amount, memo }) {
  const body = {
    CustomerRef: { value: String(customerId) },
    TotalAmt: Number(amount),
    PrivateNote: memo || undefined,
    Line: [{
      Amount: Number(amount),
      LinkedTxn: [{ TxnId: String(invoiceQbId), TxnType: 'Invoice' }],
    }],
  };
  const json = await qbPost('payment', body);
  return { id: json.Payment?.Id, response: json };
}

/** Create a QB Credit Memo (the "unused" side) for one bank-txn line. */
async function qbCreateCreditMemo({ customerId, amount, memo }) {
  const body = {
    CustomerRef: { value: String(customerId) },
    PrivateNote: memo || undefined,
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
mountPaymentBatchesApi(app, { qbCreatePayment, qbCreateCreditMemo, qbVoid, ensureQbConnected });

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
          `FROM Invoice WHERE Balance > '0' AND DueDate < '${asOf}' ` +
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
      `FROM Invoice WHERE Balance > '0' AND DueDate < '${asOf}' ` +
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

// ── Serve the Vite dashboard (build output) ────────────────────────────────
// `web/dist/` is produced by `npm --prefix web run build`. In production we
// serve it as static assets at root, with SPA fallback so client-side routes
// like /statement-cycles work even when the user reloads.
const DASHBOARD_DIR = path.join(__dirname, '..', 'web', 'dist');
if (existsSync(DASHBOARD_DIR)) {
  console.log(`Dashboard: serving ${DASHBOARD_DIR}`);
  app.use(express.static(DASHBOARD_DIR, { index: false, maxAge: '1d' }));
  // SPA fallback — anything not already handled by an /api/* / OAuth / QB
  // legacy route gets the React shell so the client router can resolve.
  app.get(
    /^\/(?!api\/|connect$|callback$|disconnect$|invoices$|summary$|sheets(\/|$)).*/,
    (_req, res, next) => {
      const indexFile = path.join(DASHBOARD_DIR, 'index.html');
      if (!existsSync(indexFile)) return next();
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
});
