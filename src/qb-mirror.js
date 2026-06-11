// QB → Postgres mirror.
//
// One module, three jobs:
//   1. backfillEntity('Invoice'|'Payment') — initial full pull, paginated.
//   2. cdcSync('Invoice'|'Payment')        — incremental delta since high-water mark.
//   3. upsertInvoice / upsertPayment       — single-row mutators, used by
//                                            webhooks too.
//
// Mirror tables: qb_invoices, qb_payments, qb_payment_lines, qb_mirror_state.
// High-water mark: qb_mirror_state.last_cdc_at per entity.

import { db } from './db/pool.js';
import { qbQuery } from './qb-client.js';

const PAGE = 1000;
// CDC overlap: ask for everything changed since (last_cdc_at - this much) on
// every poll. Absorbs clock skew between QB and our DB and re-anchors after
// a missed minute. 5 min is conservative; can lower once stable.
const CDC_OVERLAP_MS = 5 * 60 * 1000;

// ── Upserts ──────────────────────────────────────────────────────────────

export async function upsertInvoice(inv, client = db()) {
  const lastUpdated = inv.MetaData?.LastUpdatedTime || null;
  await client.query(
    `INSERT INTO qb_invoices
       (id, customer_id, txn_date, due_date, total_amt, balance,
        doc_number, sync_token, qb_last_updated, mirror_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9, now())
     ON CONFLICT (id) DO UPDATE SET
       customer_id      = EXCLUDED.customer_id,
       txn_date         = EXCLUDED.txn_date,
       due_date         = EXCLUDED.due_date,
       total_amt        = EXCLUDED.total_amt,
       balance          = EXCLUDED.balance,
       doc_number       = EXCLUDED.doc_number,
       sync_token       = EXCLUDED.sync_token,
       qb_last_updated  = EXCLUDED.qb_last_updated,
       mirror_synced_at = now()`,
    [
      String(inv.Id),
      String(inv.CustomerRef?.value || ''),
      inv.TxnDate,
      inv.DueDate || null,
      Number(inv.TotalAmt || 0),
      Number(inv.Balance ?? inv.TotalAmt ?? 0),
      inv.DocNumber || null,
      inv.SyncToken || null,
      lastUpdated,
    ],
  );
}

export async function upsertPayment(payment, client = db()) {
  const lastUpdated = payment.MetaData?.LastUpdatedTime || null;
  await client.query(
    `INSERT INTO qb_payments
       (id, customer_id, txn_date, total_amt, sync_token,
        qb_last_updated, mirror_synced_at)
     VALUES ($1,$2,$3,$4,$5,$6, now())
     ON CONFLICT (id) DO UPDATE SET
       customer_id      = EXCLUDED.customer_id,
       txn_date         = EXCLUDED.txn_date,
       total_amt        = EXCLUDED.total_amt,
       sync_token       = EXCLUDED.sync_token,
       qb_last_updated  = EXCLUDED.qb_last_updated,
       mirror_synced_at = now()`,
    [
      String(payment.Id),
      String(payment.CustomerRef?.value || ''),
      payment.TxnDate,
      Number(payment.TotalAmt || 0),
      payment.SyncToken || null,
      lastUpdated,
    ],
  );
  // Replace lines wholesale — simplest correct semantics. SyncToken handling
  // and partial updates are unnecessary because the mirror never writes back.
  await client.query(`DELETE FROM qb_payment_lines WHERE payment_id = $1`, [String(payment.Id)]);
  const lines = payment.Line || [];
  for (let i = 0; i < lines.length; i++) {
    const ln = lines[i];
    const amt = Number(ln.Amount || 0);
    // Each line can link to multiple transactions; we want one row per
    // (payment, line, linked_invoice). For most loan payments there's exactly
    // one LinkedTxn of type Invoice — but we keep the loop general.
    const invoiceLinks = (ln.LinkedTxn || [])
      .filter((lt) => lt.TxnType === 'Invoice')
      .map((lt) => String(lt.TxnId));
    if (invoiceLinks.length === 0) {
      // Unlinked line (e.g. deposit to undeposited funds). Store with NULL
      // linked_invoice_id so the line still contributes to total_amt sanity
      // checks but doesn't bucket into arrear/open math.
      await client.query(
        `INSERT INTO qb_payment_lines (payment_id, line_no, amount, linked_invoice_id)
         VALUES ($1, $2, $3, NULL)`,
        [String(payment.Id), i, amt],
      );
      continue;
    }
    // Multi-link case: split amount equally is wrong (QB doesn't do that).
    // Instead we replicate the full line amount per linked invoice — matches
    // how QB's own reports attribute the line. In practice n is almost always 1.
    for (let k = 0; k < invoiceLinks.length; k++) {
      await client.query(
        `INSERT INTO qb_payment_lines (payment_id, line_no, amount, linked_invoice_id)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (payment_id, line_no) DO UPDATE SET
           amount = EXCLUDED.amount,
           linked_invoice_id = EXCLUDED.linked_invoice_id`,
        // line_no is unique per (payment_id, line) — when multi-link, fold the
        // link index into the line_no key space (k=0 keeps original line_no).
        [String(payment.Id), i + k * 10000, amt, invoiceLinks[k]],
      );
    }
  }
}

