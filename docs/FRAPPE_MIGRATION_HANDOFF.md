# Frappe ERP migration — handoff brief for the migration agent

This document captures **everything** the current QuickBooks Online (QB) integration does, so a migration agent can build the equivalent in Frappe ERP without losing business rules or edge-case behavior.

It is **descriptive, not source**. The code itself is sacred and will be shared by Frank separately. Use this brief to understand intent; ask for code only when you need to verify a specific behavior.

The system is an in-production microfinance back office. Every paragraph below is based on real incidents and hard-won lessons. **Read everything before designing the Frappe equivalent.**

---

## 1. Executive context

Elegansky is a Tanzanian microfinance operator providing motorcycle loans. Customers repay via:
- **NMB Bank** (agency cash deposits, the dominant channel) → suffix **N**
- **CRDB Bank** (direct transfers, smaller volume) → suffix **B**
- **iPhone direct** (a separate manual entry channel) → suffix **P**

Roughly 95% of repayments are NMB agency cash deposits. The motorcycle has a remote-disable feature: when an invoice goes past due, the bike is turned off; when the customer pays, the bike must come back on **fast** (within ~10 minutes of the payment hitting the bank).

The whole system exists to make that bank-deposit-to-invoice-closed-to-bike-on loop as fast and accurate as possible.

---

## 2. System architecture (current)

```
┌──────────────────┐         ┌──────────────────────┐
│   BRAIN (Node.js)│ ←OAuth→ │  QuickBooks Online   │  ← will be replaced by Frappe
│   "the API"      │         │  (chart of accounts, │
└─────┬────────────┘         │   invoices, payments)│
      │                      └──────────────────────┘
      │ writes/reads
      ▼
┌──────────────────┐
│  Postgres (Supa) │  ← BRAIN data + QB mirror tables
│  - payment_batches│
│  - payment_uploads│
│  - qb_invoices    │  ← mirrored from QB via webhooks + CDC poller
│  - qb_payments    │
│  - qb_tokens      │
│  - customer_officer_map
│  - daily_officer_snapshot
│  ...              │
└──────────────────┘
      │
      ▼ matched rows appended
┌──────────────────┐
│  Google Sheets   │  ← staging area, 3 channels = 3 spreadsheets
│  (PASSED tabs)   │     each row is a candidate payment
└──────▲───────────┘
       │ appends matched rows
┌──────┴───────────┐
│ transaction-     │  ← matches bank CSV rows to customers
│ processor (Node) │     dedups, classifies (PASSED / SAV / REVIEW / FAIL)
└──────▲───────────┘
       │ uploads bank CSVs
┌──────┴───────────┐
│ statement-worker │  ← Playwright bot, scrapes NMB + CRDB web banking
│ (TypeScript)     │     runs 9 cron ticks/day on Render
└──────────────────┘
```

**External services:**
- **Render** — hosts BRAIN + worker + transaction-processor (separate services)
- **Supabase** — Postgres
- **Google Sheets API** — staging
- **NMB ibanking** — scrape via Playwright (requires OTP per fresh login)
- **CRDB ibanking** — same pattern, OTP per session
- **QuickBooks Online API** — OAuth2, REST + batch endpoints

---

## 3. Business model (why each piece exists)

### 3.1 Customer hierarchy
- Customers in QB are arranged as a **parent / child hierarchy**.
- A **loan officer** is modeled as a parent Customer in QB.
- Each end customer (the borrower) is a child Customer whose `ParentRef` points at the officer.
- Loan officer reports are computed by walking children of each officer parent.

### 3.2 Invoices
- One Invoice per scheduled repayment (typically weekly or monthly).
- Invoice `DocNumber` follows a structured pattern: `<branch>AGD<sequence>` or `<branch>FTM<sequence>` (e.g., `101AGD1261660007`). The branch prefix is meaningful.
- Invoices stay open (`Balance > 0`) until paid.

### 3.3 Payments
- Customer hands cash to NMB agent → NMB credits Elegansky's Kijichi Collection account.
- BRAIN matches that bank-statement row to a Customer + their **oldest open** Invoice.
- BRAIN creates a QB **Payment** linked to that Invoice, depositing into a specific Bank account.
- QB then reduces the Invoice's `Balance` and increases the Bank account's `CurrentBalance`.

### 3.4 Overflow
- If the customer pays more than the oldest invoice's balance, the surplus rolls into the next-oldest invoice (FIFO). One bank transaction can close multiple invoices.

### 3.5 Unused (unapplied) payments
- If a transaction matches a customer **but** that customer has no open invoice, we still record a Payment — without a `LinkedTxn`. QB treats it as a credit balance for that customer. We call this an **Unapplied Payment**.
- Operator policy: in some periods we record it as a **Credit Memo** instead. Both must be supported.

