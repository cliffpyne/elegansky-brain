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

async function authed(path: string, init?: RequestInit): Promise<Response> {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;
  const headers = new Headers(init?.headers);
  if (token) headers.set('authorization', `Bearer ${token}`);
  return fetch(`${API_BASE}${path}`, { ...init, headers });
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

export interface Heartbeat {
  worker_id: string;
  bank: 'NMB' | 'CRDB';
  cycle_started_at: string;
  step_num: number;
  current_step: string | null;
  last_seen: string;
  running_seconds: number;
  silent_seconds: number;
}

export async function listHeartbeats(): Promise<{ heartbeats: Heartbeat[] }> {
  const r = await authed(`/api/cycles/heartbeats`);
  if (!r.ok) throw new Error(`heartbeats ${r.status}: ${await r.text()}`);
  return r.json();
}

export interface PaymentBatchRow {
  id: string;
  created_at: string;
  finalized_at: string | null;
  recalled_at: string | null;
  rolled_back_at: string | null;
  status: 'pending' | 'finalized' | 'recalled' | 'rolled_back';
  sheet_id: string;
  sheet_tab: string;
  channel: string;
  paid_total: number | string;
  unused_total: number | string;
  sheet_total: number | string;
  paid_count: number;
  unused_count: number;
  created_by: string | null;
  recalled_by: string | null;
  failure_reason: string | null;
  invoice_snapshot_id?: string | null;
  txn_date?: string | null;
  logs?: BatchLogEntry[];
}

export interface BatchLogEntry {
  ts: string;
  level: 'info' | 'warn' | 'error';
  message: string;
  source: string;
  [extra: string]: unknown;
}

export interface InvoiceSnapshotSummary {
  id: string;
  as_of: string;
  captured_at: string;
  invoice_count: number;
  total_balance: number | string;
  date_range_header: string | null;
}

export interface InvoiceSnapshotRow {
  qbId: string;
  date: string;
  dueDate?: string;
  no: string;
  customer: string;
  memo?: string;
  balance: number;
  amount: number;
  status: string;
}

export interface SkippedDuplicateRow {
  bank_ref: string;
  customer_id: string;
  qb_id: string;
  qb_kind: 'payment' | 'credit_memo';
  qb_txn_date: string | null;
  found_at: string;
  found_by: string;
}

export interface PaymentUploadRow {
  id: string;
  batch_id: string;
  kind: 'payment' | 'credit_memo';
  bank_ref: string;
  customer_id: string | null;
  customer_name: string | null;
  invoice_qb_id: string | null;
  invoice_no: string | null;
  amount: number | string;
  memo: string | null;
  qb_id: string | null;
  status: 'created' | 'voided' | 'failed' | 'unmatched';
  failure_reason: string | null;
  created_at: string;
  voided_at: string | null;
}

export interface ArrearsSnapshotSummary {
  id: string;
  as_of: string;
  row_count: number;
  total_balance: number | string;
  created_at: string;
}

export async function listBatches(params: { limit?: number; status?: string } = {}): Promise<{ batches: PaymentBatchRow[] }> {
  const q = new URLSearchParams();
  if (params.limit) q.set('limit', String(params.limit));
  if (params.status && params.status !== 'all') q.set('status', params.status);
  const r = await authed(`/api/payment-batches?${q.toString()}`);
  if (!r.ok) throw new Error(`listBatches ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getBatch(id: string): Promise<{
  batch: PaymentBatchRow;
  uploads: PaymentUploadRow[];
  snapshot: ArrearsSnapshotSummary | null;
  invoice_snapshot: InvoiceSnapshotSummary | null;
  skipped_duplicates: SkippedDuplicateRow[];
}> {
  const r = await authed(`/api/payment-batches/${id}`);
  if (!r.ok) throw new Error(`getBatch ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getBatchInvoicesSnapshot(id: string): Promise<{
  snapshot: InvoiceSnapshotSummary & { data: InvoiceSnapshotRow[] };
}> {
  const r = await authed(`/api/payment-batches/${id}/invoices.json`);
  if (!r.ok) throw new Error(`getBatchInvoicesSnapshot ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function recallBatch(id: string, reason?: string): Promise<unknown> {
  const r = await authed(`/api/payment-batches/${id}/recall`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ reason: reason || 'admin recall from dashboard' }),
  });
  if (!r.ok) throw new Error(`recallBatch ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function fireCycle(bank: 'NMB' | 'CRDB'): Promise<{ ok: boolean; job: unknown }> {
  const r = await authed(`/api/cycles/fire`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ bank }),
  });
  if (!r.ok) throw new Error(`fireCycle ${r.status}: ${await r.text()}`);
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

// ─── Agent (autonomous Claude sessions) ─────────────────────────────────────
export interface AgentSessionRow {
  id: string;
  trigger: string;
  trigger_context: unknown;
  mode: 'plan' | 'execute';
  model: string;
  status: 'running' | 'completed' | 'paused' | 'aborted' | 'errored';
  summary: string | null;
  stats: Record<string, number> | null;
  input_tokens: string | number | null;
  output_tokens: string | number | null;
  cache_read_tokens: string | number | null;
  cache_write_tokens: string | number | null;
  cost_usd: string | null;
  started_at: string;
  ended_at: string | null;
}

export interface AgentSessionMessage {
  id: number;
  role: 'system' | 'user' | 'assistant' | 'tool';
  kind: string | null;
  payload: unknown;
  created_at: string;
}

export async function listAgentSessions(limit = 50): Promise<{ sessions: AgentSessionRow[] }> {
  const r = await authed(`/api/agent/sessions?limit=${limit}`);
  if (!r.ok) throw new Error(`listAgentSessions ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getAgentSession(
  id: string,
): Promise<{ session: AgentSessionRow; messages: AgentSessionMessage[] }> {
  const r = await authed(`/api/agent/sessions/${id}`);
  if (!r.ok) throw new Error(`getAgentSession ${r.status}: ${await r.text()}`);
  return r.json();
}

export interface AgentRunInput {
  trigger: string;
  triggerContext: unknown;
  mode: 'plan' | 'execute';
}

export async function fireAgent(input: AgentRunInput): Promise<{ ok: boolean; seed_session_id: string }> {
  const r = await authed(`/api/agent/run`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
  });
  if (!r.ok) throw new Error(`fireAgent ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function getAgentCostSummary(): Promise<{ days: Array<{ day: string; sessions: number; in_tok: string; out_tok: string; cache_read: string; cache_write: string; cost_usd: string }> }> {
  const r = await authed(`/api/agent/cost-summary`);
  if (!r.ok) throw new Error(`getAgentCostSummary ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── Agent scheduler toggle (dashboard button) ──────────────────────────────
export async function getSchedulerStatus(): Promise<{ enabled: boolean; env_master_switch: boolean; last_changed: string | null; last_changed_by: string | null }> {
  const r = await authed('/api/agent/scheduler');
  if (!r.ok) throw new Error(`getSchedulerStatus ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function setSchedulerEnabled(enabled: boolean): Promise<{ ok: boolean; enabled: boolean }> {
  const r = await authed('/api/agent/scheduler', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ enabled }),
  });
  if (!r.ok) throw new Error(`setSchedulerEnabled ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── Officer collections report ─────────────────────────────────────────────
export interface OfficerReportRow {
  officer_id: string;
  officer_name: string;
  total_invoice_amount: number;
  today_balance_remain: number;
  open_invoice_count: number;
  total_arrears: number;
  overdue_invoice_count: number;
  office_count: number;
  police_count: number;
  offline_count: number;
  offline_adjustment: number;
  open: number;
  collection: number;
  payment_count: number;
  dueopen: number;
  percent: number | null;
  status: 'good' | 'bad' | 'no_invoices';
}

export interface OfficerReportGrand {
  total_invoice_amount: number;
  today_balance_remain: number;
  total_arrears: number;
  offline_count: number;
  offline_adjustment: number;
  open: number;
  collection: number;
  dueopen: number;
  percent: number | null;
  status: 'good' | 'bad' | 'no_invoices';
}

export interface OfficerReport {
  date: string;
  per_officer: OfficerReportRow[];
  grand_total: OfficerReportGrand;
  fresh: {
    invoice_totals_pulled_at: string | null;
    offline_motos_pulled_at: string | null;
    arrears_pulled_at: string | null;
  };
}

export async function getOfficerReportToday(date?: string): Promise<OfficerReport> {
  const q = date ? `?date=${encodeURIComponent(date)}` : '';
  const r = await authed(`/api/officer-reports/today${q}`);
  if (!r.ok) throw new Error(`getOfficerReportToday ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function refreshOfficerInvoiceTotals(force = false): Promise<{ ok: boolean; started: boolean }> {
  const r = await authed('/api/officer-reports/refresh-invoice-totals', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  if (!r.ok) throw new Error(`refresh-invoice-totals ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function refreshOfficerArrears(force = false): Promise<{ ok: boolean; started: boolean }> {
  const r = await authed('/api/officer-reports/refresh-arrears', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ force }),
  });
  if (!r.ok) throw new Error(`refresh-arrears ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function refreshOfficerOfflineMotos(): Promise<{ ok: boolean; office_count: number; police_count: number; unresolved_office: number; unresolved_police: number }> {
  const r = await authed('/api/officer-reports/refresh-offline-motos', { method: 'POST' });
  if (!r.ok) throw new Error(`refresh-offline-motos ${r.status}: ${await r.text()}`);
  return r.json();
}

export async function rebuildOfficerMap(): Promise<{ ok: boolean; customers_mapped: number; distinct_officers: number }> {
  const r = await authed('/api/officer-reports/rebuild-map', { method: 'POST' });
  if (!r.ok) throw new Error(`rebuild-map ${r.status}: ${await r.text()}`);
  return r.json();
}

export interface KijichiToday {
  account_name: string;
  account_id: string | null;
  date: string;
  rows: number;
  total: number;
  note?: string;
}
export async function getKijichiToday(): Promise<KijichiToday> {
  const r = await authed('/api/officer-reports/kijichi-today');
  if (!r.ok) throw new Error(`kijichi-today ${r.status}: ${await r.text()}`);
  return r.json();
}

export interface SheetTotalsUploadDay {
  upload_day_start: string;
  by_channel: Array<{ channel: string; rows: number; total: number }>;
}
export async function getSheetTotalsUploadDay(): Promise<SheetTotalsUploadDay> {
  const r = await authed('/api/officer-reports/sheet-totals-uploadday');
  if (!r.ok) throw new Error(`sheet-totals-uploadday ${r.status}: ${await r.text()}`);
  return r.json();
}

export interface PaymentUploadsTotals {
  date: string;
  by_channel: Array<{
    channel: string;
    pushed_rows: number;
    pushed_amount: number;
    voided_rows: number;
    voided_amount: number;
    failed_rows: number;
    failed_amount: number;
    needs_saasant_rows: number;
    needs_saasant_amount: number;
  }>;
  grand_total: { pushed_rows: number; pushed_amount: number };
}
export async function getPaymentUploadsTodayTotals(): Promise<PaymentUploadsTotals> {
  const r = await authed('/api/payment-uploads/today-totals');
  if (!r.ok) throw new Error(`today-totals ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── Mega-Report (everything-report page) ──────────────────────────────────

export interface MegaReportWindow { from: string; to: string }
export interface MegaAccountBalance {
  parent_account: string;
  sub_accounts: string[];
  account_ids: Record<string, string>;
  opening_as_of: string;
  opening_balance: number | null;
  window: { from: string; to: string };
  payments_in_window: { total: number; count: number };
  expenses_in_window: { total: number; count: number };
  net_movement: number;
  closing_live: number | null;
}
export interface MegaChannelSection {
  passed: { rows: number; total: number };
  failed: { rows: number; total: number };
  extra_tabs: string[];
  extra: { rows: number; total: number };
  unused: {
    passed_rows: number; passed_total: number;
    failed_rows: number; failed_total: number;
    extra_rows: number; extra_total: number;
    total_rows: number; total_amount: number;
  };
}
export interface MegaSheetTotals {
  by_channel: Record<string, MegaChannelSection>;
  grand_passed_total: number;
  grand_failed_total: number;
  grand_unused_total: number;
}
export interface MegaOfficerRow {
  officer_id: string;
  officer_name: string;
  total_invoice_amount: number;
  today_balance_remain: number;
  open: number;
  adjustment: number;
  motos_office: number;
  motos_police: number;
  collection: number;
  collected: number;
  pct_collected: number | null;
  arrears_morning: number;
  arrears_realtime: number;
  arrear_collected: number;
  arrear_pct_collected: number | null;
}
export interface MegaOfficersAgg {
  officers: MegaOfficerRow[];
  grand: MegaOfficerRow & Record<string, number | null>;
}
export interface MegaArrearTrend {
  current: number;
  previous: number;
  delta: number;
  direction: 'up' | 'down' | 'flat';
  pct_change: number | null;
}
export interface MegaReport {
  window: MegaReportWindow;
  officer_id_filter: string | null;
  section_a_account_balance: MegaAccountBalance;
  section_b_sheet_totals: MegaSheetTotals;
  section_c_d_officers: MegaOfficersAgg;
  section_e_company_arrear_trend: MegaArrearTrend;
  generated_at: string;
}
export interface MegaReportParams {
  granularity?: 'day' | 'week' | 'month' | 'range';
  anchor?: string;
  from?: string;
  to?: string;
  officer_id?: string;
}
export async function getMegaReport(p: MegaReportParams = {}): Promise<MegaReport> {
  const q = new URLSearchParams();
  if (p.granularity) q.set('granularity', p.granularity);
  if (p.anchor) q.set('anchor', p.anchor);
  if (p.from) q.set('from', p.from);
  if (p.to) q.set('to', p.to);
  if (p.officer_id) q.set('officer_id', p.officer_id);
  const r = await authed(`/api/mega-report?${q.toString()}`);
  if (!r.ok) throw new Error(`mega-report ${r.status}: ${await r.text()}`);
  return r.json();
}

// ─── Mega-Report time series (for hover trends + drilldowns) ───────────────

export interface DailySummary {
  date: string;
  account: {
    payments_total: number; payments_count: number;
    expenses_total: number; expenses_count: number;
    net_movement: number;
    opening_balance: number | null;
    closing_live: number | null;
  } | null;
  sheets: {
    passed_total: number;
    failed_total: number;
    unused_total: number;
    by_channel: Record<string, { passed_total: number; failed_total: number; unused_total: number }>;
  } | null;
  officers: {
    total_invoice_amount: number;
    today_balance_remain: number;
    open: number;
    collected: number;
    pct_collected: number | null;
    arrears_morning: number;
    arrears_realtime: number;
    arrear_collected: number;
    arrear_pct_collected: number | null;
    officer_count: number;
  } | null;
  error?: string;
}
export interface MegaReportSeries {
  from: string;
  to: string;
  officer_id_filter: string | null;
  days: DailySummary[];
  generated_at: string;
}
export async function getMegaReportSeries(params: { from: string; to: string; officer_id?: string }): Promise<MegaReportSeries> {
  const q = new URLSearchParams();
  q.set('from', params.from);
  q.set('to', params.to);
  if (params.officer_id) q.set('officer_id', params.officer_id);
  const r = await authed(`/api/mega-report/series?${q.toString()}`);
  if (!r.ok) throw new Error(`mega-report/series ${r.status}: ${await r.text()}`);
  return r.json();
}
