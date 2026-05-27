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
