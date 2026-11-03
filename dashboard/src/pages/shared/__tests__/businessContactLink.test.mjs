// Associating a contact with a company, from EITHER side.
//
// Reported: "There is no way to associate a contact to a company. On either
// the company page or on the contact page."
//
// The data model was already right — contacts.business_id is the link
// (migration 056), the Businesses page lists its contacts by it, and a deal
// reaches a business only through it. Nothing in the app could SET it:
//
//   * The contact record's "Business" box is GHL's companyName — free text,
//     a label with no record behind it.
//   * The contact API never even returned business_id, so the UI could not
//     have shown the link let alone changed it.
//   * The company page listed contacts read-only.
//
// So a contact could show a company name while the business record said
// "No contacts linked", and neither page could reconcile them.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const read = (p) => readFileSync(new URL(p, import.meta.url), 'utf8')
const picker   = read('../BusinessPickerModal.jsx')
const contact  = read('../../contacts/ContactDetail.jsx')
const business = read('../../tabs/BusinessesTab.jsx')
const section  = read('../../dealhub/DealSection.jsx')
const cards    = read('../../tabs/ContactsTab.jsx')
const route    = read('../../../../../pipelinePulse/server/src/routes/contacts.js')

test('a contact CARD links a real business, not a typed name', () => {
  // The card offered an InlineEdit writing companyName: typing "Acme" left
  // the word "Acme" and a contact linked to nothing, while the detail page
  // next door offered the real thing.
  assert.ok(
    !/label="Business" icon="business"/.test(cards),
    'the card still offers a free-text business field'
  )
  assert.match(cards, /function CardBusinessLink\(/)
  // The SAME picker as the detail page and the Deal Hub.
  assert.match(cards, /import BusinessPickerModal from '\.\.\/shared\/BusinessPickerModal'/)
  assert.match(cards, /<BusinessPickerModal/)
})

test('the card can unlink, and the row updates without a reload', () => {
  assert.match(cards, /contactsAPI\.update\(contact\.id, \{ businessId: null \}\)/)
  // Link/unlink writes immediately, so the parent list is patched here — the
  // card's own save cycle never runs for it.
  assert.match(cards, /onBusinessChanged/)
  assert.match(cards, /businessId: link\.businessId/)
})

test('the contacts LIST returns the link, not just the label', () => {
  // The card cannot show a linked business the list never sent. company_name
  // was returned and business_id was not, so every contact would have read
  // "Link a business" however many were already linked.
  assert.match(route, /businessId: c\.business_id/)
  assert.match(route, /businessName: c\.business_name/)
  assert.match(route, /LEFT JOIN businesses b/)
  // is_active, or a business deleted in GHL would drop the whole contact row.
  assert.match(route, /b\.is_active\s+= true/)
})


test('one shared picker serves every surface', () => {
  // Three places now make this link. Three pickers would be three sets of
  // rules about what "linking" means.
  assert.match(picker, /export default function BusinessPickerModal/)
  assert.match(contact, /import BusinessPickerModal from '\.\.\/shared\/BusinessPickerModal'/)
  assert.match(section, /import BusinessPickerModal from '\.\.\/shared\/BusinessPickerModal'/)
  // The deal card's private copy is gone, not merely unused.
  assert.ok(!/function AddBusinessModal/.test(section))
})

test('the contact page can link, change and unlink', () => {
  assert.match(contact, /function BusinessLink\(/)
  assert.match(contact, /Link a business/)
  assert.match(contact, /contactsAPI\.update\(contact\.id, \{ businessId: null \}\)/)
  // RENDERED, not merely defined. An earlier version of this test asserted
  // only that the component existed — deleting the one line that renders it
  // left the page with no way to link a business and the test still passed.
  assert.match(contact, /<BusinessLink contact=\{contact\} onSaved=\{onSaved\} \/>/)
})

test('the link is never collapsed into the free-text company name', () => {
  // `business` is companyName, a typed label; `businessId` is the record.
  // Collapsing them would make one silently overwrite the other.
  //
  // This used to assert the editable ['business', 'Business', 'text'] row was
  // PRESENT. That pinned the wrong thing: two adjacent controls both captioned
  // about a business, only one of which linked to a record, is the confusion
  // — not the separation. The text row is gone from Details; what still has
  // to hold is that the link is its own concept.
  assert.match(contact, /Linked business/)
  assert.match(contact, /businessId/)
  // And it is NOT offered as a plain editable field beside the real control.
  assert.ok(
    !/\['business', 'Business', 'text'\]/.test(contact),
    'the free-text business field is back next to "Link a business"'
  )
})

test('the company page can link a contact back', () => {
  assert.match(business, /Link a contact/)
  assert.match(business, /contactsAPI\.update\(contactId, \{ businessId \}\)/)
})

test('contacts already linked are not offered again', () => {
  assert.match(business, /exclude=\{contacts\.map\(\(c\) => c\.id\)\}/)
  assert.match(picker, /const alreadyLinked = useMemo\(\(\) => new Set\(excludeIds\), \[excludeIds\]\)/)
})

test('the row comes back from the server, not built at the call site', () => {
  // ContactPicker's onChange emits the ID only — no option object. A row
  // assembled here would be missing the deal count, the role and the initials,
  // and would have to GUESS the avatar accent, which is a server-side hash of
  // the contact id. The whole record is refetched instead.
  assert.match(business, /const reload = useCallback\(\(\) => \{/)
  assert.match(business, /onLinked=\{reload\}/)
  assert.doesNotMatch(business, /await contactsAPI\.get\(contactId\)/)
})

test('a missing deal count never renders as "undefined deals"', () => {
  // The template literal is always truthy, so .filter(Boolean) cannot catch
  // an absent count — it printed "undefined deals" under the contact's name.
  assert.match(business, /Number\.isFinite\(Number\(c\.dealCount\)\)/)
})

test('a failed refetch does not wipe the page', () => {
  // The write succeeded. Clearing `data` on a failed re-read would blank the
  // record the rep is looking at over a link that actually worked.
  assert.match(business, /The write succeeded; the row list is stale/)
})

// ── Unlinking one contact ────────────────────────────────────────────

test('each contact row can be unlinked on its own', () => {
  // businessId: null is a real unlink, and the server treats it as one —
  // it is not the same as omitting the field.
  assert.match(business, /contactsAPI\.update\(contact\.id, \{ businessId: null \}\)/)
})

test('unlinking is confirmed, and says what survives', () => {
  // Next to a person's name "remove" reads like a delete. It deletes nothing:
  // the contact keeps its deals and history.
  assert.match(business, /title="Unlink this contact\?"/)
  assert.match(business, /they just stop /)
})

test('the panel refetches after an unlink as well as a link', () => {
  // The roll-up counts on the panels above move with it; patching the array
  // in place would leave them a link behind.
  assert.match(business, /onUnlinked=\{reload\}/)
})

test('the business row looks like every other row on the card', () => {
  // It was a bespoke flex row: its own padding, a 64px label against
  // .pp-cc-label's 62px, a 16px icon against 15px, and its own background.
  // Two pixels out on the label pushed the value off the line the rows above
  // it sit on, and the custom background read as grey beside their white.
  const block = cards.slice(
    cards.indexOf('function CardBusinessLink'),
    cards.indexOf('const linkBtn')
  )
  for (const cls of ['pp-cc-row', 'pp-cc-icon', 'pp-cc-label', 'pp-cc-value']) {
    assert.ok(block.includes(cls), `the business row does not use .${cls}`)
  }
  // And none of the hand-picked numbers that caused the mismatch.
  assert.ok(!/padding: '7px 9px'/.test(block), 'custom row padding is back')
  assert.ok(!/width: 64/.test(block), 'the label is 64px again, off by two')
})
