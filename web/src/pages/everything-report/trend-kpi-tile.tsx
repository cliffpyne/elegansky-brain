import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Minus, Maximize2 } from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Card, CardContent } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getMegaReportSeries, type DailySummary } from '@/lib/brain-api';
import { fmt, fmtPct } from './shared';

export type MetricExtractor = (d: DailySummary) => number | null;

interface TrendKpiTileProps {
  label: string;
  current: number | null;
  previous: number | null;
  invertDirection?: boolean;
  formatter?: (n: number | null) => string;
  /** Function to extract the metric from a DailySummary row */
  extractor: MetricExtractor;
  /** YYYY-MM-DD anchor date (used to center the trend windows) */
  anchor: string;
  /** Optional officer filter */
  officerId?: string;
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function startOfMonth(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1)).toISOString().slice(0, 10);
}
function endOfMonth(date: string): string {
  const d = new Date(date + 'T00:00:00Z');
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).toISOString().slice(0, 10);
}

/**
 * Lazy fetcher: only triggers when `enabled` flips true. Returns the daily
 * series for a given window. Caches results per (from,to,officer) key in
 * a module-level Map to avoid refetching when the same hover/dialog is
 * re-opened.
 */
const seriesCache = new Map<string, DailySummary[]>();
function useDailySeries(from: string, to: string, officerId: string | undefined, enabled: boolean) {
  const [data, setData] = useState<DailySummary[] | null>(null);
  const [loading, setLoading] = useState(false);
  const inFlight = useRef<string | null>(null);
  useEffect(() => {
    if (!enabled) return;
    const key = `${from}|${to}|${officerId || ''}`;
    const cached = seriesCache.get(key);
    if (cached) { setData(cached); return; }
    if (inFlight.current === key) return;
    inFlight.current = key;
    setLoading(true);
    getMegaReportSeries({ from, to, officer_id: officerId })
      .then((r) => { seriesCache.set(key, r.days); setData(r.days); })
      .catch(() => setData([]))
      .finally(() => { setLoading(false); inFlight.current = null; });
  }, [enabled, from, to, officerId]);
  return { data, loading };
}

export function TrendKpiTile({
  label, current, previous, invertDirection, formatter = fmt, extractor, anchor, officerId,
}: TrendKpiTileProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  // Direction badge
  const delta = current != null && previous != null ? current - previous : null;
  const pct = previous != null && previous !== 0 && current != null ? ((current - previous) / Math.abs(previous)) * 100 : null;
  const dir: 'up' | 'down' | 'flat' = delta == null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const good = invertDirection
    ? (dir === 'down' ? 'good' : dir === 'up' ? 'bad' : 'flat')
    : (dir === 'up' ? 'good' : dir === 'down' ? 'bad' : 'flat');
  const Icon = dir === 'up' ? ArrowUp : dir === 'down' ? ArrowDown : Minus;

  // Hover series — last 7 days ending at anchor
  const weekFrom = useMemo(() => addDays(anchor, -6), [anchor]);
  const weekTo = anchor;
  const week = useDailySeries(weekFrom, weekTo, officerId, hoverOpen);

  // Dialog series — full calendar month containing anchor
  const monthFrom = useMemo(() => startOfMonth(anchor), [anchor]);
  const monthTo = useMemo(() => endOfMonth(anchor), [anchor]);
  const month = useDailySeries(monthFrom, monthTo, officerId, dialogOpen);

  const weekPoints = useMemo(() => {
    if (!week.data) return [];
    return week.data.map((d) => ({ date: d.date.slice(5), value: extractor(d) ?? 0 }));
  }, [week.data, extractor]);

  const monthPoints = useMemo(() => {
    if (!month.data) return [];
    return month.data.map((d) => ({ date: d.date.slice(5), value: extractor(d) ?? 0 }));
  }, [month.data, extractor]);

  return (
    <>
      <HoverCard openDelay={150} closeDelay={50} onOpenChange={setHoverOpen}>
        <HoverCardTrigger asChild>
          <Card
            className="cursor-pointer hover:border-primary/40 transition-colors"
            onClick={() => setDialogOpen(true)}
          >
            <CardContent className="p-5">
              <div className="text-sm text-muted-foreground mb-1">{label}</div>
              <div className="text-2xl font-semibold tracking-tight font-mono">{formatter(current)}</div>
              <div className="mt-2 flex items-center gap-2 text-xs">
                <Badge variant={good === 'good' ? 'success' : good === 'bad' ? 'destructive' : 'outline'} className="gap-1">
                  <Icon className="size-3" />
                  {fmtPct(pct)}
                </Badge>
                <span className="text-muted-foreground">vs prev: {formatter(previous)}</span>
              </div>
            </CardContent>
          </Card>
        </HoverCardTrigger>
        <HoverCardContent className="w-80 p-4" side="top" align="center">
          <div className="text-sm font-medium mb-1">{label}</div>
          <div className="text-xs text-muted-foreground mb-3">Last 7 days · click tile for monthly + day detail</div>
          {week.loading && <div className="h-32 grid place-items-center text-xs text-muted-foreground">Loading…</div>}
          {!week.loading && weekPoints.length > 0 && (
            <div className="h-32">
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={weekPoints} margin={{ top: 5, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="kpi-spark" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" hide />
                  <YAxis hide />
                  <Tooltip
                    formatter={(v: number) => [formatter(v), label]}
                    contentStyle={{ fontSize: 11, padding: '4px 8px' }}
                  />
                  <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" fill="url(#kpi-spark)" strokeWidth={1.6} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          )}
        </HoverCardContent>
      </HoverCard>

      <Dialog open={dialogOpen} onOpenChange={(o) => { setDialogOpen(o); if (!o) setShowDetails(false); }}>
        <DialogContent className="max-w-4xl">
          <DialogHeader>
            <DialogTitle>{label} — monthly view</DialogTitle>
            <DialogDescription>
              {monthFrom} → {monthTo} · {showDetails ? 'day-by-day breakdown' : 'click "Detailed" for day-by-day'}
            </DialogDescription>
          </DialogHeader>

          {month.loading && <div className="h-64 grid place-items-center text-sm text-muted-foreground">Loading month series…</div>}

          {!month.loading && monthPoints.length > 0 && !showDetails && (
            <>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthPoints} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v)} />
                    <Tooltip
                      formatter={(v: number) => [formatter(v), label]}
                      labelFormatter={(l) => `Date: ${l}`}
                      contentStyle={{ fontSize: 12 }}
                    />
                    <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-end gap-2 pt-2">
                <Button onClick={() => setShowDetails(true)}>
                  <Maximize2 className="size-4 mr-2" />
                  Detailed
                </Button>
              </div>
            </>
          )}

          {!month.loading && showDetails && (
            <div className="max-h-[60vh] overflow-y-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="text-right">{label}</TableHead>
                    <TableHead className="text-right">Δ vs prev day</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {monthPoints.map((p, i) => {
                    const prev = i > 0 ? monthPoints[i - 1].value : null;
                    const d = prev != null ? p.value - prev : null;
                    return (
                      <TableRow key={p.date}>
                        <TableCell>{p.date}</TableCell>
                        <TableCell className="text-right font-mono">{formatter(p.value)}</TableCell>
                        <TableCell className={`text-right font-mono ${d == null ? '' : d > 0 ? 'text-green-700' : d < 0 ? 'text-red-700' : ''}`}>
                          {d == null ? '—' : (d > 0 ? '+' : '') + formatter(d)}
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </DialogContent>
      </Dialog>
    </>
  );
}
