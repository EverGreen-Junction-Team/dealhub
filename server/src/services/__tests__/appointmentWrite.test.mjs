// What the appointment write path refuses to do, and what it never sends by
// accident.
//
// Two things are worth pinning here and they are different in kind.
//
// THE FIRST IS A CONTRACT WITH THE REP. GHL requires a calendar and a
// contact, and answers a missing one with a 422 naming a field the rep never
// saw on screen. So the refusals happen here, in words that say what to do
// — and a test is the only thing that stops those drifting back into "that
// did not work".
//
// THE SECOND IS A PROMISE TO THE CUSTOMER. `toNotify` fires the calendar's
// confirmation and reschedule emails at the person the appointment is with,
// and GHL's own default is ON. Every call in this file therefore sets it
// explicitly. The asymmetry is the point: a move that should have emailed
// someone can be followed by an email a minute later; a dispatcher tidying
// next week's board cannot unsend fifty. Nothing about that is enforced by
// the type system, so it is enforced here.
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

// The module graph reaches config.js, which exits on a missing DATABASE_URL.
// Nothing under test opens a connection or a socket — every assertion below
// is on a path that throws before any request is built.
process.env.DATABASE_URL ||= 'postgres://stub/stub'
process.env.GHL_CLIENT_ID ||= 'stub'
process.env.GHL_CLIENT_SECRET ||= 'stub'
process.env.GHL_REDIRECT_URI ||= 'https://stub.example/cb'
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough'

const {
  createGhlAppointment, updateGhlAppointment, AppointmentWriteError
} = await import('../ghlAppointmentWrite.js')

const here = dirname(fileURLToPath(import.meta.url))
const src = readFileSync(join(here, '..', 'ghlAppointmentWrite.js'), 'utf8')
const route = readFileSync(join(here, '..', '..', 'routes', 'appointments.js'), 'utf8')

let n = 0
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name) }
const at = async (fn) => {
  try { await fn(); return null } catch (err) { return err }
}
// Awaited one at a time rather than collected and raced: these print under
// their own headings, and a test suite whose output interleaves is one
// nobody reads carefully.
const ta = async (name, fn) => { await fn(); n++; console.log('  ok  ' + name) }

const install = { location_id: 'loc_1' }

console.log('booking — refused here, in words, not by GHL in a 422')

await ta('a booking with no calendar is refused before it leaves', async () => {
  const err = await at(() => createGhlAppointment(install, {
    contactId: 'c1', startTime: 'a', endTime: 'b'
  }))
  assert.ok(err instanceof AppointmentWriteError)
  assert.equal(err.field, 'calendarId')
  assert.equal(err.status, 400)
  // The calendar is not a formality — it carries the working hours and the
  // timezone — so the message has to say so, or picking one looks arbitrary.
  assert.match(err.message, /calendar/i)
})

await ta('a booking with no customer explains where blocked time lives instead', async () => {
  const err = await at(() => createGhlAppointment(install, {
    calendarId: 'cal1', startTime: 'a', endTime: 'b'
  }))
  assert.ok(err instanceof AppointmentWriteError)
  assert.equal(err.field, 'contactId')
  // The useful half. "A customer is required" leaves a dispatcher who wants
  // to hold an afternoon with nowhere to go; blocked time is a different
  // object on a different endpoint and the message points at it.
  assert.match(err.message, /block/i)
})

await ta('a booking with no times is refused, and says which end is missing', async () => {
  const noStart = await at(() => createGhlAppointment(install, {
    calendarId: 'cal1', contactId: 'c1', endTime: 'b'
  }))
  assert.equal(noStart.field, 'startTime')
  const noEnd = await at(() => createGhlAppointment(install, {
    calendarId: 'cal1', contactId: 'c1', startTime: 'a'
  }))
  assert.equal(noEnd.field, 'endTime')
})

console.log('moving — an empty patch is not a write')

await ta('a move that changes nothing never reaches GHL', async () => {
  // Guards the board's drag path. A click the browser reports as a drag
  // would otherwise become a PUT, and each pointless write is a chance to
  // email a customer if notifications are ever switched on.
  const err = await at(() => updateGhlAppointment(install, 'appt1', {}))
  assert.ok(err instanceof AppointmentWriteError)
  assert.match(err.message, /nothing was changed/i)
})

