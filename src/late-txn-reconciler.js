// ───────────────────────────────────────────────────────────────────────────
// Late-transaction reconciler — Frank 2026-07-19
//
// Problem: when a bank statement scrape is missed and the txn is finally
// captured DAYS later, allocating it with as_of=today misattributes it to
// whatever's newest in arrears. That creates customer conflict — the
// customer says "I paid on the 15th" but the system shows the 15th unpaid
// and (say) the 18th paid.
//
// Fix: whenever an incoming txn has a sheet-date DAY earlier than the fire's
// as_of, run this reconciler:
//
//   1. Find all Payments/Reversals for that customer made AFTER late-txn day
//   2. Void them (QB → qbVoid, Frappe → reversePayment)
//   3. Delete consumed_transactions so refs become eligible again
//   4. Sort ALL affected txns by sheet-date ASC
//   5. Replay each with as_of = its OWN day
//        - QB customer → newest-first + forward-pay (existing V2)
//        - Frappe customer → today-first + oldest-arrears + forward (APRUNA style)
//   6. Push each replayed payment with TxnDate = today's window (books rule)
//
// TWO date concepts:
//   as_of    = txn's own day (what invoices existed at that time)
//   TxnDate  = today's window (which books to land in — books rule stays)
//
// This module intentionally has NO auto-fire wiring. It exposes pure
// functions + one orchestrator (`reconcileCustomer`). The API layer
// (payment-batches.js) mounts POST /api/admin/late-txn-reconcile which
// takes a bank_ref/channel/customer_id and runs the flow.
// ───────────────────────────────────────────────────────────────────────────

import { db } from './db/pool.js';
import { qbQuery, qbPost } from './qb-client.js';
import { reversePayment } from './frappe-client.js';

// Inline copy of server.js's qbVoid — kept here so the reconciler doesn't
// need a runtime dependency injection just for the void step.
async function qbVoidInline({ kind, qbId }) {
  const entityName = kind === 'payment' ? 'Payment' : 'CreditMemo';
  const q = await qbQuery(`SELECT * FROM ${entityName} WHERE Id = '${qbId}'`);
  const entity = q.QueryResponse?.[entityName]?.[0];
  if (!entity) return { alreadyGone: true, qbId };
  const body = { Id: entity.Id, SyncToken: entity.SyncToken };
  const path = kind === 'payment' ? 'payment?operation=delete' : 'creditmemo?operation=delete';
  return await qbPost(path, body);
}

/**
 * APRUNA-style Frappe allocation: TODAY → oldest ARREARS → oldest FORWARD.
 *
 * Byte-identical to `foldAllocations` in apruna-divert.js (kept here to
 * avoid a cross-file import dependency in the reconciler test surface).
 * Only difference: returns richer trace for the endpoint's JSON output.
 */
export function foldFrappeAllocations(openInvoices, amount, physicalDay) {
  const all = (openInvoices || []).filter((x) => Number(x.outstanding_amount || 0) > 0);
  const today = all.filter((x) => (x.posting_date || '') === physicalDay)
    .sort((a, b) => String(a.name).localeCompare(String(b.name)));
  const arrears = all.filter((x) => (x.posting_date || '') < physicalDay)
    .sort((a, b) => (a.posting_date || '').localeCompare(b.posting_date || '')
      || String(a.name).localeCompare(String(b.name)));
  const forward = all.filter((x) => (x.posting_date || '') > physicalDay)
    .sort((a, b) => (a.posting_date || '').localeCompare(b.posting_date || '')
      || String(a.name).localeCompare(String(b.name)));
  const ordered = [...today, ...arrears, ...forward];
  let remain = amount;
  const plan = [];
  for (const iv of ordered) {
    if (remain <= 0) break;
    const out = Number(iv.outstanding_amount || 0);
    if (out <= 0) continue;
    const alloc = Math.min(remain, out);
    plan.push({
      reference_doctype: 'Sales Invoice',
      reference_name: iv.name,
      posting_date: iv.posting_date,
      allocated_amount: alloc,
      bucket: (iv.posting_date === physicalDay) ? 'today'
        : (iv.posting_date < physicalDay ? 'arrear' : 'forward'),
    });
    remain -= alloc;
  }
  return { plan, remain };
}

