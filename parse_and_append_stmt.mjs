// Full pipeline: parse NMB statement PDF text → dedupe vs existing sheet →
// build rows in the EXACT 8-column format the transaction-processor uses →
// append in chronological order at the bottom of the NMB sheet.
//
// Column layout (per existing sheet inspection):
//   A: sequence id (auto-increment from current max)
//   B: timestamp "DD.MM.YYYY HH:MM:SS"
//   C: channel "NMB"
//   D: full narration "101 - NMB Head Office - Cash Deposit Agency banking - <pdf narration>"
//   E: amount (number, no commas)
//   F: PLATE (column header says "PHONE" but processor stores plate here)
//   G: customer name
//   H: bank ref
//
// Run modes:
//   node parse_and_append_stmt.mjs            → dry-run (show counts + samples)
//   node parse_and_append_stmt.mjs --confirm  → actually append to sheet

import fs from 'node:fs';
import pg from 'pg';
import { google } from 'googleapis';

const STMT_TXT = '/tmp/stmt.txt';
const SHEET_ID = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek';
const TAB = 'PASSED';
const CONFIRM = process.argv.includes('--confirm');

// ── Parse PDF text → transactions ─────────────────────────────────────────
const text = fs.readFileSync(STMT_TXT, 'utf8');
const lines = text.split('\n');
const txns = [];
let buffer = [];
let xrefPrefix = '';

for (const raw of lines) {
  const line = raw;
  const refMatch = line.match(/(101AGD\d{6,7}[A-Z0-9]*)\s*$/i);
  if (refMatch) { xrefPrefix = refMatch[1]; buffer.push(line.trim()); continue; }

  const dataRow = line.match(/^\s*(\d{2})\/(\d{2})\/(\d{4})\s+(\d{2})\/(\d{2})\/(\d{4})/);
  if (dataRow) {
    const narration = buffer.join(' ');
    const timeMatch = narration.match(/(\d{2})(\d{2})\s+(\d{2}):(\d{2}):(\d{2})\s+agency/);
    const plateMatch = narration.match(/MC\s*(\d{3})\s*([A-Z]{3})/i);

    let customer = '';
    const arrowIdx = narration.indexOf('=>');
    if (arrowIdx >= 0) {
      let rest = narration.slice(arrowIdx + 2);
      const xrefIdx = rest.indexOf('101AGD');
      if (xrefIdx >= 0) rest = rest.slice(0, xrefIdx);
      customer = rest.replace(/\s+/g, ' ').trim();
    }

    const tail = line.replace(/^\s*\d{2}\/\d{2}\/\d{4}\s+\d{2}\/\d{2}\/\d{4}\s+/, '');
    const nums = [...tail.matchAll(/[\d,]+\.?\d*/g)].map(m => m[0]);
    if (nums.length < 3) { buffer = []; xrefPrefix = ''; continue; }
    const credit = nums[nums.length - 2];
    const debit = nums[nums.length - 3];

    let xrefSuffix = '';
    let custTail = '';
    const fullM = tail.match(/^\s*(\S+(?:\s\S+)*?)\s{2,}(.*?)\s{2,}([A-Z0-9]{2,6})(?:\s{2,}\S*)?\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s*$/);
    if (fullM) { custTail = fullM[2].replace(/\s+/g, ' ').trim(); xrefSuffix = fullM[3]; }
    else {
      const sufMatch = tail.match(/\s+([A-Z0-9]{2,6})(?:\s+\S*)?\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s*$/);
      if (sufMatch) xrefSuffix = sufMatch[1];
    }
    const fullRef = (xrefPrefix || '') + xrefSuffix;

    if (timeMatch && credit && fullRef.startsWith('101AGD') && xrefSuffix) {
      const dd = timeMatch[1], mm = timeMatch[2];
      const hh = timeMatch[3], mn = timeMatch[4], ss = timeMatch[5];
      const sheetDate = `${dd}.${mm}.2026 ${hh}:${mn}:${ss}`;
      const plate = plateMatch ? `MC${plateMatch[1]}${plateMatch[2]}`.toUpperCase() : '';
      let fullCustomer = (customer + ' ' + custTail).replace(/\s+/g, ' ').trim();
      const lastArrow = fullCustomer.lastIndexOf('=>');
      if (lastArrow >= 0) fullCustomer = fullCustomer.slice(lastArrow + 2).trim();
      fullCustomer = fullCustomer.replace(/^MLAKI\s+/, '').trim();

      const isCredit = Number(debit.replace(/,/g, '')) === 0;
      if (isCredit) {
        txns.push({
          time: sheetDate,
          ts: new Date(Date.UTC(2026, +mm - 1, +dd, +hh, +mn, +ss)),
          plate,
          customer: fullCustomer,
          amount: Number(credit.replace(/,/g, '')),
          ref: fullRef,
          narration: narration.replace(/\s+/g, ' ').trim(),
        });
      }
    }
    buffer = []; xrefPrefix = '';
    continue;
  }
  if (line.trim() && !line.match(/Retrieved|CUSTOMER ACCOUNT|^\s*Page No|^\s*Book Date|^\s*Date\b|FRANK WILLIAM MLAKI\s*$|TEMEKE DISTRICT|TANZANIA|Total Debit|Total Credit|Number of|Current Balance|Uncollected|Available Balance|OPENING BALANCE|FUND-TRANSFER|NMBMobileProd/i)) {
    buffer.push(line.trim());
  }
}
console.log(`Parsed ${txns.length} credit transactions from PDF.`);

