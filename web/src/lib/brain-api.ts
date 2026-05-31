/**
 * Typed client for BRAIN's /api/cycles endpoints. Auth is the current
 * Supabase session's access token (Bearer); the server verifies the JWT.
 */
import { supabase } from '@/lib/supabase';

export interface CycleStats {
  passed?: number;
  passed_sav?: number;
  passed_sav_nmb?: number;
  iphone_passed?: number;
  needs_review?: number;
  failed?: number;
  failed_nmb?: number;
  skipped?: number;
  total?: number;
  fuzzy_rescued?: number;
}

export interface CycleSummaryRow {
  id: string;
  reported_at: string;
  started_at: string;
  finished_at: string;
  duration_ms: number;
  worker_id: string;
  bank: 'NMB' | 'CRDB';
  status: 'ok' | 'fail';
  stats: CycleStats | null;
  processor_response: unknown;
  error_text: string | null;
  screenshot_count: number;
}

export interface CycleFull extends Omit<CycleSummaryRow, 'screenshot_count'> {
  screenshots: string[] | null;
}

export interface SummaryResp {
  last: Array<
    Omit<CycleSummaryRow, 'screenshot_count' | 'started_at' | 'finished_at' | 'worker_id'>
  >;
  counts_24h: Array<{ bank: 'NMB' | 'CRDB'; ok_24h: number; fail_24h: number }>;
}

const API_BASE = import.meta.env.VITE_BRAIN_API_BASE || '';

async function authed(path: string): Promise<Response> {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;
  return fetch(`${API_BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
  });
}

export async function listCycles(params: {
  limit?: number;
  offset?: number;
  bank?: 'NMB' | 'CRDB' | 'all';
  status?: 'ok' | 'fail' | 'all';
  since?: string;
} = {}): Promise<{
  cycles: CycleSummaryRow[];
  page?: { limit: number; offset: number; total: number; has_more: boolean };
}> {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.offset) q.set('offset', String(params.offset));
  if (params.bank && params.bank !== 'all') q.set('bank', params.bank);
  if (params.status && params.status !== 'all') q.set('status', params.status);
  if (params.since) q.set('since', params.since);
  const r = await authed(`/api/cycles?${q.toString()}`);
  if (!r.ok) throw new Error(`listCycles ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getCycle(id: string): Promise<{ cycle: CycleFull }> {
  const r = await authed(`/api/cycles/${id}`);
  if (!r.ok) throw new Error(`getCycle ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getSummary(): Promise<SummaryResp> {
  const r = await authed(`/api/cycles/_summary`);
  if (!r.ok) throw new Error(`getSummary ${r.status}: ${await r.text()}`);
  return r.json();
}

export function relativeTime(iso: string): string {
  const diff = (Date.now() - new Date(iso).getTime()) / 1000;
  if (diff < 60) return `${Math.round(diff)}s ago`;
  if (diff < 3600) return `${Math.round(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.round(diff / 3600)}h ago`;
  return `${Math.round(diff / 86400)}d ago`;
}

export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${(ms / 60_000).toFixed(1)}m`;
}

// ── Arrears (overdue invoices, replaces ARREAR.xls) ────────────────────
export interface ArrearRow {
  qbId: string;
  date: string;          // TxnDate YYYY-MM-DD
  dueDate: string;       // DueDate YYYY-MM-DD
  type: 'Invoice';
  no: string;            // DocNumber
  customer: string;      // BRANCH:LEADER:GROUP:CUSTOMER
  branch: string;        // first segment
  customerLeaf: string;  // last segment
  memo: string;
  balance: number;
  amount: number;
  status: 'overdue';
}

export interface ArrearsListResp {
  asOf: string;
  page: { start: number; pageSize: number; returned: number; nextStart: number | null };
  invoices: ArrearRow[];
}

export interface ArrearsSummaryResp {
  asOf: string;
  count: number;
  totalBalance: number;
  branches: Record<string, number>;
}

async function unauthed(path: string): Promise<Response> {
  // /arrears is currently on BRAIN's legacy path, not /api — same backend,
  // no auth wrapper. Once we move it under /api/* we'll switch to authed().
  return fetch(`${API_BASE}${path}`);
}

export async function listArrears(params: {
  pageSize?: number;
  start?: number;
  branch?: string;
  q?: string;
  asOf?: string;
} = {}): Promise<ArrearsListResp> {
  const qs = new URLSearchParams();
  if (params.pageSize) qs.set('pageSize', String(params.pageSize));
  if (params.start) qs.set('start', String(params.start));
  if (params.branch) qs.set('branch', params.branch);
  if (params.q) qs.set('q', params.q);
  if (params.asOf) qs.set('asOf', params.asOf);
  const r = await unauthed(`/arrears?${qs.toString()}`);
  if (!r.ok) throw new Error(`listArrears ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getArrearsSummary(params: { asOf?: string; branch?: string } = {}): Promise<ArrearsSummaryResp> {
  const qs = new URLSearchParams({ summary: '1' });
  if (params.asOf) qs.set('asOf', params.asOf);
  if (params.branch) qs.set('branch', params.branch);
  const r = await unauthed(`/arrears?${qs.toString()}`);
  if (!r.ok) throw new Error(`getArrearsSummary ${r.status}: ${await r.text()}`);
  return r.json();
}

export function formatTzs(n: number): string {
  if (!isFinite(n)) return '—';
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 }) + ' TZS';
}

// ── Settings (loop kill switch) ────────────────────────────────────────
export interface Setting {
  key: string;
  value: string;
  updated_at: string;
  updated_by: string | null;
}

export async function getSetting(key: string): Promise<Setting> {
  const r = await authed(`/api/settings/${encodeURIComponent(key)}`);
  if (!r.ok) throw new Error(`getSetting ${r.status}: ${await r.text()}`);
  const body = (await r.json()) as { setting: Setting };
  return body.setting;
}

export async function setSetting(key: string, value: string): Promise<Setting> {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;
  const r = await fetch(`${API_BASE}/api/settings/${encodeURIComponent(key)}`, {
    method: 'PUT',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({ value }),
  });
  if (!r.ok) throw new Error(`setSetting ${r.status}: ${await r.text()}`);
  const body = (await r.json()) as { setting: Setting };
  return body.setting;
}
