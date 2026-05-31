// Shared helpers for the SaasAnt-vs-BRAIN comparison harness.
import { readFileSync, existsSync } from 'node:fs';

const BASE_DEFAULT = 'https://elegansky-brain.onrender.com';

export function brainBase() {
  return process.env.BRAIN_BASE || BASE_DEFAULT;
}

export function brainSecret() {
  // Order: env var, then /tmp/brain_secret cache. The cache is convenient on
  // the dev box where we keep the secret in a file; in CI/Render env wins.
  if (process.env.BRAIN_REPORT_SECRET) return process.env.BRAIN_REPORT_SECRET;
  if (process.env.STATEMENT_REPORT_SECRET) return process.env.STATEMENT_REPORT_SECRET;
  if (existsSync('/tmp/brain_secret')) return readFileSync('/tmp/brain_secret', 'utf8').trim();
  throw new Error('No BRAIN secret — set BRAIN_REPORT_SECRET or write to /tmp/brain_secret');
}

export async function brainGet(path, query = {}) {
  const url = new URL(path, brainBase());
  for (const [k, v] of Object.entries(query)) {
    if (v != null) url.searchParams.set(k, String(v));
  }
  const res = await fetch(url, {
    headers: { 'X-Report-Secret': brainSecret() },
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = { error: body }; }
  if (!res.ok) {
    const err = new Error(`GET ${path} → ${res.status}: ${json.error || body}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

export async function brainPost(path, payload) {
  const url = new URL(path, brainBase());
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Report-Secret': brainSecret(),
    },
    body: JSON.stringify(payload),
  });
  const body = await res.text();
  let json;
  try { json = JSON.parse(body); } catch { json = { error: body }; }
  if (!res.ok) {
    const err = new Error(`POST ${path} → ${res.status}: ${json.error || body}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }
  return json;
}

// Parse --flag=value style CLI args. Bare flags (no =) become { flag: true }.
export function parseArgs(argv) {
  const out = { _: [] };
  for (const a of argv.slice(2)) {
    if (a.startsWith('--')) {
      const eq = a.indexOf('=');
      if (eq > -1) out[a.slice(2, eq)] = a.slice(eq + 1);
      else out[a.slice(2)] = true;
    } else out._.push(a);
  }
  return out;
}

export function fmtMoney(n) {
  if (n == null) return '-';
  const v = Number(n) || 0;
  return v.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}
