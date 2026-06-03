// Autonomous Claude session runner.
//
// One call to runSession() = one whole agent run from spawn to end_session().
// Spawns Sonnet 4.6 with our tool kit, lets it think + call tools in a loop,
// persists everything to agent_sessions + agent_session_messages.
//
// Lifecycle:
//   1. Insert agent_sessions row (status='running')
//   2. Build initial messages: system (BRAIN_BRAIN.md + recent sessions tail)
//                              + user (trigger context)
//   3. Loop:
//        a. Call Claude (prompt-cache the system prompt + memory doc)
//        b. Persist assistant message
//        c. If stop_reason='end_turn' or no tool calls → exit loop
//        d. Dispatch each tool call, persist result
//        e. Append tool_result content blocks for next iteration
//        f. Stop if any tool set ctx.shouldHalt
//   4. Tally token usage → cost_usd
//   5. Mark session done (if end_session was called it already wrote summary;
//      otherwise mark errored with the last assistant text as summary).
//
// Cost-control rails:
//   - MAX_TURNS = 30  (safety brake; abort if loop runs away)
//   - MAX_OUTPUT_TOKENS per turn = 4096
//   - Prompt cache on system prompt: 90% cheaper to re-read between turns.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Anthropic from '@anthropic-ai/sdk';
import { TOOLS, dispatch } from './tools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const BRAIN_BRAIN = fs.readFileSync(path.join(__dirname, 'BRAIN_BRAIN.md'), 'utf8');

const MODEL = process.env.AGENT_MODEL || 'claude-sonnet-4-6';
const MAX_TURNS = 30;
const MAX_OUTPUT_TOKENS = 4096;
const RECENT_SESSIONS_TAIL = 5;

// Sonnet 4.6 pricing — keep in sync with anthropic.com/pricing
const PRICING = {
  'claude-sonnet-4-6': { in: 3, out: 15, cache_write: 3.75, cache_read: 0.30 },
  'claude-opus-4-7':   { in: 15, out: 75, cache_write: 18.75, cache_read: 1.50 },
  'claude-haiku-4-5':  { in: 1, out: 5, cache_write: 1.25, cache_read: 0.10 },
};

