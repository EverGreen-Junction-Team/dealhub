import React from 'react'
import { formatMoney } from '../../utils/money'
import { DealPill, RecordPill, relativeTime } from '../shared/ListChrome'
import { FieldRow } from '../dealhub/FieldCard'
import { FieldPicker, OwnerRow, FIELD_CHIPS, unwrapNested } from '../dealhub/DealSection'
import TagSelect from '../shared/TagSelect'

// A deal as a GRID card — the Figma design (Oct 2026):
//
//   ┌──────────────────────────────────────────┐
//   │ Riverside Extension — Glazing…  [View|DEAL]│
//   ├────────────────────┬─────────────────────┤
//   │ VALUE £8,450       │ PIPELINE STAGE  …   │
//   ├────────────────────┴─────────────────────┤
//   │ 👤 Alex Morgan              [View|CONTACT] │
//   │ 🏢 Sample Homeowner        [View|BUSINESS] │
//   ├──────────────────────────────────────────┤
//   │ TYPE · SYSTEM · OWNER · UPDATED ·          │
//   │ FIRST CONTACT · LEAD SOURCE · CLIENT TYPE ·│
//   │ TAGS                              ✎ each   │
//   └──────────────────────────────────────────┘
//
// EVERY EDITOR HERE IS THE DEAL HUB'S. The five custom fields use its
// FieldPicker, the owner its OwnerRow, the tags its TagSelect — the same
// controls with the same save shapes, so a fix to one is a fix to both.
// Value and stage have no pencil in the design, and Updated is a fact, not a
// field.

// The design's row order, which is not the Deal hub's. Keys index FIELD_CHIPS.
const ROWS = [
  ['productType', 'Type', 'grid_view'],
  ['productSystem', 'System', 'category'],
  // owner and updated slot in here — see the render below
  ['firstContactMethod', 'First contact', 'call'],
  ['leadSource', 'Lead source', 'campaign'],
  ['clientType', 'Client type', 'badge']
]

// The picklist definition for one field. Both spellings, because GHL's own key
// is inconsistent across locations (first_contact__method) — the same lookup
// FieldChipRow does on the Deal hub.
function specFor(options, dealKey) {
  // NULL while the picklists load — the Deals tab holds null as its "not
  // fetched yet" marker, and a default parameter does not replace null, so
  // reading options[...] here crashed the whole grid on first render.
  const fieldOptions = options || {}
  const chip = FIELD_CHIPS.find((f) => f[1] === dealKey)
  if (!chip) return null
  const ghlKey = chip[2]
  return fieldOptions[ghlKey]
    || fieldOptions[ghlKey.replace('__', '_')]
    || fieldOptions[dealKey.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]
    || null
}

function Cell({ label, children, last }) {
  return (
    <div style={{
      display: 'grid', gap: 4, minWidth: 0,
      padding: '10px 14px',
      borderRight: last ? 'none' : '1px solid var(--border-default)'
    }}>
      <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      {children}
    </div>
  )
}

function LinkRow({ icon, iconColor, name, empty, pill }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, minWidth: 0,
      padding: '7px 14px'
    }}>
      <span className="ms" style={{ fontSize: 17, color: iconColor, flex: 'none' }}>{icon}</span>
      <span title={name || undefined} style={{
        flex: 1, minWidth: 0,
        fontSize: 'var(--text-md)',
        color: name ? 'var(--text-body)' : 'var(--text-faint)',
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}>
        {name || empty}
      </span>
      {name && pill}
    </div>
  )
}

