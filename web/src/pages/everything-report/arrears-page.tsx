import { useMemo } from 'react';
import { Container } from '@/components/common/container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EverythingReportSubNav } from './sub-nav';
import {
  PageShell, SectionCard, SectionFilterBar,
  fmt, fmtPct, useDefaultFilter, useReportComparison,
} from './shared';
import { TrendKpiTile } from './trend-kpi-tile';
import { TrendCell } from './trend-cell';

export function ArrearsPage() {
  const [state, setState] = useDefaultFilter();
  const { current, previous, loading, reload, windows, lastFetch } = useReportComparison(state);
  const c = current?.section_c_d_officers;
  const cp = previous?.section_c_d_officers;
  const officerOptions = useMemo(() =>
    (c?.officers || []).map((o) => ({ id: String(o.officer_id), name: o.officer_name || o.officer_id })),
    [c],
  );
  return (
    <Container>
      <PageShell
        title="D · Open & Closing Arrears per Officer"
        description={`Morning arrear baseline vs real-time + % collected · ${windows.current.from} → ${windows.current.to}`}
      >
        <EverythingReportSubNav />
        <SectionFilterBar state={state} onChange={setState} onRefresh={reload} loading={loading} officerOptions={officerOptions} />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <TrendKpiTile
            label="Arrears morning"
            current={c?.grand.arrears_morning ?? null}
            previous={cp?.grand.arrears_morning ?? null}
            invertDirection
            extractor={(d) => d.officers?.arrears_morning ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Arrears now (real-time)"
            current={c?.grand.arrears_realtime ?? null}
            previous={cp?.grand.arrears_realtime ?? null}
            invertDirection
            extractor={(d) => d.officers?.arrears_realtime ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Arrear collected"
            current={c?.grand.arrear_collected ?? null}
            previous={cp?.grand.arrear_collected ?? null}
            extractor={(d) => d.officers?.arrear_collected ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Net cash flow (today)"
            current={c?.grand.net_cash_flow ?? null}
            previous={cp?.grand.net_cash_flow ?? null}
            extractor={(d) => d.officers?.net_cash_flow ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
        </div>

        <SectionCard
          title="Officer arrear breakdown"
          toolbar={lastFetch ? <span className="text-xs text-muted-foreground">Fetched {lastFetch.toLocaleTimeString()}</span> : null}
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Officer</TableHead>
                  <TableHead className="text-right">Arrear morning</TableHead>
                  <TableHead className="text-right">Arrear now</TableHead>
                  <TableHead className="text-right">Arrear paid</TableHead>
                  <TableHead className="text-right">Today inv paid</TableHead>
                  <TableHead className="text-right">Future inv paid</TableHead>
                  <TableHead className="text-right">Unapplied</TableHead>
                  <TableHead className="text-right">Total received</TableHead>
                  <TableHead className="text-right text-rose-600">− Credit memo</TableHead>
                  <TableHead className="text-right text-rose-600">− Disbursement</TableHead>
                  <TableHead className="text-right font-semibold">= Net cash flow</TableHead>
                  <TableHead className="text-right">% arrear paid</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c?.officers.map((o) => {
                  const arr = o.arrear_collected || 0;
                  const today = o.today_invoice_collection || 0;
                  const future = o.future_invoice_collection || 0;
                  const unapp = o.unapplied_received || 0;
                  const cm = o.credit_memo_issued || 0;
                  const disb = o.disbursement_total || 0;
                  const totalReceived = o.total_received ?? (arr + today + future + unapp);
                  const net = o.net_cash_flow ?? (totalReceived - cm - disb);
                  return (
                    <TableRow key={o.officer_id}>
                      <TableCell className="whitespace-nowrap font-medium">{o.officer_name}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(o.arrears_morning)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(o.arrears_realtime)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(arr)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(today)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(future)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(unapp)}</TableCell>
                      <TableCell className="text-right font-mono font-semibold">{fmt(totalReceived)}</TableCell>
                      <TableCell className="text-right font-mono text-rose-600">{cm ? '−' + fmt(cm) : '0'}</TableCell>
                      <TableCell className="text-right font-mono text-rose-600">{disb ? '−' + fmt(disb) : '0'}</TableCell>
                      <TableCell className={`text-right font-mono font-semibold ${net < 0 ? 'text-rose-600' : ''}`}>{fmt(net)}</TableCell>
                      <TableCell className="text-right">{fmtPct(o.arrear_pct_collected)}</TableCell>
                    </TableRow>
                  );
                })}
                {c && (() => {
                  const gArr = c.grand.arrear_collected || 0;
                  const gToday = c.grand.today_invoice_collection || 0;
                  const gFuture = c.grand.future_invoice_collection || 0;
                  const gUnapp = c.grand.unapplied_received || 0;
                  const gCm = c.grand.credit_memo_issued || 0;
                  const gDisb = c.grand.disbursement_total || 0;
                  const gTotalReceived = c.grand.total_received ?? (gArr + gToday + gFuture + gUnapp);
                  const gNet = c.grand.net_cash_flow ?? (gTotalReceived - gCm - gDisb);
                  return (
                    <TableRow className="bg-muted/30 font-semibold">
                      <TableCell>TOTAL</TableCell>
                      <TableCell className="text-right">
                        <TrendCell label="Total arrears morning" value={c.grand.arrears_morning} invertDirection extractor={(d) => d.officers?.arrears_morning ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                      </TableCell>
                      <TableCell className="text-right">
                        <TrendCell label="Total arrears now" value={c.grand.arrears_realtime} invertDirection extractor={(d) => d.officers?.arrears_realtime ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                      </TableCell>
                      <TableCell className="text-right">
                        <TrendCell label="Total arrear paid" value={gArr} extractor={(d) => d.officers?.arrear_collected ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                      </TableCell>
                      <TableCell className="text-right font-mono">{fmt(gToday)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(gFuture)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(gUnapp)}</TableCell>
                      <TableCell className="text-right font-mono">{fmt(gTotalReceived)}</TableCell>
                      <TableCell className="text-right font-mono text-rose-600">{gCm ? '−' + fmt(gCm) : '0'}</TableCell>
                      <TableCell className="text-right font-mono text-rose-600">{gDisb ? '−' + fmt(gDisb) : '0'}</TableCell>
                      <TableCell className={`text-right font-mono ${gNet < 0 ? 'text-rose-600' : ''}`}>{fmt(gNet)}</TableCell>
                      <TableCell className="text-right">{fmtPct(c.grand.arrear_pct_collected)}</TableCell>
                    </TableRow>
                  );
                })()}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      </PageShell>
    </Container>
  );
}