### 3.6 Failed match
- If a transaction can't be matched to any customer (e.g., garbled description), it's routed to a **needs_saasant** CSV that the operator manually reconciles via SaasAnt (a QB import tool).
- Never push to a "suspense customer" — that's a rule we learned the hard way.

---

## 4. Chart of accounts (current QB, exact IDs)

| QB Id    | Name                          | Type              | Purpose                                                |
|----------|-------------------------------|-------------------|--------------------------------------------------------|
| **785**  | **Kijichi Collection AC**     | Bank              | **Default deposit account for ALL BRAIN payments**     |
| 783      | Elegansky Collection AC       | Bank              | Secondary collection account                           |
| 813      | Bank                          | Bank              | Legacy/empty                                           |
| **804**  | **Kijichi Group Loan**        | Other Current Asset| A/R-side counterpart, all loans receivable             |
| 800      | Kijichi Disbursement          | Expense           | Outgoing loan funding                                  |
| 793      | Undeposited Funds             | Bank              | QB default; **we explicitly avoid this**               |
| 751      | Bank charges                  | Expense           | NMB / CRDB transaction fees                            |

Every `Payment` BRAIN creates sets `DepositToAccountRef = 785`. The env var `QB_DEFAULT_DEPOSIT_ACCT_ID` overrides this (defaults to `785`). If the override is wrong, QB silently routes to Undeposited Funds and the operator's reports break.

**Frappe equivalent:** a single "Bank Account" doctype entry, linked to a Chart of Accounts node. Migration must preserve the 1-1 mapping or reports based on that account will lie.

---

## 5. The data flow (one payment, end to end)

1. **Customer pays** TZS 25,000 at an NMB agent at 09:36:46 EAT.
2. **NMB statement** records a credit on Elegansky's account with description `"Cash Deposit Agency banking - ... Description MC213FLM!! From X => Y"`.
3. **Worker scrapper** (cron tick or fire-button) logs into NMB ibanking, exports today's statement in a 3-way amount split:
   - Small: TZS 0 – 12,000
   - Mid: TZS 12,001 – 12,500
   - Large: TZS 12,501 – 100,000,000
   - The 3 CSVs are concatenated and uploaded to the transaction-processor.
4. **transaction-processor** parses each row, extracts the `MC...` reference, looks up the customer by reference / phone / name, and:
   - If matched and we have an invoice → appends to the channel's `PASSED` sheet tab.
   - If matched but only savings → appends to `PASSED_SAV` tab.
   - If unmatched → appends to `FAILED` tab (for SaasAnt manual reconciliation).
   - Returns processed/passed/skipped/failed counts.
5. **BRAIN tick** fires (e.g., `loolmalas1000` at 10:00 EAT):
   - Calls `runAllCycles()` on the worker → scrappers run again to fill the 03:00–10:00 gap.
   - Calls `POST /api/payment-batches/start/<channel>` per channel.
   - The **catchup planner** reads the PASSED sheet, finds the last `end of <tick>` marker in column K, builds a window list from that marker to now (split by the 16:16 EAT business-day boundary).
   - For each window, BRAIN:
     - Reads the rows.
     - Loads each customer's open invoices from QB (cached 5 min, keyed by AS_OF).
     - Runs the **FIFO matcher** (§9) to split each transaction across invoices.
     - QB pre-flight dedup: scans `PrivateNote` of last 60 days of Payments to skip refs already pushed.
     - Calls `qbBatchCreatePayments()` (batched, up to 30 at a time) for the matched ones.
     - Calls `qbBatchCreateCreditMemos()` / `qbBatchCreateUnappliedPayments()` for the unmatched.
     - Writes column I (`Fetched at: <ISO>`), column J (`<qb_id>|<ISO>`), column K (`end of <tick_name>`) back to the sheet.
6. **QB** closes the invoice, increases the Kijichi Collection account balance.
7. **Mirror poller** (CDC) picks up the new Payment within 30s and writes to `qb_payments` mirror table.
8. **Motorcycle service** polls BRAIN's arrears endpoint, sees this customer no longer has an open invoice past-due, sends a "turn on" signal to the bike.

The whole loop from customer-pays to bike-on must fit inside ~10 minutes during business hours. This drives the 5-minute scrapper POC currently in development.

---

## 6. Sheet schema (the staging area)

Each channel has one Google Sheet with multiple tabs. The relevant tab is `PASSED` (or `BANK_PASSED` for iPhone). Row layout (1-indexed columns):

