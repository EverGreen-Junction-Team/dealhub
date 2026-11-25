import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Select } from 'antd'
import { CloseOutlined, DollarOutlined, ApartmentOutlined } from '@ant-design/icons'
import RemotePicker from '../shared/RemotePicker'
import { searchDeals } from '../../hooks/useLinkTargets'
import { useModal } from '../../hooks/useModal'
import { appointmentsAPI } from '../../api/appointments'
import { inZone } from '../../utils/calendarTime'

// What a booking is linked to: its DEAL, and the custom object records on its
// customer. Opened from the card's ⋯ menu.
//
// ── TWO KINDS OF LINK, STORED IN TWO PLACES ──────────────────────────
//
// The DEAL is Deal Hub's own: GHL has no field joining an appointment to an
// opportunity, so the choice is kept in our database and the sync is told to
// leave it alone (migration 145). It shows here, on the board and in the hover
// card; GHL never sees it.
//
// RECORDS are GHL's: a custom object relation can point at a contact but not
// at an appointment, so linking one here links it to the CUSTOMER — and it
// shows on that contact in GHL too. The dialog says so, because "I linked it
// to Tuesday's visit" and "it is on the customer" are not the same claim.
//
// Records are fetched when the dialog opens and never on hover: each one is a
// request to GHL, and a board of forty cards must not cost forty of them.

