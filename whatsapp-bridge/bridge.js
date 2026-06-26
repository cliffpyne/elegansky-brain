/**
 * Elegansky WhatsApp Bridge — Render worker version.
 *
 * Long-running Node process. Maintains a WhatsApp Web session via
 * whatsapp-web.js + Puppeteer/Chromium. Polls m6pm's existing
 * /api/whatsapp/pending queue and delivers each report file to the
 * configured group.
 *
 * First-boot flow:
 *   1. Container starts, prints QR code in the Render logs.
 *   2. Operator (255752900450) opens WhatsApp → Linked Devices → scans the QR.
 *   3. Operator sets LIST_GROUPS=1 on Render, restarts the service. Logs print
 *      every joined group's id+name. Pick one, set it as GROUP_ID env, and
 *      clear LIST_GROUPS. From here on, every report queued by m6pm gets
 *      delivered to that group.
 *
 * Session persistence:
 *   LocalAuth writes ~50MB into ./session/. On Render, mount a 1GB persistent
 *   disk at /var/data and set SESSION_DIR=/var/data/session so the session
 *   survives container restarts (otherwise QR scan needed every restart).
 *
 * Env:
 *   API_BASE         m6pm base. Default https://www.eleganskyboda.com
 *   API_TOKEN        Required. Must match m6pm's WHATSAPP_BRIDGE_TOKEN.
 *   GROUP_ID         WhatsApp group id (e.g. 1234567890-1234567890@g.us).
 *                    Optional on first boot; required to deliver anything.
 *   SESSION_DIR      Where to store the WhatsApp Web session.
 *                    Default ./session (in-container, lost on restart).
 *                    For Render: /var/data/session (on persistent disk).
 *   POLL_INTERVAL_MS Optional, default 30000.
 *   LIST_GROUPS=1    On boot, after auth, print all joined groups then exit.
 */

const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const axios = require('axios');
const fs = require('fs');
const path = require('path');

const API_BASE = process.env.API_BASE || 'https://www.eleganskyboda.com';
const API_TOKEN = process.env.API_TOKEN || '';
const GROUP_ID = process.env.GROUP_ID || '';
const SESSION_DIR = process.env.SESSION_DIR || path.join(__dirname, 'session');
const POLL_MS = parseInt(process.env.POLL_INTERVAL_MS || '30000', 10);
const LIST_GROUPS = process.env.LIST_GROUPS === '1';

if (!API_TOKEN) {
  console.error('ERROR: API_TOKEN not set — must match m6pm WHATSAPP_BRIDGE_TOKEN');
  process.exit(1);
}

const TMP_DIR = '/tmp/elegansky-bridge';
fs.mkdirSync(TMP_DIR, { recursive: true });
fs.mkdirSync(SESSION_DIR, { recursive: true });

console.log(`[bridge] starting — API_BASE=${API_BASE} SESSION_DIR=${SESSION_DIR} GROUP_ID=${GROUP_ID || '(unset)'} LIST_GROUPS=${LIST_GROUPS}`);

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: SESSION_DIR }),
  puppeteer: {
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu',
    ],
    // Let puppeteer use its bundled Chromium (downloaded during
    // `npm install`). Override via PUPPETEER_EXECUTABLE_PATH if needed.
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
  },
});

const auth = { Authorization: `Bearer ${API_TOKEN}` };
let polling = false;

client.on('qr', (qr) => {
  // Render's log viewer uses a tall-aspect monospace font that mangles
  // qrcode-terminal's ASCII art (each ▄/█ char is ~2x as tall as wide
  // → QR squished vertical → camera can't lock). Log a real PNG URL via
  // a public QR-rendering service so the operator can open it in any
  // browser tab and scan a clean image from the screen.
  process.stdout.write('\n────────────────────────────────────────────\n');
  process.stdout.write('  WhatsApp QR ready — phone 255752900450\n');
  process.stdout.write('────────────────────────────────────────────\n');
  const url = `https://api.qrserver.com/v1/create-qr-code/?size=400x400&data=${encodeURIComponent(qr)}`;
  process.stdout.write(`\n  → OPEN THIS URL IN A BROWSER, THEN SCAN THE PNG:\n  ${url}\n\n`);
  process.stdout.write('  (ASCII version below — usually unreadable in browser log viewers)\n\n');
  qrcode.generate(qr, { small: true });
});

