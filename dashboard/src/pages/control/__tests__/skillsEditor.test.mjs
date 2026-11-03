// The skills editor: what it shows and what it still stores.
//
// Every case here is a real complaint. The editor is a form over 56 saved
// skills, and two of its three problems were about what VANISHED when you
// touched it.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('../SkillsSection.jsx', import.meta.url), 'utf8')

test('editing does not replace the whole list', () => {
  // `editing ? <SkillForm/> : <list/>` emptied the page down to one form, so
  // clicking Edit on one of 56 skills read as though the rest were deleted.
  assert.ok(
    !/\{editing \? \(\s*<SkillForm/.test(src),
    'the form must not be rendered INSTEAD of the list'
  )
  assert.ok(
    /editing\?\.id === s\.id/.test(src),
    'the form should open in place of the row it belongs to'
  )
})

test('Deal AI is offered as a real choice', () => {
  // It was hard-disabled with "not yet", from before Deal AI ran the tool
  // loop. skillToolsFor(locationId, 'deal') has served deal skills since the
  // port, so the only thing stopping one was this pill.
  assert.ok(!/not yet/.test(src), 'the Deal AI option should no longer be disabled')
  assert.ok(!/const unavailable = key === 'deal'/.test(src))
  assert.ok(/\['deal', 'Deal AI'\]/.test(src), 'Deal AI should still be listed')
})

test('Deal AI is not ticked by default', () => {
  // A portfolio skill reads across every deal. Turning that on for a
  // single-deal chat by default would offer the model a tool whose answer is
  // about the wrong scope.
  const blank = src.slice(src.indexOf('const BLANK'), src.indexOf('export default'))
  assert.match(blank, /surfaces: \['portfolio'\]/)
  assert.ok(!/surfaces: \['portfolio', 'deal'\]/.test(blank))
})

test('filters and sort are no longer edited here', () => {
  assert.ok(!/label="Filters the AI can apply"/.test(src))
  assert.ok(!/label="Sort by"/.test(src))
  assert.ok(!/function ParamRow/.test(src), 'the row builder should be gone with it')
})

test('filters and sort are still SAVED', () => {
  // The whole risk of removing the editor: a save that dropped params would
  // silently strip every seeded skill's filters the first time someone opened
  // it to fix a typo. They load via {...BLANK, ...skill} and must go back out.
  assert.match(src, /params: form\.params/)
  assert.match(src, /orderBy: form\.orderBy\?\.trim\(\) \|\| null/)
  assert.match(src, /\{ \.\.\.BLANK, \.\.\.skill \}/)
})

test('the view is picked from a dropdown, not typed from memory', () => {
  // "vw_close_reason_by_stage" had to be recalled exactly, underscores and
  // all, and a typo only surfaced as a validation error after the fact.
  assert.match(src, /<Select/, 'the view field should offer a list')
  assert.match(src, /showSearch/, 'the list is long enough to need filtering')
  assert.match(src, /views\.map\(/, 'options come from the fetched catalogue')
})

test('a free-text input remains for when the catalogue cannot be read', () => {
  // A single-select antd dropdown cannot commit a value outside its options,
  // so an empty list would leave the field impossible to fill — the form
  // unusable rather than merely less convenient.
  assert.match(src, /views\.length > 0 \? \(/, 'the two cases should be explicit branches')
  assert.match(src, /placeholder="vw_quiet_deals_by_rep"/, 'the input branch should survive')
})

test('the catalogue is refetched when the account changes', () => {
  // A view exists in the database the account's role can reach, so switching
  // accounts must not leave the previous one's names in the dropdown.
  assert.match(src, /setViews\(\[\]\)/)
  assert.match(src, /controlAPI\.listViews\(\)/)
})

test('skills are laid out side by side, not stacked', () => {
  // A skill's description is written for the MODEL — the AI picks a tool
  // almost entirely on that text — so it runs to two or three hundred words.
  // Full width and unclamped, one card filled the viewport and 56 of them
  // were an endless scroll.
  assert.match(src, /gridTemplateColumns: 'repeat\(auto-fill, minmax\(420px, 1fr\)\)'/)
})

test('the description is clamped on the card', () => {
  assert.match(src, /WebkitLineClamp: 4/)
  // -webkit-line-clamp is near-universal but not guaranteed; without a
  // maxHeight fallback a browser lacking it prints all 300 words again.
  assert.match(src, /maxHeight: 'calc\(var\(--leading-normal\) \* 4em\)'/)
})

test('the full description is reachable from the card', () => {
  assert.match(src, /View more/)
  assert.match(src, /function SkillDetail/)
  assert.match(src, /createPortal/)
})

test('the detail modal closes on Escape and shows the full text', () => {
  const modal = src.slice(src.indexOf('function SkillDetail'), src.indexOf('function SkillRow'))
  assert.match(modal, /e\.key === 'Escape'/)
  assert.match(modal, /whiteSpace: 'pre-wrap'/, 'paragraphs must not collapse into one block')
  assert.match(modal, /aria-modal="true"/)
})

test('the edit form still spans the full width inside the grid', () => {
  // Squeezed into one of two columns it would be unusable.
  assert.match(src, /gridColumn: '1 \/ -1'/)
})
