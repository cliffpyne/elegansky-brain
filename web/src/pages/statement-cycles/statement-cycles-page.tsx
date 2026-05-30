import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  Toolbar,
  ToolbarActions,
  ToolbarHeading,
} from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge, BadgeDot } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  ArrowUp,
  ArrowDown,
  RefreshCw,
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Landmark,
  Activity,
  Clock,
} from 'lucide-react';
import {
  listCycles,
  getSummary,
  relativeTime,
  formatDuration,
  type CycleSummaryRow,
  type SummaryResp,
} from '@/lib/brain-api';

const REFRESH_MS = 30_000;

export function StatementCyclesPage() {
  useDocumentTitle('BRAIN — Statement Cycles');

  const [summary, setSummary] = useState<SummaryResp | null>(null);
  const [cycles, setCycles] = useState<CycleSummaryRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [lastFetched, setLastFetched] = useState<Date | null>(null);

  const refresh = useCallback(async () => {
    try {
      const [s, l] = await Promise.all([getSummary(), listCycles({ limit: 100 })]);
      setSummary(s);
      setCycles(l.cycles);
      setError(null);
      setLastFetched(new Date());
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  const last = useMemo(() => {
    const map: Record<'NMB' | 'CRDB', SummaryResp['last'][number] | null> = { NMB: null, CRDB: null };
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

  const totals24h = useMemo(() => {
    const okN = counts24h.NMB.ok + counts24h.CRDB.ok;
    const failN = counts24h.NMB.fail + counts24h.CRDB.fail;
    const total = okN + failN;
    return { ok: okN, fail: failN, total, okPct: total ? Math.round((okN / total) * 100) : 100 };
  }, [counts24h]);

  return (
    <Fragment>
      <Container>
        <Toolbar>
          <ToolbarHeading
            title="Statement Cycles"
            description="Live status of the NMB + CRDB statement-pull worker on Render. Auto-refresh every 30s."
          />
          <ToolbarActions>
            <Button variant="outline" onClick={refresh} disabled={loading}>
              <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
          </ToolbarActions>
        </Toolbar>

        {error && (
          <Card className="mb-4 border-destructive/30 bg-destructive/5">
            <CardContent className="flex items-start gap-3 py-4">
              <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-destructive">Couldn’t reach BRAIN API</div>
                <div className="text-sm text-muted-foreground mt-1 break-all">{error}</div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Highlights + per-bank last-cycle cards */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mb-4">
          <HighlightsCard
            totals={totals24h}
            counts={counts24h}
          />
          <BankCard bank="NMB" row={last.NMB} counts={counts24h.NMB} />
          <BankCard bank="CRDB" row={last.CRDB} counts={counts24h.CRDB} />
        </div>

        {/* Recent cycles */}
        <Card>
          <CardHeader>
            <div className="flex items-start justify-between w-full">
              <div>
                <CardTitle>Recent cycles</CardTitle>
                <div className="text-xs text-muted-foreground mt-1">
                  Showing last {cycles.length} {cycles.length === 1 ? 'cycle' : 'cycles'}
                  {lastFetched && <> · Last fetched {relativeTime(lastFetched.toISOString())}</>}
                </div>
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>When</TableHead>
                  <TableHead>Bank</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Passed</TableHead>
                  <TableHead className="text-right">Review</TableHead>
                  <TableHead className="text-right">Skipped</TableHead>
                  <TableHead className="text-right">Failed</TableHead>
                  <TableHead className="text-right">Duration</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {cycles.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={9} className="text-center text-muted-foreground py-12">
                      <Activity className="size-8 mx-auto text-muted-foreground/40 mb-2" />
                      <div className="font-medium text-foreground/80">No cycles reported yet</div>
                      <div className="text-xs mt-1">
                        The worker posts here after each NMB + CRDB tick (every 30 min).
                      </div>
                    </TableCell>
                  </TableRow>
                )}
                {cycles.map((c) => (
                  <TableRow key={c.id} className="hover:bg-muted/30">
                    <TableCell className="whitespace-nowrap">
                      <div className="font-medium text-sm">{relativeTime(c.reported_at)}</div>
                      <div className="text-xs text-muted-foreground">
                        {new Date(c.reported_at).toLocaleString()}
                      </div>
                    </TableCell>
                    <TableCell>
                      <Badge
                        variant={c.bank === 'NMB' ? 'primary' : 'info'}
                        appearance="light"
                        className="gap-1"
                      >
                        <Landmark className="size-3" /> {c.bank}
                      </Badge>
                    </TableCell>
                    <TableCell>
                      <StatusBadge status={c.status} />
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium text-success">
                      {sumPassed(c.stats) || '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {c.stats?.needs_review ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {c.stats?.skipped ?? '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">
                      {(c.stats?.failed ?? 0) + (c.stats?.failed_nmb ?? 0) || '—'}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      <span className="inline-flex items-center gap-1 justify-end">
                        <Clock className="size-3" />
                        {formatDuration(c.duration_ms)}
                      </span>
                    </TableCell>
                    <TableCell>
                      <Button variant="ghost" size="sm" mode="icon" asChild>
                        <Link to={`/statement-cycles/${c.id}`}>
                          <ChevronRight className="size-4" />
                        </Link>
                      </Button>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Container>
    </Fragment>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Highlights — the Metronic-style KPI card with composition bar + legend
// + per-bank rows showing trend over the last 24h.

function HighlightsCard({
  totals,
  counts,
}: {
  totals: { ok: number; fail: number; total: number; okPct: number };
  counts: Record<'NMB' | 'CRDB', { ok: number; fail: number }>;
}) {
  const okPct = totals.okPct;
  const failPct = 100 - okPct;
  return (
    <Card className="h-full">
      <CardHeader>
        <CardTitle>Highlights · 24h</CardTitle>
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-5 lg:p-7.5 lg:pt-4">
        <div className="flex flex-col gap-0.5">
          <span className="text-sm font-normal text-secondary-foreground">Total ticks</span>
          <div className="flex items-center gap-2.5">
            <span className="text-3xl font-semibold text-mono tabular-nums">{totals.total}</span>
            {totals.total > 0 && (
              <Badge size="sm" variant={totals.fail === 0 ? 'success' : 'warning'} appearance="light">
                {okPct}% green
              </Badge>
            )}
          </div>
        </div>

        {/* Composition bar */}
        <div className="flex items-center gap-1 mb-1.5 h-2 w-full bg-muted rounded-xs overflow-hidden">
          {totals.total > 0 ? (
            <>
              <div className="bg-green-500 h-full" style={{ width: `${okPct}%` }} />
              <div className="bg-destructive h-full" style={{ width: `${failPct}%` }} />
            </>
          ) : (
            <div className="bg-muted h-full w-full" />
          )}
        </div>

        {/* Legend */}
        <div className="flex items-center flex-wrap gap-4 mb-1">
          <div className="flex items-center gap-1.5">
            <BadgeDot className="bg-green-500" />
            <span className="text-sm font-normal text-foreground">{totals.ok} ok</span>
          </div>
          <div className="flex items-center gap-1.5">
            <BadgeDot className="bg-destructive" />
            <span className="text-sm font-normal text-foreground">{totals.fail} fail</span>
          </div>
        </div>

        <div className="border-b border-input"></div>

        {/* Per-bank rows */}
        <div className="grid gap-3">
          <BankRow name="NMB" ok={counts.NMB.ok} fail={counts.NMB.fail} />
          <BankRow name="CRDB" ok={counts.CRDB.ok} fail={counts.CRDB.fail} />
        </div>
      </CardContent>
    </Card>
  );
}

function BankRow({ name, ok, fail }: { name: string; ok: number; fail: number }) {
  const total = ok + fail;
  const okPct = total ? Math.round((ok / total) * 100) : 100;
  const trendingUp = fail === 0;
  return (
    <div className="flex items-center justify-between flex-wrap gap-2">
      <div className="flex items-center gap-1.5">
        <Landmark className="size-4.5 text-muted-foreground" />
        <span className="text-sm font-normal text-mono">{name}</span>
      </div>
      <div className="flex items-center text-sm font-medium text-foreground gap-6">
        <span className="lg:text-right tabular-nums">{total}</span>
        <span className="flex items-center justify-end gap-1 min-w-[60px]">
          {total === 0 ? (
            <span className="text-muted-foreground">—</span>
          ) : trendingUp ? (
            <>
              <ArrowUp className="text-green-500 size-4" />
              <span className="tabular-nums">{okPct}%</span>
            </>
          ) : (
            <>
              <ArrowDown className="text-destructive size-4" />
              <span className="tabular-nums">{okPct}%</span>
            </>
          )}
        </span>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────────────────
// Per-bank "Last cycle" card — stats grid + drilldown link.

function BankCard({
  bank,
  row,
  counts,
}: {
  bank: 'NMB' | 'CRDB';
  row: SummaryResp['last'][number] | null;
  counts: { ok: number; fail: number };
}) {
  return (
    <Card className="h-full">
      <CardHeader>
        <div className="flex items-center gap-2 grow">
          <Landmark className="size-4 text-muted-foreground" />
          <CardTitle>{bank} · last cycle</CardTitle>
        </div>
        {row ? <StatusBadge status={row.status} /> : <Badge variant="outline">No data</Badge>}
      </CardHeader>
      <CardContent className="flex flex-col gap-4 p-5 lg:p-7.5 lg:pt-4">
        {row ? (
          <>
            <div className="flex flex-col gap-0.5">
              <span className="text-sm font-normal text-secondary-foreground">When</span>
              <div className="flex items-center gap-2.5">
                <span className="text-base font-semibold text-mono">
                  {relativeTime(row.reported_at)}
                </span>
                <span className="text-xs text-muted-foreground">
                  {new Date(row.reported_at).toLocaleString()}
                </span>
              </div>
            </div>

            {row.status === 'ok' ? (
              <div className="grid grid-cols-4 gap-2">
                <Stat label="Passed" value={sumPassed(row.stats)} tone="success" />
                <Stat label="Review" value={row.stats?.needs_review ?? 0} tone="warning" />
                <Stat label="Skipped" value={row.stats?.skipped ?? 0} tone="muted" />
                <Stat
                  label="Failed"
                  value={(row.stats?.failed ?? 0) + (row.stats?.failed_nmb ?? 0)}
                  tone="danger"
                />
              </div>
            ) : (
              <div className="text-sm text-destructive break-all line-clamp-4">
                {row.error_text || 'Unknown error'}
              </div>
            )}

            <div className="flex items-center justify-between pt-3 border-t border-input text-xs text-muted-foreground">
              <span className="flex items-center gap-1.5">
                <BadgeDot className="bg-green-500" /> {counts.ok} ok
                <span className="ms-2 inline-flex items-center gap-1.5">
                  <BadgeDot className="bg-destructive" /> {counts.fail} fail
                </span>
                <span className="ms-1">24h</span>
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
          <div className="text-sm text-muted-foreground py-6 text-center">
            Waiting for the first {bank} cycle to be reported by the worker.
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function StatusBadge({ status }: { status: 'ok' | 'fail' }) {
  return status === 'ok' ? (
    <Badge variant="success" appearance="light" className="gap-1">
      <CheckCircle2 className="size-3" /> ok
    </Badge>
  ) : (
    <Badge variant="destructive" appearance="light" className="gap-1">
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
    muted: 'text-foreground/80',
  }[tone];
  return (
    <div>
      <div className={`text-2xl font-semibold tabular-nums leading-tight ${cls}`}>{value}</div>
      <div className="text-xs text-muted-foreground mt-0.5">{label}</div>
    </div>
  );
}

function sumPassed(s: CycleSummaryRow['stats']): number {
  return (
    (s?.passed ?? 0) +
    (s?.passed_sav ?? 0) +
    (s?.passed_sav_nmb ?? 0) +
    (s?.iphone_passed ?? 0)
  );
}

// Lightweight hook — sets document.title on mount, restores on unmount.
function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

export default StatementCyclesPage;
