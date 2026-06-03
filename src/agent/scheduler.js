// Internal scheduler — fires autonomous-Claude sessions at the right times
// of day. Lives inside the BRAIN web service (no separate cron infra needed).
//
// Each scheduled tick has a NAME (mountain-themed) + scheduled EAT time. The
// name is its identity. When the tick runs (on time or delayed by retries),
// the resulting QB Payments carry a TxnDate derived from the NAME — not the
// wall clock at execution time. So if kili1615 retries 5 times and actually
// fires at 17:00, the txns still get TxnDate=today, because kili1615 IS the
// "16:15 EAT batch" by identity.
//
// Two INDEPENDENT date facts per tick:
//   - as_of    = the calendar day the bank txn happened (in the bank-txn
//                window). Controls which invoices are in the matching pool.
//   - txn_date = the date written to QB as the Payment TxnDate. Determined
//                by the tick's scheduled EAT time vs the 16:15 cutoff:
//                  scheduled <= 16:15 EAT → txn_date = execution-day
//                  scheduled  > 16:15 EAT → txn_date = execution-day + 1
//
// Schedule (all times EAT = UTC+3 → cron expressions are UTC):
//
//   meru0300        catchup-yesterday   as_of=yesterday  txn_date=today
//   hanang0700      today-normal        as_of=today      txn_date=today
//   loolmalas1000   today-normal        as_of=today      txn_date=today
//   lengai1300      today-normal        as_of=today      txn_date=today
//   kili1615        today-cutoff        as_of=today      txn_date=today
//   mawenzi1800     today-evening       as_of=today      txn_date=tomorrow
//   kibo2100        today-evening       as_of=today      txn_date=tomorrow
//
// Reliability:
//   - On boot, we check the last successful session per tick name and fire
//     any tick missed by <2h while BRAIN was offline (deploy window etc.).

import cron from 'node-cron';
import { db } from '../db/pool.js';
import { runSession } from './runner.js';
import { notifyAdmin } from '../notifications.js';

// Each tick: name + UTC cron + EAT label + kind + txn_date_offset (days).
const SCHEDULE = [
  { name: 'meru0300',      utc: '0 0 * * *',   eat: '03:00', kind: 'catchup-yesterday', txnDateOffset: 0 },
  { name: 'hanang0700',    utc: '0 4 * * *',   eat: '07:00', kind: 'today-normal',      txnDateOffset: 0 },
  { name: 'loolmalas1000', utc: '0 7 * * *',   eat: '10:00', kind: 'today-normal',      txnDateOffset: 0 },
  { name: 'lengai1300',    utc: '0 10 * * *',  eat: '13:00', kind: 'today-normal',      txnDateOffset: 0 },
  { name: 'kili1615',      utc: '15 13 * * *', eat: '16:15', kind: 'today-cutoff',      txnDateOffset: 0 },
  { name: 'mawenzi1800',   utc: '0 15 * * *',  eat: '18:00', kind: 'today-evening',     txnDateOffset: 1 },
  { name: 'kibo2100',      utc: '0 18 * * *',  eat: '21:00', kind: 'today-evening',     txnDateOffset: 1 },
];

const ENABLED = process.env.AGENT_SCHEDULER_ENABLED !== 'false';

