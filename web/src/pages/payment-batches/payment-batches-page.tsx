import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { RefreshCw, ChevronRight } from 'lucide-react';
import { listBatches, type PaymentBatchRow } from '@/lib/brain-api';

const REFRESH_MS = 15_000;

function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (s) {
    case 'finalized': return 'default';
    case 'pending': return 'secondary';
    case 'recalled': return 'outline';
    case 'rolled_back': return 'destructive';
    default: return 'outline';
  }
}

function fmt(n: number | string | null | undefined): string {
  if (n == null) return '-';
  const v = Number(n) || 0;
  return v.toLocaleString();
}

export function PaymentBatchesPage() {
  const [batches, setBatches] = useState<PaymentBatchRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await listBatches({ limit: 100 });
      setBatches(r.batches);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
    const t = setInterval(refresh, REFRESH_MS);
    return () => clearInterval(t);
  }, [refresh]);

  return (
    <Fragment>
      <Toolbar>
        <ToolbarHeading title="Payment batches" description="QB uploads created from the invoice-payment-app — paid + unused side-by-side, recallable as one unit." />
        <ToolbarActions>
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </ToolbarActions>
      </Toolbar>
      <Container>
        <div className="space-y-5">
        {error && (
          <Card className="border-destructive">
            <CardContent className="pt-6 text-destructive">{error}</CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Recent batches</CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Channel</TableHead>
                  <TableHead>Fired by</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead className="text-right">Paid (TZS)</TableHead>
                  <TableHead className="text-right">Unused (TZS)</TableHead>
                  <TableHead className="text-right">Sheet sum</TableHead>
                  <TableHead className="text-right">Paid rows</TableHead>
                  <TableHead className="text-right">Unused rows</TableHead>
                  <TableHead></TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {batches.length === 0 && !loading && (
                  <TableRow>
                    <TableCell colSpan={10} className="text-center text-muted-foreground">
                      No batches yet.
                    </TableCell>
                  </TableRow>
                )}
                {batches.map((b) => {
                  const tick = (b.created_by || '').replace(/^auto-upload:?/, '') || '—';
                  return (
                    <TableRow key={b.id}>
                      <TableCell className="whitespace-nowrap text-sm">
                        <div>{new Date(b.created_at).toLocaleString()}</div>
                        <div className="text-xs text-muted-foreground">{b.id.slice(0, 8)}</div>
                      </TableCell>
                      <TableCell>{b.channel}</TableCell>
                      <TableCell>
                        <Badge variant="primary" className="uppercase text-[10px]">{tick}</Badge>
                      </TableCell>
                      <TableCell>
                        <Badge variant={statusVariant(b.status)}>{b.status}</Badge>
                        {b.failure_reason && (
                          <div className="text-xs text-destructive mt-1 max-w-xs truncate" title={b.failure_reason}>
                            {b.failure_reason}
                          </div>
                        )}
                      </TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(b.paid_total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(b.unused_total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{fmt(b.sheet_total)}</TableCell>
                      <TableCell className="text-right tabular-nums">{b.paid_count}</TableCell>
                      <TableCell className="text-right tabular-nums">{b.unused_count}</TableCell>
                      <TableCell>
                        <Button variant="ghost" size="sm" asChild>
                          <Link to={`/payment-batches/${b.id}`}>
                            <ChevronRight className="size-4" />
                          </Link>
                        </Button>
                      </TableCell>
                    </TableRow>
                  );
                })}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
        </div>
      </Container>
    </Fragment>
  );
}
