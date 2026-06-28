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
        range: { type: 'string', description: 'A1 notation, e.g. "PASSED!A1:H200000"' },
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
          enum: ['nmbnew', 'bank', 'iphone_bank', 'sav_nmb', 'sav_crdb'],
          description: 'nmbnew=NMB→QB, bank=CRDB→QB, iphone_bank=iPhone M-Pesa→QB, sav_nmb=SAVCOM NMB→Frappe, sav_crdb=SAVCOM CRDB→Frappe. SAV channels read PASSED_SAV sheets and push payments to Frappe (not QB) using elegansky.api.ingest_payment with explicit allocations from the V2 algorithm against Frappe open invoices.',
        },
        since_iso: {
          type: 'string',
          description: 'Window start in ISO 8601 UTC (EAT is UTC+3). OPTIONAL: omit when trigger context says mode_label=from_last — the server then defaults to (MAX(consumed_transactions.sheet_ts) + 1ms) for the channel, which is the operator-blessed semantics. DO NOT compute since_iso yourself from payment_batches.created_at or finalized_at — those are clock times, not bank-data times, and using them creates gaps that miss real rows.',
        },
        until_iso: {
          type: 'string',
          description: 'Window end in ISO 8601 UTC (exclusive). OPTIONAL: omit when trigger says mode_label=from_last — server defaults to now+60s. If you supply this, set it to current wall-clock UTC + ~1min so freshly-appended sheet rows are captured.',
        },
        as_of: {
          type: 'string',
          description: 'YYYY-MM-DD — controls which invoices are in the matching pool (DueDate <= as_of). The calendar day the BANK TXN HAPPENED. NOT the same as txn_date. See BRAIN_BRAIN.md "AS_OF rule" — independent from txn_date.',
        },
        txn_date: {
          type: 'string',
          description: 'YYYY-MM-DD — REQUIRED. The date written to QB as the Payment TxnDate. Determined by the scheduled tick name: ticks at or before 16:15 EAT → txn_date=execution day; ticks after 16:15 EAT → txn_date=next day. INDEPENDENT from as_of: as_of is when the customer actually paid, txn_date is when the bookkeeper records it. Auto-upload endpoint returns 400 if omitted — wall-clock fallback was removed 2026-06-07.',
        },
        tick_name: {
          type: 'string',
          description: 'The scheduler tick name that triggered this fire — pull from your trigger_context.tick (e.g. "meru0300", "kili1615", "mawenzi1800"). Used by the auto-upload endpoint to paint the last processed sheet row purple + write "end of {tick_name}" to Column K as a visual end-of-window marker. Defaults to "heisenberg" if omitted (= manual button-fired run).',
        },
      },
      required: ['channel', 'as_of', 'txn_date'],
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
        // since_iso/until_iso are OPTIONAL — if omitted, the auto-upload
        // endpoint applies the from_last sheet-time default (Frank's rule
        // from 2026-06-04). Only include them when truly explicit.
        const body = {
          ...(input.since_iso ? { since_iso: input.since_iso } : {}),
          ...(input.until_iso ? { until_iso: input.until_iso } : {}),
          as_of: input.as_of,
          txn_date: input.txn_date,
          dry_run: ctx.mode === 'plan',
          tick_name: input.tick_name || 'heisenberg',
        };
        // SAV channels go through the Frappe-end-to-end pipeline (separate
        // endpoint, separate runner, sacred V2 algorithm preserved). QB
        // channels stay on the existing /auto-upload path.
        const isFrappeChannel = ['sav_nmb', 'sav_crdb'].includes(input.channel);
        const endpoint = isFrappeChannel
          ? `${base}/api/payment-batches/auto-upload-frappe/${encodeURIComponent(input.channel)}`
          : `${base}/api/payment-batches/auto-upload/${encodeURIComponent(input.channel)}`;
        const r = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-Report-Secret': secret },
          body: JSON.stringify(body),
          // 600s (10 min) — enough headroom for the FIRST fire of a session
          // when none of the perf caches (arrears 12k, QB dup-scan 60-day) are
          // warm. Subsequent fires within 5 min hit the cache and finish in
          // 15-30s. Before bumping this, the agent timed out at 180s and
          // retried 3× getting 409 lock conflicts while the server job
          // genuinely was still processing (Frank case 2026-06-07T16:40Z).
          signal: AbortSignal.timeout(600_000),
        });
        const j = await r.json().catch(async () => ({ error: 'non-json response', body: (await r.text()).slice(0, 500) }));
        if (!r.ok) {
          result = { error: `auto-upload ${r.status}`, detail: j };
        } else {
          // Summarise so the model doesn't blow context on raw response.
          // The server uses different field names for dry-run vs real-run:
          //   dry-run:  paid_planned, unused_planned, sheet_sum
          //   real-run: paid_count, unused_count (eventually finalized)
          result = {
            mode: ctx.mode,
            channel: input.channel,
            window: { since: input.since_iso, until: input.until_iso, as_of: input.as_of, txn_date: input.txn_date || null },
            batch_id: j.batch_id || null,
            skipped: !!j.skipped,
            skipped_reason: j.skipped ? (j.reason || null) : null,
            // Read both shapes — server is inconsistent. Dry-run uses
            // *_planned fields and sheet_sum; finalized real-runs use
            // *_count / *_total.
            paid_count: j.paid_planned ?? j.paid?.length ?? j.paid_count ?? null,
            paid_total: j.paid_total ?? null,
            unused_count: j.unused_planned ?? j.unused?.length ?? j.unused_count ?? null,
            unused_total: j.unused_total ?? null,
            sheet_total: j.sheet_sum ?? j.sheet_total ?? null,
            // Surface row-skip diagnostics when the server skipped a window
            // with no rows — lets the operator see exactly why (K boundary,
            // out-of-window dates, etc.).
            skip_diagnostics: j.skipped ? {
              skipped_no_date: j.skipped_no_date ?? null,
              skipped_bad_format: j.skipped_bad_format ?? null,
              skipped_out_of_window: j.skipped_out_of_window ?? null,
              skipped_already_pushed: j.skipped_already_pushed ?? null,
              max_k_row: j.max_k_row ?? null,
              sheet_total_rows: j.sheet_total_rows ?? null,
            } : null,
            reconciles: (j.sheet_sum ?? j.sheet_total) != null && j.paid_total != null && j.unused_total != null
              ? Math.abs(Number(j.sheet_sum ?? j.sheet_total) - (Number(j.paid_total) + Number(j.unused_total))) < 0.01
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
