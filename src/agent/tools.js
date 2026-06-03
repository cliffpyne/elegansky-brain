// Tool definitions exposed to the autonomous Claude.
// Each tool: a JSON schema (sent to the model) + a JS handler that runs it.
//
// Design rules:
//   - Tools are SIDE-EFFECTFUL HTTP/DB calls. Keep them small + idempotent.
//   - Every tool logs to the DB session log automatically.
//   - Errors are returned as the tool result, not thrown — let Claude decide.
//   - Read-only tools are safe to call freely. Write tools require a session
//     that's in 'execute' mode (not 'plan' mode).

import { qbGet, qbQuery, qbBatch } from '../qb-client.js';
import { readSheet } from '../sheets.js';
import { notifyAdmin } from '../notifications.js';

export const TOOLS = [
  {
    name: 'qb_query',
    description:
      'Run a QuickBooks Online query. Use for SELECT-style reads of Customer, Invoice, Payment, Account, etc. Returns the QueryResponse array. Note: QBO LIKE wildcards are unreliable; prefer exact-match or explicit Id lookups.',
    input_schema: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'QBO Query Language statement, e.g. "SELECT * FROM Customer WHERE DisplayName = \'FOO\' MAXRESULTS 5"',
        },
      },
      required: ['query'],
    },
  },
  {
    name: 'qb_get',
    description:
      'GET a single QB entity by Id. Use when you know the exact Id (more reliable than LIKE queries). Returns the full entity.',
    input_schema: {
      type: 'object',
      properties: {
        entity: { type: 'string', enum: ['customer', 'invoice', 'payment', 'account', 'creditmemo'] },
        id: { type: 'string' },
      },
      required: ['entity', 'id'],
    },
  },
  {
    name: 'qb_batch',
    description:
      'POST to QB /batch endpoint. Max 30 ops per call. Use for bulk create/update/delete. Each op needs bId, operation, and an entity payload. Returns BatchItemResponse array. NEVER use this in plan-only mode.',
    input_schema: {
      type: 'object',
      properties: {
        operations: {
          type: 'array',
          maxItems: 30,
          items: {
            type: 'object',
            properties: {
              bId: { type: 'string' },
              operation: { type: 'string', enum: ['create', 'update', 'delete'] },
              entityType: { type: 'string', enum: ['Payment', 'Invoice', 'CreditMemo'] },
              entity: { type: 'object', description: 'The entity body — for create, the new object; for update/delete, must include Id and SyncToken.' },
            },
            required: ['bId', 'operation', 'entityType', 'entity'],
          },
        },
      },
      required: ['operations'],
    },
  },
  {
    name: 'sheet_read',
    description:
      'Read a range from a Google Sheet. Returns rows as 2D array (first row is the header you can choose to keep or skip).',
    input_schema: {
      type: 'object',
      properties: {
        spreadsheetId: { type: 'string' },
        range: { type: 'string', description: 'A1 notation, e.g. "PASSED!A1:H80000"' },
      },
      required: ['spreadsheetId', 'range'],
    },
  },
  {
    name: 'db_query',
    description:
      'Run a read-only SQL SELECT on BRAIN Postgres. Tables: payment_batches, payment_uploads, consumed_transactions, statement_cycles, notifications, agent_sessions, agent_session_messages, duplicate_customers, app_settings. PARAMETERIZED ($1, $2 …); no string interp.',
    input_schema: {
      type: 'object',
      properties: {
        sql: { type: 'string' },
        params: { type: 'array', items: {} },
      },
      required: ['sql'],
    },
  },
  {
    name: 'db_log',
    description:
      'Append a structured event to the current session log. Use freely — Frank reads these to audit your reasoning. Levels: info, warn, error.',
    input_schema: {
      type: 'object',
      properties: {
        level: { type: 'string', enum: ['info', 'warn', 'error'] },
        event: { type: 'string', description: 'short event name, e.g. "plan-written" or "sheet-loaded"' },
        detail: { type: 'object' },
      },
      required: ['level', 'event'],
    },
  },
  {
    name: 'sms_notify',
    description:
      'Send Frank an SMS via the phone APK gateway. Use for: 1-line heartbeats during long runs, reconciliation-mismatch alarms, ambiguity questions needing his judgement, end-of-run summary. Keep messages short — these are real SMSs.',
    input_schema: {
      type: 'object',
      properties: {
        message: { type: 'string', description: 'plain text, <=300 chars ideal' },
        severity: { type: 'string', enum: ['critical', 'warning', 'info'] },
      },
      required: ['message', 'severity'],
    },
  },
  {
    name: 'ask_frank_and_wait',
    description:
      'Send Frank a question via SMS and PAUSE this session. The cron job ends; when Frank replies, a new session resumes with his answer in the SMS thread. Use only for irreversible decisions (mass deletes, ambiguous customer matches at scale, algorithm deviation).',
    input_schema: {
      type: 'object',
      properties: {
        question: { type: 'string' },
        context: { type: 'string', description: 'what you were about to do, what the options are' },
      },
      required: ['question', 'context'],
    },
  },
  {
    name: 'run_upload_window',
    description:
      'Run the full IP-algorithm upload for one channel + time window. This is the high-level tool that does sheet-read + arrears-match + payment-allocation + QB-push + DB-logging in one call. Internally calls the same auto-upload pipeline that the existing cron uses. RETURNS a structured summary { batch_id, paid_count, paid_total, unused_count, unused_total, flagged, skipped }. In plan mode, sets dry_run=true so no QB writes happen. NEVER pass a window that overlaps an already-processed one — consumed_transactions will reject duplicates.',
    input_schema: {
      type: 'object',
      properties: {
        channel: {
          type: 'string',
          enum: ['nmbnew', 'bank', 'iphone_bank'],
          description: 'nmbnew=NMB, bank=CRDB, iphone_bank=iPhone M-Pesa',
        },
        since_iso: {
          type: 'string',
          description: 'Window start in ISO 8601, e.g. "2026-06-03T00:00:00Z". UTC. EAT is UTC+3.',
        },
        until_iso: {
          type: 'string',
          description: 'Window end in ISO 8601 (exclusive).',
        },
        as_of: {
          type: 'string',
          description: 'YYYY-MM-DD — controls which invoices are in the matching pool (DueDate <= as_of). The calendar day the BANK TXN HAPPENED. NOT the same as txn_date. See BRAIN_BRAIN.md "AS_OF rule" — independent from txn_date.',
        },
        txn_date: {
          type: 'string',
          description: 'YYYY-MM-DD — the date written to QB as the Payment TxnDate. Determined by the scheduled tick name: ticks at or before 16:15 EAT → txn_date=execution day; ticks after 16:15 EAT → txn_date=next day. INDEPENDENT from as_of: as_of is when the customer actually paid, txn_date is when the bookkeeper records it. Omit only if you want the wall-clock default (paymentTxnDate() — risky for retries).',
        },
      },
      required: ['channel', 'since_iso', 'until_iso', 'as_of'],
    },
  },
  {
    name: 'end_session',
    description:
      'Cleanly end this session with a summary. Call this as your LAST tool. Writes summary + status to agent_sessions.',
    input_schema: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['completed', 'paused', 'aborted'] },
        summary: { type: 'string', description: '2–4 sentences. What ran, what got pushed, what was anomalous.' },
        stats: {
          type: 'object',
          properties: {
            rows_processed: { type: 'integer' },
            rows_paid: { type: 'integer' },
            rows_unused: { type: 'integer' },
            rows_flagged: { type: 'integer' },
            total_paid_tzs: { type: 'number' },
            total_unused_tzs: { type: 'number' },
          },
        },
      },
      required: ['status', 'summary'],
    },
  },
];

