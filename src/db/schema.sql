-- BRAIN: storage for statement-pull cycle reports.
-- One row per (bank, cycle attempt). The worker POSTs to /api/cycles after
-- each NMB or CRDB run; the dashboard reads from here.
--
-- Lives in the same Supabase DB as the disburser so we share connections.

CREATE TABLE IF NOT EXISTS statement_cycles (
  id                uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  reported_at       timestamptz   NOT NULL DEFAULT now(),
  started_at        timestamptz   NOT NULL,
  finished_at       timestamptz   NOT NULL,
  duration_ms       integer       NOT NULL,
  worker_id         text          NOT NULL,         -- e.g. "render-statement-pull"
  bank              text          NOT NULL,         -- "NMB" | "CRDB"
  status            text          NOT NULL,         -- "ok" | "fail"
  -- Processor's stats blob: { passed, passed_sav, needs_review, failed, skipped, total, ... }
  stats             jsonb,
  -- Processor's "message" + needs_review review_data (if any).
  processor_response jsonb,
  -- 3 key screenshots per cycle, stored as base64 data-URLs in upload order:
  -- typical: [login_ok, search_results, processor_response]. Capped client-side
  -- to ~250KB each. NULL if the cycle failed before any screenshot was taken.
  screenshots       text[],
  -- Free-form error message captured at the throw point. NULL on success.
  error_text        text
);