await ta('undefined fields do not count as changes', async () => {
  // The board sends only what moved, so a reassignment arrives with
  // startTime undefined rather than absent. Treating that as a change would
  // send `startTime: undefined` to GHL and blank the time.
  const err = await at(() => updateGhlAppointment(install, 'appt1', {
    startTime: undefined, assignedUserId: undefined
  }))
  assert.ok(err instanceof AppointmentWriteError)
  assert.match(err.message, /nothing was changed/i)
})

await ta('a write with no appointment id is refused', async () => {
  const err = await at(() => updateGhlAppointment(install, null, { title: 'x' }))
  assert.equal(err.field, 'appointmentId')
})

console.log('notifications — off unless somebody decided otherwise')

t('the default is false, stated once', () => {
  assert.match(src, /NOTIFY_CUSTOMER_BY_DEFAULT\s*=\s*false/)
})

t('every operation sets toNotify explicitly rather than omitting it', () => {
  // THE WHOLE POINT. GHL's own default is to notify, so leaving the field
  // out makes the louder behaviour the one you get by forgetting. Each of
  // the three operations must name it.
  const update = src.slice(src.indexOf('export async function updateGhlAppointment'))
    .slice(0, src.slice(src.indexOf('export async function updateGhlAppointment')).indexOf('\n}\n'))
  assert.ok(/body\.toNotify\s*=/.test(update), 'update must set toNotify')

  const create = src.slice(src.indexOf('export async function createGhlAppointment'))
  assert.ok(/toNotify:/.test(create.slice(0, create.indexOf('\n}\n'))), 'create must set toNotify')

  const del = src.slice(src.indexOf('export async function deleteGhlAppointment'))
  assert.ok(/toNotify:/.test(del), 'delete must set toNotify')
})

t('notifying takes an explicit true — nothing truthy will do', () => {
  // `notifyCustomer === true`, not `!!notifyCustomer`. A string, a 1, or an
  // object arriving from a request body must not email anybody.
  const occurrences = src.match(/notifyCustomer === true/g) || []
  assert.ok(occurrences.length >= 3, 'each operation should test for an explicit true')
})

t('the route never defaults the flag itself', () => {
  // One owner for this decision. A second default in the route is how the
  // two drift apart and the service's documented promise stops being true.
  const patch = route.slice(route.indexOf("appointmentsRouter.patch('/:id'"))
  assert.ok(!/notifyCustomer\s*(=|\|\|)\s*(true|false)/.test(patch),
    'the route must pass notifyCustomer through, not default it')
})

console.log("availability — the calendar's rules are not ours to override")

t('the override is off unless explicitly asked for', () => {
  assert.ok(/ignoreAvailability === true/.test(src))
  // Never set unconditionally: those rules are somebody's working day, and
  // an app that quietly ignored them would book a surveyor into a Sunday.
  assert.ok(!/ignoreFreeSlotValidation:\s*true\s*,/.test(src.replace(/if \(.*\) body\.ignoreFreeSlotValidation = true;/g, '')))
})

console.log('cancelling is not deleting')

t('delete is documented as the exception, not the way to cancel', () => {
  // A cancelled appointment keeps its slot and its link to the deal — the
  // record that somebody was going to visit and then did not, which is the
  // thing a sales operation counts. A deleted one makes the afternoon look
  // like it was always free.
  const del = src.slice(src.indexOf('SEPARATE FROM CANCELLING'))
  assert.ok(del.length > 0, 'the distinction must be written down where delete is defined')
  assert.match(del, /cancelled/i)
})

t('blocked time is refused by the route, not passed to the appointment API', () => {
  // GHL's appointment endpoints do not own blocked slots, so passing one
  // through produces a 404 that reads as "this record is missing" rather
  // than "this is not an appointment".
  assert.ok(route.includes("event_kind === 'blocked'"))
})

console.log(`\n${n} passed, 0 failed`)