| Col | Meaning                | Example value                                       |
|-----|------------------------|-----------------------------------------------------|
| A   | row id (operator-visible) | `43055`                                          |
| B   | timestamp              | `15.06.2026 09:36:46`   (DD.MM.YYYY HH:MM:SS, EAT) |
| C   | bank                   | `NMB`                                              |
| D   | full description       | `101 - NMB Head Office - Cash Deposit...`          |
| E   | amount                 | `18000`     (TZS)                                  |
| F   | phone / agent ref      | `MC213FLM`                                         |
| G   | customer name          | `EMMANUEL RAPHAEL PETER`                           |
| H   | invoice DocNumber      | `101AGD1261665169`                                 |
| I   | Fetched-at claim       | `Fetched at: 2026-06-15T07:08:07.844Z`             |
| J   | QB receipt             | `1712138 \| 2026-06-15T07:08:25.799Z`              |
| K   | tick marker            | `end of loolmalas1000:catchup_2026-06-15_business_2026-06-15` |
| L   | QB_DUPLICATE flag      | `QB_DUPLICATE` (rare; processor marks pre-known dup)|

**Rules the planner relies on:**
- A row with col I or col J **non-empty** is treated as "already claimed or pushed" → planner skips it. (Edge case bug: a stray value in col I from another script will cause that row to be skipped indefinitely. See §13.)
- A row with col K text matching `end of <tick>` is a **marker row** — its timestamp anchors the next window's `since_iso`.

**The 3 channel sheets:**

| channel       | suffix | sheet name on dashboard      |
|---------------|--------|------------------------------|
| `nmbnew`      | **N**  | NMB PASSED                   |
| `bank`        | **B**  | CRDB PASSED                  |
| `iphone_bank` | **P**  | iPhone BANK_PASSED           |

The suffix is appended to the Payment's `PrivateNote` and to dedup keys so a hypothetical NMB ref `MC213FLM` collides cleanly with a hypothetical CRDB `MC213FLM` only when intentional.

---

## 7. The 9-tick auto-upload schedule

The worker runs 9 cron ticks per day, all in EAT. Each tick runs scrappers → payments (for `nmbnew` + `bank` sequentially; `iphone_bank` is currently excluded by operator decision).

| Tick name       | EAT time | UTC cron     | What it covers                                  |
|-----------------|----------|--------------|-------------------------------------------------|
| `meru0100`      | 01:00    | `0 22 * * *` | Tail of yesterday's evening transactions        |
| `meru0300`      | 03:00    | `0 0 * * *`  | Today's earliest morning                        |
| `hanang0700`    | 07:00    | `0 4 * * *`  | Today's pre-work morning                        |
| `loolmalas1000` | 10:00    | `0 7 * * *`  | Mid-morning                                     |
| `lengai1230`    | 12:30    | `30 9 * * *` | Lunch hour                                      |
| `mawenzi1400`   | 14:00    | `0 11 * * *` | Early afternoon                                 |
| `kili1615`      | 16:15    | `15 13 * * *`| **Last tick that pays as today's TxnDate**      |
| `kibo1900`      | 19:00    | `0 16 * * *` | First tick that flips to **tomorrow's TxnDate** |
| `kibo2100`      | 21:00    | `0 18 * * *` | Last tick of the day                            |

### 7.1 The 16:16 EAT business-day boundary
This is the single most important business rule:

- Transactions occurring **before 16:16 EAT** belong to **today's** business day.
- Transactions occurring **at 16:16:00 EAT or later** belong to **tomorrow's** business day.

The planner expresses this as: a tick at `now ≥ 16:16` splits its window into:
- A "window A" capped at 16:15:59.999 today → `as_of=today, txn_date=today`.
- A "window B" starting at 16:16:00 → `as_of=today, txn_date=tomorrow`.

When `kili1615` fires at exactly 16:15:00 EAT, it must NOT cross the boundary; the window cap is 16:15:59.999. When `kibo1900` fires at 19:00 EAT, the entire window is post-boundary and the TxnDate is tomorrow.

**This boundary is operator policy, not legal/regulatory.** It exists because end-of-day reconciliation cuts the books at that point.

### 7.2 Asymmetric failure policy
A tick can complete with partial scrapper success:
- **NMB ok + CRDB ok** → fire payments for both channels.
- **NMB ok + CRDB fail** → fire payments anyway (CRDB is low-volume, NMB carries the load).
- **NMB fail** → **SKIP payments entirely**. NMB is the load-bearing channel; firing without it is not worth the risk.

This rule was added 2026-06-15 after the CRDB empty-day false-fail incident.