export default function AppointmentLinks({ appointment, zone, onClose, onDealSaved }) {
  const a = appointment
  const modalRef = useModal()
  const contactId = a.contactId || null

  // ── Deal ──────────────────────────────────────────────────────────
  const [dealId, setDealId] = useState(a.dealId || null)
  const [dealLabel, setDealLabel] = useState(a.dealName || null)
  const [savingDeal, setSavingDeal] = useState(false)
  const [dealError, setDealError] = useState(null)
  const dealChanged = (dealId || null) !== (a.dealId || null)
  const dealSeed = useMemo(
    () => (a.dealId ? [{ value: a.dealId, label: a.dealName || 'This deal' }] : []),
    [a.dealId, a.dealName]
  )
  const searchCustomerDeals = useCallback((q) => searchDeals(q, { contactId }), [contactId])

  const saveDeal = async (body) => {
    setSavingDeal(true)
    setDealError(null)
    try {
      const res = await appointmentsAPI.setDeal(a.id, body)
      onDealSaved?.(a, res, body.mode === 'auto'
        ? 'Deal will follow the automatic link again'
        : body.dealId ? `Linked to ${res?.deal?.name || dealLabel || 'the deal'}` : 'Deal unlinked')
    } catch (err) {
      setDealError(err.message)
    } finally {
      setSavingDeal(false)
    }
  }

  // ── Records ───────────────────────────────────────────────────────
  const [records, setRecords] = useState(
    { status: contactId ? 'loading' : 'none', objects: [], records: [], error: null }
  )
  const [objectKey, setObjectKey] = useState(null)
  const [recordId, setRecordId] = useState(null)
  const [linking, setLinking] = useState(false)
  const [recordError, setRecordError] = useState(null)
  const [removing, setRemoving] = useState(null)

  const loadRecords = useCallback(async () => {
    if (!contactId) {
      setRecords({ status: 'none', objects: [], records: [], error: null })
      return
    }
    try {
      const res = await appointmentsAPI.records(a.id)
      setRecords({ status: 'ok', objects: res?.objects || [], records: res?.records || [], error: null })
      setObjectKey((k) => k || res?.objects?.[0]?.key || null)
    } catch (err) {
      setRecords({ status: 'error', objects: [], records: [], error: err.message })
    }
  }, [a.id, contactId])

  useEffect(() => { loadRecords() }, [loadRecords])

  const searchObject = useCallback(
    (q) => (objectKey
      ? appointmentsAPI.searchRecords(objectKey, q).then((r) => r?.records || [])
      : Promise.resolve([])),
    [objectKey]
  )

  const link = async () => {
    if (!objectKey || !recordId) return
    setLinking(true)
    setRecordError(null)
    try {
      await appointmentsAPI.linkRecord(a.id, objectKey, recordId)
      setRecordId(null)
      await loadRecords()
    } catch (err) {
      setRecordError(err.message)
    } finally {
      setLinking(false)
    }
  }

  const unlink = async (r) => {
    setRemoving(r.relationId)
    setRecordError(null)
    try {
      await appointmentsAPI.unlinkRecord(a.id, r.relationId)
      await loadRecords()
    } catch (err) {
      setRecordError(err.message)
    } finally {
      setRemoving(null)
    }
  }

  const busy = savingDeal || linking || removing !== null
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !busy) onClose?.() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [busy, onClose])

  const who = a.contactName || a.title || 'This appointment'
  const when = a.startsAt ? inZone(a.startsAt, zone).format('ddd D MMM, HH:mm') : ''
  const chosenObject = records.objects.find((o) => o.key === objectKey)

  return (
    <div
      role="presentation"
      onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose?.() }}
      style={{ position: 'fixed', inset: 0, zIndex: 60, background: 'rgba(16,20,24,0.28)' }}
    >
      <style>{LINKS_CSS}</style>
      <div
        ref={modalRef}
        role="dialog"
        aria-modal="true"
        aria-label={`Links for ${who}`}
        className="pp-links"
        style={{
          position: 'absolute', top: '12%', left: '50%', transform: 'translateX(-50%)',
          width: 'min(480px, calc(100vw / var(--app-zoom) - 24px))',
          maxHeight: 'calc(80vh / var(--app-zoom))', overflowY: 'auto',
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-lg)',
          boxShadow: 'var(--shadow-overlay)',
          padding: 'var(--space-4) var(--space-5)'
        }}
      >
        <div style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
          <div style={{ flex: 1, minWidth: 0 }}>
            <div className="pp-links-title">{who}</div>
            {when && <div className="pp-links-sub">{when}</div>}
          </div>
          <button type="button" aria-label="Close" className="pp-links-x" onClick={onClose} disabled={busy}>
            <CloseOutlined />
          </button>
        </div>

        {/* ── Deal ─────────────────────────────────────────────── */}
        <section className="pp-links-section">
          <h3 className="pp-links-h"><DollarOutlined /> Deal</h3>
          {!contactId
            ? <p className="pp-links-note">This appointment has no customer, so it cannot be linked to a deal.</p>
            : (
              <>
                <RemotePicker
                  value={dealId}
                  onChange={(v, opt) => { setDealId(v); setDealLabel(opt?.label || null) }}
                  search={searchCustomerDeals}
                  seed={dealSeed}
                  placeholder="Choose one of this customer's deals"
                  noneText="This customer has no deals"
                  emptyText="None of this customer's deals match"
                  style={{ width: '100%' }}
                  disabled={savingDeal}
                />
                <p className="pp-links-note">
                  {a.dealPinned
                    ? 'Linked by hand in Deal Hub. Syncing from your CRM will not change it.'
                    : 'Linked automatically when the customer has one open deal. Choosing one here keeps it.'}
                </p>
                {dealError && <div className="pp-links-error" role="alert">{dealError}</div>}
                <div className="pp-links-actions">
                  {a.dealPinned && (
                    <Button size="small" type="text" disabled={savingDeal} onClick={() => saveDeal({ mode: 'auto' })}>
                      Use the automatic link
                    </Button>
                  )}
                  <Button
                    size="small"
                    type="primary"
                    loading={savingDeal}
                    disabled={!dealChanged}
                    onClick={() => saveDeal({ dealId: dealId || null })}
                  >
                    {dealId ? 'Save deal' : 'Remove deal'}
                  </Button>
                </div>
              </>
              )}
        </section>

        {/* ── Records ──────────────────────────────────────────── */}
        <section className="pp-links-section">
          <h3 className="pp-links-h"><ApartmentOutlined /> Records on this customer</h3>
          {records.status === 'none' && (
            <p className="pp-links-note">This appointment has no customer to link records to.</p>
          )}
          {records.status === 'loading' && <p className="pp-links-note">Loading…</p>}
          {records.status === 'error' && <div className="pp-links-error" role="alert">{records.error}</div>}
          {records.status === 'ok' && records.objects.length === 0 && (
            <p className="pp-links-note">
              Your CRM has no custom objects that can be linked to a contact.
            </p>
          )}
          {records.status === 'ok' && records.objects.length > 0 && (
            <>
              {records.records.length === 0
                ? <p className="pp-links-note">Nothing linked yet.</p>
                : (
                  <ul className="pp-links-list">
                    {records.records.map((r) => (
                      <li key={r.relationId}>
                        <span className="pp-links-kind">{r.objectLabel}</span>
                        <span className="pp-links-name">{r.label}</span>
                        <button
                          type="button"
                          className="pp-links-unlink"
                          aria-label={`Unlink ${r.label}`}
                          disabled={busy}
                          onClick={() => unlink(r)}
                        >
                          {removing === r.relationId ? 'Unlinking…' : 'Unlink'}
                        </button>
                      </li>
                    ))}
                  </ul>
                  )}

              <div className="pp-links-add">
                <Select
                  value={objectKey}
                  onChange={(k) => { setObjectKey(k); setRecordId(null) }}
                  options={records.objects.map((o) => ({ value: o.key, label: o.singular }))}
                  popupClassName="pp-menu"
                  style={{ width: 140, flex: 'none' }}
                  disabled={linking}
                />
                <RemotePicker
                  // Remounted per type so a search for Projects never shows
                  // under Sites.
                  key={objectKey || 'none'}
                  value={recordId}
                  onChange={(v) => setRecordId(v)}
                  search={searchObject}
                  placeholder={`Find a ${(chosenObject?.singular || 'record').toLowerCase()}`}
                  noneText={`No ${(chosenObject?.plural || 'records').toLowerCase()} yet`}
                  style={{ flex: 1, minWidth: 0 }}
                  disabled={linking}
                />
                <Button size="small" type="primary" loading={linking} disabled={!recordId} onClick={link}>
                  Link
                </Button>
              </div>
              <p className="pp-links-note">
                Linked to the customer in your CRM, so it also shows on their contact.
              </p>
            </>
          )}
          {recordError && <div className="pp-links-error" role="alert">{recordError}</div>}
        </section>
      </div>
    </div>
  )
}