// ── Batched upserts (used by backfill + CDC) ────────────────────────────

function buildPlaceholders(rowCount, colCount, startIdx = 1) {
  const rows = [];
  let p = startIdx;
  for (let r = 0; r < rowCount; r++) {
    const cols = [];
    for (let c = 0; c < colCount; c++) cols.push('$' + p++);
    rows.push('(' + cols.join(',') + ')');
  }
  return rows.join(',');
}

export async function upsertInvoicesBatch(invoices, client) {
  if (!invoices.length) return;
  const cols = 9;
  const values = [];
  for (const inv of invoices) {
    values.push(
      String(inv.Id),
      String(inv.CustomerRef?.value || ''),
      inv.TxnDate,
      inv.DueDate || null,
      Number(inv.TotalAmt || 0),
      Number(inv.Balance ?? inv.TotalAmt ?? 0),
      inv.DocNumber || null,
      inv.SyncToken || null,
      inv.MetaData?.LastUpdatedTime || null,
    );
  }
  const placeholders = buildPlaceholders(invoices.length, cols);
  // Only bump mirror_synced_at when something ACTUALLY changed — the
  // CDC 5-min overlap re-fetches unchanged rows every tick; treating
  // those as "newly mirrored" inflated our lag metric to 600+ seconds
  // even though first-mirror was <30 s.
  await client.query(
    `INSERT INTO qb_invoices
       (id, customer_id, txn_date, due_date, total_amt, balance,
        doc_number, sync_token, qb_last_updated)
     VALUES ${placeholders}
     ON CONFLICT (id) DO UPDATE SET
       customer_id      = EXCLUDED.customer_id,
       txn_date         = EXCLUDED.txn_date,
       due_date         = EXCLUDED.due_date,
       total_amt        = EXCLUDED.total_amt,
       balance          = EXCLUDED.balance,
       doc_number       = EXCLUDED.doc_number,
       sync_token       = EXCLUDED.sync_token,
       qb_last_updated  = EXCLUDED.qb_last_updated,
       mirror_synced_at = now()
     WHERE qb_invoices.qb_last_updated IS DISTINCT FROM EXCLUDED.qb_last_updated`,
    values,
  );
}

export async function upsertPaymentsBatch(payments, client) {
  if (!payments.length) return;
  // 1. Bulk upsert qb_payments header rows.
  const cols = 6;
  const values = [];
  for (const p of payments) {
    values.push(
      String(p.Id),
      String(p.CustomerRef?.value || ''),
      p.TxnDate,
      Number(p.TotalAmt || 0),
      p.SyncToken || null,
      p.MetaData?.LastUpdatedTime || null,
    );
  }
  const placeholders = buildPlaceholders(payments.length, cols);
  await client.query(
    `INSERT INTO qb_payments
       (id, customer_id, txn_date, total_amt, sync_token, qb_last_updated)
     VALUES ${placeholders}
     ON CONFLICT (id) DO UPDATE SET
       customer_id      = EXCLUDED.customer_id,
       txn_date         = EXCLUDED.txn_date,
       total_amt        = EXCLUDED.total_amt,
       sync_token       = EXCLUDED.sync_token,
       qb_last_updated  = EXCLUDED.qb_last_updated,
       mirror_synced_at = now()
     WHERE qb_payments.qb_last_updated IS DISTINCT FROM EXCLUDED.qb_last_updated`,
    values,
  );
  // 2. Replace lines for every payment in this batch.
  const ids = payments.map((p) => String(p.Id));
  await client.query(`DELETE FROM qb_payment_lines WHERE payment_id = ANY($1)`, [ids]);
  // 3. Bulk INSERT all lines for this batch.
  const lineVals = [];
  for (const p of payments) {
    const lines = p.Line || [];
    for (let i = 0; i < lines.length; i++) {
      const ln = lines[i];
      const amt = Number(ln.Amount || 0);
      const invoiceLinks = (ln.LinkedTxn || [])
        .filter((lt) => lt.TxnType === 'Invoice')
        .map((lt) => String(lt.TxnId));
      if (invoiceLinks.length === 0) {
        lineVals.push(String(p.Id), i, amt, null);
      } else {
        // Multi-link case extremely rare. Fold the link index into line_no.
        for (let k = 0; k < invoiceLinks.length; k++) {
          lineVals.push(String(p.Id), i + k * 10000, amt, invoiceLinks[k]);
        }
      }
    }
  }
  if (lineVals.length) {
    const lineRows = lineVals.length / 4;
    const linePh = buildPlaceholders(lineRows, 4);
    await client.query(
      `INSERT INTO qb_payment_lines (payment_id, line_no, amount, linked_invoice_id)
       VALUES ${linePh}
       ON CONFLICT (payment_id, line_no) DO UPDATE SET
         amount = EXCLUDED.amount,
         linked_invoice_id = EXCLUDED.linked_invoice_id`,
      lineVals,
    );
  }
}

