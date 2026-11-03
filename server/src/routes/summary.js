import express from 'express';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';

export const summaryRouter = express.Router();
summaryRouter.use(requireSession);

// GET /api/summary/counts — location-wide totals for the top-nav pills.
//
// One call, five numbers. Cheap: every subquery hits an indexed column and
// stops after COUNT. The frontend caches the result and refreshes when the
// user creates/edits something (via a state-bump prop, later).

summaryRouter.get('/counts', async (req, res, next) => {
  const locationId = req.locationId;
  try {
    const row = await withTenant(locationId, async (client) => {
      const r = await client.query(
        `SELECT
           (SELECT COUNT(*)::int FROM contacts
             WHERE location_id = $1 AND deleted_at IS NULL)                      AS contacts,
           (SELECT COUNT(*)::int FROM opportunities
             WHERE location_id = $1
               AND is_deleted = false AND deleted_at IS NULL AND is_ghost = false
               AND status = 'open')                                              AS deals,
           (SELECT COUNT(*)::int FROM tasks
             WHERE location_id = $1
               AND deleted_at IS NULL
               AND status = 'open')                                              AS tasks,
           (SELECT COUNT(*)::int FROM notes
             WHERE location_id = $1
               AND status = 'active')                                            AS notes,
           (SELECT COUNT(*)::int FROM businesses
             WHERE location_id = $1 AND is_active = true)                        AS businesses`,
        [locationId]
      );
      return r.rows[0];
    });
    res.json(row);
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/summary/counts failed');
    next(err);
  }
});
