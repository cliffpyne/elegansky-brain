import 'dotenv/config';
import express from 'express';
import OAuthClient from 'intuit-oauth';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { listSharedSheets, sheetMetadata, readSheet, serviceAccountEmail } from './sheets.js';
import { mountCyclesApi } from './cycles.js';
import { mountSettingsApi } from './settings.js';

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

const TOKENS_FILE = 'tokens.json';
const API_BASE = QB_ENVIRONMENT === 'production'
  ? 'https://quickbooks.api.intuit.com'
  : 'https://sandbox-quickbooks.api.intuit.com';

function loadTokens() {
  if (!existsSync(TOKENS_FILE)) return null;
  const raw = readFileSync(TOKENS_FILE, 'utf-8').trim();
  if (!raw) return null;
  return JSON.parse(raw);
}

function saveTokens(token) {
  writeFileSync(TOKENS_FILE, JSON.stringify(token, null, 2));
}

const saved = loadTokens();
if (saved) {
  oauthClient.setToken(saved);
  console.log(`Loaded saved tokens for realm ${saved.realmId}`);
}

// CSRF state for OAuth — stored in-memory; for production-scale use Redis or signed cookies.
const pendingStates = new Set();

async function ensureFreshToken() {
  const tokens = loadTokens();
  if (!tokens) throw new Error('Not connected. Visit /connect first.');
  oauthClient.setToken(tokens);
  if (!oauthClient.isAccessTokenValid()) {
    const refreshed = await oauthClient.refresh();
    const next = refreshed.getJson();
    next.realmId = tokens.realmId;
    next.acquiredAt = Date.now();
    saveTokens(next);
    oauthClient.setToken(next);
  }
  return oauthClient.getToken();
}

async function qbQuery(sql) {
  await ensureFreshToken();
  const realmId = oauthClient.getToken().realmId;
  const url = `${API_BASE}/v3/company/${realmId}/query?query=${encodeURIComponent(sql)}&minorversion=73`;
  const response = await oauthClient.makeApiCall({
    url,
    headers: { Accept: 'application/json' },
  });
  return response.json;
}

const app = express();
app.set('trust proxy', true); // ngrok / Cloudflare / any reverse proxy
// Worker reports + screenshots can be a few hundred KB. Default 100kb won't fit.
app.use(express.json({ limit: '4mb' }));

// /api/cycles* — statement-pull dashboard data plane.
mountCyclesApi(app);
// /api/settings* — runtime toggles (loop kill switch).
mountSettingsApi(app);

// (legacy / homepage removed — the Vite dashboard now owns "/" and the React
// router handles all client-side paths. QB OAuth status moves to /api/qb/status
// for the dashboard to consume in a follow-up.)
app.get('/api/qb/status', (_req, res) => {
  const tokens = loadTokens();
  res.json({ connected: !!tokens, realmId: tokens?.realmId ?? null });
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
    saveTokens(token);
    console.log('✅ Tokens saved for realm', realmId);
    res.send(`<h1>✅ Connected</h1><p>Realm: <code>${realmId}</code></p><p><a href="/">Home</a></p>`);
  } catch (err) {
    console.error('OAuth callback error:', err);
    res.status(500).send(`<h1>OAuth error</h1><pre>${err.message}\n\n${err.stack}</pre><p><a href="/">Home</a></p>`);
  }
});

app.get('/disconnect', async (req, res) => {
  try { await oauthClient.revoke(); } catch (e) { /* token may already be invalid */ }
  if (existsSync(TOKENS_FILE)) unlinkSync(TOKENS_FILE);
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
