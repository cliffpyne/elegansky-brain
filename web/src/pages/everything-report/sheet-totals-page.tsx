import { Container } from '@/components/common/container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EverythingReportSubNav } from './sub-nav';
import {
  PageShell, SectionCard, SectionFilterBar, ComparisonKpiTile,
  fmt, useDefaultFilter, useReportComparison,
} from './shared';

export function SheetTotalsPage() {
  const [state, setState] = useDefaultFilter();
  const { current, previous, loading, reload, windows, lastFetch } = useReportComparison(state);
  const b = current?.section_b_sheet_totals;
  const bp = previous?.section_b_sheet_totals;

  return (
    <Container>
      <PageShell
        title="B · Google Sheets Totals"
        description={`PASSED + FAILED + UNUSED per channel · ${windows.current.from} → ${windows.current.to} vs prev period`}
      >
        <EverythingReportSubNav />
        <SectionFilterBar state={state} onChange={setState} onRefresh={reload} loading={loading} />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <ComparisonKpiTile label="PASSED total" current={b?.grand_passed_total ?? null} previous={bp?.grand_passed_total ?? null} />
          <ComparisonKpiTile label="FAILED total" current={b?.grand_failed_total ?? null} previous={bp?.grand_failed_total ?? null} invertDirection />
          <ComparisonKpiTile label="UNUSED total" current={b?.grand_unused_total ?? null} previous={bp?.grand_unused_total ?? null} invertDirection />
        </div>

        <SectionCard
          title="Per channel — current window"
          toolbar={lastFetch ? <span className="text-xs text-muted-foreground">Fetched {lastFetch.toLocaleTimeString()}</span> : null}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">PASSED rows</TableHead>
                <TableHead className="text-right">PASSED total</TableHead>
                <TableHead className="text-right">FAILED rows</TableHead>
                <TableHead className="text-right">FAILED total</TableHead>
                <TableHead className="text-right">UNUSED rows</TableHead>
                <TableHead className="text-right">UNUSED total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b && Object.entries(b.by_channel).map(([ch, v]) => (
                <TableRow key={ch}>
                  <TableCell className="font-medium">
                    {ch}
                    {v.extra_tabs.length > 0 && <span className="text-xs text-muted-foreground ml-1">(+{v.extra_tabs.join(',')})</span>}
                  </TableCell>
                  <TableCell className="text-right">{fmt(v.passed.rows + v.extra.rows)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(v.passed.total + v.extra.total)}</TableCell>
                  <TableCell className="text-right">{fmt(v.failed.rows)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(v.failed.total)}</TableCell>
                  <TableCell className="text-right">{fmt(v.unused.total_rows)}</TableCell>
                  <TableCell className="text-right font-mono">{fmt(v.unused.total_amount)}</TableCell>
                </TableRow>
              ))}
              {b && (
                <TableRow className="bg-muted/30 font-semibold">
                  <TableCell>TOTAL</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right font-mono">{fmt(b.grand_passed_total)}</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right font-mono">{fmt(b.grand_failed_total)}</TableCell>
                  <TableCell className="text-right">—</TableCell>
                  <TableCell className="text-right font-mono">{fmt(b.grand_unused_total)}</TableCell>
                </TableRow>
              )}
            </TableBody>
          </Table>
        </SectionCard>

        <SectionCard title="Current vs Previous (per channel)">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Channel</TableHead>
                <TableHead className="text-right">PASSED cur</TableHead>
                <TableHead className="text-right">PASSED prev</TableHead>
                <TableHead className="text-right">Δ PASSED</TableHead>
                <TableHead className="text-right">FAILED cur</TableHead>
                <TableHead className="text-right">FAILED prev</TableHead>
                <TableHead className="text-right">Δ FAILED</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {b && Object.entries(b.by_channel).map(([ch, v]) => {
                const pv = bp?.by_channel[ch];
                const curP = v.passed.total + v.extra.total;
                const prevP = (pv?.passed.total || 0) + (pv?.extra.total || 0);
                const curF = v.failed.total; const prevF = pv?.failed.total || 0;
                return (
                  <TableRow key={ch}>
                    <TableCell className="font-medium">{ch}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(curP)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(prevP)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(curP - prevP)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(curF)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(prevF)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(curF - prevF)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </SectionCard>
      </PageShell>
    </Container>
  );
}
