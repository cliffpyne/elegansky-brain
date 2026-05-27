import 'dotenv/config';
import express from 'express';
import OAuthClient from 'intuit-oauth';
import { readFileSync, writeFileSync, existsSync, unlinkSync } from 'node:fs';
import { randomBytes } from 'node:crypto';

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

app.get('/', (req, res) => {
  const tokens = loadTokens();
  const connected = !!tokens;
  res.send(`<!doctype html>
<html><head><meta charset="utf-8"><title>EleganskyBrain</title>
<style>body{font-family:system-ui;max-width:680px;margin:3rem auto;padding:0 1rem;line-height:1.6}
a.btn{display:inline-block;padding:.6rem 1.2rem;background:#0a5fdb;color:#fff;text-decoration:none;border-radius:6px;margin-right:.5rem}
a.btn.alt{background:#444}
code{background:#f4f4f4;padding:2px 6px;border-radius:4px}</style>
</head><body>
<h1>EleganskyBrain — BRAIN</h1>
<p>Status: <strong>${connected ? '🟢 Connected to QuickBooks' : '🔴 Not connected'}</strong></p>
${connected
  ? `<p>Realm: <code>${tokens.realmId}</code></p>
     <p><a class="btn" href="/invoices">View invoices</a>
        <a class="btn" href="/summary">Master summary</a>
        <a class="btn alt" href="/disconnect">Disconnect</a></p>`
  : `<p><a class="btn" href="/connect">Connect to QuickBooks</a></p>`}
</body></html>`);
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
    const result = await qbQuery('SELECT * FROM Invoice MAXRESULTS 1000');
    const invoices = result.QueryResponse?.Invoice ?? [];
    res.json({ count: invoices.length, invoices });
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

app.listen(PORT, () => {
  console.log(`EleganskyBrain → http://localhost:${PORT}`);
  console.log(`Environment: ${QB_ENVIRONMENT}`);
});
