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
  refreshOfficerOfflineMotos,
  rebuildOfficerMap,
  type OfficerReport,
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
  const [error, setError] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState<string | null>(null); // which button is busy
  const [lastFetch, setLastFetch] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await getOfficerReportToday();
      setReport(r);
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

  const onRefreshInvoices = async () => {
    setRefreshing('invoices');
    try { await refreshOfficerInvoiceTotals(true); setTimeout(load, 4000); }
    catch (e) { setError(String((e as Error).message || e)); }
    finally { setTimeout(() => setRefreshing(null), 5000); }
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

      {grand && (
        <div className="grid grid-cols-2 md:grid-cols-4 gap-3 mb-4">
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
