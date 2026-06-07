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

// Master kill switch via env var (boot time). Runtime toggle via
// app_settings.agent_scheduler_enabled (dashboard button). If env is
// 'false', the scheduler never registers at boot. If env is 'true' (default),
// the scheduler registers and each tick checks the DB flag at fire time.
const ENV_ENABLED = process.env.AGENT_SCHEDULER_ENABLED !== 'false';

async function isRuntimeEnabled() {
  try {
    const r = await db().query(`SELECT value FROM app_settings WHERE key = 'agent_scheduler_enabled'`);
    if (r.rows.length === 0) return true;  // default-on
    return String(r.rows[0].value).toLowerCase() === 'true';
  } catch (err) {
    console.error('[scheduler] DB toggle check failed (failing safe = enabled):', err.message);
    return true;
  }
}

/**
 * Did the NMB scraper report OK within the last `maxAgeMin` minutes?
 * Used by meru0300 as a precondition — if NMB isn't fresh, the whole
 * day's catchup is bogus and the scheduler should be killed instead
 * of compounding the gap.
 *
 * Returns { ok: boolean, reason: string }.
 * The reason string is human-readable and gets surfaced in the admin
 * notification so the operator knows what to investigate.
 */
async function checkNmbScrapedRecently(maxAgeMin) {
  try {
    const r = await db().query(
      `SELECT status, reported_at FROM statement_cycles
        WHERE bank = 'NMB'
        ORDER BY reported_at DESC LIMIT 1`,
    );
    if (!r.rows.length) {
      return { ok: false, reason: 'no NMB scrape report has ever been received' };
    }
    const row = r.rows[0];
    const ageMin = Math.floor((Date.now() - new Date(row.reported_at).getTime()) / 60_000);
    if (row.status !== 'ok') {
      return { ok: false, reason: `latest NMB scrape status=${row.status} (reported ${ageMin} min ago)` };
    }
    if (ageMin >= maxAgeMin) {
      return { ok: false, reason: `latest NMB OK is ${ageMin} min old (cutoff = ${maxAgeMin} min — scraper may have stopped firing)` };
    }
    return { ok: true, reason: `latest NMB status=ok, reported ${ageMin} min ago` };
  } catch (err) {
    // Fail CLOSED — if we can't read the DB, we don't know NMB succeeded,
    // so abort meru0300 conservatively. Better safe than sorry on the
    // most critical tick of the day.
    return { ok: false, reason: `DB read failed: ${err.message}` };
  }
}

function buildTriggerContext(sched) {
  const now = new Date();
  const eatNow = new Date(now.getTime() + 3 * 3600_000);
  const todayEat = eatNow.toISOString().slice(0, 10);
  const yEat = new Date(eatNow.getTime() - 24 * 3600_000).toISOString().slice(0, 10);
  const tEat = new Date(eatNow.getTime() + 24 * 3600_000).toISOString().slice(0, 10);

  const txnDate = sched.txnDateOffset === 0 ? todayEat : tEat;

  // EAT-time → UTC-ISO converter. Accepts HH:MM or HH:MM:SS.
  const eatIso = (dateStr, hhmmss) => {
    const [h, m, s = 0] = hhmmss.split(':').map(Number);
    const d = new Date(dateStr + 'T00:00:00Z');
    d.setUTCHours(h - 3, m, s, 0);
    return d.toISOString();
  };

  if (sched.kind === 'catchup-yesterday') {
    // Two distinct sub-windows per channel:
    //   1. Yesterday's evening tail:   16:15 → 23:59:59 YESTERDAY  → AS_OF=yesterday
    //   2. Today's pre-dawn segment:   00:00:00 → execution-time   → AS_OF=today
    // Both produce TxnDate=today (tick runs at 03:00 EAT, pre-cutoff).
    // The windows DO NOT cross midnight — each lives strictly inside its own
    // calendar day. This is per Frank's explicit rule: "16:15 to 23:59" for
    // window 1, "00:00 to whatever 03:00" for window 2.
    return {
      tick: sched.name,
      eat_scheduled: sched.eat,
      kind: sched.kind,
      txn_date: txnDate,
      windows: [
        { channel: 'nmbnew',      since_iso: eatIso(yEat, '16:15'),       until_iso: eatIso(yEat, '23:59:59'), as_of: yEat,     txn_date: txnDate },
        { channel: 'bank',        since_iso: eatIso(yEat, '16:15'),       until_iso: eatIso(yEat, '23:59:59'), as_of: yEat,     txn_date: txnDate },
        { channel: 'iphone_bank', since_iso: eatIso(yEat, '16:15'),       until_iso: eatIso(yEat, '23:59:59'), as_of: yEat,     txn_date: txnDate },
        { channel: 'nmbnew',      since_iso: eatIso(todayEat, '00:00'),   until_iso: now.toISOString(),       as_of: todayEat, txn_date: txnDate },
        { channel: 'bank',        since_iso: eatIso(todayEat, '00:00'),   until_iso: now.toISOString(),       as_of: todayEat, txn_date: txnDate },
        { channel: 'iphone_bank', since_iso: eatIso(todayEat, '00:00'),   until_iso: now.toISOString(),       as_of: todayEat, txn_date: txnDate },
      ],
      note: 'Catchup is two distinct day-bound windows: (1) yesterday 16:15→23:59 AS_OF=yesterday, (2) today 00:00→now AS_OF=today. No midnight crossing. All TxnDate=today.',
    };
  }
  if (sched.kind === 'today-normal' || sched.kind === 'today-cutoff') {
    // Daytime tick. AS_OF=today, TxnDate=today.
    // Use FROM_LAST: omit since_iso/until_iso so the auto-upload endpoint
    // computes since = MAX(consumed_transactions.sheet_ts)+1ms per channel.
    // Operator rule 2026-06-04: "all uploads use last used ref + fresh /arrears".
    return {
      tick: sched.name,
      eat_scheduled: sched.eat,
      kind: sched.kind,
      mode_label: 'from_last',
      txn_date: txnDate,
      windows: [
        { channel: 'nmbnew',      as_of: todayEat, txn_date: txnDate },
        { channel: 'bank',        as_of: todayEat, txn_date: txnDate },
        { channel: 'iphone_bank', as_of: todayEat, txn_date: txnDate },
      ],
      note: 'Daytime run. from_last (omit since/until). AS_OF=today, TxnDate=today. /arrears pulled fresh per channel.',
    };
  }
  if (sched.kind === 'today-evening') {
    // Post-cutoff evening. AS_OF=today (bank txns happened today before
    // posting), TxnDate=tomorrow (cutoff rule). from_last semantics.
    return {
      tick: sched.name,
      eat_scheduled: sched.eat,
      kind: sched.kind,
      mode_label: 'from_last',
      txn_date: txnDate,
      windows: [
        { channel: 'nmbnew',      as_of: todayEat, txn_date: txnDate },
        { channel: 'bank',        as_of: todayEat, txn_date: txnDate },
        { channel: 'iphone_bank', as_of: todayEat, txn_date: txnDate },
      ],
      note: 'Post-cutoff evening run. from_last. AS_OF=today (bank-txn day), TxnDate=tomorrow (cutoff rule).',
    };
  }
  throw new Error('unknown kind: ' + sched.kind);
}

