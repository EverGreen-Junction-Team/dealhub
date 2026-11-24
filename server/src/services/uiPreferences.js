// uiPreferences.js — the rules behind the appearance settings.
//
// Pure: no express, no database. Split out from the route so the validation
// can be tested directly rather than re-declared in the test file, which is
// what routes/savedViews.js had to do and which leaves two copies to keep in
// step by hand.

// The app's shipped look. Also the floor the whole feature stands on: if the
// table is empty, unreachable, or every row is deleted, this is what the
// dashboard renders at, which is exactly what it rendered at before the
// feature existed.
//
// zoom 0.85 is the value that was hardcoded in index.css. Keeping it as the
// default means turning this feature on changes nothing for anybody until
// somebody deliberately moves a slider.
export const DEFAULTS = Object.freeze({ zoom: 0.85, textScale: 1 });

// key → [min, max]. Both ends matter: too small is unreadable, too large
// breaks layouts that assume a usable viewport width.
const RANGES = {
  // 0.6 is small but legible on a large monitor; 1.2 is as far as the
  // fixed-width sidebars and the calendar's columns stretch before they
  // start overlapping.
  zoom: [0.6, 1.2],
  // Text size on top of the zoom. Narrower, because this one multiplies
  // inside boxes whose heights are in pixels — a card in the calendar, a row
  // in a list — and past about 1.3 the text stops fitting them.
  textScale: [0.85, 1.3]
};

/**
 * Validate and clamp an incoming preferences object.
 *
 * Returns { prefs, bad }. `bad` is a sentence naming the offending key,
 * because "invalid preferences" tells the person at the screen nothing about
 * which control to move.
 */
export function cleanPrefs(input) {
  if (input == null || typeof input !== 'object' || Array.isArray(input)) {
    return { prefs: null, bad: 'Preferences must be an object' };
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    const range = RANGES[k];
    if (!range) return { prefs: null, bad: `"${k}" is not a setting we can save` };
    // Accepts a numeric string so a form field that never converted its
    // value is not a silent 400 the user cannot explain.
    const n = typeof v === 'number' ? v : Number(v);
    if (!Number.isFinite(n)) return { prefs: null, bad: `"${k}" must be a number` };
    const [min, max] = range;
    if (n < min || n > max) {
      return { prefs: null, bad: `"${k}" must be between ${min} and ${max}` };
    }
    // Rounded to a step the UI can actually land on, so a float that arrives
    // as 0.8500000000000001 is stored as 0.85 and compares equal next time.
    out[k] = Math.round(n * 100) / 100;
  }
  return { prefs: out, bad: null };
}

/**
 * The numbers the app should actually render at.
 *
 * Per KEY, not per row. A user who has only ever changed the text size keeps
 * following the account's zoom — if the account later changes it, they see
 * that change. Merging whole rows instead would freeze the whole of their
 * appearance at the moment they touched one slider, which is not what
 * "I made the text bigger" means.
 */
export function resolve(account, user) {
  return { ...DEFAULTS, ...(account || {}), ...(user || {}) };
}
