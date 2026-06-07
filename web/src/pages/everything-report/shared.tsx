import { useCallback, useEffect, useMemo, useState } from 'react';
import { ArrowUp, ArrowDown, Minus, RefreshCw } from 'lucide-react';
import { Card, CardContent, CardHeader, CardHeading, CardTitle, CardToolbar } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { getMegaReport, type MegaReport } from '@/lib/brain-api';

export type Granularity = 'day' | 'week' | 'month' | 'range';

export const fmt = (n: number | null | undefined) =>
  n == null ? '—' : Math.round(n).toLocaleString();
export const fmt2 = (n: number | null | undefined) =>
  n == null ? '—' : n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
export const fmtPct = (p: number | null | undefined) =>
  p == null ? '—' : (p >= 0 ? '+' : '') + p.toFixed(1) + '%';

export function todayEatStr() {
  const eat = new Date(Date.now() + 3 * 3600_000);
  return eat.toISOString().slice(0, 10);
}

/**
 * Resolve a granularity+anchor into [from, to] and the immediately-prior
 * window of the same length (used for comparison).
 */
export function resolveWindow(granularity: Granularity, anchor: string, rangeFrom?: string, rangeTo?: string) {
  if (granularity === 'range') {
    const from = rangeFrom || anchor; const to = rangeTo || anchor;
    const fd = new Date(from + 'T00:00:00Z'); const td = new Date(to + 'T00:00:00Z');
    const days = Math.round((td.getTime() - fd.getTime()) / (24 * 3600_000)) + 1;
    const prevTo = new Date(fd); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
    const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - (days - 1));
    return {
      current: { from, to },
      previous: { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) },
    };
  }
  const d = new Date(anchor + 'T00:00:00Z');
  let curFrom = d, curTo = d;
  if (granularity === 'week') {
    const dow = d.getUTCDay();
    curFrom = new Date(d); curFrom.setUTCDate(curFrom.getUTCDate() - dow);
    curTo = new Date(curFrom); curTo.setUTCDate(curTo.getUTCDate() + 6);
  } else if (granularity === 'month') {
    curFrom = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), 1));
    curTo = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0));
  }
  const len = Math.round((curTo.getTime() - curFrom.getTime()) / (24 * 3600_000)) + 1;
  const prevTo = new Date(curFrom); prevTo.setUTCDate(prevTo.getUTCDate() - 1);
  const prevFrom = new Date(prevTo); prevFrom.setUTCDate(prevFrom.getUTCDate() - (len - 1));
  return {
    current: { from: curFrom.toISOString().slice(0, 10), to: curTo.toISOString().slice(0, 10) },
    previous: { from: prevFrom.toISOString().slice(0, 10), to: prevTo.toISOString().slice(0, 10) },
  };
}

export interface SectionFilterState {
  granularity: Granularity;
  anchor: string;
  rangeFrom: string;
  rangeTo: string;
  officerId: string;
}

interface FilterBarProps {
  state: SectionFilterState;
  onChange: (s: SectionFilterState) => void;
  onRefresh: () => void;
  loading?: boolean;
  officerOptions?: { id: string; name: string }[];
}

