# EleganskyBrain — Cold-start brief for Claude Code sessions

You are being invoked in the BRAIN repo. This file is what the operator wants a fresh session to know before touching code.

## What this is

BRAIN is the **central Node app** that runs Frank Mlaki's motorcycle finance operations (Elegansky, Tanzania). It:

- Ingests bank statement rows from the PASSED tab of a shared Google Sheet
- Matches each bank txn to open QuickBooks invoices via the "invoice-payment algorithm" (sacred — do not opine on)
- Pushes matched payments to QuickBooks (QB is source of truth for accounting) OR to Frappe/ERPNext (SAVCOM path)
- Runs 9 scheduled ticks per day that auto-fire uploads (meru/hanang/loolmalas/lengai/mawenzi/kili/kibo)
- Generates the morning + noon debt reports (arrears .xls files) and delivers links via SMS
- Serves the Metronic-based dashboard for operator manual actions

## Where it runs

- **Host**: VPS `169.58.17.126` (Contabo, Ubuntu 24.04). DNS: `brain.eleganskyboda.com`
- **Systemd service**: `brain.service`
- **App dir on VPS**: `/home/eleg/EleganskyBrain`
- **Port**: 3000 (behind reverse proxy for the public domain)
- **DB**: Postgres (connection via `.env` on VPS — do not read `.env` unless the user asks, treat as sensitive)
- **Git remote**: `git@github.com:cliffpyne/elegansky-brain.git` — branch `main`
- **Legacy Render deploy**: `elegansky-brain.onrender.com` is referenced as a `BRAIN_BASE_URL` fallback but the VPS is authoritative now

## How to deploy changes

**Preferred path (git → Render/VPS auto-deploy):**
```
git add <specific files, not . or -A>
git commit -m "..."
git push origin main
```

**When GitHub SSH is unreachable from operator's machine** (happened this session — network flake):
```
scp src/<changed>.js root@169.58.17.126:/tmp/
ssh root@169.58.17.126 "cp /tmp/<file>.js /home/eleg/EleganskyBrain/src/<file>.js"
ssh root@169.58.17.126 "systemctl restart brain"
# then git push later when network is back so remote + VPS stay in sync
```

## Deploy safety rules — READ BEFORE PUSHING

These are operator-established, non-negotiable:

1. **Never `git push` if `auto_upload_locks` or `agent_sessions` has running rows** — a restart mid-fire kills in-flight fetches and corrupts state. Query first:
   ```sql
   SELECT * FROM auto_upload_locks;
   SELECT * FROM agent_sessions WHERE status='running';
   ```
2. **Keep ≥25 min away from every scheduled tick** for safe deploys. Ticks (EAT): 01:00, 03:00, 05:00, 07:00, 10:00, 12:30, 14:00, 16:15, 18:00, 21:00
3. **Never skip hooks** (`--no-verify`) unless the user explicitly asks
4. **Never POST test data to live QB** (Payments/Invoices/CreditMemos) even with intent to delete — analysts watch the live ledger
5. **Never POST to endpoints with real side effects** (SMS, snapshot, reports) as a "probe"

## Key entry points

- `src/server.js` — HTTP server, mounts all APIs, defines `qbPreflightDedup`
- `src/payment-batches.js` — the workhorse: `prepareAutoUpload`, `runAutoUploadBackground`, `computeCatchupPlan`, `/api/payment-batches/start/:channel`, `/api/payment-batches/auto-upload/:channel`
- `src/apruna-divert.js` — routes APRUNA-blacklisted senders to Frappe instead of QB (before preflight)
- `src/late-txn-reconciler.js` — voids downstream QB payments + replays when a late (retro) row arrives
- `src/agent/scheduler.js` — cron scheduler that fires the 9 daily ticks
- `src/agent/tools.js` — Claude Agent SDK tools the autonomous fires can invoke
- `src/m6pm-automation.js` — `autoFireReportsWatcher`, `tickResultNotifierWatcher`, other watchers
- `src/qb-client.js` — QuickBooks API wrapper (`qbQuery`, `qbPost`)
- `src/frappe-client.js` — Frappe API wrapper
- `src/sheets.js` — Google Sheets read/write (`readSheet`, `writeSheetCells`, `paintRowEndMarker`)
- `web/` — Metronic React dashboard (Vite; served by BRAIN at `/`)

## Channels

- `nmbnew` — NMB bank (main)
- `bank` — CRDB bank
- `iphone_bank` — iPhone SMS-captured txns
- `bank_sav`, `nmbnew_sav` — SAVCOM channels, routes to Frappe not QB, **skips QB preflight** (per commit `cc2c62d`)

## Kili1615 rule (business-day boundary)

- Business day rolls at **16:15 EAT** (`kili1615`)
- Rows timestamped `00:00–16:15 EAT` on day D → `as_of=D`, `TxnDate=D` (sub-window A)
- Rows timestamped `16:16–23:59 EAT` on day D → `as_of=D`, `TxnDate=D+1` (sub-window B)
- Retro / catch-up fires: `TxnDate = firing kili day of NOW` (per commit `e151d0b`), `as_of = row's kili day` per window

## Column K in the sheet

- Column K holds the "end of {tick}" marker written after each auto-upload fire
- Highest-row-number K marker is the **plan walker baseline** — `computeCatchupPlan` treats rows ≤ that row as already processed
- **Orphaning gotcha**: retro rows appended at the bottom of the sheet with an old date can get K painted on them, orphaning fresh rows above (lower row numbers) that share the same time-order but were appended earlier. Session-end K fix (commit `04b6e7f`) writes ONE K at max-row after all windows in a `/start/:channel` fire

