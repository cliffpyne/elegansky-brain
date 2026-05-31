#!/usr/bin/env node
// Diff two /arrears snapshots — see what changed in QB between them.
//
// Usage:
//   node tools/diff.mjs <id_before> <id_after>
//   node tools/diff.mjs <id_before> <id_after> --json    # raw JSON
//
// Output (human mode):
//   - aggregate (row count + balance delta)
//   - per-invoice categories: paid_down, fully_paid, new, unchanged
//   - per-customer rollup (top 20 by absolute balance change)
//
// "Fully paid" = invoice present in BEFORE but absent in AFTER (QB drops
// invoices from the overdue list once they're paid). "Paid down" = same id,
// balance smaller after. "New" = only in AFTER.

import { brainGet, parseArgs, fmtMoney } from './_common.mjs';

const args = parseArgs(process.argv);
const [idBefore, idAfter] = args._;
if (!idBefore || !idAfter) {
  console.error('usage: node tools/diff.mjs <id_before> <id_after> [--json]');
  process.exit(2);
}

console.log(`[diff] fetching snapshots…`);
const [before, after] = await Promise.all([
  brainGet(`/api/arrears-snapshots/${idBefore}`),
  brainGet(`/api/arrears-snapshots/${idAfter}`),
]);
const A = before.snapshot;
const B = after.snapshot;

// Index by qbId (invoice unique id)
const idx = (rows) => {
  const m = new Map();
  for (const r of rows) m.set(String(r.qbId), r);
  return m;
};
const beforeIdx = idx(A.data);
const afterIdx = idx(B.data);

const paidDown = [];
const fullyPaid = [];
const newOnes = [];
const unchanged = [];
const balanceWentUp = []; // shouldn't happen on overdue invoices, but worth surfacing

for (const [id, b4] of beforeIdx) {
  const af = afterIdx.get(id);
  if (!af) {
    fullyPaid.push({ ...b4, delta: -b4.balance });
  } else if (af.balance < b4.balance) {
    paidDown.push({ ...af, before_balance: b4.balance, delta: af.balance - b4.balance });
  } else if (af.balance > b4.balance) {
    balanceWentUp.push({ ...af, before_balance: b4.balance, delta: af.balance - b4.balance });
  } else {
    unchanged.push(af);
  }
}
for (const [id, af] of afterIdx) {
  if (!beforeIdx.has(id)) newOnes.push({ ...af, delta: af.balance });
}

const sum = (arr, k = 'delta') => arr.reduce((s, r) => s + (Number(r[k]) || 0), 0);

const totalPaid = sum(paidDown) + sum(fullyPaid); // negative number (money "applied")
const totalNew = sum(newOnes);
const totalDelta = Number(B.total_balance) - Number(A.total_balance);

if (args.json) {
  console.log(JSON.stringify({
    before: { id: A.id, as_of: A.as_of, total_balance: A.total_balance, row_count: A.row_count, label: A.notes },
    after:  { id: B.id, as_of: B.as_of, total_balance: B.total_balance, row_count: B.row_count, label: B.notes },
    delta: {
      total_balance: totalDelta,
      paid_down_amount: sum(paidDown),
      fully_paid_amount: sum(fullyPaid),
      new_arrears_amount: totalNew,
    },
    paid_down: paidDown,
    fully_paid: fullyPaid,
    new_arrears: newOnes,
    balance_went_up: balanceWentUp,
  }, null, 2));
  process.exit(0);
}

console.log('');
console.log(`╔══ ARREARS DIFF ════════════════════════════════════════════╗`);
console.log(`║ before:  ${A.id}  (${A.notes || 'no label'})`);
console.log(`║          ${A.row_count} rows, ${fmtMoney(A.total_balance)} TZS @ ${A.as_of}`);
console.log(`║ after:   ${B.id}  (${B.notes || 'no label'})`);
console.log(`║          ${B.row_count} rows, ${fmtMoney(B.total_balance)} TZS @ ${B.as_of}`);
console.log(`║`);
console.log(`║ total balance delta: ${fmtMoney(totalDelta)} TZS`);
console.log(`║   paid down:    ${paidDown.length.toString().padStart(5)} invoices,  ${fmtMoney(sum(paidDown))} TZS`);
console.log(`║   fully paid:   ${fullyPaid.length.toString().padStart(5)} invoices,  ${fmtMoney(sum(fullyPaid))} TZS`);
console.log(`║   new arrears:  ${newOnes.length.toString().padStart(5)} invoices,  ${fmtMoney(totalNew)} TZS`);
console.log(`║   unchanged:    ${unchanged.length.toString().padStart(5)} invoices`);
if (balanceWentUp.length) {
  console.log(`║   ⚠ went UP:   ${balanceWentUp.length.toString().padStart(5)} invoices,  ${fmtMoney(sum(balanceWentUp))} TZS (unusual)`);
}
console.log(`╚════════════════════════════════════════════════════════════╝`);

// Per-customer rollup
const byCustomer = new Map();
const accum = (rows, label) => {
  for (const r of rows) {
    const key = r.customer || '(unknown)';
    const e = byCustomer.get(key) || { customer: key, delta: 0, paid_down: 0, fully_paid: 0, new: 0, branch: r.branch };
    e.delta += Number(r.delta) || 0;
    e[label] += 1;
    byCustomer.set(key, e);
  }
};
accum(paidDown, 'paid_down');
accum(fullyPaid, 'fully_paid');
accum(newOnes, 'new');

const customers = [...byCustomer.values()]
  .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  .slice(0, 20);

console.log('\nTop 20 customers by absolute change:');
console.log('  branch       customer'.padEnd(54) + 'delta TZS'.padStart(15) + '   pd/fp/new');
for (const c of customers) {
  const cust = c.customer.length > 40 ? c.customer.slice(0, 37) + '...' : c.customer;
  const branch = (c.branch || '').slice(0, 10).padEnd(12);
  console.log('  ' + branch + cust.padEnd(42) + fmtMoney(c.delta).padStart(15)
    + `    ${c.paid_down}/${c.fully_paid}/${c.new}`);
}

console.log('\nLegend: pd=paid_down, fp=fully_paid, new=new_arrears');
console.log('Run with --json for full machine-readable output.');
