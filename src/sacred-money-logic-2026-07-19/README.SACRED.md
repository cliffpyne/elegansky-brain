# Sacred Money Logic — frozen 2026-07-19

Verbatim backup taken **before** the retro-date allocation rewrite.
Frank's instruction: "before any changes save the sacred money logic for me brother"

## Files

- `payment-algorithm-v2.js.SACRED`
  Regular QB path — `processInvoicePaymentsWithForwardPay`.
  Phase 1: cap-no-overflow, invoices NEWEST-first, TX OLDEST-first.
  Phase 2: forward-pay leftover onto closest future invoice.
  Leftover after Phase 2 → QB Unapplied Payment.

- `apruna-divert.js.SACRED`
  APRUNA cohort — `foldAllocations`.
  Order: TODAY → oldest ARREARS → oldest FORWARD.
  Uses PHYSICAL payment day (kili1615 does NOT shift bucket).

- `frappe-push-sav.js.SACRED`
  ESTHER SAVCOM — `processInvoicePaymentsV2` (Phase 1 only).
  Same sort as Phase 1 QB. Leftover → hanging Frappe advance (Phase 2 disabled).

- `processInvoicePayments-DEAD-in-payment-batches.js.SACRED`
  The original sacred fn — DEAD CODE at time of backup, no callers.
  63 lines, cap-WITH-overflow. Kept for reference only.

## Restore

If a rewrite lands wrong:
```bash
cd /var/www/html/EleganskyBrain
cp src/sacred-money-logic-2026-07-19/payment-algorithm-v2.js.SACRED src/payment-algorithm-v2.js
cp src/sacred-money-logic-2026-07-19/apruna-divert.js.SACRED src/apruna-divert.js
cp src/sacred-money-logic-2026-07-19/frappe-push-sav.js.SACRED src/frappe-push-sav.js
git add src && git commit -m "restore: sacred money logic from 2026-07-19 backup"
git push
# then SSH VPS + git pull + systemctl restart brain.service
```
