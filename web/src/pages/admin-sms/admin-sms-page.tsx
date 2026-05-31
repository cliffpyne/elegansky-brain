import { Fragment, useCallback, useEffect, useState } from 'react';
import { Toolbar, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Save, RefreshCw } from 'lucide-react';
import { getSetting, setSetting } from '@/lib/brain-api';

// Calls the BRAIN admin-sms endpoints via the shared secret. These endpoints
// don't use Supabase JWT — they're producer/consumer flow secrets — so we
// hit them directly with a separate prefix. For the dashboard we add a thin
// wrapper that posts through the existing BRAIN host.
const BRAIN_BASE = import.meta.env.VITE_BRAIN_BASE || '';

async function fetchMessages(secret: string) {
  const r = await fetch(`${BRAIN_BASE}/api/admin-sms?limit=100`, {
    headers: { 'X-Report-Secret': secret },
  });
  if (!r.ok) throw new Error(`fetch ${r.status}: ${await r.text()}`);
  return (await r.json()) as {
    messages: Array<{
      id: string;
      created_at: string;
      to_phone: string;
      message: string;
      kind: string | null;
      status: 'pending' | 'sent' | 'failed';
      sent_at: string | null;
      failed_reason: string | null;
    }>;
  };
}

async function sendTest(secret: string, message: string) {
  const r = await fetch(`${BRAIN_BASE}/api/admin-sms/queue`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Report-Secret': secret },
    body: JSON.stringify({ message, kind: 'test' }),
  });
  if (!r.ok) throw new Error(`queue ${r.status}: ${await r.text()}`);
  return r.json();
}

export function AdminSmsPage() {
  const [phones, setPhones] = useState('');
  const [phonesSaved, setPhonesSaved] = useState('');
  const [savingPhones, setSavingPhones] = useState(false);
  const [secret, setSecret] = useState('');
  const [messages, setMessages] = useState<Awaited<ReturnType<typeof fetchMessages>>['messages']>([]);
  const [testMsg, setTestMsg] = useState('Test ping from BRAIN');
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const s = await getSetting('admin_phones').catch(() => null);
      const v = s?.value ?? '';
      setPhones(v);
      setPhonesSaved(v);
      if (secret) {
        try {
          const m = await fetchMessages(secret);
          setMessages(m.messages);
        } catch (e) {
          setError((e as Error).message);
        }
      }
      setLoading(false);
    } catch (e) {
      setError((e as Error).message);
      setLoading(false);
    }
  }, [secret]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const savePhones = useCallback(async () => {
    setSavingPhones(true);
    try {
      const cleaned = phones
        .split(/[,\s]+/)
        .map((p) => p.trim())
        .filter(Boolean)
        .join(', ');
      const updated = await setSetting('admin_phones', cleaned);
      setPhones(updated.value);
      setPhonesSaved(updated.value);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSavingPhones(false);
    }
  }, [phones]);

  const fireTest = useCallback(async () => {
    if (!secret) {
      setError('Set the shared secret first');
      return;
    }
    try {
      await sendTest(secret, testMsg);
      const m = await fetchMessages(secret);
      setMessages(m.messages);
    } catch (e) {
      setError((e as Error).message);
    }
  }, [secret, testMsg]);

  return (
    <Fragment>
      <Toolbar>
        <ToolbarHeading title="Admin notifications" description="Phone numbers that get an SMS when something fails" />
      </Toolbar>
      <Container>
        {error && (
          <Card className="mb-4 border-destructive">
            <CardContent className="pt-6 text-destructive">{error}</CardContent>
          </Card>
        )}
        <div className="grid gap-4 md:grid-cols-2">
          <Card>
            <CardHeader>
              <CardTitle>Admin phone numbers</CardTitle>
              <CardDescription>
                Comma-separated. International format (e.g. +255712345678). When a worker
                cycle hits its retry limit, every number listed here gets an SMS via the
                always-online relay phone.
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                placeholder="+255712345678, +255712345679"
                value={phones}
                onChange={(e) => setPhones(e.target.value)}
              />
              <Button
                onClick={savePhones}
                disabled={savingPhones || phones === phonesSaved}
                size="sm"
              >
                <Save className="size-4" /> Save
              </Button>
            </CardContent>
          </Card>

          <Card>
            <CardHeader>
              <CardTitle>Test a notification</CardTitle>
              <CardDescription>
                Enqueue a test message to every configured phone. Requires the shared
                report secret — paste it below (it's used here in your browser only).
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <Input
                type="password"
                placeholder="X-Report-Secret"
                value={secret}
                onChange={(e) => setSecret(e.target.value)}
              />
              <Input
                placeholder="Message body"
                value={testMsg}
                onChange={(e) => setTestMsg(e.target.value)}
              />
              <div className="flex gap-2">
                <Button onClick={fireTest} disabled={!secret} size="sm">
                  Send test
                </Button>
                <Button variant="outline" size="sm" onClick={refresh}>
                  <RefreshCw className="size-4" /> Refresh
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card className="mt-4">
          <CardHeader>
            <CardTitle>Recent messages</CardTitle>
            <CardDescription>
              Latest 100 queued/sent notifications. The relay phone APK polls
              <code className="mx-1">/api/admin-sms/pending</code> and acks each one
              after sending — pending means the APK hasn't picked it up yet.
            </CardDescription>
          </CardHeader>
          <CardContent>
            {loading ? (
              <p className="text-sm text-muted-foreground">Loading…</p>
            ) : messages.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No messages yet. Configure phones and trigger a failure (or use the test box).
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>When</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead>Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {messages.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(m.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{m.to_phone}</TableCell>
                      <TableCell>{m.kind || '—'}</TableCell>
                      <TableCell className="max-w-md truncate">{m.message}</TableCell>
                      <TableCell>
                        <Badge
                          variant={
                            m.status === 'sent'
                              ? 'default'
                              : m.status === 'failed'
                                ? 'destructive'
                                : 'secondary'
                          }
                        >
                          {m.status}
                        </Badge>
                        {m.status === 'failed' && m.failed_reason && (
                          <div className="text-xs text-destructive mt-1">{m.failed_reason}</div>
                        )}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      </Container>
    </Fragment>
  );
}