client.on('authenticated', () => {
  console.log('[bridge] authenticated — session saved under', SESSION_DIR);
});

client.on('auth_failure', (msg) => {
  console.error('[bridge] AUTH FAILURE:', msg);
});

client.on('disconnected', (reason) => {
  console.error('[bridge] disconnected:', reason, '— restart to re-link');
});

client.on('ready', async () => {
  console.log('[bridge] ready — WhatsApp connected as', client.info?.wid?._serialized || '(unknown)');

  if (LIST_GROUPS) {
    const chats = await client.getChats();
    console.log('\nJoined groups:');
    for (const c of chats.filter((c) => c.isGroup)) {
      console.log(`  ${c.id._serialized}    ${c.name}`);
    }
    console.log('\nSet GROUP_ID to one of the IDs above, clear LIST_GROUPS, and restart.\n');
    // Don't exit — Render will restart and re-list. Operator pulls the IDs
    // from the logs and configures via the Render dashboard.
    return;
  }

  if (!GROUP_ID) {
    console.error('[bridge] GROUP_ID not set. Set LIST_GROUPS=1 on Render and restart to enumerate groups.');
    return;
  }

  startPollingLoop();
});

async function startPollingLoop() {
  console.log(`[bridge] polling ${API_BASE}/api/whatsapp/pending every ${POLL_MS / 1000}s…`);
  while (true) {
    try {
      await pollOnce();
    } catch (e) {
      console.error('[bridge] poll error:', e.message);
    }
    await sleep(POLL_MS);
  }
}

async function pollOnce() {
  if (polling) return;
  polling = true;
  try {
    const { data } = await axios.get(`${API_BASE}/api/whatsapp/pending?limit=20`, {
      headers: auth,
      timeout: 15_000,
    });
    if (!Array.isArray(data) || data.length === 0) return;
    console.log(`[bridge] ${data.length} pending`);
    for (const job of data) {
      try {
        await deliverOne(job);
      } catch (e) {
        console.error(`[bridge] failed delivery ${job.id}:`, e.message);
        await markDelivered(job.id, 'failed', e.message?.slice(0, 500) || 'unknown');
      }
    }
  } finally {
    polling = false;
  }
}

async function deliverOne(job) {
  const localPath = path.join(TMP_DIR, `${job.id}_${job.filename}`);
  const writer = fs.createWriteStream(localPath);
  const fileResp = await axios.get(`${API_BASE}/api/whatsapp/file/${job.id}`, {
    headers: auth,
    responseType: 'stream',
    timeout: 60_000,
  });
  await new Promise((resolve, reject) => {
    fileResp.data.pipe(writer);
    writer.on('finish', resolve);
    writer.on('error', reject);
  });

  const media = MessageMedia.fromFilePath(localPath);
  media.filename = job.filename;
  await client.sendMessage(GROUP_ID, media, {
    caption: job.caption || job.filename,
    sendMediaAsDocument: true,
  });
  console.log(`[bridge] sent ${job.kind || '?'}: ${job.filename}`);

  await markDelivered(job.id, 'sent');
  fs.unlink(localPath, () => {});

  // Small pause between sends to dodge WhatsApp's rate limits.
  await sleep(2000);
}

async function markDelivered(id, status, error) {
  try {
    await axios.post(
      `${API_BASE}/api/whatsapp/mark/${id}`,
      { status, error },
      { headers: { ...auth, 'Content-Type': 'application/json' }, timeout: 15_000 },
    );
  } catch (e) {
    console.error(`[bridge] mark ${id} failed:`, e.message);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

client.initialize();

process.on('SIGINT', () => {
  console.log('\n[bridge] shutting down');
  client.destroy();
  process.exit(0);
});
process.on('SIGTERM', () => {
  console.log('\n[bridge] SIGTERM');
  client.destroy();
  process.exit(0);
});
