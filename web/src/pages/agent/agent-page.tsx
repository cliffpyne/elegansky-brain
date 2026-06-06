import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, ChevronRight, Zap, Bot, Activity } from 'lucide-react';
import {
  listAgentSessions,
  fireAgent,
  getSchedulerStatus,
  setSchedulerEnabled,
  type AgentSessionRow,
} from '@/lib/brain-api';

const REFRESH_MS = 10_000;

function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (s) {
    case 'completed': return 'default';
    case 'running': return 'secondary';
    case 'paused': return 'outline';
    case 'errored':
    case 'aborted': return 'destructive';
    default: return 'outline';
  }
}

function fmtUsd(n: string | null | undefined): string {
  if (n == null) return '-';
  return '$' + Number(n).toFixed(4);
}

function fmtTokens(n: string | number | null | undefined): string {
  if (n == null) return '-';
  return Number(n).toLocaleString();
}

function relTime(iso: string): string {
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60_000) return Math.floor(ms / 1000) + 's ago';
  if (ms < 3600_000) return Math.floor(ms / 60_000) + 'm ago';
  if (ms < 86400_000) return Math.floor(ms / 3600_000) + 'h ago';
  return Math.floor(ms / 86400_000) + 'd ago';
}

// EAT helpers — UTC + 3h
function todayEat(): string {
  const eat = new Date(Date.now() + 3 * 3600_000);
  return eat.toISOString().slice(0, 10);
}
function nowIso(): string {
  return new Date().toISOString();
}
function nowEat(): string {
  // EAT wall-clock "YYYY-MM-DDTHH:mm:ss" (no Z, no offset)
  return new Date(Date.now() + 3 * 3600_000).toISOString().slice(0, 19);
}
function eatToUtcIso(eatLocal: string): string {
  // Operator enters time in EAT wall clock. Accept both formats:
  //   - ISO:       "2026-06-03T16:48:57" or "2026-06-03 16:48:57"
  //   - European:  "03.06.2026T16:48:57" or "03.06.2026 16:48:57"
  //                (matches the bank statement format operators copy from)
  // Treat the input as EAT (UTC+3) and convert to UTC ISO.
  let s = eatLocal.trim().replace(/Z$/i, '');
  // Normalize whitespace/T separator
  s = s.replace(' ', 'T');
  // Strip any pre-existing offset the user may have pasted in
  s = s.replace(/[+-]\d{2}:?\d{2}$/, '');
  // If the date part is DD.MM.YYYY, swap to ISO YYYY-MM-DD
  const euMatch = s.match(/^(\d{2})\.(\d{2})\.(\d{4})(.*)$/);
  if (euMatch) {
    s = `${euMatch[3]}-${euMatch[2]}-${euMatch[1]}${euMatch[4]}`;
  }
  // Default to start-of-day if no time given
  if (!/T\d{2}/.test(s)) s = s + 'T00:00:00';
  const d = new Date(s + '+03:00');
  if (isNaN(d.getTime())) throw new Error('Invalid EAT date: ' + eatLocal);
  return d.toISOString();
}
function pastCutoffEat(): boolean {
  const eat = new Date(Date.now() + 3 * 3600_000);
  const h = eat.getUTCHours();
  const m = eat.getUTCMinutes();
  return h > 16 || (h === 16 && m >= 15);
}
function tomorrowEat(): string {
  const eat = new Date(Date.now() + (3 + 24) * 3600_000);
  return eat.toISOString().slice(0, 10);
}

