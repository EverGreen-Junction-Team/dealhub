// Note colours: one palette, one set of rules for displaying them.
//
// WHY THIS IS SHARED. The palette lived inside NoteEditor, which was fine
// while the colour was only something you PICKED. It is now something the deal
// rail, the timeline and the notes tab all RENDER, and four private copies of
// seven hex values is how the same note ends up yellow in one list and grey in
// another.
//
// The colour is stored as a hex string on the note (migration 058 promoted
// title/color/pinned out of the raw payload) and the server sends it on both
// the /api/notes list and the deal timeline. Nothing rendered it until now.

// GHL's own note palette.
//
// These are THEIR values, not our accent hues: a note colour is a pastel fill
// behind text, and using our saturated accents meant the same note showed one
// colour in GHL and a different one here — or none, if the hex matched nothing
// of ours.
//
// If GHL adds a colour, add it here. An unrecognised hex still RENDERS
// everywhere (nothing below is a lookup against this list — it is used for
// offering choices and for naming, not for validation), it just isn't offered
// as a pick and reads as "from your CRM" in the editor.
export const NOTE_COLOURS = [
  ['#FFF2B2', 'Yellow'],
  ['#FFD9B2', 'Orange'],
  ['#FFC2C2', 'Red'],
  ['#E5C2FF', 'Purple'],
  ['#C2D9FF', 'Blue'],
  ['#C2F0E0', 'Green'],
  ['#E0E4EA', 'Grey']
]

// GHL accepts #FFF and #FFAA00 only — a named colour or rgb() is rejected on
// write. So anything else that reaches us is data we cannot trust in a style
// attribute, and a raw value interpolated into `background: ${x}` is a CSS
// injection: `red; background-image: url(...)` would escape the declaration.
//
// Returns the normalised 6-digit hex, or null. Null means "no colour", which
// every caller must render as its own uncoloured default rather than as grey —
// most notes have no colour and they should not all look like grey notes.
export function normaliseNoteColour(value) {
  if (typeof value !== 'string') return null
  const t = value.trim()
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(t)
  if (!m) return null
  const hex = m[1]
  // Expand #abc to #aabbcc so callers can slice fixed offsets and so two
  // spellings of one colour compare equal.
  const full = hex.length === 3
    ? hex.split('').map((c) => c + c).join('')
    : hex
  return `#${full.toUpperCase()}`
}

// The name, for a tooltip or a label. An unrecognised colour gets its hex,
// which is more useful than "Custom" when a rep is asking why it looks odd.
export function noteColourName(value) {
  const hex = normaliseNoteColour(value)
  if (!hex) return null
  const found = NOTE_COLOURS.find(([h]) => h.toUpperCase() === hex)
  return found ? found[1] : hex
}

// Everything a row needs to show the colour, or nulls when there is none.
//
// WHY A HELPER RATHER THAN INLINE STYLES AT EACH SITE. The three lists showing
// notes have different row layouts, but the RULES are the same in all of them:
//
//   • the stripe is the full-strength colour — it is a 3px bar, and a tint of
//     a pastel at 3px wide is invisible
//   • the icon square is the same colour, so the two read as one object
//   • the icon GLYPH stays dark. These are pastels; white on #FFF2B2 fails
//     contrast badly, and the icon is the row's anchor
//   • no colour means no stripe at all, not a transparent one — a grey or
//     empty stripe on the majority of notes reads as a broken colour
export function noteColourStyle(value) {
  const hex = normaliseNoteColour(value)
  if (!hex) return { hex: null, stripe: null, tint: null, name: null }
  return {
    hex,
    stripe: hex,
    tint: hex,
    name: noteColourName(hex)
  }
}
