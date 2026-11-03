import React, { useEffect, useRef, useState } from 'react'
import { businessesAPI } from '../../api/businesses'
import { formatMoney } from '../../utils/money'
import { DealPill, RecordPill, relativeTime, Bar, SkeletonStyles } from '../shared/ListChrome'

// A business as a GRID card — the Figma Businesses grid (Oct 2026):
//
//   ┌────────────────────────────────────────────┐
//   │ ☐ Harborview Retail Fit-Out   [Open|BUSINESS]│
//   ├──────────────┬──────────────┬──────────────┤
//   │ OPEN PIPELINE│ OPEN TASKS   │ LAST ACTIVITY │
//   ├──────────────┴──────────────┴──────────────┤
//   │ 👤 Taylor Huang               [View|CONTACT]│
//   │ 🏷 Retail Shopfront…  £34,000   [View|DEAL] │
//   ├────────────────────────────────────────────┤
//   │ BUSINESS  name / location / email /         │
//   │           website / type / tags         ✎   │
//   └────────────────────────────────────────────┘
//
// DATA AS IT EXISTS. The contact and deal rows are not in the list endpoint,
// so each card reads its own business detail — but only once it scrolls into
// view, so a page of twenty cards does not fire twenty requests up front.
// Open tasks, type and tags have no API yet; they keep the design's shape
// with an empty value and a disabled control, and fill in when the list
// endpoint sends openTaskCount / type / tags.

// How many contact and deal rows a card shows before "+N more".
const MAX_ROWS = 3

// The design's empty value.
const EMPTY = '….'

// One of the three headline figures under the title.
function Stat({ label, children, faint, mono, last }) {
  return (
    <div style={{
      display: 'grid', gap: 4, minWidth: 0,
      padding: '10px 14px',
      borderRight: last ? 'none' : '1px solid var(--border-default)'
    }}>
      <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      <span style={{
        fontFamily: mono ? 'var(--font-mono)' : 'var(--font-sans)',
        fontSize: 'var(--text-lg)', fontWeight: faint ? 400 : 600,
        fontVariantNumeric: 'tabular-nums',
        color: faint ? 'var(--text-faint)' : 'var(--text-heading)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}>
        {children}
      </span>
    </div>
  )
}

// A person or a deal on the business: icon, name, optional figure, pill.
function LinkRow({ icon, iconColor, name, figure, pill }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, minHeight: 26 }}>
      <span className="ms" style={{ fontSize: 16, color: iconColor, flex: 'none' }}>{icon}</span>
      <span title={name} style={{
        flex: 1, minWidth: 0,
        fontSize: 'var(--text-md)', color: 'var(--text-body)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}>
        {name}
      </span>
      {figure && (
        <span style={{
          flex: 'none', fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)',
          fontWeight: 600, color: 'var(--text-heading)', fontVariantNumeric: 'tabular-nums'
        }}>
          {figure}
        </span>
      )}
      {pill}
    </div>
  )
}