### 7.3 CRDB empty-day quirk
When CRDB has zero transactions for a day, the exported `.xls` is a 10-line shell. The transaction-processor rejects it with HTTP 500 (`"Passed header=[12], len of 1, but only 10 lines in file"`). The worker now catches that exact error pattern and treats the day as "0 records, success" — otherwise it would burn 3 × 10-minute retry attempts.

---

## 8. The catchup planner (`computeCatchupPlan`)

Given a channel's sheet + the current UTC ms, produce an ordered list of windows to fire. Pseudocode:

```
find the LAST row whose col K starts with "end of "  → marker_row
if no marker: return []  (caller fires a default window via prepareAutoUpload)
parse marker_row.col_B as EAT timestamp → marker_ms

dates = walk from marker_eat_date to today_eat_date inclusive
plan = []
for D in dates:
  A: since=max(marker_ms+1, 00:00 EAT D)
     until=min(16:16 EAT D, now+1)
     if A has rows in sheet below marker → push {kind:A, as_of:D, txn_date:D, ...}
  B: since=max(marker_ms+1, 16:16 EAT D)
     until=min(00:00 EAT D+1, now+1)
     if B has rows in sheet below marker → push {kind:B, as_of:D, txn_date:D+1, ...}
return plan
```

Key invariant: **`as_of` and `txn_date` differ only for kind=B windows**, where the transactions happened today (`as_of=today`) but post the 16:16 boundary so they pay tomorrow's books (`txn_date=tomorrow`).

Edge case fixed 2026-06-15: there used to be an early return when `marker_date === today_date`, meant as an optimization. It was wrong — it skipped the incremental window from `marker_ms+1 → now` when the marker happened to be on today's date (which is the common case for any tick after the first one of the day). Removing the early return fixed silently-dropped intra-day payments.

---

## 9. The payment matcher (`processInvoicePayments`)

**Sacred algorithm — bit-for-bit equivalent to the original invoice-payment-app.** Frank's hard rule: do not edit this without his approval.

Input:
- A list of customers' open invoices, each with `{ customerKey, qbId, docNumber, balance }`.
- A list of bank transactions for those customers, each with `{ customerKey, receivedTimestamp, amount, memo, bankRef }`.

Algorithm:
1. Group invoices by customer; sort each group **newest-first** by issue date.
2. Group transactions by customer; sort each group **oldest-first** by `receivedTimestamp`.
3. For each customer, walk transactions oldest → newest:
   - Take the oldest unused transaction with amount `T`.
   - Take the newest open invoice with balance `B`.
   - If `T ≥ B`: close that invoice (pay `B`), reduce `T -= B`, advance to the next-newest invoice with the remainder. Continue until `T = 0` or no more open invoices.
   - If `T < B`: pay `T` against that invoice, leaving a balance; transaction is fully spent.
4. Anything left over (transactions with no invoice to apply to) → unused list.

The "newest invoice first, oldest transaction first" combination is intentional. It reflects how Frank's operators expect overflow to work, and it produces results matching the manual reconciliation report.

**Edge cases the matcher handles:**
- A single transaction overflowing into 3+ older invoices (`PrivateNote` records every linked invoice id).
- A customer with savings-only deposits (matcher leaves them in the unused list; routed to Credit Memo / Unapplied Payment).
- A customer whose oldest invoice has more balance than the transaction (partial payment; invoice stays open).

---

## 10. QB OAuth & token management

