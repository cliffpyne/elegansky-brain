import { Fragment, useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Undo2, RefreshCw, AlertCircle, Download, Database } from 'lucide-react';
import {
  getBatch,
  recallBatch,
  type PaymentBatchRow,
  type PaymentUploadRow,
  type ArrearsSnapshotSummary,
} from '@/lib/brain-api';

function fmt(n: number | string | null | undefined): string {
  if (n == null) return '-';
  const v = Number(n) || 0;
  return v.toLocaleString();
}

function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (s) {
    case 'finalized': return 'default';
    case 'pending': return 'secondary';
    case 'recalled': return 'outline';
    case 'rolled_back': return 'destructive';
    case 'created': return 'default';
    case 'voided': return 'outline';
    case 'failed': return 'destructive';
    case 'unmatched': return 'secondary';
    default: return 'outline';
  }
}

function downloadCsv(filename: string, rows: PaymentUploadRow[]) {
  const header = ['bank_ref', 'customer_name', 'customer_id', 'invoice_no', 'amount', 'memo', 'status'];
  const escape = (v: string | number | null | undefined) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.bank_ref, r.customer_name, r.customer_id, r.invoice_no, r.amount, r.memo, r.status,
    ].map(escape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

export function PaymentBatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [batch, setBatch] = useState<PaymentBatchRow | null>(null);
  const [uploads, setUploads] = useState<PaymentUploadRow[]>([]);
  const [snapshot, setSnapshot] = useState<ArrearsSnapshotSummary | null>(null);
  const [loading, setLoading] = useState(true);
  const [recalling, setRecalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const r = await getBatch(id);
      setBatch(r.batch);
      setUploads(r.uploads);
      setSnapshot(r.snapshot);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const onRecall = useCallback(async () => {
    if (!id || !batch) return;
    if (batch.status !== 'finalized') {
      setError(`Cannot recall a batch in status ${batch.status}`);
      return;
    }
    const ok = confirm(
      `Recall ${batch.paid_count} QB Payments? This voids every Payment + CreditMemo BRAIN created for this batch and releases the bank refs. Cannot be undone.`,
    );
    if (!ok) return;
    setRecalling(true);
    setError(null);
    try {
      await recallBatch(id);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setRecalling(false);
    }
  }, [id, batch, refresh]);

  const paid = uploads.filter((u) => u.kind === 'payment' && u.status !== 'unmatched');
  const creditsMatched = uploads.filter((u) => u.kind === 'credit_memo' && u.status !== 'unmatched');
  const unmatched = uploads.filter((u) => u.status === 'unmatched');

  return (
    <Fragment>
      <Toolbar>
        <ToolbarHeading
          title="Payment batch"
          description={batch ? `${batch.channel} · created ${new Date(batch.created_at).toLocaleString()}` : 'Loading…'}
        />
        <ToolbarActions>
          <Button variant="outline" asChild>
            <Link to="/payment-batches">Back to list</Link>
          </Button>
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
          {batch?.status === 'finalized' && (
            <Button variant="destructive" onClick={onRecall} disabled={recalling}>
              <Undo2 className="size-4" />
              {recalling ? 'Recalling…' : 'Recall batch'}
            </Button>
          )}
        </ToolbarActions>
      </Toolbar>
      <Container>
        {error && (
          <Card className="mb-4 border-destructive">
            <CardContent className="pt-6 text-destructive flex gap-2 items-start">
              <AlertCircle className="size-5 shrink-0" />
              {error}
            </CardContent>
          </Card>
        )}

        {batch && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-3">
                Batch <code className="text-sm font-mono">{batch.id.slice(0, 8)}</code>
                <Badge variant={statusVariant(batch.status)}>{batch.status}</Badge>
              </CardTitle>
              <CardDescription>{batch.channel} · sheet tab {batch.sheet_tab}</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div><div className="text-muted-foreground">Paid total</div><div className="font-medium text-lg tabular-nums">{fmt(batch.paid_total)} TZS</div></div>
                <div><div className="text-muted-foreground">Unused total</div><div className="font-medium text-lg tabular-nums">{fmt(batch.unused_total)} TZS</div></div>
                <div><div className="text-muted-foreground">Sheet sum (BRAIN check)</div><div className="font-medium text-lg tabular-nums">{fmt(batch.sheet_total)} TZS</div></div>
                <div><div className="text-muted-foreground">Rows</div><div className="font-medium text-lg">{batch.paid_count} paid · {batch.unused_count} unused</div></div>
                <div><div className="text-muted-foreground">Created by</div><div className="font-medium">{batch.created_by || '—'}</div></div>
                {batch.finalized_at && <div><div className="text-muted-foreground">Finalized</div><div className="font-medium">{new Date(batch.finalized_at).toLocaleString()}</div></div>}
                {batch.recalled_at && <div><div className="text-muted-foreground">Recalled</div><div className="font-medium">{new Date(batch.recalled_at).toLocaleString()}</div></div>}
                {batch.recalled_by && <div><div className="text-muted-foreground">Recalled by</div><div className="font-medium">{batch.recalled_by}</div></div>}
              </div>
              {batch.failure_reason && (
                <div className="mt-4 p-3 rounded-md bg-destructive/10 text-destructive text-sm">
                  <strong>Failure reason:</strong> {batch.failure_reason}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        {snapshot && (
          <Card className="mb-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Database className="size-4" />
                Arrears snapshot used by this batch
              </CardTitle>
              <CardDescription>
                The frozen list of overdue invoices the payment algorithm matched against. Same snapshot is reused on rerun.
              </CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div><div className="text-muted-foreground">Snapshot id</div><div className="font-mono text-xs">{snapshot.id.slice(0, 8)}</div></div>
                <div><div className="text-muted-foreground">As of</div><div className="font-medium">{snapshot.as_of}</div></div>
                <div><div className="text-muted-foreground">Invoices</div><div className="font-medium tabular-nums">{fmt(snapshot.row_count)}</div></div>
                <div><div className="text-muted-foreground">Total balance</div><div className="font-medium tabular-nums">{fmt(snapshot.total_balance)} TZS</div></div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Paid invoices ({paid.length})</CardTitle>
            <CardDescription>Each row is one QB Payment that was applied to an overdue invoice. Voided rows are recalled Payments.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bank ref</TableHead>
                  <TableHead>Invoice</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>QB Payment id</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {paid.slice(0, 500).map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs">{u.bank_ref}</TableCell>
                    <TableCell>{u.invoice_no || '—'}</TableCell>
                    <TableCell className="max-w-xs truncate" title={u.customer_name || u.customer_id}>
                      {u.customer_name || u.customer_id}
                    </TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(u.amount)}</TableCell>
                    <TableCell className="font-mono text-xs">{u.qb_id || '—'}</TableCell>
                    <TableCell><Badge variant={statusVariant(u.status)}>{u.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {paid.length > 500 && (
              <div className="text-sm text-muted-foreground mt-2">Showing first 500 of {paid.length} paid rows.</div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle>Credit memos created ({creditsMatched.length})</CardTitle>
            <CardDescription>
              Unused bank transactions whose customer was resolvable. Each row is a QB CreditMemo posted to that customer's account — credit applies to future invoices.
            </CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bank ref</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>QB CreditMemo id</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {creditsMatched.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No CreditMemos in this batch.
                    </TableCell>
                  </TableRow>
                )}
                {creditsMatched.slice(0, 500).map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs">{u.bank_ref}</TableCell>
                    <TableCell className="max-w-xs truncate">{u.customer_name || u.customer_id || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(u.amount)}</TableCell>
                    <TableCell className="font-mono text-xs">{u.qb_id || '—'}</TableCell>
                    <TableCell><Badge variant={statusVariant(u.status)}>{u.status}</Badge></TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>

        <Card className="border-amber-500/40">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="text-amber-700 dark:text-amber-300">Unmatched — needs officer review ({unmatched.length})</CardTitle>
                <CardDescription>
                  Bank transactions where the algorithm could not resolve a QB customer (plate auto-suggest, garbled name, customer not in QB, etc.). Nothing was written to QB. Export below, identify the right customer manually, then apply the credit yourself.
                </CardDescription>
              </div>
              {unmatched.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => downloadCsv(`unmatched-${batch?.id.slice(0,8)}-${batch?.channel}.csv`, unmatched)}
                >
                  <Download className="size-4" />
                  Export CSV
                </Button>
              )}
            </div>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bank ref</TableHead>
                  <TableHead>Name on transaction</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {unmatched.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={3} className="text-center text-muted-foreground">
                      Nothing here — every bank ref matched a QB customer.
                    </TableCell>
                  </TableRow>
                )}
                {unmatched.slice(0, 500).map((u) => (
                  <TableRow key={u.id}>
                    <TableCell className="font-mono text-xs">{u.bank_ref}</TableCell>
                    <TableCell className="max-w-xs truncate">{u.customer_name || '—'}</TableCell>
                    <TableCell className="text-right tabular-nums">{fmt(u.amount)}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {unmatched.length > 500 && (
              <div className="text-sm text-muted-foreground mt-2">Showing first 500 of {unmatched.length}. Use Export CSV for the full list.</div>
            )}
          </CardContent>
        </Card>
      </Container>
    </Fragment>
  );
}
