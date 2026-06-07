import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowDown, ArrowUp, Minus, Maximize2 } from 'lucide-react';
import {
  Area, AreaChart, Bar, BarChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis,
} from 'recharts';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import {
  Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle,
} from '@/components/ui/dialog';
import { HoverCard, HoverCardContent, HoverCardTrigger } from '@/components/ui/hover-card';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { getMegaReportSeries, type DailySummary } from '@/lib/brain-api';
import { fmt, fmtPct } from './shared';

export type MetricExtractor = (d: DailySummary) => number | null;

interface TrendCellProps {
  label: string;
  value: number | null;
  invertDirection?: boolean;
  formatter?: (n: number | null) => string;
  extractor: MetricExtractor;
  anchor: string;
  officerId?: string;
}

function addDays(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
function addYears(date: string, n: number): string {
  const d = new Date(date + 'T00:00:00Z');
  d.setUTCFullYear(d.getUTCFullYear() + n);
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

const seriesCache = new Map<string, DailySummary[]>();
const singleDayCache = new Map<string, number | null>();

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

/**
 * Fetch single-day values (for the comparison points — yesterday, last week,
 * last month, last year same date). Cached aggressively since most cells on
 * a page will reuse the same dates.
 */
function useSingleDayValues(
  dates: string[],
  extractor: MetricExtractor,
  officerId: string | undefined,
  enabled: boolean,
) {
  const [vals, setVals] = useState<Record<string, number | null>>({});
  useEffect(() => {
    if (!enabled) return;
    const needed = dates.filter((d) => {
      const k = `${d}|${officerId || ''}`;
      return !singleDayCache.has(k);
    });
    if (needed.length === 0) {
      setVals(Object.fromEntries(dates.map((d) => [d, singleDayCache.get(`${d}|${officerId || ''}`) ?? null])));
      return;
    }
    Promise.all(needed.map((d) =>
      getMegaReportSeries({ from: d, to: d, officer_id: officerId })
        .then((r) => {
          const v = extractor(r.days[0]);
          singleDayCache.set(`${d}|${officerId || ''}`, v);
          return [d, v] as const;
        })
        .catch(() => [d, null] as const),
    )).then(() => {
      setVals(Object.fromEntries(dates.map((d) => [d, singleDayCache.get(`${d}|${officerId || ''}`) ?? null])));
    });
  }, [enabled, dates.join(','), officerId, extractor]);
  return vals;
}

export function TrendCell({
  label, value, invertDirection, formatter = fmt, extractor, anchor, officerId,
}: TrendCellProps) {
  const [hoverOpen, setHoverOpen] = useState(false);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  const refs = useMemo(() => ({
    yesterday: addDays(anchor, -1),
    dayBefore: addDays(anchor, -2),
    lastWeek: addDays(anchor, -7),
    lastMonth: addDays(anchor, -30),
    lastYear: addYears(anchor, -1),
  }), [anchor]);

  const refDates = useMemo(() => Object.values(refs), [refs]);
  const refValues = useSingleDayValues(refDates, extractor, officerId, hoverOpen);

  const weekFrom = useMemo(() => addDays(anchor, -6), [anchor]);
  const week = useDailySeries(weekFrom, anchor, officerId, hoverOpen);

  const monthFrom = useMemo(() => startOfMonth(anchor), [anchor]);
  const monthTo = useMemo(() => endOfMonth(anchor), [anchor]);
  const month = useDailySeries(monthFrom, monthTo, officerId, dialogOpen);

  const weekPoints = useMemo(
    () => (week.data || []).map((d) => ({ date: d.date.slice(5), value: extractor(d) ?? 0 })),
    [week.data, extractor],
  );
  const monthPoints = useMemo(
    () => (month.data || []).map((d) => ({ date: d.date.slice(5), value: extractor(d) ?? 0 })),
    [month.data, extractor],
  );

  const yest = refValues[refs.yesterday] ?? null;
  const delta = value != null && yest != null ? value - yest : null;
  const pct = yest != null && yest !== 0 && value != null ? ((value - yest) / Math.abs(yest)) * 100 : null;
  const dir: 'up' | 'down' | 'flat' = delta == null ? 'flat' : delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const good = invertDirection
    ? (dir === 'down' ? 'good' : dir === 'up' ? 'bad' : 'flat')
    : (dir === 'up' ? 'good' : dir === 'down' ? 'bad' : 'flat');
  const Icon = dir === 'up' ? ArrowUp : dir === 'down' ? ArrowDown : Minus;

  return (
    <>
      <HoverCard openDelay={150} closeDelay={50} onOpenChange={setHoverOpen}>
        <HoverCardTrigger asChild>
          <span
            className="cursor-pointer font-mono inline-flex items-center gap-1 hover:underline decoration-dotted underline-offset-2"
            onClick={(e) => { e.stopPropagation(); setDialogOpen(true); }}
          >
            {formatter(value)}
          </span>
        </HoverCardTrigger>
        <HoverCardContent className="w-72 p-3" side="top" align="center">
          <div className="text-xs font-semibold mb-1">{label}</div>
          <div className="text-base font-mono">{formatter(value)}</div>
          <div className="flex items-center gap-1.5 mt-1">
            <Badge variant={good === 'good' ? 'success' : good === 'bad' ? 'destructive' : 'outline'} className="gap-1 text-[10px] h-5">
              <Icon className="size-2.5" />
              {fmtPct(pct)}
            </Badge>
            <span className="text-[11px] text-muted-foreground">vs yesterday</span>
          </div>
          <div className="h-20 mt-2">
            {week.loading && <div className="grid place-items-center h-full text-[10px] text-muted-foreground">Loading…</div>}
            {!week.loading && weekPoints.length > 0 && (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={weekPoints} margin={{ top: 4, right: 0, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="cell-spark" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="hsl(var(--primary))" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="hsl(var(--primary))" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <XAxis dataKey="date" hide />
                  <YAxis hide />
                  <Tooltip formatter={(v: number) => [formatter(v), label]} contentStyle={{ fontSize: 10, padding: '3px 6px' }} />
                  <Area type="monotone" dataKey="value" stroke="hsl(var(--primary))" fill="url(#cell-spark)" strokeWidth={1.4} />
                </AreaChart>
              </ResponsiveContainer>
            )}
          </div>
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 mt-2 text-[11px]">
            <span className="text-muted-foreground">Yesterday</span>
            <span className="text-right font-mono">{formatter(refValues[refs.yesterday] ?? null)}</span>
            <span className="text-muted-foreground">Day before</span>
            <span className="text-right font-mono">{formatter(refValues[refs.dayBefore] ?? null)}</span>
            <span className="text-muted-foreground">Last week</span>
            <span className="text-right font-mono">{formatter(refValues[refs.lastWeek] ?? null)}</span>
            <span className="text-muted-foreground">Last month</span>
            <span className="text-right font-mono">{formatter(refValues[refs.lastMonth] ?? null)}</span>
            <span className="text-muted-foreground">Last year</span>
            <span className="text-right font-mono">{formatter(refValues[refs.lastYear] ?? null)}</span>
          </div>
          <div className="text-[10px] text-muted-foreground mt-2 italic">click cell for monthly + day-by-day</div>
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

          {month.loading && <div className="h-64 grid place-items-center text-sm text-muted-foreground">Loading…</div>}

          {!month.loading && monthPoints.length > 0 && !showDetails && (
            <>
              <div className="h-72">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={monthPoints} margin={{ top: 10, right: 10, left: 0, bottom: 5 }}>
                    <CartesianGrid strokeDasharray="3 3" stroke="hsl(var(--border))" />
                    <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                    <YAxis tick={{ fontSize: 11 }} tickFormatter={(v) => fmt(v)} />
                    <Tooltip formatter={(v: number) => [formatter(v), label]} labelFormatter={(l) => `Date: ${l}`} contentStyle={{ fontSize: 12 }} />
                    <Bar dataKey="value" fill="hsl(var(--primary))" radius={[4, 4, 0, 0]} />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              <div className="flex justify-end pt-2">
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
