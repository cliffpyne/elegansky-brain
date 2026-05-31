#!/usr/bin/env node
// One-time sort of NMB NEW sheet's PASSED tab by date (column B).
//
// Why: NMB exports came in mixed orders over time (descending vs ascending
// chunks; some legacy rows with DD MMM YYYY format, some with
// DD.MM.YYYY HH:MM:SS). Manual drag-select totals in Sheets became unreliable.
//
// Safety:
//   - Creates a backup tab "PASSED_backup_<YYYY-MM-DD-HHmmss>" with the EXACT
//     current data BEFORE touching PASSED.
//   - Aborts if backup row count doesn't match the source.
//   - Unparseable-date rows go to the TOP (preserved, not lost). They're the
//     oldest legacy rows so they belong there in any case.
//
// Sort key: timestamp parsed from column B. Two formats handled:
//   1) "DD.MM.YYYY HH:MM:SS"   (current NMB export format)
//   2) "DD Mon YYYY"           (legacy, no time → treated as 00:00:00)
//
// Run:
//   node tools/sort-passed-tab.mjs
//   node tools/sort-passed-tab.mjs --dry-run   (just report what WOULD change)

import { google } from 'googleapis';
import { readFileSync, existsSync } from 'node:fs';

const SHEET_ID = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek';
const TAB = 'PASSED';
const DRY_RUN = process.argv.includes('--dry-run');

function loadCreds() {
  if (process.env.GOOGLE_SERVICE_ACCOUNT_JSON) return JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
  const local = '/var/www/html/EleganskyBrain/google-service-account.json';
  if (existsSync(local)) return JSON.parse(readFileSync(local, 'utf-8'));
  throw new Error('No Google credentials. Set GOOGLE_SERVICE_ACCOUNT_JSON or drop google-service-account.json at repo root.');
}

const auth = new google.auth.GoogleAuth({
  credentials: loadCreds(),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const MONTHS = { jan:0,feb:1,mar:2,apr:3,may:4,jun:5,jul:6,aug:7,sep:8,oct:9,nov:10,dec:11 };

function parseRowDate(s) {
  const txt = String(s || '').trim();
  if (!txt) return null;
  // Format 1: DD.MM.YYYY HH:MM:SS
  let m = txt.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
  if (m) return new Date(Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6])).getTime();
  // Format 2: DD Mon YYYY  (no time)
  m = txt.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  if (m) {
    const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
    if (mo == null) return null;
    return new Date(Date.UTC(+m[3], mo, +m[1])).getTime();
  }
  return null;
}

console.log('[sort] reading PASSED tab…');
const read = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: `${TAB}!A1:Z200000`,
});
const all = read.data.values || [];
console.log(`[sort] read ${all.length} total rows (incl. header)`);

const header = all[0];
const data = all.slice(1).filter((r) => r && r.some((c) => String(c).trim().length));
console.log(`[sort] header: ${JSON.stringify(header)}`);
console.log(`[sort] non-empty data rows: ${data.length}`);

const enriched = data.map((row, originalIdx) => {
  const ts = parseRowDate(row[1]);
  return { row, ts, originalIdx };
});

const parsed = enriched.filter((e) => e.ts != null);
const unparsed = enriched.filter((e) => e.ts == null);
console.log(`[sort] dates parsed:      ${parsed.length}`);
console.log(`[sort] dates UNPARSED:   ${unparsed.length}  (these stay at TOP, preserving original order)`);

if (unparsed.length > 0) {
  console.log('[sort] sample of unparsed date strings (showing 5):');
  unparsed.slice(0, 5).forEach((e) => console.log('  row', e.originalIdx + 2, '→', JSON.stringify(e.row[1])));
}

// Sort the parsed rows asc by ts. Tie-break by original index so a stable order
// is preserved for same-second rows.
parsed.sort((a, b) => a.ts - b.ts || a.originalIdx - b.originalIdx);

const sortedRows = [...unparsed.map((e) => e.row), ...parsed.map((e) => e.row)];
console.log(`[sort] post-sort rows: ${sortedRows.length}  (expected ${data.length})`);
if (sortedRows.length !== data.length) {
  console.error('[sort] ABORT: row count mismatch between pre and post sort');
  process.exit(1);
}

// Show before/after edges so the operator can sanity-check
console.log('\n[sort] BEFORE (first 3 / last 3 data rows by current sheet order):');
data.slice(0, 3).forEach((r, i) => console.log(`  pre row ${i + 2}:`, JSON.stringify(r[1]), '|', String(r[7] || '').trim()));
console.log('  ...');
data.slice(-3).forEach((r, i) => console.log(`  pre row ${data.length - 3 + i + 2}:`, JSON.stringify(r[1]), '|', String(r[7] || '').trim()));

console.log('\n[sort] AFTER  (first 3 / last 3 in new sorted order):');
sortedRows.slice(0, 3).forEach((r, i) => console.log(`  post row ${i + 2}:`, JSON.stringify(r[1]), '|', String(r[7] || '').trim()));
console.log('  ...');
sortedRows.slice(-3).forEach((r, i) => console.log(`  post row ${sortedRows.length - 3 + i + 2}:`, JSON.stringify(r[1]), '|', String(r[7] || '').trim()));

if (DRY_RUN) {
  console.log('\n[sort] --dry-run → not writing anything. Done.');
  process.exit(0);
}

// ── Step 1: create backup tab with the exact current data ───────────────
const tsLabel = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
const backupTab = `PASSED_backup_${tsLabel}`;
console.log(`\n[sort] creating backup tab "${backupTab}"…`);
const addRes = await sheets.spreadsheets.batchUpdate({
  spreadsheetId: SHEET_ID,
  requestBody: {
    requests: [
      { addSheet: { properties: { title: backupTab, gridProperties: { rowCount: all.length + 10, columnCount: header.length + 2 } } } },
    ],
  },
});
const newSheetId = addRes.data.replies[0].addSheet.properties.sheetId;
console.log(`[sort] created backup tab id ${newSheetId}`);

console.log('[sort] copying current PASSED data into backup…');
await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID,
  range: `${backupTab}!A1`,
  valueInputOption: 'RAW',
  requestBody: { values: all },
});
console.log('[sort] backup populated.');

// Verify backup count
const verify = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: `${backupTab}!A1:Z200000`,
});
const verifyRows = (verify.data.values || []).filter((r) => r && r.some((c) => String(c).trim().length));
console.log(`[sort] backup verified: ${verifyRows.length} non-empty rows (source had ${data.length + 1} incl header)`);
if (verifyRows.length < data.length) {
  console.error('[sort] ABORT: backup row count too low — refusing to write sorted data.');
  process.exit(2);
}

// ── Step 2: clear PASSED data area + write sorted rows back ─────────────
console.log('[sort] clearing PASSED data area (header preserved)…');
await sheets.spreadsheets.values.clear({
  spreadsheetId: SHEET_ID,
  range: `${TAB}!A2:Z200000`,
});

console.log(`[sort] writing ${sortedRows.length} sorted rows…`);
await sheets.spreadsheets.values.update({
  spreadsheetId: SHEET_ID,
  range: `${TAB}!A2`,
  valueInputOption: 'RAW',
  requestBody: { values: sortedRows },
});
console.log(`[sort] ✅ done — PASSED is now sorted by date (col B), backup kept at "${backupTab}"`);
