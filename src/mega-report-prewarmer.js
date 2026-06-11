// Mega-report pre-warmer.
//
// /api/mega-report has a 30 s TTL response cache. First-of-window hits
// still pay the QB BalanceSheet + Google Sheets cost (~15-30 s). This
// module hits the most-common windows every 25 s in the background so
// the cache is always warm — even the very first visitor in the morning
// sees a sub-second load.
//
// Windows pre-warmed (each ≤ 1 internal call):
//   - today                  (anchor=today, granularity=day)
//   - yesterday              (anchor=today-1, granularity=day)
//   - current week           (Sun-Sat containing today)
//   - last week              (Sun-Sat containing today-7)
//
// Implementation: directly invokes the per-section helpers (which already
// go through the same cached() wrapper as the HTTP endpoint), so we share
// the cache with real dashboard hits — there's no double-pull.

const PREWARM_INTERVAL_MS = 25_000;

let _started = false;
let _timer = null;
let _state = {
  last_run_at: null,
  last_ok_at: null,
  last_error: null,
  runs: 0,
};
let _inFlight = false;

function todayEatStr() {
  const eat = new Date(Date.now() + 3 * 3600_000);
  return eat.toISOString().slice(0, 10);
}

function isoNDaysAgo(n) {
  const d = new Date(Date.now() + 3 * 3600_000 - n * 86_400_000);
  return d.toISOString().slice(0, 10);
}

function sundayAnchoredWeek(anchorDate) {
  const d = new Date(anchorDate + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun
  const sunday = new Date(d); sunday.setUTCDate(d.getUTCDate() - dow);
  const saturday = new Date(sunday); saturday.setUTCDate(sunday.getUTCDate() + 6);
  return {
    from: sunday.toISOString().slice(0, 10),
    to: saturday.toISOString().slice(0, 10),
  };
}

async function warmWindow(prewarmHooks, from, to) {
  // Fire all three section helpers in parallel. Each goes through cached().
  await Promise.all([
    prewarmHooks.getAccountBalance(from, to).catch((e) =>
      console.error(`[prewarmer] accountBalance ${from}→${to} failed:`, e.message)),
    prewarmHooks.getSheetTotals(from, to).catch((e) =>
      console.error(`[prewarmer] sheetTotals ${from}→${to} failed:`, e.message)),
    prewarmHooks.aggregateOfficers(from, to, null).catch((e) =>
      console.error(`[prewarmer] officers ${from}→${to} failed:`, e.message)),
  ]);
}

async function tick(prewarmHooks) {
  if (_inFlight) return;
  _inFlight = true;
  _state.last_run_at = new Date().toISOString();
  try {
    const today = todayEatStr();
    const yesterday = isoNDaysAgo(1);
    const wk = sundayAnchoredWeek(today);
    const lastWk = sundayAnchoredWeek(isoNDaysAgo(7));
    // Sequential so we don't dog-pile QB. Each window's parallel
    // section-helper fan-out is plenty.
    await warmWindow(prewarmHooks, today, today);
    await warmWindow(prewarmHooks, yesterday, yesterday);
    await warmWindow(prewarmHooks, wk.from, wk.to);
    await warmWindow(prewarmHooks, lastWk.from, lastWk.to);
    _state.last_ok_at = new Date().toISOString();
    _state.last_error = null;
    _state.runs += 1;
    if (_state.runs <= 2) console.log(`[prewarmer] tick #${_state.runs} done`);
  } catch (err) {
    _state.last_error = err.message;
    console.error('[prewarmer] tick failed:', err.message);
  } finally {
    _inFlight = false;
  }
}

export function startMegaReportPrewarmer(prewarmHooks) {
  if (_started) return;
  _started = true;
  // First tick after 10 s so the server can settle.
  setTimeout(() => {
    tick(prewarmHooks);
    _timer = setInterval(() => tick(prewarmHooks), PREWARM_INTERVAL_MS);
  }, 10_000);
  console.log(`[prewarmer] started, interval=${PREWARM_INTERVAL_MS}ms`);
}

export function getMegaReportPrewarmerState() {
  return { ..._state, running: _started, interval_ms: PREWARM_INTERVAL_MS };
}