- **Authorization Code grant** flow, registered to a single Realm ID (the operator's QB company).
- Tokens stored in Postgres table `qb_tokens` (one row, `id=1`): `access_token`, `refresh_token`, `access_token_expires_at`, `refresh_token_expires_at`.
- BRAIN auto-refreshes the access token ~5 min before expiry. Refresh token lifetime is 100 days; if it expires Frank must re-authorize via the dashboard `/connect` flow.
- All QB API calls go through `qbQuery(sql)` (for SELECTs) or `qbPost(entity, body)` (for creates/updates) — both auto-attach the bearer token.

Tokens used to live in a `tokens.json` file. That migration is complete; new deployments use Postgres only.

---

## 11. QB entities BRAIN reads / writes

### 11.1 Customer
- Read: by Id, by DisplayName (batched IN-list), full scan paginated.
- Write: never directly. Customer creation is operator-driven via QB UI.
- Fields used: `Id`, `DisplayName`, `FullyQualifiedName`, `Active`, `Balance`, `ParentRef`, `CompanyName`.
- The `ParentRef` is the loan-officer hookup. `FullyQualifiedName` (e.g., `"KIJICHI BRANCH:AGRICOLA BODA:Furaha Rashidy Boda:OMARY JUMA KIPENGERE MC678ELL"`) encodes the full hierarchy in colon-delimited segments.

### 11.2 Invoice
- Read: by Id, by CustomerRef, by Balance > 0 (paginated for arrears reports).
- Write: never (loan disbursement is a separate process).
- Fields used: `Id`, `DocNumber`, `Balance`, `TotalAmt`, `DueDate`, `TxnDate`, `CustomerRef`, `Line` (for inspection only).
- The `DocNumber` format encodes branch / product / sequence. Operators read these by sight.

### 11.3 Payment
- Read: by `PrivateNote LIKE`, by `TxnDate`, by `DepositToAccountRef`.
- Write: single + batched (up to 30/op via `/batch` endpoint).
- Required fields:
  ```
  CustomerRef:           { value: "<customer_id>" }
  TotalAmt:              25000
  TxnDate:               "2026-06-15"               // YYYY-MM-DD
  PaymentMethodRef:      { value: "<method_id>" }   // usually "Cash"
  DepositToAccountRef:   { value: "785" }           // Kijichi Collection AC
  PrivateNote:           "MC213FLM|N"               // bank ref + suffix
  LinkedTxn:             [ { TxnId: "<invoice_id>", TxnType: "Invoice", TxnLineLink:[{...}] } ]
  ```
- For **unapplied payments**, `LinkedTxn` is omitted.
- For **batch creates**, body is `{ BatchItemRequest: [{ bId, operation:"create", Payment: {...} }, ...] }`. Responses include `bId` echoed back so callers map results to requests.

### 11.4 CreditMemo
- Same `CustomerRef` + `TotalAmt` + `TxnDate` shape, with a `Line.SalesItemLineDetail.ItemRef` pointing at a generic "Cash deposit" item.
- Used when operator policy prefers a credit memo over an unapplied payment.

### 11.5 Account
- Read: `SELECT Id, Name, AccountType, AccountSubType, CurrentBalance, Active FROM Account WHERE Active = true`.
- Used by the QB health-check endpoint and the chart-of-accounts admin tool.
- Never written.

### 11.6 Other read-only entities used in reports
- `Bill`, `Vendor` (count summaries only).
- `Item` (referenced via CreditMemo).
- `Class` (some reports group by Class; verify if you use Class tracking).

---

## 12. The mirror tables + CDC poller

BRAIN's reporting hot path can't afford a QB round-trip on every page load (QB is slow + rate-limited). So we keep a **local Postgres mirror** of `qb_invoices`, `qb_payments`, `qb_credit_memos`. The mirror is kept fresh by:

1. **Webhooks** from QB (Customer / Invoice / Payment events) → BRAIN endpoint → upsert mirror row.
2. **CDC poller** every ~30s as a backstop in case webhooks are missed. Walks `MetaData.LastUpdatedTime > since`.
3. **Initial backfill** on first deploy: paginates the full entity space.

The arrears report, the officer collections report, the mega-report — all read the mirror, not QB live. They typically respond in <500 ms vs ~30s if hitting QB.

Frappe equivalent: probably not needed if Frappe's own DB is fast enough to query directly. But preserve the **invariant**: the reporting hot path must not block on the ERP API for typical operator queries.

---

## 13. Recall flow (voids)

When operators fire a bad batch (wrong window, wrong customer set, etc.) they need to undo it cleanly. The recall flow:

1. `POST /api/payment-batches/:id/recall` — operator-clicked or scripted.
2. For each `payment_uploads` row in the batch with `status='created'`:
   - Call QB `void` (Payment) or `delete` (CreditMemo) — note: QB "voids" a Payment (zeros TotalAmt, marks `Voided` flag) but doesn't delete it. QB "deletes" a CreditMemo entirely.
3. Clear column J (qb receipt) and column I (Fetched at) on the corresponding sheet rows so they become eligible for re-fire.
4. Clear the matching `consumed_transactions` rows so the planner sees the refs as fresh again.
5. Update `payment_batches.status = 'recalled'` + record `recalled_at`.

Hard rule: **never recall by sheet window alone.** Recall by `batch_id` because the K-marker structure already tells us which rows belong to which batch. A "recall by window" was tried once and accidentally voided records from a different batch that happened to overlap the window.

A separate void-by-sheet-window endpoint exists for ghost-cleanup (rare maintenance scenarios). It's gated by a manual confirm flag.

---

## 14. Concurrency + locking

### 14.1 Channel locks
- `auto_upload_locks` table holds one row per channel currently being fired (`{channel, holder, locked_at}`).
- The `start/:channel` endpoint INSERTs into this table; conflicts return HTTP 409.
- Stale locks (older than 5 min) are reclaimed automatically.
- The worker polls a lock-status endpoint to know when a channel fire has fully completed (so it can move on to the next channel without overlapping arrears-cache state).

### 14.2 Arrears cache
- BRAIN caches each channel's open-invoice snapshot keyed by `as_of`, TTL 5 min.
- **Must be cleared between sequential fires** in the same tick. Otherwise, after NMB pays customer X's last invoice, the bank fire might see stale arrears showing that invoice as still open and pay it again.
- The endpoint `POST /api/admin/clear-arrears-cache` flushes the cache; the worker calls it between channel fires.

### 14.3 Kill switches
- `STATEMENT_PULL_PAUSED=true` (env) → worker skips all scrapper ticks.
- `app_settings.statement_pull_enabled='false'` (DB) → same effect, dashboard-toggleable.
- `app_settings.auto_upload_enabled='false'` (DB) → BRAIN's start endpoint returns 503 for scheduled-tick traffic. Dashboard fires (`tick_name=heisenberg` or any JWT request) bypass this gate.

---

## 15. Reports & queries (the operator UX)

### 15.1 Arrears
- Endpoint: `GET /api/arrears`
- Returns per-customer open balance, sorted by customer name.
- Hits the `qb_invoices` mirror, summed by CustomerRef.
- Used by the dashboard `/arrears` page + by operators exporting to xlsx for collection review.

### 15.2 Officer collections
- Endpoint: `GET /api/officer-reports/today`
- Walks the customer hierarchy: for each loan officer (parent), sum today's Payments across all child customers.
- Backed by `daily_officer_snapshot` (pre-aggregated table refreshed every 30s).
- Officer-report exclusions: 10 specific QB officer-level customers are hidden (sibling co, blocked, iPhone-only, inactive). The exclusion list is hard-coded in BRAIN — must be ported.

### 15.3 Mega-report
- 5-section dashboard page: A (account balances), B (period collections), C (arrears trend), D (officer leaderboard), E (channel split).
- Pre-warmed cache (30s) for the most-common windows; bulk-range QB query + sheet cache yielded a 38× speedup over the naive version.
- Each cell supports a click-through to a detailed view; each cell has a hover trend popover.

### 15.4 Statement Cycles
- The worker's status page. Shows the last NMB + CRDB cycles, recent cycle history with passed / skipped / failed counts, and Fire buttons.

### 15.5 Batches
- Lists `payment_batches` rows. Per-batch detail page (4 tabs): summary, paid, unused, sheet rows. Recall button.
- Three quick-download icons per row (planned): `invoices.xls`, `paid.csv`, `unused.csv`.

---

## 16. Webhooks BRAIN ingests from QB

QB pushes events to BRAIN's webhook endpoint. The events we act on:
- `Customer.create` / `Customer.update` → upsert `customer_officer_map` + mirror table.
- `Invoice.create` / `Invoice.update` → upsert mirror; recompute arrears for that customer if balance changed.
- `Payment.create` / `Payment.update` → upsert mirror.
- `Payment.delete` (= void detected) → mark mirror voided; trigger a cascade if the void should also clear a sheet's column J (it usually shouldn't — the column J record is the audit trail).

