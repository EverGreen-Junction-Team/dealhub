// savedViews.js — named filter sets for the deals board and table.
//
// A view is { name, filters, isShared }. The filters are the same query
// parameters GET /api/deals already accepts, so applying a view is "put these
// on the URL" rather than a second query language.
//
// WHY THE FILTERS ARE VALIDATED HERE. They are stored as JSONB, which Postgres
// cannot type-check. An unknown key would therefore be accepted, stored, and
// then silently ignored when the list endpoint read it back — the view would
// look saved and quietly not work. So the whitelist below is checked on write,
// and anything outside it is rejected with the offending key named.

import express from 'express';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';

export const savedViewsRouter = express.Router();
savedViewsRouter.use(requireSession);

// Mirrors the query parameters of GET /api/deals, plus `view` (board/table/
// cards), which is part of the saved position even though it is not a filter.
// Union across scopes. Kept as one list rather than per-scope: a deals filter
// stored on a contacts view is harmless (the contacts list ignores what it
// does not read), while a per-scope split would reject a legitimate 'q' or
// 'view' that both share.
const ALLOWED = new Set([
  // deals
  'status', 'pipelineId', 'stageId', 'assignedTo',
  // contacts
  'contactType', 'tag', 'activity', 'hasDeals', 'minValue', 'maxValue',
  // both
  'q', 'view'
]);

const MAX_NAME = 60;
// Contacts joined deals when the contacts table gained filters. The column
// was always scoped for this — adding one is a Set entry, not a migration.
const SCOPES = new Set(['deals', 'contacts']);

// Strings only, trimmed, empties dropped.
//
// An empty value means "no filter", and storing it would make the difference
// between "all statuses" and "status unset" invisible on read.
function cleanFilters(input) {
  if (input == null) return { filters: {}, bad: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { filters: null, bad: 'filters must be an object' };
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ALLOWED.has(k)) return { filters: null, bad: `"${k}" is not a filter we can save` };
    if (v == null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return { filters: null, bad: `"${k}" must be a plain value` };
    }
    const s = String(v).trim();
    if (s) out[k] = s;
  }
  return { filters: out, bad: null };
}

function shape(row) {
  return {
    id: row.id,
    name: row.name,
    filters: row.filters || {},
    isShared: row.is_shared,
    // So the UI can show "shared by someone else" and hide its edit controls.
    isMine: row.is_mine,
    position: row.position,
    updatedAt: row.updated_at
  };
}

// GET /api/saved-views?scope=deals
//
// Mine, plus anything shared in this sub-account. Ordered so a rep's own
// views come first — they are the ones being switched between all day.
savedViewsRouter.get('/', async (req, res, next) => {
  const locationId = req.locationId;
  const userId = req.session?.userId || null;
  const scope = (req.query.scope || 'deals').toString();

  try {
    const rows = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT id, name, filters, is_shared, position, updated_at,
                (user_id IS NOT DISTINCT FROM $3) AS is_mine
           FROM saved_views
          WHERE location_id = $1
            AND scope = $2
            AND (user_id IS NOT DISTINCT FROM $3 OR is_shared = true)
          ORDER BY (user_id IS NOT DISTINCT FROM $3) DESC,
                   position ASC NULLS LAST,
                   lower(name) ASC`,
        [locationId, scope, userId]
      );
      return rows;
    });
    res.json({ views: rows.map(shape) });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/saved-views failed');
    next(err);
  }
});

// POST /api/saved-views — create, or overwrite one of the caller's own by name.
//
// Saving a name twice UPDATES rather than erroring: "save this view" pressed
// again is a rep refining the same view, not asking for a second tab with an
// identical label.
savedViewsRouter.post('/', async (req, res, next) => {
  const locationId = req.locationId;
  const userId = req.session?.userId || null;
  const body = req.body || {};
  const scope = (body.scope || 'deals').toString();

  if (!SCOPES.has(scope)) {
    return res.status(400).json({ error: 'Unknown view type', field: 'scope' });
  }
  const name = typeof body.name === 'string' ? body.name.trim() : '';
  if (!name) {
    return res.status(400).json({ error: 'Give this view a name', field: 'name' });
  }
  if (name.length > MAX_NAME) {
    return res.status(400).json({
      error: `A view name cannot be longer than ${MAX_NAME} characters`, field: 'name'
    });
  }
  const { filters, bad } = cleanFilters(body.filters);
  if (bad) return res.status(400).json({ error: bad, field: 'filters' });

  try {
    const row = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO saved_views (location_id, scope, user_id, name, filters, is_shared)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6)
         ON CONFLICT (location_id, scope, COALESCE(user_id, ''), lower(name))
         DO UPDATE SET filters    = EXCLUDED.filters,
                       is_shared  = EXCLUDED.is_shared,
                       updated_at = now()
         RETURNING id, name, filters, is_shared, position, updated_at, true AS is_mine`,
        [locationId, scope, userId, name, JSON.stringify(filters), body.isShared === true]
      );
      return rows[0];
    });
    logger.info({ locationId, userId, viewId: row.id, name }, 'saved view stored');
    res.status(201).json({ view: shape(row) });
  } catch (err) {
    logger.error({ err, locationId, userId }, 'POST /api/saved-views failed');
    next(err);
  }
});

// DELETE /api/saved-views/:id — only your own.
//
// A shared view can be READ by the whole sub-account but deleted only by the
// person who made it; otherwise one rep tidying up removes a tab the rest of
// the team is using.
savedViewsRouter.delete('/:id', async (req, res, next) => {
  const locationId = req.locationId;
  const userId = req.session?.userId || null;
  const id = req.params.id;

  try {
    const result = await withTenant(locationId, async (client) => {
      const { rowCount } = await client.query(
        `DELETE FROM saved_views
          WHERE location_id = $1 AND id = $2
            AND user_id IS NOT DISTINCT FROM $3`,
        [locationId, id, userId]
      );
      return rowCount;
    });
    if (!result) {
      // Not found and not-yours are deliberately the same answer: a rep does
      // not need to learn which other views exist by probing ids.
      return res.status(404).json({ error: 'That view was not found' });
    }
    res.json({ ok: true, id });
  } catch (err) {
    logger.error({ err, locationId, id }, 'DELETE /api/saved-views/:id failed');
    next(err);
  }
});
