// Deal custom-field chips: what they show, and what survives a save.
//
// Two reported problems, one screenshot:
//   1. Clearing Product type showed "Not set", then the OLD value came back
//      — along with every other field the rep had just changed.
//   2. Lead source opportunity rendered as {"{\"{\\\"Webchat\\\"}\"}"}.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const section = readFileSync(new URL('../DealSection.jsx', import.meta.url), 'utf8')
const tab = readFileSync(new URL('../../tabs/DealHubTab.jsx', import.meta.url), 'utf8')

const unwrapNested = (() => {
  const fn = section.slice(section.indexOf('function unwrapNested'), section.indexOf('const FIELD_CHIPS'))
  // eslint-disable-next-line no-new-func
  return new Function(`${fn}; return unwrapNested`)()
})()

test('a repeatedly JSON-encoded value reduces to its text', () => {
  // The exact value from production.
  assert.equal(unwrapNested('{"{\\"{\\\\\\"Webchat\\\\\\"}\\"}"}'), 'Webchat')
})

test('a single Postgres array wrapper is peeled', () => {
  assert.equal(unwrapNested('{"Webchat"}'), 'Webchat')
})

test('an ordinary value is untouched', () => {
  // The unwrapper must never mangle the normal case, which is almost every
  // value — that would be a far worse bug than the one it fixes.
  for (const v of ['Webchat', 'Homeowner', 'Crittall', 'Steel & glass', '']) {
    assert.equal(unwrapNested(v), v)
  }
})

test('non-strings pass through', () => {
  assert.equal(unwrapNested(null), null)
  assert.equal(unwrapNested(undefined), undefined)
  assert.equal(unwrapNested(42), 42)
})

test('the field rows render through the unwrapper', () => {
  // Pinned as the CALL, not as one spelling of it. The value is read once
  // into a local now that each field renders a row with both a text value and
  // a picker — the previous assertion matched the old inline JSX attribute
  // and broke on a change that kept the unwrapping exactly as it was.
  assert.match(section, /const value = unwrapNested\(deal\[key\]\)/)
  // And it reaches BOTH slots — a picker that skipped it would show the raw
  // {"value":"…"} wrapper the moment a field came back nested.
  assert.match(section, /value=\{value\}[\s\S]{0,400}?<FieldPicker/)
})

// ── The revert ───────────────────────────────────────────────────────
test('the reconcile merges rather than replacing the whole deal', () => {
  // `setDeal(fresh)` wholesale put every field back when the 2.5s guess lost
  // its race with GHL's webhook — so a rep cleared one chip and watched the
  // old value return along with anything else changed in those seconds.
  // Scoped to the custom-field branch. The PEOPLE reconcile a few hundred
  // lines down is still a wholesale setDeal and should stay one — a contact
  // link has no locally-applied field to preserve, so there is nothing to
  // pin and merging would only add a way to go wrong.
  const branch = tab.slice(tab.indexOf("if (field === 'customField')"), tab.indexOf("} else if (field === 'status')"))
  assert.ok(
    !/dealsAPI\.get\(dealId\)\.then\(setDeal\)/.test(branch),
    'the custom-field reconcile must not replace the deal wholesale'
  )
  assert.match(branch, /const merged = \{ \.\.\.fresh \}/)
})

test('the field just saved is pinned over a stale refetch', () => {
  assert.match(tab, /if \(pinnedKey && fresh\[pinnedKey\] !== pinnedText\)/)
  assert.match(tab, /q\.fieldId === pinnedId/)
})

// The merge itself — modelled, because the ordering is the fix.
const merge = (fresh, pinnedKey, pinnedText, pinnedId) => {
  const m = { ...fresh }
  if (pinnedKey && fresh[pinnedKey] !== pinnedText) m[pinnedKey] = pinnedText
  if (pinnedId && Array.isArray(fresh.qualification)) {
    m.qualification = fresh.qualification.map((q) => (
      q.fieldId === pinnedId
        ? { ...q, value: pinnedText, filled: !!(pinnedText && String(pinnedText).trim()) }
        : q
    ))
  }
  return m
}

test('a CLEAR survives a server that has not caught up', () => {
  const r = merge({ productType: 'Crittall', clientType: 'Homeowner' }, 'productType', null, null)
  assert.equal(r.productType, null)
  // and nothing else is disturbed
  assert.equal(r.clientType, 'Homeowner')
})

test('untouched fields still come from the server', () => {
  // The point of reconciling at all: a value GHL normalised must win.
  const r = merge({ productType: 'Steel', clientType: 'Trade' }, 'productType', 'Steel', null)
  assert.equal(r.clientType, 'Trade')
  assert.equal(r.productType, 'Steel')
})

