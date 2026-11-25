// Writes the CRM has accepted that our database has not caught up with yet.
//
// ── THE BUG THIS EXISTS TO PREVENT ───────────────────────────────────
//
// A move or a status change goes to GHL; OUR row is written by GHL's
// AppointmentUpdate webhook a few seconds later. Every handler reloaded the
// board straight after the write — and the reload read our database, which
// still held the OLD row, so it put the card back where it had been. Found on
// the live board: a booking dragged to Thursday sat on Tuesday at full
// opacity for over six seconds, and "Saved" was announced over a card still
// showing its old status. Twice a second click was made because the first
// looked like it had not worked.
//
// So a successful write is remembered here and laid over every reload until
// the row from the server agrees with it — at which point the webhook has
// landed and the entry is dropped. Never longer than PENDING_TTL_MS: if the
// webhook never comes, the board must not lie forever, and the next reload
// after the expiry shows what the database actually holds.

export const PENDING_TTL_MS = 2 * 60 * 1000

// Times compare as instants: the server returns '…T16:00:00.000Z' for what
// we sent as '…T16:00:00+00:00', and a string comparison would never settle.
const TIME_FIELDS = new Set(['startsAt', 'endsAt'])

function same(key, a, b) {
  if (TIME_FIELDS.has(key)) {
    const ta = new Date(a).getTime()
    const tb = new Date(b).getTime()
    return Number.isFinite(ta) && ta === tb
  }
  // `null` and `undefined` both mean "nobody" for an assignee.
  return (a ?? null) === (b ?? null)
}

/**
 * Overlay pending writes on freshly loaded appointments.
 * Mutates `pending` to drop entries that have settled or expired.
 */
export function overlayPending(appointments, pending, now = Date.now()) {
  if (!pending || pending.size === 0) return appointments
  return appointments.map((a) => {
    const p = pending.get(a.id)
    if (!p) return a
    if (now - p.at > PENDING_TTL_MS) {
      pending.delete(a.id)
      return a
    }
    // Compare only the fields we wrote. A name we filled in locally is a
    // display nicety, not part of what has to settle.
    const settled = Object.entries(p.fields)
      .filter(([k]) => k !== 'assignedUserName')
      .every(([k, v]) => same(k, a[k], v))
    if (settled) {
      pending.delete(a.id)
      return a
    }
    return { ...a, ...p.fields }
  })
}
