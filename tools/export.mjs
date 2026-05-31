#!/usr/bin/env node
// Export an arrears snapshot to a CSV file you can open in Excel.
//
// Usage:
//   node tools/export.mjs <snapshot_id>
//   node tools/export.mjs <snapshot_id> --out=/tmp/arrears.csv
//
// Columns mirror the .xls schema used by invoice-payment-app / SaasAnt:
//   date, type, no, customer, memo, balance, amount, status, qbId,
//   dueDate, branch, customerLeaf

import { brainGet, parseArgs } from './_common.mjs';
import { writeFileSync } from 'node:fs';

const args = parseArgs(process.argv);
const [snapshotId] = args._;
if (!snapshotId) {
  console.error('usage: node tools/export.mjs <snapshot_id> [--out=path.csv]');
  process.exit(2);
}
const outPath = args.out || `/tmp/arrears_${snapshotId.slice(0, 8)}.csv`;

console.log(`[export] fetching snapshot ${snapshotId}…`);
const { snapshot } = await brainGet(`/api/arrears-snapshots/${snapshotId}`);

const cols = ['date', 'type', 'no', 'customer', 'memo', 'balance', 'amount', 'status', 'qbId', 'dueDate', 'branch', 'customerLeaf'];

// CSV-escape: wrap in "..." if the cell has a comma, quote, or newline; double internal quotes.
const esc = (v) => {
  if (v == null) return '';
  const s = String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

const lines = [cols.join(',')];
for (const row of snapshot.data) {
  lines.push(cols.map((c) => esc(row[c])).join(','));
}
writeFileSync(outPath, lines.join('\n') + '\n', 'utf8');

console.log(`[export] wrote ${snapshot.data.length} rows to ${outPath}`);
console.log(`         label:         ${snapshot.notes || '(no label)'}`);
console.log(`         total_balance: ${Number(snapshot.total_balance).toLocaleString()} TZS`);