// ── Backfill ─────────────────────────────────────────────────────────────

/**
 * Initial full pull. Walks STARTPOSITION 1, 1001, 2001... until QB returns
 * an empty page. Upserts each row. Updates qb_mirror_state.last_cdc_at to
 * the highest MetaData.LastUpdatedTime seen so CDC picks up from there.
 *
 * Invoice backfill is unconditional (all invoices, all history). Payment
 * backfill takes an optional `since` ISO date to scope (e.g. last 365 days)
 * if a full pull is too big — but defaults to all.
 *
 * Returns { entity, pages, rows, max_last_updated, took_ms }.
 */
export async function backfillEntity(entity, opts = {}) {
  if (!['Invoice', 'Payment'].includes(entity)) throw new Error('bad entity: ' + entity);
  const t0 = Date.now();
  let start = 1;
  let pages = 0;
  let rows = 0;
  let maxLastUpdated = null;
  // Scope options (combine with AND):
  //   opts.where    — raw WHERE clause override (no leading WHERE)
  //   opts.since    — MetaData.LastUpdatedTime >= 'iso'
  //   opts.fromDate — TxnDate >= 'YYYY-MM-DD'
  //   opts.openOnly — Balance > '0' (Invoice only)
  const clauses = [];
  if (opts.where) clauses.push(opts.where);
  if (opts.since) clauses.push(`MetaData.LastUpdatedTime >= '${opts.since}'`);
  if (opts.fromDate) clauses.push(`TxnDate >= '${opts.fromDate}'`);
  if (opts.openOnly && entity === 'Invoice') clauses.push(`Balance > '0'`);
  const where = clauses.length ? ` WHERE ${clauses.join(' AND ')}` : '';
  while (true) {
    const r = await qbQuery(
      `SELECT * FROM ${entity}${where} ` +
      `STARTPOSITION ${start} MAXRESULTS ${PAGE}`,
    );
    const list = r.QueryResponse?.[entity] || [];
    if (list.length === 0) break;
    // Single transaction per page, BATCHED inserts (1000 rows in one SQL
    // statement instead of 1000 separate INSERTs). 30-50× faster on Supabase
    // pooler because we eat one round-trip per page instead of per row.
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      if (entity === 'Invoice') await upsertInvoicesBatch(list, client);
      else                       await upsertPaymentsBatch(list, client);
      for (const row of list) {
        const lu = row.MetaData?.LastUpdatedTime;
        if (lu && (!maxLastUpdated || lu > maxLastUpdated)) maxLastUpdated = lu;
        rows++;
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      throw e;
    } finally {
      client.release();
    }
    pages++;
    // Progress log every page for long backfills (Frank wants check-ins).
    console.log(`[qb-mirror] backfill ${entity}: page ${pages}, rows ${rows} (last MetaData=${maxLastUpdated})`);
    if (list.length < PAGE) break;
    start += PAGE;
  }
  if (maxLastUpdated) {
    await db().query(
      `INSERT INTO qb_mirror_state (entity, last_cdc_at, last_backfill_at, rows_synced)
       VALUES ($1, $2, now(), $3)
       ON CONFLICT (entity) DO UPDATE SET
         last_cdc_at = GREATEST(qb_mirror_state.last_cdc_at, EXCLUDED.last_cdc_at),
         last_backfill_at = now(),
         rows_synced = qb_mirror_state.rows_synced + EXCLUDED.rows_synced,
         last_error = NULL,
         last_error_at = NULL`,
      [entity, maxLastUpdated, rows],
    );
  }
  return { entity, pages, rows, max_last_updated: maxLastUpdated, took_ms: Date.now() - t0 };
}

// ── CDC delta sync ───────────────────────────────────────────────────────

