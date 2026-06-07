import { Fragment, useCallback, useEffect, useState } from 'react';
import { useParams, Link } from 'react-router-dom';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Undo2, RefreshCw, AlertCircle, Download, Database, FileSpreadsheet, FileText, History, ShieldAlert } from 'lucide-react';
import {
  getBatch,
  getBatchInvoicesSnapshot,
  recallBatch,
  type PaymentBatchRow,
  type PaymentUploadRow,
  type ArrearsSnapshotSummary,
  type InvoiceSnapshotSummary,
  type BatchLogEntry,
  type SkippedDuplicateRow,
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

// SaasAnt-shaped Payment CSV.
// Header + per-row format matches paidpaid.csv / unused.csv exactly. Used so
// re-uploading via SaasAnt works without column re-mapping.
function saasantCsv(filename: string, rows: PaymentUploadRow[], paymentDate: string, kind: 'paid' | 'unused') {
  const header = [
    'Payment Date', 'Customer', 'Payment Method', 'Deposit To Account Name',
    'Invoice No', 'Journal No', 'Amount', 'Reference No', 'Memo',
    'Country Code', 'Exchange Rate',
  ];
  const escape = (v: string | number | null | undefined) => {
    if (v == null) return '';
    const s = String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      paymentDate,
      r.customer_name || r.customer_id || '',
      'Cash',
      'Kijichi Collection AC',
      kind === 'paid' ? (r.invoice_no || '') : '',
      '',
      Number(r.amount) || 0,
      '',
      r.memo || r.bank_ref || '',
      '',
      '',
    ].map(escape).join(','));
  }
  const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Open-Invoices snapshot XLS (matches QB Account-QuickReport export shape).
// Header row, column row, then data rows. Uses xlsx lib (dynamic import so
// the bundle stays small for users who never download).
async function downloadInvoicesXls(
  filename: string,
  data: Array<{ qbId: string; date: string; no: string; customer: string; memo?: string; balance: number; amount: number; status: string }>,
  dateRangeHeader: string,
) {
  const XLSX = await import('xlsx');
  const aoa: (string | number)[][] = [
    [dateRangeHeader, '', '', '', '', '', '', ''],
    ['Date', 'Type', 'No.', 'Customer', 'Memo', 'Balance', 'Amount', 'Status'],
    ...data.map((r) => [r.date || '', 'Invoice', r.no || '', r.customer || '', r.memo || '', r.balance, r.amount, r.status || '']),
  ];
  const ws = XLSX.utils.aoa_to_sheet(aoa);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, ws, 'Open Invoices');
  XLSX.writeFile(wb, filename);
}

