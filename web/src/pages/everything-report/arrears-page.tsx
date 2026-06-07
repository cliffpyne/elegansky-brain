import { useMemo } from 'react';
import { Container } from '@/components/common/container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EverythingReportSubNav } from './sub-nav';
import {
  PageShell, SectionCard, SectionFilterBar,
  fmt, fmtPct, useDefaultFilter, useReportComparison, useSnapshotRefresh,
} from './shared';
import { TrendKpiTile } from './trend-kpi-tile';
import { TrendCell } from './trend-cell';
import { Button } from '@/components/ui/button';
import { RefreshCw } from 'lucide-react';

export function ArrearsPage() {
  const [state, setState] = useDefaultFilter();
  const { current, previous, loading, reload, windows, lastFetch } = useReportComparison(state);
  const { refresh: refreshSnapshots, refreshing } = useSnapshotRefresh(reload);
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
        <div className="flex items-center justify-between">
          <div className="text-xs text-muted-foreground">
            Morning arrears + real-time arrears come from QB. Click <b>Refresh snapshots</b> to pull a fresh arrears snapshot for today.
          </div>
          <Button onClick={refreshSnapshots} disabled={refreshing || loading} variant="outline" size="sm">
            <RefreshCw className={`mr-2 size-4 ${refreshing ? 'animate-spin' : ''}`} />
            {refreshing ? 'Refreshing QB…' : 'Refresh snapshots (live QB)'}
          </Button>
        </div>

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
            label="Officers active"
            current={c?.officers.length ?? null}
            previous={cp?.officers.length ?? null}
            extractor={(d) => d.officers?.officer_count ?? null}
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
                  <TableHead className="text-right">Arrear collected</TableHead>
                  <TableHead className="text-right">% arrear collected</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {c?.officers.map((o) => (
                  <TableRow key={o.officer_id}>
                    <TableCell className="whitespace-nowrap font-medium">{o.officer_name}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.arrears_morning)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.arrears_realtime)}</TableCell>
                    <TableCell className="text-right font-mono">{fmt(o.arrear_collected)}</TableCell>
                    <TableCell className="text-right">{fmtPct(o.arrear_pct_collected)}</TableCell>
                  </TableRow>
                ))}
                {c && (
                  <TableRow className="bg-muted/30 font-semibold">
                    <TableCell>TOTAL</TableCell>
                    <TableCell className="text-right">
                      <TrendCell label="Total arrears morning" value={c.grand.arrears_morning} invertDirection extractor={(d) => d.officers?.arrears_morning ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                    </TableCell>
                    <TableCell className="text-right">
                      <TrendCell label="Total arrears now" value={c.grand.arrears_realtime} invertDirection extractor={(d) => d.officers?.arrears_realtime ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                    </TableCell>
                    <TableCell className="text-right">
                      <TrendCell label="Total arrear collected" value={c.grand.arrear_collected} extractor={(d) => d.officers?.arrear_collected ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                    </TableCell>
                    <TableCell className="text-right">{fmtPct(c.grand.arrear_pct_collected)}</TableCell>
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
