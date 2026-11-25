import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

// The mini-month paints two things on each day: the BAND that shows which
// days are on screen, and the DISC that marks today.
//
// They were both set on one button, and `background` was declared for the
// band and then overwritten for today — so the one day that is almost
// always inside the visible week was the only day that lost the week's
// tint. It showed as a white ring around today's disc: not a style, the
// rail's own background coming through a cell that should have been
// carrying the band like its neighbours. `borderRadius: 50%` on a cell
// wider than it is tall made it worse, drawing an ellipse and leaving
// white in the corners too.
//
// The fix is structural — band on the button, disc on a span inside — so
// the test is structural. Collapsing them back into one element is what
// brings the bug back.

const SRC = readFileSync(new URL('../MiniMonth.jsx', import.meta.url), 'utf8')
const CODE = SRC.split('\n')
  .filter((l) => {
    const t = l.trim()
    return !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
  })
  .join('\n')

test('the band is not conditional on today', () => {
  // The exact shape of the original bug: a second `background` that wins
  // for today and throws the band away.
  assert.match(CODE, /background: isShown \? 'var\(--tint-pine\)' : 'transparent'/,
    'the span band is gone')
  const buttonStyle = CODE.slice(CODE.indexOf('<button'), CODE.indexOf('<span'))
  assert.ok(!/isToday \? 'var\(--brand-primary\)'/.test(buttonStyle),
    "today's disc is being painted on the button again — it will eat the band")
})

test('the disc is a real circle, on its own element', () => {
  const inner = CODE.slice(CODE.indexOf('<span'))
  assert.match(inner, /width: 24, height: 24/, 'the disc is not square, so 50% is an ellipse')
  assert.match(inner, /borderRadius: '50%'/, 'the disc is not round')
  assert.match(inner, /background: isToday \? 'var\(--brand-primary\)' : 'transparent'/,
    'the disc no longer marks today')
})

test('the button is square so the band meets its neighbours', () => {
  // A rounded button leaves a gap of rail-white between adjacent days and
  // the range stops reading as one run.
  const buttonStyle = CODE.slice(CODE.indexOf('<button'), CODE.indexOf('<span'))
  assert.ok(!/borderRadius: '50%'/.test(buttonStyle), 'the band is round again')
})

test('only the ends of the range are capped', () => {
  for (const side of ['TopLeft', 'BottomLeft']) {
    assert.match(CODE, new RegExp(`border${side}Radius: isShown && day === firstKey`),
      `the range start is not capped on its ${side} corner`)
  }
  for (const side of ['TopRight', 'BottomRight']) {
    assert.match(CODE, new RegExp(`border${side}Radius: isShown && day === lastKey`),
      `the range end is not capped on its ${side} corner`)
  }
})

test('the ends come from the span the grid is drawn from', () => {
  // Not from the week of `value`: in month view the span is 35 days and a
  // cap at value's week would land in the middle of the band.
  assert.match(CODE, /const firstKey = span \? span\.from/, 'firstKey is not read from span')
  assert.match(CODE, /const lastKey = span \? span\.from\.add\(span\.days - 1, 'day'\)/,
    'lastKey is not read from span')
})

test('a missing span does not cap anything', () => {
  // span is optional on this component; firstKey/lastKey must be null
  // rather than throwing or matching a day key by accident.
  assert.match(CODE, /firstKey = span \? [^:]+ : null/)
  assert.match(CODE, /lastKey = span \? [^:]+ : null/)
})