// Handler dispatch — each handler gets (input, ctx) where ctx = { db, sessionId, mode }
export async function dispatch(toolName, input, ctx) {
  const start = Date.now();
  try {
    let result;
    switch (toolName) {
      case 'qb_query':
        result = await qbQuery(input.query);
        break;
      case 'qb_get':
        result = await qbGet(input.entity, input.id);
        break;
      case 'qb_batch':
        if (ctx.mode === 'plan') {
          result = { skipped: true, reason: 'plan mode — no writes performed', would_have_run: input.operations.length + ' ops' };
        } else {
          result = await qbBatch(input.operations);
        }
        break;
      case 'sheet_read':
        result = await readSheet(input.spreadsheetId, input.range);
        break;
      case 'db_query':
        result = await ctx.db.query(input.sql, input.params || []);
        result = { rowCount: result.rowCount, rows: result.rows };
        break;
      case 'db_log':
        await ctx.db.query(
          `INSERT INTO agent_session_messages (session_id, role, kind, payload)
           VALUES ($1, 'tool', 'db_log', $2)`,
          [ctx.sessionId, JSON.stringify({ level: input.level, event: input.event, detail: input.detail || {} })],
        );
        result = { logged: true };
        break;
      case 'sms_notify':
        if (ctx.mode === 'plan') {
          result = { skipped: true, reason: 'plan mode — SMS suppressed', would_have_sent: input.message };
        } else {
          await notifyAdmin({ message: input.message, severity: input.severity, source: 'agent:' + ctx.sessionId });
          result = { sent: true };
        }
        break;
      case 'ask_frank_and_wait':
        await ctx.db.query(
          `UPDATE agent_sessions SET status='paused', paused_question=$2, updated_at=now() WHERE id=$1`,
          [ctx.sessionId, JSON.stringify({ question: input.question, context: input.context })],
        );
        await notifyAdmin({ message: 'BRAIN paused: ' + input.question, severity: 'warning', source: 'agent:' + ctx.sessionId });
        ctx.shouldHalt = 'paused';
        result = { paused: true, note: 'Session paused. You will resume when Frank replies.' };
        break;
      case 'run_upload_window': {
        // Internal HTTP call to BRAIN's own auto-upload endpoint. Uses the
        // shared secret so it bypasses external network. dry_run=true when
        // mode='plan'.
        const base = process.env.SELF_URL || 'http://127.0.0.1:' + (process.env.PORT || 3000);
        const secret = process.env.STATEMENT_REPORT_SECRET;
        if (!secret) {
          result = { error: 'STATEMENT_REPORT_SECRET not configured — agent cannot call auto-upload' };
          break;
        }
        const body = {
          since_iso: input.since_iso,
          until_iso: input.until_iso,
          as_of: input.as_of,
          txn_date: input.txn_date || null,
          dry_run: ctx.mode === 'plan',
        };
        const r = await fetch(`${base}/api/payment-batches/auto-upload/${encodeURIComponent(input.channel)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Report-Secret': secret },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(180_000),
        });
        const j = await r.json().catch(async () => ({ error: 'non-json response', body: (await r.text()).slice(0, 500) }));
        if (!r.ok) {
          result = { error: `auto-upload ${r.status}`, detail: j };
        } else {
          // Summarise so the model doesn't blow context on raw response.
          result = {
            mode: ctx.mode,
            channel: input.channel,
            window: { since: input.since_iso, until: input.until_iso, as_of: input.as_of, txn_date: input.txn_date || null },
            batch_id: j.batch_id || null,
            skipped: !!j.skipped,
            skipped_reason: j.skipped ? (j.reason || null) : null,
            paid_count: j.paid?.length ?? j.paid_count ?? null,
            paid_total: j.paid_total ?? null,
            unused_count: j.unused?.length ?? j.unused_count ?? null,
            unused_total: j.unused_total ?? null,
            sheet_total: j.sheet_total ?? null,
            reconciles: j.sheet_total != null && j.paid_total != null && j.unused_total != null
              ? Math.abs(Number(j.sheet_total) - (Number(j.paid_total) + Number(j.unused_total))) < 0.01
              : null,
          };
        }
        break;
      }
      case 'end_session':
        await ctx.db.query(
          `UPDATE agent_sessions
              SET status=$2, summary=$3, stats=$4, ended_at=now(), updated_at=now()
            WHERE id=$1`,
          [ctx.sessionId, input.status, input.summary, JSON.stringify(input.stats || {})],
        );
        ctx.shouldHalt = input.status;
        result = { ended: true };
        break;
      default:
        result = { error: 'unknown tool: ' + toolName };
    }
    // Log the tool call itself (input + result + elapsed)
    await ctx.db.query(
      `INSERT INTO agent_session_messages (session_id, role, kind, payload)
       VALUES ($1, 'tool', $2, $3)`,
      [ctx.sessionId, toolName, JSON.stringify({ input, result_preview: previewResult(result), elapsed_ms: Date.now() - start })],
    );
    return result;
  } catch (err) {
    const errMsg = String(err.message || err).slice(0, 500);
    await ctx.db.query(
      `INSERT INTO agent_session_messages (session_id, role, kind, payload)
       VALUES ($1, 'tool', $2, $3)`,
      [ctx.sessionId, toolName, JSON.stringify({ input, error: errMsg, elapsed_ms: Date.now() - start })],
    );
    return { error: errMsg };
  }
}

function previewResult(r) {
  const s = JSON.stringify(r);
  return s.length > 4000 ? s.slice(0, 4000) + '…[truncated]' : r;
}
