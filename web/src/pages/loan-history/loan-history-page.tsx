import { useCallback, useEffect, useState } from 'react';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, AlertTriangle } from 'lucide-react';
import { getLoanLog, recallByLog, type LoanLogRow } from '@/lib/brain-api';

const fmt = (s: string | null | number | undefined) =>
  s == null ? '—' : Number(s).toLocaleString();
const fmtDate = (s: string | null) => (s ? s.slice(0, 10) : '—');
const fmtDateTime = (s: string | null) => {
  if (!s) return '—';
  const d = new Date(s);
  return d.toLocaleString(undefined, { dateStyle: 'short', timeStyle: 'short' });
};

function statusBadge(s: string | null) {
  if (s === 'success') return <Badge variant="default">success</Badge>;
  if (s === 'partial') return <Badge className="bg-amber-500">partial</Badge>;
  if (s === 'recalled') return <Badge variant="outline">recalled</Badge>;
  if (s === 'failed') return <Badge variant="destructive">failed</Badge>;
  return <Badge variant="outline">{s || '—'}</Badge>;
}

function typeLabel(r: LoanLogRow): string {
  // new-loan fires have an estimate_qb_id; add-invoices fires don't
  return r.estimate_qb_id ? 'New loan' : 'Add invoices';
}

export function LoanHistoryPage() {
  const [rows, setRows] = useState<LoanLogRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recallingId, setRecallingId] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true); setError(null);
    try {
      const r = await getLoanLog(200);
      setRows(r.rows);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, [load]);

  const onRecall = async (row: LoanLogRow) => {
    if (row.status === 'recalled') {
      alert('Already recalled.');
      return;
    }
    const what = row.estimate_qb_id
      ? `the customer + estimate + ${row.invoice_count ?? 0} invoices`
      : `${row.invoice_count ?? 0} invoices (customer kept)`;
    if (!confirm(`Recall ${what}?\n\nThis deletes from QB. Irreversible.`)) return;
    setRecallingId(row.id);
    try {
      const rec = await recallByLog(row.id);
      if (rec.ok) {
        alert(`Recalled. Invoices deleted: ${rec.invoices.deleted}/${rec.invoices.planned}` +
          (rec.estimate ? `, estimate deleted: ${rec.estimate.deleted}` : '') +
          (rec.customer ? `, customer deactivated: ${rec.customer.deactivated}` : ''));
      } else {
        alert(`Partial recall: ${rec.invoices.deleted}/${rec.invoices.planned} invoices deleted, ${rec.invoices.failure_count} failed.`);
      }
      await load();
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setRecallingId(null);
    }
  };

  return (
    <>
      <Toolbar>
        <ToolbarHeading title="Loan history" description="All new-loan + add-invoices fires — recall any of them later" />
        <ToolbarActions>
          <Button variant="outline" onClick={load} disabled={loading}>
            <RefreshCw className="size-4" /> {loading ? 'Loading…' : 'Refresh'}
          </Button>
        </ToolbarActions>
      </Toolbar>

      <Container>
        {error && (
          <Card className="mb-4 border-destructive">
            <CardContent className="py-3 text-destructive flex items-center gap-2">
              <AlertTriangle className="size-4" /> {error}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardHeader>
            <CardTitle>{rows.length} most recent</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Type</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Invoices</TableHead>
                  <TableHead className="text-right">Total (TZS)</TableHead>
                  <TableHead>Start → End</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Action</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {rows.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={8} className="text-center text-muted-foreground">
                      No loan/invoice fires yet — use New loan or Add invoices.
                    </TableCell>
                  </TableRow>
                )}
                {rows.map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs whitespace-nowrap">{fmtDateTime(r.created_at)}</TableCell>
                    <TableCell>{typeLabel(r)}</TableCell>
                    <TableCell className="text-xs">
                      <div className="font-medium">{r.customer_display_name || '—'}</div>
                      <div className="text-muted-foreground">QB id {r.customer_qb_id}</div>
                    </TableCell>
                    <TableCell className="text-right">{fmt(r.invoice_count)}</TableCell>
                    <TableCell className="text-right">{fmt(r.total_amount)}</TableCell>
                    <TableCell className="text-xs whitespace-nowrap">{fmtDate(r.start_date)} → {fmtDate(r.end_date)}</TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                    <TableCell className="text-right">
                      {r.status === 'recalled' ? (
                        <span className="text-xs text-muted-foreground">already recalled</span>
                      ) : (
                        <Button
                          variant="destructive"
                          size="sm"
                          onClick={() => onRecall(r)}
                          disabled={recallingId === r.id}
                        >
                          {recallingId === r.id ? 'Recalling…' : 'Recall'}
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      </Container>
    </>
  );
}