Each event includes a `lastUpdated` timestamp and an entity Id. We re-fetch the full entity from QB because the webhook payload is a header-only notification.

Subscription is realm-wide; we filter in code by the entity types above.

---

## 17. Suffix system (`N` / `B` / `P`)

The suffix appears in three places:
1. `PrivateNote` on QB Payments: `<bank_ref>|<suffix>` (e.g., `MC213FLM|N`).
2. Dedup keys: `<customer_id>|<bank_ref>|<suffix>`.
3. Memo column J in the sheet (occasionally, depending on tick name).

It prevents cross-channel collisions when two banks happen to issue the same reference number, and it's the operator's shorthand for "where did this payment come from" in QB reports.

**Frappe must preserve the suffix.** Reports group by it; recall logic uses it to scope the void.

---

## 18. Tricky things the migration agent will hit

### 18.1 Wall-clock vs sheet-clock
- Sheet column B is **wall-clock EAT** (no timezone suffix). When BRAIN parses it, it must subtract 3 hours to get true UTC. A row saying `15.06.2026 09:36:46` is `06:36:46 UTC`.
- An incident in 2026-06-04 lost 91 rows / 1.6M TZS because the parser treated `12:04` as UTC when it was actually `12:04 EAT (= 09:04 UTC)`, and those rows fell outside the window filter.

