import { useCallback, useEffect, useMemo, useState } from 'react';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Badge } from '@/components/ui/badge';
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from '@/components/ui/select';
import { Search, RefreshCw, ChevronRight, AlertTriangle, CheckCircle2 } from 'lucide-react';
import {
  getQbCustomerChildren, getQbItems, getQbNextInvoiceNo,
  getQbCustomerLastInvoice, previewAddInvoices, executeAddInvoices,
  type QbCustomer, type QbItem,
  type AddInvoicesPreview, type AddInvoicesResult,
} from '@/lib/brain-api';

const fmt = (n: number) => n.toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);
function uuid() {
  return 'add-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

export function AddInvoicesPage() {
  // Customer search
  const [searchTerm, setSearchTerm] = useState('');
  const [searchResults, setSearchResults] = useState<QbCustomer[]>([]);
  const [selectedCustomer, setSelectedCustomer] = useState<QbCustomer | null>(null);
  const [lastInvoice, setLastInvoice] = useState<{ doc_number: string; txn_date: string } | null>(null);
  const [suggestedStart, setSuggestedStart] = useState<string>('');

  // Item picker
  const [items, setItems] = useState<QbItem[]>([]);
  const [productId, setProductId] = useState<string>('');

  // Inputs (per Frank 2026-06-17: human types days + amount, system fills the rest)
  const [numDays, setNumDays] = useState<string>('');
  const [dailyAmount, setDailyAmount] = useState<string>('12500');
  const [startDate, setStartDate] = useState<string>(todayISO());

  // UI state
  const [loading, setLoading] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [preview, setPreview] = useState<AddInvoicesPreview | null>(null);
  const [result, setResult] = useState<AddInvoicesResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [idemKey, setIdemKey] = useState(uuid());
  const [nextInvoiceNo, setNextInvoiceNo] = useState<number | null>(null);

  useEffect(() => {
    getQbItems().then((r) => setItems(r.items)).catch((e) => setError(String((e as Error).message)));
    getQbNextInvoiceNo().then((r) => setNextInvoiceNo(r.next)).catch(() => {});
  }, []);

  const doSearch = useCallback(async () => {
    if (!searchTerm.trim()) return;
    setLoading('search'); setError(null);
    try {
      const r = await getQbCustomerChildren({ search: searchTerm.trim() });
      setSearchResults(r.customers);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(null); }
  }, [searchTerm]);

  // When a customer is selected → look up their last invoice
  useEffect(() => {
    if (!selectedCustomer) { setLastInvoice(null); setSuggestedStart(''); return; }
    getQbCustomerLastInvoice(selectedCustomer.id)
      .then((r) => {
        setLastInvoice(r.last);
        if (r.suggested_start_date) {
          setSuggestedStart(r.suggested_start_date);
          setStartDate(r.suggested_start_date);
        }
      })
      .catch(() => { setLastInvoice(null); });
  }, [selectedCustomer]);

  // Math (days × daily = total — direct, no remainder needed)
  const totalInvoiceCount = useMemo(() => Math.max(0, Math.floor(Number(numDays) || 0)), [numDays]);
  const totalAmount = useMemo(
    () => totalInvoiceCount * (Number(dailyAmount) || 0),
    [totalInvoiceCount, dailyAmount],
  );
  const computedEndDate = useMemo(() => {
    if (!startDate || totalInvoiceCount <= 0) return '';
    const d = new Date(startDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + totalInvoiceCount - 1);
    return d.toISOString().slice(0, 10);
  }, [startDate, totalInvoiceCount]);

  const canPreview = !!(
    selectedCustomer && productId && totalInvoiceCount > 0 &&
    Number(dailyAmount) > 0 && startDate
  );

  const doPreview = async () => {
    if (!selectedCustomer) return;
    setLoading('preview'); setError(null); setPreview(null); setResult(null);
    try {
      const p = await previewAddInvoices({
        customer_id: selectedCustomer.id,
        start_date: startDate,
        daily_amount: Number(dailyAmount),
        product_service_id: productId,
        end_date: computedEndDate,
      });
      setPreview(p);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(null); }
  };

  const doExecute = async () => {
    if (!selectedCustomer) return;
    setLoading('execute'); setError(null);
    try {
      const r = await executeAddInvoices({
        customer_id: selectedCustomer.id,
        start_date: startDate,
        daily_amount: Number(dailyAmount),
        product_service_id: productId,
        end_date: computedEndDate,
        idempotency_key: idemKey,
      });
      setResult(r);
      setConfirming(false);
    } catch (e) { setError(String((e as Error).message)); setConfirming(false); }
    finally { setLoading(null); }
  };

  const resetAll = () => {
    setSearchTerm(''); setSearchResults([]); setSelectedCustomer(null);
    setLastInvoice(null); setSuggestedStart('');
    setNumDays(''); setDailyAmount('12500'); setStartDate(todayISO()); setProductId('');
    setPreview(null); setResult(null); setError(null);
    setIdemKey(uuid());
    getQbNextInvoiceNo().then((r) => setNextInvoiceNo(r.next)).catch(() => {});
  };

  return (
    <>
      <Toolbar>
        <ToolbarHeading title="Add invoices" description="Push daily invoices to an existing QB customer" />
        <ToolbarActions>
          {nextInvoiceNo !== null && (
            <Badge variant="outline">Next Invoice No: {nextInvoiceNo}</Badge>
          )}
          <Button variant="outline" onClick={resetAll}>
            <RefreshCw className="size-4" /> Reset
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

        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          <Card>
            <CardHeader>
              <CardTitle>1. Find existing customer</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Search by name (any part)</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    placeholder="e.g. CLIFFORD or MASUI"
                    value={searchTerm}
                    onChange={(e) => setSearchTerm(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && doSearch()}
                  />
                  <Button variant="outline" onClick={doSearch} disabled={loading === 'search'}>
                    <Search className="size-4" />
                  </Button>
                </div>
                {searchResults.length > 0 && (
                  <Select
                    value={selectedCustomer?.id || ''}
                    onValueChange={(v) => {
                      const c = searchResults.find((x) => x.id === v) || null;
                      setSelectedCustomer(c);
                    }}
                  >
                    <SelectTrigger className="mt-2">
                      <SelectValue placeholder={`${searchResults.length} matches — pick one`} />
                    </SelectTrigger>
                    <SelectContent>
                      {searchResults.map((c) => (
                        <SelectItem key={c.id} value={c.id}>
                          {c.name} <span className="text-muted-foreground text-xs ml-1">(L{c.level} • {c.full_name})</span>
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                )}
              </div>

              {selectedCustomer && (
                <div className="text-sm space-y-1">
                  <div><b>Picked:</b> {selectedCustomer.full_name}</div>
                  <div className="text-muted-foreground text-xs">QB id: {selectedCustomer.id}</div>
                  {lastInvoice ? (
                    <div className="text-muted-foreground">
                      Last invoice: <b>#{lastInvoice.doc_number}</b> on {lastInvoice.txn_date} → suggested start {suggestedStart}
                    </div>
                  ) : (
                    <div className="text-muted-foreground">No prior invoices for this customer</div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Invoice schedule</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Product/Service</Label>
                <Select value={productId} onValueChange={setProductId}>
                  <SelectTrigger><SelectValue placeholder={`${items.length} items`} /></SelectTrigger>
                  <SelectContent>
                    {items.map((it) => (
                      <SelectItem key={it.id} value={it.id}>{it.name}{it.default_price ? ` (default ${fmt(it.default_price)})` : ''}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Number of days</Label>
                  <Input type="number" value={numDays} onChange={(e) => setNumDays(e.target.value)} placeholder="e.g. 180" />
                </div>
                <div>
                  <Label>Amount per invoice (TZS)</Label>
                  <Input type="number" value={dailyAmount} onChange={(e) => setDailyAmount(e.target.value)} placeholder="12500" />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <Label>Start date</Label>
                  <Input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)} />
                </div>
                <div>
                  <Label>End date (auto)</Label>
                  <Input type="date" value={computedEndDate} readOnly disabled />
                </div>
              </div>

              {totalInvoiceCount > 0 && (
                <div className="text-sm text-muted-foreground">
                  <b>{fmt(totalInvoiceCount)}</b> invoices × {fmt(Number(dailyAmount))} TZS = <b>{fmt(totalAmount)} TZS</b>
                </div>
              )}

              <Button onClick={doPreview} disabled={!canPreview || loading === 'preview'}>
                {loading === 'preview' ? 'Computing…' : 'Preview'}
                <ChevronRight className="size-4" />
              </Button>
            </CardContent>
          </Card>
        </div>

        {preview && !result && (
          <Card className="mt-4">
            <CardHeader><CardTitle>3. Preview — verify before pushing</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="font-semibold">Customer</div>
                  <div>{preview.customer.display_name}</div>
                  <div className="text-muted-foreground text-xs">{preview.customer.full_name}</div>
                </div>
                <div>
                  <div className="font-semibold">Schedule</div>
                  <div>{preview.invoices.first_date} → {preview.invoices.last_date}</div>
                  <div className="text-muted-foreground text-xs">Doc# {preview.invoices.first_doc_number} → {preview.invoices.last_doc_number}</div>
                </div>
                <div>
                  <div className="font-semibold">Invoices</div>
                  <div>
                    {preview.invoices.count} = {preview.invoices.daily_count} × {fmt(preview.invoices.per_invoice_amount)}
                    {preview.invoices.remainder_amount > 0 && <> + 1 × {fmt(preview.invoices.remainder_amount)}</>}
                  </div>
                  <div className="text-muted-foreground text-xs">Total: {fmt(preview.invoices.total_amount)} TZS</div>
                </div>
              </div>
              <div className="text-xs text-muted-foreground">
                Sample: {preview.invoices.sample.map((s) => `#${s.doc_number}@${s.txn_date}=${fmt(s.amount)}`).join(', ')}…
              </div>
              <div className="flex gap-2 pt-2">
                {!confirming ? (
                  <Button onClick={() => setConfirming(true)}>Push to QB</Button>
                ) : (
                  <>
                    <Button onClick={doExecute} disabled={loading === 'execute'} variant="destructive">
                      {loading === 'execute' ? 'Pushing…' : `Confirm — create ${preview.invoices.count} invoices`}
                    </Button>
                    <Button onClick={() => setConfirming(false)} variant="outline">Cancel</Button>
                  </>
                )}
              </div>
            </CardContent>
          </Card>
        )}

        {result && (
          <Card className="mt-4">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                {result.status === 'success'
                  ? <><CheckCircle2 className="size-5 text-green-600" /> Pushed to QB</>
                  : result.status === 'partial'
                    ? <><AlertTriangle className="size-5 text-amber-600" /> Partial push</>
                    : <><AlertTriangle className="size-5 text-destructive" /> Push failed</>}
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3 text-sm">
              <div className="grid grid-cols-2 gap-4">
                <div>
                  <div className="font-semibold">Customer</div>
                  <div>{result.customer.display_name}</div>
                  <div className="text-muted-foreground text-xs">QB id {result.customer.id}</div>
                </div>
                <div>
                  <div className="font-semibold">Invoices</div>
                  <div>{result.invoices.count} / {result.invoices.planned}</div>
                  <div className="text-muted-foreground text-xs">Doc# {result.invoices.first_doc} → {result.invoices.last_doc}</div>
                  <div className="text-muted-foreground text-xs">{fmt(result.invoices.total_amount)} TZS</div>
                </div>
              </div>
              {result.invoices.failures.length > 0 && (
                <div className="text-destructive text-xs">
                  <div className="font-semibold">{result.invoices.failures.length} failures:</div>
                  <ul className="list-disc pl-6">
                    {result.invoices.failures.slice(0, 5).map((f, i) => (
                      <li key={i}>#{f.doc_number} @ {f.txn_date}: {f.error}</li>
                    ))}
                  </ul>
                </div>
              )}
              <Button onClick={resetAll} variant="outline">+ Add to another customer</Button>
            </CardContent>
          </Card>
        )}
      </Container>
    </>
  );
}
