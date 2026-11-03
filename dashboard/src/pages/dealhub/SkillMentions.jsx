import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Truncate } from '../shared/ListChrome'

// The @-menu in the Insights AI composer.
//
// Typing @ offers the skills this sub-account has saved — a skill being a
// database view someone exposed to the AI. Picking one inserts its name as
// plain text; the model reads "@quiet_deals_by_rep" in the question and
// reaches for that tool. Nothing is wired behind the mention: it is a strong
// hint in the question, not a separate instruction channel. That matters —
// the AI can still use a skill without being asked, and can still ignore a
// mention that does not fit what was asked.
//
// WHY IT SHOWS "NO SKILLS" RATHER THAN NOTHING. An @ that silently does
// nothing reads as a broken feature. Saying the list is empty, and where they
// come from, turns a dead keystroke into an answer.
//
// INSIGHTS AI ONLY. Deal AI's answer path is a single schema-constrained call
// with no tool support, so a skill cannot run there. Mounting this in that
// composer would offer a menu of things that silently do nothing.

// The @ that opens the menu must start a word — an email address typed into
// the box should not trigger it.
export function findMentionQuery(text, caret) {
  if (caret == null) return null
  const upto = text.slice(0, caret)
  const at = upto.lastIndexOf('@')
  if (at === -1) return null
  const before = at === 0 ? '' : upto[at - 1]
  if (before && !/\s/.test(before)) return null
  const query = upto.slice(at + 1)
  // A space no longer closes the menu outright — skill names are several words
  // ("response time by rep"), and refusing any space meant the multi-word
  // search below could never receive a multi-word query.
  //
  // But it cannot stay open forever either: an @ typed mid-sentence would hold
  // a menu over the rest of the question. So it closes once the query stops
  // looking like a name being typed — more than three words, or any word that
  // ends with sentence punctuation.
  const words = query.split(/\s+/)
  if (words.length > 3) return null
  if (/[.,;:!?]\s*$/.test(query)) return null
  // A trailing double space is a deliberate "I am done with the mention".
  if (/\s\s$/.test(query)) return null
  return { start: at, query }
}

