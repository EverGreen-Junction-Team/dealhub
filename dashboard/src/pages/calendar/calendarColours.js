// calendarColours.js — every booking is drawn in its CALENDAR's colour.
//
// ── WHY THE CALENDAR, NOT THE PERSON ─────────────────────────────────
//
// The cards used to take the assigned person's colour. The team reads its
// diary by calendar instead — "Team Iris & Gabriel", "BGD Detailing",
// "Holidays" — and colours each one, the way Google Calendar does. So the
// calendar is the one colour key on every view: week, day, month and the
// people board. Two keys on one card (person and calendar) would be worse
// than either.
//
// A colour chosen in the sidebar is stored per sub-account (server
// migration 148), so the whole team sees the same colours. A calendar
// nobody has coloured gets one from DEFAULT_ORDER by its position in the
// list, so the board is coloured from the first load.

// The palette offered in the picker: four rows of six, warm to cool and
// then the quiet ones, so a row reads as a family of hues.
export const CALENDAR_PALETTE = [
  { hex: '#ad1457', name: 'Raspberry' }, { hex: '#d81b60', name: 'Pink' },
  { hex: '#d50000', name: 'Red' }, { hex: '#e67c73', name: 'Coral' },
  { hex: '#f4511e', name: 'Orange' }, { hex: '#ef6c00', name: 'Pumpkin' },

  { hex: '#f09300', name: 'Amber' }, { hex: '#f6bf26', name: 'Yellow' },
  { hex: '#e4c441', name: 'Mustard' }, { hex: '#c0ca33', name: 'Lime' },
  { hex: '#7cb342', name: 'Leaf' }, { hex: '#33b679', name: 'Mint' },

  { hex: '#0b8043', name: 'Green' }, { hex: '#009688', name: 'Teal' },
  { hex: '#039be5', name: 'Sky blue' }, { hex: '#4285f4', name: 'Blue' },
  { hex: '#3f51b5', name: 'Indigo' }, { hex: '#7986cb', name: 'Periwinkle' },

  { hex: '#b39ddb', name: 'Lilac' }, { hex: '#9e69af', name: 'Violet' },
  { hex: '#8e24aa', name: 'Purple' }, { hex: '#795548', name: 'Brown' },
  { hex: '#a79b8e', name: 'Stone' }, { hex: '#616161', name: 'Grey' }
]

// The defaults, in the order calendars receive them. Neighbours in the
// list get clearly different hues — no two blues side by side.
const DEFAULT_ORDER = [
  '#039be5', '#d50000', '#0b8043', '#8e24aa', '#f4511e', '#3f51b5',
  '#d81b60', '#009688', '#f09300', '#795548', '#7cb342', '#7986cb',
  '#ad1457', '#33b679', '#ef6c00', '#4285f4', '#9e69af', '#c0ca33',
  '#e67c73', '#616161', '#f6bf26', '#b39ddb', '#a79b8e', '#e4c441'
]

// An appointment on a calendar we have no entry for (deleted, or the
// calendar list failed to load) and blocked time.
export const NO_CALENDAR_COLOUR = 'var(--gray-450)'

/** The default colour for the calendar at this position in the list. */
export function defaultCalendarColour(index) {
  return DEFAULT_ORDER[((index % DEFAULT_ORDER.length) + DEFAULT_ORDER.length) % DEFAULT_ORDER.length]
}

/** Map(calendarId → colour): the chosen colour, else the default by position. */
export function calendarColourMap(calendars) {
  const map = new Map()
  ;(calendars || []).forEach((c, i) => {
    if (c?.id) map.set(c.id, c.colour || defaultCalendarColour(i))
  })
  return map
}

/** The colour one booking is drawn in. */
export function colourOfAppointment(map, appointment) {
  if (!appointment || appointment.kind === 'blocked') return NO_CALENDAR_COLOUR
  return (map && map.get(appointment.calendarId)) || NO_CALENDAR_COLOUR
}
