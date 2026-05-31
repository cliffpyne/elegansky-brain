import { readFileSync, existsSync } from 'node:fs';
import { google } from 'googleapis';

let _sheets = null;
let _drive = null;

function loadCredentials() {
  const envJson = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
  if (envJson) {
    try { return JSON.parse(envJson); }
    catch { throw new Error('GOOGLE_SERVICE_ACCOUNT_JSON env var is set but not valid JSON'); }
  }
  const localPath = 'google-service-account.json';
  if (existsSync(localPath)) return JSON.parse(readFileSync(localPath, 'utf-8'));
  throw new Error('No Google service-account credentials found. Set GOOGLE_SERVICE_ACCOUNT_JSON env var, or place google-service-account.json in project root.');
}

async function getAuth() {
  const credentials = loadCredentials();
  return new google.auth.GoogleAuth({
    credentials,
    scopes: [
      'https://www.googleapis.com/auth/spreadsheets',
      'https://www.googleapis.com/auth/drive.metadata.readonly',
    ],
  });
}

async function sheetsClient() {
  if (_sheets) return _sheets;
  _sheets = google.sheets({ version: 'v4', auth: await getAuth() });
  return _sheets;
}

async function driveClient() {
  if (_drive) return _drive;
  _drive = google.drive({ version: 'v3', auth: await getAuth() });
  return _drive;
}

export async function listSharedSheets() {
  const drive = await driveClient();
  const res = await drive.files.list({
    q: "mimeType='application/vnd.google-apps.spreadsheet' and trashed=false",
    fields: 'files(id,name,modifiedTime,webViewLink,owners(emailAddress))',
    pageSize: 100,
    orderBy: 'modifiedTime desc',
  });
  return res.data.files || [];
}

export async function sheetMetadata(spreadsheetId) {
  const sheets = await sheetsClient();
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: 'spreadsheetId,properties(title),sheets(properties(title,sheetId,gridProperties))',
  });
  return res.data;
}

export async function readSheet(spreadsheetId, range) {
  const sheets = await sheetsClient();
  if (!range) {
    const meta = await sheets.spreadsheets.get({
      spreadsheetId,
      fields: 'sheets(properties(title))',
    });
    const firstSheet = meta.data.sheets?.[0]?.properties?.title;
    if (!firstSheet) throw new Error('Spreadsheet has no tabs');
    range = `${firstSheet}!A1:Z1000`;
  }
  const res = await sheets.spreadsheets.values.get({ spreadsheetId, range });
  return { range: res.data.range, values: res.data.values || [] };
}

export function serviceAccountEmail() {
  return loadCredentials().client_email;
}

/**
 * Atomic-ish sort of one tab by date column, with backup. Used by the
 * /api/admin/sort-sheet-by-date endpoint after the NMB CSV-order chaos.
 *
 * Behaviour:
 *   - Reads the full tab including the header row (header is preserved).
 *   - Parses col B (dateCol) using TWO formats:
 *       "DD.MM.YYYY HH:MM:SS"   (current NMB)
 *       "DD Mon YYYY"           (legacy, no time)
 *   - Rows with unparseable dates go to the TOP, preserving their original
 *     relative order (no data loss).
 *   - Creates a backup tab "<TAB>_backup_<ISO>" with the EXACT current data
 *     before touching the source tab; aborts if backup row count is short.
 *   - Then clears col A..Z from row 2 onward and writes the sorted rows back.
 *
 * Returns a summary object the endpoint can shove straight at the operator.
 */
export async function sortTabByDate(spreadsheetId, tabName, { dryRun = false, dateColIndex = 1 } = {}) {
  const sheets = await sheetsClient();

  const read = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${tabName}!A1:Z200000`,
  });
  const all = read.data.values || [];
  if (all.length < 2) return { error: 'tab has fewer than 2 rows — nothing to sort' };
  const header = all[0];
  const data = all.slice(1).filter((r) => r && r.some((c) => String(c).trim().length));

  const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
  const parseDate = (s) => {
    const txt = String(s || '').trim();
    if (!txt) return null;
    let m = txt.match(/^(\d{2})\.(\d{2})\.(\d{4})\s+(\d{2}):(\d{2}):(\d{2})/);
    if (m) return Date.UTC(+m[3], +m[2] - 1, +m[1], +m[4], +m[5], +m[6]);
    m = txt.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
    if (m) {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo == null) return null;
      return Date.UTC(+m[3], mo, +m[1]);
    }
    return null;
  };

  const enriched = data.map((row, originalIdx) => ({ row, ts: parseDate(row[dateColIndex]), originalIdx }));
  const parsed = enriched.filter((e) => e.ts != null);
  const unparsed = enriched.filter((e) => e.ts == null);
  parsed.sort((a, b) => a.ts - b.ts || a.originalIdx - b.originalIdx);
  const sortedRows = [...unparsed.map((e) => e.row), ...parsed.map((e) => e.row)];

  const summary = {
    rows_in: data.length,
    rows_parsed: parsed.length,
    rows_unparsed: unparsed.length,
    rows_out: sortedRows.length,
    unparsed_samples: unparsed.slice(0, 5).map((e) => e.row[dateColIndex]),
    before_first3: data.slice(0, 3).map((r) => ({ date: r[dateColIndex], ref: r[7] })),
    before_last3: data.slice(-3).map((r) => ({ date: r[dateColIndex], ref: r[7] })),
    after_first3: sortedRows.slice(0, 3).map((r) => ({ date: r[dateColIndex], ref: r[7] })),
    after_last3: sortedRows.slice(-3).map((r) => ({ date: r[dateColIndex], ref: r[7] })),
  };

  if (sortedRows.length !== data.length) {
    return { ...summary, error: 'row count mismatch pre/post sort — refusing to write' };
  }

  if (dryRun) {
    return { ...summary, dry_run: true, written: false };
  }

  // Step 1: backup tab
  const tsLabel = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const backupTab = `${tabName}_backup_${tsLabel}`;
  const addRes = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: {
      requests: [
        {
          addSheet: {
            properties: {
              title: backupTab,
              gridProperties: { rowCount: all.length + 10, columnCount: header.length + 2 },
            },
          },
        },
      ],
    },
  });
  const backupSheetId = addRes.data.replies[0].addSheet.properties.sheetId;

  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${backupTab}!A1`,
    valueInputOption: 'RAW',
    requestBody: { values: all },
  });

  const verify = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `${backupTab}!A1:Z200000`,
  });
  const verifyData = (verify.data.values || []).filter((r) => r && r.some((c) => String(c).trim().length));
  if (verifyData.length < data.length) {
    return { ...summary, backup_tab: backupTab, error: `backup verify too low (${verifyData.length} < ${data.length}) — refused to write to source` };
  }

  // Step 2: clear + write
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `${tabName}!A2:Z200000`,
  });
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `${tabName}!A2`,
    valueInputOption: 'RAW',
    requestBody: { values: sortedRows },
  });

  return { ...summary, backup_tab: backupTab, backup_sheet_id: backupSheetId, written: true };
}
