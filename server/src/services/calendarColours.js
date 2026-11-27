// calendarColours.js — the colour each calendar is drawn in (migration 148).
//
// Pure, so the rules are tested without a database.

/**
 * A colour as stored: '#rrggbb', lower case. Accepts '#RGB' / '#RRGGBB' with
 * or without the '#'. Returns null for "no colour" (null, '', undefined) and
 * undefined for anything that is not a colour — the route answers 400.
 */
export function normaliseColour(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') return undefined;
  let s = v.trim().toLowerCase();
  if (s.startsWith('#')) s = s.slice(1);
  if (/^[0-9a-f]{3}$/.test(s)) s = s.split('').map((c) => c + c).join('');
  if (!/^[0-9a-f]{6}$/.test(s)) return undefined;
  return `#${s}`;
}

/** Rows → Map(calendarId → colour). */
export function colourMap(rows) {
  return new Map((rows || []).map((r) => [r.calendar_id, r.colour]));
}
