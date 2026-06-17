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
  previewNewLoan, executeNewLoan,
  type QbCustomer, type QbItem, type NewLoanPreview, type NewLoanExecuteResult,
} from '@/lib/brain-api';

const fmt = (n: number) => n.toLocaleString();
const todayISO = () => new Date().toISOString().slice(0, 10);

function uuid() {
  // Simple idempotency key generator (no crypto dep needed)
  return 'loan-' + Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 10);
}

interface Step {
  parent: QbCustomer | null;        // Step 1: BRANCH (Level 0, e.g. KIJICHI BRANCH)
  loanOfficer: QbCustomer | null;   // Step 2: LOAN OFFICER (Level 1, e.g. AGRICOLA BODA)
  subOfficer: QbCustomer | null;    // Step 3: SUB LOAN OFFICER (Level 2, e.g. Furaha Rashidy Boda)
}

export function NewLoanPage() {
  // Customer hierarchy state — 3 picker steps before the leaf borrower
  const [step, setStep] = useState<Step>({ parent: null, loanOfficer: null, subOfficer: null });

  // Dropdown data
  const [branches, setBranches] = useState<QbCustomer[]>([]);
  const [loanOfficers, setLoanOfficers] = useState<QbCustomer[]>([]);
  const [subOfficers, setSubOfficers] = useState<QbCustomer[]>([]);
  const [items, setItems] = useState<QbItem[]>([]);

  // Branch search (since top-level can be many)
  const [branchSearch, setBranchSearch] = useState('');

  // Loan form
  const [displayName, setDisplayName] = useState('');
  const [mobile, setMobile] = useState('');
  const [estimateAmount, setEstimateAmount] = useState<string>('');
  const [startDate, setStartDate] = useState(todayISO());
  const [endDate, setEndDate] = useState('');
  const [dailyAmount, setDailyAmount] = useState<string>('12500');
  const [productId, setProductId] = useState<string>('');
  const [memo, setMemo] = useState('');

  // UI state
  const [loading, setLoading] = useState<string | null>(null);
  const [preview, setPreview] = useState<NewLoanPreview | null>(null);
  const [result, setResult] = useState<NewLoanExecuteResult | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [idemKey, setIdemKey] = useState(uuid());
  const [nextInvoiceNo, setNextInvoiceNo] = useState<number | null>(null);

  // Initial load: branches (default Level=0) + items + next invoice no
  const loadBranches = useCallback(async (search?: string) => {
    setLoading('branches');
    try {
      const r = await getQbCustomerChildren(search ? { search } : {});
      setBranches(r.customers);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(null); }
  }, []);

  useEffect(() => {
    loadBranches();
    getQbItems().then((r) => setItems(r.items)).catch((e) => setError(String((e as Error).message)));
    getQbNextInvoiceNo().then((r) => setNextInvoiceNo(r.next)).catch(() => {});
  }, [loadBranches]);

  // Branch picked → load loan officers
  useEffect(() => {
    if (!step.parent) { setLoanOfficers([]); return; }
    setLoading('loan-officers');
    getQbCustomerChildren({ parent_id: step.parent.id })
      .then((r) => setLoanOfficers(r.customers))
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setLoading(null));
  }, [step.parent]);

  // Loan officer picked → load sub loan officers
  useEffect(() => {
    if (!step.loanOfficer) { setSubOfficers([]); return; }
    setLoading('sub-officers');
    getQbCustomerChildren({ parent_id: step.loanOfficer.id })
      .then((r) => setSubOfficers(r.customers))
      .catch((e) => setError(String((e as Error).message)))
      .finally(() => setLoading(null));
  }, [step.loanOfficer]);

  // Estimate-driven invoice math (Frank's spec 2026-06-17):
  //   dailyCount = floor(estimate / daily)
  //   remainder  = estimate mod daily   (e.g. 3,500 when not divisible)
  //   total invoices = dailyCount + (remainder > 0 ? 1 : 0)
  //   Σ invoice amounts == estimate EXACTLY.
  const dailyCount = useMemo(() => {
    const est = Number(estimateAmount) || 0;
    const dai = Number(dailyAmount) || 0;
    if (est <= 0 || dai <= 0) return 0;
    return Math.floor(est / dai);
  }, [estimateAmount, dailyAmount]);

  const remainderAmount = useMemo(() => {
    const est = Number(estimateAmount) || 0;
    const dai = Number(dailyAmount) || 0;
    if (est <= 0 || dai <= 0) return 0;
    return est - dailyCount * dai;
  }, [estimateAmount, dailyAmount, dailyCount]);

  const totalInvoiceCount = useMemo(
    () => dailyCount + (remainderAmount > 0 ? 1 : 0),
    [dailyCount, remainderAmount],
  );

  // Derived end_date = start + (totalInvoiceCount - 1) days
  const computedEndDate = useMemo(() => {
    if (!startDate || totalInvoiceCount <= 0) return '';
    const d = new Date(startDate + 'T00:00:00Z');
    d.setUTCDate(d.getUTCDate() + totalInvoiceCount - 1);
    return d.toISOString().slice(0, 10);
  }, [startDate, totalInvoiceCount]);

  useEffect(() => {
    if (computedEndDate && computedEndDate !== endDate) setEndDate(computedEndDate);
  }, [computedEndDate]); // eslint-disable-line react-hooks/exhaustive-deps

  // For backward compat with older code paths that referenced `days`
  const days = totalInvoiceCount;
  const totalInvoices = useMemo(
    () => dailyCount * (Number(dailyAmount) || 0) + remainderAmount,
    [dailyCount, dailyAmount, remainderAmount],
  );

  const canPreview = !!(
    step.subOfficer && displayName.trim() &&
    Number(estimateAmount) > 0 && startDate && endDate &&
    Number(dailyAmount) > 0 && productId
  );

  const doPreview = async () => {
    if (!step.subOfficer) return;
    setLoading('preview'); setError(null); setPreview(null); setResult(null);
    try {
      const p = await previewNewLoan({
        parent_id: step.subOfficer.id,
        display_name: displayName.trim(),
        mobile: mobile.trim() || undefined,
        estimate_amount: Number(estimateAmount),
        start_date: startDate,
        end_date: endDate,
        daily_amount: Number(dailyAmount),
        product_service_id: productId,
      });
      setPreview(p);
    } catch (e) { setError(String((e as Error).message)); }
    finally { setLoading(null); }
  };

  const doExecute = async () => {
    if (!step.subOfficer) return;
    setLoading('execute'); setError(null);
    try {
      const r = await executeNewLoan({
        parent_id: step.subOfficer.id,
        display_name: displayName.trim(),
        mobile: mobile.trim() || undefined,
        estimate_amount: Number(estimateAmount),
        start_date: startDate,
        end_date: endDate,
        daily_amount: Number(dailyAmount),
        product_service_id: productId,
        memo: memo.trim() || undefined,
        idempotency_key: idemKey,
      });
      setResult(r);
      setConfirming(false);
    } catch (e) { setError(String((e as Error).message)); setConfirming(false); }
    finally { setLoading(null); }
  };

  const resetAll = () => {
    setStep({ parent: null, loanOfficer: null, subOfficer: null });
    setDisplayName(''); setMobile(''); setEstimateAmount('');
    setStartDate(todayISO()); setEndDate(''); setDailyAmount('12500');
    setProductId(''); setMemo('');
    setPreview(null); setResult(null); setError(null);
    setIdemKey(uuid());
    getQbNextInvoiceNo().then((r) => setNextInvoiceNo(r.next)).catch(() => {});
  };

  return (
    <>
      <Toolbar>
        <ToolbarHeading title="New loan" description="Create QB customer + estimate + daily invoices in one shot" />
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
          {/* ─── LEFT: Form ─────────────────────────────────── */}
          <Card>
            <CardHeader>
              <CardTitle>1. Branch + officer hierarchy</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Branch (Level 0) — e.g. KIJICHI BRANCH</Label>
                <div className="flex gap-2 mt-1">
                  <Input
                    placeholder="search e.g. KIJICHI"
                    value={branchSearch}
                    onChange={(e) => setBranchSearch(e.target.value)}
                    onKeyDown={(e) => e.key === 'Enter' && loadBranches(branchSearch)}
                  />
                  <Button variant="outline" onClick={() => loadBranches(branchSearch)}>
                    <Search className="size-4" />
                  </Button>
                </div>
                <Select
                  value={step.parent?.id || ''}
                  onValueChange={(v) => {
                    const c = branches.find((b) => b.id === v) || null;
                    setStep({ parent: c, loanOfficer: null, subOfficer: null });
                  }}
                >
                  <SelectTrigger className="mt-2"><SelectValue placeholder={`${branches.length} branches loaded`} /></SelectTrigger>
                  <SelectContent>
                    {branches.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name} (L{b.level})</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Loan officer (Level 1) — e.g. AGRICOLA BODA</Label>
                <Select
                  value={step.loanOfficer?.id || ''}
                  onValueChange={(v) => {
                    const c = loanOfficers.find((b) => b.id === v) || null;
                    setStep((s) => ({ ...s, loanOfficer: c, subOfficer: null }));
                  }}
                  disabled={!step.parent}
                >
                  <SelectTrigger><SelectValue placeholder={step.parent ? `${loanOfficers.length} loan officers` : 'pick branch first'} /></SelectTrigger>
                  <SelectContent>
                    {loanOfficers.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div>
                <Label>Sub loan officer (Level 2) — e.g. Furaha Rashidy Boda</Label>
                <Select
                  value={step.subOfficer?.id || ''}
                  onValueChange={(v) => {
                    const c = subOfficers.find((b) => b.id === v) || null;
                    setStep((s) => ({ ...s, subOfficer: c }));
                  }}
                  disabled={!step.loanOfficer}
                >
                  <SelectTrigger><SelectValue placeholder={step.loanOfficer ? `${subOfficers.length} sub loan officers` : 'pick loan officer first'} /></SelectTrigger>
                  <SelectContent>
                    {subOfficers.map((b) => (
                      <SelectItem key={b.id} value={b.id}>{b.name}</SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              {step.subOfficer && (
                <div className="text-sm text-muted-foreground">
                  New borrower will be created under: <b>{step.subOfficer.full_name}</b>
                </div>
              )}
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>2. Borrower (Level 3) + loan</CardTitle>
            </CardHeader>
            <CardContent className="space-y-4">
              <div>
                <Label>Borrower DisplayName (free text — phone embedded is fine)</Label>
                <Input
                  placeholder="e.g. 0713227668Cliford Denis MAsui"
                  value={displayName}
                  onChange={(e) => setDisplayName(e.target.value)}
                />
              </div>
              <div>
                <Label>Mobile (optional QB Mobile field)</Label>
                <Input
                  placeholder="e.g. 255713227668"
                  value={mobile}
                  onChange={(e) => setMobile(e.target.value)}
                />
              </div>
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
                  <Label>Estimate amount (TZS)</Label>
                  <Input type="number" value={estimateAmount} onChange={(e) => setEstimateAmount(e.target.value)} placeholder="4962500" />
                </div>
                <div>
                  <Label>Daily invoice (TZS)</Label>
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
                  <Input type="date" value={endDate} readOnly disabled />
                </div>
              </div>
              {totalInvoiceCount > 0 && (
                <div className="text-sm text-muted-foreground">
                  {remainderAmount > 0 ? (
                    <>
                      <b>{fmt(totalInvoiceCount)}</b> invoices = {fmt(dailyCount)} × {fmt(Number(dailyAmount))} + 1 × <b>{fmt(remainderAmount)}</b> remainder
                      = <b>{fmt(totalInvoices)} TZS</b>
                    </>
                  ) : (
                    <>
                      <b>{fmt(totalInvoiceCount)}</b> invoices × {fmt(Number(dailyAmount))} TZS
                      = <b>{fmt(totalInvoices)} TZS</b>
                    </>
                  )}
                </div>
              )}
              <div>
                <Label>Memo (optional)</Label>
                <Input placeholder="loan note" value={memo} onChange={(e) => setMemo(e.target.value)} />
              </div>

              <div className="flex gap-2">
                <Button onClick={doPreview} disabled={!canPreview || loading === 'preview'}>
                  {loading === 'preview' ? 'Computing…' : 'Preview'}
                  <ChevronRight className="size-4" />
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        {/* ─── BOTTOM: Preview + Confirm + Result ──────────── */}
        {preview && !result && (
          <Card className="mt-4">
            <CardHeader><CardTitle>3. Preview — verify before pushing</CardTitle></CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-3 gap-4 text-sm">
                <div>
                  <div className="font-semibold">Customer</div>
                  <div>{preview.customer.display_name}</div>
                  <div className="text-muted-foreground text-xs">
                    {preview.customer.will_be_reused
                      ? `Reuse existing QB id ${preview.customer.existing_qb_id}`
                      : 'New customer will be created'}
                  </div>
                </div>
                <div>
                  <div className="font-semibold">Estimate</div>
                  <div>{fmt(preview.estimate.amount)} TZS</div>
                  <div className="text-muted-foreground text-xs">
                    {preview.estimate.start_date} → {preview.estimate.end_date}
                  </div>
                </div>
                <div>
                  <div className="font-semibold">Invoices</div>
                  <div>
                    {preview.invoices.count} × {fmt(preview.invoices.per_invoice_amount)} = {fmt(preview.invoices.total_amount)} TZS
                  </div>
                  <div className="text-muted-foreground text-xs">
                    Doc# {preview.invoices.first_doc_number} → {preview.invoices.last_doc_number}
                  </div>
                </div>
              </div>
              {preview.warning && (
                <div className="text-amber-600 text-sm flex items-center gap-2">
                  <AlertTriangle className="size-4" /> {preview.warning}
                </div>
              )}
              <div className="text-xs text-muted-foreground">
                Sample invoices: {preview.invoices.sample.map((s) => `#${s.doc_number}@${s.txn_date}`).join(', ')}…
              </div>
              <div className="flex gap-2 pt-2">
                {!confirming ? (
                  <Button onClick={() => setConfirming(true)} variant="default">
                    Push to QB
                  </Button>
                ) : (
                  <>
                    <Button onClick={doExecute} disabled={loading === 'execute'} variant="destructive">
                      {loading === 'execute' ? 'Pushing…' : `Confirm — create 1 + 1 + ${preview.invoices.count}`}
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
              <div className="grid grid-cols-3 gap-4">
                <div>
                  <div className="font-semibold">Customer</div>
                  <div>{result.customer.display_name}</div>
                  <div className="text-muted-foreground text-xs">QB id {result.customer.id}{result.customer.was_reused ? ' (reused)' : ' (created)'}</div>
                </div>
                <div>
                  <div className="font-semibold">Estimate</div>
                  <div>{fmt(result.estimate.amount)} TZS</div>
                  <div className="text-muted-foreground text-xs">QB id {result.estimate.id}</div>
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
              <Button onClick={resetAll} variant="outline">+ New loan</Button>
            </CardContent>
          </Card>
        )}
      </Container>
    </>
  );
}
