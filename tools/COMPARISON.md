# SaasAnt vs BRAIN — comparison harness

Three CLI tools live in `tools/`:

| tool | purpose |
|---|---|
| `snap.mjs` | take a labeled `/arrears` snapshot, store it server-side |
| `diff.mjs` | diff two snapshots → see exactly what changed in QB |
| `qb-activity.mjs` | list QB Payments + CreditMemos in a time window |

All three read `BRAIN_REPORT_SECRET` (or fall back to `/tmp/brain_secret`),
and default to `https://elegansky-brain.onrender.com` (override with
`BRAIN_BASE`).

## The flow

```text
                                          tools/snap.mjs --label="baseline"
   Step 1.  Baseline snapshot       ─────►  → snap_id "AAA"
                                          tools/qb-activity.mjs --since=YYYY-MM-DD --json > /tmp/qb-pre.json

   Step 2.  SaasAnt upload           (operator: do the normal SaasAnt run)

                                          tools/snap.mjs --label="post-saasant"
   Step 3.  Post-SaasAnt snapshot   ─────►  → snap_id "BBB"
                                          tools/qb-activity.mjs --since=YYYY-MM-DD
   Step 4.  SaasAnt diff            ─────►  tools/diff.mjs AAA BBB

   Step 5.  Undo SaasAnt             (operator: void the payments / credit
                                       memos created in step 2 — qb-activity
                                       lists their qb_ids)
                                          tools/snap.mjs --label="back-to-baseline"
   Step 6.  Sanity snapshot         ─────►  → snap_id "CCC" — diff(AAA,CCC) should be ~zero

   Step 7.  BRAIN upload             (operator: POST the SAME paid/unused CSVs
                                       through /api/payment-batches, get batch_id)
                                          tools/snap.mjs --label="post-brain"
   Step 8.  Post-BRAIN snapshot     ─────►  → snap_id "DDD"
                                          tools/qb-activity.mjs --since=YYYY-MM-DD
   Step 9.  BRAIN diff              ─────►  tools/diff.mjs CCC DDD
                                            (should equal diff AAA BBB —
                                             same input, same effect on QB)

  Step 10.  Recall test             POST /api/payment-batches/<batch_id>/recall
                                          tools/snap.mjs --label="post-recall"
                                    ─────►  → snap_id "EEE" — diff(CCC,EEE) should be zero
```

## What "good" looks like

- **diff(AAA → BBB) == diff(CCC → DDD)** at per-customer aggregate. Same
  invoices fully paid, same partial paydowns, same totals. That's the
  green light to retire SaasAnt.
- **diff(CCC → EEE) ≈ zero**. Recall void'd every Payment + CreditMemo
  BRAIN created. Any non-zero rows are bugs to fix BEFORE going live.

## Common gotchas

- **Total balance can move on its own** between snapshots if anyone else is
  using QB (new invoices, manual payments, sales). Bracket each step
  tightly in time, and watch the per-invoice diff, not just the total.
- **QB drops invoices from the overdue list once balance hits 0** — those
  show up as `fully_paid` rows in the diff, with `delta = -original_balance`.
- **QB's `Payment.TxnDate` is the txn's own date, not the create date**.
  If SaasAnt back-dates a payment to the bank-statement date, set
  `--since` to that date, not today's.
- **The recall path needs the same QB tokens** that created the records.
  If `tokens.json` got wiped by a deploy in between, the recall will fail
  at the QB void step — task #24 (token persistence in Postgres) fixes this.
