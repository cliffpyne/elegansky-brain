#!/usr/bin/env node
// List QB Payments + CreditMemos in a time window — audit trail for an upload.
//
// Usage:
//   node tools/qb-activity.mjs --since=2026-05-31
//   node tools/qb-activity.mjs --since=2026-05-31 --until=2026-05-31
//   node tools/qb-activity.mjs --since=2026-05-31 --kind=payment
//   node tools/qb-activity.mjs --since=2026-05-31 --json
//
// Use it BEFORE and AFTER an upload to see exactly what got created. Default
// `kind=all` returns both Payments and CreditMemos.

import { brainGet, parseArgs, fmtMoney } from './_common.mjs';

const args = parseArgs(process.argv);
const since = args.since;
if (!since) {
  console.error('usage: node tools/qb-activity.mjs --since=YYYY-MM-DD [--until=YYYY-MM-DD] [--kind=payment|credit_memo|all] [--json]');
  process.exit(2);
}

const data = await brainGet('/api/qb/activity', {
  since, until: args.until, kind: args.kind || 'all',
});

if (args.json) {
  console.log(JSON.stringify(data, null, 2));
  process.exit(0);
}

console.log('');
console.log(`╔══ QB ACTIVITY ${data.since} → ${data.until || 'today'} ═══════════════╗`);
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
