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
// calendar list failed to load), with no person whose Personal calendar
// could stand in.
export const NO_CALENDAR_COLOUR = 'var(--gray-450)'

/** The default colour for the calendar at this position in the list. */
export function defaultCalendarColour(index) {
  return DEFAULT_ORDER[((index % DEFAULT_ORDER.length) + DEFAULT_ORDER.length) % DEFAULT_ORDER.length]
}

// "Charlie Stoyle's Personal Calendar" → "Charlie Stoyle". The same rule
// the sidebar draws the row with.
const PERSONAL_NAME = /^(.+?)['’]s personal calendar$/i

/**
 * Everything needed to colour and filter a booking by calendar.
 *
 *   colours       Map(calendarId → colour): chosen, else the default by position
 *   userCalendar  Map(userId → calendarId): each person's PERSONAL calendar
 *
 * ── WHY PEOPLE MAP TO A CALENDAR ─────────────────────────────────────
 *
 * Found live: most of what is on this board is person-level blocked time,
 * which GHL ties to a USER and gives no calendar at all. Coloured by
 * calendar alone, every one of those was grey. Each person has a Personal
 * calendar, so an entry with no calendar of its own belongs to its person's
 * Personal calendar — for its colour, for that calendar's count, and for
 * that calendar's tick.
 *
 * The person is found from the calendar's members (the server sends
 * `userIds`), or failing that from its name, "<Name>'s Personal Calendar",
 * matched against the people on the board.
 */
export function calendarIndex(calendars, resources = []) {
  const colours = new Map()
  const userCalendar = new Map()
  const byName = new Map((resources || [])
    .filter((r) => r?.id && r?.name)
    .map((r) => [r.name.trim().toLowerCase(), r.id]))
  ;(calendars || []).forEach((c, i) => {
    if (!c?.id) return
    colours.set(c.id, c.colour || defaultCalendarColour(i))
    const named = PERSONAL_NAME.exec((c.name || '').trim())
    const personal = c.type === 'personal' || !!named
    if (!personal) return
    const ids = Array.isArray(c.userIds) && c.userIds.length
      ? c.userIds
      : (named && byName.get(named[1].trim().toLowerCase()) ? [byName.get(named[1].trim().toLowerCase())] : [])
    for (const u of ids) if (!userCalendar.has(u)) userCalendar.set(u, c.id)
  })
  return { colours, userCalendar }
}

/** The calendar a booking belongs to: its own, else its person's Personal one. */
export function calendarOf(index, a) {
  if (!a) return null
  if (a.calendarId && index?.colours?.has(a.calendarId)) return a.calendarId
  const own = a.assignedUserId && index?.userCalendar?.get(a.assignedUserId)
  return own || a.calendarId || null
}

/** The colour one booking is drawn in — blocked time included. */
export function colourOfAppointment(index, appointment) {
  if (!appointment) return NO_CALENDAR_COLOUR
  return index?.colours?.get(calendarOf(index, appointment)) || NO_CALENDAR_COLOUR
}

/** True when a booking has a calendar colour (rather than the grey fallback). */
export function hasCalendarColour(accent) {
  return !!accent && accent !== NO_CALENDAR_COLOUR
}

// Blocked time keeps its stripes on top of its colour: it is the absence of
// availability, not a booking, and must read as different at a glance.
export const BLOCKED_HATCH =
  'repeating-linear-gradient(45deg, transparent, transparent 5px, rgba(0,0,0,0.05) 5px, rgba(0,0,0,0.05) 10px)'
