// Insights — the BGD insight set, read through our own API.
//
// The prototype (InsightsHub) read Supabase straight from the browser with a
// service-role key and filtered on a brand decoded inside each view. Neither
// travels: the key would be a standing grant over every table, and the brand
// decode hardcodes the sub-accounts (migration 135's header has the detail).
//
// Here each chart names a VIEW, the view returns raw location_id, and this
// route appends `WHERE location_id = $1` from the session. Same boundary as
// every other read in this app — a caller cannot ask for another account's
// rows, because the id never comes from the request.
//
// ── ONE ROUTE PER CHART, NOT ONE FOR THE PAGE ────────────────────────
//
// 24 cards draw 26 charts across 27 views. A single endpoint would run all
// of them on every page load, so the slowest query would decide how long the
// page took and one failure would cost the lot. Per chart, the client fetches
// only what is on screen and a broken insight is a broken card.

import { Router } from 'express';
import { requireSession } from './auth.js';
import { withTenant } from '../db.js';
import { logger } from '../utils/logger.js';

export const insightsRouter = Router();

// Every route here is per-account. requireSession puts the JWT's locationId
// on the request, and that is the ONLY place the id comes from — a query
// param would let a caller read another sub-account's figures.
insightsRouter.use(requireSession);

// chart key -> the view(s) it reads, in the order its adapter expects.
// Taken from the prototype's lib/charts.ts so the two cannot disagree about
// which view feeds which chart.
const CHART_VIEWS = {
  c11: ["vw_insight_1_1"],
  c13: ["vw_insight_1_3"],
  c14: ["vw_insight_1_4"],
  c15b: ["vw_insight_1_5_b", "vw_insight_1_5_a"],
  c21: ["vw_insight_2_1"],
  c22: ["vw_insight_2_2"],
  c24: ["vw_insight_2_4"],
  c25: ["vw_insight_2_5"],
  c35a: ["vw_insight_3_5_a"],
  c37: ["vw_insight_3_7"],
  c38: ["vw_insight_3_8"],
  c41: ["vw_insight_4_1"],
  c42: ["vw_insight_4_2"],
  c43a: ["vw_insight_4_3_a"],
  c44: ["vw_insight_4_4"],
  c45: ["vw_insight_4_5"],
  c51: ["vw_insight_5_1"],
  c61: ["vw_insight_6_1"],
  c62: ["vw_insight_6_2"],
  c63a: ["vw_insight_6_3_a"],
  c63b: ["vw_insight_6_3_b"],
  c81: ["vw_insight_8_1"],
  c82b: ["vw_insight_8_2_b"],
  c83a: ["vw_insight_8_3"],
  c84: ["vw_insight_8_4"],
  c85: ["vw_insight_8_5"],
};

// Hard cap per view. These are pre-aggregated — a stage breakdown is a dozen
// rows, a per-rep cut is one row per rep — so anything near this means a view
// is not aggregating and the chart would be unreadable anyway.
const MAX_ROWS = 500;

// Every view name is checked against this before it reaches a query. Nothing
// from the request is ever interpolated into SQL: the key selects a name we
// wrote, and the location is a bound parameter.
const KNOWN_VIEWS = new Set(Object.values(CHART_VIEWS).flat());

insightsRouter.get('/charts/:key', async (req, res, next) => {
  const locationId = req.locationId;
  const key = String(req.params.key || '');
  const views = CHART_VIEWS[key];

  if (!views) {
    return res.status(404).json({ error: `No insight chart named "${key}".` });
  }

  try {
    const sets = await withTenant(locationId, async (client) => {
      const out = [];
      for (const view of views) {
        // Belt and braces: `views` comes from our own map, but the name is
        // interpolated into the SQL text (a view cannot be a bound
        // parameter), so it is re-checked against the allow-list here.
        if (!KNOWN_VIEWS.has(view)) throw new Error(`unknown view ${view}`);
        const r = await client.query(
          `SELECT * FROM ${view} WHERE location_id = $1 LIMIT ${MAX_ROWS}`,
          [locationId]
        );
        out.push(r.rows);
      }
      return out;
    });

    res.json({ key, views, sets, rows: sets.reduce((n, s) => n + s.length, 0) });
  } catch (err) {
    logger.error({ err, locationId, key }, 'GET /api/insights/charts/:key failed');
    next(err);
  }
});

// Which charts this build can serve. The client uses it to tell a card whose
// data is genuinely missing from one whose key it simply does not know.
insightsRouter.get('/charts', (_req, res) => {
  res.json({ keys: Object.keys(CHART_VIEWS).sort() });
});