export default function DealGridCard({
  deal, fieldOptions = {}, users = null,
  // { dealId, key } while a save is in flight, so only that row spins.
  saving = null,
  onSaveField, onTagsChanged,
  onOpenInHub, onOpenContact, onOpenBusiness
}) {
  const name = deal.dealTag || deal.opportunityName || 'Untitled deal'
  const value = Number(deal.monetaryValue)
  const contactName = deal.contact
    ? `${deal.contact.firstName || ''} ${deal.contact.lastName || ''}`.trim()
    : ''
  const businessName = deal.businessName || deal.contact?.business || ''
  const savingKey = saving && saving.dealId === deal.id ? saving.key : null

  const pickerRow = ([key, label, icon], i, last) => {
    const spec = specFor(fieldOptions, key)
    const v = unwrapNested(deal[key])
    return (
      <FieldRow
        key={key}
        icon={icon}
        label={label}
        value={v}
        // No definition resolved → plain text, honestly read-only, exactly as
        // the Deal hub falls back.
        control={spec && onSaveField ? (
          <FieldPicker
            bare
            label={label}
            value={v}
            spec={spec}
            saving={savingKey === spec.id}
            onChange={(next) => onSaveField(deal, 'customField', { id: spec.id, value: next, dealKey: key })}
          />
        ) : undefined}
        notSet
        last={last}
      />
    )
  }

  return (
    <article style={{
      display: 'flex', flexDirection: 'column',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)',
      overflow: 'hidden'
    }}>
      <header style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '12px 14px',
        borderBottom: '1px solid var(--border-default)'
      }}>
        <h3 title={name} style={{
          flex: 1, minWidth: 0, margin: 0,
          fontSize: 'var(--text-lg)', fontWeight: 600, letterSpacing: '-0.01em',
          color: 'var(--text-heading)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}>
          {name}
        </h3>
        <DealPill name={name} onClick={onOpenInHub ? () => onOpenInHub(deal.id) : undefined} />
      </header>

      <div style={{
        display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) minmax(0, 1fr)',
        borderBottom: '1px solid var(--border-default)'
      }}>
        <Cell label="Value">
          {/* An unpriced deal says so rather than printing £0, which reads as
              "worth nothing" instead of "not yet quoted". */}
          <span style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xl)', fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: value > 0 ? 'var(--text-heading)' : 'var(--text-faint)'
          }}>
            {value > 0 ? formatMoney(value, deal.currency) : 'Not priced'}
          </span>
        </Cell>
        <Cell label="Pipeline stage" last>
          <span style={{
            fontSize: 'var(--text-md)', fontWeight: 600,
            color: deal.stage ? 'var(--text-heading)' : 'var(--text-faint)',
            overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
          }}>
            {deal.stage || 'No stage'}
          </span>
        </Cell>
      </div>

      <div style={{ borderBottom: '1px solid var(--border-default)', padding: '4px 0' }}>
        <LinkRow
          icon="person"
          iconColor="var(--accent-sky-text)"
          name={contactName}
          empty="No contact"
          pill={
            <RecordPill
              kind="CONTACT"
              name={contactName}
              onClick={onOpenContact && deal.contact?.id ? () => onOpenContact(deal.contact.id) : undefined}
            />
          }
        />
        <LinkRow
          icon="domain"
          iconColor="var(--accent-plum-text)"
          name={businessName}
          empty="No business"
          pill={
            <RecordPill
              kind="BUSINESS"
              name={businessName}
              // Only a real business RECORD opens; the free-text company on
              // the contact has nowhere to go.
              onClick={onOpenBusiness && deal.businessId ? () => onOpenBusiness(deal.businessId) : undefined}
            />
          }
        />
      </div>

      <div style={{ padding: '12px 14px 14px' }}>
        <div style={{
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-sm)', overflow: 'hidden'
        }}>
          {ROWS.slice(0, 2).map((r, i) => pickerRow(r, i, false))}
          <OwnerRow
            deal={deal}
            users={users}
            onNeedUsers={() => {}}
            saving={savingKey === 'assignedTo'}
            onSave={(v) => onSaveField && onSaveField(deal, 'assignedTo', v)}
          />
          <FieldRow
            icon="history"
            label="Updated"
            value={relativeTime(deal.updatedAt)}
          />
          {ROWS.slice(2).map((r, i) => pickerRow(r, i, false))}
          <FieldRow
            icon="sell"
            label="Tags"
            last
            control={
              deal.contact?.id ? (
                // The CONTACT's tags are editable; the deal's own come
                // along locked — GHL's tags are contact-scoped, and the
                // contact endpoint cannot change a deal's. Same split as the
                // Deal hub's tag row.
                <TagSelect
                  contactId={deal.contact.id}
                  tags={deal.contactTags || []}
                  readOnlyTags={deal.tags || []}
                  onChange={(next) => onTagsChanged && onTagsChanged(deal, next)}
                />
              ) : undefined
            }
            value={(deal.tags || []).join(', ') || null}
          />
        </div>
      </div>
    </article>
  )
}
