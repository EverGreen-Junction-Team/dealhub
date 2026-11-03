import React, { useEffect, useRef, useState } from 'react'
import { FieldRow } from './FieldCard'
import { contactsAPI } from '../../api/contacts'

// A contact field EDITED IN PLACE on the Deal hub (client request, Oct 2026).
//
// The pencils on the Customer band and the People cards used to open the
// contact's own record — a page away from the deal the rep was working on.
// Now the pencil turns the row's value into a text box: ✓ or Enter saves,
// ✕ or Esc cancels. The save is the same PATCH /api/contacts/:id the contact
// record makes, and `onSaved(contactId, patch)` lets the Deal hub repaint
// every copy of the contact (the Customer band and the People card read the
// same deal.people) without waiting for GHL's webhook.
//
// `field` is the key on our person object AND the patch key — every field
// used here (firstName, lastName, email, phone, address1, city, postalCode,
// state, country) is accepted under that name by contactPatch.js.

// The server's own email check, character for character — see ContactDetail.
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/

export default function EditableContactRow({
  contactId, field, icon, label, value, type = 'text', last, onSaved
}) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const input = useRef(null)

  useEffect(() => { if (editing && input.current) input.current.focus() }, [editing])

  const start = () => { setDraft(value || ''); setError(null); setEditing(true) }
  const cancel = () => { setEditing(false); setError(null) }

  const save = async () => {
    const next = draft.trim()
    if (next === (value || '')) { cancel(); return }
    if (type === 'email' && next && !EMAIL_RE.test(next)) {
      setError('That email address is not valid')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const res = await contactsAPI.update(contactId, { [field]: next })
      // GHL's echo first: it normalises some values on write ("+44 7700…"
      // comes back "+447700…"), and our copy should match what it stored.
      const echoed = res?.contact?.[field]
      onSaved && onSaved(contactId, { [field]: echoed !== undefined ? echoed : next })
      setEditing(false)
    } catch (err) {
      setError(err?.response?.data?.error || err?.message || 'Could not save that — try again')
    } finally {
      setSaving(false)
    }
  }

  if (!editing) {
    return (
      <FieldRow
        icon={icon}
        label={label}
        value={value}
        last={last}
        onEdit={contactId ? start : undefined}
        editTitle={`Edit ${String(label).toLowerCase()}`}
      />
    )
  }

  const btn = {
    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
    width: 24, height: 24, padding: 0, flex: 'none',
    border: '1px solid var(--border-default)', borderRadius: 6,
    background: '#fff', cursor: saving ? 'progress' : 'pointer'
  }

  return (
    <FieldRow
      icon={icon}
      label={label}
      last={last}
      control={(
        <span style={{ display: 'flex', alignItems: 'center', gap: 6, width: '100%', minWidth: 0 }}>
          <input
            ref={input}
            type={type}
            value={draft}
            disabled={saving}
            onChange={(e) => { setDraft(e.target.value); setError(null) }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); save() }
              if (e.key === 'Escape') { e.preventDefault(); cancel() }
            }}
            aria-label={label}
            aria-invalid={!!error}
            title={error || undefined}
            style={{
              flex: 1, minWidth: 0, height: 28, boxSizing: 'border-box',
              padding: '0 8px',
              border: `1px solid ${error ? 'var(--status-stuck)' : 'var(--border-strong)'}`,
              borderRadius: 6,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              color: 'var(--text-heading)', background: '#fff'
            }}
          />
          <button type="button" onClick={save} disabled={saving} title="Save" aria-label="Save"
            style={{ ...btn, color: 'var(--green-600)' }}>
            <span className="ms" style={{ fontSize: 16 }}>{saving ? 'progress_activity' : 'check'}</span>
          </button>
          <button type="button" onClick={cancel} disabled={saving} title="Cancel" aria-label="Cancel"
            style={{ ...btn, color: 'var(--text-muted)' }}>
            <span className="ms" style={{ fontSize: 16 }}>close</span>
          </button>
          {error && (
            <span role="alert" style={{
              flex: 'none', maxWidth: 180, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
              fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)'
            }}>
              {error}
            </span>
          )}
        </span>
      )}
    />
  )
}
