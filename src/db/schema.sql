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
  status           text          NOT NULL CHECK (status IN ('created', 'voided', 'failed')),
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
CREATE TABLE IF NOT EXISTS consumed_transactions (
  bank_ref      text          PRIMARY KEY,
  batch_id      uuid          NOT NULL REFERENCES payment_batches(id) ON DELETE CASCADE,
  consumed_at   timestamptz   NOT NULL DEFAULT now()
);

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