/** EAT day (UTC+3, no DST) from a Date/ms/ISO string. */
export function eatDayOf(input) {
  const d = input instanceof Date ? input
    : (typeof input === 'number' ? new Date(input) : new Date(String(input)));
  const eat = new Date(d.getTime() + 3 * 3600 * 1000);
  return eat.toISOString().slice(0, 10);
}

/**
 * Given a customer + a "since day" (YYYY-MM-DD in EAT), find every
 * created payment_uploads row whose parent batch was created AFTER
 * that day. Those are the payments to void + replay.
 *
 * Returns: [{ id, bank_ref, kind, qb_id, amount, invoice_no, customer_name,
 *             channel, created_at, batch_id, sheet_row_number, memo }, ...]
 *
 * Scope: only status='created' rows (already voided / failed rows are
 * skipped). Kind: 'payment' AND 'credit_memo' (both get voided).
 */
export async function findAffectedPayments({ customerId, sinceDay, customerName }) {
  const params = [];
  // 2026-07-24 (Frank: "the whole books need retro"): include SAV/Frappe
  // pushes — their live status is 'pushed_to_frappe', not 'created'.
  const where = [`pu.status IN ('created','pushed_to_frappe')`];
  if (customerId) {
    params.push(customerId);
    where.push(`pu.customer_id = $${params.length}`);
  } else if (customerName) {
    params.push(customerName);
    where.push(`pu.customer_name = $${params.length}`);
  } else {
    throw new Error('customerId or customerName required');
  }
  params.push(sinceDay);
  where.push(`(pu.created_at AT TIME ZONE 'Africa/Dar_es_Salaam')::date > $${params.length}::date`);
  // Session guard (Frank 2026-07-24): never void a payment pushed in the
  // last 20 minutes — that's this session's own replay/push work. Without
  // this, multi-window sessions re-void earlier windows' replays (SULTANI
  // was reconciled 3× in one session on 07-24).
  where.push(`pu.created_at < now() - interval '20 minutes'`);
  const q = await db().query(
    `SELECT pu.id, pu.bank_ref, pu.kind, pu.qb_id, pu.amount, pu.invoice_no,
            pu.customer_name, pu.customer_id, pb.channel,
            pu.created_at, pu.batch_id
       FROM payment_uploads pu
       JOIN payment_batches pb ON pb.id = pu.batch_id
      WHERE ${where.join(' AND ')}
      ORDER BY pu.created_at`,
    params,
  );
  return q.rows;
}

/**
 * Void one payment. QB channels → qbVoid, Frappe channels → reversePayment.
 * Returns { ok, kind, id, error? } — best-effort per row.
 */
export async function voidOne(pu) {
  const isFrappe = /sav_|frappe|apruna/i.test(String(pu.channel || ''));
  try {
    if (isFrappe) {
      // SAV pipeline ingests with txn_id = <suffixed_ref> + 'V'
      // (FRAPPE_TXN_MARKER); apruna diverts ingest with the BARE ref.
      const isSav = /^sav_/i.test(String(pu.channel || ''));
      const txnId = isSav
        ? String(pu.bank_ref || '') + 'V'
        : String(pu.bank_ref || '').replace(/(NS|CS|[NBP])$/, '');
      const r = await reversePayment(txnId);
      return { ok: true, kind: 'frappe_reverse', pu_id: pu.id, txn_id: txnId, response: r };
    }
    if (!pu.qb_id) return { ok: false, kind: 'qb_void', pu_id: pu.id, error: 'no qb_id on upload row' };
    await qbVoidInline({ kind: pu.kind === 'credit_memo' ? 'credit_memo' : 'payment', qbId: pu.qb_id });
    return { ok: true, kind: 'qb_void', pu_id: pu.id, qb_id: pu.qb_id };
  } catch (err) {
    return { ok: false, kind: isFrappe ? 'frappe_reverse' : 'qb_void', pu_id: pu.id, error: String(err.message || err) };
  }
}

/**
 * Preview + optionally execute the retro-reconcile for one customer +
 * one late txn day. Does NOT push new payments — that's the caller's job
 * (the auto-upload pipeline handles it after this leaves the sheet refs
 * eligible again).
 *
 * Body:
 *   { customerId?, customerName?, sinceDay: 'YYYY-MM-DD',
 *     dryRun: true | false (default true) }
 *
 * Returns:
 *   { affected_payments: [...], void_results: [...],
 *     consumed_rows_deleted: N, ready_to_replay_refs: [...] }
 */