function buildTriggerContext(sched) {
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 3600_000);
  const todayEat = eatNow.toISOString().slice(0, 10);
  const yEat = new Date(eatNow.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
  const tEat = new Date(eatNow.getTime() + 24 * 3600_000).toISOString().slice(0, 10);

  const txnDate = sched.txnDateOffset === 0 ? todayEat : tEat;

  // EAT-time → UTC-ISO converter.
  const eatIso = (dateStr, hhmm) => {
    const [h, m] = hhmm.split(':').map(Number);
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCHours(h - 3, m, 0, 0);
    return d.toISOString();
  };

  if (sched.kind === 'catchup-yesterday') {
    // Bank txns happened YESTERDAY (16:15 EAT → 23:59 EAT). AS_OF=yesterday.
    // TxnDate is TODAY (the operator convention — post-cutoff books to next day,
    // and the meru0300 tick name lives at execution-day-zero offset since it
    // logically represents "first run of today's bookkeeping cycle").
    return {
      tick: sched.name,
      eat_scheduled: sched.eat,
      kind: sched.kind,
      txn_date: txnDate,
      windows: [
        { channel: 'nmbnew',      since_iso: eatIso(yEat, '16:15'), until_iso: eatIso(todayEat, '03:00'), as_of: yEat, txn_date: txnDate },
        { channel: 'bank',        since_iso: eatIso(yEat, '16:15'), until_iso: eatIso(todayEat, '03:00'), as_of: yEat, txn_date: txnDate },
        { channel: 'iphone_bank', since_iso: eatIso(yEat, '16:15'), until_iso: eatIso(todayEat, '03:00'), as_of: yEat, txn_date: txnDate },
      ],
      note: 'Catchup for yesterday-evening tail. AS_OF=yesterday, TxnDate=today.',
    };
  }
  if (sched.kind === 'today-normal' || sched.kind === 'today-cutoff') {
    // Bank txns happened TODAY (00:00 EAT → now). AS_OF=today.
    // TxnDate=today since this tick is scheduled at/before 16:15 EAT.
    return {
      tick: sched.name,
      eat_scheduled: sched.eat,
      kind: sched.kind,
      txn_date: txnDate,
      windows: [
        { channel: 'nmbnew',      since_iso: eatIso(todayEat, '00:00'), until_iso: now.toISOString(), as_of: todayEat, txn_date: txnDate },
        { channel: 'bank',        since_iso: eatIso(todayEat, '00:00'), until_iso: now.toISOString(), as_of: todayEat, txn_date: txnDate },
        { channel: 'iphone_bank', since_iso: eatIso(todayEat, '00:00'), until_iso: now.toISOString(), as_of: todayEat, txn_date: txnDate },
      ],
      note: 'Daytime run. AS_OF=today, TxnDate=today.',
    };
  }
  if (sched.kind === 'today-evening') {
    // Bank txns happened TODAY post 16:15 EAT cutoff. AS_OF=today (when
    // customer actually paid). TxnDate=tomorrow (per cutoff convention).
    // Do NOT use AS_OF=tomorrow — that's the conflation trap.
    return {
      tick: sched.name,
      eat_scheduled: sched.eat,
      kind: sched.kind,
      txn_date: txnDate,
      windows: [
        { channel: 'nmbnew',      since_iso: eatIso(todayEat, '16:15'), until_iso: now.toISOString(), as_of: todayEat, txn_date: txnDate },
        { channel: 'bank',        since_iso: eatIso(todayEat, '16:15'), until_iso: now.toISOString(), as_of: todayEat, txn_date: txnDate },
        { channel: 'iphone_bank', since_iso: eatIso(todayEat, '16:15'), until_iso: now.toISOString(), as_of: todayEat, txn_date: txnDate },
      ],
      note: 'Post-cutoff evening run. AS_OF=today (bank txn day), TxnDate=tomorrow (cutoff rule).',
    };
  }
  throw new Error('unknown kind: ' + sched.kind);
}

async function fireTick(sched) {
  const triggerContext = buildTriggerContext(sched);
  const label = 'cron:' + sched.name;
  console.log(`[scheduler] firing ${sched.name} (eat=${sched.eat}, kind=${sched.kind}, txn_date=${triggerContext.txn_date})`);
  try {
    const r = await runSession({
      db: db(),
      trigger: label,
      triggerContext,
      mode: 'execute',
    });
    console.log(`[scheduler] ${sched.name} → session=${r.sessionId} status=${r.status} cost=$${r.cost_usd}`);
  } catch (err) {
    console.error(`[scheduler] ${sched.name} FAILED:`, err.message);
    notifyAdmin({
      message: `BRAIN ${sched.name} failed: ${String(err.message || err).slice(0, 200)}`,
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
    cron.schedule(sched.utc, () => fireTick(sched), { timezone: 'UTC' });
  }
  console.log(`[scheduler] registered ${SCHEDULE.length} ticks: ${SCHEDULE.map(s => s.name + '@' + s.eat).join(', ')}`);

  setTimeout(checkMissedTicks, 5_000);
}

async function checkMissedTicks() {
  try {
    const now = new Date();
    for (const sched of SCHEDULE) {
      const lastFire = lastFireTimeUtc(sched.utc, now);
      if (!lastFire) continue;
      const ageMs = now - lastFire;
      if (ageMs > 2 * 3600_000) continue;
      if (ageMs < 60_000) continue;
      const r = await db().query(
        `SELECT 1 FROM agent_sessions WHERE trigger=$1 AND started_at > $2 LIMIT 1`,
        ['cron:' + sched.name, lastFire.toISOString()],
      );
      if (r.rows.length === 0) {
        console.log(`[scheduler] catching up missed tick ${sched.name} (would have fired ${lastFire.toISOString()})`);
        fireTick(sched);
      }
    }
  } catch (err) {
    console.error('[scheduler] missed-tick check failed:', err.message);
  }
}

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
