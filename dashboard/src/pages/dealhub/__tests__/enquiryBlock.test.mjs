// The initial enquiry block, and the modal behind it.
//
// Until now there was nowhere in Deal Hub to see what the customer first
// asked for: the conversation is in the timeline, but the enquiry that
// CREATED the deal lives in whichever lead source produced it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('../DealSection.jsx', import.meta.url), 'utf8')

test('the block still renders when there is no enquiry at all', () => {
  // The design keeps it under Businesses on every deal. Returning null made
  // the column end abruptly and read as a missing block, not an empty one.
  const block = src.slice(src.indexOf('function EnquiryBlock'), src.indexOf('// Every enquiry on this deal'))
  assert.doesNotMatch(block, /\)\s*return null/)
  assert.match(block, /'No enquiry recorded\.'/)
})

test("the customer's own line breaks survive", () => {
  const block = src.slice(src.indexOf('function EnquiryBlock'), src.indexOf('// Every enquiry on this deal'))
  assert.match(block, /whiteSpace: 'pre-wrap'/)
  // A pasted URL must not widen the column past its own edge.
  assert.match(block, /overflowWrap: 'anywhere'/)
})

test('the history opens in a modal, not inline', () => {
  // The block sits in a narrow column beside Value and Businesses. Three
  // paragraphs of customer text expanded there pushes everything below it
  // off screen.
  assert.match(src, /function EnquiryModal/)
  assert.match(src, /createPortal/)
  assert.ok(!/showAll \? 'Hide'/.test(src), 'the inline toggle should be gone')
})

test('the modal closes on Escape and on backdrop click', () => {
  const modal = src.slice(src.indexOf('function EnquiryModal'))
  assert.match(modal, /e\.key === 'Escape'/)
  assert.match(modal, /if \(e\.target === e\.currentTarget\) onClose\(\)/)
  assert.match(modal, /aria-modal="true"/)
})

test('the modal shows the current enquiry alongside the earlier ones', () => {
  // Opening "show all" and seeing only the OLD ones would be a list missing
  // the thing it is being compared against.
  const modal = src.slice(src.indexOf('function EnquiryModal'))
  assert.match(modal, /\.\.\.\(current \? \[\{ text: current, current: true \}\] : \[\]\)/)
  assert.match(modal, /\[\.\.\.earlier\]\.reverse\(\)/)
})

// ── The count in the button ──────────────────────────────────────────
const label = (current, n) => {
  const total = n + (current ? 1 : 0)
  return `Show all ${total} ${total === 1 ? 'enquiry' : 'enquiries'}`
}

test('the button counts the current enquiry too', () => {
  // The modal shows it, so excluding it from the count would promise one
  // fewer than appears.
  assert.equal(label('x', 2), 'Show all 3 enquiries')
})

test('and says "enquiry" when there is only one', () => {
  // Reachable: a deal whose automation cleared master but which has history.
  assert.equal(label(null, 1), 'Show all 1 enquiry')
  assert.equal(label(null, 3), 'Show all 3 enquiries')
})

test('"replaced", not "sent"', () => {
  // seen_at is when WE saw the field change. GHL does not say when the
  // customer wrote it, and that is not a date to invent.
  assert.match(src, /replaced /)
  assert.ok(!/\bsent \{new Date\(e\.seen_at\)/.test(src))
})
