// Limbo-batch recovery.
//
// If a payment_batch row gets to status='pending' but never has any
// payment_uploads written (process killed, deploy mid-flight, manual
// interruption), the refs in consumed_transactions stay locked forever and
// block future runs. This module finds those orphan batches and releases
// the locks.
//
// Real incident: 2026-06-04 morning. NMB batch 91c0fa9e locked 418 refs
// (6.679M TZS) when a --confirm got killed before the QB push loop. A
// subsequent run found 418 refs already-consumed and only pushed 10. The
// only way to recover was to manually DELETE FROM consumed_transactions
// + UPDATE the batch to rolled_back. We don't want to need a human for that.
//
// Policy:
//   - A batch with status='pending' AND created_at < now() - 15 min
//     AND zero payment_uploads rows is "abandoned in limbo".
//   - For each: release locks + mark rolled_back, no human ack needed.
//   - Run this on BRAIN startup AND expose at /api/admin/recover-limbo.

import { db } from './db/pool.js';
import { notifyAdmin } from './notifications.js';

const LIMBO_MIN_AGE_MS = 15 * 60 * 1000;

/**
 * Find and roll back limbo batches. Returns { recovered, totalRefsReleased }.
 * Optional `minAgeMs` overrides the default 15-minute threshold (useful for
 * tests or aggressive runs from a dashboard button).
 */
export async function recoverLimboBatches({ minAgeMs = LIMBO_MIN_AGE_MS } = {}) {
  const pool = db();
  // Find pending batches older than the threshold with zero uploads.
  const orphans = await pool.query(
    `SELECT pb.id, pb.idempotency_key, pb.channel, pb.created_at,
            COALESCE(pb.paid_count, 0) + COALESCE(pb.unused_count, 0) AS planned,
            (SELECT COUNT(*) FROM consumed_transactions ct WHERE ct.batch_id = pb.id) AS refs
       FROM payment_batches pb
       LEFT JOIN payment_uploads pu ON pu.batch_id = pb.id
      WHERE pb.status = 'pending'
        AND pb.created_at < now() - ($1::int * interval '1 millisecond')
      GROUP BY pb.id
     HAVING COUNT(pu.id) = 0`,
    [minAgeMs],
  );

  if (orphans.rows.length === 0) return { recovered: 0, totalRefsReleased: 0, batches: [] };

  const recovered = [];
  let totalRefsReleased = 0;
  const c = await pool.connect();
  try {
    for (const b of orphans.rows) {
      await c.query('BEGIN');
      const del = await c.query(
        `DELETE FROM consumed_transactions WHERE batch_id = $1 RETURNING bank_ref`,
        [b.id],
      );
      await c.query(
        `UPDATE payment_batches
            SET status = 'rolled_back',
                rolled_back_at = now(),
                failure_reason = 'auto-rollback by limbo-recovery: batch was pending with zero uploads'
          WHERE id = $1`,
        [b.id],
      );
      await c.query('COMMIT');
      totalRefsReleased += del.rowCount;
      recovered.push({
        id: b.id,
        idempotency_key: b.idempotency_key,
        channel: b.channel,
        age_minutes: Math.round((Date.now() - new Date(b.created_at).getTime()) / 60000),
        refs_released: del.rowCount,
        planned_count: Number(b.planned),
      });
      console.warn(`[limbo-recovery] released ${del.rowCount} refs from batch ${b.id} (${b.idempotency_key})`);
    }
  } catch (err) {
    try { await c.query('ROLLBACK'); } catch { /* ignore */ }
    console.error('[limbo-recovery] failed mid-sweep:', err);
    throw err;
  } finally {
    c.release();
  }

  if (recovered.length) {
    notifyAdmin({
      message:
        `BRAIN recovered ${recovered.length} limbo batch${recovered.length === 1 ? '' : 'es'} ` +
        `(${totalRefsReleased} refs released). Channels: ${[...new Set(recovered.map((r) => r.channel))].join(', ')}`,
      severity: 'warning',
      source: 'limbo-recovery',
    });
  }

  return { recovered: recovered.length, totalRefsReleased, batches: recovered };
}

/**
 * Mount /api/admin/recover-limbo (Supabase JWT) for a dashboard button.
 */
export function mountLimboRecoveryApi(app, { requireSupabaseJwt }) {
  app.post('/api/admin/recover-limbo', requireSupabaseJwt, async (req, res) => {
    try {
      const aggressive = req.body?.aggressive === true;
      const result = await recoverLimboBatches({
        minAgeMs: aggressive ? 60_000 : LIMBO_MIN_AGE_MS,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/admin/limbo-status', requireSupabaseJwt, async (req, res) => {
    try {
      const r = await db().query(
        `SELECT pb.id, pb.idempotency_key, pb.channel, pb.created_at,
                pb.paid_count + pb.unused_count AS planned,
                (SELECT COUNT(*) FROM consumed_transactions ct WHERE ct.batch_id = pb.id) AS refs_locked,
                (SELECT COUNT(*) FROM payment_uploads pu WHERE pu.batch_id = pb.id) AS uploads
           FROM payment_batches pb
          WHERE pb.status = 'pending'
          ORDER BY pb.created_at`,
      );
      res.json({ pending: r.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

/**
 * Run once on BRAIN boot (5 sec after startup so DB pool is warm). Logs to
 * console + SMS via notifyAdmin if anything was recovered.
 */
export function startLimboRecoveryOnBoot() {
  setTimeout(async () => {
    try {
      const r = await recoverLimboBatches();
      if (r.recovered > 0) {
        console.warn(`[limbo-recovery boot sweep] recovered=${r.recovered} refs_released=${r.totalRefsReleased}`);
      } else {
        console.log('[limbo-recovery boot sweep] no limbo batches found');
      }
    } catch (err) {
      console.error('[limbo-recovery boot sweep] error:', err.message);
    }
  }, 5000);
}
