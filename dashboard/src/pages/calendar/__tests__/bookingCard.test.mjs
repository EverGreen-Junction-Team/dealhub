import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const read = (f) => readFileSync(new URL(`../${f}`, import.meta.url), 'utf8')
const code = (f) => read(f).split('\n')
  .filter((l) => { const t = l.trim(); return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*') })
  .join('\n')

// ── The override ─────────────────────────────────────────────────────
// GHL's availability check is the calendar owner's rule. The first save
// must always respect it; only a refusal FOR THAT REASON earns a second,
// explicit button, and only that button may send the override.

test('the first save never overrides availability', () => {
  const src = code('BookAppointment.jsx')
  assert.match(src, /onClick=\{\(\) => submit\(false\)\}/, 'Save is not the non-overriding path')
  assert.ok(!/onClick=\{submit\}/.test(src), 'Save passes the click event as `override`, which is truthy')
  assert.match(src, /\.\.\.\(override \? \{ ignoreAvailability: true \} : \{\}\)/,
    'the override is sent unconditionally')
})

test('"Book it anyway" appears only when the server says it would help', () => {
  const src = code('BookAppointment.jsx')
  assert.match(src, /setCanOverride\(!override && err\.data\?\.canOverride === true\)/,
    'the button is offered on refusals the override cannot fix')
  assert.match(src, /\{canOverride && \(/)
  assert.match(src, /onClick=\{\(\) => submit\(true\)\}/)
})

test('internal notes reach the request as description', () => {
  const src = code('BookAppointment.jsx')
  assert.match(src, /description: notes\.trim\(\) \|\| undefined/)
  assert.match(src, /maxLength=\{5000\}/, 'no cap on a field GHL caps at 5000')
})

test('labels are read, not decorated', () => {
  const src = read('BookAppointment.jsx')
  const block = src.slice(src.indexOf('.pp-quick-label {'), src.indexOf('}', src.indexOf('.pp-quick-label {')))
  assert.ok(!/uppercase/.test(block), 'labels are uppercase again')
  assert.match(block, /color: var\(--text-body\)/, 'labels are muted again')
})

test('the controls have visible edges before hover', () => {
  const src = read('BookAppointment.jsx')
  assert.match(src, /\.pp-quick \.ant-input \{[^}]*border-color: var\(--border-default\) !important/,
    'controls are borderless until hovered again')
})

// ── The hover card ───────────────────────────────────────────────────

test('both views use the shared detail card, portalled with tokens', () => {
  for (const f of ['AppointmentCard.jsx', 'MonthGrid.jsx']) {
    const src = code(f)
    assert.match(src, /<Popover[\s\S]*?content=\{<AppointmentDetail/, `${f} is not using the detail card`)
    assert.match(src, /rootClassName="pp-portal"/, `${f} portals outside the token scope`)
    assert.ok(!/<Tooltip title=\{tip\}/.test(src), `${f} went back to the dark tooltip`)
  }
})

test('the name is not printed twice', () => {
  const src = code('AppointmentDetail.jsx')
  assert.match(src, /a\.title && !same\(a\.title, label\)/, 'title shown even when it repeats the name')
  assert.match(src, /trim\(\)\.toLowerCase\(\)/, 'the comparison is exact, and GHL re-cases titles')
})