## Retro reconcile (late txn handling)

- Triggered in `prepareAutoUpload` when `physical_day < as_of` for any row
- Calls `reconcileCustomer(customerName, sinceDay)` — voids the customer's QB Payments made after `sinceDay`, clears their `consumed_transactions`, so re-fire can allocate correctly
- Sacred rule Frank set: "retro-void must handle day-back late rows — void downstream customer payments and replay"
- Known nuance: for heisenberg per-window fires where `as_of = row_day`, condition `physical_day < as_of` may never trigger. Auto-fire ticks with `as_of=today` handle it correctly.

## 2026-07-21 session fixes (recent, all deployed)

- **commit `0d9b6f3`** — `qbPreflightDedup` (server.js) now filters non-numeric customer_ids from tuples before building the QB IN clause. Previously a stale/malformed customer_id caused QB to return "Invalid ID" and abort the entire 50-cust chunk. Also removed a TDZ crash in the preflight-fail cleanup path that had been masking the real error as `Cannot access 'batchId' before initialization`. Example bad ID caught today: `ISMAIL SELEMANI ISMAIL` (customer name in the id field via a bad invoice mirror row).
- **commit `04b6e7f`** — `start-channel` (payment-batches.js) now writes ONE session-end K marker at MAX row across all windows in a plan, instead of per-window K markers. Fixes the retro-orphaning where per-window K on a retro row (07-14 row appended below fresh 07-21 rows) would strand the fresh rows.
- **commit `f11216f`** — `autoFireReportsWatcher` + `maybeFireEveningComparison` (m6pm-automation.js) now require: (a) each `expectedChannels` (default `['nmbnew','bank']`) has ≥1 finalized batch AND (b) `auto_upload_locks` is CLEAR on every expected channel. Previously LIMIT 1 fired the report as soon as any first-window-first-channel batch finalized — sending NMB-only reports whenever bank was still processing later windows. Grace timeout `graceMin` (20 min) still forces a partial fire if a channel is genuinely dead.

## Known-unfixed gotchas (as of this session)

- **Heisenberg orphans in row-number K flow**: session-end K writes at max row-number, but retro rows appended at the bottom of the sheet can have older timestamps than fresh 07-21 rows above them. When session-end K lands on that retro row, the fresh rows above it get orphaned again on the next plan walk. Symptom today: 12 rows at 43968-43983 stranded even after two heisenberg fires. Manual recovery: clear K on the retro row(s) + re-fire — see BRAIN's `writeSheetCells` + `computeCatchupPlan`.
- **`ReferenceError: CONCURRENCY is not defined`**: appeared in one 07-21 bank heisenberg window at the end (batch still finalized with 86 payments, but the error should be traced — grep `CONCURRENCY` in payment-batches.js).

## Health checks

```bash
# Locks + running sessions (must be empty for safe deploy)
ssh root@169.58.17.126 'psql $BRAIN_DB -c "SELECT * FROM auto_upload_locks; SELECT * FROM agent_sessions WHERE status=$$running$$"'

# Service status
ssh root@169.58.17.126 'systemctl is-active brain nmb-live-puller crdb-live-puller statement-puller'

# Log tail (BRAIN)
ssh root@169.58.17.126 'tail -100 /var/log/brain.log'
```

## Auth for BRAIN endpoints

- `requireSecretOrJwt` middleware — accepts either `x-report-secret` header (env `STATEMENT_REPORT_SECRET`) or Supabase JWT
- Dashboard uses JWT; curl / cron scripts use `x-report-secret`

## Operator preferences (from memory — apply globally)

- **Direct pushback welcome** when a plan looks like paving a cowpath. Don't just agree-and-build.
- **Don't relitigate operator choices** (bank API vs scraping, FIFO vs newest-first, etc.). Help execute.
- **Payment allocation algorithm is sacred** — port it verbatim from invoice-payment-app, no opinions on FIFO/newest-first/overpayment behavior.
- **Speak during long tasks** — 1-line check-in every ~5 min during long builds/uploads/scans; silence reads as broken.
- **Reuse existing endpoints** — never write custom SQL to answer "show me X" until you've grep'd for an existing endpoint doing exactly that.
- **Metronic UI only** — BRAIN dashboard reuses Metronic components; no ad-hoc HTML/CSS.
- **Post-recall fresh upload SOP** — `dry_run` first, fire smallest channel first, 2-6 min waits between fires, scan after each.

## Sister services

- **eleganskyCrdb** (VPS `/home/eleg/eleganskyCrdb`) — CRDB portal scraper POC. See its CLAUDE.md.
- **NMB puller** (VPS `/home/eleg/eleganskyNmb/` — assumed path, not in local repos on operator's PC) — NMB portal scraper POC
- **elegansky-m6pm** — dashboard for SMS + report actions
- **elegansky-m6pm-iphone** — iPhone-side companion of m6pm

## What this brief does NOT include

- **Secrets** — env values must never be read/echoed by Claude without explicit user request
- **The full invoice-payment algorithm** — read `src/payment-batches.js` around `processInvoicePaymentsWithForwardPay` for the current implementation
- **Every scheduler quirk** — read `src/agent/scheduler.js` for the tick definitions and `mawenzi1400` etc. (there are 9 ticks total, some added recently)
