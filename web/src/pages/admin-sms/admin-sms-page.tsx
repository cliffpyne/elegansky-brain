import { Fragment, useCallback, useEffect, useState } from 'react';
import { Toolbar, ToolbarHeading } from '@/layouts/demo1/components/toolbar';
import { Container } from '@/components/common/container';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from '@/components/ui/table';
import { Save, RefreshCw } from 'lucide-react';
import { getSetting, setSetting } from '@/lib/brain-api';

// Calls the BRAIN admin-sms endpoints via the shared secret. These endpoints
// don't use Supabase JWT — they're producer/consumer flow secrets — so we
// hit them directly with a separate prefix. For the dashboard we add a thin
// wrapper that posts through the existing BRAIN host.
import { supabase } from '@/lib/supabase';

const BRAIN_BASE = import.meta.env.VITE_BRAIN_BASE || '';

async function authHeader(): Promise<Record<string, string>> {
  const session = (await supabase.auth.getSession()).data.session;
  const token = session?.access_token;
  return token ? { authorization: `Bearer ${token}` } : {};
}

async function fetchMessages(_secret: string) {
  const r = await fetch(`${BRAIN_BASE}/api/admin-sms?limit=100`, {
    headers: await authHeader(),
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

async function sendTest(_secret: string, message: string) {
  // Use /api/admin/notifications/test — writes to the `notifications` table
  // which the phone APK actually polls. /api/admin-sms/queue uses a separate
  // legacy `admin_sms_queue` table the APK never sees.
  const r = await fetch(`${BRAIN_BASE}/api/admin/notifications/test`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
    body: JSON.stringify({ message, severity: 'info' }),
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
  const [msgPage, setMsgPage] = useState(0);
  const MESSAGES_PAGE_SIZE = 10;
  const pagedMessages = messages.slice(msgPage * MESSAGES_PAGE_SIZE, (msgPage + 1) * MESSAGES_PAGE_SIZE);
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
        <div className="space-y-5">
        {error && (
          <Card className="mb-4 border-destructive">
            <CardContent className="pt-6 text-destructive">{error}</CardContent>
          </Card>
        )}
        <div className="grid gap-5 md:grid-cols-2 items-start">
          <Card>
            <CardHeader className="border-b">
              <CardTitle>Admin phone numbers</CardTitle>
              <CardDescription>
                Comma-separated. Every number gets an SMS when a worker cycle hits its retry limit.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="admin-phones" className="text-sm font-medium">Phone numbers</Label>
                <Input
                  id="admin-phones"
                  placeholder="+255712345678, +255712345679"
                  value={phones}
                  onChange={(e) => setPhones(e.target.value)}
                />
              </div>
              <div className="flex items-center justify-between gap-3 pt-1">
                <span className="text-xs text-muted-foreground">
                  {phones === phonesSaved ? 'No unsaved changes' : 'Unsaved changes'}
                </span>
                <Button
                  onClick={savePhones}
                  disabled={savingPhones || phones === phonesSaved}
                  size="sm"
                >
                  <Save className="size-4" /> Save
                </Button>
              </div>
            </CardContent>
          </Card>

          <Card>
            <CardHeader className="border-b">
              <CardTitle>Test a notification</CardTitle>
              <CardDescription>
                Send a test SMS to every configured phone. Needs the shared report secret.
              </CardDescription>
            </CardHeader>
            <CardContent className="p-5 space-y-4">
              <div className="space-y-1.5">
                <Label htmlFor="report-secret" className="text-sm font-medium">Report secret</Label>
                <Input
                  id="report-secret"
                  type="password"
                  placeholder="X-Report-Secret"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                />
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="test-message" className="text-sm font-medium">Message body</Label>
                <Input
                  id="test-message"
                  placeholder="Test ping from BRAIN"
                  value={testMsg}
                  onChange={(e) => setTestMsg(e.target.value)}
                />
              </div>
              <div className="flex items-center justify-end gap-2 pt-1">
                <Button variant="outline" size="sm" onClick={refresh}>
                  <RefreshCw className="size-4" /> Refresh
                </Button>
                <Button onClick={fireTest} disabled={!secret} size="sm">
                  Send test
                </Button>
              </div>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardHeader className="border-b">
            <CardTitle>Recent messages</CardTitle>
            <CardDescription>
              Latest queued/sent notifications. The relay phone APK polls
              <code className="mx-1 select-text">/api/admin-sms/pending</code> and acks each one
              after sending — <span className="font-medium">pending</span> means the APK hasn't picked it up yet.
            </CardDescription>
          </CardHeader>
          <CardContent className="p-0">
            {loading ? (
              <p className="text-sm text-muted-foreground px-5 py-8 text-center">Loading…</p>
            ) : messages.length === 0 ? (
              <p className="text-sm text-muted-foreground px-5 py-8 text-center">
                No messages yet. Configure phones and trigger a failure (or use the test box).
              </p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="pl-5">When</TableHead>
                    <TableHead>Phone</TableHead>
                    <TableHead>Kind</TableHead>
                    <TableHead>Message</TableHead>
                    <TableHead className="pr-5">Status</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {pagedMessages.map((m) => (
                    <TableRow key={m.id}>
                      <TableCell className="pl-5 whitespace-nowrap text-sm text-muted-foreground">
                        {new Date(m.created_at).toLocaleString()}
                      </TableCell>
                      <TableCell className="font-mono text-xs">{m.to_phone}</TableCell>
                      <TableCell>{m.kind || '—'}</TableCell>
                      <TableCell className="max-w-md truncate">{m.message}</TableCell>
                      <TableCell className="pr-5">
                        <Badge
                          variant={
                            m.status === 'sent'
                              ? 'primary'
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
          {messages.length > MESSAGES_PAGE_SIZE && (
            <div className="flex items-center justify-between border-t px-5 py-3 text-sm">
              <span className="text-muted-foreground">
                Showing {msgPage * MESSAGES_PAGE_SIZE + 1}–{Math.min((msgPage + 1) * MESSAGES_PAGE_SIZE, messages.length)} of {messages.length.toLocaleString()}
              </span>
              <div className="flex items-center gap-2">
                <Button variant="outline" size="sm" onClick={() => setMsgPage((p) => Math.max(0, p - 1))} disabled={msgPage === 0}>Previous</Button>
                <Button variant="outline" size="sm" onClick={() => setMsgPage((p) => Math.min(Math.ceil(messages.length / MESSAGES_PAGE_SIZE) - 1, p + 1))} disabled={(msgPage + 1) * MESSAGES_PAGE_SIZE >= messages.length}>Next</Button>
              </div>
            </div>
          )}
        </Card>
      </div>
      </Container>
    </Fragment>
  );
}
