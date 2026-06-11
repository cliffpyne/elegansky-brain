// Admin endpoints for the QB mirror.
//   POST /api/qb-mirror/backfill   — trigger a full or scoped backfill
//   POST /api/qb-mirror/cdc-sync   — force an immediate CDC tick
//   GET  /api/qb-mirror/state      — counts + poller state

import { backfillEntity, cdcSync, getMirrorState } from './qb-mirror.js';
import { getQbMirrorPollerState } from './qb-mirror-poller.js';

export function mountQbMirrorApi(app, { requireSecretOrJwt }) {
  app.get('/api/qb-mirror/state', requireSecretOrJwt, async (_req, res) => {
    try {
      const state = await getMirrorState();
      res.json({
        ...state,
        poller: getQbMirrorPollerState(),
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // POST /api/qb-mirror/backfill { entity: 'Invoice'|'Payment', openOnly?, fromDate?, since? }
  // Async — kicks off and returns immediately; poll /state for progress.
  app.post('/api/qb-mirror/backfill', requireSecretOrJwt, async (req, res) => {
    const { entity, openOnly, fromDate, since } = req.body || {};
    if (!['Invoice', 'Payment'].includes(entity)) {
      return res.status(400).json({ error: 'entity must be Invoice or Payment' });
    }
    // Fire-and-forget. Caller polls /api/qb-mirror/state for row counts.
    (async () => {
      try {
        const out = await backfillEntity(entity, { openOnly, fromDate, since });
        console.log(`[qb-mirror-api] backfill complete:`, out);
      } catch (e) {
        console.error(`[qb-mirror-api] backfill failed:`, e.message);
      }
    })();
    res.json({ ok: true, started: { entity, openOnly, fromDate, since } });
  });

  app.post('/api/qb-mirror/cdc-sync', requireSecretOrJwt, async (req, res) => {
    const { entity } = req.body || {};
    if (!['Invoice', 'Payment'].includes(entity)) {
      return res.status(400).json({ error: 'entity must be Invoice or Payment' });
    }
    try {
      const out = await cdcSync(entity);
      res.json(out);
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
