#!/usr/bin/env node
// Take a labeled /arrears snapshot and store it in BRAIN's arrears_snapshots table.
//
// Usage:
//   node tools/snap.mjs --label="baseline"
//   node tools/snap.mjs --label="post-saasant" --asOf=2026-05-31
//
// Prints the snapshot_id (uuid) and counts. Save the id — diff.mjs needs it.

import { brainGet, brainPost, parseArgs, fmtMoney } from './_common.mjs';

const args = parseArgs(process.argv);
const label = args.label || `snap-${new Date().toISOString().slice(0, 19)}`;
const asOf = args.asOf || new Date().toISOString().slice(0, 10);

console.log(`[snap] taking snapshot — label="${label}" asOf=${asOf}`);
console.log(`[snap] pulling /arrears (this may take 30-90s for the full overdue list)…`);

// Page through /arrears — pageSize=1000 is the max QB will return per query.
const all = [];
let start = 1;
let pages = 0;
const PAGE = 1000;
while (true) {
  const r = await brainGet('/arrears', { asOf, pageSize: PAGE, start });
  const invs = r.invoices || [];
  if (!invs.length) break;
  all.push(...invs);
  pages++;
  process.stdout.write(`  page ${pages} → ${invs.length} rows (running total ${all.length})\r`);
  if (!r.page?.nextStart) break;
  start = r.page.nextStart;
}
console.log(`\n[snap] /arrears: ${all.length} rows from ${pages} page(s)`);

const totalBalance = all.reduce((s, r) => s + (Number(r.balance) || 0), 0);
console.log(`[snap] total balance: ${fmtMoney(totalBalance)} TZS`);
console.log(`[snap] storing snapshot via POST /api/arrears-snapshots…`);

const res = await brainPost('/api/arrears-snapshots', {
  data: all,
  as_of: asOf,
  created_by: `comparison-harness:${process.env.USER || 'cli'}`,
  notes: label,
});

const snap = res.snapshot;
console.log('');
console.log(`╔══ SNAPSHOT SAVED ═════════════════════════════════════════╗`);
console.log(`║ id:            ${snap.id}`);
console.log(`║ label:         ${label}`);
console.log(`║ as_of:         ${snap.as_of}`);
console.log(`║ row_count:     ${snap.row_count}`);
console.log(`║ total_balance: ${fmtMoney(snap.total_balance)} TZS`);
console.log(`║ created_at:    ${snap.created_at}`);
console.log(`╚════════════════════════════════════════════════════════════╝`);
console.log('\nKeep the id — pass it to tools/diff.mjs <id_before> <id_after>.');