const LINKS_CSS = `
.pp-links-title { font-size: var(--text-lg); font-weight: var(--weight-semibold); color: var(--text-heading); overflow-wrap: anywhere; }
.pp-links-sub { font-size: var(--text-sm); color: var(--text-muted); margin-top: 2px; }
.pp-links-x { border: none; background: none; cursor: pointer; color: var(--text-muted); padding: 4px; border-radius: var(--radius-sm); }
.pp-links-x:hover { background: var(--gray-100); color: var(--text-heading); }
.pp-links-section { margin-top: var(--space-4); padding-top: var(--space-3); border-top: 1px solid var(--border-default); }
.pp-links-h { display: flex; align-items: center; gap: 6px; margin: 0 0 var(--space-2); font-size: var(--text-sm); font-weight: var(--weight-semibold); color: var(--text-heading); }
.pp-links-h .anticon { color: var(--text-muted); }
.pp-links-note { margin: 6px 0 0; font-size: var(--text-xs); color: var(--text-muted); line-height: 1.45; }
.pp-links-error { margin-top: 8px; padding: 6px 10px; border-radius: var(--radius-sm); background: var(--tint-clay); color: var(--accent-clay-text); font-size: var(--text-sm); }
.pp-links-actions { display: flex; justify-content: flex-end; gap: 6px; margin-top: var(--space-2); }
.pp-links-list { list-style: none; margin: 0 0 var(--space-3); padding: 0; display: flex; flex-direction: column; gap: 4px; }
.pp-links-list li { display: flex; align-items: center; gap: 8px; padding: 6px 8px; border: 1px solid var(--border-default); border-radius: var(--radius-sm); font-size: var(--text-sm); }
.pp-links-kind { flex: none; padding: 1px 6px; border-radius: 999px; background: var(--gray-100); color: var(--text-body); font-size: var(--text-xs); font-weight: var(--weight-medium); }
.pp-links-name { flex: 1; min-width: 0; color: var(--text-heading); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pp-links-unlink { flex: none; border: none; background: none; color: var(--text-link); cursor: pointer; font-size: var(--text-xs); padding: 2px 4px; }
.pp-links-unlink:disabled { color: var(--text-muted); cursor: default; }
.pp-links-add { display: flex; align-items: center; gap: 6px; }
`
