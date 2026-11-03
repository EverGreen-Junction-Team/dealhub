import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useModal } from '../../hooks/useModal'
import { Input, Select } from 'antd'
import { businessesAPI } from '../../api/businesses'
import { countryOptions } from '../../constants/countries'

// Create or edit a business.
//
// Writes go to the CRM — see the server's ghlBusinessWrite.js. Three of their
// rules shape this form:
//
//   • NO WEBHOOKS EXIST for businesses. The server applies the echoed response
//     to our row itself, so a save shows up here immediately rather than at the
//     next nightly sync.
//
//   • DOMAIN IS UNIQUE PER LOCATION. Two businesses cannot share one, so the
//     current value is always shown and the server names the clashing business
//     rather than returning a bare rejection.
//
//   • A BUSINESS OVER 2000 CONTACTS CAN BE RENAMED ONCE A DAY. We cannot see
//     their contact count, so that surfaces as a save error, not a pre-check —
//     which is why the name field warns before it's touched on a large one.

// Ordered as the detail panel lays them out, so editing feels like the same
// screen rather than a different form.
// `group` splits eleven fields into three answerable questions. Eleven controls
// in one flat grid asked the rep to hold the whole form in their head; a
// postcode and a company name were weighted identically.
//
// The groups are the natural seams, not arbitrary thirds: who they are, how to
// reach them, where they are.
const FIELDS = [
  { name: 'name',        label: 'Company name', type: 'text',      required: true, group: 'Company' },
  { name: 'description', label: 'Description',  type: 'multiline', group: 'Company' },
  { name: 'website',     label: 'Website',      type: 'text',      placeholder: 'www.example.com', group: 'Company' },
  { name: 'domainname',  label: 'Domain',       type: 'text',      placeholder: 'example.com',
    hint: 'The bare domain — no https://. Only one business per domain.', group: 'Company' },
  { name: 'email',       label: 'Email',        type: 'text',      group: 'Contact' },
  { name: 'phone',       label: 'Phone',        type: 'text',      placeholder: '+44…', group: 'Contact' },
  { name: 'address',     label: 'Address',      type: 'text',      group: 'Address' },
  { name: 'city',        label: 'City',         type: 'text',      group: 'Address' },
  { name: 'state',       label: 'County / State', type: 'text',    group: 'Address' },
  { name: 'postalCode',  label: 'Postcode',     type: 'text',      group: 'Address' },
  { name: 'country',     label: 'Country',      type: 'country',   group: 'Address' }
]

// The shared list — GHL's own 247 countries, common ones grouped first. This
// file used to carry its own eleven, so the create form and the edit panel
// offered different countries for the same field.
//
// Built once at module scope: rebuilding 247 options per render made the
// dropdown stutter while typing.
const COUNTRY_OPTIONS = countryOptions()

// Contact count above which GHL rate-limits renames. Their number, not ours.
const RENAME_LIMIT_CONTACTS = 2000

