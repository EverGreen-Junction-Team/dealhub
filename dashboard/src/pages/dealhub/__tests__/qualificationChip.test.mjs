// The unanswered state on a qualification heading.
//
// Run: node --test src/pages/dealhub/__tests__/qualificationChip.test.mjs
//
// It was a dashed rose CHIP reading "Add answer", matching the deal card's
// unset field chips. The client's October 2026 design replaces it with a box
// shaped like the input it becomes, carrying an "Add answer…" placeholder —
// so the panel reads as a form rather than as a report.
//
// The PRINCIPLE the chip existed for has not changed and is still asserted
// below: an unanswered heading must look like somewhere you can type, must say
// it is unanswered, and must not pretend to be editable when no saver is
// wired.

import test from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'

const src = readFileSync(new URL('../QualificationSection.jsx', import.meta.url), 'utf8')

test('an unanswered heading renders as a real textarea', () => {
  // Not a button that becomes one on click. That box looked like a field but
  // was not: a rep who clicked and started typing lost the first keystroke,
  // because the click only opened the editor.
  assert.match(src, /<textarea/)
  assert.match(src, /rows=\{3\}/)
  assert.match(src, /resize: 'vertical'/)
  // No click-to-edit button left behind.
  assert.doesNotMatch(src, /minHeight: 64/)
})

test('the placeholder says the heading is unanswered', () => {
  // "Add answer…", not an empty box: the panel's whole point is which
  // questions have no answer, and a blank field states nothing.
  assert.match(src, /placeholder=\{canEdit \? 'Add answer…' : 'Not filled yet'\}/)
})

test('it is only editable when a saver is wired', () => {
  // readOnly, not disabled: a disabled textarea cannot be focused, so its
  // text cannot be selected or copied — and a rep with no write access still
  // needs to read the answer.
  assert.match(src, /readOnly=\{!canEdit\}/)
  assert.match(src, /if \(!canEdit \|\| active\) return/)
})

test('the edited row is the one that looks active', () => {
  // Ten identical boxes with no focus state gives no sign which one a save
  // would land on.
  assert.match(src, /const active = editing === q\.fieldKey/)
  assert.match(src, /active \? 'var\(--accent-gold-text\)'/)
})

test('Save and Cancel show only on the row being edited', () => {
  // Ten permanent button pairs would be louder than the answers themselves.
  assert.match(src, /\{active && \(/)
})

test('the grid is TWO columns, never three', () => {
  // auto-fit packs in as many columns as fit, so a wide screen got three: the
  // design shows two, and at three the heading column is squeezed until every
  // question wraps — and the odd-row filler, which assumes two, left a grey
  // block where the two empty slots were.
  // No inline grid-template — the class governs, or an inline value would
  // win over the media query. (The phrase still appears in a COMMENT
  // explaining the old behaviour, so this checks the property, not the file.)
  assert.doesNotMatch(src, /gridTemplateColumns: 'repeat\(auto-fit/)
  assert.match(src, /className="pp-qual-grid"/)
  const css = readFileSync(
    new URL('../../../styles/dealhub-tokens.css', import.meta.url), 'utf8'
  )
  // One column by default, two above the breakpoint — and never more.
  const rule = css.slice(css.indexOf('.pp-qual-grid'))
  assert.match(rule, /grid-template-columns: 1fr;/)
  assert.match(rule, /@media \(min-width: 900px\)/)
  assert.match(rule, /grid-template-columns: repeat\(2, minmax\(0, 1fr\)\);/)
  // Both scopes, since tokens do not reach a portalled surface.
  assert.match(rule, /\.pp-portal\s+\.pp-qual-grid/)
})

test('the columns read down, 1-5 then 6-10', () => {
  // Two explicit stacks rather than one row-major grid, so an odd count needs
  // no filler cell and a narrow panel keeps the order.
  assert.match(src, /const columns = \[qualification\.slice\(0, half\), qualification\.slice\(half\)\]/)
})

test('saving is per-heading, and blocks cancel too', () => {
  // A global "something is saving" flag greyed every row's buttons. And
  // abandoning the box mid-write leaves the rep looking at the old value with
  // a save still landing behind it.
  // By fieldId: saveDealField marks a custom field by its GHL id, so a
  // fieldKey comparison never matched and "Saving…" never showed.
  assert.match(src, /const saving = savingField === q\.fieldId/)
  // BOTH buttons take the guard — abandoning mid-write leaves the rep on the
  // old value with a save still landing behind it.
  assert.equal((src.match(/disabled=\{saving\}/g) || []).length, 2)
})

test('blurring a changed box saves it', () => {
  // Focus is what opens the editor now, so clicking from one box into another
  // switches `editing` — without this the first box's typing was discarded
  // silently, which is data loss on a click-through. commit() returns without
  // a request when nothing changed, so a stray click costs nothing.
  assert.match(src, /onBlur=\{\(\) => \{/)
  assert.match(src, /if \(canEdit && active\) commit\(q\)/)
})

test('a save landing late does not close the box being typed in', () => {
  // Blur fires the save, and by the time it returns the rep has clicked into
  // the next heading. Clearing `editing` unconditionally left that box focused
  // but rendering the stored value, so typing and backspace did nothing.
  const commit = src.slice(src.indexOf('const commit = async'), src.indexOf('const missing ='))
  assert.match(commit, /setEditing\(\(cur\) => \(cur === q\.fieldKey \? null : cur\)\)/)
  const afterSave = commit.slice(commit.indexOf('await onSave'))
  assert.doesNotMatch(afterSave, /setEditing\(null\)/)
  assert.doesNotMatch(afterSave, /setDraft\(''\)/)
})

test('typing into a focused but inactive box claims it', () => {
  // The self-heal for any path that leaves focus in a closed box.
  assert.match(src, /if \(!active\) setEditing\(q\.fieldKey\)\s*\n\s*setDraft\(e\.target\.value\)/)
})

test('Cmd/Ctrl+Enter saves through blur, not in place', () => {
  // In place closed the editor with focus still in the box, and the blur that
  // followed saved a second time.
  assert.match(src, /e\.key === 'Enter' && \(e\.metaKey \|\| e\.ctrlKey\)\) e\.currentTarget\.blur\(\)/)
})

test('Escape does NOT save through that blur', () => {
  // setEditing(null) is queued, but .blur() dispatches onBlur in the same
  // tick — so the handler still reads `editing === q.fieldKey` from this
  // render's closure and would commit the draft the rep just abandoned. Only
  // a ref changes before the blur is dispatched.
  assert.match(src, /const abandoning = useRef\(false\)/)
  assert.match(src, /if \(abandoning\.current\) \{ abandoning\.current = false; return \}/)
  const esc = src.slice(src.indexOf("if (e.key === 'Escape')"))
  const flagAt = esc.indexOf('abandoning.current = true')
  const blurAt = esc.indexOf('.blur()')
  assert.ok(flagAt > -1 && flagAt < blurAt, 'the flag must be set before blur() fires')
})

test('the ref sits above the early return', () => {
  // A hook after a conditional return runs in a different order on the
  // renders that take it.
  assert.ok(
    src.indexOf('const abandoning = useRef(false)') < src.indexOf('if (qualification.length === 0) return null'),
    'useRef is below the early return'
  )
})
