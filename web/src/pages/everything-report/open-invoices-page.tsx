import { useMemo } from 'react';
import { Container } from '@/components/common/container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EverythingReportSubNav } from './sub-nav';
import {
  PageShell, SectionCard, SectionFilterBar,
  fmt, fmtPct, useDefaultFilter, useReportComparison,
} from './shared';
import { TrendKpiTile } from './trend-kpi-tile';

export function OpenInvoicesPage() {
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
        title="C · Open Invoices per Officer"
        description={`Invoice amount, balance, moto adjustments, open + % collected · ${windows.current.from} → ${windows.current.to}`}
      >
        <EverythingReportSubNav />
        <SectionFilterBar state={state} onChange={setState} onRefresh={reload} loading={loading} officerOptions={officerOptions} />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <TrendKpiTile
            label="Total invoice amount"
            current={c?.grand.total_invoice_amount ?? null}
            previous={cp?.grand.total_invoice_amount ?? null}
            extractor={(d) => d.officers?.total_invoice_amount ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Balance remain"
            current={c?.grand.today_balance_remain ?? null}
            previous={cp?.grand.today_balance_remain ?? null}
            invertDirection
            extractor={(d) => d.officers?.today_balance_remain ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Open (after motos)"
            current={c?.grand.open ?? null}
            previous={cp?.grand.open ?? null}
            extractor={(d) => d.officers?.open ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Collected"
            current={c?.grand.collected ?? null}
            previous={cp?.grand.collected ?? null}
            extractor={(d) => d.officers?.collected ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
        </div>

        <SectionCard
          title="Officer breakdown"
          toolbar={lastFetch ? <span className="text-xs text-muted-foreground">Fetched {lastFetch.toLocaleTimeString()}</span> : null}
        >
          <div className="overflow-x-auto">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>Officer</TableHead>
                  <TableHead className="text-right">Invoice amount</TableHead>
                  <TableHead className="text-right">Balance remain</TableHead>
                  <TableHead className="text-right">Moto office</TableHead>
                  <TableHead className="text-right">Moto police</TableHead>
                  <TableHead className="text-right">Adjustment (×12k)</TableHead>
                  <TableHead className="text-right">Open</TableHead>
                  <TableHead className="text-right">Collected</TableHead>
                  <TableHead className="text-right">% collected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c?.officers.map((o) => (
                  <TableRow key={o.officer_id}>
                    <TableCell className="whitespace-nowrap font-medium">{o.officer_name}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.total_invoice_amount)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.today_balance_remain)}</TableCell>
                    <TableCell className="text-right">{fmt(o.motos_office)}</TableCell>
                    <TableCell className="text-right">{fmt(o.motos_police)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.adjustment)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.open)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.collected)}</TableCell>
                    <TableCell className="text-right">{fmtPct(o.pct_collected)}</TableCell>
                  </TableRow>
                ))}
                {c && (
                  <TableRow className="bg-muted/30 font-semibold">
                    <TableCell>TOTAL</TableCell>
                    <TableCell className="text-right font-mono">{fmt(c.grand.total_invoice_amount)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(c.grand.today_balance_remain)}</TableCell>
                    <TableCell className="text-right">{fmt(c.grand.motos_office)}</TableCell>
                    <TableCell className="text-right">{fmt(c.grand.motos_police)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(c.grand.adjustment)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(c.grand.open)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(c.grand.collected)}</TableCell>
                    <TableCell className="text-right">{fmtPct(c.grand.pct_collected)}</TableCell>
                  </TableRow>
                )}
              </TableBody>
            </Table>
          </div>
        </SectionCard>
      </PageShell>
    </Container>
  );
}