// A labelled field with an in-place editor behind its pencil.
//
// `field` is the business PATCH key; without one the pencil is shown but
// disabled — the design has it, and a hidden pencil would read as read-only
// by choice rather than not-yet-editable.
function FieldRow({ icon, label, value, display, field, businessId, onSaved, last, children, disabledTitle, noPencil = false }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  useEffect(() => { if (editing) inputRef.current?.focus() }, [editing])

  const begin = () => { setDraft(value || ''); setError(null); setEditing(true) }
  const cancel = () => { setEditing(false); setError(null) }
  const save = async () => {
    const next = draft.trim()
    if (next === (value || '')) { cancel(); return }
    setSaving(true)
    setError(null)
    try {
      // '' clears, as CompanyInfoPanel sends it — the same PATCH, same rules.
      await businessesAPI.update(businessId, { [field]: next })
      setEditing(false)
      // Patch from what we SENT, not GHL's echo: the echo uses GHL's own
      // field names, and does not always return every field it was given.
      onSaved && onSaved(field === 'name'
        ? { name: next || 'Unnamed business', hasName: !!next }
        : { [field]: next || null })
    } catch (e) {
      setError(e.message || 'Could not save that')
    } finally {
      setSaving(false)
    }
  }

  const shown = display ?? value
  const isEmpty = shown == null || String(shown).trim() === ''

  return (
    <div style={{
      display: 'grid', gridTemplateColumns: '100px minmax(0, 1fr) auto',
      borderBottom: last ? 'none' : '1px solid var(--border-default)'
    }}>
      <span style={{
        display: 'flex', alignItems: 'center', gap: 6,
        padding: '7px 10px', minWidth: 0,
        background: 'var(--gray-25)',
        borderRight: '1px solid var(--border-default)'
      }}>
        <span className="ms" style={{ fontSize: 15, color: 'var(--text-muted)', flex: 'none' }}>{icon}</span>
        <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      </span>

      <span style={{ display: 'flex', alignItems: 'center', padding: '5px 10px', minWidth: 0 }}>
        {editing ? (
          <span style={{ display: 'grid', gap: 3, width: '100%' }}>
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') save()
                if (e.key === 'Escape') cancel()
              }}
              onBlur={() => { if (!saving) save() }}
              disabled={saving}
              aria-label={label}
              style={{
                width: '100%', height: 28, padding: '0 8px',
                border: `1px solid ${error ? 'var(--status-stuck)' : 'var(--brand-primary)'}`,
                borderRadius: 'var(--radius-sm)',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                color: 'var(--text-body)', outline: 'none'
              }}
            />
            {error && (
              <span role="alert" style={{ fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)' }}>
                {error}
              </span>
            )}
          </span>
        ) : children || (
          <span title={isEmpty ? undefined : String(shown)} style={{
            fontSize: 'var(--text-md)',
            color: isEmpty ? 'var(--text-faint)' : 'var(--text-body)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {isEmpty ? EMPTY : shown}
          </span>
        )}
      </span>

      <span style={{ display: 'flex', alignItems: 'center', padding: '0 8px' }}>
        {!editing && !noPencil && (
          <button
            type="button"
            onClick={field ? begin : undefined}
            disabled={!field || saving}
            title={field ? `Edit ${label.toLowerCase()}` : (disabledTitle || `${label} can't be edited here yet`)}
            aria-label={`Edit ${label.toLowerCase()}`}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, padding: 0,
              border: 'none', background: 'none',
              color: field ? 'var(--text-muted)' : 'var(--text-faint)',
              opacity: field ? 1 : 0.5,
              cursor: field ? 'pointer' : 'not-allowed'
            }}
          >
            <span className={saving ? 'ms pp-spin' : 'ms'} style={{ fontSize: 16 }}>
              {saving ? 'progress_activity' : 'edit'}
            </span>
          </button>
        )}
      </span>
    </div>
  )
}

// The business's contacts and deals, read from its detail once the card is
// on screen. `null` = not fetched yet.
function useLinkedOnView(ref, business) {
  const [linked, setLinked] = useState(null)
  const [failed, setFailed] = useState(false)
  // Nothing to fetch for a business with no contacts and no deals: the
  // design's "Nothing linked yet" needs no request.
  const empty = (business.contactCount || 0) === 0 && (business.dealCount || 0) === 0

  useEffect(() => {
    if (empty || linked || failed) return
    const el = ref.current
    if (!el) return
    let alive = true
    const fetchIt = () => {
      businessesAPI.get(business.id)
        .then((d) => { if (alive) setLinked({ contacts: d?.contacts || [], deals: d?.deals || [] }) })
        .catch(() => { if (alive) setFailed(true) })
    }
    // No IntersectionObserver (very old browsers): fetch straight away.
    if (typeof IntersectionObserver === 'undefined') { fetchIt(); return () => { alive = false } }
    const io = new IntersectionObserver((entries) => {
      if (entries.some((e) => e.isIntersecting)) { io.disconnect(); fetchIt() }
    }, { rootMargin: '200px' })
    io.observe(el)
    return () => { alive = false; io.disconnect() }
  }, [ref, business.id, empty, linked, failed])

  return { linked, failed, empty }
}

