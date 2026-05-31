#!/usr/bin/env node
// List QB Payments + CreditMemos in a time window — audit trail for an upload.
//
// Usage (PREFERRED: filter by when QB recorded the row — captures what the
// upload actually CREATED regardless of back-dated TxnDate):
//   node tools/qb-activity.mjs --sinceCreated=2026-05-31T11:00:00Z
//   node tools/qb-activity.mjs --sinceCreated=NOW                  (last 5 min)
//
// Usage (filter by claimed TxnDate — older API, surfaces ALL payments dated
// on/after the date even if they were entered last year):
//   node tools/qb-activity.mjs --since=2026-05-31
//
// Other flags:
//   --until=YYYY-MM-DD       upper bound on TxnDate
//   --untilCreated=ISO       upper bound on Metadata.CreateTime
//   --kind=payment|credit_memo|all   default all
//   --json                   raw JSON output

import { brainGet, parseArgs, fmtMoney } from './_common.mjs';

const args = parseArgs(process.argv);
if (!args.since && !args.sinceCreated) {
  console.error('usage: node tools/qb-activity.mjs --sinceCreated=ISO [...] | --since=YYYY-MM-DD');
  console.error('       --sinceCreated is recommended for upload audit (filters by when QB recorded the row).');
  process.exit(2);
}

// Sugar: --sinceCreated=NOW → 5 minutes ago, suitable as "right-before-upload" baseline.
let sinceCreated = args.sinceCreated;
if (sinceCreated === 'NOW' || sinceCreated === 'now') {
  sinceCreated = new Date(Date.now() - 5 * 60_000).toISOString();
  console.log(`[qb-activity] --sinceCreated=NOW → ${sinceCreated}`);
}

const data = await brainGet('/api/qb/activity', {
  since: args.since, until: args.until,
  sinceCreated, untilCreated: args.untilCreated,
  kind: args.kind || 'all',
});

if (args.json) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

console.log('');
const window = data.sinceCreated
  ? `created ≥ ${data.sinceCreated}` + (data.untilCreated ? ` ≤ ${data.untilCreated}` : '')
  : `TxnDate ${data.since} → ${data.until || 'today'}`;
console.log(`╔══ QB ACTIVITY (${window}) ══════════════════════════╗`);
console.log(`║ Payments:    ${data.summary.payments.count.toString().padStart(4)}  ${fmtMoney(data.summary.payments.total).padStart(15)} TZS`);
console.log(`║ CreditMemos: ${data.summary.creditMemos.count.toString().padStart(4)}  ${fmtMoney(data.summary.creditMemos.total).padStart(15)} TZS`);
console.log(`╚════════════════════════════════════════════════════════════╝`);

if (data.payments.length) {
  console.log('\nPAYMENTS:');
  console.log('  qb_id'.padEnd(10) + 'date'.padEnd(12) + 'customer'.padEnd(36) + 'amount'.padStart(12) + '  memo');
  for (const p of data.payments) {
    const cust = (p.customer.name || p.customer.id || '?').slice(0, 32).padEnd(34);
    const memo = (p.privateNote || '').slice(0, 40);
    console.log('  ' + (p.qbId + '').padEnd(10) + (p.txnDate || '').padEnd(12) + cust + fmtMoney(p.totalAmt).padStart(12) + '  ' + memo);
    for (const li of p.linkedInvoices) {
      console.log('    → invoice ' + li.invoiceId + '  ' + fmtMoney(li.amount) + ' TZS');
    }
  }
}

if (data.creditMemos.length) {
  console.log('\nCREDIT MEMOS:');
  console.log('  qb_id'.padEnd(10) + 'date'.padEnd(12) + 'customer'.padEnd(36) + 'amount'.padStart(12) + '  remaining   memo');
  for (const cm of data.creditMemos) {
    const cust = (cm.customer.name || cm.customer.id || '?').slice(0, 32).padEnd(34);
    const memo = (cm.privateNote || '').slice(0, 30);
    console.log('  ' + (cm.qbId + '').padEnd(10) + (cm.txnDate || '').padEnd(12) + cust
      + fmtMoney(cm.totalAmt).padStart(12) + '  ' + fmtMoney(cm.remaining).padStart(9) + '   ' + memo);
  }
}
