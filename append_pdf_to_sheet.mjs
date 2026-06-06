// Append the dedup'd new rows from the parsed PDF into the NMB sheet.
// Uses GOOGLE_SERVICE_ACCOUNT_JSON (same creds as BRAIN) via googleapis.
// USE_OPTION = 'NEW_ONLY' (default) or 'ALL' (don't dedup).

import fs from 'node:fs';
import { google } from 'googleapis';

const SHEET_ID = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek';
const TAB = 'PASSED';
const INPUT = '/tmp/nmb_stmt_NEW_for_sheet.tsv';

const creds = JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON);
const auth = new google.auth.GoogleAuth({
  credentials: creds,
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const tsv = fs.readFileSync(INPUT, 'utf8').split('\n').filter(l => l.trim());
const rows = tsv.slice(1).map(l => l.split('\t'));

console.log(`About to append ${rows.length} rows to NMB sheet (${TAB} tab).`);
console.log('First 3 rows that will be appended:');
for (const r of rows.slice(0, 3)) console.log('  ', r.join(' | '));
console.log('Last 3 rows that will be appended:');
for (const r of rows.slice(-3)) console.log('  ', r.join(' | '));

if (process.argv[2] !== '--confirm') {
  console.log('');
  console.log('DRY RUN — pass --confirm to actually append.');
  process.exit(0);
}

const r = await sheets.spreadsheets.values.append({
  spreadsheetId: SHEET_ID,
  range: `${TAB}!A:H`,
  valueInputOption: 'USER_ENTERED',
  insertDataOption: 'INSERT_ROWS',
  requestBody: { values: rows },
});
console.log('');
console.log('APPENDED.');
console.log('updatedRange:', r.data.updates.updatedRange);
console.log('updatedRows:', r.data.updates.updatedRows);
console.log('updatedCells:', r.data.updates.updatedCells);
