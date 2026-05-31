import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Toolbar,
  ToolbarActions,
  ToolbarHeading,
} from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import { RefreshCw, AlertCircle, CheckCircle2, ChevronRight, ChevronLeft, Power, PowerOff } from 'lucide-react';
import {
  listCycles,
  getSummary,
  relativeTime,
  formatDuration,
  getSetting,
  setSetting,
  fireCycle,
  type CycleSummaryRow,
  type SummaryResp,
  type Setting,
} from '@/lib/brain-api';
import { Play } from 'lucide-react';

const REFRESH_MS = 30_000;
const PAGE_SIZE = 50;

export function StatementCyclesPage() {
  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [cycles, setCycles] = useState<CycleSummaryRow[]>([]);
  const [pageInfo, setPageInfo] = useState<{ offset: number; total: number; has_more: boolean }>({
    offset: 0, total: 0, has_more: false,
  });
  const [loopSetting, setLoopSetting] = useState<Setting | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const refresh = useCallback(async (nextOffset?: number) => {
    const off = nextOffset ?? pageInfo.offset;
    try {
      const [s, l, ls] = await Promise.all([
        getSummary(),
        listCycles({ limit: PAGE_SIZE, offset: off }),
        getSetting('statement_pull_enabled').catch(() => null),
      ]);
      setSummary(s);
      setCycles(l.cycles);
      if (l.page) {
        setPageInfo({ offset: l.page.offset, total: l.page.total, has_more: l.page.has_more });
      }
      if (ls) setLoopSetting(ls);
      setError(null);
      setLastFetched(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [pageInfo.offset]);

  const goPage = useCallback(
    (delta: number) => {
      const next = Math.max(0, pageInfo.offset + delta * PAGE_SIZE);
      void refresh(next);
    },
    [pageInfo.offset, refresh],
  );

  const toggleLoop = useCallback(async () => {
    if (!loopSetting) return;
    const next = loopSetting.value === 'true' ? 'false' : 'true';
    setToggling(true);
    try {
      const updated = await setSetting('statement_pull_enabled', next);
      setLoopSetting(updated);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setToggling(false);
    }
  }, [loopSetting]);

  const [firing, setFiring] = useState<null | 'NMB' | 'CRDB'>(null);
  const fire = useCallback(async (bank: 'NMB' | 'CRDB') => {
    setFiring(bank);
    setError(null);
    try {
      await fireCycle(bank);
      // Pull the latest cycles in ~5s so the new attempt shows up.
      setTimeout(() => { void refresh(); }, 5000);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setFiring(null);
    }
  }, [refresh]);

  const loopEnabled = loopSetting?.value === 'true';
  const loopAutoDisabled = loopSetting?.updated_by?.startsWith('worker:auto-disable');

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const last = useMemo(() => {
    const map: Record<'NMB' | 'CRDB', SummaryResp['last'][number] | null> = {
      NMB: null,
      CRDB: null,
    };
    for (const row of summary?.last ?? []) map[row.bank] = row;
    return map;
  }, [summary]);

  const counts24h = useMemo(() => {
    const map: Record<'NMB' | 'CRDB', { ok: number; fail: number }> = {
      NMB: { ok: 0, fail: 0 },
      CRDB: { ok: 0, fail: 0 },
    };
    for (const c of summary?.counts_24h ?? []) {
      map[c.bank] = { ok: Number(c.ok_24h), fail: Number(c.fail_24h) };
    }
    return map;
  }, [summary]);

  return (
    <Fragment>
      <Container>
        <Toolbar>
          <ToolbarHeading
            title="Statement Cycles"
            description="Live status of NMB + CRDB statement-pull worker on Render. Auto-refresh every 30s."
          />
          <ToolbarActions>
            <Button
              variant="outline"
              onClick={() => fire('NMB')}
              disabled={firing !== null}
              className="gap-2"
              title="Run an NMB cycle now (Render one-off job)"
            >
              <Play className="size-4" />
              {firing === 'NMB' ? 'Firing…' : 'Fire NMB'}
            </Button>
            <Button
              variant="outline"
              onClick={() => fire('CRDB')}
              disabled={firing !== null}
              className="gap-2"
              title="Run a CRDB cycle now (Render one-off job)"
            >
              <Play className="size-4" />
              {firing === 'CRDB' ? 'Firing…' : 'Fire CRDB'}
            </Button>
            {loopSetting && (
              <Button
                variant={loopEnabled ? 'default' : 'destructive'}
                onClick={toggleLoop}
                disabled={toggling}
                className="gap-2"
              >
                {loopEnabled ? (
                  <>
                    <Power className="size-4" /> Loop ON
                  </>
                ) : (
                  <>
                    <PowerOff className="size-4" /> Loop OFF
                  </>
                )}
              </Button>
            )}
            <Button variant="outline" onClick={refresh} disabled={loading}>
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </ToolbarActions>
        </Toolbar>

        {/* Auto-disabled banner — explains why the loop is off so admin knows
            what to investigate before flipping it back on. */}
        {loopSetting && !loopEnabled && (
          <Card
            className={`mb-4 ${loopAutoDisabled ? 'border-destructive/30 bg-destructive/5' : 'border-amber-500/30 bg-amber-500/5'}`}
          >
            <CardContent className="flex items-start gap-3 py-4">
              <AlertCircle
                className={`size-5 shrink-0 mt-0.5 ${loopAutoDisabled ? 'text-destructive' : 'text-amber-600'}`}
              />
              <div className="flex-1">
                <div className={`font-medium ${loopAutoDisabled ? 'text-destructive' : 'text-amber-700'}`}>
                  Loop is OFF — no new cycles will run until you turn it back on.
                </div>
                <div className="text-sm text-muted-foreground mt-1">
                  {loopAutoDisabled
                    ? 'The worker auto-disabled the loop after 3 failed retries. Reason: '
                    : 'Disabled by '}
                  <span className="font-mono">{loopSetting.updated_by ?? 'unknown'}</span>
                  {' · '}
                  <span>{new Date(loopSetting.updated_at).toLocaleString()}</span>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {error && (
          <Card className="mb-4 border-destructive/30 bg-destructive/5">
            <CardContent className="flex items-start gap-3 py-4">
              <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-destructive">Couldn’t reach BRAIN API</div>
                <div className="text-sm text-muted-foreground mt-1">{error}</div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Status cards */}
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mb-6">
          <BankStatusCard
            bank="NMB"
            row={last.NMB}
            counts={counts24h.NMB}
          />
          <BankStatusCard
            bank="CRDB"
            row={last.CRDB}
            counts={counts24h.CRDB}
          />
        </div>

        {/* Cycle history table */}
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Recent cycles</CardTitle>
            {lastFetched && (
              <div className="text-xs text-muted-foreground">
                Last fetched {relativeTime(lastFetched.toISOString())}
              </div>
            )}
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Bank</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Passed</TableHead>
                  <TableHead className="text-right">Needs review</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cycles.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-8">
                      No cycles reported yet. The worker reports here after each
                      NMB + CRDB tick.
                    </TableCell>
                  </TableRow>
                )}
                {cycles.map((c) => (
                  <TableRow key={c.id}>
                    <TableCell className="whitespace-nowrap">
                      <div className="font-medium">{relativeTime(c.reported_at)}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(c.reported_at).toLocaleString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge variant={c.bank === 'NMB' ? 'default' : 'secondary'}>{c.bank}</Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {sumPassed(c.stats)}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.stats?.needs_review ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.stats?.skipped ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.stats
                        ? (c.stats.failed ?? 0) + (c.stats.failed_nmb ?? 0)
                        : '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {formatDuration(c.duration_ms)}
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" asChild>
                        <Link to={`/statement-cycles/${c.id}`}>
                          <ChevronRight className="size-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {pageInfo.total > PAGE_SIZE && (
              <div className="flex items-center justify-between border-t px-4 py-3 text-sm text-muted-foreground">
                <span>
                  Showing {pageInfo.offset + 1}–{Math.min(pageInfo.offset + cycles.length, pageInfo.total)} of {pageInfo.total.toLocaleString()}
                </span>
                <div className="flex items-center gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goPage(-1)}
                    disabled={pageInfo.offset === 0 || loading}
                  >
                    <ChevronLeft className="size-4" />
                    Previous
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => goPage(1)}
                    disabled={!pageInfo.has_more || loading}
                  >
                    Next
                    <ChevronRight className="size-4" />
                  </Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      </Container>
    </Fragment>
  );
}

function BankStatusCard({
  bank,
  row,
  counts,
}: {
  bank: 'NMB' | 'CRDB';
  row: SummaryResp['last'][number] | null;
  counts: { ok: number; fail: number };
}) {
  return (
    <Card>
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Last {bank} cycle</CardTitle>
          {row ? <StatusBadge status={row.status} /> : <Badge variant="outline">No data</Badge>}
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {row ? (
          <>
            <div className="text-sm">
              <span className="font-medium">{relativeTime(row.reported_at)}</span>
              <span className="text-muted-foreground ml-2">
                {new Date(row.reported_at).toLocaleString()}
              </span>
            </div>
            {row.status === 'ok' ? (
              <div className="grid grid-cols-4 gap-2 text-sm">
                <Stat label="Passed" value={sumPassed(row.stats)} tone="success" />
                <Stat label="Review" value={row.stats?.needs_review ?? 0} tone="warning" />
                <Stat label="Skipped" value={row.stats?.skipped ?? 0} tone="muted" />
                <Stat label="Failed" value={(row.stats?.failed ?? 0) + (row.stats?.failed_nmb ?? 0)} tone="danger" />
              </div>
            ) : (
              <div className="text-sm text-destructive whitespace-pre-wrap break-all line-clamp-3">
                {row.error_text || 'Unknown error'}
              </div>
            )}
            <div className="flex items-center justify-between pt-3 border-t text-xs text-muted-foreground">
              <span>
                Last 24h: <strong className="text-success">{counts.ok} ok</strong> ·{' '}
                <strong className="text-destructive">{counts.fail} fail</strong>
              </span>
              <Link
                to={`/statement-cycles/${row.id}`}
                className="text-primary hover:underline inline-flex items-center gap-1"
              >
                Details <ChevronRight className="size-3" />
              </Link>
            </div>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">
            Waiting for the first {bank} cycle to be reported by the worker.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: 'ok' | 'fail' }) {
  return status === 'ok' ? (
    <Badge variant="default" className="bg-success text-success-foreground gap-1">
      <CheckCircle2 className="size-3" /> ok
    </Badge>
  ) : (
    <Badge variant="destructive" className="gap-1">
      <AlertCircle className="size-3" /> fail
    </Badge>
  );
}

function Stat({
  label,
  value,
  tone,
}: {
  label: string;
  value: number;
  tone: 'success' | 'warning' | 'danger' | 'muted';
}) {
  const cls = {
    success: 'text-success',
    warning: 'text-warning',
    danger: 'text-destructive',
    muted: 'text-muted-foreground',
  }[tone];
  return (
    <div>
      <div className={`text-xl font-semibold tabular-nums ${cls}`}>{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}

// Returns the summed passed count, or '—' if there are no stats at all.
// We don't want failed cycles (which carry stats=null because the processor
// never returned) to render as "0 passed" — that's indistinguishable from
// "the processor ran and 0 rows passed" and confuses the operator.
function sumPassed(s: CycleSummaryRow['stats']): number | string {
  if (!s) return '—';
  const total =
    (s.passed ?? 0) +
    (s.passed_sav ?? 0) +
    (s.passed_sav_nmb ?? 0) +
    (s.iphone_passed ?? 0);
  return total;
}

export default StatementCyclesPage;