export async function runSession({ db, trigger, triggerContext, mode = 'execute', parentSessionId = null }) {
  if (!process.env.ANTHROPIC_API_KEY) {
    throw new Error('ANTHROPIC_API_KEY required for agent runner');
  }
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  // 1. Insert session row
  const sessionRow = await db.query(
    `INSERT INTO agent_sessions (trigger, trigger_context, mode, model, parent_session_id)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING id`,
    [trigger, JSON.stringify(triggerContext || {}), mode, MODEL, parentSessionId],
  );
  const sessionId = sessionRow.rows[0].id;

  const ctx = { db, sessionId, mode, shouldHalt: null };

  // 2. Pull recent session tail for context
  const recent = await db.query(
    `SELECT trigger, started_at, status, summary, stats
       FROM agent_sessions
      WHERE status IN ('completed','paused','errored') AND id <> $1
      ORDER BY started_at DESC
      LIMIT $2`,
    [sessionId, RECENT_SESSIONS_TAIL],
  );
  const recentSummary =
    recent.rows.length
      ? recent.rows.map(r =>
          `  • ${r.started_at.toISOString().slice(0,16)} [${r.trigger}] ${r.status}: ${r.summary || '(no summary)'}`
        ).join('\n')
      : '  (no prior sessions)';

  // Recent SMS inbox tail (last hour)
  const recentSms = await db.query(
    `SELECT received_at, from_number, message
       FROM sms_inbox
      WHERE received_at > now() - interval '24 hours'
      ORDER BY received_at DESC LIMIT 10`,
  );
  const smsTail = recentSms.rows.length
    ? recentSms.rows.reverse().map(r => `  ← ${r.received_at.toISOString().slice(0,16)} from ${r.from_number}: ${r.message}`).join('\n')
    : '  (no recent SMS)';

  // 3. Build initial messages
  const systemPrompt = [
    { type: 'text', text: BRAIN_BRAIN, cache_control: { type: 'ephemeral' } },
    { type: 'text', text: `# Recent session log (last ${RECENT_SESSIONS_TAIL})\n\n${recentSummary}\n\n# Recent SMS thread (24h)\n\n${smsTail}\n\n# Current mode\n\nmode=${mode}${mode === 'plan' ? ' (DRY-RUN: no QB writes, no SMSs sent)' : ''}\n` },
  ];
  const userMsg = `# Trigger\n\n**Source:** ${trigger}\n\n**Context:**\n\`\`\`json\n${JSON.stringify(triggerContext, null, 2)}\n\`\`\`\n\nProceed. Use tools. End the session with end_session when done.`;

  // Persist system + user
  await db.query(
    `INSERT INTO agent_session_messages (session_id, role, kind, payload) VALUES
       ($1, 'system', 'text', $2),
       ($1, 'user',   'text', $3)`,
    [sessionId, JSON.stringify({ system_prompt_len: BRAIN_BRAIN.length, recent_count: recent.rows.length }), JSON.stringify({ text: userMsg })],
  );

  let messages = [{ role: 'user', content: userMsg }];
  let totalIn = 0, totalOut = 0, cacheRead = 0, cacheWrite = 0;
  let turn = 0;
  let lastAssistantText = '';

  // 4. Main loop
  while (turn < MAX_TURNS && !ctx.shouldHalt) {
    turn++;
    let resp;
    try {
      resp = await client.messages.create({
        model: MODEL,
        max_tokens: MAX_OUTPUT_TOKENS,
        system: systemPrompt,
        tools: TOOLS,
        messages,
      });
    } catch (err) {
      await db.query(
        `UPDATE agent_sessions SET status='errored', error_text=$2, ended_at=now() WHERE id=$1`,
        [sessionId, String(err.message || err).slice(0, 1000)],
      );
      throw err;
    }

    // Tally usage
    totalIn      += resp.usage?.input_tokens || 0;
    totalOut     += resp.usage?.output_tokens || 0;
    cacheRead    += resp.usage?.cache_read_input_tokens || 0;
    cacheWrite   += resp.usage?.cache_creation_input_tokens || 0;

    // Persist assistant message
    await db.query(
      `INSERT INTO agent_session_messages (session_id, role, kind, payload) VALUES ($1, 'assistant', 'turn', $2)`,
      [sessionId, JSON.stringify({ turn, stop_reason: resp.stop_reason, content: resp.content, usage: resp.usage })],
    );

    // Extract last text for fallback summary
    for (const block of resp.content) {
      if (block.type === 'text' && block.text) lastAssistantText = block.text;
    }

    // Push assistant turn into history
    messages.push({ role: 'assistant', content: resp.content });

    // If no tool calls or natural stop → exit
    const toolUses = resp.content.filter(b => b.type === 'tool_use');
    if (toolUses.length === 0) break;
    if (resp.stop_reason !== 'tool_use' && resp.stop_reason !== 'end_turn') break;

    // Dispatch all tools in sequence (preserves order for the model)
    const toolResults = [];
    for (const tu of toolUses) {
      const result = await dispatch(tu.name, tu.input, ctx);
      toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) });
      if (ctx.shouldHalt) break;
    }
    messages.push({ role: 'user', content: toolResults });

    if (ctx.shouldHalt) break;
  }

  // 5. Cost + finalize
  const price = PRICING[MODEL] || PRICING['claude-sonnet-4-6'];
  const cost =
    (totalIn       * price.in)        / 1_000_000 +
    (totalOut      * price.out)       / 1_000_000 +
    (cacheRead     * price.cache_read)/ 1_000_000 +
    (cacheWrite    * price.cache_write)/1_000_000;

  // If end_session wasn't called explicitly, write a fallback summary
  const finalRow = await db.query(`SELECT status, summary FROM agent_sessions WHERE id=$1`, [sessionId]);
  if (finalRow.rows[0].status === 'running') {
    await db.query(
      `UPDATE agent_sessions
          SET status=$2, summary=$3, ended_at=now(), updated_at=now()
        WHERE id=$1`,
      [
        sessionId,
        turn >= MAX_TURNS ? 'aborted' : 'completed',
        (lastAssistantText || '(no summary written; loop ended without end_session call)').slice(0, 2000),
      ],
    );
  }
  await db.query(
    `UPDATE agent_sessions
        SET input_tokens=$2, output_tokens=$3, cache_read_tokens=$4, cache_write_tokens=$5, cost_usd=$6, updated_at=now()
      WHERE id=$1`,
    [sessionId, totalIn, totalOut, cacheRead, cacheWrite, cost.toFixed(4)],
  );

  return {
    sessionId,
    turns: turn,
    status: (await db.query(`SELECT status FROM agent_sessions WHERE id=$1`, [sessionId])).rows[0].status,
    tokens: { input: totalIn, output: totalOut, cache_read: cacheRead, cache_write: cacheWrite },
    cost_usd: Number(cost.toFixed(4)),
  };
}
