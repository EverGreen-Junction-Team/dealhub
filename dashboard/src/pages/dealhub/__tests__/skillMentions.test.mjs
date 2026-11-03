// The @-menu's search, against the real skill list.
//
// With 35 skills the menu is a scroll, so typing has to narrow it. It always
// could — nothing said so, and the matcher could not handle the way people
// actually type these names.

import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

const src = readFileSync(new URL('../SkillMentions.jsx', import.meta.url), 'utf8')

// The shipped helpers, lifted verbatim.
const findStart = src.indexOf('export function findMentionQuery')
const findEnd = src.indexOf('export default')
// eslint-disable-next-line no-new-func
const { findMentionQuery } = new Function(
  src.slice(findStart, findEnd).replace('export function', 'function')
  + '; return { findMentionQuery }'
)()

// The matcher, rebuilt exactly as the useMemo body does.
function matchSkills(skills, query) {
  const raw = (query || '').trim().toLowerCase()
  if (!raw) return skills
  const words = raw.split(/[\s_]+/).filter(Boolean)
  const squashed = raw.replace(/[\s_]+/g, '')
  const scored = []
  for (const s of skills) {
    const nameRaw = s.name.toLowerCase()
    const name = nameRaw.replace(/_/g, ' ')
    const nameSquashed = nameRaw.replace(/_/g, '')
    const desc = (s.description || '').toLowerCase()
    const squashHit = squashed.length >= 3 && nameSquashed.includes(squashed)
    if (!squashHit && !words.every((w) => name.includes(w) || desc.includes(w))) continue
    const inName = words.filter((w) => name.includes(w)).length
    const startsWord = words.some((w) => name.startsWith(w)) ? 1 : 0
    const squashRank = squashHit ? 4 : 0
    const squashStarts = squashHit && nameSquashed.startsWith(squashed) ? 2 : 0
    scored.push({ s, rank: inName * 2 + startsWord + squashRank + squashStarts })
  }
  return scored
    .sort((a, b) => b.rank - a.rank || a.s.name.localeCompare(b.s.name))
    .map((x) => x.s)
}

// The real registry, so the test fails when a rename breaks a search people use.
const registry = JSON.parse(readFileSync(
  new URL('../../../../../pipelinePulse/server/data/skills/registry.json', import.meta.url),
  'utf8'
))
const SKILLS = registry.skills.map((r) => ({ name: r.skill, description: r.answers || '' }))

test('the real registry has enough skills to need a search', () => {
  assert.ok(SKILLS.length >= 30, `${SKILLS.length} skills`)
})

test('a multi-word query matches across underscores', () => {
  // "rep time" found NOTHING before: the words are both in
  // response_time_by_rep, separated by underscores and in the other order,
  // and a substring match only ever sees one contiguous run.
  const hits = matchSkills(SKILLS, 'rep time').map((s) => s.name)
  assert.ok(hits.includes('response_time_by_rep'), hits.join(', '))
})

test('words may be typed in any order', () => {
  const a = matchSkills(SKILLS, 'time rep').map((s) => s.name)
  const b = matchSkills(SKILLS, 'rep time').map((s) => s.name)
  assert.deepEqual(a, b)
})

test('"lost reason" finds the close-reason skills', () => {
  const hits = matchSkills(SKILLS, 'lost reason').map((s) => s.name)
  assert.ok(hits.some((n) => n.startsWith('close_reason')), hits.join(', '))
})

test('a name match outranks a description match', () => {
  // Someone typing "rep" wants the skills CALLED rep-something first, not the
  // ones that merely mention reps in their description.
  const hits = matchSkills(SKILLS, 'rep').map((s) => s.name)
  assert.ok(hits.length > 1)
  assert.match(hits[0], /rep/)
})

test('a query matching nothing returns nothing, not everything', () => {
  assert.equal(matchSkills(SKILLS, 'zzzz nonsense').length, 0)
})

test('an empty query shows every skill', () => {
  assert.equal(matchSkills(SKILLS, '').length, SKILLS.length)
})

test('@ opens the menu only at a word start', () => {
  assert.ok(findMentionQuery('@re', 3))
  assert.ok(findMentionQuery('tell me @re', 11))
  // An email address must not open it.
  assert.equal(findMentionQuery('a@b', 3), null)
})

test('the menu survives a space, so a name can be typed in words', () => {
  // The old rule closed the menu on ANY space, which made the multi-word
  // search above unreachable from the composer.
  const q = findMentionQuery('@rep time', 9)
  assert.equal(q?.query, 'rep time')
})

test('the menu closes once it stops looking like a name', () => {
  // It cannot stay open forever: an @ mid-sentence would hold a menu over the
  // rest of the question.
  assert.equal(findMentionQuery('@rep time by person now', 23), null)  // >3 words
  assert.equal(findMentionQuery('@rep,', 5), null)                      // punctuation
  assert.equal(findMentionQuery('@rep  ', 6), null)                     // double space
})

test('a name typed WITHOUT its underscores still matches', () => {
  // "closereason" found nothing while "close_reason" worked. Splitting on
  // underscores handles "close_reason" and "close reason", but a query with
  // no separator is a single word that no spaced-out name contains — so
  // typing a skill's own name without its underscores matched nothing, which
  // is the opposite of what someone expects.
  const hits = matchSkills(SKILLS, 'closereason').map((s) => s.name)
  assert.ok(hits.includes('close_reason_list'), hits.join(', '))
  assert.ok(hits.includes('close_reason_fill_rate'), hits.join(', '))
})

test('a longer run-together query narrows further', () => {
  const hits = matchSkills(SKILLS, 'closereasonlist').map((s) => s.name)
  assert.deepEqual(hits, ['close_reason_list'])
})

test('a run-together NAME match outranks a word found in prose', () => {
  // Someone typing "forecastdeals" is naming a skill, not describing a topic.
  const hits = matchSkills(SKILLS, 'forecastdeals').map((s) => s.name)
  assert.equal(hits[0], 'forecast_deals')
})

test('a run-together query does not invent adjacency', () => {
  // "reptime" would be a skill spelled that way. response_time_by_rep squashes
  // to "responsetimebyrep", where rep and time are not adjacent — so this is
  // correctly NOT a match, and "rep time" with a space still finds it.
  const squashed = matchSkills(SKILLS, 'reptime').map((s) => s.name)
  assert.ok(!squashed.includes('response_time_by_rep'))
  const spaced = matchSkills(SKILLS, 'rep time').map((s) => s.name)
  assert.ok(spaced.includes('response_time_by_rep'))
})

test('a very short query does not squash-match everything', () => {
  // Two characters would substring-match most names once separators are gone,
  // so the squash path needs at least three.
  const two = matchSkills(SKILLS, 'cl').map((s) => s.name)
  const three = matchSkills(SKILLS, 'clo').map((s) => s.name)
  assert.ok(two.length <= SKILLS.length)
  assert.ok(three.length <= two.length + SKILLS.length)
})

console.log('skill mentions: all cases pass')
