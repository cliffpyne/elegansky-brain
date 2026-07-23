# Elegansky Payment-Date Semantics — READ BEFORE TOUCHING ANY DATE

**Audience:** every service/session that reads or writes Elegansky payment data
(Frappe/ERPNext "ESTHER" book, transaction-processor, m6pm, analysts' tools).
**Authority:** Frank Mlaki (operator). Enforced by BRAIN (elegansky-brain).
**Status:** LAW. Do not "fix", "normalize", or migrate date storage anywhere
without Frank's explicit sign-off. If a date looks wrong to you, report it —
do not change it.

---

## 1. The business day is kili1615, not midnight

Elegansky's payment day runs **16:15 EAT → 16:15 EAT next day** (the
"kili1615" boundary). All reporting, arrears comparisons, and Frank's
marker-to-marker sheet accounting use this clock.

A payment physically made at 20:00 on day D belongs to **payment day D+1**.
This is intentional. It is NOT a bug, NOT a timezone error, NOT drift.

## 2. The four date rules (as enforced in QB and BRAIN)

| Case | TxnDate / posting_date |
|---|---|
| Fresh row, before 16:15 on day D | D |
| Fresh row, after 16:15 on day D (evening tail) | **D+1** (kili roll) |
| Late/retro row (arrived days late), first-ever push | **the firing day** (rule `e151d0b`) |
| Voided-and-replayed payment (existed before, re-pushed) | **its ORIGINAL payment day** (rule of 2026-07-23, commit `3d2bf7a`) |

The last rule exists because reposting old money on today's date inflates
today's collections and drains the original day's ledger. BRAIN enforces it
automatically in the QB path; the Frappe path is scheduled to get the same
treatment for backfill/recon fires (until then, some recon batches posted
2026-07-23 carry the push date — Frank knows; leave them alone).

## 3. "The real date isn't stored" is FALSE — where truth lives

- **Every consumed ref's real sheet timestamp** is stored in BRAIN's Postgres:
  `consumed_transactions.sheet_ts` (exact second the row landed at the bank).
- **Every batch's payment-day** is `payment_batches.txn_date`.
- **NMB references** (`101AGD1262xx...`) encode the bank date in the ref body.
- **CRDB / iPhone references** (`19f8972ac3539aa1`-style) encode the exact
  bank timestamp: **the first 11 hex characters are a Unix epoch in
  milliseconds**. Decode: `int(ref[:11], 16) / 1000` → UTC seconds
  (+3h = EAT). Example: `19f8972ac3539aa1` → 2026-07-22 13:50:21 EAT.

So the real collection moment of ANY payment is always recoverable. Nobody
needs to store "the real date" in Frappe — it would actually be wrong to,
because ledgers run on payment-day accounting (rule #1), not physical time.

## 4. Hard rules for the Frappe/ESTHER side

1. **Never change `posting_date` of any Payment Entry** — not manually, not
   by script, not as a "data quality fix". Date corrections flow ONLY through
   BRAIN (which patches QB via `qbPatchPaymentTxnDate` and will own the
   Frappe equivalent), with Frank's approval, so both books and BRAIN's DB
   stay consistent.
2. **Never alter, re-suffix, or "clean up" reference_no values.** Suffixes
   are routing law: `N`/`B`/`P` = QB-bound (NMB/CRDB/iPhone), `NS`/`CS` =
   SAVCOM, `V` appended by Frappe ingest. Manual entries must use a clearly
   manual reference (e.g. `MANUAL-YYYY-MM-DD`) — never a format that
   imitates bank refs.
3. **Never post, reverse, or void payments that BRAIN manages** outside
   BRAIN's endpoints. BRAIN's dedup keys on references; side-channel writes
   create ghosts BRAIN cannot vouch for (as of 2026-07-23 there are already
   460,500 TZS of hand entries under `MANUAL-2026-07-22` and 759,700 TZS
   hand-typed in QB that reconciliation must carry as unverifiable).
4. **Do not infer duplicates from the sheet's column-A id** — that id (from
   transaction-processor) collides across thousands of rows. Transaction
   identity = the bank reference, nothing else.

## 5. If something looks wrong

Report it to Frank / the BRAIN session with the ref(s). BRAIN can decode the
real timestamp, show every generation of the payment (pushed / voided /
replayed), and reconcile against QB, Frappe, and the sheet to the shilling —
it does this daily. Changing stored data to match your assumption destroys
the audit trail that makes that possible.

— Prepared by BRAIN ops session, 2026-07-23. Questions → Frank.
