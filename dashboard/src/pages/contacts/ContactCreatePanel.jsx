import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Select } from 'antd'
import { contactsAPI } from '../../api/contacts'
import { dealsAPI } from '../../api/deals'

// "Add contact" — a small form over the list, writing through
// POST /api/contacts. It replaces a button that only said contacts were
// added in the CRM; the create API has existed server-side (createGhlContact)
// and the route now lands the row locally, so the list shows the new person
// the moment this closes.
//
// GHL's own rule, applied before the request: a contact needs at least one
// of a name, an email or a phone. Owner and type are optional and go in the
// same create call — a second PATCH to set them would fire a second webhook
// and race the first.
const TYPES = [{ value: 'lead', label: 'Lead' }, { value: 'customer', label: 'Customer' }]

export default function ContactCreatePanel({ onCreated, onClose }) {
  const [firstName, setFirstName] = useState('')
  const [lastName, setLastName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [type, setType] = useState(null)
  const [assignedTo, setAssignedTo] = useState(null)
  const [users, setUsers] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errorField, setErrorField] = useState(null)
  const firstRef = useRef(null)

  useEffect(() => { firstRef.current?.focus() }, [])
  useEffect(() => {
    let alive = true
    dealsAPI.users()
      .then((r) => { if (alive) setUsers(r?.users || []) })
      .catch(() => { if (alive) setUsers([]) })
    return () => { alive = false }
  }, [])
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const ready = !!(firstName.trim() || lastName.trim() || email.trim() || phone.trim())

  const create = async () => {
    if (!ready || saving) return
    setSaving(true); setError(null); setErrorField(null)
    try {
      const res = await contactsAPI.create({
        ...(firstName.trim() ? { firstName: firstName.trim() } : {}),
        ...(lastName.trim() ? { lastName: lastName.trim() } : {}),
        ...(email.trim() ? { email: email.trim() } : {}),
        ...(phone.trim() ? { phone: phone.trim() } : {}),
        ...(type ? { contactType: type } : {}),
        ...(assignedTo ? { assignedTo } : {})
      })
      onCreated && onCreated(res?.contact || null)
    } catch (err) {
      setError(err?.message || 'Could not create the contact — try again.')
      setErrorField(err?.field || null)
      setSaving(false)
    }
  }

  const input = (key, value, set, placeholder, inputType = 'text', ref) => (
    <input
      ref={ref}
      type={inputType}
      value={value}
      onChange={(e) => set(e.target.value)}
      onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); create() } }}
      placeholder={placeholder}
      disabled={saving}
      style={{
        width: '100%', boxSizing: 'border-box', height: 38, padding: '0 12px',
        border: `1px solid ${errorField === key ? 'var(--status-stuck)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-md)', background: '#fff', outline: 'none',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--text-heading)'
      }}
    />
  )

  return createPortal(
    <div
      className="pp-portal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(23, 33, 46, 0.45)'
      }}
    >
      <div
        role="dialog"
        aria-label="Add contact"
        style={{
          width: 'min(560px, calc(100vw - 32px))',
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          overflow: 'hidden'
        }}
      >
        <div style={{
          display: 'flex', alignItems: 'center', gap: 9,
          padding: '14px 18px',
          borderBottom: '1px solid var(--border-default)'
        }}>
          <span className="ms" style={{ fontSize: 20, color: 'var(--accent-sky-text)' }}>person_add</span>
          <h2 style={{ margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600, color: 'var(--text-heading)' }}>
            Add contact
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              marginLeft: 'auto', width: 30, height: 30, border: 'none', background: 'none',
              color: 'var(--text-muted)', cursor: 'pointer', display: 'inline-flex',
              alignItems: 'center', justifyContent: 'center'
            }}
          >
            <span className="ms" style={{ fontSize: 18 }}>close</span>
          </button>
        </div>

        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 14,
          padding: 18
        }}>
          <Field label="First name">{input('firstName', firstName, setFirstName, 'Alex', 'text', firstRef)}</Field>
          <Field label="Last name">{input('lastName', lastName, setLastName, 'Morgan')}</Field>
          <Field label="Email">{input('email', email, setEmail, 'alex@example.com', 'email')}</Field>
          <Field label="Phone">{input('phone', phone, setPhone, '+44 7700 900123', 'tel')}</Field>
          <Field label="Type">
            <Select
              value={type}
              onChange={setType}
              allowClear
              placeholder="Lead or customer"
              options={TYPES}
              popupClassName="pp-menu"
              style={{ width: '100%' }}
              styles={{ root: { height: 38 } }}
              disabled={saving}
            />
          </Field>
          <Field label="Owner">
            <Select
              value={assignedTo}
              onChange={setAssignedTo}
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder={users === null ? 'Loading…' : 'Unassigned'}
              loading={users === null}
              options={(users || []).map((u) => ({ value: u.id, label: u.name || u.email || u.id }))}
              popupClassName="pp-menu"
              style={{ width: '100%' }}
              styles={{ root: { height: 38 } }}
              disabled={saving}
            />
          </Field>
        </div>

        {error && (
          <p style={{
            margin: '0 18px 12px', padding: '9px 12px',
            borderLeft: '3px solid var(--status-stuck)', background: 'var(--tint-rose)',
            fontSize: 'var(--text-base)', color: 'var(--status-stuck-text)'
          }}>
            {error}
          </p>
        )}

        <div style={{
          display: 'flex', alignItems: 'center', justifyContent: 'flex-end', gap: 8,
          padding: '12px 18px',
          borderTop: '1px solid var(--border-default)', background: 'var(--gray-25)'
        }}>
          {!ready && (
            <span style={{ marginRight: 'auto', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
              A name, email or phone is needed.
            </span>
          )}
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              height: 36, padding: '0 14px', border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-pill)', background: '#fff',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--text-body)',
              cursor: 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!ready || saving}
            style={{
              height: 36, padding: '0 16px', border: 'none',
              borderRadius: 'var(--radius-pill)',
              background: ready ? 'var(--brand-primary)' : 'var(--gray-200)',
              color: ready ? '#fff' : 'var(--text-faint)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
              cursor: ready && !saving ? 'pointer' : 'default'
            }}
          >
            {saving ? 'Creating…' : 'Create contact'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  )
}

function Field({ label, children }) {
  return (
    <label style={{ display: 'grid', gap: 5, minWidth: 0 }}>
      <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      {children}
    </label>
  )
}