### 18.2 Column I as a "claim" marker
- BRAIN writes `Fetched at: <ISO>` to column I **before** pushing to QB. If the push crashes mid-batch, column I is set but column J is empty → the row stays "claimed but un-pushed."
- A limbo-batch recovery sweep at boot detects this and releases stuck locks.
- Risk: any stray value in column I (e.g., from manual editing, or a buggy other script) will cause that row to be skipped indefinitely. Seen at row 43055 on 2026-06-15 with a value `9633000042` of unknown origin. Investigation showed: not in QB, not paid, the row was silently skipped. Operator had to clear col I manually.

### 18.3 Date period state caching in NMB SPA
- After downloading a statement with "Select Date Range," NMB's SPA caches that choice. The next time you navigate to the same account, it lands on the date-range view, not the dashboard view — even if you visit the dashboard URL first.
- POC for the 5-min live scrapper had to work around this by opening a fresh browser tab between cycles (cookies preserve, DOM state resets).

### 18.4 CRDB empty-day quirk (see §7.3)
Treat empty-day rejection as success.

### 18.5 NMB OTP relay
- Each fresh NMB login triggers a one-time-code SMS to the operator's phone.
- A "boss phone" relay app forwards the SMS to a BRAIN webhook (`/internal/tan/latest`); the worker polls that webhook for ~4 minutes after clicking Login.
- If the phone is off, the OTP never reaches BRAIN → login fails → 2 more retry attempts at 10-min intervals → ultimately tick skips.
- The OTP relay is a single point of failure. SMS gateway via APK (replaces Africa's Talking dependency) is on the roadmap.

### 18.6 Dry-run batches
- `POST /api/payment-batches/start/:channel` with `dry_run=true` produces a `payment_batches` row + `payment_uploads` rows but skips QB calls and sheet writes.
- Side effect: dashboard "recent batches" list will show the dry-run alongside real batches. Always check `failure_reason` for the string `"dry_run"` before counting a batch as a real push.
- Cleanup: `POST /api/admin/delete-dry-run-batch/:id` will safely delete a batch + its uploads ONLY if it's flagged as dry-run.

### 18.7 The "heisenberg" tick name
- When an operator fires a payment from the dashboard's Heisenberg page (manual catchup), the `tick_name` is literally `heisenberg`.
- This tick name **bypasses** the `auto_upload_enabled` gate, which is intentional: manual operator action overrides scheduled-tick policy.
- Frappe equivalent must preserve the "operator can always force a fire" affordance.

### 18.8 The `start_button` tick name
- Same bypass behavior as `heisenberg`. Used by the dashboard's `Start` button on the catchup-plan view.

---

## 19. QB → Frappe entity mapping (starting point)

| QB entity                   | Frappe doctype                                                  | Notes                                                                                       |
|-----------------------------|------------------------------------------------------------------|---------------------------------------------------------------------------------------------|
| `Customer` (top-level)      | `Customer`                                                       | Use `customer_group` for officer-level grouping or `parent_customer` if available.          |
| `Customer` (loan officer)   | `Sales Person` or a custom `Loan Officer` doctype                | Frappe doesn't natively model customer hierarchy; pick the cleaner abstraction.             |
| `Invoice`                   | `Sales Invoice`                                                  | `DocNumber` → `name` or a custom field `bank_ref_no`.                                       |
| `Payment`                   | `Payment Entry`                                                  | `LinkedTxn` → `references` table linking the Payment Entry to specific Sales Invoices.      |
| `CreditMemo`                | `Sales Invoice` with `is_return=1` OR `Journal Entry`            | Choose based on whether the credit should offset future invoices automatically.             |
| `Account`                   | `Account`                                                        | Recreate the COA structure 1-to-1; preserve account IDs in a custom field for cross-ref.    |
| `Class` (if used)           | `Cost Center` or `Project`                                       | Verify whether QB Class tracking is used in current reports.                                |
| `Bill` / `Vendor`           | `Purchase Invoice` / `Supplier`                                  | Used only for count summaries today; low priority.                                          |
| `PaymentMethodRef`          | `Mode of Payment`                                                | Map "Cash", "Bank Transfer" etc.                                                            |
| `DepositToAccountRef`       | `paid_to` on Payment Entry (Asset account)                       | Always Kijichi Collection AC → corresponding Frappe Bank Account.                           |
| `PrivateNote`               | `remarks` or a custom field `bank_reference`                     | Must remain queryable (the dedup scan reads it).                                            |

Mappings to clarify with the operator before cutover:
- Loan-officer hierarchy: parent customer vs sales person vs custom doctype?
- Branch encoding in DocNumber: keep as opaque string, or split into a custom `branch` field?
- Multi-currency: not used today, but Frappe forces a choice.

---

## 20. Migration strategy (suggested phasing)

1. **Phase 0 — Read-only mirror.**
   - Stand up Frappe with the empty COA matching QB's, plus a one-time customer + invoice import (CSV from QB).
   - BRAIN writes payments to QB as today; also writes to Frappe (dual-write).
   - Validate reports match between the two systems for at least 7 days.
2. **Phase 1 — Cut over reads.**
   - Arrears, officer-report, mega-report start reading from Frappe instead of QB mirror.
   - Keep QB as the source of truth for writes for one more week.
3. **Phase 2 — Cut over writes.**
   - Payment creation switches to Frappe; QB receives a one-way mirror via webhook for audit only.
   - Keep QB OAuth alive in case operators want to inspect old data.
4. **Phase 3 — Decommission QB.**
   - Disable QB OAuth refresh.
   - Archive `qb_*` mirror tables.

At every phase, the 5-min POC scrapper, the 9 tick crons, the suffix system, the 16:16 boundary, the FIFO matcher, the recall flow, and the kill switches must remain bit-for-bit equivalent. The migration is about swapping the ERP backend, not redesigning operations.

---

## 21. Open questions for the migration agent

- Does Frappe's Payment Entry support a "multiple invoice references with partial allocation per reference" cleanly enough to model the FIFO overflow case? (BRAIN sometimes splits one transaction across 5 invoices.)
- How will Frappe handle the suffix on the dedup key? Custom field + index, or embed in a naming series?
- What's the equivalent of QB's batch endpoint (up to 30 ops per round-trip)? Frappe's `/api/method/frappe.client.insert_many` may work but typically slower per row.
- Where will OAuth-style token storage live? Frappe uses its own API key/secret model.
- Does Frappe support webhooks granular enough to fire on per-doctype changes (Customer / Sales Invoice / Payment Entry only)?
- How will the motorcycle-disable service consume Frappe's arrears view? REST? Realtime websocket?

---

## 22. Where to look in the code (for the migration agent, when Frank shares it)

When Frank shares the source, these are the files / regions the migration agent should read first:

- **`src/server.js`** — BRAIN's express routes, OAuth flow, `qbQuery` helper, batch QB writers (`qbBatchCreatePayments`, `qbBatchCreateUnappliedPayments`), `qbCreateCreditMemo`, all `/api/*` endpoints, mirror table refresh.
- **`src/payment-batches.js`** — the planner (`computeCatchupPlan`), the matcher (`processInvoicePayments`), the orchestrator (`prepareAutoUpload`, `runAutoUploadBackground`), the `/api/payment-batches/*` endpoints.
- **`src/runner/*`** — the legacy upload scripts ported from `.mjs`. Some logic still lives there.
- **`web/`** — the Vite/React dashboard. Mostly read-only for the migration but useful for understanding operator UX.

In the worker repo (`eleganskyCrdb`):
- **`src/statementPull/runWorker.ts`** — the 9-tick scheduler, asymmetric NMB-FAIL policy, fire-request poller for manual scrapes.
- **`src/statementPull/runNmbCycle.ts`** + **`src/portal/nmbLogin.ts`** / **`nmbStatement.ts`** — NMB scraper, OTP relay, 3-batch amount split, Big Data Statement popup handling.
- **`src/statementPull/runCrdbCycle.ts`** + **`src/portal/crdbLogin.ts`** / **`crdbStatement.ts`** — CRDB scraper, session keepalive, empty-day handling.
- **`src/statementPull/uploadToProcessor.ts`** — the bridge to the transaction-processor service.
- **`src/poc/nmbLivePuller.ts`** — the 5-min POC; demonstrates persistent-session + fresh-tab pattern for keeping NMB alive without per-pull OTPs.

---

## 23. Contact + escalation

- **Operator:** Frank Mlaki, fmlaki@gmail.com, +255 (Tanzania).
- **Working hours:** business hours East Africa Time. Most ticks fire when Frank is awake; he intervenes on OTP timeouts and dashboard heisenberg fires.
- **Sacred constraints (from prior incidents):**
  - The matcher in `processInvoicePayments` is not to be edited.
  - No test writes to live QB (Payments / Invoices / CreditMemos), even with intent to delete after — analysts watch the ledger.
  - Never push to a "suspense customer"; failed matches go to SaasAnt CSV.
  - Don't deploy during an active payment fire (`auto_upload_locks` or `agent_sessions` has running rows).
- **Memory document:** Frank maintains an institutional memory at `~/.claude/projects/-var-www-html-EleganskyBrain/memory/MEMORY.md`. Read it when picking up the project.

---

*Last updated: 2026-06-15. This document is the migration brief. The code is sacred. Read this, design Frappe equivalents, then ask Frank for code excerpts when you need to verify behavior.*