test('a cleared qualification row does not disturb its siblings', () => {
  const r = merge(
    { qualification: [{ fieldId: 'f1', value: 'old', filled: true }, { fieldId: 'f2', value: 'keep', filled: true }] },
    null, null, 'f1'
  )
  assert.deepEqual(r.qualification[0], { fieldId: 'f1', value: null, filled: false })
  assert.deepEqual(r.qualification[1], { fieldId: 'f2', value: 'keep', filled: true })
})

// ── No flash of the old value ────────────────────────────────────────
// Reported after the revert fix: "i clear, loading coming, then old value is
// coming and then its removing — it's working finally but confusion for
// users." Three visual states for one action, and the middle one says the
// clear failed.
//
// Cause: commit() called setDraft(null) BEFORE onChange, so for the frames
// between the two the chip fell back to `current` — the prop the parent had
// not updated yet.

test('the draft is not dropped before the change is announced', () => {
  const commit = section.slice(section.indexOf('const commit = () =>'), section.indexOf('// Release the held draft'))
  // The old shape: setDraft(null) then onChange(draft).
  assert.ok(
    !/setDraft\(null\)\s*\n\s*if \(!same\) onChange\(draft\)/.test(commit),
    'the draft must outlive the onChange call'
  )
  assert.match(commit, /onChange\(draft\)\s*\n\s*\}/)
})

test('the draft is released once the prop agrees', () => {
  assert.match(section, /if \(settled\) setDraft\(null\)/)
})

test('an empty draft settles against an unset field', () => {
  // Clearing a single-select sends '' and the prop comes back null, so a
  // strict compare would hold the draft for ever and the chip would never
  // accept a later server correction.
  assert.match(section, /\|\| \(!draft && !set\)/)
})

// The sequence itself.
const sequence = () => {
  const frames = []
  let value = 'Crittall'
  let draft = null
  const paint = () => {
    const set = value != null && String(value).trim() !== ''
    const current = set ? String(value) : undefined
    frames.push((draft === null ? current : draft) || 'Not set')
    if (draft !== null && (draft === current || (!draft && !set))) draft = null
  }
  paint()                 // before
  draft = ''; paint()     // rep clears
  paint()                 // onChange fired, draft held
  value = null; paint()   // parent optimistic paint
  paint()                 // settled
  return frames
}

test('clearing never shows the old value again', () => {
  const frames = sequence()
  // 'Crittall' may only appear as the FIRST frame.
  assert.equal(frames[0], 'Crittall')
  assert.ok(!frames.slice(1).includes('Crittall'), `old value reappeared: ${frames.join(' -> ')}`)
})

// ── The spinner has to outlive the request ───────────────────────────
// Reported after the flicker fix: "it should have loading until value
// changes instead of changing and coming empty like that — at the end value
// is coming but transition."
//
// A custom field is not done when its PUT is. The write resolves in ~700ms,
// but the value is not settled until the 2.5s reconcile lands (our PUT ->
// GHL -> webhook -> the handler's own fetch -> our row). Clearing the
// spinner on the request left the chip looking finished for ~1.8s and then
// changing again, which reads as the save undoing itself.

test('a custom field keeps its spinner past the request', () => {
  assert.match(tab, /if \(field !== 'customField'\) setSavingField\(null\)/)
})

test('the reconcile clears it, on success AND on failure to re-read', () => {
  // .finally, not .then: an unreadable refetch must not strand a spinner for
  // ever over a value that is probably correct.
  assert.match(tab, /\.finally\(\(\) => setSavingField\(\(cur\) => \(cur === pinnedId \? null : cur\)\)\)/)
})

test('it is cleared by id, not blindly', () => {
  // A second field edited while the first reconciles owns the spinner by
  // then; clearing unconditionally would stop ITS spinner early.
  assert.match(tab, /cur === pinnedId \? null : cur/)
})

test('a failed write clears the spinner itself', () => {
  // No reconcile is scheduled when the PUT throws, so nothing else would.
  // Sliced from the catch to its own finally — `setSaveError` also appears
  // earlier in the file, so indexing on it found the wrong window.
  const start = tab.indexOf('} catch (err) {')
  const katch = tab.slice(start, tab.indexOf('} finally {', start))
  assert.match(katch, /setSavingField\(null\)/)
})

test('the chip is disabled while saving', () => {
  // The value is already painted optimistically, so without this a rep could
  // pick again mid-flight and race two writes to the same field.
  assert.match(section, /disabled=\{saving\}/)
})
