import { Fragment, useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Toolbar, ToolbarActions, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { ArrowLeft, RefreshCw, MessageSquare, Wrench, Brain, AlertCircle } from 'lucide-react';
import { getAgentSession, type AgentSessionRow, type AgentSessionMessage } from '@/lib/brain-api';

const REFRESH_MS = 5_000;

function statusVariant(s: string): 'default' | 'secondary' | 'destructive' | 'outline' {
  switch (s) {
    case 'completed': return 'default';
    case 'running': return 'secondary';
    case 'paused': return 'outline';
    case 'errored':
    case 'aborted': return 'destructive';
    default: return 'outline';
  }
}

function fmtUsd(n: string | null | undefined): string {
  if (n == null) return '-';
  return '$' + Number(n).toFixed(4);
}

function fmtTok(n: string | number | null | undefined): string {
  if (n == null) return '-';
  return Number(n).toLocaleString();
}

interface ContentBlock {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
}

function MessageBlock({ msg }: { msg: AgentSessionMessage }) {
  const p = msg.payload as Record<string, unknown>;
  const time = new Date(msg.created_at).toISOString().slice(11, 19);

  if (msg.role === 'system') {
    return (
      <div className="border-l-4 border-slate-300 pl-3 py-2 text-xs text-muted-foreground">
        <div className="font-mono">[{time}] system prompt loaded</div>
      </div>
    );
  }

  if (msg.role === 'user') {
    const text = (p as { text?: string }).text || JSON.stringify(p, null, 2);
    return (
      <div className="border-l-4 border-blue-400 pl-3 py-2">
        <div className="text-xs font-mono text-muted-foreground">[{time}] user (trigger)</div>
        <pre className="text-xs whitespace-pre-wrap mt-1 max-h-48 overflow-auto">{text}</pre>
      </div>
    );
  }

  if (msg.role === 'assistant') {
    const blocks = (p.content || []) as ContentBlock[];
    return (
      <div className="border-l-4 border-purple-400 pl-3 py-2 space-y-2">
        <div className="text-xs font-mono text-muted-foreground flex items-center gap-2">
          [{time}] <Brain className="size-3" /> assistant turn {(p as { turn?: number }).turn ?? ''}
          <span className="text-[10px] uppercase tracking-wide">{(p as { stop_reason?: string }).stop_reason}</span>
        </div>
        {blocks.map((b, i) => {
          if (b.type === 'text') {
            return (
              <div key={i} className="text-sm whitespace-pre-wrap">{b.text}</div>
            );
          }
          if (b.type === 'tool_use') {
            return (
              <div key={i} className="bg-amber-50 border border-amber-200 rounded p-2">
                <div className="flex items-center gap-2 text-xs font-mono text-amber-700">
                  <Wrench className="size-3" /> tool_use → <strong>{b.name}</strong>
                </div>
                <pre className="text-xs whitespace-pre-wrap mt-1 max-h-32 overflow-auto">{JSON.stringify(b.input, null, 2)}</pre>
              </div>
            );
          }
          return null;
        })}
      </div>
    );
  }

  if (msg.role === 'tool') {
    const isError = !!p.error;
    return (
      <div className={`border-l-4 ${isError ? 'border-red-400' : 'border-emerald-400'} pl-3 py-2`}>
        <div className="text-xs font-mono text-muted-foreground flex items-center gap-2">
          [{time}] {isError ? <AlertCircle className="size-3 text-red-600" /> : <MessageSquare className="size-3" />} tool result → <strong>{msg.kind}</strong>
          {(p as { elapsed_ms?: number }).elapsed_ms != null && <span className="text-[10px]">({(p as { elapsed_ms?: number }).elapsed_ms}ms)</span>}
        </div>
        {isError ? (
          <pre className="text-xs whitespace-pre-wrap mt-1 text-red-700 max-h-48 overflow-auto">{String(p.error)}</pre>
        ) : (
          <pre className="text-xs whitespace-pre-wrap mt-1 max-h-48 overflow-auto">
            {typeof p.result_preview === 'string'
              ? p.result_preview
              : JSON.stringify(p.result_preview, null, 2)}
          </pre>
        )}
      </div>
    );
  }

  return null;
}

export function AgentSessionDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [session, setSession] = useState<AgentSessionRow | null>(null);
  const [messages, setMessages] = useState<AgentSessionMessage[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) return;
    try {
      const r = await getAgentSession(id);
      setSession(r.session);
      setMessages(r.messages);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void refresh();
    if (session?.status === 'running') {
      const t = setInterval(refresh, REFRESH_MS);
      return () => clearInterval(t);
    }
    return undefined;
  }, [refresh, session?.status]);

  return (
    <Fragment>
      <Toolbar>
        <ToolbarHeading
          title="Agent session"
          description={session?.trigger || ''}
        />
        <ToolbarActions>
          <Button variant="outline" asChild>
            <Link to="/agent">
              <ArrowLeft className="size-4" /> Back
            </Link>
          </Button>
          <Button variant="outline" onClick={refresh} disabled={loading}>
            <RefreshCw className={`size-4 ${loading ? 'animate-spin' : ''}`} />
            Refresh
          </Button>
        </ToolbarActions>
      </Toolbar>
      <Container className="space-y-4">
        {error && (
          <div className="text-sm text-red-600 border border-red-200 bg-red-50 p-3 rounded">
            {error}
          </div>
        )}
        {session && (
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Badge variant={statusVariant(session.status)}>{session.status}</Badge>
                <Badge variant={session.mode === 'execute' ? 'default' : 'outline'}>{session.mode}</Badge>
                <span className="text-xs font-mono">{session.id}</span>
              </CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="grid grid-cols-4 gap-3 text-sm">
                <div>
                  <div className="text-muted-foreground text-xs">Model</div>
                  <div className="font-mono">{session.model}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Cost</div>
                  <div className="font-mono">{fmtUsd(session.cost_usd)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Input tokens</div>
                  <div className="font-mono">{fmtTok(session.input_tokens)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Output tokens</div>
                  <div className="font-mono">{fmtTok(session.output_tokens)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Cache read</div>
                  <div className="font-mono">{fmtTok(session.cache_read_tokens)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Cache write</div>
                  <div className="font-mono">{fmtTok(session.cache_write_tokens)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Started</div>
                  <div className="font-mono text-xs">{new Date(session.started_at).toISOString().slice(0, 19)}</div>
                </div>
                <div>
                  <div className="text-muted-foreground text-xs">Ended</div>
                  <div className="font-mono text-xs">{session.ended_at ? new Date(session.ended_at).toISOString().slice(0, 19) : '—'}</div>
                </div>
              </div>
              {session.summary && (
                <div>
                  <div className="text-muted-foreground text-xs mb-1">Summary</div>
                  <div className="text-sm bg-slate-50 p-3 rounded">{session.summary}</div>
                </div>
              )}
              {session.stats && Object.keys(session.stats).length > 0 && (
                <div>
                  <div className="text-muted-foreground text-xs mb-1">Stats</div>
                  <pre className="text-xs bg-slate-50 p-2 rounded">{JSON.stringify(session.stats, null, 2)}</pre>
                </div>
              )}
            </CardContent>
          </Card>
        )}
        <Card>
          <CardHeader>
            <CardTitle>Message log ({messages.length})</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            {messages.length === 0 && <div className="text-sm text-muted-foreground">No messages yet…</div>}
            {messages.map((m) => (
              <MessageBlock key={m.id} msg={m} />
            ))}
          </CardContent>
        </Card>
      </Container>
    </Fragment>
  );
}