export async function reconcileCustomer({ customerId, customerName, sinceDay, dryRun = true }) {
  if (!sinceDay || !/^\d{4}-\d{2}-\d{2}$/.test(String(sinceDay))) {
    throw new Error('sinceDay YYYY-MM-DD required');
  }
  const affected = await findAffectedPayments({ customerId, sinceDay, customerName });
  const out = {
    inputs: { customerId, customerName, sinceDay, dryRun },
    affected_count: affected.length,
    affected_payments: affected,
    void_results: [],
    consumed_rows_deleted: 0,
    ready_to_replay_refs: [],
  };
  if (dryRun || affected.length === 0) return out;

  // Void each unique payment (dedupe by qb_id or bank_ref since a single
  // QB Payment can span multiple payment_uploads rows).
  const seenKey = new Set();
  const keyOk = new Map(); // dedupe key -> void succeeded in QB/Frappe
  for (const pu of affected) {
    const key = pu.qb_id || pu.bank_ref;
    if (seenKey.has(key)) continue;
    seenKey.add(key);
    const r = await voidOne(pu);
    out.void_results.push(r);
    keyOk.set(key, r.ok === true);
  }

  // SAFETY (2026-07-22): a ref may only be cleared for replay when EVERY
  // payment on it voided successfully. Clearing a ref whose void failed
  // re-pushes the txn while the old payment is still live in QB — that is
  // exactly how the 2026-07-19 test run minted duplicate payments. Failed
  // voids keep their consumed rows: the late txn stays unused (safe,
  // pre-retro behavior) and the fire log carries a VOID FAILURE line.
  const failedRows = affected.filter((p) => keyOk.get(p.qb_id || p.bank_ref) !== true);
  const failedRefs = new Set(failedRows.map((p) => p.bank_ref));
  const clearRows = affected.filter((p) => !failedRefs.has(p.bank_ref));
  if (failedRows.length) {
    out.void_failures = failedRows.map((p) => ({ id: p.id, qb_id: p.qb_id, bank_ref: p.bank_ref }));
    console.error(
      `[retro-reconcile] VOID FAILURE ${customerName || customerId}: ${failedRows.length}/${affected.length} row(s) kept consumed (no replay) — refs: ${[...failedRefs].join(',')}`,
    );
  }

  // Clear consumed_transactions for the fully-voided refs so they can flow
  // through the puller/upload path again, and mark their payment_uploads
  // rows voided — in ONE transaction so a crash can't clear a ref without
  // recording the void (the other half of the 07-19 burn).
  const bareRefs = Array.from(new Set(clearRows.map((p) => String(p.bank_ref || '').replace(/[NBP]$/, '')).filter(Boolean)));
  const suffixedRefs = Array.from(new Set(clearRows.map((p) => p.bank_ref).filter(Boolean)));
  const puIds = clearRows.map((p) => p.id);
  const client = await db().connect();
  try {
    await client.query('BEGIN');
    if (suffixedRefs.length) {
      const del = await client.query(
        `DELETE FROM consumed_transactions
          WHERE bank_ref = ANY($1::text[]) OR bank_ref = ANY($2::text[])
          RETURNING bank_ref, sheet_ts`,
        [bareRefs, suffixedRefs],
      );
      out.consumed_rows_deleted = del.rowCount || 0;
      // Preserve each released ref's SHEET timestamp — the replay engine
      // derives AS_OF from the PHYSICAL day (sheet ts), never from the
      // kili payment date (Frank's dual-date law, 2026-07-24).
      out.released_sheet_ts = {};
      for (const row of del.rows) out.released_sheet_ts[row.bank_ref] = row.sheet_ts;
    }
    if (puIds.length) {
      await client.query(
        `UPDATE payment_uploads
            SET status = 'voided',
                voided_at = now(),
                failure_reason = COALESCE(failure_reason, '') || ' | retro-reconcile ' || now()::text
          WHERE id = ANY($1::uuid[])`,
        [puIds],
      );
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  } finally {
    client.release();
  }
  out.ready_to_replay_refs = suffixedRefs;

  return out;
}

/**
 * Mount the admin API surface for manual reconcile testing.
 *
 *   POST /api/admin/late-txn-reconcile
 *   Body: { customer_id?, customer_name?, since_day: 'YYYY-MM-DD',
 *           dry_run: true|false (default true) }
 *   Auth: X-Report-Secret
 *
 *   GET  /api/admin/late-txn-reconcile/probe
 *   Query: ?customer_name=<name>&as_of=YYYY-MM-DD
 *   Preview: what would allocation look like for a hypothetical payment
 *   at that as_of, using the Frappe APRUNA-style rules? Read-only.
 */
export function mountLateTxnReconcilerApi(app, { requireSecretOrJwt }) {
  app.post('/api/admin/late-txn-reconcile', requireSecretOrJwt, async (req, res) => {
    try {
      const customerId = req.body?.customer_id || null;
      const customerName = req.body?.customer_name || null;
      const sinceDay = String(req.body?.since_day || '').trim();
      const dryRun = req.body?.dry_run !== false; // default TRUE for safety
      if (!customerId && !customerName) {
        return res.status(400).json({ error: 'customer_id or customer_name required' });
      }
      const result = await reconcileCustomer({ customerId, customerName, sinceDay, dryRun });
      res.json(result);
    } catch (err) {
      console.error('[POST /api/admin/late-txn-reconcile]', err);
      res.status(500).json({ error: err.message });
    }
  });
}

// ─── REPLAY ENGINE (Frank spec, 2026-07-24 — the dual-date chronological replay) ───
//
// Input: released refs with their sheet timestamps + original payment dates.
// For each customer, payments replay in strict sheet-time order:
//   - AS_OF        = the payment's PHYSICAL day (EAT day of its sheet ts) —
//                    NEVER derived from the payment date.
//   - Payment date = its ORIGINAL kili-adjusted date, unchanged.
//   - Allocation   = live open invoices, sacred walk: due-today (as_of) →
//                    arrears ASC → forward ASC. Partial fills stay open for
//                    the next payment; leftover money spills forward.
//   - Remainder with no open invoice → unapplied payment (existing rule).
// Every replay is recorded in payment_uploads + consumed_transactions under
// a dedicated retro-replay batch so dedup holds forever.
const REPLAY_DEPOSIT_ACCT = process.env.QB_DEFAULT_DEPOSIT_ACCT_ID || '785';

function eatPhysicalDay(ts) {
  const d = ts instanceof Date ? ts : new Date(ts);
  return new Date(d.getTime() + 3 * 3600_000).toISOString().slice(0, 10);
}

async function qbOpenInvoices(customerId) {
  const r = await qbQuery(
    `SELECT Id, Balance, DueDate FROM Invoice WHERE CustomerRef = '${customerId}' AND Balance > '0' MAXRESULTS 1000`,
  );
  return (r.QueryResponse?.Invoice || []).map((iv) => ({
    id: String(iv.Id), balance: Number(iv.Balance || 0), due: String(iv.DueDate || ''),
  }));
}

function sacredWalk(invoices, asOfDay) {
  const today = invoices.filter((iv) => iv.due === asOfDay).sort((a, b) => a.id.localeCompare(b.id));
  const arrears = invoices.filter((iv) => iv.due < asOfDay).sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
  const forward = invoices.filter((iv) => iv.due > asOfDay).sort((a, b) => a.due.localeCompare(b.due) || a.id.localeCompare(b.id));
  return [...today, ...arrears, ...forward];
}

/**
 * replayBucket(items, { batchTag }) — items: [{ bank_ref, sheet_ts,
 * customer_id, customer_name, channel, amount, payment_date }]
 * Returns { replayed, failed, unapplied, details }.
 */
export async function replayBucket(items, { batchTag = 'retro-replay' } = {}) {
  const out = { replayed: 0, failed: 0, unapplied: 0, details: [] };
  if (!items || !items.length) return out;

  // one batch row per engine invocation
  const idem = `retro-replay-${new Date().toISOString().slice(0, 10)}-${Math.random().toString(36).slice(2, 8)}`;
  const ins = await db().query(
    `INSERT INTO payment_batches (idempotency_key, status, sheet_id, sheet_tab, channel, bank_refs,
       sheet_total, paid_total, unused_total, paid_count, unused_count, created_by, txn_date)
     VALUES ($1,'pending','','','retro_replay',ARRAY[]::text[],0,0,0,0,0,$2,now()::date) RETURNING id`,
    [idem, `retro-replay:${batchTag}`],
  );
  const batchId = ins.rows[0].id;

  // group by customer, replay chronologically inside each
  const byCustomer = new Map();
  for (const it of items) {
    const k = it.customer_id || it.customer_name;
    if (!byCustomer.has(k)) byCustomer.set(k, []);
    byCustomer.get(k).push(it);
  }
  let paidTotal = 0, paidCount = 0;
  for (const [, list] of byCustomer.entries()) {
    list.sort((a, b) => new Date(a.sheet_ts).getTime() - new Date(b.sheet_ts).getTime());
    for (const it of list) {
      const asOf = eatPhysicalDay(it.sheet_ts);
      const payDate = it.payment_date;
      if (/sav_|frappe|apruna/i.test(String(it.channel || ''))) {
        out.failed++; out.details.push({ ref: it.bank_ref, error: 'frappe-channel — QB replay path not applicable' });
        console.error(`[replay-engine] SKIP ${it.bank_ref}: frappe channel '${it.channel}' — SAV replay engine pending`);
        continue;
      }
      if (!it.customer_id || !/^\d+$/.test(String(it.customer_id))) {
        out.failed++; out.details.push({ ref: it.bank_ref, error: 'no numeric customer_id' });
        console.error(`[replay-engine] SKIP ${it.bank_ref}: unresolvable customer_id '${it.customer_id}'`);
        continue;
      }
      try {
        let remain = Number(it.amount);
        const invoices = sacredWalk(await qbOpenInvoices(it.customer_id), asOf);
        const made = [];
        for (const iv of invoices) {
          if (remain <= 0) break;
          const alloc = Math.min(remain, iv.balance);
          if (alloc <= 0) continue;
          const body = {
            CustomerRef: { value: String(it.customer_id) }, TotalAmt: alloc,
            PrivateNote: it.bank_ref, TxnDate: payDate,
            DepositToAccountRef: { value: REPLAY_DEPOSIT_ACCT },
            Line: [{ Amount: alloc, LinkedTxn: [{ TxnId: iv.id, TxnType: 'Invoice' }] }],
          };
          const json = await qbPost('payment', body);
          made.push({ qb_id: String(json.Payment?.Id), amount: alloc, invoice: iv.id });
          remain -= alloc;
        }
        if (remain > 0) {
          const json = await qbPost('payment', {
            CustomerRef: { value: String(it.customer_id) }, TotalAmt: remain,
            PrivateNote: it.bank_ref, TxnDate: payDate,
            DepositToAccountRef: { value: REPLAY_DEPOSIT_ACCT },
          });
          made.push({ qb_id: String(json.Payment?.Id), amount: remain, invoice: null });
          out.unapplied++;
          remain = 0;
        }
        // bookkeeping: uploads + consumed (transactional)
        const client = await db().connect();
        try {
          await client.query('BEGIN');
          for (const m of made) {
            await client.query(
              `INSERT INTO payment_uploads (batch_id, kind, bank_ref, customer_id, customer_name,
                 invoice_qb_id, amount, memo, qb_id, status)
               VALUES ($1,'payment',$2,$3,$4,$5,$6,$2,$7,'created')`,
              [batchId, it.bank_ref, it.customer_id, it.customer_name, m.invoice, m.amount, m.qb_id],
            );
          }
          await client.query(
            `INSERT INTO consumed_transactions (bank_ref, batch_id, sheet_ts) VALUES ($1,$2,$3)
             ON CONFLICT DO NOTHING`,
            [it.bank_ref, batchId, it.sheet_ts],
          );
          await client.query('COMMIT');
        } catch (e2) { await client.query('ROLLBACK'); throw e2; } finally { client.release(); }
        paidCount += made.length; paidTotal += Number(it.amount);
        out.replayed++;
        console.log(`[replay-engine] ${it.bank_ref} ${it.customer_name} ${it.amount} → ${made.length} payment(s), as_of=${asOf}, date=${payDate}`);
      } catch (err) {
        out.failed++;
        out.details.push({ ref: it.bank_ref, error: String(err.message || err).slice(0, 200) });
        console.error(`[replay-engine] REPLAY FAILURE ${it.bank_ref} ${it.customer_name}: ${err.message}`);
      }
    }
  }
  await db().query(
    `UPDATE payment_batches SET status='finalized', finalized_at=now(), paid_count=$2, paid_total=$3 WHERE id=$1`,
    [batchId, paidCount, paidTotal],
  );
  console.log(`[replay-engine] bucket done: replayed=${out.replayed} failed=${out.failed} unapplied=${out.unapplied} batch=${batchId}`);
  return out;
}
