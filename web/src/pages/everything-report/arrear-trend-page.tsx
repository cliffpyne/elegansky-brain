import { Container } from '@/components/common/container';
import { Badge } from '@/components/ui/badge';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EverythingReportSubNav } from './sub-nav';
import {
  PageShell, SectionCard, SectionFilterBar,
  fmt, fmtPct, useDefaultFilter, useReportComparison,
} from './shared';
import { TrendKpiTile } from './trend-kpi-tile';

export function ArrearTrendPage() {
  const [state, setState] = useDefaultFilter();
  const { current, previous, loading, reload, windows, lastFetch } = useReportComparison(state);
  const trend = current?.section_e_company_arrear_trend;
  // Cross-section comparison: D's arrears_realtime trend
  const cur = current?.section_c_d_officers?.grand?.arrears_realtime ?? null;
  const prev = previous?.section_c_d_officers?.grand?.arrears_realtime ?? null;
  return (
    <Container>
      <PageShell
        title="E · Company Arrear Trend"
        description={`Current arrears vs immediately-prior period — is total arrear going UP, DOWN, or FLAT?`}
      >
        <EverythingReportSubNav />
        <SectionFilterBar state={state} onChange={setState} onRefresh={reload} loading={loading} />

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
          <TrendKpiTile
            label="Arrears current"
            current={cur}
            previous={prev}
            invertDirection
            extractor={(d) => d.officers?.arrears_realtime ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Arrears prev period"
            current={prev}
            previous={null}
            extractor={(d) => d.officers?.arrears_realtime ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Net Δ arrears"
            current={(cur ?? 0) - (prev ?? 0)}
            previous={0}
            invertDirection
            extractor={(d) => d.officers?.arrear_collected ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
        </div>

        <SectionCard
          title="Company-wide arrear trend"
          toolbar={trend ? (
            <Badge variant={trend.direction === 'up' ? 'destructive' : trend.direction === 'down' ? 'success' : 'outline'} className="gap-1">
              {trend.direction === 'up' && <TrendingUp className="size-3" />}
              {trend.direction === 'down' && <TrendingDown className="size-3" />}
              {trend.direction === 'flat' && <Minus className="size-3" />}
              {trend.direction === 'up' ? 'GROWING (bad)' : trend.direction === 'down' ? 'SHRINKING (good)' : 'FLAT'}
            </Badge>
          ) : null}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Window</TableHead>
                <TableHead>Range</TableHead>
                <TableHead className="text-right">Arrear total</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Current</TableCell>
                <TableCell className="text-xs text-muted-foreground">{windows.current.from} → {windows.current.to}</TableCell>
                <TableCell className="text-right font-mono">{fmt(cur)}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Previous (same length)</TableCell>
                <TableCell className="text-xs text-muted-foreground">{windows.previous.from} → {windows.previous.to}</TableCell>
                <TableCell className="text-right font-mono">{fmt(prev)}</TableCell>
              </TableRow>
              <TableRow className="bg-muted/30 font-semibold">
                <TableCell>Δ</TableCell>
                <TableCell className="text-xs text-muted-foreground">{trend?.direction.toUpperCase()}</TableCell>
                <TableCell className="text-right font-mono">{fmt(trend?.delta)} ({fmtPct(trend?.pct_change)})</TableCell>
              </TableRow>
            </TableBody>
          </Table>
          {lastFetch && <div className="text-xs text-muted-foreground mt-2">Fetched {lastFetch.toLocaleTimeString()}</div>}
        </SectionCard>
      </PageShell>
    </Container>
  );
}