export default function SkillMentions({
  skills, loading, query, onPick, onClose, anchorRef
}) {
  const [active, setActive] = useState(0)
  const listRef = useRef(null)

  const matches = useMemo(() => {
    const raw = (query || '').trim().toLowerCase()
    if (!raw) return skills

    // EVERY WORD must appear somewhere, not the phrase as a substring.
    //
    // Skill names are snake_case, so a plain `includes` only ever matched one
    // contiguous run of a name: "rep" found six skills, but "rep time" found
    // NONE — the words are there, separated by an underscore and in the other
    // order. Same for "lost reason" against close_reason_list. A rep typing
    // what they want in their own words got an empty menu and concluded the
    // skill did not exist.
    //
    // Underscores are flattened to spaces so a word can match across them, and
    // the description is searched too — "money" finds nothing in any name but
    // sits in several descriptions.
    const words = raw.split(/[\s_]+/).filter(Boolean)
    // The query with every separator removed, for the case where someone
    // types the name as one run: "closereason" for close_reason_list.
    //
    // Splitting on underscores handles "close_reason" and "close reason", but
    // a query with NO separator is a single word that no spaced-out name
    // contains — so typing the skill's own name without its underscores
    // matched nothing, which is the opposite of what a reader expects.
    const squashed = raw.replace(/[\s_]+/g, '')

    const scored = []
    for (const s of skills) {
      const nameRaw = s.name.toLowerCase()
      const name = nameRaw.replace(/_/g, ' ')
      // Both sides stripped, so separators stop mattering in either direction.
      const nameSquashed = nameRaw.replace(/_/g, '')
      const desc = (s.description || '').toLowerCase()

      const squashHit = squashed.length >= 3 && nameSquashed.includes(squashed)
      if (!squashHit && !words.every((w) => name.includes(w) || desc.includes(w))) continue
      // A name match beats a description one: someone typing "rep" wants the
      // skills CALLED rep-something before the ones that merely mention reps.
      const inName = words.filter((w) => name.includes(w)).length
      const startsWord = words.some((w) => name.startsWith(w)) ? 1 : 0
      // A run-together match on the NAME outranks a word found in prose:
      // someone typing "closereason" is naming a skill, not describing a
      // topic, so the skills actually called that belong at the top.
      const squashRank = squashHit ? 4 : 0
      const squashStarts = squashHit && nameSquashed.startsWith(squashed) ? 2 : 0
      scored.push({ s, rank: inName * 2 + startsWord + squashRank + squashStarts })
    }
    return scored
      .sort((a, b) => b.rank - a.rank || a.s.name.localeCompare(b.s.name))
      .map((x) => x.s)
  }, [skills, query])

  // Reset the highlight whenever the list changes under it, or the keyboard
  // selection points at a row that is no longer there.
  useEffect(() => { setActive(0) }, [query, skills.length])

  // Arrow keys and Enter are handled on the TEXTAREA (it keeps focus), and
  // relayed here through a window event so this component owns the list
  // behaviour without stealing the caret.
  useEffect(() => {
    const onKey = (e) => {
      if (!matches.length) return
      if (e.detail === 'down') setActive((i) => (i + 1) % matches.length)
      if (e.detail === 'up')   setActive((i) => (i - 1 + matches.length) % matches.length)
      if (e.detail === 'pick') onPick(matches[active])
    }
    window.addEventListener('pp-mention-key', onKey)
    return () => window.removeEventListener('pp-mention-key', onKey)
  }, [matches, active, onPick])

  useEffect(() => {
    const el = listRef.current?.querySelector('[data-active="true"]')
    el?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    const onDown = (e) => {
      if (anchorRef?.current && !anchorRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [anchorRef, onClose])

  return (
    <div
      role="listbox"
      aria-label="Skills"
      style={{
        position: 'absolute', bottom: 'calc(100% + 8px)', left: 0, right: 0,
        maxWidth: 460, zIndex: 60,
        background: 'var(--surface-raised, #fff)',
        border: '1px solid var(--border-default)',
        borderRadius: 10,
        boxShadow: '0 10px 30px rgba(0,0,0,0.13)',
        overflow: 'hidden'
      }}
    >
      {/* The header doubles as the search box.
          Typing after the @ has always filtered this list, but nothing said
          so — the menu opened as 35 alphabetical rows and the only visible
          affordance was the scrollbar, so a rep scrolled to find
          "@response_time_by_rep" instead of typing "resp". A real input would
          steal the caret from the textarea (which owns the arrow keys and
          Enter), so this MIRRORS what has been typed rather than accepting
          input of its own. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 7,
        padding: '7px 12px',
        borderBottom: '1px solid var(--border-default)',
        fontSize: 'var(--text-xs)', fontWeight: 600,
        letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
        color: 'var(--text-muted)'
      }}>
        <span className="ms" style={{ fontSize: 14, textTransform: 'none' }}>search</span>
        <span>Skills</span>
        {query ? (
          <span style={{
            textTransform: 'none', letterSpacing: 0, fontWeight: 500,
            color: 'var(--text-body)'
          }}>
            “{query}”
          </span>
        ) : (
          <span style={{
            textTransform: 'none', letterSpacing: 0, fontWeight: 400,
            color: 'var(--text-faint)'
          }}>
            — type to filter
          </span>
        )}
        <span style={{ flex: 1 }} />
        {!loading && skills.length > 0 && (
          <span style={{
            textTransform: 'none', letterSpacing: 0, fontWeight: 500,
            fontVariantNumeric: 'tabular-nums', color: 'var(--text-faint)'
          }}>
            {matches.length}/{skills.length}
          </span>
        )}
      </div>

      {loading ? (
        <Note>Loading…</Note>
      ) : skills.length === 0 ? (
        // The empty state carries the explanation. A rep who types @ and sees
        // "no skills" with no context types it again expecting something else.
        <Note>
          <strong style={{ color: 'var(--text-body)' }}>No skills yet.</strong>
          <br />
          A skill lets the AI answer from one of your own data views. They are
          added in the Control panel.
        </Note>
      ) : matches.length === 0 ? (
        <Note>Nothing matches “{query}”.</Note>
      ) : (
        <ul ref={listRef} style={{
          listStyle: 'none', margin: 0, padding: 4,
          maxHeight: 264, overflowY: 'auto'
        }}>
          {matches.map((s, i) => (
            <li key={s.name}>
              <button
                type="button"
                data-active={i === active}
                role="option"
                aria-selected={i === active}
                // onMouseDown, not onClick: the textarea loses focus on
                // mousedown, which closes the menu before a click ever lands.
                onMouseDown={(e) => { e.preventDefault(); onPick(s) }}
                onMouseEnter={() => setActive(i)}
                style={{
                  display: 'block', width: '100%', textAlign: 'left',
                  padding: '7px 9px', border: 'none', borderRadius: 7,
                  background: i === active ? 'var(--surface-hover, #f2f4f3)' : 'transparent',
                  cursor: 'pointer', fontFamily: 'var(--font-sans)'
                }}
              >
                <span style={{
                  display: 'block',
                  fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
                  fontWeight: 600, color: 'var(--text-heading)'
                }}>
                  @{s.name}
                </span>
                <Truncate style={{ display: 'block', marginTop: 1,
                  fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  {s.description}
                </Truncate>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function Note({ children }) {
  return (
    <p style={{
      margin: 0, padding: '12px 13px',
      fontSize: 'var(--text-sm)', lineHeight: 1.5, color: 'var(--text-muted)'
    }}>
      {children}
    </p>
  )
}