CREATE INDEX IF NOT EXISTS idx_statement_cycles_reported_at
  ON statement_cycles (reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_statement_cycles_bank_reported_at
  ON statement_cycles (bank, reported_at DESC);

CREATE INDEX IF NOT EXISTS idx_statement_cycles_status
  ON statement_cycles (status);

-- BRAIN: small key/value store for runtime toggles + audit log.
-- Used right now for the statement-pull "loop enabled" kill switch.
-- The worker reads `statement_pull_enabled` before each tick; if it's
-- "false", the tick is skipped. The dashboard exposes a toggle that
-- writes here. When retries exhaust, the worker auto-flips it to false
-- and (when SMS is wired) notifies the admin.
CREATE TABLE IF NOT EXISTS app_settings (
  key         text         PRIMARY KEY,
  value       text         NOT NULL,
  updated_at  timestamptz  NOT NULL DEFAULT now(),
  updated_by  text         -- "admin:fmlaki@gmail.com" or "worker:auto-disable"
);

-- Seed: loop is enabled by default. Admin can toggle in dashboard.
INSERT INTO app_settings (key, value, updated_by)
VALUES ('statement_pull_enabled', 'true', 'migration:initial-seed')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- BRAIN: OAuth tokens (currently QuickBooks only).
--
-- Previously persisted to tokens.json on the worker filesystem, but Render's
-- filesystem is wiped on every deploy → connection broke every push. Single
-- row keyed by provider (only 'quickbooks' for now). Upserted on each
-- refresh; ensureFreshToken() reads here on every QB API call.
CREATE TABLE IF NOT EXISTS app_oauth_tokens (
  provider     text          PRIMARY KEY,        -- 'quickbooks'
  realm_id     text,
  token_json   jsonb         NOT NULL,
  updated_at   timestamptz   NOT NULL DEFAULT now()
);

-- ─────────────────────────────────────────────────────────────────────────
-- BRAIN: Payment batches — the upload→QB bridge that replaces SaasAnt.
--
-- Flow per call from invoice-payment-app:
--
--   1. arrears_snapshots   — store the /arrears state at batch-creation time.
--                            One snapshot is shared by ALL batches in one run
--                            (one arrears pull → many sheet/tab batches).
--
--   2. payment_batches     — one batch = one (sheet_id, tab, set-of-bank-refs).
--                            Atomic unit of recall.  Status transitions:
--                              pending → finalized   (all QB calls succeeded)
--                              pending → rolled_back (QB error mid-flight,
--                                                     everything voided + refs
--                                                     released)
--                              finalized → recalled  (admin click)
--
--   3. payment_uploads     — one row per QB resource created (Payment OR
--                            CreditMemo).  Carries qb_id + raw responses for
--                            audit + recall.
--
--   4. consumed_transactions — the FORBIDDEN-FOR-REUSE gate.  Bank ref
--                            shows up here while it's in an active batch;
--                            recall releases it.
--
-- Source-of-truth principle: the arrears_snapshot for a batch is the data
-- the batch was REALLY built against.  On recall+rerun we go back to THAT
-- snapshot, not today's /arrears, so we never replay against drifted state.

CREATE TABLE IF NOT EXISTS arrears_snapshots (
  id           uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   timestamptz   NOT NULL DEFAULT now(),
  as_of        date          NOT NULL,
  -- The full /arrears list at snapshot time (array of ArrearRow shapes).
  data         jsonb         NOT NULL,
  row_count    integer       NOT NULL,
  total_balance numeric      NOT NULL,
  created_by   text,
  notes        text
);

CREATE INDEX IF NOT EXISTS idx_arrears_snapshots_created_at
  ON arrears_snapshots (created_at DESC);

CREATE TABLE IF NOT EXISTS payment_batches (
  id                    uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  -- Client-provided dedupe key. Second POST with the same key returns the
  -- first batch's result instead of running QB twice. Critical safety net.
  idempotency_key       text          UNIQUE NOT NULL,
  created_at            timestamptz   NOT NULL DEFAULT now(),
  finalized_at          timestamptz,
  recalled_at           timestamptz,
  rolled_back_at        timestamptz,
  status                text          NOT NULL CHECK (status IN
    ('pending', 'finalized', 'recalled', 'rolled_back')),
  arrears_snapshot_id   uuid          NOT NULL REFERENCES arrears_snapshots(id),
  -- Identifies the source sheet+tab+row scope of this batch.
  sheet_id              text          NOT NULL,
  sheet_tab             text          NOT NULL,
  channel               text          NOT NULL, -- 'bank' | 'iphone_bank' | 'nmbnew'
  -- The bank refs that make up this batch (from the sheet's column 0).
  bank_refs             text[]        NOT NULL,
  -- Tally fields, all derived from the request body + sheet verification.
  sheet_total           numeric       NOT NULL, -- sum from sheet (BRAIN's own check)
  paid_total            numeric       NOT NULL, -- sum(paid[].amount) from request
  unused_total          numeric       NOT NULL, -- sum(unused[].amount) from request
  -- Counts for the dashboard.
  paid_count            integer       NOT NULL,
  unused_count          integer       NOT NULL,
  -- Whoever told us to create this; "invoice-payment-app@<hostname>" etc.
  created_by            text,
  recalled_by           text,
  failure_reason        text          -- populated on rolled_back
);

CREATE INDEX IF NOT EXISTS idx_payment_batches_created_at
  ON payment_batches (created_at DESC);
CREATE INDEX IF NOT EXISTS idx_payment_batches_status
  ON payment_batches (status);
CREATE INDEX IF NOT EXISTS idx_payment_batches_sheet
  ON payment_batches (sheet_id, sheet_tab);

CREATE TABLE IF NOT EXISTS payment_uploads (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  batch_id         uuid          NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  -- 'payment' (paid → QB Payment) | 'credit_memo' (unused → QB CreditMemo)
  kind             text          NOT NULL CHECK (kind IN ('payment', 'credit_memo')),
  bank_ref         text          NOT NULL, -- source bank txn id (with payment-method suffix)
  customer_id      text          NOT NULL, -- QB CustomerRef.value
  customer_name    text,                    -- display only
  invoice_qb_id    text,                    -- only for payments
  invoice_no       text,                    -- only for payments (DocNumber)
  amount           numeric       NOT NULL,
  memo             text,
  qb_id            text,                    -- created QB id on success
  qb_response      jsonb,                   -- raw QB POST response
  status           text          NOT NULL CHECK (status IN ('created', 'voided', 'failed', 'unmatched', 'dry_run', 'needs_saasant')),
  failure_reason   text,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  voided_at        timestamptz,
  qb_void_response jsonb
);

CREATE INDEX IF NOT EXISTS idx_payment_uploads_batch_id
  ON payment_uploads (batch_id);
CREATE INDEX IF NOT EXISTS idx_payment_uploads_bank_ref
  ON payment_uploads (bank_ref);
CREATE INDEX IF NOT EXISTS idx_payment_uploads_status
  ON payment_uploads (status);

-- The gate. While a bank_ref is in this table, it CANNOT be in another
-- active batch. Recall deletes its rows; rerun re-inserts them.
--
-- sheet_ts is the bank-statement timestamp of the txn (col B of the sheet,
-- in UTC). Populated at insert time so "from_last" defaults can be the
-- latest *sheet-time* of consumed refs — NOT batch-finalized clock time.
-- This is the semantic Frank wants: pick up exactly where the last
-- successful upload left off in bank-data time.
CREATE TABLE IF NOT EXISTS consumed_transactions (
  bank_ref      text          PRIMARY KEY,
  batch_id      uuid          NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  consumed_at   timestamptz   NOT NULL DEFAULT now(),
  sheet_ts      timestamptz
);

-- Safe to re-run.
DO $$
BEGIN
  ALTER TABLE consumed_transactions ADD COLUMN IF NOT EXISTS sheet_ts timestamptz;
EXCEPTION WHEN OTHERS THEN NULL;
END $$;

CREATE INDEX IF NOT EXISTS idx_consumed_transactions_sheet_ts
  ON consumed_transactions (sheet_ts DESC) WHERE sheet_ts IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_consumed_transactions_batch_id
  ON consumed_transactions (batch_id);

-- Seeds for sheet allow/deny — invoice-payment-app's hardcoded mapping.
-- Stored as JSON so the admin dashboard can edit them later without a
-- migration. Each allowlist entry carries the tab + amount column index
-- so BRAIN can verify the sheet_total independently.
-- idCol = 7 (REFNUMBER), not 0 (row counter). Confirmed in
-- invoice-payment-app: `id: row[7] || channel-${i+1}`. Memo column on the
-- output CSVs carries row[7].
INSERT INTO app_settings (key, value, updated_by) VALUES
  ('sheet_allowlist', $json$
{
  "1rdSRNLdZPT5xXLRgV7wSn1beYwWZp41ZpYoLkbGmt0o": {
    "channel": "bank", "label": "BANK (CRDB)", "tab": "PASSED",
    "idCol": 7, "amountCol": 4
  },
  "1Y2cOyObQvP502kvEbC-uGDP-3Sf5X9JKnDDYmR0BPRQ": {
    "channel": "iphone_bank", "label": "IPHONE BANK (CRDB)", "tab": "BANK_PASSED",
    "idCol": 7, "amountCol": 4
  },
  "1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek": {
    "channel": "nmbnew", "label": "NMB NEW (NMB)", "tab": "PASSED",
    "idCol": 7, "amountCol": 4
  }
}
  $json$, 'migration:initial-seed'),
  ('sheet_denylist', '["1N3ZxahtaFBX0iK3cijDraDmyZM8573PVVf8D-WVqicE"]',
    'migration:initial-seed')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Notifications + SMS gateway.
-- BRAIN code paths POST here when something needs operator attention.
-- An Android phone APK polls /api/notifications/pending and forwards each
-- message as an SMS to the configured admin numbers.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS notifications (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  message          text          NOT NULL,
  severity         text          NOT NULL CHECK (severity IN ('critical','warning','info')),
  source           text,
  status           text          NOT NULL DEFAULT 'pending'
                                 CHECK (status IN ('pending','sending','sent','failed')),
  retry_count      int           NOT NULL DEFAULT 0,
  created_at       timestamptz   NOT NULL DEFAULT now(),
  picked_up_at     timestamptz,
  sent_at          timestamptz,
  failed_at        timestamptz,
  failure_reason   text,
  sms_to           text[],
  ack_device_id    text
);

CREATE INDEX IF NOT EXISTS idx_notifications_status
  ON notifications (status, created_at);
CREATE INDEX IF NOT EXISTS idx_notifications_severity
  ON notifications (severity, created_at DESC);

-- Seed default admin recipient list — empty until operator configures it
-- from the dashboard. The phone APK fetches this and sends to each number.
INSERT INTO app_settings (key, value, updated_by) VALUES
  ('sms_recipients', '[]', 'migration:notifications-seed')
ON CONFLICT (key) DO NOTHING;

-- ─────────────────────────────────────────────────────────────────────────
-- Autonomous-Claude agent runtime
--
-- Each cron fire (or SMS-trigger) spawns one agent_session. The session
-- has a trigger context, a mode (plan|execute), a stream of messages
-- (system, user, assistant, tool calls + their results), and at the end a
-- summary + stats. Future sessions read the last N completed sessions to
-- maintain institutional memory across cron firings.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS agent_sessions (
  id               uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  trigger          text          NOT NULL,         -- 'cron:03:00' | 'sms:ask' | 'manual'
  trigger_context  jsonb,                          -- {channel, window, as_of, ...}
  mode             text          NOT NULL CHECK (mode IN ('plan','execute')),
  model            text          NOT NULL,         -- 'claude-sonnet-4-6'
  status           text          NOT NULL DEFAULT 'running'
                                 CHECK (status IN ('running','completed','paused','aborted','errored')),
  summary          text,
  stats            jsonb,
  paused_question  jsonb,                          -- {question, context} if paused
  parent_session_id uuid REFERENCES agent_sessions(id),  -- for SMS reply continuations
  input_tokens     bigint        DEFAULT 0,
  output_tokens    bigint        DEFAULT 0,
  cache_read_tokens bigint       DEFAULT 0,
  cache_write_tokens bigint      DEFAULT 0,
  cost_usd         numeric,
  started_at       timestamptz   NOT NULL DEFAULT now(),
  ended_at         timestamptz,
  updated_at       timestamptz   NOT NULL DEFAULT now(),
  error_text       text
);

CREATE INDEX IF NOT EXISTS idx_agent_sessions_started_at
  ON agent_sessions (started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_status
  ON agent_sessions (status, started_at DESC);
CREATE INDEX IF NOT EXISTS idx_agent_sessions_trigger
  ON agent_sessions (trigger, started_at DESC);

CREATE TABLE IF NOT EXISTS agent_session_messages (
  id           bigserial     PRIMARY KEY,
  session_id   uuid          NOT NULL REFERENCES agent_sessions(id) ON DELETE CASCADE,
  role         text          NOT NULL CHECK (role IN ('system','user','assistant','tool')),
  kind         text,                              -- tool name, or 'text', 'thinking'
  payload      jsonb         NOT NULL,
  created_at   timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_agent_session_messages_session
  ON agent_session_messages (session_id, id);

-- Inbound SMS thread — when Frank texts the phone APK, it forwards to
-- BRAIN, which appends here. Agent sessions read recent messages.
CREATE TABLE IF NOT EXISTS sms_inbox (
  id              bigserial     PRIMARY KEY,
  received_at     timestamptz   NOT NULL DEFAULT now(),
  from_number     text          NOT NULL,
  message         text          NOT NULL,
  processed       boolean       NOT NULL DEFAULT false,
  processed_at    timestamptz,
  spawned_session_id uuid       REFERENCES agent_sessions(id)
);

CREATE INDEX IF NOT EXISTS idx_sms_inbox_unprocessed
  ON sms_inbox (received_at) WHERE processed = false;

-- Migration: extend payment_uploads.status to include 'needs_saasant'
-- (rows whose customer didn't match in QB; queued for manual SaasAnt push).
-- Safe to re-run.
DO $$
BEGIN
  ALTER TABLE payment_uploads DROP CONSTRAINT IF EXISTS payment_uploads_status_check;
  ALTER TABLE payment_uploads ADD CONSTRAINT payment_uploads_status_check
    CHECK (status IN ('created','voided','failed','unmatched','dry_run','needs_saasant'));
EXCEPTION WHEN OTHERS THEN
  -- ignore if table not yet present
  NULL;
END $$;

-- External-consumed refs ledger.
-- Catches refs that were pushed to QB via a path OTHER than BRAIN
-- (SaasAnt, manual web UI, sister tool, prior BRAIN incarnation whose
-- consumed_transactions got cleared). Populated by the QB pre-flight
-- check (see preflightQbDedup in payment-batches.js). Once a ref is
-- here, BRAIN never tries to push it again — same role as
-- consumed_transactions but for refs that landed in QB outside our
-- workflow.
--
-- Key on (bank_ref, customer_id) because a misrouted SaasAnt push for
-- customer A doesn't preclude a legitimate BRAIN push for customer B
-- with the same ref (very unlikely in practice, but the schema doesn't
-- need to assume).
CREATE TABLE IF NOT EXISTS external_consumed_refs (
  bank_ref      text          NOT NULL,
  customer_id   text          NOT NULL,
  qb_id         text          NOT NULL,
  qb_kind       text          NOT NULL CHECK (qb_kind IN ('payment','credit_memo')),
  qb_txn_date   date,
  found_at      timestamptz   NOT NULL DEFAULT now(),
  found_by      text,                                   -- which batch's pre-flight surfaced it
  PRIMARY KEY (bank_ref, customer_id)
);

CREATE INDEX IF NOT EXISTS idx_external_consumed_refs_ref
  ON external_consumed_refs (bank_ref);
CREATE INDEX IF NOT EXISTS idx_external_consumed_refs_found_at
  ON external_consumed_refs (found_at DESC);

-- Duplicate-customer ledger. Grows over time as Claude (or Frank)
-- identifies QB customer records that are duplicates of each other.
-- The matcher in src/runner/match-customers.js consults this table
-- to redirect a "wrong duplicate" id to the canonical id.
CREATE TABLE IF NOT EXISTS duplicate_customers (
  duplicate_id   text          PRIMARY KEY,        -- the wrong QB Customer Id
  canonical_id   text          NOT NULL,           -- the right QB Customer Id
  reason         text,                             -- 'plate-suffix-mismatch' etc.
  noted_by       text,                             -- 'agent:<session>' | 'admin:fmlaki'
  noted_at       timestamptz   NOT NULL DEFAULT now()
);

-- ── Officer-collections-report tables ──────────────────────────────────────
-- Frank's loan officers are "parent customers" in QB sitting at the same
-- hierarchy level as AGRICOLA BODA. Every actual rider/borrower has an
-- ancestor at that level. The map below caches, for every QB customer,
-- which officer they roll up to — so the report doesn't traverse the
-- parent chain on every request.
CREATE TABLE IF NOT EXISTS customer_officer_map (
  customer_id      text          PRIMARY KEY,      -- any QB Customer Id
  customer_name    text,
  officer_id       text          NOT NULL,         -- ancestor at officer level
  officer_name     text          NOT NULL,
  qb_level         int,                            -- this customer's depth in QB
  cached_at        timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_customer_officer_map_officer
  ON customer_officer_map (officer_id);

-- OFFICE/POLICE motorcycles from the external Google Sheet.
-- snapshot_date = the day the sheet was read. source = 'OFFICE' or 'POLICE'.
-- One row per (date, rider_name, plate). officer_* nullable so unmapped
-- entries still get persisted for triage.
CREATE TABLE IF NOT EXISTS officer_offline_motos (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  snapshot_date date          NOT NULL,
  source        text          NOT NULL CHECK (source IN ('OFFICE','POLICE')),
  rider_name    text          NOT NULL,
  plate         text,
  customer_id   text,                              -- resolved QB id (if matched)
  officer_id    text,                              -- resolved officer (if matched)
  officer_name  text,
  cached_at     timestamptz   NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS idx_officer_offline_motos_date_officer
  ON officer_offline_motos (snapshot_date, officer_id);

-- Cached daily totals per officer. Frank said live-pull is fine (amount
-- is immutable post-issuance), so this table is just a 5-min cache to
-- keep dashboard polling cheap. cached_at is the TTL anchor.
CREATE TABLE IF NOT EXISTS officer_invoice_snapshots (
  snapshot_date          date          NOT NULL,
  officer_id             text          NOT NULL,
  officer_name           text          NOT NULL,
  total_invoice_amount   numeric       NOT NULL,   -- Σ Invoice.TotalAmt (NOT Balance)
  open_invoice_count     int           NOT NULL,
  cached_at              timestamptz   NOT NULL DEFAULT now(),
  PRIMARY KEY (snapshot_date, officer_id)
);

-- QB Open-Invoices snapshot, captured per AS_OF date. Batches share a
-- snapshot when they fire against the same AS_OF (e.g. 3 channels firing
-- the same morning tick all bind to one snapshot). Lets the operator
-- later download the exact invoice universe that was allocated against.
CREATE TABLE IF NOT EXISTS invoice_snapshots (
  id            uuid          PRIMARY KEY DEFAULT gen_random_uuid(),
  as_of         date          NOT NULL,
  captured_at   timestamptz   NOT NULL DEFAULT now(),
  invoice_count integer       NOT NULL,
  total_balance numeric       NOT NULL,
  -- Array of { date, no, customer, memo, balance, amount, status } shapes.
  data          jsonb         NOT NULL,
  -- The header line we render at the top of the .xls download.
  date_range_header text
);

CREATE INDEX IF NOT EXISTS idx_invoice_snapshots_as_of
  ON invoice_snapshots (as_of, captured_at DESC);

-- Link payment_batches → invoice_snapshots. NULL on batches created
-- before this feature shipped. Always populated for new batches.
ALTER TABLE payment_batches
  ADD COLUMN IF NOT EXISTS invoice_snapshot_id uuid
    REFERENCES invoice_snapshots(id);

-- Per-batch structured log buffer. Every meaningful event during the
-- upload (start, dup-check result, each chunk push, error, retry,
-- finalize) appends one row of jsonb here. Operator opens the batch
-- detail page later and reads the trail for debugging.
-- Shape: [{ ts, level: "info"|"warn"|"error", message, source, ... }]
ALTER TABLE payment_batches
  ADD COLUMN IF NOT EXISTS logs jsonb NOT NULL DEFAULT '[]'::jsonb;
CREATE INDEX IF NOT EXISTS idx_payment_batches_logs_gin
  ON payment_batches USING gin (logs);

-- ─────────────────────────────────────────────────────────────────────────
-- QB MIRROR (Phase 1) — local copies of Invoice + Payment + LinkedTxn rows
-- so report queries hit Postgres (sub-second) instead of QB API (minutes).
-- Kept current by CDC polling every 30s + webhook upserts (Phase 2).
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS qb_invoices (
  id                text          PRIMARY KEY,        -- QB Invoice.Id
  customer_id       text          NOT NULL,
  txn_date          date          NOT NULL,
  due_date          date,
  total_amt         numeric       NOT NULL,
  balance           numeric       NOT NULL,
  doc_number        text,
  sync_token        text,
  qb_last_updated   timestamptz,                       -- MetaData.LastUpdatedTime
  mirror_synced_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qb_invoices_txn_date
  ON qb_invoices (txn_date);
CREATE INDEX IF NOT EXISTS idx_qb_invoices_due_overdue
  ON qb_invoices (due_date) WHERE balance > 0;
CREATE INDEX IF NOT EXISTS idx_qb_invoices_customer
  ON qb_invoices (customer_id);
CREATE INDEX IF NOT EXISTS idx_qb_invoices_balance_pos
  ON qb_invoices (balance) WHERE balance > 0;

CREATE TABLE IF NOT EXISTS qb_payments (
  id                text          PRIMARY KEY,        -- QB Payment.Id
  customer_id       text          NOT NULL,
  txn_date          date          NOT NULL,
  total_amt         numeric       NOT NULL,
  sync_token        text,
  qb_last_updated   timestamptz,
  mirror_synced_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qb_payments_txn_date
  ON qb_payments (txn_date);
CREATE INDEX IF NOT EXISTS idx_qb_payments_customer
  ON qb_payments (customer_id);

-- One row per Payment.Line[] entry that links to an Invoice. Used by the
-- arrear math (bucket today's payment lines by linked invoice's overdue
-- status). Other line types (deposits, discounts) skipped — they don't
-- show up in our reports.
CREATE TABLE IF NOT EXISTS qb_payment_lines (
  payment_id        text          NOT NULL REFERENCES qb_payments(id) ON DELETE CASCADE,
  line_no           int           NOT NULL,          -- 0-indexed position in Line[]
  amount            numeric       NOT NULL,
  linked_invoice_id text,                            -- LinkedTxn[].TxnId where TxnType='Invoice'
  PRIMARY KEY (payment_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_qb_payment_lines_invoice
  ON qb_payment_lines (linked_invoice_id) WHERE linked_invoice_id IS NOT NULL;

-- 2026-06-11 — QB CreditMemo mirror. CreditMemos are money OUT (refunds,
-- writeoffs) issued against customer balance and applied to invoices.
-- They reduce per-officer collection totals — without mirroring them
-- the dashboard overcounts what an officer actually delivered (e.g.
-- PERIS THOMAS OKALA shows +34.5k on the dashboard vs -891k in the QB
-- Account QuickReport because today's CreditMemos against PERIS's
-- customers aren't visible to the report).
CREATE TABLE IF NOT EXISTS qb_credit_memos (
  id                text         PRIMARY KEY,
  customer_id       text         NOT NULL,
  txn_date          date         NOT NULL,
  total_amt         numeric      NOT NULL,
  sync_token        text,
  qb_last_updated   timestamptz,
  mirror_synced_at  timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_qb_credit_memos_txn_date ON qb_credit_memos (txn_date);
CREATE INDEX IF NOT EXISTS idx_qb_credit_memos_customer ON qb_credit_memos (customer_id);

CREATE TABLE IF NOT EXISTS qb_credit_memo_lines (
  credit_memo_id    text         NOT NULL REFERENCES qb_credit_memos(id) ON DELETE CASCADE,
  line_no           int          NOT NULL,
  amount            numeric      NOT NULL,
  linked_invoice_id text,
  PRIMARY KEY (credit_memo_id, line_no)
);
CREATE INDEX IF NOT EXISTS idx_qb_credit_memo_lines_invoice
  ON qb_credit_memo_lines (linked_invoice_id) WHERE linked_invoice_id IS NOT NULL;

-- High-water mark + audit per entity for CDC polling.
-- last_cdc_at = highest LastUpdatedTime we've ingested. The CDC poll asks
-- QB for everything changedSince last_cdc_at - 60s (overlap to absorb
-- clock skew + missed webhooks).
CREATE TABLE IF NOT EXISTS qb_mirror_state (
  entity            text          PRIMARY KEY,       -- 'Invoice' | 'Payment'
  last_cdc_at       timestamptz   NOT NULL,
  last_backfill_at  timestamptz,
  rows_synced       bigint        NOT NULL DEFAULT 0,
  last_error        text,
  last_error_at     timestamptz
);

-- Phase 5+ — pre-computed daily Section B sheet totals per (date, channel).
-- mega-report's getSheetTotals reads this table when present; falls back
-- to live Google Sheets read only on miss.
CREATE TABLE IF NOT EXISTS daily_sheet_totals (
  date            date         NOT NULL,
  channel         text         NOT NULL,
  passed_rows     int          NOT NULL DEFAULT 0,
  passed_total    numeric      NOT NULL DEFAULT 0,
  failed_rows     int          NOT NULL DEFAULT 0,
  failed_total    numeric      NOT NULL DEFAULT 0,
  unused_rows     int          NOT NULL DEFAULT 0,
  unused_total    numeric      NOT NULL DEFAULT 0,
  computed_at     timestamptz  NOT NULL DEFAULT now(),
  PRIMARY KEY (date, channel)
);
CREATE INDEX IF NOT EXISTS idx_daily_sheet_totals_date
  ON daily_sheet_totals (date DESC);

-- Phase 5+ — pre-computed daily Section A account balance per date.
-- Populated by account-balance-snapshotter every 60 s for today + N
-- historical days on boot. mega-report's getAccountBalance reads here
-- first, falls back to live QB BalanceSheet only on miss. Once this
-- table is warm, dashboard cold-path is pure Postgres SELECT.
CREATE TABLE IF NOT EXISTS daily_account_balance (
  date            date         PRIMARY KEY,
  parent_account  text         NOT NULL,
  opening_balance numeric,
  closing_live    numeric,
  payments_total  numeric      NOT NULL DEFAULT 0,
  payments_count  int          NOT NULL DEFAULT 0,
  expenses_total  numeric      NOT NULL DEFAULT 0,
  expenses_count  int          NOT NULL DEFAULT 0,
  net_movement    numeric      NOT NULL DEFAULT 0,
  computed_at     timestamptz  NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_daily_account_balance_date
  ON daily_account_balance (date DESC);

-- Phase 4 — pre-computed daily aggregates per (date, officer). Lets
-- multi-day windows and trend comparisons avoid re-aggregating raw
-- mirror rows. Refreshed by snapshot-refresher every 30 s for today,
-- sealed by nightly job for historical days.
CREATE TABLE IF NOT EXISTS daily_officer_snapshot (
  date                     date     NOT NULL,
  officer_id               text     NOT NULL,
  officer_name             text     NOT NULL,
  -- Section C: today's invoices.
  total_invoice_amount     numeric  NOT NULL DEFAULT 0,
  today_balance_remain     numeric  NOT NULL DEFAULT 0,
  open_invoice_count       int      NOT NULL DEFAULT 0,
  -- Section D: arrears + collection math.
  arrears_now              numeric  NOT NULL DEFAULT 0,
  arrears_morning          numeric  NOT NULL DEFAULT 0,
  arrear_collected         numeric  NOT NULL DEFAULT 0,
  open_invoice_collection  numeric  NOT NULL DEFAULT 0,
  overdue_invoice_count    int      NOT NULL DEFAULT 0,
  computed_at              timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (date, officer_id)
);

-- 2026-06-11 — split open_invoice_collection into today vs future buckets.
-- Identity now: arrear_collected + today_invoice_collection +
-- future_invoice_collection = total payment lines linked to invoices, per
-- officer. Lets the dashboard show prepayment (future installments) vs
-- "paid today's open" cleanly instead of lumping both into open_invoice_collection.
ALTER TABLE daily_officer_snapshot
  ADD COLUMN IF NOT EXISTS today_invoice_collection  numeric NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS future_invoice_collection numeric NOT NULL DEFAULT 0;
CREATE INDEX IF NOT EXISTS idx_daily_officer_snapshot_date
  ON daily_officer_snapshot (date DESC);
CREATE INDEX IF NOT EXISTS idx_daily_officer_snapshot_officer
  ON daily_officer_snapshot (officer_id, date DESC);

-- ─────────────────────────────────────────────────────────────────────────
-- 2026-07-17 — Frappe Payment Entry mirror. Same pattern as qb_payments.
-- APRUNA THOMAS BODA's cohort routes to Frappe now (via apruna-divert), so
-- the officer/mega/comparison reports need to sum QB payments + Frappe
-- payments per customer/day. cdcSync polls elegansky.api.recent_payments
-- (or /api/resource/Payment Entry filtered by `modified`) every N minutes;
-- the same upsert path is called from the frappe-webhook module for
-- real-time updates.
-- ─────────────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS frappe_payments (
  name              text          PRIMARY KEY,        -- Frappe Payment Entry name
  party             text          NOT NULL,           -- Frappe customer name
  posting_date      date          NOT NULL,
  paid_amount       numeric       NOT NULL,
  mode_of_payment   text,                             -- NMB / CRDB / iPhone / SAVCOM NMB / etc.
  reference_no      text,                             -- bank_ref (txn_id)
  docstatus         smallint      NOT NULL DEFAULT 1, -- 0=draft, 1=submitted, 2=cancelled
  frappe_modified   timestamptz,                      -- Frappe's `modified` field for CDC
  mirror_synced_at  timestamptz   NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS idx_frappe_payments_posting_date
  ON frappe_payments (posting_date);
CREATE INDEX IF NOT EXISTS idx_frappe_payments_party
  ON frappe_payments (party);
CREATE INDEX IF NOT EXISTS idx_frappe_payments_reference_no
  ON frappe_payments (reference_no) WHERE reference_no IS NOT NULL;

CREATE TABLE IF NOT EXISTS frappe_mirror_state (
  entity            text          PRIMARY KEY,        -- 'PaymentEntry'
  last_cdc_at       timestamptz   NOT NULL,           -- high-water mark for CDC
  last_backfill_at  timestamptz,
  rows_synced       bigint        NOT NULL DEFAULT 0
);
