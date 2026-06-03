// Internal scheduler — fires autonomous-Claude sessions at the right times
// of day. Lives inside the BRAIN web service (no separate cron infra needed).
//
// Schedule (all times EAT = UTC+3):
//
//   03:00  catchup     NMB + CRDB   window=YESTERDAY 18:00 → YESTERDAY 23:59  as_of=YESTERDAY
//   07:00  morning     NMB + CRDB   window=TODAY 00:00 → TODAY now              as_of=TODAY
//   10:00  late-morn   NMB + CRDB                                                as_of=TODAY
//   13:00  noon        NMB + CRDB + iphone_bank                                  as_of=TODAY
//   16:15  cutoff      NMB + CRDB + iphone_bank                                  as_of=TODAY
//   18:00  evening     NMB + CRDB + iphone_bank   (TxnDate flips to TOMORROW)    as_of=TOMORROW
//   21:00  night       NMB + CRDB + iphone_bank                                  as_of=TOMORROW
//
// AS_OF logic: see BRAIN_BRAIN.md. After 16:15 EAT cutoff, fresh deposits are
// booked with TxnDate=tomorrow, so we want tomorrow's invoices in the matching
// pool. Before cutoff, today's invoices are correct.
//
// Each tick POSTs to /api/agent/run with a structured triggerContext. The
// agent then plans + calls run_upload_window once per (channel, window).
//
// Reliability:
//   - On boot, we check the last successful session per trigger label and
//     fire any tick missed by <2h while BRAIN was offline (e.g. during a
//     deploy that straddled a scheduled time).

import cron from 'node-cron';
import { db } from '../db/pool.js';
import { runSession } from './runner.js';
import { notifyAdmin } from '../notifications.js';

// One row per scheduled tick. Cron expr is in UTC (BRAIN's process timezone).
// EAT = UTC + 3, so subtract 3 hours from EAT to get UTC.
const SCHEDULE = [
  { label: 'cron:03:00-catchup',  utc: '0 0 * * *',  eat: '03:00', kind: 'catchup' },   // 03:00 EAT = 00:00 UTC
  { label: 'cron:07:00-morning',  utc: '0 4 * * *',  eat: '07:00', kind: 'today' },
  { label: 'cron:10:00-latemorn', utc: '0 7 * * *',  eat: '10:00', kind: 'today' },
  { label: 'cron:13:00-noon',     utc: '0 10 * * *', eat: '13:00', kind: 'today' },
  { label: 'cron:16:15-cutoff',   utc: '15 13 * * *', eat: '16:15', kind: 'today' },
  { label: 'cron:18:00-evening',  utc: '0 15 * * *', eat: '18:00', kind: 'evening' },
  { label: 'cron:21:00-night',    utc: '0 18 * * *', eat: '21:00', kind: 'evening' },
];

const ENABLED = process.env.AGENT_SCHEDULER_ENABLED !== 'false';

function buildTriggerContext(kind) {
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 3600_000);
  const todayEat = eatNow.toISOString().slice(0, 10);
  const yEat = new Date(eatNow.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
  const tEat = new Date(eatNow.getTime() + 24 * 3600_000).toISOString().slice(0, 10);

  // Helper to convert "YYYY-MM-DD HH:mm EAT" → ISO UTC string.
  const eatIso = (dateStr, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCHours(h - 3, m, 0, 0);  // EAT → UTC
    return d.toISOString();
  };

  if (kind === 'catchup') {
    // Cover yesterday's last cutoff (16:15) through end of yesterday + early today
    return {
      kind: 'catchup',
      windows: [
        { channel: 'nmbnew',      since_iso: eatIso(yEat, '16:15'), until_iso: eatIso(todayEat, '03:00'), as_of: yEat },
        { channel: 'bank',        since_iso: eatIso(yEat, '16:15'), until_iso: eatIso(todayEat, '03:00'), as_of: yEat },
        { channel: 'iphone_bank', since_iso: eatIso(yEat, '16:15'), until_iso: eatIso(todayEat, '03:00'), as_of: yEat },
      ],
      note: 'Catch-up for yesterday-evening tail. AS_OF=yesterday is the rule.',
    };
  }
  if (kind === 'today') {
    // Window: today 00:00 → now. The auto-upload endpoint will default sinceIso
    // to "last finalized + safety" if we omit it, but for the agent we want
    // explicit context.
    return {
      kind: 'today',
      windows: [
        { channel: 'nmbnew',      since_iso: eatIso(todayEat, '00:00'), until_iso: now.toISOString(), as_of: todayEat },
        { channel: 'bank',        since_iso: eatIso(todayEat, '00:00'), until_iso: now.toISOString(), as_of: todayEat },
        { channel: 'iphone_bank', since_iso: eatIso(todayEat, '00:00'), until_iso: now.toISOString(), as_of: todayEat },
      ],
      note: 'Standard daytime run. AS_OF=today.',
    };
  }
  if (kind === 'evening') {
    // Post-16:15 cutoff bank txns happened TODAY → AS_OF=today (today's
    // invoices are what was due when the customer actually paid).
    // TxnDate WILL be tomorrow (per the cutoff rule applied at QB-write time
    // by paymentTxnDate()) — but that's an INDEPENDENT concern. Do NOT use
    // AS_OF=tomorrow here. That would put tomorrow's just-created invoices
    // in the pool and pay them ahead of today's real arrears — the same
    // bug as the morning-catchup AS_OF mistake. See BRAIN_BRAIN.md.
    return {
      kind: 'evening',
      windows: [
        { channel: 'nmbnew',      since_iso: eatIso(todayEat, '16:15'), until_iso: now.toISOString(), as_of: todayEat },
        { channel: 'bank',        since_iso: eatIso(todayEat, '16:15'), until_iso: now.toISOString(), as_of: todayEat },
        { channel: 'iphone_bank', since_iso: eatIso(todayEat, '16:15'), until_iso: now.toISOString(), as_of: todayEat },
      ],
      note: 'Post-cutoff evening run. AS_OF=today (matches when bank txn happened). TxnDate flips to tomorrow at QB-write time per cutoff rule.',
    };
  }
  throw new Error('unknown kind: ' + kind);
}

