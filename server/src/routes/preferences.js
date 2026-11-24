// preferences.js — how the dashboard is sized, per sub-account and per person.
//
// Two rows answer the same question and one beats the other: see
// migration 144. The account row (user_id NULL) is the house default; a user
// row overrides it for that person only. This route resolves them and
// reports all three layers, because a settings screen that shows only the
// winning number cannot explain why a slider has the value it has.
//
// ── WHY THE WHITELIST CARRIES RANGES ─────────────────────────────────
//
// These are not ordinary preferences. `zoom` scales the entire interface, so
// a bad value is not a bad-looking page — it is a page nobody can read,
// including the settings screen that would let them put it back. A stored
// 0.05 locks the user out of their own fix.
//
// So every key is clamped here, on the way in, to a range in which the app
// is still operable. The client also clamps, for a responsive slider; that
// is a convenience and this is the guarantee. A number outside the range is
// a mistake somewhere, so it is rejected by name rather than silently
// rounded — silently storing something other than what was asked for is how
// a settings screen loses the user's trust.

import express from 'express';
import { withTenant } from '../db.js';
import { requireSession } from './auth.js';
import { logger } from '../utils/logger.js';
import { DEFAULTS, cleanPrefs, resolve } from '../services/uiPreferences.js';

export const preferencesRouter = express.Router();
preferencesRouter.use(requireSession);

// Which of the two rows a write is aimed at. Not in the service with the
// rest of the rules: it is about the shape of the request, not about what a
// valid preference is.
const SCOPES = new Set(['account', 'user']);

// GET /api/preferences
//
// All three layers, not just the answer. The settings screen shows which
// values are the account's and which are the person's own, and cannot do
// that from the resolved numbers alone.
preferencesRouter.get('/', async (req, res, next) => {
  const locationId = req.locationId;
  const userId = req.session?.userId || null;

  try {
    const rows = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT user_id, prefs, updated_by, updated_at
           FROM ui_preferences
          WHERE location_id = $1
            AND (user_id IS NULL OR user_id IS NOT DISTINCT FROM $2)`,
        [locationId, userId]
      );
      return rows;
    });

    const accountRow = rows.find((r) => r.user_id === null) || null;
    const userRow = userId ? rows.find((r) => r.user_id === userId) || null : null;

    res.json({
      defaults: DEFAULTS,
      account: accountRow?.prefs || null,
      accountUpdatedBy: accountRow?.updated_by || null,
      accountUpdatedAt: accountRow?.updated_at || null,
      mine: userRow?.prefs || null,
      effective: resolve(accountRow?.prefs, userRow?.prefs)
    });
  } catch (err) {
    logger.error({ err, locationId }, 'GET /api/preferences failed');
    next(err);
  }
});

// PUT /api/preferences  { scope: 'account' | 'user', prefs: {...} }
//
// WHO MAY SET THE ACCOUNT DEFAULT. Anyone in the sub-account, which is the
// same rule saved views already use for `is_shared` — the session carries no
// role, so there is nothing to check against without a second lookup, and
// inventing a half-enforced permission is worse than an honest one. The UI
// says plainly that this one is for everybody, and `updated_by` records who
// did it, which is what makes an unwanted change explainable and reversible
// rather than mysterious.
preferencesRouter.put('/', async (req, res, next) => {
  const locationId = req.locationId;
  const userId = req.session?.userId || null;
  const body = req.body || {};
  const scope = (body.scope || 'user').toString();

  if (!SCOPES.has(scope)) {
    return res.status(400).json({ error: 'Scope must be "account" or "user"', field: 'scope' });
  }
  if (scope === 'user' && !userId) {
    // No user id on the session means the iframe handshake did not carry
    // one. There is nowhere to put a personal setting, and storing it as the
    // account's would change it for the whole team behind their back.
    return res.status(400).json({
      error: 'We could not tell who you are, so this can only be saved for the whole account',
      field: 'scope'
    });
  }
  const { prefs, bad } = cleanPrefs(body.prefs);
  if (bad) return res.status(400).json({ error: bad, field: 'prefs' });

  const rowUser = scope === 'account' ? null : userId;

  try {
    const row = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `INSERT INTO ui_preferences (location_id, user_id, prefs, updated_by)
         VALUES ($1, $2, $3::jsonb, $4)
         ON CONFLICT (location_id, COALESCE(user_id, ''))
         DO UPDATE SET prefs      = EXCLUDED.prefs,
                       updated_by = EXCLUDED.updated_by,
                       updated_at = now()
         RETURNING user_id, prefs, updated_by, updated_at`,
        [locationId, rowUser, JSON.stringify(prefs), userId]
      );
      return rows[0];
    });

    // Read the other layer back so the response can carry the resolved
    // numbers. Without it the client would have to guess what its own save
    // did to the effective value, and would guess wrong whenever the layer
    // it did not touch has a key the layer it did touch does not.
    const other = await withTenant(locationId, async (client) => {
      const { rows } = await client.query(
        `SELECT prefs FROM ui_preferences
          WHERE location_id = $1 AND user_id IS NOT DISTINCT FROM $2`,
        [locationId, scope === 'account' ? userId : null]
      );
      return rows[0]?.prefs || null;
    });

    const account = scope === 'account' ? row.prefs : other;
    const mine = scope === 'account' ? other : row.prefs;

    logger.info({ locationId, userId, scope, prefs }, 'ui preferences stored');
    res.json({
      defaults: DEFAULTS,
      account: account || null,
      mine: mine || null,
      effective: resolve(account, mine)
    });
  } catch (err) {
    logger.error({ err, locationId, userId, scope }, 'PUT /api/preferences failed');
    next(err);
  }
});

// DELETE /api/preferences?scope=user
//
// "Use the account's settings" / "use the app's defaults". Deleting the row
// rather than writing the inherited numbers into it is what keeps the
// inheritance live: a person who resets now FOLLOWS the account default
// again, including whatever it changes to next month. Copying the numbers
// down would look identical today and silently stop tracking.
preferencesRouter.delete('/', async (req, res, next) => {
  const locationId = req.locationId;
  const userId = req.session?.userId || null;
  const scope = (req.query.scope || 'user').toString();

  if (!SCOPES.has(scope)) {
    return res.status(400).json({ error: 'Scope must be "account" or "user"', field: 'scope' });
  }
  if (scope === 'user' && !userId) {
    return res.status(400).json({ error: 'We could not tell who you are', field: 'scope' });
  }

  try {
    const rows = await withTenant(locationId, async (client) => {
      await client.query(
        `DELETE FROM ui_preferences
          WHERE location_id = $1 AND user_id IS NOT DISTINCT FROM $2`,
        [locationId, scope === 'account' ? null : userId]
      );
      const { rows } = await client.query(
        `SELECT user_id, prefs FROM ui_preferences
          WHERE location_id = $1
            AND (user_id IS NULL OR user_id IS NOT DISTINCT FROM $2)`,
        [locationId, userId]
      );
      return rows;
    });

    const account = rows.find((r) => r.user_id === null)?.prefs || null;
    const mine = userId ? rows.find((r) => r.user_id === userId)?.prefs || null : null;

    logger.info({ locationId, userId, scope }, 'ui preferences cleared');
    res.json({
      defaults: DEFAULTS,
      account,
      mine,
      effective: resolve(account, mine)
    });
  } catch (err) {
    logger.error({ err, locationId, userId, scope }, 'DELETE /api/preferences failed');
    next(err);
  }
});