export function PaymentBatchDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [batch, setBatch] = useState<PaymentBatchRow | null>(null);
  const [uploads, setUploads] = useState<PaymentUploadRow[]>([]);
  const [snapshot, setSnapshot] = useState<ArrearsSnapshotSummary | null>(null);
  const [invoiceSnapshot, setInvoiceSnapshot] = useState<InvoiceSnapshotSummary | null>(null);
  const [skippedDups, setSkippedDups] = useState<SkippedDuplicateRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [recalling, setRecalling] = useState(false);
  const [downloadingXls, setDownloadingXls] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const r = await getBatch(id);
      setBatch(r.batch);
      setUploads(r.uploads);
      setSnapshot(r.snapshot);
      setInvoiceSnapshot(r.invoice_snapshot);
      setSkippedDups(r.skipped_duplicates || []);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  const fireInvoicesXlsDownload = useCallback(async () => {
    if (!id || !batch || !invoiceSnapshot) return;
    setDownloadingXls(true);
    try {
      const r = await getBatchInvoicesSnapshot(id);
      const fname = `open-invoices-${invoiceSnapshot.as_of}-${batch.channel}.xls`;
      const header = invoiceSnapshot.date_range_header
        || `Type: Invoices Status: Open Delivery Method: Any Date: 2026-01-01 - ${invoiceSnapshot.as_of}`;
      await downloadInvoicesXls(fname, r.snapshot.data || [], header);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setDownloadingXls(false);
    }
  }, [id, batch, invoiceSnapshot]);

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
  const logs: BatchLogEntry[] = (batch?.logs as BatchLogEntry[] | undefined) || [];

  // SaasAnt CSV requires a Payment Date column in MM-DD-YYYY format. We
  // derive it from the batch's finalize timestamp (closest stand-in for
  // "when this batch was actually pushed"). Once payment_batches.txn_date
  // is exposed in the API we'll switch to that.
  const paymentDateForCsv = (() => {
    const d = new Date(batch?.finalized_at || batch?.created_at || Date.now());
    const mm = String(d.getMonth() + 1).padStart(2, '0');
    const dd = String(d.getDate()).padStart(2, '0');
    return `${mm}-${dd}-${d.getFullYear()}`;
  })();

  // Derive a short tick-name chip from created_by ("auto-upload:meru0300" → "meru0300")
  const tickChip = (batch?.created_by || '').replace(/^auto-upload:?/, '') || '—';

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
                <div><div className="text-muted-foreground">Fired by</div><div className="font-medium flex items-center gap-2">
                  <Badge variant="primary" className="uppercase text-[10px]">{tickChip}</Badge>
                  <span className="text-xs text-muted-foreground">{batch.created_by || '—'}</span>
                </div></div>
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
              <div className="flex items-center justify-between gap-2">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <Database className="size-4" />
                    Arrears snapshot used by this batch
                  </CardTitle>
                  <CardDescription>
                    The frozen list of overdue invoices the payment algorithm matched against. Same snapshot is reused on rerun.
                  </CardDescription>
                </div>
                <Button variant="outline" asChild>
                  <a href={`/api/arrears-snapshots/${snapshot.id}/export.csv`} download>
                    <Download className="size-4" />
                    Export CSV
                  </a>
                </Button>
              </div>
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

        {invoiceSnapshot && (
          <Card className="mb-4 border-blue-500/30">
            <CardHeader>
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div>
                  <CardTitle className="flex items-center gap-2">
                    <FileSpreadsheet className="size-4 text-blue-600" />
                    QB Open-Invoices snapshot (used at allocation time)
                  </CardTitle>
                  <CardDescription>
                    {invoiceSnapshot.date_range_header || `As of ${invoiceSnapshot.as_of}`} — captured{' '}
                    {new Date(invoiceSnapshot.captured_at).toLocaleString()}
                  </CardDescription>
                </div>
                <Button
                  variant="primary"
                  onClick={fireInvoicesXlsDownload}
                  disabled={downloadingXls || invoiceSnapshot.invoice_count === 0}
                >
                  <FileSpreadsheet className="size-4" />
                  {downloadingXls ? 'Building XLS…' : 'Download invoices.xls'}
                </Button>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-4 text-sm">
                <div>
                  <div className="text-muted-foreground">Invoices in snapshot</div>
                  <div className="font-semibold text-lg tabular-nums">{fmt(invoiceSnapshot.invoice_count)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Total open balance</div>
                  <div className="font-semibold text-lg tabular-nums">{fmt(invoiceSnapshot.total_balance)} TZS</div>
                </div>
                <div>
                  <div className="text-muted-foreground">As of</div>
                  <div className="font-medium">{invoiceSnapshot.as_of}</div>
                </div>
                <div>
                  <div className="text-muted-foreground">Snapshot id</div>
                  <div className="font-mono text-xs">{invoiceSnapshot.id.slice(0, 8)}</div>
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        <Card className="mb-4">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>Paid invoices ({paid.length})</CardTitle>
                <CardDescription>Each row is one QB Payment that was applied to an overdue invoice. Voided rows are recalled Payments.</CardDescription>
              </div>
              {paid.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => saasantCsv(`paidpaid-${batch?.id.slice(0,8)}-${batch?.channel}.csv`, paid, paymentDateForCsv, 'paid')}
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
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle>Credit memos created ({creditsMatched.length})</CardTitle>
                <CardDescription>
                  Unused bank transactions whose customer was resolvable. Each row is a QB CreditMemo posted to that customer's account — credit applies to future invoices.
                </CardDescription>
              </div>
              {creditsMatched.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => saasantCsv(`unused-${batch?.id.slice(0,8)}-${batch?.channel}.csv`, creditsMatched, paymentDateForCsv, 'unused')}
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
                  onClick={() => saasantCsv(`unmatched-${batch?.id.slice(0,8)}-${batch?.channel}.csv`, unmatched, paymentDateForCsv, 'unused')}
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

        <Card className="mb-4 border-slate-400/40">
          <CardHeader>
            <div className="flex items-center justify-between gap-2">
              <div>
                <CardTitle className="flex items-center gap-2">
                  <ShieldAlert className="size-4 text-slate-500" />
                  Skipped QB duplicates ({skippedDups.length})
                </CardTitle>
                <CardDescription>
                  Refs that BRAIN's pre-flight found ALREADY in QB (from SaasAnt, the manual transaction processor, or a prior BRAIN run). These were grey-painted on the sheet and excluded from this batch — no QB Payment was created for them here.
                </CardDescription>
              </div>
              {skippedDups.length > 0 && (
                <Button
                  variant="outline"
                  onClick={() => {
                    const header = ['bank_ref', 'qb_id', 'qb_kind', 'qb_txn_date', 'customer_id', 'found_at', 'found_by'];
                    const esc = (v: string | null | undefined) => {
                      if (v == null) return '';
                      const s = String(v);
                      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
                    };
                    const lines = [header.join(',')];
                    for (const r of skippedDups) {
                      lines.push([r.bank_ref, r.qb_id, r.qb_kind, r.qb_txn_date, r.customer_id, r.found_at, r.found_by].map(esc).join(','));
                    }
                    const blob = new Blob([lines.join('\n')], { type: 'text/csv;charset=utf-8;' });
                    const url = URL.createObjectURL(blob);
                    const a = document.createElement('a');
                    a.href = url;
                    a.download = `skipped-duplicates-${batch?.id.slice(0, 8)}-${batch?.channel}.csv`;
                    a.click();
                    URL.revokeObjectURL(url);
                  }}
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
                  <TableHead>QB id</TableHead>
                  <TableHead>QB kind</TableHead>
                  <TableHead>QB TxnDate</TableHead>
                  <TableHead>Detected at</TableHead>
                  <TableHead>Source</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {skippedDups.length === 0 && (
                  <TableRow>
                    <TableCell colSpan={6} className="text-center text-muted-foreground">
                      None — every ref in this window was fresh.
                    </TableCell>
                  </TableRow>
                )}
                {skippedDups.slice(0, 300).map((s) => (
                  <TableRow key={`${s.bank_ref}-${s.customer_id}`}>
                    <TableCell className="font-mono text-xs">{s.bank_ref}</TableCell>
                    <TableCell className="font-mono text-xs">{s.qb_id}</TableCell>
                    <TableCell>
                      <Badge variant="outline">{s.qb_kind}</Badge>
                    </TableCell>
                    <TableCell>{s.qb_txn_date || '—'}</TableCell>
                    <TableCell className="whitespace-nowrap text-xs text-muted-foreground">{new Date(s.found_at).toLocaleString()}</TableCell>
                    <TableCell className="text-xs text-muted-foreground">{s.found_by}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {skippedDups.length > 300 && (
              <div className="text-sm text-muted-foreground mt-2">Showing 300 of {skippedDups.length}.</div>
            )}
          </CardContent>
        </Card>

        <Card className="mb-4">
          <CardHeader>
            <CardTitle className="flex items-center gap-2">
              <History className="size-4 text-muted-foreground" />
              Batch logs ({logs.length})
            </CardTitle>
            <CardDescription>
              Structured trail of everything BRAIN did during this batch — start, dup-check result, each chunk's outcome, every sweep retry, finalize. Use this to debug if something looks off.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {logs.length === 0 ? (
              <div className="text-sm text-muted-foreground py-6 text-center">No logs recorded for this batch.</div>
            ) : (
              <div className="space-y-2 max-h-[480px] overflow-y-auto">
                {logs.map((e, i) => (
                  <div key={i} className="flex gap-3 items-start text-sm border-b last:border-b-0 pb-2">
                    <Badge
                      variant={e.level === 'error' ? 'destructive' : e.level === 'warn' ? 'secondary' : 'outline'}
                      className="shrink-0 mt-0.5 uppercase text-[10px]"
                    >
                      {e.level}
                    </Badge>
                    <div className="flex-1 min-w-0">
                      <div className="font-mono text-xs text-muted-foreground">
                        {new Date(e.ts).toLocaleString()} · {e.source}
                      </div>
                      <div className="whitespace-pre-wrap break-words">{e.message}</div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </CardContent>
        </Card>
      </Container>
    </Fragment>
  );
}
