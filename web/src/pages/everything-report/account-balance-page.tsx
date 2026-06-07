import { Container } from '@/components/common/container';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { EverythingReportSubNav } from './sub-nav';
import {
  PageShell, SectionCard, SectionFilterBar,
  fmt, fmt2, useDefaultFilter, useReportComparison,
} from './shared';
import { TrendKpiTile } from './trend-kpi-tile';
import { TrendCell } from './trend-cell';

export function AccountBalancePage() {
  const [state, setState] = useDefaultFilter();
  const { current, previous, loading, reload, windows, lastFetch } = useReportComparison(state);
  const a = current?.section_a_account_balance;
  const ap = previous?.section_a_account_balance;
  return (
    <Container>
      <PageShell
        title="A · Account QuickReport"
        description={`Elegansky Collection AC + sub-accounts · ${windows.current.from} → ${windows.current.to} vs ${windows.previous.from} → ${windows.previous.to}`}
      >
        <EverythingReportSubNav />
        <SectionFilterBar state={state} onChange={setState} onRefresh={reload} loading={loading} />

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <TrendKpiTile
            label="Payments (credits)"
            current={a?.payments_in_window.total ?? null}
            previous={ap?.payments_in_window.total ?? null}
            extractor={(d) => d.account?.payments_total ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Expenses (debits)"
            current={a?.expenses_in_window.total ?? null}
            previous={ap?.expenses_in_window.total ?? null}
            invertDirection
            extractor={(d) => d.account?.expenses_total ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Net movement"
            current={a?.net_movement ?? null}
            previous={ap?.net_movement ?? null}
            extractor={(d) => d.account?.net_movement ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
          <TrendKpiTile
            label="Live balance"
            current={a?.closing_live ?? null}
            previous={ap?.closing_live ?? null}
            formatter={fmt2}
            extractor={(d) => d.account?.closing_live ?? null}
            anchor={state.anchor}
            officerId={state.officerId || undefined}
          />
        </div>

        <SectionCard
          title="Account QuickReport — current window"
          toolbar={lastFetch ? <span className="text-xs text-muted-foreground">Fetched {lastFetch.toLocaleTimeString()}</span> : null}
        >
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead className="text-right">Value</TableHead>
                <TableHead>Source</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Beginning balance ({a?.opening_as_of?.slice(5) || '—'})</TableCell>
                <TableCell className="text-right">
                  <TrendCell label="Beginning balance" value={a?.opening_balance ?? null} formatter={fmt2} extractor={(d) => d.account?.opening_balance ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{a?.parent_account} + {a?.sub_accounts?.join(', ') || '—'} sub</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-green-700">+ Payments (credits)</TableCell>
                <TableCell className="text-right text-green-700">
                  <TrendCell label="Payments (credits)" value={a?.payments_in_window.total ?? null} extractor={(d) => d.account?.payments_total ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmt(a?.payments_in_window.count)} txns</TableCell>
              </TableRow>
              <TableRow>
                <TableCell className="text-red-700">− Expenses (debits)</TableCell>
                <TableCell className="text-right text-red-700">
                  <TrendCell label="Expenses (debits)" value={a?.expenses_in_window.total ?? null} invertDirection extractor={(d) => d.account?.expenses_total ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">{fmt(a?.expenses_in_window.count)} txns</TableCell>
              </TableRow>
              <TableRow className="bg-muted/30">
                <TableCell className="font-semibold">= Net movement</TableCell>
                <TableCell className="text-right font-semibold">
                  <TrendCell label="Net movement" value={a?.net_movement ?? null} extractor={(d) => d.account?.net_movement ?? null} anchor={state.anchor} officerId={state.officerId || undefined} /> ✓
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">Matches Account QuickReport TOTAL row</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Live balance now</TableCell>
                <TableCell className="text-right">
                  <TrendCell label="Live balance" value={a?.closing_live ?? null} formatter={fmt2} extractor={(d) => d.account?.closing_live ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-xs text-muted-foreground">parent + sub</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </SectionCard>

        <SectionCard title="Previous window (same length)">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Metric</TableHead>
                <TableHead className="text-right">Current</TableHead>
                <TableHead className="text-right">Previous</TableHead>
                <TableHead className="text-right">Δ</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow>
                <TableCell>Payments (credits)</TableCell>
                <TableCell className="text-right">
                  <TrendCell label="Payments (cur)" value={a?.payments_in_window.total ?? null} extractor={(d) => d.account?.payments_total ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-right">
                  <TrendCell label="Payments (prev)" value={ap?.payments_in_window.total ?? null} extractor={(d) => d.account?.payments_total ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-right font-mono">{fmt((a?.payments_in_window.total || 0) - (ap?.payments_in_window.total || 0))}</TableCell>
              </TableRow>
              <TableRow>
                <TableCell>Expenses (debits)</TableCell>
                <TableCell className="text-right">
                  <TrendCell label="Expenses (cur)" value={a?.expenses_in_window.total ?? null} invertDirection extractor={(d) => d.account?.expenses_total ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-right">
                  <TrendCell label="Expenses (prev)" value={ap?.expenses_in_window.total ?? null} invertDirection extractor={(d) => d.account?.expenses_total ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-right font-mono">{fmt((a?.expenses_in_window.total || 0) - (ap?.expenses_in_window.total || 0))}</TableCell>
              </TableRow>
              <TableRow className="bg-muted/30 font-semibold">
                <TableCell>Net movement</TableCell>
                <TableCell className="text-right">
                  <TrendCell label="Net (cur)" value={a?.net_movement ?? null} extractor={(d) => d.account?.net_movement ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-right">
                  <TrendCell label="Net (prev)" value={ap?.net_movement ?? null} extractor={(d) => d.account?.net_movement ?? null} anchor={state.anchor} officerId={state.officerId || undefined} />
                </TableCell>
                <TableCell className="text-right font-mono">{fmt((a?.net_movement || 0) - (ap?.net_movement || 0))}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </SectionCard>
      </PageShell>
    </Container>
  );
}