function HeisenbergForm({ onFired }: { onFired: () => void }) {
  const [channel, setChannel] = useState<'nmbnew' | 'bank' | 'iphone_bank'>('nmbnew');
  const [windowMode, setWindowMode] = useState<'from_last' | 'explicit'>('from_last');
  const [sinceIso, setSinceIso] = useState<string>('');
  const [untilIso, setUntilIso] = useState<string>(nowEat());
  const [asOf, setAsOf] = useState<string>(todayEat());
  const [txnDate, setTxnDate] = useState<string>(pastCutoffEat() ? tomorrowEat() : todayEat());
  const [mode, setMode] = useState<'plan' | 'execute'>('plan');
  const [firing, setFiring] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const fire = async () => {
    setFiring(true);
    setResult(null);
    setError(null);
    try {
      const win: Record<string, unknown> = {
        channel,
        as_of: asOf,
        txn_date: txnDate,
      };
      if (windowMode === 'explicit') {
        // Inputs are EAT wall-clock; convert to UTC ISO for the API.
        win.since_iso = eatToUtcIso(sinceIso);
        win.until_iso = eatToUtcIso(untilIso);
      } // else omit — server defaults to "since last finalized batch"
      const r = await fireAgent({
        trigger: 'heisenberg',
        triggerContext: {
          tick: 'heisenberg',
          mode_label: windowMode,
          windows: [win],
          note: `Heisenberg ${windowMode}-mode fired from dashboard.`,
        },
        mode,
      });
      setResult(`Spawned. Session id (seed): ${r.seed_session_id.slice(0, 8)}… — watch the list below.`);
      setTimeout(onFired, 3000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFiring(false);
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Zap className="size-5" /> Fire heisenberg (ad-hoc manual upload)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="grid grid-cols-2 gap-3">
          <label className="space-y-1">
            <span className="text-sm font-medium">Channel</span>
            <Select value={channel} onValueChange={(v) => setChannel(v as 'nmbnew' | 'bank' | 'iphone_bank')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="nmbnew">NMB</SelectItem>
                <SelectItem value="bank">CRDB</SelectItem>
                <SelectItem value="iphone_bank">iPhone</SelectItem>
              </SelectContent>
            </Select>
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">Window source</span>
            <Select value={windowMode} onValueChange={(v) => setWindowMode(v as 'from_last' | 'explicit')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="from_last">From last consumed → now</SelectItem>
                <SelectItem value="explicit">Explicit time range</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        {windowMode === 'explicit' && (
          <div className="grid grid-cols-2 gap-3">
            <label className="space-y-1">
              <span className="text-sm font-medium">Since (EAT — UTC+3)</span>
              <Input value={sinceIso} onChange={(e) => setSinceIso(e.target.value)} placeholder="03.06.2026T16:48:57 or 2026-06-03T16:48:57" />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">Until (EAT — UTC+3)</span>
              <Input value={untilIso} onChange={(e) => setUntilIso(e.target.value)} placeholder="03.06.2026T23:59:59 or 2026-06-03T23:59:59" />
            </label>
          </div>
        )}
        <div className="grid grid-cols-3 gap-3">
          <label className="space-y-1">
            <span className="text-sm font-medium">AS_OF (bank-txn day)</span>
            <Input value={asOf} onChange={(e) => setAsOf(e.target.value)} placeholder="2026-06-03" />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">TxnDate (QB booking)</span>
            <Input value={txnDate} onChange={(e) => setTxnDate(e.target.value)} placeholder="2026-06-04" />
          </label>
          <label className="space-y-1">
            <span className="text-sm font-medium">Mode</span>
            <Select value={mode} onValueChange={(v) => setMode(v as 'plan' | 'execute')}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="plan">Plan (dry-run)</SelectItem>
                <SelectItem value="execute">Execute (real QB writes)</SelectItem>
              </SelectContent>
            </Select>
          </label>
        </div>
        <div className="text-xs text-muted-foreground space-y-1">
          <div>
            <strong>AS_OF</strong> = the calendar day the bank txn happened (controls matching pool).
          </div>
          <div>
            <strong>TxnDate</strong> = the date the QB Payment is dated. Past 16:15 EAT cutoff → tomorrow.
          </div>
          <div>
            They are independent. Never set AS_OF=tomorrow for today's deposits.
          </div>
        </div>
        {result && <div className="text-sm text-emerald-600">{result}</div>}
        {error && <div className="text-sm text-red-600">{error}</div>}
        <Button onClick={fire} disabled={firing} className={mode === 'execute' ? 'bg-red-600 hover:bg-red-700' : ''}>
          {firing ? 'Firing…' : mode === 'execute' ? 'Fire (REAL WRITES)' : 'Fire (plan-only)'}
        </Button>
      </CardContent>
    </Card>
  );
}

function SchedulerToggle() {
  const [status, setStatus] = useState<{ enabled: boolean; env_master_switch: boolean; last_changed: string | null; last_changed_by: string | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try { setStatus(await getSchedulerStatus()); setErr(null); }
    catch (e) { setErr((e as Error).message); }
  }, []);
  useEffect(() => { void refresh(); }, [refresh]);
  const toggle = async () => {
    if (!status) return;
    setBusy(true); setErr(null);
    try {
      const r = await setSchedulerEnabled(!status.enabled);
      setStatus((s) => s ? { ...s, enabled: r.enabled, last_changed: new Date().toISOString(), last_changed_by: 'dashboard' } : s);
    } catch (e) { setErr((e as Error).message); }
    finally { setBusy(false); }
  };
  if (!status) return null;
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Activity className="size-5" /> Scheduled cycles (7 daily ticks)
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex items-center justify-between">
          <div>
            <div className="text-sm font-medium">
              Status:{' '}
              <Badge variant={status.enabled ? 'default' : 'destructive'}>
                {status.enabled ? 'ON — ticks will fire' : 'OFF — paused'}
              </Badge>
            </div>
            <div className="text-xs text-muted-foreground mt-1">
              meru0300 (catchup) · hanang0700 · loolmalas1000 · lengai1300 · kili1615 · mawenzi1800 · kibo2100
            </div>
            {status.last_changed && (
              <div className="text-xs text-muted-foreground mt-1">
                Last changed: {new Date(status.last_changed).toISOString().slice(0, 19)} by {status.last_changed_by || 'unknown'}
              </div>
            )}
            {!status.env_master_switch && (
              <div className="text-xs text-red-600 mt-1">
                ⚠ AGENT_SCHEDULER_ENABLED=false on Render — scheduler is hard-disabled at the env level. Toggle here will be ignored until env is flipped.
              </div>
            )}
          </div>
          <Button
            onClick={toggle}
            disabled={busy || !status.env_master_switch}
            variant={status.enabled ? 'destructive' : 'default'}
            className="min-w-32"
          >
            {busy ? 'Saving…' : status.enabled ? 'Turn OFF' : 'Turn ON'}
          </Button>
        </div>
        {err && <div className="text-sm text-red-600">{err}</div>}
      </CardContent>
    </Card>
  );
}

function SessionsTable({ sessions, loading }: { sessions: AgentSessionRow[]; loading: boolean }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Bot className="size-5" /> Recent agent sessions
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading && sessions.length === 0 ? (
          <div className="text-sm text-muted-foreground">Loading…</div>
        ) : sessions.length === 0 ? (
          <div className="text-sm text-muted-foreground">No sessions yet.</div>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Started</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Mode</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="text-right">Cost</TableHead>
                <TableHead className="text-right">In tok</TableHead>
                <TableHead className="text-right">Out tok</TableHead>
                <TableHead>Summary</TableHead>
                <TableHead></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sessions.map((s) => (
                <TableRow key={s.id}>
                  <TableCell className="whitespace-nowrap text-xs">{relTime(s.started_at)}</TableCell>
                  <TableCell className="font-mono text-xs">{s.trigger}</TableCell>
                  <TableCell><Badge variant={s.mode === 'execute' ? 'default' : 'outline'}>{s.mode}</Badge></TableCell>
                  <TableCell><Badge variant={statusVariant(s.status)}>{s.status}</Badge></TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmtUsd(s.cost_usd)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmtTokens(s.input_tokens)}</TableCell>
                  <TableCell className="text-right font-mono text-xs">{fmtTokens(s.output_tokens)}</TableCell>
                  <TableCell className="text-xs max-w-md truncate" title={s.summary || ''}>{s.summary || '—'}</TableCell>
                  <TableCell>
                    <Link to={`/agent/${s.id}`} className="text-primary text-xs flex items-center gap-1">
                      View <ChevronRight className="size-3" />
                    </Link>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}

export function AgentPage() {
  const [sessions, setSessions] = useState<AgentSessionRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await listAgentSessions(50);
      setSessions(r.sessions);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <Fragment>
      <Toolbar>
        <ToolbarHeading
          title="Agent"
          description="Autonomous Claude sessions — scheduled ticks (meru0300, kili1615, kibo2100…) and heisenberg manual fires."
        />
        <ToolbarActions>
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </ToolbarActions>
      </Toolbar>
      <Container className="space-y-4">
        {error && (
          <div className="text-sm text-red-600 border border-red-200 bg-red-50 p-3 rounded">
            {error}
          </div>
        )}
        <SchedulerToggle />
        <HeisenbergForm onFired={refresh} />
        <SessionsTable sessions={sessions} loading={loading} />
      </Container>
    </Fragment>
  );
}
