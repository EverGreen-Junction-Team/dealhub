// What a note row shows after a save.
//
// Reported: renaming a note sent {"title":"test4"}, the row kept showing the
// OLD heading, and the preview looked unchanged. The PATCH was correct and
// the server stored it — the bug was in what the UI did with the response.
//
// GHL's note PUT does not reliably echo every field it was sent. Both rails
// patched their row with `saved.title ?? null`, so an omitted title BLANKED
// the name the rep had just typed and the old body-derived heading
// reappeared. `body` survived only because it fell back to the row's own
// value rather than to null.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const editor = readFileSync(new URL('../NoteEditor.jsx', import.meta.url), 'utf8')
const notesTab = readFileSync(new URL('../../tabs/NotesTab.jsx', import.meta.url), 'utf8')
const rail = readFileSync(new URL('../../dealhub/DealTasksSection.jsx', import.meta.url), 'utf8')

test('the editor tells callers every field it applied', () => {
  // It used to pass only businessId. Those are the fields we SENT, so they
  // are the only ones we can speak for when the CRM stays silent.
  assert.match(editor, /\{ \.\.\.changes \}/)
})

test('neither rail blanks a field the CRM did not echo', () => {
  for (const [name, src] of [['NotesTab', notesTab], ['the deal rail', rail]]) {
    assert.ok(
      !/title: saved\.title \?\? null/.test(src),
      `${name} must not fall back to null for title`
    )
    assert.match(src, /title: applied\?\.title \?\? saved\.title \?\? editor\.note\.title/,
      `${name} should prefer what was applied`)
  }
})

test('the deal rail actually receives the applied values', () => {
  // It took only (saved) — the second argument was there and ignored.
  assert.match(rail, /onSaved=\{\(saved, applied\) =>/)
})

// ── The fallback chain itself ────────────────────────────────────────
// Modelled directly, because the ordering is the whole fix.
const resolve = (applied, saved, row) => applied?.title ?? saved.title ?? row.title ?? null

test('a rename survives a silent CRM response', () => {
  assert.equal(resolve({ title: 'test4' }, {}, { title: 'old' }), 'test4')
})

test('a rename survives an echoing CRM response', () => {
  assert.equal(resolve({ title: 'test4' }, { title: 'test4' }, { title: 'old' }), 'test4')
})

test('a deliberate CLEAR still clears', () => {
  // ?? passes '' through — only null/undefined fall to the next source. If
  // this used || the rep could never remove a title.
  assert.equal(resolve({ title: '' }, {}, { title: 'old' }), '')
})

test('an untouched title is left alone on a body-only edit', () => {
  assert.equal(resolve({ body: 'new' }, { body: 'new' }, { title: 'old' }), 'old')
})