export default function BusinessGridCard({
  business: b,
  onOpen, onOpenContact, onOpenDeal, onSaved
}) {
  const ref = useRef(null)
  const { linked, failed, empty } = useLinkedOnView(ref, b)

  // OPEN pipeline when the API sends it; until then every deal's value, with
  // the tooltip saying so — won and lost deals are in that figure.
  const pipeline = b.openPipelineValue ?? b.totalValue
  const pipelineIsTotal = b.openPipelineValue == null
  const location = [b.city, b.country].filter(Boolean).join(', ')
  const status = b.isActive === false ? 'Inactive' : 'Open'

  const contacts = linked?.contacts || []
  const deals = linked?.deals || []
  const more = Math.max(0, contacts.length - MAX_ROWS) + Math.max(0, deals.length - MAX_ROWS)

  return (
    <article
      ref={ref}
      className="pp-card"
      style={{
        display: 'flex', flexDirection: 'column',
        background: 'var(--surface-card)',
        borderRadius: 'var(--radius-md)',
        overflow: 'hidden'
      }}
    >
      {/* HEADER — name (wraps rather than truncating a company name) and the
          status badge. No selection checkbox: businesses have no bulk
          actions, so it was removed (Oct 2026, client request). */}
      <header style={{
        display: 'flex', alignItems: 'flex-start', gap: 10,
        padding: '14px 14px 12px'
      }}>
        <button
          type="button"
          onClick={onOpen}
          title={`Open ${b.name}`}
          style={{
            flex: 1, minWidth: 0, padding: 0, border: 'none', background: 'none',
            textAlign: 'left', cursor: 'pointer',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-xl)', fontWeight: 700, lineHeight: 1.25,
            letterSpacing: '-0.01em',
            color: b.hasName ? 'var(--text-heading)' : 'var(--text-faint)',
            fontStyle: b.hasName ? 'normal' : 'italic',
            overflowWrap: 'anywhere'
          }}
        >
          {b.name}
        </button>
        {/* STATUS, then the record type — the Deal hub's "Open | DEAL" badge,
            in plum. It opens the record, as that one does: the client asked
            for the deal badge to work rather than sit there saying "Open". */}
        <button
          type="button"
          onClick={onOpen}
          title={`${status} — open this business`}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
            height: 22, padding: '0 4px 0 10px',
            border: 'none', borderRadius: 'var(--radius-pill)',
            background: b.isActive === false ? 'var(--gray-500)' : 'var(--panel-head-plum, var(--accent-plum))',
            color: '#fff', fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-sm)', fontWeight: 600, cursor: 'pointer'
          }}
        >
          {status}
          <span style={{
            display: 'inline-flex', alignItems: 'center',
            height: 18, padding: '0 8px',
            borderRadius: 'var(--radius-pill)', background: '#fff',
            color: b.isActive === false ? 'var(--gray-500)' : 'var(--panel-head-plum, var(--accent-plum))',
            fontSize: 10, fontWeight: 700, letterSpacing: 'var(--tracking-label)'
          }}>
            BUSINESS
          </span>
        </button>
      </header>

      {/* THE THREE FIGURES. */}
      <div style={{
        display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0, 1fr))',
        borderTop: '1px solid var(--border-default)',
        borderBottom: '1px solid var(--border-default)'
      }}>
        <Stat label="Open pipeline" mono faint={!pipeline}>
          <span title={pipeline && pipelineIsTotal ? 'Value of every deal on this business, including closed ones' : undefined}>
            {pipeline ? formatMoney(pipeline) : 'No value yet'}
          </span>
        </Stat>
        <Stat label="Open tasks" faint={b.openTaskCount == null}>
          {b.openTaskCount != null ? `${b.openTaskCount} open` : '—'}
        </Stat>
        <Stat label="Last activity" faint={!b.lastActivityAt} last>
          {relativeTime(b.lastActivityAt) || '—'}
        </Stat>
      </div>

      {/* CONTACTS AND DEALS — from the business's detail. */}
      <div style={{
        display: 'grid', gap: 6, padding: '10px 14px',
        borderBottom: '1px solid var(--border-default)'
      }}>
        {empty && (
          <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-faint)' }}>Nothing linked yet</span>
        )}
        {!empty && !linked && !failed && (
          <>
            <SkeletonStyles />
            <Bar w="80%" h={14} />
            <Bar w="65%" h={14} />
          </>
        )}
        {/* A failed read falls back to the counts the list already sent —
            the card still says what is linked, just not who. */}
        {!empty && failed && (
          <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
            {b.contactCount} {b.contactCount === 1 ? 'contact' : 'contacts'} · {b.dealCount} {b.dealCount === 1 ? 'deal' : 'deals'}
          </span>
        )}
        {linked && contacts.slice(0, MAX_ROWS).map((c) => (
          <LinkRow
            key={`c-${c.id}`}
            icon="person"
            iconColor="var(--accent-sky-text)"
            name={c.name}
            pill={
              <RecordPill
                kind="CONTACT"
                name={c.name}
                onClick={onOpenContact ? () => onOpenContact(c.id) : undefined}
              />
            }
          />
        ))}
        {linked && deals.slice(0, MAX_ROWS).map((d) => (
          <LinkRow
            key={`d-${d.id}`}
            icon="sell"
            iconColor="var(--green-600)"
            name={d.name}
            figure={d.value ? formatMoney(d.value) : null}
            pill={
              <DealPill
                compact
                name={d.name}
                onClick={onOpenDeal ? () => onOpenDeal(d.id) : undefined}
              />
            }
          />
        ))}
        {linked && more > 0 && (
          <button
            type="button"
            onClick={onOpen}
            style={{
              justifySelf: 'start', padding: 0, border: 'none', background: 'none',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)', fontWeight: 600,
              color: 'var(--accent-plum-text)', cursor: 'pointer'
            }}
          >
            +{more} more
          </button>
        )}
        {linked && contacts.length === 0 && deals.length === 0 && (
          <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-faint)' }}>Nothing linked yet</span>
        )}
      </div>

      {/* THE RECORD, editable in place. */}
      <div style={{ display: 'grid', gap: 8, padding: '12px 14px 14px' }}>
        <span className="pp-label" style={{ marginBottom: 0 }}>Business</span>
        <div style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-sm)', overflow: 'hidden'
        }}>
          <FieldRow icon="domain" label="Name" value={b.hasName ? b.name : ''}
            field="name" businessId={b.id} onSaved={onSaved} />
          {/* Location shows "City, Country" and edits the city — the country
              is a picklist that belongs in the full record. */}
          <FieldRow icon="location_on" label="Location" value={b.city || ''}
            display={location}
            field="city" businessId={b.id} onSaved={onSaved} />
          <FieldRow icon="mail" label="Email" value={b.email || ''}
            field="email" businessId={b.id} onSaved={onSaved} />
          <FieldRow icon="language" label="Website" value={b.website || ''}
            field="website" businessId={b.id} onSaved={onSaved} />
          <FieldRow icon="storefront" label="Type" value={b.type || ''}
            disabledTitle="Business type isn't available yet" />
          <FieldRow icon="sell" label="Tags" last noPencil>
            <span style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 4 }}>
              {(Array.isArray(b.tags) ? b.tags : []).map((t) => (
                <span key={t} style={{
                  padding: '1px 8px', borderRadius: 'var(--radius-pill)',
                  border: '1px solid var(--border-strong)',
                  fontSize: 'var(--text-base)', color: 'var(--text-body)'
                }}>
                  {t}
                </span>
              ))}
              {/* The design's "+ Tag". Disabled until businesses carry tags. */}
              <button
                type="button"
                disabled
                title="Business tags aren't available yet"
                style={{
                  padding: '1px 8px', borderRadius: 'var(--radius-pill)',
                  border: '1px dashed var(--border-strong)', background: 'none',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
                  color: 'var(--text-faint)', cursor: 'not-allowed'
                }}
              >
                + Tag
              </button>
            </span>
          </FieldRow>
        </div>
      </div>
    </article>
  )
}