/**
 * Pull rows changed since (last_cdc_at - overlap), upsert into mirror,
 * advance the high-water mark. Bounded per call: at most CDC_MAX_ROWS so
 * each tick fits inside Supabase's 60s statement timeout and Render's
 * healthcheck window. If QB returns the cap, the next tick picks up the
 * remainder automatically (last_cdc_at advances each call).
 */
// One CDC tick budget. Was 200 — too small when one payment session
// updates 500+ invoices at once (each invoice's Balance changes), the
// poller couldn't keep up and steady-state lag drifted to 20 min.
// 1500 fits inside our 45 s statement_timeout for the upsert step and
// drains 3000 rows/min × per entity, which is well above natural QB
// activity even during heisenberg fires.
const CDC_MAX_ROWS = 1500;

export async function cdcSync(entity) {
  if (!['Invoice', 'Payment'].includes(entity)) throw new Error('bad entity: ' + entity);
  const t0 = Date.now();
  const stateRes = await db().query(
    `SELECT last_cdc_at FROM qb_mirror_state WHERE entity = $1`,
    [entity],
  );
  if (!stateRes.rows.length) {
    throw new Error(`cdcSync(${entity}): no qb_mirror_state row; run backfillEntity first`);
  }
  const baseline = new Date(stateRes.rows[0].last_cdc_at);
  const since = new Date(baseline.getTime() - CDC_OVERLAP_MS);
  const sinceIso = since.toISOString();
  // Bounded query: ORDER BY + MAXRESULTS cap means QB returns ONE bounded
  // page even if thousands of rows changed. Next tick picks up the rest.
  // Drop SELECT * for Invoice (we don't need nested Line[]); keep it for
  // Payment because Line[].LinkedTxn[] is the whole point of mirroring.
  const sel = entity === 'Payment' ? '*' : 'Id, CustomerRef, TxnDate, DueDate, TotalAmt, Balance, DocNumber, SyncToken, MetaData';
  const r = await qbQuery(
    `SELECT ${sel} FROM ${entity} ` +
    `WHERE MetaData.LastUpdatedTime >= '${sinceIso}' ` +
    `ORDER BY MetaData.LastUpdatedTime ` +
    `MAXRESULTS ${CDC_MAX_ROWS}`,
  );
  const list = r.QueryResponse?.[entity] || [];
  let rows = 0;
  let maxLastUpdated = null;
  if (list.length > 0) {
    const client = await db().connect();
    try {
      await client.query('BEGIN');
      // SET LOCAL must be inside the transaction. Caps each Postgres
      // operation to 45 s so we fail fast and let the next tick retry,
      // instead of waiting for Supabase to cancel at 60 s.
      await client.query(`SET LOCAL statement_timeout = 45000`);
      if (entity === 'Invoice') await upsertInvoicesBatch(list, client);
      else                       await upsertPaymentsBatch(list, client);
      await client.query('COMMIT');
      for (const row of list) {
        const lu = row.MetaData?.LastUpdatedTime;
        if (lu && (!maxLastUpdated || lu > maxLastUpdated)) maxLastUpdated = lu;
        rows++;
      }
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      await db().query(
        `UPDATE qb_mirror_state SET last_error = $1, last_error_at = now() WHERE entity = $2`,
        [String(e.message || e).slice(0, 500), entity],
      );
      throw e;
    } finally {
      client.release();
    }
  }
  if (maxLastUpdated) {
    await db().query(
      `UPDATE qb_mirror_state
          SET last_cdc_at = GREATEST(last_cdc_at, $1),
              rows_synced = rows_synced + $2,
              last_error = NULL,
              last_error_at = NULL
        WHERE entity = $3`,
      [maxLastUpdated, rows, entity],
    );
  }
  return { entity, rows, deleted: 0, max_last_updated: maxLastUpdated, took_ms: Date.now() - t0 };
}

// ── State inspection ────────────────────────────────────────────────────

export async function getMirrorState() {
  const counts = await db().query(`
    SELECT
      (SELECT COUNT(*) FROM qb_invoices)       AS invoices,
      (SELECT COUNT(*) FROM qb_payments)       AS payments,
      (SELECT COUNT(*) FROM qb_payment_lines)  AS payment_lines,
      (SELECT COUNT(*) FROM qb_invoices WHERE balance > 0) AS open_invoices,
      (SELECT MAX(qb_last_updated) FROM qb_invoices) AS last_invoice_update,
      (SELECT MAX(qb_last_updated) FROM qb_payments) AS last_payment_update
  `);
  const state = await db().query(`SELECT * FROM qb_mirror_state ORDER BY entity`);
  return { counts: counts.rows[0], state: state.rows };
}
