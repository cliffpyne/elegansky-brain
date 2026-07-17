// Admin API for the Frappe payment mirror. Read-only inspection endpoints.
import { db } from './db/pool.js';
import { getFrappeMirrorPollerState } from './frappe-mirror-poller.js';
import { backfillPayments, cdcSyncPayments, sumFrappePaidForPartiesOnDate } from './frappe-mirror.js';
import { getAprunaCache } from './apruna-resolver.js';

export function mountFrappeMirrorApi(app, { requireSecretOrJwt }) {
  // GET /api/frappe-mirror/state — poller status + row count
  app.get('/api/frappe-mirror/state', requireSecretOrJwt, async (_req, res) => {
    try {
      const poller = getFrappeMirrorPollerState();
      const cnt = await db().query(`SELECT COUNT(*)::int AS n FROM frappe_payments`);
      const s = await db().query(`SELECT * FROM frappe_mirror_state WHERE entity = 'PaymentEntry'`);
      res.json({ poller, row_count: cnt.rows[0].n, state: s.rows[0] || null });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/frappe-mirror/backfill — force full backfill
  app.post('/api/frappe-mirror/backfill', requireSecretOrJwt, async (_req, res) => {
    try {
      const r = await backfillPayments();
      res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // POST /api/frappe-mirror/cdc — force one CDC sync tick
  app.post('/api/frappe-mirror/cdc', requireSecretOrJwt, async (_req, res) => {
    try {
      const r = await cdcSyncPayments();
      res.json(r);
    } catch (err) { res.status(500).json({ error: err.message }); }
  });

  // GET /api/frappe-mirror/apruna-today?date=YYYY-MM-DD
  // Returns Frappe payment total across ALL APRUNA customers on that date.
  // Combines with the QB officer report (which the frontend shows for other
  // officers) to give the real APRUNA collection number.
  app.get('/api/frappe-mirror/apruna-today', requireSecretOrJwt, async (req, res) => {
    try {
      const date = String(req.query.date || new Date().toISOString().slice(0, 10));
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return res.status(400).json({ error: 'date must be YYYY-MM-DD' });
      const roster = await getAprunaCache();
      // Roster keys: `customer` is the canonical Frappe party name.
      const parties = new Set();
      for (const entry of roster.byPlate.values())  if (entry.customer) parties.add(String(entry.customer));
      for (const entry of roster.byQbId.values())   if (entry.customer) parties.add(String(entry.customer));
      const partyList = [...parties];
      const perParty = await sumFrappePaidForPartiesOnDate(partyList, date);
      let total = 0;
      const details = [];
      for (const [party, sum] of perParty.entries()) {
        total += sum;
        if (sum > 0) details.push({ party, sum });
      }
      details.sort((a, b) => b.sum - a.sum);
      res.json({ date, officer: 'APRUNA THOMAS BODA', roster_size: partyList.length, total_frappe_paid: total, per_party: details.slice(0, 100) });
    } catch (err) { res.status(500).json({ error: err.message }); }
  });
}
