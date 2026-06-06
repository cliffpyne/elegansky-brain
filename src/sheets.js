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

/**
 * Batch-write values to specific cells. Used to mark rows as
 * "Fetched at" (column I) and "QB pushed" (column J) during the
 * auto-upload flow so the sheet itself records what's been processed.
 *
 * updates: [{ range: "PASSED!I12345", value: "..." }, ...]
 *
 * Uses values.batchUpdate so all cells go in one API call (rate-limit
 * friendly for hundreds of writes per batch).
 */
export async function writeSheetCells(spreadsheetId, updates) {
  if (!Array.isArray(updates) || updates.length === 0) return { updatedCells: 0 };
  const sheets = await sheetsClient();
  const data = updates.map((u) => ({
    range: u.range,
    values: [[u.value]],
  }));
  const res = await sheets.spreadsheets.values.batchUpdate({
    spreadsheetId,
    requestBody: { valueInputOption: 'USER_ENTERED', data },
  });
  return {
    updatedCells: res.data.totalUpdatedCells || 0,
    updatedRanges: res.data.totalUpdatedRanges || 0,
  };
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
export async function sortTabByDate(spreadsheetId, tabName, { dryRun = false, dateColIndex = 1, messageColIndex = 3, skipBackup = false } = {}) {
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
  const NOW = Date.now();
  const SLOP_MS = 24 * 60 * 60 * 1000;

  // Parse a date string. Returns { ts, normalized } or null.
  // Handles three formats:
  //   "DD.MM.YYYY HH:MM:SS"   (current NMB)
  //   "MM.DD.YYYY HH:MM:SS"   (month-first variant on some channels)
  //   "DD Mon YYYY"           (legacy, no time → midnight)
  // Normalizes to "DD.MM.YYYY HH:MM:SS" (zero-padded) on parse success.
  const parseDate = (s) => {
    const txt = String(s || '').trim();
    if (!txt) return null;
    let m = txt.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})\s+(\d{1,2}):(\d{1,2}):(\d{1,2})/);
    if (m) {
      const [a, b, y, hh, mm, ss] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
      if (b >= 1 && b <= 12 && a >= 1 && a <= 31) {
        const t = Date.UTC(y, b - 1, a, hh, mm, ss);
        if (t <= NOW + SLOP_MS) return { ts: t, normalized: fmtDate(a, b, y, hh, mm, ss) };
      }
      if (a >= 1 && a <= 12 && b >= 1 && b <= 31) {
        const t = Date.UTC(y, a - 1, b, hh, mm, ss);
        if (t <= NOW + SLOP_MS) return { ts: t, normalized: fmtDate(b, a, y, hh, mm, ss) };
      }
      return null;
    }
    // "DD Mon YYYY" or "DD-Mon-YYYY" or "DD/Mon/YYYY"
    m = txt.match(/^(\d{1,2})[\s\-\/]+([A-Za-z]{3,9})[\s\-\/]+(\d{4})$/);
    if (m) {
      const mo = MONTHS[m[2].slice(0, 3).toLowerCase()];
      if (mo == null) return null;
      const t = Date.UTC(+m[3], mo, +m[1]);
      return { ts: t, normalized: fmtDate(+m[1], mo + 1, +m[3], 0, 0, 0) };
    }
    // ISO-ish: "YYYY-MM-DD HH:MM:SS" or "YYYY-MM-DD"
    m = txt.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[\sT](\d{1,2}):(\d{1,2}):(\d{1,2}))?/);
    if (m) {
      const [y, mo, d, hh, mm, ss] = [+m[1], +m[2], +m[3], +(m[4] ?? 0), +(m[5] ?? 0), +(m[6] ?? 0)];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const t = Date.UTC(y, mo - 1, d, hh, mm, ss);
        if (t <= NOW + SLOP_MS) return { ts: t, normalized: fmtDate(d, mo, y, hh, mm, ss) };
      }
      return null;
    }
    // Excel serial date (days since 1899-12-30, the Lotus 1-2-3 epoch).
    // Pure-integer cells like "46139" are these.
    m = txt.match(/^(\d{4,6})(?:\.\d+)?$/);
    if (m) {
      const days = +m[1];
      if (days > 25569 && days < 80000) {  // 1970-01-01 .. 2118-something
        const t = (days - 25569) * 86400 * 1000;
        if (t <= NOW + SLOP_MS) {
          const d = new Date(t);
          return { ts: t, normalized: fmtDate(d.getUTCDate(), d.getUTCMonth() + 1, d.getUTCFullYear(), d.getUTCHours(), d.getUTCMinutes(), d.getUTCSeconds()) };
        }
      }
    }
    return null;
  };

  const pad2 = (n) => String(n).padStart(2, '0');
  function fmtDate(d, mo, y, h, mi, s) {
    return `${pad2(d)}.${pad2(mo)}.${y} ${pad2(h)}:${pad2(mi)}:${pad2(s)}`;
  }

  // Extract a date out of the MESSAGE field for rows whose date column is
  // missing or junk. Two NMB MESSAGE patterns hit:
  //   TIPS Payments:    "...Received payment from ... on DD.MM.YYYY HH MM SS!!..."
  //   Agency banking:   "...Agency banking - DDMM HH MM SS agency..." (no year →
  //                      year is inferred from the today/current year so March
  //                      2026 rows land as 2026).
  const extractFromMessage = (msg, fallbackYear = new Date().getUTCFullYear()) => {
    const t = String(msg || '');
    if (!t) return null;
    // Pattern 1: "on DD.MM.YYYY HH MM SS"
    let m = t.match(/\bon (\d{2})\.(\d{2})\.(\d{4})\s+(\d{2})\s+(\d{2})\s+(\d{2})\b/);
    if (m) {
      const [d, mo, y, hh, mm, ss] = [+m[1], +m[2], +m[3], +m[4], +m[5], +m[6]];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const ts = Date.UTC(y, mo - 1, d, hh, mm, ss);
        if (ts <= NOW + SLOP_MS) return { ts, normalized: fmtDate(d, mo, y, hh, mm, ss) };
      }
    }
    // Pattern 2: "Agency banking - DDMM HH MM SS agency"  (no year)
    m = t.match(/Agency banking\s*-\s*(\d{2})(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+agency/);
    if (m) {
      const [d, mo, hh, mm, ss] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const ts = Date.UTC(fallbackYear, mo - 1, d, hh, mm, ss);
        if (ts <= NOW + SLOP_MS) return { ts, normalized: fmtDate(d, mo, fallbackYear, hh, mm, ss) };
      }
    }
    // Pattern 3: "Funds Transfer  - DD MM HH MM SS FUND-TRANSFER" (no year)
    m = t.match(/Funds Transfer\s*-\s*(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+(\d{2})\s+FUND-TRANSFER/);
    if (m) {
      const [d, mo, hh, mm, ss] = [+m[1], +m[2], +m[3], +m[4], +m[5]];
      if (mo >= 1 && mo <= 12 && d >= 1 && d <= 31) {
        const ts = Date.UTC(fallbackYear, mo - 1, d, hh, mm, ss);
        if (ts <= NOW + SLOP_MS) return { ts, normalized: fmtDate(d, mo, fallbackYear, hh, mm, ss) };
      }
    }
    return null;
  };

  // First pass: try to parse the date column directly.
  // Second pass for misses: extract date from MESSAGE and OVERWRITE the
  // date cell with the normalized value so the row sorts into its real
  // chronological position (and so future readers see a real date).
  let dateFilledFromMsg = 0;
  const enriched = data.map((row, originalIdx) => {
    const fromCol = parseDate(row[dateColIndex]);
    if (fromCol) return { row, ts: fromCol.ts, originalIdx, source: 'col' };
    const fromMsg = extractFromMessage(row[messageColIndex]);
    if (fromMsg) {
      const fixedRow = row.slice();
      fixedRow[dateColIndex] = fromMsg.normalized;
      dateFilledFromMsg++;
      return { row: fixedRow, ts: fromMsg.ts, originalIdx, source: 'msg' };
    }
    return { row, ts: null, originalIdx, source: 'none' };
  });
  const parsed = enriched.filter((e) => e.ts != null);
  const unparsed = enriched.filter((e) => e.ts == null);
  parsed.sort((a, b) => a.ts - b.ts || a.originalIdx - b.originalIdx);
  const sortedRows = [...unparsed.map((e) => e.row), ...parsed.map((e) => e.row)];

  const summary = {
    rows_in: data.length,
    rows_parsed: parsed.length,
    rows_filled_from_message: dateFilledFromMsg,
    rows_unparsed: unparsed.length,
    rows_out: sortedRows.length,
    unparsed_samples: unparsed.slice(0, 5).map((e) => ({ date: e.row[dateColIndex], msg: String(e.row[messageColIndex] || '').slice(0, 120) })),
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

  // Step 1: backup tab (skipped for auto-runs — would clutter the sheet with
  // dozens of backup tabs per day; the operator already has a manual backup
  // from the first sort run, which is the rollback point).
  let backupTab = null;
  let backupSheetId = null;
  if (!skipBackup) {
    const tsLabel = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
    backupTab = `${tabName}_backup_${tsLabel}`;
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
    backupSheetId = addRes.data.replies[0].addSheet.properties.sheetId;

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