// ── Auth + read existing sheet (refs + max seq id) ────────────────────────
const credsJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
if (!credsJson) throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var required');
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(credsJson),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

const get = await sheets.spreadsheets.values.get({
  spreadsheetId: SHEET_ID,
  range: `${TAB}!A1:H80000`,
});
const sheetRows = get.data.values || [];
const sheetRefs = new Set();
let maxId = 0;
for (let i = 1; i < sheetRows.length; i++) {
  const id = Number(sheetRows[i][0]);
  if (!Number.isNaN(id) && id > maxId) maxId = id;
  const ref = String(sheetRows[i][7] || '').trim();
  if (ref) sheetRefs.add(ref);
}
console.log(`Existing sheet: ${sheetRows.length - 1} data rows; max id = ${maxId}; ${sheetRefs.size} distinct refs.`);

// ── Dedup vs existing sheet refs, sort chronologically ──────────────────
const newTxns = txns
  .filter(t => !sheetRefs.has(t.ref))
  .sort((a, b) => a.ts - b.ts);
console.log(`New rows after dedup: ${newTxns.length}`);

// ── Build sheet rows in processor's column format ───────────────────────
const NARRATION_PREFIX = '101 - NMB Head Office - Cash Deposit Agency banking - ';
let nextId = maxId + 1;
const sheetRowsToAppend = newTxns.map(t => [
  String(nextId++),                           // A: id
  t.time,                                     // B: DD.MM.YYYY HH:MM:SS
  'NMB',                                      // C: channel
  NARRATION_PREFIX + t.narration,             // D: full message
  String(t.amount),                           // E: amount
  t.plate,                                    // F: plate
  t.customer,                                 // G: customer
  t.ref,                                      // H: ref
]);

console.log('');
console.log('Sample first 3 rows to append:');
for (const r of sheetRowsToAppend.slice(0, 3)) {
  console.log('  A:' + r[0], '| B:' + r[1], '| E:' + r[4], '| F:' + r[5], '| G:' + r[6], '| H:' + r[7]);
  console.log('    D:', r[3].slice(0, 120) + '…');
}
console.log('Sample last 3 rows to append:');
for (const r of sheetRowsToAppend.slice(-3)) {
  console.log('  A:' + r[0], '| B:' + r[1], '| E:' + r[4], '| F:' + r[5], '| G:' + r[6], '| H:' + r[7]);
}

if (!CONFIRM) {
  console.log('');
  console.log(`DRY RUN — would append ${sheetRowsToAppend.length} rows. Pass --confirm to do it.`);
  process.exit(0);
}

// ── Append in chunks (Google Sheets max ~1000 cells/request comfortably) ──
const CHUNK = 200;
let appended = 0;
for (let i = 0; i < sheetRowsToAppend.length; i += CHUNK) {
  const chunk = sheetRowsToAppend.slice(i, i + CHUNK);
  const r = await sheets.spreadsheets.values.append({
    spreadsheetId: SHEET_ID,
    range: `${TAB}!A:H`,
    valueInputOption: 'USER_ENTERED',
    insertDataOption: 'INSERT_ROWS',
    requestBody: { values: chunk },
  });
  appended += r.data.updates.updatedRows || 0;
  console.log(`  appended chunk ${(i / CHUNK) + 1}/${Math.ceil(sheetRowsToAppend.length / CHUNK)} → ${r.data.updates.updatedRange} (${r.data.updates.updatedRows} rows)`);
}
console.log('');
console.log(`DONE — appended ${appended} rows.`);