async function fireTick(sched) {
  // Runtime toggle check (dashboard button). Env kill-switch is checked
  // at startScheduler() time; the DB flag is checked PER TICK so an
  // operator can pause/resume mid-day from the dashboard.
  if (!(await isRuntimeEnabled())) {
    console.log(`[scheduler] ${sched.name} suppressed — app_settings.agent_scheduler_enabled = false`);
    return;
  }

  // Meru0300 NMB precondition (Frank 2026-06-07): the 03:00 catchup
  // tick represents yesterday-evening + today-pre-dawn books. NMB is
  // the main bank — if its scraper didn't report OK recently, the whole
  // day's data is corrupt and continuing to fire later ticks would
  // compound the gap. So we ABORT this tick AND kill the whole
  // scheduler for the day (admin re-enables manually after fixing the
  // scraper). CRDB-only failures don't trigger this — only NMB.
  if (sched.name === 'meru0300') {
    const ok = await checkNmbScrapedRecently(30);
    if (!ok.ok) {
      console.error(`[scheduler] ${sched.name} ABORT — NMB precondition failed: ${ok.reason}. Killing whole scheduler.`);
      try {
        await db().query(
          `INSERT INTO app_settings (key, value, updated_by)
           VALUES ('agent_scheduler_enabled', 'false', $1)
           ON CONFLICT (key) DO UPDATE SET
             value = 'false',
             updated_at = now(),
             updated_by = EXCLUDED.updated_by`,
          [`auto:meru0300:nmb-precondition-failed`],
        );
      } catch (e) {
        console.error('[scheduler] failed to flip kill switch:', e.message);
      }
      notifyAdmin({
        message: `BRAIN ${sched.name} ABORTED + scheduler DISABLED — ${ok.reason}. No further ticks will run today. Fix NMB scraper, then re-enable agent_scheduler_enabled in the dashboard.`,
        severity: 'critical',
        source: 'agent:scheduler:meru0300',
      });
      return;
    }
    console.log(`[scheduler] ${sched.name} NMB precondition OK: ${ok.reason}`);
  }

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
  if (!ENV_ENABLED) {
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
    // SCHEDULE is defined in tick-name (= time) order, meru0300 first. So
    // looping in order guarantees meru0300 catches up BEFORE later ticks.
    for (const sched of SCHEDULE) {
      const lastFire = lastFireTimeUtc(sched.utc, now);
      if (!lastFire) continue;
      const ageMs = now - lastFire;
      const isMeru = sched.name === 'meru0300';
      // Meru0300 special case (Frank 2026-06-07): on service restart, meru
      // is ALWAYS the first to fire if it hasn't completed today —
      // regardless of how late (no 2-hour cap). All other ticks still
      // honor the 2-hour staleness rule to avoid noisy late catchups.
      if (!isMeru && ageMs > 2 * 3600_000) continue;
      if (ageMs < 60_000) continue;
      const r = await db().query(
        `SELECT 1 FROM agent_sessions WHERE trigger=$1 AND started_at > $2 LIMIT 1`,
        ['cron:' + sched.name, lastFire.toISOString()],
      );
      if (r.rows.length === 0) {
        const note = isMeru && ageMs > 2 * 3600_000 ? ' (meru0300 special — no time cap)' : '';
        console.log(`[scheduler] catching up missed tick ${sched.name} (would have fired ${lastFire.toISOString()})${note}`);
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
