import React, { useEffect, useMemo, useState } from 'react'
import { createPortal } from 'react-dom'
import { businessesAPI } from '../../api/businesses'
import { contactsAPI } from '../../api/contacts'

// Pick a business to link to a contact.
//
// SHARED by the Deal Hub's deal card and the contact record. A deal reaches
// a business only through its contacts (contacts.business_id, migration
// 056), so both surfaces are doing the same write and must not drift into
// two pickers with different rules.
//
// Searches OUR businesses table (GET /api/businesses?q=), the way the
// contact picker searches our contacts: it runs under RLS, so it can only
// ever offer this sub-account's businesses, and it costs no GHL call per
// keystroke.
//
// The write is PATCH /contacts/:id { businessId } — the contact patch, not a
// business one. There is no deal↔business endpoint to call, because GHL has
// no such link; the contact IS the link.
//
// `excludeIds` are businesses already linked here, filtered out so the
// commonest mistake — relinking the one already showing — cannot be clicked.
// `blurb` lets each caller say where the link will land, which differs: a
// deal links through its primary contact, a contact links directly.
export default function BusinessPickerModal({ contact, excludeIds = [], blurb, onClose, onLinked }) {
  const [q, setQ] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [picked, setPicked] = useState(null)

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const alreadyLinked = useMemo(() => new Set(excludeIds), [excludeIds])

  useEffect(() => {
    let alive = true
    setLoading(true)
    const t = window.setTimeout(() => {
      businessesAPI.list({ ...(q.trim() ? { q: q.trim() } : {}), limit: 20 })
        .then((r) => { if (alive) setResults((r?.businesses || []).filter((b) => !alreadyLinked.has(b.id))) })
        .catch(() => { if (alive) setResults([]) })
        .finally(() => { if (alive) setLoading(false) })
    }, 250)
    return () => { alive = false; window.clearTimeout(t) }
  }, [q, alreadyLinked])

  const link = async () => {
    if (!picked || saving) return
    setSaving(true)
    setError(null)
    try {
      await contactsAPI.update(contact.id, { businessId: picked.id })
      onLinked(picked)
    } catch (err) {
      setError(err.message || 'Could not link that business — try again')
      setSaving(false)
    }
  }

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Add a business"
      className="pp-portal"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 920,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15, 23, 42, 0.32)',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        padding: 16
      }}
    >
      <div style={{
        width: 'min(520px, 100%)', maxHeight: '80vh',
        background: '#fff',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-overlay)',
        display: 'grid', gridTemplateRows: 'auto auto 1fr auto',
        overflow: 'hidden'
      }}>
        <div style={{ padding: '18px 22px 10px' }}>
          <h2 style={{ margin: 0, fontSize: 'var(--text-lg)', fontWeight: 700, color: 'var(--text-heading)' }}>
            Add a business
          </h2>
          <p style={{ margin: '3px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {/* Says WHERE the link lands. From a deal, a rep expects to
                attach a business to the DEAL; GHL attaches it to the contact
                and the deal shows it through them. Spelling that out is what
                stops "why did it change on the contact too?" later. */}
            {blurb}
          </p>
        </div>

        <div style={{ padding: '0 22px 10px' }}>
          <input
            autoFocus
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder="Search businesses by name…"
            style={{
              width: '100%', height: 36, padding: '0 11px',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-sm)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              boxSizing: 'border-box'
            }}
          />
        </div>

        <div style={{ overflowY: 'auto', padding: '0 22px', minHeight: 120 }}>
          {loading && results.length === 0 && (
            <p style={{ margin: '12px 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>Searching…</p>
          )}
          {!loading && results.length === 0 && (
            <p style={{ margin: '12px 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
              {q.trim() ? 'No businesses match that.' : 'No businesses in this account yet.'}
            </p>
          )}
          {results.map((b) => {
            const on = picked?.id === b.id
            return (
              <button
                key={b.id}
                type="button"
                onClick={() => setPicked(on ? null : b)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 9, width: '100%',
                  padding: '9px 10px', marginBottom: 4, textAlign: 'left',
                  border: `1px solid ${on ? 'var(--accent-sky)' : 'var(--border-default)'}`,
                  borderRadius: 'var(--radius-sm)',
                  background: on ? 'var(--tint-sky)' : '#fff',
                  fontFamily: 'var(--font-sans)', cursor: 'pointer'
                }}
              >
                <span className="ms" style={{ fontSize: 17, color: 'var(--accent-sky-text)', flex: 'none' }}>domain</span>
                <span style={{ minWidth: 0, flex: 1 }}>
                  <span style={{ display: 'block', fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-heading)' }}>
                    {b.name}
                  </span>
                  {b.city && (
                    <span style={{ display: 'block', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>{b.city}</span>
                  )}
                </span>
                {on && <span className="ms" style={{ fontSize: 17, color: 'var(--accent-sky-text)' }}>check</span>}
              </button>
            )
          })}
        </div>

        <div style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 22px 16px',
          borderTop: '1px solid var(--border-default)'
        }}>
          {error && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)', flex: 1 }}>{error}</span>
          )}
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={onClose}
            disabled={saving}
            style={{
              height: 32, padding: '0 14px',
              border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)',
              background: '#fff', color: 'var(--text-heading)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={link}
            disabled={!picked || saving}
            style={{
              height: 32, padding: '0 14px',
              border: 'none', borderRadius: 'var(--radius-sm)',
              background: picked && !saving ? 'var(--accent-sky-text)' : 'var(--gray-200)',
              color: '#fff',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 600,
              cursor: picked && !saving ? 'pointer' : 'not-allowed'
            }}
          >
            {saving ? 'Linking…' : 'Link business'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}
