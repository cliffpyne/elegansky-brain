// Parse NMB statement PDF → dedupe vs sheet (PASSED + FAILED_NMB) → route
// plate-present rows to PASSED, plate-absent rows to FAILED_NMB → append each
// in chronological order continuing each tab's own id sequence.
//
// FAILED_NMB col F gets the literal string "No phone/plate" (the processor's
// convention for unidentified-plate rows; preserved here so an operator can
// filter on it the same way).
//
// Run modes:
//   node parse_and_append_v2.mjs            → dry-run summary
//   node parse_and_append_v2.mjs --confirm  → actually append

import fs from 'node:fs';
import { google } from 'googleapis';

const STMT_TXT = '/tmp/stmt.txt';
const SHEET_ID = '1YchOygtfVyVNgz37sGX_KKud_Wr9KQsIkQKn_tEdbek';
const TAB_PASSED = 'PASSED';
const TAB_FAILED = 'FAILED_NMB';
const NARRATION_PREFIX = '101 - NMB Head Office - Cash Deposit Agency banking - ';
const CONFIRM = process.argv.includes('--confirm');

// ── 1. Parse PDF ──────────────────────────────────────────────────────────
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

    let xrefSuffix = ''; let custTail = '';
    const fullM = tail.match(/^\s*(\S+(?:\s\S+)*?)\s{2,}(.*?)\s{2,}([A-Z0-9]{2,6})(?:\s{2,}\S*)?\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s*$/);
    if (fullM) { custTail = fullM[2].replace(/\s+/g, ' ').trim(); xrefSuffix = fullM[3]; }
    else { const sufMatch = tail.match(/\s+([A-Z0-9]{2,6})(?:\s+\S*)?\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s+[\d,]+(?:\.\d+)?\s*$/); if (sufMatch) xrefSuffix = sufMatch[1]; }
    const fullRef = (xrefPrefix || '') + xrefSuffix;

    if (timeMatch && credit && fullRef.startsWith('101AGD') && xrefSuffix) {
      const dd = timeMatch[1], mm = timeMatch[2], hh = timeMatch[3], mn = timeMatch[4], ss = timeMatch[5];
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
          plate, customer: fullCustomer,
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

// ── 2. Auth ───────────────────────────────────────────────────────────────
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_SERVICE_ACCOUNT_JSON),
  scopes: ['https://www.googleapis.com/auth/spreadsheets'],
});
const sheets = google.sheets({ version: 'v4', auth });

// ── 3. Read existing PASSED and FAILED_NMB refs + max ids ────────────────
async function inspectTab(tab) {
  const r = await sheets.spreadsheets.values.get({ spreadsheetId: SHEET_ID, range: `${tab}!A1:H80000` });
  const rows = r.data.values || [];
  const refs = new Set();
  let maxId = 0;
  for (let i = 1; i < rows.length; i++) {
    const id = Number(rows[i][0]);
    if (!Number.isNaN(id) && id > maxId) maxId = id;
    const ref = String(rows[i][7] || '').trim();
    if (ref) refs.add(ref);
  }
  return { rowCount: rows.length - 1, refs, maxId };
}
const passed = await inspectTab(TAB_PASSED);
const failed = await inspectTab(TAB_FAILED);
const sav = await inspectTab('PASSED_SAV_NMB');
const ili = await inspectTab('ILIYOPATA NMB');
console.log(`PASSED tab:         ${passed.rowCount} rows, max id = ${passed.maxId}, ${passed.refs.size} distinct refs`);
console.log(`FAILED_NMB tab:     ${failed.rowCount} rows, max id = ${failed.maxId}, ${failed.refs.size} distinct refs`);
console.log(`PASSED_SAV_NMB tab: ${sav.rowCount} rows, ${sav.refs.size} distinct refs (dedup only)`);
console.log(`ILIYOPATA NMB tab:  ${ili.rowCount} rows, ${ili.refs.size} distinct refs (dedup only)`);

// ── 4. Dedup vs ALL four tabs combined ────────────────────────────────────
const allExistingRefs = new Set([...passed.refs, ...failed.refs, ...sav.refs, ...ili.refs]);
const newTxns = txns.filter(t => !allExistingRefs.has(t.ref)).sort((a, b) => a.ts - b.ts);
console.log(`New rows (not in either tab): ${newTxns.length}`);

// ── 5. Split by plate-present ─────────────────────────────────────────────
const toPassed = newTxns.filter(t => t.plate);
const toFailed = newTxns.filter(t => !t.plate);
console.log(`  → PASSED     (plate present): ${toPassed.length} rows`);
console.log(`  → FAILED_NMB (no plate):       ${toFailed.length} rows`);

// ── 6. Build sheet rows for each tab ──────────────────────────────────────
let nextPid = passed.maxId + 1;
const passedRows = toPassed.map(t => [
  String(nextPid++),
  t.time,
  'NMB',
  NARRATION_PREFIX + t.narration,
  String(t.amount),
  t.plate,
  t.customer,
  t.ref,
]);
let nextFid = failed.maxId + 1;
const failedRows = toFailed.map(t => [
  String(nextFid++),
  t.time,
  'NMB',
  NARRATION_PREFIX + t.narration,
  String(t.amount),
  'No phone/plate',
  t.customer,
  t.ref,
]);

console.log('');
if (passedRows.length) {
  console.log('Sample PASSED rows (first 2):');
  for (const r of passedRows.slice(0, 2)) console.log('  A:' + r[0] + ' | B:' + r[1] + ' | E:' + r[4] + ' | F:' + r[5] + ' | G:' + r[6] + ' | H:' + r[7]);
}
if (failedRows.length) {
  console.log('Sample FAILED_NMB rows (first 2):');
  for (const r of failedRows.slice(0, 2)) console.log('  A:' + r[0] + ' | B:' + r[1] + ' | E:' + r[4] + ' | F:' + r[5] + ' | G:' + r[6] + ' | H:' + r[7]);
}

if (!CONFIRM) {
  console.log('');
  console.log(`DRY RUN. Would append ${passedRows.length} → PASSED and ${failedRows.length} → FAILED_NMB. Pass --confirm to do it.`);
  process.exit(0);
}

// ── 7. Append in chunks ───────────────────────────────────────────────────
async function appendChunked(tab, rows) {
  if (!rows.length) return 0;
  const CHUNK = 200;
  let total = 0;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const r = await sheets.spreadsheets.values.append({
      spreadsheetId: SHEET_ID,
      range: `${tab}!A:H`,
      valueInputOption: 'USER_ENTERED',
      insertDataOption: 'INSERT_ROWS',
      requestBody: { values: chunk },
    });
    total += r.data.updates.updatedRows || 0;
    console.log(`  ${tab} chunk ${Math.floor(i / CHUNK) + 1}/${Math.ceil(rows.length / CHUNK)} → ${r.data.updates.updatedRange} (${r.data.updates.updatedRows} rows)`);
  }
  return total;
}
const pTot = await appendChunked(TAB_PASSED, passedRows);
const fTot = await appendChunked(TAB_FAILED, failedRows);
console.log('');
console.log(`DONE — PASSED: +${pTot}  FAILED_NMB: +${fTot}`);
