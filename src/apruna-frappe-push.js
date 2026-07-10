// ───────────────────────────────────────────────────────────────────────────
// APRUNA dual-write to Frappe (post-QB-Payment hook)
//
// Frank + Frappe engineer 2026-07-10 agreement:
//   - QB stays frozen for old rows (boss's rule: never write to live QB).
//   - Every payment BRAIN pushes on nmbnew/bank for an APRUNA-migrated
//     customer ALSO goes to Frappe as system-of-record.
//   - Matching is exact 1:1 by qb_id — 217/217 APRUNA customers carry qb_id
//     so no plate/wakandi/name fuzz.
//   - txn_id is the sheet bank_ref — Frappe uses it as the idempotency key,
//     so retries never double-post.
//
// MVP scope (2026-07-10):
//   * No allocations sent → payment lands as unapplied credit on Frappe side.
//     Frappe engineer allocates manually for the first test payment; batch
//     allocation support is a follow-up once the flow is proven end-to-end.
//   * Zero touch to existing nmbnew/bank/QB pipeline. This module is called
//     AFTER the batch's QB Payments finalize (fire-and-forget from BRAIN's
//     perspective; Frappe write failure is logged but does NOT roll back QB).
//   * Zero touch to SAVCOM. sav_nmb/sav_crdb channels never enter this path.
// ───────────────────────────────────────────────────────────────────────────

import { db } from './db/pool.js';
import { resolveAprunaByQbId } from './apruna-resolver.js';
import { ingestPayment } from './frappe-client.js';

/** Map an auto-upload channel to the Frappe mode_of_payment tag. */
function modeForChannel(channel) {
  if (channel === 'nmbnew') return 'NMB';
  if (channel === 'bank') return 'CRDB';
  if (channel === 'iphone_bank') return 'iPhone';
  return 'Cash';
}

/**
 * Fire APRUNA dual-writes for every finalized paid row in `batchId`.
 * Returns a summary — pushed / matched / skipped / errored counts + a small
 * per-row detail sample so the caller can log it.
 *
 * The batch's txn_date is used as the Frappe payment posting date so the
 * kili1615 cutline rule is respected on the Frappe side too.
 *
 * Safe to call multiple times for the same batch: Frappe dedupes by txn_id
 * (bank_ref), so a duplicate call returns { status: 'duplicate' } which we
 * treat as success.
 */
export async function pushAprunaForBatch(batchId, { dryRun = false } = {}) {
  const batchRes = await db().query(
    `SELECT id::text, channel, status, txn_date FROM payment_batches WHERE id = $1`,
    [batchId],
  );
  const batch = batchRes.rows[0];
  if (!batch) throw new Error(`batch ${batchId} not found`);
  if (batch.status !== 'finalized') {
    return {
      batch_id: batchId, skipped: true,
      reason: `batch status = ${batch.status}, only finalized batches dual-write`,
    };
  }
  if (!['nmbnew', 'bank', 'iphone_bank'].includes(batch.channel)) {
    return {
      batch_id: batchId, skipped: true,
      reason: `channel ${batch.channel} not in APRUNA dual-write set (nmbnew/bank/iphone_bank only)`,
    };
  }
  const mode = modeForChannel(batch.channel);
  const dateStr = batch.txn_date instanceof Date
    ? batch.txn_date.toISOString().slice(0, 10)
    : String(batch.txn_date).slice(0, 10);

  // Pull the paid uploads for this batch.
  const upsRes = await db().query(
    `SELECT id::text, bank_ref, customer_id, customer_name, amount, qb_id
       FROM payment_uploads
      WHERE batch_id = $1 AND kind = 'paid' AND status = 'finalized' AND amount > 0`,
    [batchId],
  );

  let matched = 0, unmatched = 0, pushed = 0, duplicate = 0, errored = 0;
  const details = []; // {upload_id, bank_ref, qb_id, outcome, msg}
  const sampleCap = 25;

  for (const u of upsRes.rows) {
    const qbId = u.customer_id ? String(u.customer_id) : null;
    if (!qbId) { unmatched++; continue; }
    const apruna = await resolveAprunaByQbId(qbId);
    if (!apruna) { unmatched++; continue; }
    matched++;

    if (dryRun) {
      if (details.length < sampleCap) {
        details.push({
          upload_id: u.id, bank_ref: u.bank_ref, qb_id: qbId,
          apruna_customer: apruna.customer || apruna.display_name,
          amount: Number(u.amount), date: dateStr, mode,
          outcome: '(dry_run)',
        });
      }
      continue;
    }

    // Frappe accepts either the qb_id or the customer name — send the
    // Frappe customer key when we have it (unambiguous), fall back to
    // qb_id (which _resolve_customer maps via eg_qb_id).
    const customerKey = apruna.customer || qbId;
    try {
      const resp = await ingestPayment({
        customer: customerKey,
        amount: Number(u.amount),
        date: dateStr,
        txn_id: String(u.bank_ref),
        mode_of_payment: mode,
        // No allocations for MVP — payment lands as unapplied credit on Frappe.
      });
      const status = resp?.status || 'ok';
      if (status === 'duplicate') duplicate++;
      else pushed++;
      if (details.length < sampleCap) {
        details.push({
          upload_id: u.id, bank_ref: u.bank_ref, qb_id: qbId,
          apruna_customer: customerKey,
          amount: Number(u.amount), date: dateStr, mode,
          outcome: status,
        });
      }
    } catch (err) {
      errored++;
      const msg = String(err.message || err).slice(0, 300);
      if (details.length < sampleCap) {
        details.push({
          upload_id: u.id, bank_ref: u.bank_ref, qb_id: qbId,
          outcome: 'error', error: msg,
        });
      }
      console.error(`[apruna-push] batch=${batchId} ref=${u.bank_ref} qb_id=${qbId}: ${msg}`);
    }
  }

  const summary = {
    batch_id: batchId, channel: batch.channel, txn_date: dateStr, mode,
    dry_run: dryRun,
    uploads: upsRes.rows.length,
    matched_apruna: matched,
    unmatched: unmatched,
    pushed_new: pushed,
    duplicate_skipped: duplicate,
    errored,
    details,
  };

  // Append summary to the batch's logs for reconciliation (fire-and-forget).
  if (!dryRun) {
    try {
      await db().query(
        `UPDATE payment_batches
            SET logs = COALESCE(logs, '[]'::jsonb) || $2::jsonb
          WHERE id = $1`,
        [batchId, JSON.stringify([{
          ts: new Date().toISOString(),
          level: matched === 0 ? 'info' : (errored ? 'warn' : 'info'),
          source: 'apruna-dual-write',
          message: matched === 0
            ? 'no APRUNA-matched rows in batch'
            : `APRUNA dual-write: matched=${matched} pushed=${pushed} duplicate=${duplicate} errored=${errored}`,
          matched, pushed, duplicate, errored,
        }])],
      );
    } catch (e) {
      console.error(`[apruna-push] failed to append batch log: ${e.message}`);
    }
  }

  return summary;
}
