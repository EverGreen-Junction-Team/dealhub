// sweepCursors.js — helper for the sweep_cursors table.
//
// Cursor advance protocol:
//   1. sweep starts, reads success_through
//   2. window_start = success_through - 5 min (overlap buffer)  OR  now - 30 days if NULL
//   3. window_end   = now at sweep start
//   4. sweep does the work
//   5. On success only → advance success_through = window_end
//   6. On failure     → cursor unchanged; next run retries the same window

import { rawQuery } from '../db.js';

// Default first-run lookback when the cursor is NULL.
const FIRST_RUN_LOOKBACK_DAYS = 30;
// Overlap buffer subtracted from success_through when computing window_start.
// Catches messages that arrived seconds after the previous window closed.
const OVERLAP_MINUTES = 5;

export async function getCursor(locationId, objectType) {
  const { rows } = await rawQuery(
    `SELECT success_through FROM sweep_cursors
      WHERE location_id = $1 AND object_type = $2`,
    [locationId, objectType]
  );
  return rows[0]?.success_through || null;
}

export function computeWindow(cursor, now = new Date()) {
  let windowStart;
  if (cursor) {
    windowStart = new Date(cursor.getTime() - OVERLAP_MINUTES * 60_000);
  } else {
    windowStart = new Date(now.getTime() - FIRST_RUN_LOOKBACK_DAYS * 86400_000);
  }
  return { windowStart, windowEnd: now };
}

export async function advanceCursor(locationId, objectType, successThrough) {
  await rawQuery(
    `INSERT INTO sweep_cursors (location_id, object_type, success_through, updated_at)
     VALUES ($1, $2, $3, now())
     ON CONFLICT (location_id, object_type) DO UPDATE SET
       success_through = EXCLUDED.success_through,
       updated_at      = now()`,
    [locationId, objectType, successThrough]
  );
}