export default function BusinessEditor({
  business = null,      // null = creating
  onClose,
  onSaved
}) {
  const editing = !!business

  const modalRef = useModal()

  const [values, setValues] = useState(() => {
    const seed = {}
    for (const f of FIELDS) seed[f.name] = business?.[f.name] || ''
    return seed
  })

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errorField, setErrorField] = useState(null)

  const firstRef = useRef(null)
  useEffect(() => {
    const t = window.setTimeout(() => firstRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [])

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])

  const set = (name, v) => setValues((prev) => ({ ...prev, [name]: v }))

  // Only what changed. Sending the whole record would overwrite a field someone
  // else edited in the CRM meanwhile — and on this endpoint it would also carry
  // locationId, which GHL rejects on an update.
  const changes = useMemo(() => {
    if (!editing) return null
    const out = {}
    for (const f of FIELDS) {
      const now = (values[f.name] || '').trim()
      const was = (business[f.name] || '').trim()
      if (now !== was) out[f.name] = now
    }
    return out
  }, [editing, business, values])

  // Renaming a big business is rate-limited by GHL to once a day. Warn while
  // it's still a keystroke away rather than after a failed save.
  const renameWarning = editing
    && changes?.name !== undefined
    && (business.contactCount || 0) > RENAME_LIMIT_CONTACTS

  const dirty = editing
    ? Object.keys(changes).length > 0
    : (values.name || '').trim().length > 0
  const canSave = !saving && dirty && (values.name || '').trim().length > 0

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    setErrorField(null)
    try {
      let res
      if (editing) {
        res = await businessesAPI.update(business.id, changes)
      } else {
        // Drop empties on create — sending "" for every untouched field would
        // store a record full of blank strings rather than nulls.
        const body = {}
        for (const f of FIELDS) {
          const v = (values[f.name] || '').trim()
          if (v) body[f.name] = v
        }
        res = await businessesAPI.create(body)
      }
      onSaved(res.business || null)
      onClose()
    } catch (err) {
      setError(err.message || 'Could not save that — try again')
      setErrorField(err.data?.field || null)
      setSaving(false)
    }
  }

  return (
    <div
      className="pp-backdrop"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div
        // Scroll lock + focus trap, shared by every dialog. Escape stays
        // with each component: theirs is guarded against mid-save.
        ref={modalRef}
        className="pp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit business' : 'New business'}
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); save() }
        }}
        // Widest of the five — it carries the most fields, including the
        // country picker and a full address block.
        // maxHeight/flex now come from .pp-modal, which caps every dialog at
        // the viewport rather than only this one.
        style={{ width: 'min(680px, 100%)' }}
      >
        <header
          className="pp-modal-head"
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          {/* Badged icon, not a tinted band — colour now means only
              one thing in a dialog header, and that is danger. */}
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, flex: 'none',
              borderRadius: 'var(--radius-md)',
              background: 'var(--tint-sky)'
            }}
          >
            <span className="ms" style={{ fontSize: 18, color: 'var(--accent-sky-text)' }}>
              domain
            </span>
          </span>
          <h2 className="pp-modal-title" style={{ flex: 1 }}>
            {editing ? 'Edit business' : 'New business'}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            title="Close"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 26, height: 26,
              borderRadius: 'var(--radius-md)',
              border: '1px solid var(--border-default)',
              background: 'var(--surface-card)',
              cursor: saving ? 'default' : 'pointer',
              color: 'var(--text-muted)'
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>close</span>
          </button>
        </header>

        <div
          className="pp-modal-body"
          style={{
            flex: 1,
            display: 'grid', gap: 'var(--space-3)',
            gridTemplateColumns: 'repeat(auto-fit, minmax(260px, 1fr))',
            padding: 'var(--space-4)'
          }}
        >
          {FIELDS.map((f, i) => {
            const wide = f.type === 'multiline'
            // A rule whenever the group changes — not before the first, which
            // would put a heading directly under the modal's own title.
            const newGroup = i > 0 && f.group !== FIELDS[i - 1].group
            return (
              <React.Fragment key={f.name}>
              {newGroup && (
                <div
                  style={{
                    gridColumn: '1 / -1',
                    display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                    marginTop: 'var(--space-1)'
                  }}
                >
                  {/* Same sizing as .pp-label so the group heading and the
                      field labels below it read as one system. Not the class
                      itself — that is display:block with a margin, and this
                      needs flex:none to sit beside its rule. */}
                  <span
                    style={{
                      flex: 'none',
                      fontSize: 'var(--text-sm)', fontWeight: 600,
                      letterSpacing: '0.05em',
                      textTransform: 'uppercase', color: 'var(--text-faint)'
                    }}
                  >
                    {f.group}
                  </span>
                  <span style={{ flex: 1, height: 1, background: 'var(--border-default)' }} />
                </div>
              )}
              <div style={{ minWidth: 0, gridColumn: wide ? '1 / -1' : undefined }}>
                <span className="pp-label">
                  {f.label}
                  {f.required && <span className="pp-req">*</span>}
                </span>

                {f.type === 'multiline' ? (
                  <Input.TextArea
                    value={values[f.name]}
                    onChange={(e) => set(f.name, e.target.value)}
                    rows={2}
                    status={errorField === f.name ? 'error' : undefined}
                  />
                ) : f.type === 'country' ? (
                  <Select
                    value={values[f.name] || undefined}
                    onChange={(v) => set(f.name, v || '')}
                    options={COUNTRY_OPTIONS}
                    placeholder="Not set"
                    allowClear
                    showSearch
                    // "United Kingdom (GB)" is the label, so this one prop
                    // searches the name AND the code.
                    optionFilterProp="label"
                    popupClassName="pp-menu"
                    listHeight={280}
                    notFoundContent="No country matches that"
                    style={{ width: '100%' }}
                    status={errorField === f.name ? 'error' : undefined}
                  />
                ) : (
                  <Input
                    ref={i === 0 ? firstRef : undefined}
                    value={values[f.name]}
                    onChange={(e) => set(f.name, e.target.value)}
                    placeholder={f.placeholder}
                    status={errorField === f.name ? 'error' : undefined}
                  />
                )}

                {f.hint && errorField !== f.name && (
                  <span
                    style={{
                      display: 'block', marginTop: 4,
                      fontSize: 'var(--text-sm)', color: 'var(--text-faint)'
                    }}
                  >
                    {f.hint}
                  </span>
                )}
                {errorField === f.name && (
                  <span
                    style={{
                      display: 'block', marginTop: 4,
                      fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)'
                    }}
                  >
                    {error}
                  </span>
                )}
              </div>
              </React.Fragment>
            )
          })}

          {renameWarning && (
            <div
              style={{
                gridColumn: '1 / -1',
                display: 'flex', alignItems: 'flex-start', gap: 7,
                padding: '9px 11px',
                border: '1px solid var(--status-working)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--tint-gold)',
                fontSize: 'var(--text-md)', color: 'var(--accent-gold-text)'
              }}
            >
              <span className="ms" style={{ fontSize: 16, flex: 'none', marginTop: 1 }}>schedule</span>
              This business has over {RENAME_LIMIT_CONTACTS.toLocaleString()} contacts,
              so its name can only be changed once a day.
            </div>
          )}

          {error && !errorField && (
            <div
              style={{
                gridColumn: '1 / -1',
                display: 'flex', alignItems: 'flex-start', gap: 7,
                padding: '9px 11px',
                border: '1px solid var(--status-stuck)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--tint-rose)',
                fontSize: 'var(--text-md)', color: 'var(--status-stuck-text)'
              }}
            >
              <span className="ms" style={{ fontSize: 16, flex: 'none', marginTop: 1 }}>error</span>
              {error}
            </div>
          )}
        </div>

        <footer
          className="pp-modal-foot"
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            flex: 'none',
            borderTop: '1px solid var(--border-default)'
          }}
        >
          <span className="pp-modal-status">
            {saving ? 'Saving to your CRM…' : editing && !dirty ? 'No changes yet' : '⌘↵ to save'}
          </span>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              height: 32, padding: '0 14px',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: '#fff',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              color: 'var(--text-body)',
              cursor: saving ? 'default' : 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={save}
            disabled={!canSave}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 7,
              height: 32, padding: '0 16px',
              border: 'none', borderRadius: 'var(--radius-md)',
              background: canSave ? 'var(--brand-primary)' : 'var(--gray-200)',
              color: canSave ? '#fff' : 'var(--text-faint)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
              cursor: canSave ? 'pointer' : 'default'
            }}
          >
            {saving && (
              <span className="ms pp-spin" style={{ fontSize: 15 }}>progress_activity</span>
            )}
            {saving ? 'Saving' : editing ? 'Save changes' : 'Create business'}
          </button>
        </footer>
      </div>
    </div>
  )
}
