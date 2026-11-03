import React, { useEffect, useMemo, useRef, useState } from 'react'
import { initialsFor } from '../shared/ListChrome'

// The @-menu in the internal-comment composer: the sub-account's users, as
// GHL's own comment box offers them. Same keyboard protocol as SkillMentions
// — the textarea keeps the caret and relays arrows and Enter through the
// 'pp-mention-key' window event — so a rep who knows one menu knows both.
export default function UserMentions({ users, loading, query, onPick, onClose, anchorRef }) {
  const [active, setActive] = useState(0)
  const listRef = useRef(null)

  const matches = useMemo(() => {
    const q = (query || '').trim().toLowerCase()
    if (!q) return users
    const words = q.split(/\s+/).filter(Boolean)
    return users.filter((u) => {
      const hay = `${u.name || ''} ${u.email || ''}`.toLowerCase()
      return words.every((w) => hay.includes(w))
    })
  }, [users, query])

  useEffect(() => { setActive(0) }, [query, users.length])

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
    listRef.current?.querySelector('[data-active="true"]')?.scrollIntoView({ block: 'nearest' })
  }, [active])

  useEffect(() => {
    const onDown = (e) => {
      if (anchorRef?.current && !anchorRef.current.contains(e.target)) onClose()
    }
    document.addEventListener('mousedown', onDown)
    return () => document.removeEventListener('mousedown', onDown)
  }, [anchorRef, onClose])

  const note = (children) => (
    <div style={{ padding: '12px 14px', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{children}</div>
  )

  return (
    <div
      role="listbox"
      aria-label="Mention a team member"
      style={{
        position: 'absolute', bottom: 'calc(100% + 8px)', left: 0,
        width: 'min(360px, 100%)', zIndex: 60,
        background: 'var(--surface-raised, #fff)',
        border: '1px solid var(--border-default)',
        borderRadius: 10, boxShadow: '0 10px 30px rgba(0,0,0,0.13)', overflow: 'hidden'
      }}
    >
      {loading ? note('Loading team…')
        : users.length === 0 ? note('No team members found.')
          : matches.length === 0 ? note(<>Nobody matches “{query}”.</>)
            : (
              <ul ref={listRef} style={{ listStyle: 'none', margin: 0, padding: 4, maxHeight: 280, overflowY: 'auto' }}>
                {matches.map((u, i) => (
                  <li key={u.id}>
                    <button
                      type="button"
                      data-active={i === active ? 'true' : 'false'}
                      onMouseDown={(e) => { e.preventDefault(); onPick(u) }}
                      onMouseEnter={() => setActive(i)}
                      style={{
                        display: 'flex', alignItems: 'center', gap: 12, width: '100%',
                        padding: '8px 10px', border: 0, textAlign: 'left', cursor: 'pointer',
                        borderRadius: 8, background: i === active ? 'var(--tint-sky)' : 'transparent',
                        fontFamily: 'var(--font-sans)'
                      }}
                    >
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 36, height: 36, flex: 'none', borderRadius: '50%',
                        background: 'var(--tint-plum)', color: 'var(--accent-plum-text)',
                        fontSize: 'var(--text-sm)', fontWeight: 600
                      }}>
                        {initialsFor(u.name || u.email || '?')}
                      </span>
                      <span style={{ minWidth: 0, display: 'flex', flexDirection: 'column' }}>
                        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-heading)', fontWeight: 500, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {u.name}
                        </span>
                        {u.email && (
                          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                            {u.email}
                          </span>
                        )}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
    </div>
  )
}
