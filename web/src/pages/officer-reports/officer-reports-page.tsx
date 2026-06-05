import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, FileSearch, MapPin } from 'lucide-react';
import {
  getOfficerReportToday,
  refreshOfficerInvoiceTotals,
  refreshOfficerArrears,
  refreshOfficerOfflineMotos,
  rebuildOfficerMap,
  getKijichiToday,
  getSheetTotalsUploadDay,
  getPaymentUploadsTodayTotals,
  type OfficerReport,
  type KijichiToday,
  type SheetTotalsUploadDay,
  type PaymentUploadsTotals,
} from '@/lib/brain-api';

const fmt = (n: number) => n.toLocaleString();
const fmtPercent = (p: number | null) => (p == null ? '—' : p.toFixed(1) + '%');
const fmtTime = (s: string | null) => {
  if (!s) return 'never';
  const d = new Date(s);
  const mm = String(d.getMinutes()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  return `${hh}:${mm}`;
};

export function OfficerReportsPage() {
  const [report, setReport] = useState<OfficerReport | null>(null);
  const [kijichi, setKijichi] = useState<KijichiToday | null>(null);
  const [sheetTotals, setSheetTotals] = useState<SheetTotalsUploadDay | null>(null);
  const [pushedTotals, setPushedTotals] = useState<PaymentUploadsTotals | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null); // which button is busy
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, k, s, p] = await Promise.all([
        getOfficerReportToday(),
        getKijichiToday().catch(() => null),
        getSheetTotalsUploadDay().catch(() => null),
        getPaymentUploadsTodayTotals().catch(() => null),
      ]);
      setReport(r);
      setKijichi(k);
      setSheetTotals(s);
      setPushedTotals(p);
      setError(null);
      setLastFetch(new Date());
    } catch (e) {
      setError(String((e as Error).message || e));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-refresh every 30s.
  useEffect(() => {
    const id = setInterval(load, 30_000);
    return () => clearInterval(id);
  }, [load]);

  // QB scans run in background and take ~60-90s. Poll the report's `fresh`
  // timestamp every 10s for up to 2 min, reload as soon as it advances.
  async function waitForFreshAdvance(getStamp: (r: OfficerReport) => string | null, deadlineMs = 120_000) {
    const baseline = report ? getStamp(report) : null;
    const start = Date.now();
    while (Date.now() - start < deadlineMs) {
      await new Promise(r => setTimeout(r, 10_000));
      try {
        const r = await getOfficerReportToday();
        const cur = getStamp(r);
        if (cur && cur !== baseline) { setReport(r); setLastFetch(new Date()); return; }
      } catch { /* keep polling */ }
    }
    // Fallback: do a final load so user sees whatever cache state is.
    await load();
  }

  const onRefreshInvoices = async () => {
    setRefreshing('invoices');
    try {
      await refreshOfficerInvoiceTotals(true);
      await waitForFreshAdvance((r) => r.fresh.invoice_totals_pulled_at);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setRefreshing(null);
    }
  };
  const onRefreshArrears = async () => {
    setRefreshing('arrears');
    try {
      await refreshOfficerArrears(true);
      await waitForFreshAdvance((r) => r.fresh.arrears_pulled_at);
    } catch (e) {
      setError(String((e as Error).message || e));
    } finally {
      setRefreshing(null);
    }
  };
  const onRefreshOffline = async () => {
    setRefreshing('offline');
    try { await refreshOfficerOfflineMotos(); setTimeout(load, 2000); }
    catch (e) { setError(String((e as Error).message || e)); }
    finally { setTimeout(() => setRefreshing(null), 3000); }
  };
  const onRebuildMap = async () => {
    setRefreshing('map');
    try { await rebuildOfficerMap(); setTimeout(load, 2000); }
    catch (e) { setError(String((e as Error).message || e)); }
    finally { setTimeout(() => setRefreshing(null), 3000); }
  };

  const rows = report?.per_officer || [];
  const grand = report?.grand_total;

  const statusBadge = (status: string, percent: number | null) => {
    if (status === 'good') return <Badge className="bg-green-600 hover:bg-green-700">GOOD</Badge>;
    if (status === 'bad')  return <Badge className="bg-red-600 hover:bg-red-700">BAD</Badge>;
    return <Badge variant="outline">no inv</Badge>;
  };

  return (
    <Container>
      <Toolbar>
        <ToolbarHeading>
          <div className="flex flex-col">
            <span className="text-lg font-semibold">Loan Officer Collections</span>
            <span className="text-xs text-muted-foreground">
              {report?.date} ·
              {' '}invoice totals pulled {fmtTime(report?.fresh?.invoice_totals_pulled_at || null)},
              {' '}OFFICE/POLICE pulled {fmtTime(report?.fresh?.offline_motos_pulled_at || null)} ·
              {' '}auto-refresh 30s · last fetch {lastFetch ? fmtTime(lastFetch.toISOString()) : '—'}
            </span>
          </div>
        </ToolbarHeading>
        <ToolbarActions>
          <Button variant="outline" size="sm" disabled={refreshing !== null} onClick={onRefreshInvoices}>
            <FileSearch className="h-4 w-4 mr-1" />
            {refreshing === 'invoices' ? 'Refreshing…' : 'Refresh invoices'}
          </Button>
          <Button variant="outline" size="sm" disabled={refreshing !== null} onClick={onRefreshArrears}>
            <FileSearch className="h-4 w-4 mr-1" />
            {refreshing === 'arrears' ? 'Scanning…' : 'Refresh arrears'}
          </Button>
          <Button variant="outline" size="sm" disabled={refreshing !== null} onClick={onRefreshOffline}>
            <RefreshCw className="h-4 w-4 mr-1" />
            {refreshing === 'offline' ? 'Pulling…' : 'Pull OFFICE/POLICE'}
          </Button>
          <Button variant="outline" size="sm" disabled={refreshing !== null} onClick={onRebuildMap}>
            <MapPin className="h-4 w-4 mr-1" />
            {refreshing === 'map' ? 'Rebuilding…' : 'Rebuild map'}
          </Button>
        </ToolbarActions>
      </Toolbar>

      {error && (
        <Card className="mb-4 border-red-300">
          <CardContent className="py-3 text-red-700 text-sm">Error: {error}</CardContent>
        </Card>
      )}

      {/* BRAIN-pushed today by channel — what actually landed in QB Payments today */}
      {pushedTotals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          {(() => {
            const nmb = pushedTotals.by_channel.find((c) => c.channel === 'nmbnew');
            const bank = pushedTotals.by_channel.find((c) => c.channel === 'bank');
            const iph = pushedTotals.by_channel.find((c) => c.channel === 'iphone_bank');
            const grand = pushedTotals.grand_total;
            return (
              <>
                <Card className="border-green-300">
                  <CardHeader className="pb-2">
                    <CardTitle className="text-sm text-green-700">BRAIN pushed today (all)</CardTitle>
                  </CardHeader>
                  <CardContent className="text-2xl font-bold text-green-700">
                    {fmt(grand.pushed_amount)}
                    <div className="text-xs font-normal text-muted-foreground">{grand.pushed_rows} txns</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">NMB pushed today</CardTitle></CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {fmt(nmb?.pushed_amount || 0)}
                    <div className="text-xs font-normal text-muted-foreground">{nmb?.pushed_rows || 0} txns</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">CRDB pushed today</CardTitle></CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {fmt(bank?.pushed_amount || 0)}
                    <div className="text-xs font-normal text-muted-foreground">{bank?.pushed_rows || 0} txns</div>
                  </CardContent>
                </Card>
                <Card>
                  <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">iPhone pushed today</CardTitle></CardHeader>
                  <CardContent className="text-2xl font-bold">
                    {fmt(iph?.pushed_amount || 0)}
                    <div className="text-xs font-normal text-muted-foreground">{iph?.pushed_rows || 0} txns</div>
                  </CardContent>
                </Card>
              </>
            );
          })()}
        </div>
      )}

      {/* Sheet-totals row: what's flowed in since the upload-day started (last kili1615) */}
      {sheetTotals && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-3">
          <Card className="border-purple-300">
            <CardHeader className="pb-2">
              <CardTitle className="text-sm text-purple-700">QB Kijichi today (all sources)</CardTitle>
            </CardHeader>
            <CardContent className="text-2xl font-bold text-purple-700">
              {kijichi ? fmt(kijichi.total) : '—'}
              <div className="text-xs font-normal text-muted-foreground">{kijichi ? kijichi.rows + ' txns' : ''}</div>
            </CardContent>
          </Card>
          {sheetTotals.by_channel.map((c) => (
            <Card key={c.channel}>
              <CardHeader className="pb-2">
                <CardTitle className="text-sm text-muted-foreground">
                  {c.channel === 'nmbnew' ? 'NMB sheet' : c.channel === 'bank' ? 'CRDB sheet' : 'iPhone sheet'}
                  <span className="text-xs"> (since last kili1615)</span>
                </CardTitle>
              </CardHeader>
              <CardContent className="text-2xl font-bold">
                {fmt(c.total)}
                <div className="text-xs font-normal text-muted-foreground">{c.rows} rows</div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      {grand && (
        <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3 mb-4">
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Open (today)</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold">{fmt(grand.open)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Collected</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold">{fmt(grand.collection)}</CardContent>
          </Card>
          <Card>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">Due Open</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold">{fmt(grand.dueopen)}</CardContent>
          </Card>
          <Card className="border-blue-300">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-blue-700">Arrears created today</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold text-blue-700">{fmt(grand.today_balance_remain)}</CardContent>
          </Card>
          <Card className="border-amber-300">
            <CardHeader className="pb-2"><CardTitle className="text-sm text-amber-700">Lifetime arrears</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold text-amber-700">{fmt(grand.total_arrears)}</CardContent>
          </Card>
          <Card className={grand.status === 'good' ? 'border-green-300' : grand.status === 'bad' ? 'border-red-300' : ''}>
            <CardHeader className="pb-2"><CardTitle className="text-sm text-muted-foreground">% Collection</CardTitle></CardHeader>
            <CardContent className="text-2xl font-bold flex items-center gap-2">
              {fmtPercent(grand.percent)} {statusBadge(grand.status, grand.percent)}
            </CardContent>
          </Card>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Per officer ({rows.length})</CardTitle>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Officer</TableHead>
                <TableHead className="text-right font-bold">Invoices (count)</TableHead>
                <TableHead className="text-right">Office</TableHead>
                <TableHead className="text-right">Police</TableHead>
                <TableHead className="text-right">Invoice total</TableHead>
                <TableHead className="text-right text-blue-700">Today's arrears (Remain)</TableHead>
                <TableHead className="text-right text-amber-700">Lifetime arrears</TableHead>
                <TableHead className="text-right">Adjustment</TableHead>
                <TableHead className="text-right">Open</TableHead>
                <TableHead className="text-right">Collected</TableHead>
                <TableHead className="text-right">Due open</TableHead>
                <TableHead className="text-right">%</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((r) => (
                <TableRow key={r.officer_id}>
                  <TableCell className="font-medium">{r.officer_name}</TableCell>
                  <TableCell className="text-right font-semibold">{fmt(r.open_invoice_count)}</TableCell>
                  <TableCell className="text-right">{fmt(r.office_count)}</TableCell>
                  <TableCell className="text-right">{fmt(r.police_count)}</TableCell>
                  <TableCell className="text-right">{fmt(r.total_invoice_amount)}</TableCell>
                  <TableCell className="text-right text-blue-700 font-semibold">{fmt(r.today_balance_remain)}</TableCell>
                  <TableCell className="text-right text-amber-700 font-semibold">{fmt(r.total_arrears)}</TableCell>
                  <TableCell className="text-right text-muted-foreground">−{fmt(r.offline_adjustment)}</TableCell>
                  <TableCell className="text-right font-semibold">{fmt(r.open)}</TableCell>
                  <TableCell className="text-right">{fmt(r.collection)}</TableCell>
                  <TableCell className="text-right">{fmt(r.dueopen)}</TableCell>
                  <TableCell className={`text-right font-bold ${r.status === 'good' ? 'text-green-700' : r.status === 'bad' ? 'text-red-700' : ''}`}>
                    {fmtPercent(r.percent)}
                  </TableCell>
                  <TableCell>{statusBadge(r.status, r.percent)}</TableCell>
                </TableRow>
              ))}
              {grand && (
                <TableRow className="font-bold bg-muted/40">
                  <TableCell>GRAND TOTAL</TableCell>
                  <TableCell className="text-right">{fmt(rows.reduce((a, r) => a + r.open_invoice_count, 0))}</TableCell>
                  <TableCell className="text-right">{fmt(grand.offline_count - rows.reduce((a, r) => a + r.police_count, 0))}</TableCell>
                  <TableCell className="text-right">{fmt(rows.reduce((a, r) => a + r.police_count, 0))}</TableCell>
                  <TableCell className="text-right">{fmt(grand.total_invoice_amount)}</TableCell>
                  <TableCell className="text-right text-blue-700">{fmt(grand.today_balance_remain)}</TableCell>
                  <TableCell className="text-right text-amber-700">{fmt(grand.total_arrears)}</TableCell>
                  <TableCell className="text-right">−{fmt(grand.offline_adjustment)}</TableCell>
                  <TableCell className="text-right">{fmt(grand.open)}</TableCell>
                  <TableCell className="text-right">{fmt(grand.collection)}</TableCell>
                  <TableCell className="text-right">{fmt(grand.dueopen)}</TableCell>
                  <TableCell className="text-right">{fmtPercent(grand.percent)}</TableCell>
                  <TableCell>{statusBadge(grand.status, grand.percent)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </Container>
  );
}
