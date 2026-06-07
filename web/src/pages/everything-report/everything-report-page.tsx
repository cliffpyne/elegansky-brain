import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from '@/components/ui/table';
import { RefreshCw, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import {
  getMegaReport,
  refreshOfficerInvoiceTotals,
  refreshOfficerArrears,
  refreshOfficerOfflineMotos,
  type MegaReport,
} from '@/lib/brain-api';

const fmt = (n: number | null | undefined) =>
  n == null ? '—' : Math.round(n).toLocaleString();
const fmtPct = (p: number | null | undefined) =>
  p == null ? '—' : p.toFixed(1) + '%';

type Granularity = 'day' | 'week' | 'month' | 'range';

function todayEatStr() {
  const eat = new Date(Date.now() + 3 * 3600_000);
  return eat.toISOString().slice(0, 10);
}

export function EverythingReportPage() {
  const [granularity, setGranularity] = useState<Granularity>('day');
  const [anchor, setAnchor] = useState<string>(todayEatStr());
  const [from, setFrom] = useState<string>(todayEatStr());
  const [to, setTo] = useState<string>(todayEatStr());
  const [officerFilter, setOfficerFilter] = useState<string>('');
  const [report, setReport] = useState<MegaReport | null>(null);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, string> = { granularity };
      if (granularity === 'range') {
        params.from = from; params.to = to;
      } else {
        params.anchor = anchor;
      }
      if (officerFilter) params.officer_id = officerFilter;
      const r = await getMegaReport(params);
      setReport(r);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setLoading(false);
    }
  }, [granularity, anchor, from, to, officerFilter]);

  useEffect(() => { load(); }, [load]);

  // Full refresh: refetch motorcycles + invoice totals + arrears, then reload report.
  const onFullRefresh = async () => {
    setRefreshing('all');
    try {
      await Promise.all([
        refreshOfficerOfflineMotos().catch(() => null),
        refreshOfficerInvoiceTotals(true).catch(() => null),
        refreshOfficerArrears(true).catch(() => null),
      ]);
      // Give the snapshots ~3s to settle.
      await new Promise((r) => setTimeout(r, 3000));
      await load();
    } finally {
      setRefreshing(null);
    }
  };

  const sectionA = report?.section_a_account_balance;
  const sectionB = report?.section_b_sheet_totals;
  const officersAgg = report?.section_c_d_officers;
  const trend = report?.section_e_company_arrear_trend;

  const officerOptions = useMemo(() => {
    if (!officersAgg) return [];
    return officersAgg.officers.map((o) => ({
      id: String(o.officer_id),
      name: o.officer_name || o.officer_id,
    }));
  }, [officersAgg]);

  return (
    <Container>
      <Toolbar>
        <ToolbarHeading title="Everything Report" description="All sections — refresh button refetches motorcycles, invoices, arrears, then report" />
        <ToolbarActions>
          <Button onClick={onFullRefresh} disabled={!!refreshing || loading}>
            <RefreshCw className={`mr-2 size-4 ${refreshing === 'all' ? 'animate-spin' : ''}`} />
            {refreshing === 'all' ? 'Refreshing all…' : 'Refresh all (live)'}
          </Button>
        </ToolbarActions>
      </Toolbar>

      {error && (
        <Card className="border-destructive">
          <CardContent className="text-destructive p-4">{error}</CardContent>
        </Card>
      )}

      {/* Filter bar */}
      <Card>
        <CardContent className="flex flex-wrap items-end gap-3 p-4">
          <div>
            <div className="text-xs text-muted-foreground mb-1">Granularity</div>
            <select
              value={granularity}
              onChange={(e) => setGranularity(e.target.value as Granularity)}
              className="border rounded px-2 py-1 text-sm"
            >
              <option value="day">Day</option>
              <option value="week">Week (Sun–Sat)</option>
              <option value="month">Month</option>
              <option value="range">Date range</option>
            </select>
          </div>
          {granularity === 'range' ? (
            <>
              <div>
                <div className="text-xs text-muted-foreground mb-1">From</div>
                <Input type="date" value={from} onChange={(e) => setFrom(e.target.value)} />
              </div>
              <div>
                <div className="text-xs text-muted-foreground mb-1">To</div>
                <Input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
              </div>
            </>
          ) : (
            <div>
              <div className="text-xs text-muted-foreground mb-1">Anchor date</div>
              <Input type="date" value={anchor} onChange={(e) => setAnchor(e.target.value)} />
            </div>
          )}
          <div>
            <div className="text-xs text-muted-foreground mb-1">Officer</div>
            <select
              value={officerFilter}
              onChange={(e) => setOfficerFilter(e.target.value)}
              className="border rounded px-2 py-1 text-sm min-w-[200px]"
            >
              <option value="">All officers</option>
              {officerOptions.map((o) => (
                <option key={o.id} value={o.id}>{o.name}</option>
              ))}
            </select>
          </div>
          <Button variant="outline" onClick={load} disabled={loading}>
            {loading ? 'Loading…' : 'Apply filters'}
          </Button>
          {lastFetch && (
            <div className="text-xs text-muted-foreground ml-auto">
              Window: {report?.window.from} → {report?.window.to} · Fetched {lastFetch.toLocaleTimeString()}
            </div>
          )}
        </CardContent>
      </Card>

      {/* Section A — QB Account Balance */}
      <Card>
        <CardHeader><CardTitle>A · QB Kijichi Collection AC balance</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead>Amount (TZS)</TableHead>
                <TableHead>As of</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Opening balance (start of window)</TableCell>
                <TableCell className="font-mono">{fmt(sectionA?.opening)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{sectionA?.opening_as_of}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Closing balance (end of window)</TableCell>
                <TableCell className="font-mono">{fmt(sectionA?.closing)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">{sectionA?.closing_as_of}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Δ in window (closing − opening)</TableCell>
                <TableCell className="font-mono">{fmt(sectionA?.delta_in_window)}</TableCell>
                <TableCell>—</TableCell>
              </TableRow>
              <TableRow className="bg-muted/30">
                <TableCell className="font-semibold">Live (right now)</TableCell>
                <TableCell className="font-mono font-semibold">{fmt(sectionA?.live)}</TableCell>
                <TableCell className="text-xs text-muted-foreground">now</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Section B — Sheet Totals */}
      <Card>
        <CardHeader><CardTitle>B · Google Sheets totals (PASSED + FAILED + UNUSED)</CardTitle></CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">PASSED rows</TableHead>
                <TableHead className="text-right">PASSED total</TableHead>
                <TableHead className="text-right">FAILED rows</TableHead>
                <TableHead className="text-right">FAILED total</TableHead>
                <TableHead className="text-right">UNUSED rows</TableHead>
                <TableHead className="text-right">UNUSED total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {sectionB && Object.entries(sectionB.by_channel).map(([ch, v]) => (
                <TableRow key={ch}>
                  <TableCell className="font-medium">{ch}</TableCell>
                  <TableCell className="text-right">{fmt(v.passed.rows)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(v.passed.total)}</TableCell>
                  <TableCell className="text-right">{fmt(v.failed.rows)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(v.failed.total)}</TableCell>
                  <TableCell className="text-right">{fmt(v.unused.total_rows)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(v.unused.total_amount)}</TableCell>
                </TableRow>
              ))}
              {sectionB && (
                <TableRow className="bg-muted/30 font-semibold">
                  <TableCell>TOTAL</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right font-mono">{fmt(sectionB.grand_passed_total)}</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right font-mono">{fmt(sectionB.grand_failed_total)}</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right font-mono">{fmt(sectionB.grand_unused_total)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Section E — Company arrear trend */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            E · Company arrear trend (vs immediately-prior window)
            {trend && (
              <Badge variant={trend.direction === 'up' ? 'destructive' : trend.direction === 'down' ? 'success' : 'outline'}>
                {trend.direction === 'up' && <TrendingUp className="size-3 mr-1" />}
                {trend.direction === 'down' && <TrendingDown className="size-3 mr-1" />}
                {trend.direction === 'flat' && <Minus className="size-3 mr-1" />}
                {trend.direction === 'up' ? 'GROWING' : trend.direction === 'down' ? 'SHRINKING' : 'FLAT'}
              </Badge>
            )}
          </CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Window</TableHead>
                <TableHead className="text-right">Real-time arrears (sum)</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Current</TableCell>
                <TableCell className="text-right font-mono">{fmt(trend?.current)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Previous (same length)</TableCell>
                <TableCell className="text-right font-mono">{fmt(trend?.previous)}</TableCell>
              </TableRow>
              <TableRow className="bg-muted/30">
                <TableCell className="font-semibold">Δ</TableCell>
                <TableCell className="text-right font-mono font-semibold">
                  {fmt(trend?.delta)} ({fmtPct(trend?.pct_change)})
                </TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </CardContent>
      </Card>

      {/* Section C+D — Officers */}
      <Card>
        <CardHeader>
          <CardTitle>C+D · Officers — invoice open, % collected, arrear open + collected</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Officer</TableHead>
                  <TableHead className="text-right">Invoice amount</TableHead>
                  <TableHead className="text-right">Balance remain</TableHead>
                  <TableHead className="text-right">Moto office</TableHead>
                  <TableHead className="text-right">Moto police</TableHead>
                  <TableHead className="text-right">Adjustment (×12k)</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">% collected</TableHead>
                  <TableHead className="text-right">Arrear morning</TableHead>
                  <TableHead className="text-right">Arrear now</TableHead>
                  <TableHead className="text-right">Arrear collected</TableHead>
                  <TableHead className="text-right">% arrear</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {officersAgg?.officers.map((o) => (
                  <TableRow key={o.officer_id}>
                    <TableCell className="whitespace-nowrap">{o.officer_name}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.total_invoice_amount)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.today_balance_remain)}</TableCell>
                    <TableCell className="text-right">{fmt(o.motos_office)}</TableCell>
                    <TableCell className="text-right">{fmt(o.motos_police)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.adjustment)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.open)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.collected)}</TableCell>
                    <TableCell className="text-right">{fmtPct(o.pct_collected)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.arrears_morning)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.arrears_realtime)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.arrear_collected)}</TableCell>
                    <TableCell className="text-right">{fmtPct(o.arrear_pct_collected)}</TableCell>
                  </TableRow>
                ))}
                {officersAgg && (
                  <TableRow className="bg-muted/30 font-semibold">
                    <TableCell>TOTAL</TableCell>
                    <TableCell className="text-right font-mono">{fmt(officersAgg.grand.total_invoice_amount)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(officersAgg.grand.today_balance_remain)}</TableCell>
                    <TableCell className="text-right">{fmt(officersAgg.grand.motos_office)}</TableCell>
                    <TableCell className="text-right">{fmt(officersAgg.grand.motos_police)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(officersAgg.grand.adjustment)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(officersAgg.grand.open)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(officersAgg.grand.collected)}</TableCell>
                    <TableCell className="text-right">{fmtPct(officersAgg.grand.pct_collected)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(officersAgg.grand.arrears_morning)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(officersAgg.grand.arrears_realtime)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(officersAgg.grand.arrear_collected)}</TableCell>
                    <TableCell className="text-right">{fmtPct(officersAgg.grand.arrear_pct_collected)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </Container>
  );
}
