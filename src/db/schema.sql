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
