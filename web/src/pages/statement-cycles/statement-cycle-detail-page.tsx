import { Fragment, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import {
  Toolbar,
  ToolbarActions,
  ToolbarHeading,
} from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, AlertCircle, CheckCircle2 } from 'lucide-react';
import { getCycle, relativeTime, formatDuration, type CycleFull } from '@/lib/brain-api';

export function StatementCycleDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [cycle, setCycle] = useState<CycleFull | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [activeShot, setActiveShot] = useState(0);

  useEffect(() => {
    document.title = cycle ? `BRAIN — ${cycle.bank} cycle` : 'BRAIN — Cycle';
    return () => {
      document.title = 'BRAIN';
    };
  }, [cycle]);

  useEffect(() => {
    if (!id) return;
    getCycle(id)
      .then((r) => setCycle(r.cycle))
      .catch((e) => setError((e as Error).message));
  }, [id]);

  if (error) {
    return (
      <Container>
        <Card className="border-destructive/30 bg-destructive/5">
          <CardContent className="py-6 flex items-start gap-3">
            <AlertCircle className="size-5 text-destructive shrink-0 mt-0.5" />
            <div>
              <div className="font-medium text-destructive">Couldn’t load cycle</div>
              <div className="text-sm text-muted-foreground mt-1">{error}</div>
            </div>
          </CardContent>
        </Card>
      </Container>
    );
  }

  if (!cycle) {
    return (
      <Container>
        <div className="text-muted-foreground py-12 text-center">Loading…</div>
      </Container>
    );
  }

  return (
    <Fragment>
      <Container>
        <Toolbar>
          <ToolbarHeading
            title={`${cycle.bank} cycle · ${cycle.status === 'ok' ? '✓' : '✗'}`}
            description={`${new Date(cycle.reported_at).toLocaleString()} · ${formatDuration(
              cycle.duration_ms,
            )} · worker ${cycle.worker_id}`}
          />
          <ToolbarActions>
            <Button variant="outline" asChild>
              <Link to="/statement-cycles">
                <ArrowLeft className="size-4" /> Back to cycles
              </Link>
            </Button>
          </ToolbarActions>
        </Toolbar>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
          {/* Left col: stats + processor message + raw error */}
          <div className="lg:col-span-1 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <div className="flex items-center justify-between">
                  <CardTitle className="text-base">Outcome</CardTitle>
                  {cycle.status === 'ok' ? (
                    <Badge variant="default" className="bg-success text-success-foreground gap-1">
                      <CheckCircle2 className="size-3" /> ok
                    </Badge>
                  ) : (
                    <Badge variant="destructive" className="gap-1">
                      <AlertCircle className="size-3" /> fail
                    </Badge>
                  )}
                </div>
              </CardHeader>
              <CardContent className="space-y-3">
                <Row label="Bank" value={cycle.bank} />
                <Row label="Started" value={new Date(cycle.started_at).toLocaleString()} />
                <Row label="Finished" value={new Date(cycle.finished_at).toLocaleString()} />
                <Row label="Duration" value={formatDuration(cycle.duration_ms)} />
                <Row label="Worker" value={cycle.worker_id} />
                <Row label="Reported" value={relativeTime(cycle.reported_at)} />
              </CardContent>
            </Card>

            {cycle.stats && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Stats</CardTitle>
                </CardHeader>
                <CardContent>
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    {Object.entries(cycle.stats).map(([k, v]) => (
                      <div key={k} className="flex items-center justify-between border-b pb-1.5">
                        <span className="text-muted-foreground">{k}</span>
                        <span className="font-medium tabular-nums">{String(v)}</span>
                      </div>
                    ))}
                  </div>
                </CardContent>
              </Card>
            )}

            {cycle.error_text && (
              <Card className="border-destructive/30 bg-destructive/5">
                <CardHeader className="pb-2">
                  <CardTitle className="text-base text-destructive">Error</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-xs whitespace-pre-wrap break-all text-destructive">
                    {cycle.error_text}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>

          {/* Right col: screenshots */}
          <div className="lg:col-span-2 space-y-4">
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-base">
                  Screenshots ({cycle.screenshots?.length ?? 0})
                </CardTitle>
              </CardHeader>
              <CardContent>
                {cycle.screenshots && cycle.screenshots.length > 0 ? (
                  <div className="space-y-3">
                    <div className="border rounded-lg overflow-hidden bg-muted">
                      <img
                        src={cycle.screenshots[activeShot]}
                        alt={`Screenshot ${activeShot + 1}`}
                        className="w-full max-h-[640px] object-contain bg-background"
                      />
                    </div>
                    <div className="flex flex-wrap gap-2">
                      {cycle.screenshots.map((src, i) => (
                        <button
                          key={i}
                          type="button"
                          onClick={() => setActiveShot(i)}
                          className={`border rounded overflow-hidden h-16 w-24 shrink-0 ${
                            i === activeShot ? 'ring-2 ring-primary' : ''
                          }`}
                        >
                          <img src={src} alt={`thumb ${i + 1}`} className="h-full w-full object-cover" />
                        </button>
                      ))}
                    </div>
                  </div>
                ) : (
                  <div className="text-sm text-muted-foreground py-8 text-center">
                    No screenshots captured for this cycle.
                  </div>
                )}
              </CardContent>
            </Card>

            {cycle.processor_response !== null && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-base">Processor response</CardTitle>
                </CardHeader>
                <CardContent>
                  <pre className="text-xs whitespace-pre-wrap break-all bg-muted rounded p-3 max-h-96 overflow-auto">
                    {JSON.stringify(cycle.processor_response, null, 2)}
                  </pre>
                </CardContent>
              </Card>
            )}
          </div>
        </div>
      </Container>
    </Fragment>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between text-sm border-b pb-1.5">
      <span className="text-muted-foreground">{label}</span>
      <span className="font-medium">{value}</span>
    </div>
  );
}

export default StatementCycleDetailPage;
