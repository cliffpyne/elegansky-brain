import { Fragment, useCallback, useEffect, useMemo, useState } from 'react';
import {
  Toolbar,
  ToolbarActions,
  ToolbarHeading,
} from '@/layouts/demo1/components/toolbar';
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
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  Download,
  RefreshCw,
  AlertCircle,
  Search,
  ChevronLeft,
  ChevronRight,
} from 'lucide-react';
import {
  listArrears,
  getArrearsSummary,
  formatTzs,
  type ArrearRow,
  type ArrearsSummaryResp,
} from '@/lib/brain-api';

const PAGE_SIZE = 100;

export function ArrearsPage() {
  useDocumentTitle('BRAIN — Arrears');

  const [summary, setSummary] = useState<ArrearsSummaryResp | null>(null);
  const [rows, setRows] = useState<ArrearRow[]>([]);
  const [start, setStart] = useState(1);
  const [hasMore, setHasMore] = useState(false);

  const [branch, setBranch] = useState<string>('all');
  const [q, setQ] = useState<string>('');
  const [qDebounced, setQDebounced] = useState<string>('');

  const [loadingList, setLoadingList] = useState(true);
  const [loadingSummary, setLoadingSummary] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Debounce search input to 350ms so we don't fire a fetch per keystroke.
  useEffect(() => {
    const t = setTimeout(() => setQDebounced(q), 350);
    return () => clearTimeout(t);
  }, [q]);

  // Re-fetch summary when filters change.
  useEffect(() => {
    setLoadingSummary(true);
    getArrearsSummary({ branch: branch === 'all' ? undefined : branch })
      .then(setSummary)
      .catch((e) => setError((e as Error).message))
      .finally(() => setLoadingSummary(false));
  }, [branch]);

  // Reset to page 1 when filters change.
  useEffect(() => {
    setStart(1);
  }, [branch, qDebounced]);

  // Fetch list page.
  const refreshList = useCallback(async () => {
    setLoadingList(true);
    try {
      const r = await listArrears({
        pageSize: PAGE_SIZE,
        start,
        branch: branch === 'all' ? undefined : branch,
        q: qDebounced || undefined,
      });
      setRows(r.invoices);
      setHasMore(!!r.page.nextStart);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [start, branch, qDebounced]);

  useEffect(() => {
    refreshList();
  }, [refreshList]);

  const branches = useMemo(() => {
    const entries = Object.entries(summary?.branches ?? {});
    entries.sort((a, b) => b[1] - a[1]);
    return entries;
  }, [summary]);

  const totalCount = summary?.count ?? 0;
  const totalBalance = summary?.totalBalance ?? 0;
  const topBranch = branches[0];

  /** Client-side Export-to-Excel of the CURRENTLY-FILTERED full set. */
  const exportExcel = useCallback(async () => {
    if (!summary || summary.count === 0) return;
    // Page through every matching row, then build a SheetJS workbook in the browser.
    // For 13k rows this is ~14 fetches of 1000 — runs in 5-15s.
    setLoadingList(true);
    try {
      const PAGE = 1000;
      let s = 1;
      const out: ArrearRow[] = [];
      while (true) {
        const r = await listArrears({
          pageSize: PAGE,
          start: s,
          branch: branch === 'all' ? undefined : branch,
          q: qDebounced || undefined,
        });
        out.push(...r.invoices);
        if (!r.page.nextStart) break;
        s = r.page.nextStart;
      }
      // Dynamic import of xlsx so we don't bloat the initial bundle.
      const XLSX = await import('xlsx');
      const aoa: (string | number)[][] = [
        ['Date', 'Type', 'No.', 'Customer', 'Memo', 'Balance', 'Amount', 'Status'],
      ];
      for (const r of out) {
        aoa.push([r.date, r.type, r.no, r.customer, r.memo, r.balance, r.amount, r.status]);
      }
      const ws = XLSX.utils.aoa_to_sheet(aoa);
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, ws, 'Arrears');
      const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-');
      XLSX.writeFile(wb, `brain-arrears-${stamp}.xlsx`);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoadingList(false);
    }
  }, [summary, branch, qDebounced]);

  return (
    <Fragment>
      <Container>
        <div className="space-y-5">
        <Toolbar>
          <ToolbarHeading
            title="Arrears"
            description="Overdue, still-unpaid invoices — live from QuickBooks. Replaces the manual ARREAR.xls download."
          />
          <ToolbarActions>
            <Button variant="outline" onClick={refreshList} disabled={loadingList}>
              <RefreshCw className={`size-4 ${loadingList ? 'animate-spin' : ''}`} />
              Refresh
            </Button>
            <Button onClick={exportExcel} disabled={loadingList || totalCount === 0}>
              <Download className="size-4" />
              Export {totalCount > 0 ? `(${totalCount.toLocaleString()})` : ''}
            </Button>
          </ToolbarActions>
        </Toolbar>

        {error && (
          <Card className="mb-4 border-destructive/30 bg-destructive/5">
            <CardContent className="flex items-start gap-3 py-4">
              <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
              <div>
                <div className="font-medium text-destructive">Couldn’t reach BRAIN /arrears</div>
                <div className="text-sm text-muted-foreground mt-1 break-all">{error}</div>
                <div className="text-xs text-muted-foreground mt-2">
                  Most common cause: QuickBooks not connected on this BRAIN deploy.
                  Visit <code>/connect</code> on BRAIN to authorise.
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Summary row */}
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-4">
          <SummaryCard
            label="Overdue invoices"
            value={loadingSummary ? '…' : totalCount.toLocaleString()}
            sub={summary?.asOf ? `as of ${summary.asOf}` : ''}
          />
          <SummaryCard
            label="Total outstanding"
            value={loadingSummary ? '…' : formatTzs(totalBalance)}
            sub={branch === 'all' ? 'all branches' : `branch: ${branch}`}
            tone="success"
          />
          <SummaryCard
            label="Top branch"
            value={loadingSummary || !topBranch ? '…' : topBranch[0]}
            sub={loadingSummary || !topBranch ? '' : `${topBranch[1].toLocaleString()} rows`}
          />
        </div>

        {/* Filter row */}
        <Card className="mb-4">
          <CardContent className="flex flex-wrap items-center gap-3 py-4">
            <div className="relative flex-1 min-w-[260px]">
              <Search className="size-4 absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground" />
              <Input
                placeholder="Search customer or invoice #"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                className="pl-9"
              />
            </div>
            <div className="min-w-[260px]">
              <Select value={branch} onValueChange={setBranch}>
                <SelectTrigger>
                  <SelectValue placeholder="Branch" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="all">All branches</SelectItem>
                  {branches.map(([name, n]) => (
                    <SelectItem key={name} value={name}>
                      {name} ({n.toLocaleString()})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </CardContent>
        </Card>

        {/* Table */}
        <Card>
          <CardHeader>
            <div className="flex items-center justify-between w-full">
              <CardTitle>Recent overdue</CardTitle>
              <div className="text-xs text-muted-foreground">
                Page {Math.ceil(start / PAGE_SIZE)} · showing {rows.length} of {totalCount.toLocaleString()}
              </div>
            </div>
          </CardHeader>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow className="bg-muted/40">
                  <TableHead>Date</TableHead>
                  <TableHead>Invoice #</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Balance</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loadingList && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground py-12">
                      {totalCount === 0
                        ? 'No overdue invoices for this filter.'
                        : 'Loading…'}
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.qbId} className="hover:bg-muted/30">
                    <TableCell className="whitespace-nowrap tabular-nums">{r.date}</TableCell>
                    <TableCell className="font-medium">{r.no}</TableCell>
                    <TableCell>
                      <div className="text-sm">{r.customerLeaf}</div>
                      <div className="text-xs text-muted-foreground line-clamp-1">{r.customer}</div>
                    </TableCell>
                    <TableCell className="text-right tabular-nums font-medium text-destructive">
                      {r.balance.toLocaleString()}
                    </TableCell>
                    <TableCell className="text-right tabular-nums text-muted-foreground">
                      {r.amount.toLocaleString()}
                    </TableCell>
                    <TableCell>
                      <Badge variant="destructive" appearance="light">{r.status}</Badge>
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
          <div className="flex items-center justify-between p-3 border-t">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStart(Math.max(1, start - PAGE_SIZE))}
              disabled={start <= 1 || loadingList}
            >
              <ChevronLeft className="size-4" /> Previous
            </Button>
            <div className="text-xs text-muted-foreground">
              Showing rows {start.toLocaleString()}–{(start + rows.length - 1).toLocaleString()}
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setStart(start + PAGE_SIZE)}
              disabled={!hasMore || loadingList}
            >
              Next <ChevronRight className="size-4" />
            </Button>
          </div>
        </Card>
      </div>
      </Container>
    </Fragment>
  );
}

function SummaryCard({
  label,
  value,
  sub,
  tone,
}: {
  label: string;
  value: string;
  sub?: string;
  tone?: 'success' | 'danger' | 'muted';
}) {
  const valueCls = {
    success: 'text-success',
    danger: 'text-destructive',
    muted: 'text-foreground',
    undefined: 'text-foreground',
  }[tone ?? ('undefined' as const)];
  return (
    <Card>
      <CardContent className="py-5">
        <div className="text-xs uppercase tracking-wide text-muted-foreground">{label}</div>
        <div className={`text-3xl font-semibold tabular-nums mt-1.5 ${valueCls}`}>{value}</div>
        {sub && <div className="text-xs text-muted-foreground mt-1">{sub}</div>}
      </CardContent>
    </Card>
  );
}

function useDocumentTitle(title: string) {
  useEffect(() => {
    const prev = document.title;
    document.title = title;
    return () => {
      document.title = prev;
    };
  }, [title]);
}

export default ArrearsPage;