export function SectionFilterBar({ state, onChange, onRefresh, loading, officerOptions = [] }: FilterBarProps) {
  return (
    <Card>
      <CardContent className="flex flex-wrap items-end gap-3 p-4">
        <div className="min-w-[140px]">
          <div className="text-xs text-muted-foreground mb-1">Granularity</div>
          <Select value={state.granularity} onValueChange={(v) => onChange({ ...state, granularity: v as Granularity })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="day">Day</SelectItem>
              <SelectItem value="week">Week (Sun–Sat)</SelectItem>
              <SelectItem value="month">Month</SelectItem>
              <SelectItem value="range">Date range</SelectItem>
            </SelectContent>
          </Select>
        </div>
        {state.granularity === 'range' ? (
          <>
            <div>
              <div className="text-xs text-muted-foreground mb-1">From</div>
              <Input type="date" value={state.rangeFrom} onChange={(e) => onChange({ ...state, rangeFrom: e.target.value })} />
            </div>
            <div>
              <div className="text-xs text-muted-foreground mb-1">To</div>
              <Input type="date" value={state.rangeTo} onChange={(e) => onChange({ ...state, rangeTo: e.target.value })} />
            </div>
          </>
        ) : (
          <div>
            <div className="text-xs text-muted-foreground mb-1">Anchor date</div>
            <Input type="date" value={state.anchor} onChange={(e) => onChange({ ...state, anchor: e.target.value })} />
          </div>
        )}
        <div className="min-w-[220px]">
          <div className="text-xs text-muted-foreground mb-1">Officer</div>
          <Select value={state.officerId || 'all'} onValueChange={(v) => onChange({ ...state, officerId: v === 'all' ? '' : v })}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="all">All officers</SelectItem>
              {officerOptions.map((o) => <SelectItem key={o.id} value={o.id}>{o.name}</SelectItem>)}
            </SelectContent>
          </Select>
        </div>
        <Button onClick={onRefresh} disabled={loading} className="ml-auto">
          <RefreshCw className={`size-4 mr-2 ${loading ? 'animate-spin' : ''}`} />
          {loading ? 'Loading…' : 'Refresh'}
        </Button>
      </CardContent>
    </Card>
  );
}

interface ComparisonTileProps {
  label: string;
  current: number | null;
  previous: number | null;
  invertDirection?: boolean;   // when going DOWN is "good" (e.g. arrears)
  formatter?: (n: number | null) => string;
}

export function ComparisonKpiTile({ label, current, previous, invertDirection, formatter = fmt }: ComparisonTileProps) {
  const delta = current != null && previous != null ? current - previous : null;
  const pct = previous != null && previous !== 0 && current != null ? ((current - previous) / Math.abs(previous)) * 100 : null;
  let dir: 'up' | 'down' | 'flat' = 'flat';
  if (delta != null) dir = delta > 0 ? 'up' : delta < 0 ? 'down' : 'flat';
  const good = invertDirection
    ? (dir === 'down' ? 'good' : dir === 'up' ? 'bad' : 'flat')
    : (dir === 'up' ? 'good' : dir === 'down' ? 'bad' : 'flat');
  const Icon = dir === 'up' ? ArrowUp : dir === 'down' ? ArrowDown : Minus;
  return (
    <Card>
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
  );
}

/**
 * Fetches the report for the current window AND the immediately-prior window
 * of the same length. Caller uses both to compute deltas + trend.
 */
export function useReportComparison(state: SectionFilterState) {
  const [current, setCurrent] = useState<MegaReport | null>(null);
  const [previous, setPrevious] = useState<MegaReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const windows = useMemo(
    () => resolveWindow(state.granularity, state.anchor, state.rangeFrom, state.rangeTo),
    [state.granularity, state.anchor, state.rangeFrom, state.rangeTo],
  );

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [cur, prev] = await Promise.all([
        getMegaReport({ granularity: 'range', from: windows.current.from, to: windows.current.to, officer_id: state.officerId || undefined }),
        getMegaReport({ granularity: 'range', from: windows.previous.from, to: windows.previous.to, officer_id: state.officerId || undefined }).catch(() => null as unknown as MegaReport),
      ]);
      setCurrent(cur);
      setPrevious(prev);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, [windows, state.officerId]);

  useEffect(() => { void load(); }, [load]);

  return { current, previous, loading, error, lastFetch, windows, reload: load };
}

export function useDefaultFilter(): [SectionFilterState, (s: SectionFilterState) => void] {
  const today = todayEatStr();
  return useState<SectionFilterState>({
    granularity: 'day', anchor: today, rangeFrom: today, rangeTo: today, officerId: '',
  });
}

export function PageShell({ title, description, children }: { title: string; description?: string; children: React.ReactNode }) {
  return (
    <div className="space-y-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{title}</h1>
        {description && <p className="text-sm text-muted-foreground mt-1">{description}</p>}
      </div>
      {children}
    </div>
  );
}

export function SectionCard({ title, toolbar, children }: { title: string; toolbar?: React.ReactNode; children: React.ReactNode }) {
  return (
    <Card>
      <CardHeader>
        <CardHeading><CardTitle>{title}</CardTitle></CardHeading>
        {toolbar && <CardToolbar>{toolbar}</CardToolbar>}
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );
}