async function fireTick(label, kind) {
  const triggerContext = buildTriggerContext(kind);
  console.log(`[scheduler] firing ${label} kind=${kind}`);
  try {
    const r = await runSession({
      db: db(),
      trigger: label,
      triggerContext,
      mode: 'execute',
    });
    console.log(`[scheduler] ${label} → session=${r.sessionId} status=${r.status} cost=$${r.cost_usd}`);
  } catch (err) {
    console.error(`[scheduler] ${label} FAILED:`, err.message);
    notifyAdmin({
      message: `BRAIN scheduler ${label} failed: ${String(err.message || err).slice(0, 200)}`,
      severity: 'critical',
      source: 'agent:scheduler',
    });
  }
}

export function startScheduler() {
  if (!ENABLED) {
    console.log('[scheduler] disabled via AGENT_SCHEDULER_ENABLED=false');
    return;
  }
  if (!process.env.ANTHROPIC_API_KEY) {
    console.warn('[scheduler] ANTHROPIC_API_KEY missing — scheduler will register but ticks will throw');
  }

  for (const sched of SCHEDULE) {
    cron.schedule(sched.utc, () => fireTick(sched.label, sched.kind), { timezone: 'UTC' });
  }
  console.log(`[scheduler] registered ${SCHEDULE.length} ticks: ${SCHEDULE.map(s => s.eat + '(' + s.kind + ')').join(', ')}`);

  // Missed-tick recovery on boot: if a tick should have fired in the past
  // 2 hours and we don't have a session for it, fire it now. Prevents
  // deploys that span a scheduled time from silently dropping a tick.
  setTimeout(checkMissedTicks, 5_000);
}

async function checkMissedTicks() {
  try {
    const now = new Date();
    for (const sched of SCHEDULE) {
      const lastFire = lastFireTimeUtc(sched.utc, now);
      if (!lastFire) continue;
      const ageMs = now - lastFire;
      if (ageMs > 2 * 3600_000) continue;  // too old to chase
      if (ageMs < 60_000) continue;        // about to fire normally
      const r = await db().query(
        `SELECT 1 FROM agent_sessions
          WHERE trigger=$1 AND started_at > $2 LIMIT 1`,
        [sched.label, lastFire.toISOString()],
      );
      if (r.rows.length === 0) {
        console.log(`[scheduler] catching up missed tick ${sched.label} (would have fired ${lastFire.toISOString()})`);
        fireTick(sched.label, sched.kind);
      }
    }
  } catch (err) {
    console.error('[scheduler] missed-tick check failed:', err.message);
  }
}

// Given a cron expression like "0 4 * * *" and a reference Date, return the
// most recent firing time in UTC (or null if the expression doesn't match
// daily-at-fixed-time form).
function lastFireTimeUtc(cronExpr, ref) {
  const parts = cronExpr.split(/\s+/);
  if (parts.length !== 5) return null;
  const [minStr, hourStr] = parts;
  const min = Number(minStr), hour = Number(hourStr);
  if (Number.isNaN(min) || Number.isNaN(hour)) return null;
  const t = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth(), ref.getUTCDate(), hour, min, 0, 0));
  if (t > ref) t.setUTCDate(t.getUTCDate() - 1);
  return t;
}
