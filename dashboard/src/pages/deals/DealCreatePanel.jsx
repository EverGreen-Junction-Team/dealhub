import React, { useMemo, useState } from 'react'
import { DatePicker, Select, Input } from 'antd'
import dayjs from 'dayjs'
import { dealsAPI } from '../../api/deals'
import ContactPicker from '../shared/ContactPicker'
import { currencySymbol } from '../../utils/money'

// Create a deal.
//
// The server route (POST /api/deals) has existed since the write work but
// nothing called it — there was no way to create a deal in this app at all, so
// a rep had to go to GoHighLevel for the one action that starts everything else.
//
// REQUIRED, per the server's own validation: a contact, a name, and a pipeline.
// A stage is not required — GHL drops a new deal on the pipeline's first stage —
// but it is offered, because "which stage does this start in" is a real
// question when a deal arrives mid-process.
//
// ONE REQUEST. Everything is drafted locally and posted once, like the edit
// panel. Status is not offered: every deal this app creates starts open, which
// is what the server defaults to.
//
// NOT A MODAL, for the same reason the editor isn't — it opens above the list so
// the rep can see what already exists while naming a new one, which is how
// duplicates get noticed.
export default function DealCreatePanel({
  pipelines, users, refError, onCreated, onClose
}) {
  const [contactId, setContactId] = useState(null)
  const [name, setName] = useState('')
  const [pipelineId, setPipelineId] = useState(null)
  const [stageId, setStageId] = useState(null)
  const [value, setValue] = useState('')
  const [assignedTo, setAssignedTo] = useState(null)
  const [closeDate, setCloseDate] = useState('')

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errorField, setErrorField] = useState(null)

  const loadingRef = pipelines === null || users === null

  const stagesForPipeline = useMemo(() => {
    if (!pipelines) return []
    return pipelines.find((p) => p.id === pipelineId)?.stages || []
  }, [pipelines, pipelineId])

  // Picking a pipeline preselects its first active stage. A stage from another
  // pipeline is a 422, and leaving it blank makes the rep answer a question
  // GHL would have answered identically.
  const onPipelineChange = (next) => {
    setPipelineId(next)
    const p = (pipelines || []).find((x) => x.id === next)
    const first = (p?.stages || []).find((s) => s.isActive) || (p?.stages || [])[0]
    setStageId(first?.id || null)
  }

  // The three the server requires. Checked here so Create is visibly disabled
  // rather than round-tripping to a 400 the rep has to read.
  const ready = !!contactId && !!name.trim() && !!pipelineId

  const create = async () => {
    if (!ready || saving) return
    setSaving(true)
    setError(null)
    setErrorField(null)
    try {
      const res = await dealsAPI.create({
        contactId,
        name: name.trim(),
        pipelineId,
        // Omitted rather than sent null when unset: GHL treats an absent field
        // as "use the default" and an explicit null as "clear it", and on a
        // create the former is what's meant.
        ...(stageId ? { pipelineStageId: stageId } : {}),
        ...(value.trim() ? { value: value.trim() } : {}),
        ...(assignedTo ? { assignedTo } : {}),
        ...(closeDate ? { expectedCloseDate: closeDate } : {}),
      })
      onCreated && onCreated(res?.opportunity || null)
    } catch (err) {
      setError(err.message || 'Could not create that deal — try again')
      setErrorField(err.data?.field || null)
      setSaving(false)
    }
  }

  return (
    <section
      style={{
        border: '1px solid var(--brand-primary)',
        boxShadow: 'var(--shadow-card)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        overflow: 'hidden',
        marginBottom: 14
      }}
    >
      <header
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          padding: '13px var(--space-4)',
          borderBottom: '1px solid var(--border-default)',
          background: 'var(--tint-pine)'
        }}
      >
        <span className="ms" style={{ fontSize: 20, color: 'var(--accent-pine-text)' }}>
          add_circle
        </span>
        <h3
          style={{
            flex: 1, margin: 0,
            fontSize: 'var(--text-xl)', fontWeight: 600,
            color: 'var(--accent-pine-text)'
          }}
        >
          New deal
        </h3>
        <button
          onClick={onClose}
          disabled={saving}
          title="Discard this deal"
          style={{
            display: 'inline-flex', alignItems: 'center',
            width: 30, height: 30,
            justifyContent: 'center',
            border: '1px solid var(--border-strong)',
            borderRadius: 'var(--radius-md)',
            background: '#fff', color: 'var(--text-body)',
            cursor: saving ? 'default' : 'pointer'
          }}
        >
          <span className="ms" style={{ fontSize: 18 }}>close</span>
        </button>
      </header>

      <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
        {refError && (
          <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--status-stuck-text)' }}>
            {refError} — a deal needs a pipeline, so this can’t be completed until that loads.
          </p>
        )}

        <Row>
          <Field label="Contact" required error={errorField === 'contactId' ? error : null} span={2}>
            {/* Searches every contact in the sub-account. A deal is created
                against a contact in GHL, so this is not optional. */}
            <ContactPicker
              value={contactId}
              onChange={setContactId}
              invalid={errorField === 'contactId'}
            />
          </Field>
        </Row>

        <Row>
          <Field label="Deal name" required error={errorField === 'name' ? error : null} span={2}>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              onPressEnter={create}
              disabled={saving}
              status={errorField === 'name' ? 'error' : undefined}
              placeholder="What is this deal for?"
            />
          </Field>
        </Row>

        <Row>
          <Field label="Pipeline" required error={errorField === 'pipelineId' ? error : null}>
            <Select
              value={pipelineId || undefined}
              onChange={onPipelineChange}
              showSearch
              optionFilterProp="label"
              disabled={saving}
              loading={loadingRef}
              placeholder={loadingRef ? 'Loading…' : 'Pick a pipeline'}
              status={errorField === 'pipelineId' ? 'error' : undefined}
              options={(pipelines || []).map((p) => ({ value: p.id, label: p.name }))}
              notFoundContent="No pipelines in this sub-account"
              popupClassName="pp-menu"
              style={{ width: '100%' }}
            />
          </Field>
          <Field label="Stage" error={errorField === 'pipelineStageId' ? error : null}>
            <Select
              value={stageId || undefined}
              onChange={setStageId}
              showSearch
              optionFilterProp="label"
              disabled={saving || !pipelineId}
              placeholder={pipelineId ? 'First stage' : 'Pick a pipeline first'}
              options={stagesForPipeline
                // Retired stages are not offered on a CREATE. Unlike the edit
                // panel — where a deal may already be parked on one — there is
                // no reason to start a new deal on a dead stage.
                .filter((st) => st.isActive)
                .map((st) => ({ value: st.id, label: st.name }))}
              notFoundContent="This pipeline has no stages"
              popupClassName="pp-menu"
              style={{ width: '100%' }}
            />
          </Field>
        </Row>

        <Row>
          <Field label="Value" error={errorField === 'value' ? error : null}>
            <Input
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={saving}
              status={errorField === 'value' ? 'error' : undefined}
              // No deal yet, so no currency to read: a new opportunity inherits the
              // location's default, which the server applies on write. Called with
              // no argument so the fallback lives in one place rather than being a
              // second hardcoded '£' here.
              prefix={<span style={{ color: 'var(--text-faint)' }}>{currencySymbol()}</span>}
              placeholder="Not priced yet"
              style={{ fontFamily: 'var(--font-mono)' }}
            />
          </Field>
          <Field label="Owner">
            <Select
              value={assignedTo || undefined}
              onChange={setAssignedTo}
              disabled={saving}
              loading={loadingRef}
              allowClear
              showSearch
              optionFilterProp="label"
              placeholder="Unassigned"
              options={(users || []).map((u) => ({ value: u.id, label: u.name }))}
              notFoundContent="No matching user"
              popupClassName="pp-menu"
              style={{ width: '100%' }}
            />
          </Field>
        </Row>

        <Row>
          <Field label="Expected close" error={errorField === 'expectedCloseDate' ? error : null}>
            <DatePicker
              popupClassName="pp-cal"
              value={closeDate ? dayjs(closeDate) : null}
              onChange={(d) => setCloseDate(d ? d.format('YYYY-MM-DD') : '')}
              disabled={saving}
              format="D MMM YYYY"
              placeholder="Set a date"
              style={{ width: '100%' }}
            />
          </Field>
          {/* NO SOURCE FIELD. GHL's create endpoint has no writable `source`
              — it stamps its own ("public api" for anything we create), and
              opportunityPatch drops the key. An input here would be a control
              that silently does nothing. */}
        </Row>

        {/* Only when it isn't already sitting under the field responsible —
            errorField puts it there, and showing both duplicates it. */}
        {error && !errorField && (
          <div
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 7,
              padding: '9px 11px',
              border: '1px solid var(--status-stuck)',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--tint-rose)',
              fontSize: 'var(--text-base)', color: 'var(--status-stuck-text)'
            }}
          >
            <span className="ms" style={{ fontSize: 15, flex: 'none', marginTop: 1 }}>error</span>
            {error}
          </div>
        )}

        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--border-default)'
          }}
        >
          <span
            style={{ flex: 1, fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}
          >
            {saving
              ? 'Creating in your CRM…'
              : ready
                ? 'Created in your CRM, then synced back here'
                : 'A contact, a name and a pipeline are required'}
          </span>
          <button
            onClick={onClose}
            disabled={saving}
            style={{
              height: 34, padding: '0 15px',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: '#fff', color: 'var(--text-body)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
              cursor: saving ? 'default' : 'pointer'
            }}
          >
            Cancel
          </button>
          <button
            onClick={create}
            disabled={!ready || saving}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              height: 34, padding: '0 17px',
              border: 'none', borderRadius: 'var(--radius-md)',
              background: ready ? 'var(--brand-primary)' : 'var(--gray-200)',
              color: ready ? '#fff' : 'var(--text-faint)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
              cursor: ready && !saving ? 'pointer' : 'default'
            }}
          >
            {saving && (
              <span className="ms pp-spin" style={{ fontSize: 15 }}>progress_activity</span>
            )}
            {saving ? 'Creating' : 'Create deal'}
          </button>
        </div>
      </div>
    </section>
  )
}

// Two columns that collapse to one on a narrow iframe — the host controls the
// width, so a fixed grid would overflow rather than reflow.
function Row({ children }) {
  return (
    <div
      style={{
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(230px, 1fr))',
        gap: 'var(--space-3)'
      }}
    >
      {children}
    </div>
  )
}

function Field({ label, children, required = false, span = 1, error = null }) {
  return (
    <div style={{ minWidth: 0, gridColumn: span === 2 ? '1 / -1' : undefined }}>
      <span
        style={{
          display: 'block', marginBottom: 5,
          fontSize: 'var(--text-xs)', fontWeight: 600,
          letterSpacing: 'var(--tracking-label)',
          textTransform: 'uppercase', color: 'var(--text-muted)'
        }}
      >
        {label}
        {required && (
          <span style={{ color: 'var(--status-stuck)', marginLeft: 3 }} aria-hidden="true">*</span>
        )}
      </span>
      {children}
      {error && (
        <p
          style={{
            margin: '5px 0 0',
            fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)'
          }}
        >
          {error}
        </p>
      )}
    </div>
  )
}
