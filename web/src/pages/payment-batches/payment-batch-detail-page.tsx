import { Fragment, useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Undo2, RefreshCw, AlertCircle } from 'lucide-react';
import { getBatch, recallBatch, type PaymentBatchRow, type PaymentUploadRow } from '@/lib/brain-api';

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
    default: return 'outline';
  }
}

export function PaymentBatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [batch, setBatch] = useState<PaymentBatchRow | null>(null);
  const [uploads, setUploads] = useState<PaymentUploadRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [recalling, setRecalling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const r = await getBatch(id);
      setBatch(r.batch);
      setUploads(r.uploads);
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

  const paid = uploads.filter((u) => u.kind === 'payment');
  const credits = uploads.filter((u) => u.kind === 'credit_memo');

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

        <Card>
          <CardHeader>
            <CardTitle>Unused / credit memos ({credits.length})</CardTitle>
            <CardDescription>Bank transactions that didn't match a customer's overdue invoice. Tracked in consumed_transactions but only written to QB if a customer_id was resolvable.</CardDescription>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Bank ref</TableHead>
                  <TableHead>Customer</TableHead>
                  <TableHead className="text-right">Amount</TableHead>
                  <TableHead>QB id</TableHead>
                  <TableHead>Status</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {credits.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={5} className="text-center text-muted-foreground">
                      No credit memos in this batch.
                    </TableCell>
                  </TableRow>
                )}
                {credits.slice(0, 500).map((u) => (
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
      </Container>
    </Fragment>
  );
}
