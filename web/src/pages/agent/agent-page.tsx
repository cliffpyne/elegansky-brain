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
import { RefreshCw, ChevronRight, Zap, Bot } from 'lucide-react';
import {
  listAgentSessions,
  fireAgent,
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
  const [untilIso, setUntilIso] = useState<string>(nowIso());
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
        win.since_iso = new Date(sinceIso).toISOString();
        win.until_iso = new Date(untilIso).toISOString();
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
              <span className="text-sm font-medium">Since (ISO 8601 UTC)</span>
              <Input value={sinceIso} onChange={(e) => setSinceIso(e.target.value)} placeholder="2026-06-03T13:47:00Z" />
            </label>
            <label className="space-y-1">
              <span className="text-sm font-medium">Until (ISO 8601 UTC)</span>
              <Input value={untilIso} onChange={(e) => setUntilIso(e.target.value)} placeholder="2026-06-03T20:55:52Z" />
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
        <HeisenbergForm onFired={refresh} />
        <SessionsTable sessions={sessions} loading={loading} />
      </Container>
    </Fragment>
  );
}
