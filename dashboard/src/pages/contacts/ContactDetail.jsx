import { Select } from 'antd'
import React, { useEffect, useRef, useState } from 'react'
import { contactsAPI } from '../../api/contacts'
import CustomFieldSections from '../shared/CustomFieldSections'
import {
  Panel, StateMessage, SkeletonStyles, Bar, formatDate, initialsFor, nameFor, DealPill, Truncate
} from '../shared/ListChrome'
import TagSelect from '../shared/TagSelect'
import { htmlToText } from '../../utils/sanitiseHtml'
import EmailBody from '../dealhub/EmailBody'
import AttachmentChip from '../dealhub/AttachmentChip'
import AttachmentViewer from '../dealhub/AttachmentViewer'
import MessageDealPill from '../dealhub/MessageDealPill'
import BusinessPickerModal from '../shared/BusinessPickerModal'
import { DealTasksSection, DealNotesSection } from '../dealhub/DealTasksSection'

// Contact record — everything about one person, in five panels:
//
//   Details     identity, tags and the editable fields, in one record card
//   Deals       which opportunities they're on
//   Tasks and notes  everything filed against this person, side by side
//   All messages     every message, with the deal it's filed to
//   Do not disturb   per-channel switches
//   Custom fields    GHL's own folders
//
// All messages is the useful one: showing every message together is what
// makes a wrongly-filed one visible, because it's the row whose deal tag
// looks wrong beside its content. DND and custom fields sit after it —
// settings and reference, not the story of the relationship.
// GHL's echo uses its own camelCase field names; the UI uses ours. Map only the
// keys we display — an unmapped key would quietly leave a stale value on screen.// GHL's field name -> the label the user sees on that input.
function labelFor(field) {
  const map = {
    firstName: 'First name', lastName: 'Last name', email: 'Email',
    phone: 'Phone', address1: 'Address', city: 'City', state: 'State',
    postalCode: 'Postal code', website: 'Website', timezone: 'Timezone',
    country: 'Country', dateOfBirth: 'Date of birth', tags: 'Tags'
  }
  return map[field] || field
}

function fromGhl(c) {
  if (!c) return null
  const out = {}
  const map = {
    firstName: 'firstName', lastName: 'lastName', email: 'email', phone: 'phone',
    address1: 'address', city: 'city', state: 'state', postalCode: 'postalCode',
    website: 'website', timezone: 'timezone', country: 'country'
  }
  for (const [from, to] of Object.entries(map)) {
    if (c[from] !== undefined) out[to] = c[from]
  }
  return Object.keys(out).length ? out : null
}

export default function ContactDetail({ contactId, onBack, onOpenDeal, onOpenTab }) {
  const [contact, setContact] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    setContact(null)
    setError(null)
    contactsAPI.get(contactId)
      .then((c) => alive && setContact(c))
      .catch((err) => alive && setError(err.message || 'Failed to load contact'))
    return () => { alive = false }
  }, [contactId])

  if (error) {
    return (
      <Shell onBack={onBack}>
        <div
          style={{
            padding: 16, borderLeft: '3px solid var(--status-stuck)',
            background: 'var(--tint-rose)', color: 'var(--status-stuck)',
            borderRadius: 'var(--radius-md)', fontSize: 'var(--text-md)'
          }}
        >
          {error}
        </div>
      </Shell>
    )
  }

  if (!contact) {
    return (
      <Shell onBack={onBack}>
        <SkeletonStyles />
        {[120, 220, 260, 140].map((h, i) => (
          <div
            key={i}
            style={{
              border: '1px solid var(--border-default)',
              borderRadius: 'var(--radius-md)',
              background: '#fff', padding: 16, display: 'grid', gap: 10
            }}
          >
            <Bar w={i % 2 ? '32%' : '46%'} h={15} />
            <Bar w="100%" h={h / 3} r="var(--radius-md)" />
          </div>
        ))}
      </Shell>
    )
  }

  return (
    <Shell onBack={onBack}>
      {/* PANEL ORDER: Details, Deals, Tasks and notes, All messages, Do not
          disturb, Custom
          fields. Asked for directly, and it reads as the order a rep works
          in: who they are, what they are buying, what has been said — then
          the two panels that are settings and reference rather than the
          story of the relationship. */}
      <Details
        contact={contact}
        onSaved={(patch) => setContact((c) => ({ ...c, ...patch }))}
      />
      <Deals deals={contact.deals} onOpenDeal={onOpenDeal} />
      <TasksAndNotes contactId={contactId} contact={contact} onOpenTab={onOpenTab} />
      <AllMessages
        contactId={contactId}
        deals={contact.deals || []}
        onOpenDeal={onOpenDeal}
      />
      <DoNotDisturb
        contact={contact}
        onChange={(dnd) => setContact((c) => ({ ...c, dnd }))}
      />
      {/* Custom fields, in GHL's own folders. */}
      <CustomFields
        contact={contact}
        onSaved={(groups) => setContact((c) => ({ ...c, customFieldGroups: groups }))}
      />
    </Shell>
  )
}

// EVERY TASK AND NOTE FILED AGAINST THIS PERSON, side by side — the client
// asked for them on the contact record (Oct 2026). The Deal hub's own rails,
// scoped to the contact: the same list, editor, tick-to-complete and delete,
// so a task changed here behaves exactly as it does on a deal. Equal halves;
// they stack on a narrow screen.
function TasksAndNotes({ contactId, contact, onOpenTab }) {
  // The rails create against one of `people`; here that is this contact.
  const people = [{
    id: contactId,
    firstName: contact.firstName,
    lastName: contact.lastName,
    email: contact.email,
    primary: true
  }]
  return (
    <div style={{
      display: 'grid',
      gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))',
      gap: 14, alignItems: 'start', minWidth: 0
    }}>
      <DealTasksSection
        contactId={contactId}
        people={people}
        onOpenAll={onOpenTab ? () => onOpenTab('tasks') : undefined}
      />
      <DealNotesSection
        contactId={contactId}
        people={people}
        onOpenAll={onOpenTab ? () => onOpenTab('notes') : undefined}
      />
    </div>
  )
}

function Shell({ children, onBack }) {
  return (
    <div
      style={{
        maxWidth: 1000, width: '100%', boxSizing: 'border-box',
        // space-4 on top, not space-1: the "All contacts" pill sat tight under
        // the nav, where the design gives it room — and every other page's
        // Shell already starts lower (ListChrome's Shell uses space-3).
        margin: '0 auto', padding: 'var(--space-4) 20px var(--space-7)',
        display: 'grid', gap: 14
      }}
    >
      {onBack && (
        <button
          onClick={onBack}
          style={{
            justifySelf: 'start',
            display: 'inline-flex', alignItems: 'center', gap: 6,
            // A solid slate pill, as the design draws it — the same treatment
            // as the nav's Back button, so "go back" looks like one control.
            height: 32, padding: '0 14px 0 10px',
            border: 'none', borderRadius: 'var(--radius-pill)',
            background: 'var(--gray-800)', color: '#fff',
            cursor: 'pointer',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
            fontWeight: 600
          }}
        >
          <span className="ms" style={{ fontSize: 17 }}>arrow_back</span>
          All contacts
        </button>
      )}
      {children}
    </div>
  )
}

// ── Details — the record card ─────────────────────────────────────────
//
// The October 2026 design puts who the contact is and their editable fields
// in ONE card:
//
//   (GB) Graham Bryant  [CONTACT RECORD]
//        No tags  (+ Add a tag)
//   ┌ 👤 FIRST NAME │ Graham       ✎ ┬ 👤 LAST NAME   │ Bryant       ✎ ┐
//   │ ✉ EMAIL      │ …            ✎ │ 📞 PHONE       │ …            ✎ │
//   │ 📍 ADDRESS    │ …            ✎ │ 🕓 TIMEZONE    │ Europe/London ✎ │
//   └ 🏢 BUSINESS   │ (Link a business) │ 🪪 CONTACT TYPE │ Not set      ˅ ┘
//   Saved changes are written to your CRM, which sends them back to every view.
//
// The header used to repeat email, phone, address and timezone as a line of
// facts above a Details panel holding the same values as inputs — every fact
// twice. Now each is one cell, read as text and edited in place.

// NO 'business' TEXT FIELD HERE.
//
// It wrote GHL's `companyName` — a free-text label with no link to anything,
// sitting directly beside the business LINK, which sets the real relation
// (contacts.business_id). Filling the text one looked like it had worked and
// left the contact linked to nothing. contactPatch still maps business →
// companyName, so anything stored is preserved; what is removed is the
// invitation to type into it.
//
// In the table's reading order — the grid fills left to right, so each pair
// here is one row.
const FIELDS = [
  ['firstName', 'First name', 'text', 'person'],
  ['lastName', 'Last name', 'text', 'person'],
  ['email', 'Email', 'email', 'mail'],
  ['phone', 'Phone', 'tel', 'call'],
  ['address', 'Address', 'text', 'location_on'],
  // Mapped by fromGhl and named by labelFor; contactPatch maps `timezone`
  // through to GHL's own field, so Save sends it. (Confirmed 12 Oct 2026.)
  ['timezone', 'Timezone', 'text', 'schedule']
]

// GHL's own two values, and there are only two — its contact panel offers
// Lead and Customer and nothing else. Stored lowercase, shown capitalised.
const CONTACT_TYPES = [
  { value: 'lead', label: 'Lead' },
  { value: 'customer', label: 'Customer' }
]

// The contact's link to a business record, in a table cell.
//
// Writes PATCH /contacts/:id { businessId } — the same single write the Deal
// Hub's "Add business" makes, through the same shared picker, so the two
// surfaces cannot drift apart on what linking means. `businessId: null` is a
// real unlink and the server treats it as one; it is not the same as omitting
// the field.
function BusinessLink({ contact, onSaved }) {
  const [picking, setPicking] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  const linked = contact.businessId
    ? { id: contact.businessId, name: contact.businessName || 'Linked business' }
    : null

  const unlink = async () => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await contactsAPI.update(contact.id, { businessId: null })
      onSaved({ businessId: null, businessName: null })
    } catch (err) {
      setError(err?.message || 'Could not unlink')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{
      flex: 1, minWidth: 0, alignSelf: 'center',
      display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
      padding: '6px 12px'
    }}>
      {linked ? (
        <>
          <span title={linked.name} style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, maxWidth: '100%',
            height: 26, padding: '0 10px',
            border: '1px solid var(--accent-plum)',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--tint-plum)',
            fontSize: 'var(--text-base)', fontWeight: 600,
            color: 'var(--accent-plum-text)'
          }}>
            <span className="ms" style={{ fontSize: 15, flex: 'none' }}>business</span>
            <Truncate>{linked.name}</Truncate>
          </span>
          <button
            type="button"
            className="pp-cc-act"
            onClick={() => setPicking(true)}
            disabled={busy}
            title="Link a different business"
            aria-label="Change business"
            style={{ padding: '0 4px' }}
          >
            <span className="ms" style={{ fontSize: 15 }}>edit</span>
          </button>
          <button
            type="button"
            className="pp-cc-act"
            onClick={unlink}
            disabled={busy}
            title="Unlink this business from the contact"
            aria-label="Unlink business"
            style={{ padding: '0 4px' }}
          >
            <span className="ms" style={{ fontSize: 15 }}>{busy ? 'progress_activity' : 'link_off'}</span>
          </button>
        </>
      ) : (
        <button
          type="button"
          onClick={() => setPicking(true)}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5,
            height: 26, padding: '0 10px',
            border: '1px dashed var(--border-strong)',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-card)',
            color: 'var(--text-body)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
            cursor: 'pointer'
          }}
        >
          <span className="ms" style={{ fontSize: 15 }}>add_business</span>
          Link a business
        </button>
      )}

      {error && (
        <span style={{ fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)' }}>{error}</span>
      )}

      {picking && (
        <BusinessPickerModal
          contact={contact}
          excludeIds={linked ? [linked.id] : []}
          blurb="Linked to this contact, and shown on every deal they are on."
          onClose={() => setPicking(false)}
          onLinked={(business) => {
            setPicking(false)
            onSaved({ businessId: business.id, businessName: business.name })
          }}
        />
      )}
    </span>
  )
}

// Tags on the contact record. Editable through the dedicated add/remove
// endpoints — the field save on this card goes through the contact update
// endpoint, which REPLACES the whole tag array and is therefore refused for
// tags (see the server's contactPatch.js). Hence a separate control.
function TagStrip({ contactId, tags }) {
  const [current, setCurrent] = useState(tags)
  return (
    <TagSelect
      contactId={contactId}
      tags={current}
      onChange={setCurrent}
    />
  )
}

function Details({ contact, onSaved }) {
  const name = nameFor(contact)
  const [draft, setDraft] = useState(() =>
    Object.fromEntries(FIELDS.map(([k]) => [k, contact[k] || '']))
  )
  const [type, setType] = useState(contact.contactType || '')
  // The field being edited, by key. One at a time: the others read as text.
  const [editing, setEditing] = useState(null)
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)
  // Which field GHL rejected, so the message can sit on that cell rather
  // than as a banner that doesn't say what's wrong.
  const [errorField, setErrorField] = useState(null)
  const timer = useRef(null)

  const save = async (patch) => {
    setState('saving')
    setError(null)
    setErrorField(null)
    try {
      const res = await contactsAPI.update(contact.id, patch)
      // Prefer what GHL echoed back over what we sent. GHL normalises some
      // fields on write — "+1 888-888-8888" comes back "+18888888888" — so
      // applying our own patch would show the pre-normalised value until the
      // next refresh, and the field would appear to have saved wrongly.
      onSaved(fromGhl(res?.contact) || patch)
      setState('saved')
      clearTimeout(timer.current)
      timer.current = setTimeout(() => setState('idle'), 2000)
    } catch (err) {
      // The API names the offending field, so mark it rather than showing a
      // banner that doesn't say which cell is wrong.
      setError(err?.response?.data?.error || err.message || 'Could not save')
      setErrorField(err?.response?.data?.field || null)
      setState('error')
    }
  }

  useEffect(() => () => clearTimeout(timer.current), [])

  // Which fields differ from what's saved. Compared against `contact`, the last
  // value the server confirmed — not against the initial draft, so a field
  // edited and then typed back to its original stops counting as dirty.
  const isDirty = (key) => {
    const current = key === 'contactType' ? type : draft[key]
    return (contact[key] || '') !== (current || '')
  }

  // contactType rides along with the fields: contactPatch maps it to GHL's
  // `type`, which the service applies even though it is hidden from the
  // documented PUT. It was left out here on the belief that the endpoint
  // dropped it — the dropdown changed and Save sent nothing.
  const dirtyKeys = [...FIELDS.map(([k]) => k), 'contactType'].filter(isDirty)

  // One request for every change, not one per field. Each PATCH is a round trip
  // to GHL plus a webhook back, so saving five fields separately would fire
  // five of each and the last webhook would win in an unpredictable order.
  const saveAll = () => {
    setEditing(null)
    if (!dirtyKeys.length) return

    // CHECKED BEFORE SENDING — deliberately the SERVER'S regex, character for
    // character. A stricter one here would refuse addresses the API accepts;
    // a looser one would let the round trip happen anyway and change nothing.
    if (dirtyKeys.includes('email')) {
      const email = (draft.email || '').trim()
      if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        setError('That email address is not valid')
        setErrorField('email')
        setState('error')
        return
      }
    }

    const patch = {}
    for (const k of dirtyKeys) {
      patch[k] = k === 'contactType' ? type : draft[k]
    }
    save(patch)
  }

  const revert = () => {
    setDraft(Object.fromEntries(FIELDS.map(([k]) => [k, contact[k] || ''])))
    setType(contact.contactType || '')
    setEditing(null)
    setError(null)
    setErrorField(null)
    setState('idle')
  }

  // Saving / Saved / the rejected field's message, beside the name.
  const status =
    state === 'saving' ? 'Saving…'
      : state === 'saved' ? 'Saved'
      // Name the field GHL rejected — the same message with no field named
      // on an eight-cell table is not clear.
      : state === 'error'
        ? (errorField ? `${labelFor(errorField)}: ${error}` : error)
      : null

  return (
    <section style={{
      border: '1px solid var(--border-default)',
      boxShadow: 'var(--shadow-card)',
      borderRadius: 'var(--radius-md)',
      background: '#fff',
      overflow: 'hidden'
    }}>
      {/* IDENTITY — avatar, name, the record badge, and the tags beneath. */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 13,
        padding: 'var(--space-4) 18px var(--space-3)'
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 40, height: 40, flex: 'none', marginTop: 2,
          borderRadius: '50%',
          background: `var(--tint-${contact.accent || 'plum'})`,
          color: `var(--accent-${contact.accent || 'plum'}-text)`,
          fontSize: 'var(--text-md)', fontWeight: 700
        }}>
          {initialsFor(contact.firstName, contact.lastName, name)}
        </span>
        <div style={{ minWidth: 0, flex: 1, display: 'grid', gap: 6 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 9, flexWrap: 'wrap' }}>
            <h1 style={{
              margin: 0, fontSize: 'var(--text-2xl)', fontWeight: 600,
              letterSpacing: '-0.01em', color: 'var(--text-heading)'
            }}>
              {name}
            </h1>
            <span style={{
              fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: 'var(--tracking-label)',
              textTransform: 'uppercase',
              padding: '3px 9px', borderRadius: 'var(--radius-sm)',
              background: 'var(--gray-100)', color: 'var(--text-muted)'
            }}>
              Contact record
            </span>
            {status && (
              <Status metaTone={state === 'error' ? 'error' : 'muted'}>{status}</Status>
            )}
          </div>
          <TagStrip contactId={contact.id} tags={contact.tags || []} />
        </div>
      </div>

      {/* THE FIELDS — a ruled two-column table. */}
      <div style={{ padding: '0 18px var(--space-3)' }}>
        <div className="pp-cc-fields pp-cc-fields-2">
          {FIELDS.map(([key, label, type_, icon]) => (
            <FieldCell
              key={key}
              fieldKey={key}
              errorField={errorField}
              icon={icon}
              label={label}
              type={type_}
              value={draft[key]}
              open={editing === key}
              // THE REJECTED FIELD WINS OVER "DIRTY". Dirty is pine — right
              // for "this will be sent", wrong the moment the save came back
              // rejecting that field: an invalid email sat highlighted green,
              // reading as success.
              line={errorField === key
                ? 'var(--status-stuck)'
                : isDirty(key) ? 'var(--brand-primary)' : undefined}
              tint={errorField === key
                ? 'var(--tint-rose)'
                : isDirty(key) ? 'var(--tint-pine)' : undefined}
              onOpen={() => setEditing(key)}
              onClose={() => setEditing((k) => (k === key ? null : k))}
              onChange={(v) => {
                setDraft((d) => ({ ...d, [key]: v }))
                // Typing in the field that was rejected clears the complaint.
                // Leaving it up while the reader fixes the value makes a
                // corrected field look broken.
                if (errorField === key) {
                  setError(null); setErrorField(null); setState('idle')
                }
              }}
              onSave={saveAll}
              onCancel={revert}
            />
          ))}

          {/* THE BUSINESS LINK — contacts.business_id, the actual link to a
              business record, not GHL's free-text companyName. Opens a
              picker and writes immediately, unlike the cells above. */}
          <div className="pp-cc-row" style={{ cursor: 'default' }}>
            <span className="pp-cc-key">
              <span className="ms pp-cc-icon">business</span>
              <span className="pp-cc-label">Business</span>
            </span>
            <BusinessLink contact={contact} onSaved={onSaved} />
          </div>

          <div className="pp-cc-row" style={{ cursor: 'default' }}>
            <span className="pp-cc-key">
              <span className="ms pp-cc-icon">badge</span>
              <span className="pp-cc-label">Contact type</span>
            </span>
            <span style={{ flex: 1, minWidth: 0, alignSelf: 'center', padding: '0 4px' }}>
              <Select
                title="Lead or Customer, as in your CRM"
                variant="borderless"
                // Lower-cased so a stored "Lead" still matches the 'lead'
                // option and renders as the label rather than as an unknown
                // value.
                value={type ? String(type).toLowerCase() : undefined}
                // No allowClear: GHL has no "no type" state, and offering a
                // clear that the server then refuses would be a control that
                // fails on use.
                onChange={(v) => setType(v ?? '')}
                placeholder="Not set"
                style={{ width: '100%' }}
                popupClassName="pp-menu"
                options={[
                  // A value GHL sent that is not one of the two stays
                  // selectable rather than being silently rewritten.
                  ...(type && !CONTACT_TYPES.some((o) => o.value === String(type).toLowerCase())
                    ? [{ value: type, label: type }]
                    : []),
                  ...CONTACT_TYPES
                ]}
              />
            </span>
          </div>
        </div>
      </div>

      {(contact.secondaryEmails?.length > 0 || contact.secondaryPhones?.length > 0) && (
        <div style={{
          padding: '0 18px var(--space-3)',
          display: 'flex', flexWrap: 'wrap', gap: '6px 18px',
          fontSize: 'var(--text-base)', color: 'var(--text-muted)'
        }}>
          {contact.secondaryEmails?.map((e) => <span key={e}>Also: {e}</span>)}
          {contact.secondaryPhones?.map((p) => <span key={p}>Also: {p}</span>)}
        </div>
      )}

      <p style={{
        margin: 0, padding: '10px 18px',
        borderTop: '1px solid var(--border-default)',
        background: 'var(--gray-25)',
        fontSize: 'var(--text-base)', color: 'var(--text-muted)'
      }}>
        {dirtyKeys.length > 0
          ? `${dirtyKeys.length} unsaved ${dirtyKeys.length === 1 ? 'change' : 'changes'} — press Enter or Save to send them to your CRM.`
          : 'Saved changes are written to your CRM, which sends them back to every view here.'}
      </p>

      {/* An explicit Save. Blur-committing meant a half-typed value could reach
          GHL the moment focus moved, and there was no way to abandon an edit —
          nor any sign that anything was unsaved. */}
      {dirtyKeys.length > 0 && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          padding: '11px 18px',
          borderTop: '1px solid var(--border-default)',
          background: 'var(--tint-pine)'
        }}>
          <button
            onClick={saveAll}
            disabled={state === 'saving'}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              cursor: state === 'saving' ? 'wait' : 'pointer',
              height: 34, padding: '0 16px',
              border: 'none', borderRadius: 'var(--radius-md)',
              background: 'var(--brand-primary)', color: '#fff',
              boxShadow: '0 2px 6px rgba(13, 91, 64, 0.32)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-md)', fontWeight: 600
            }}
          >
            <span className="ms" style={{ fontSize: 17 }}>check</span>
            {state === 'saving' ? 'Saving…' : `Save ${dirtyKeys.length}`}
          </button>
          <button
            onClick={revert}
            disabled={state === 'saving'}
            style={{
              cursor: 'pointer',
              height: 34, padding: '0 14px',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: '#fff',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-md)', color: 'var(--text-body)'
            }}
          >
            Cancel
          </button>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            Enter saves · Esc cancels
          </span>
        </div>
      )}
    </section>
  )
}

// The save state beside the name. An error is announced, not just shown: a
// screen-reader user gets no colour, and this text is the only report of the
// failure — the same treatment Panel gives its meta.
function Status({ metaTone, children }) {
  const isError = metaTone === 'error'
  return (
    <span
      role={isError ? 'alert' : undefined}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        marginLeft: 'auto',
        fontSize: 'var(--text-md)', fontWeight: isError ? 600 : 400,
        color: isError ? 'var(--status-stuck-text)' : 'var(--text-muted)'
      }}
    >
      {isError && <span className="ms" style={{ fontSize: 16 }}>error</span>}
      {children}
    </span>
  )
}

// One cell of the field table: the value as text with a pencil, or the input
// while it is being edited. Enter saves every change, Escape abandons them,
// and leaving the cell keeps the edit (marked) for the Save bar.
function FieldCell({
  fieldKey: key, errorField, icon, label, type, value, open, line, tint,
  onOpen, onClose, onChange, onSave, onCancel
}) {
  const head = (
    <span className="pp-cc-key">
      <span className="ms pp-cc-icon">{icon}</span>
      <span className="pp-cc-label">{label}</span>
    </span>
  )

  if (open) {
    return (
      <label className="pp-cc-row pp-cc-row-open">
        {head}
        <span style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '5px 12px' }}>
          <input
            autoFocus
            type={type}
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onBlur={onClose}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); onSave() }
              if (e.key === 'Escape') { e.preventDefault(); onCancel() }
            }}
            placeholder={`Add ${label.toLowerCase()}`}
            // Marked for a screen reader as the field that failed.
            aria-invalid={errorField === key || undefined}
            className={errorField === key ? 'pp-cc-input pp-cc-input-bad' : 'pp-cc-input'}
          />
        </span>
      </label>
    )
  }

  return (
    <button
      type="button"
      onClick={onOpen}
      className="pp-cc-row"
      title={`${label} — click to edit`}
      aria-invalid={errorField === key || undefined}
      style={{
        // A bar on the cell's left edge in the state colour, plus its tint.
        boxShadow: line ? `inset 3px 0 0 ${line}` : undefined,
        background: tint
      }}
    >
      {head}
      <span className={value ? 'pp-cc-value' : 'pp-cc-value pp-cc-value-empty'}>
        {value || 'Not set'}
      </span>
      <span className="ms pp-cc-pencil">edit</span>
    </button>
  )
}

// ── Custom fields ─────────────────────────────────────────────────────
//
// One collapsible section per GHL folder. The server sends them already
// grouped, typed and valued (customFieldGroups in routes/contacts.js), so
// this is a form over that shape rather than a second place that decides what
// a custom field is.
//
// SAVES SEPARATELY from the Details panel. Custom fields go to GHL as
// `customFields: [{ id, field_value }]` — a different part of the body from
// firstName/email, and forty of them behind one Save would make an
// unrelated failure look like a failed name change.
function CustomFields({ contact, onSaved }) {
  const groups = contact.customFieldGroups || []
  const [draft, setDraft] = useState({})
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)

  const dirtyIds = Object.keys(draft)

  const setField = (id, value) => {
    setDraft((d) => ({ ...d, [id]: value }))
    if (state === 'error') { setState('idle'); setError(null) }
  }

  const save = async () => {
    if (!dirtyIds.length) return
    setState('saving')
    setError(null)
    try {
      // Only what changed. field_value (snake case) is what GHL wants — the
      // server accepts either spelling and normalises, but sending the right
      // one keeps the wire format obvious at the call site.
      const customFields = dirtyIds.map((id) => ({
        id,
        field_value: normaliseOut(draft[id])
      }))
      const res = await contactsAPI.update(contact.id, { customFields })
      // Prefer the server's echo: it re-reads the definitions and returns the
      // groups with stored values, so a value GHL normalised shows correctly
      // rather than as we typed it.
      if (res?.customFieldGroups) onSaved(res.customFieldGroups)
      setDraft({})
      setState('saved')
      window.setTimeout(() => setState('idle'), 2000)
    } catch (err) {
      setError(err.message || 'Could not save those fields')
      setState('error')
    }
  }

  const revert = () => { setDraft({}); setState('idle'); setError(null) }

  if (!groups.length) {
    // Not an error, and not worth a panel: a location with no custom fields
    // for contacts is an ordinary setup.
    return null
  }

  return (
    <Panel
      icon="tune"
      title="Custom fields"
      accent="sky"
      meta={
        state === 'saving' ? 'Saving…'
          : state === 'saved' ? 'Saved'
          : state === 'error' ? error
          : dirtyIds.length
            ? `${dirtyIds.length} unsaved change${dirtyIds.length === 1 ? '' : 's'}`
            : `${groups.length} ${groups.length === 1 ? 'folder' : 'folders'}`
      }
      metaTone={state === 'error' ? 'error' : 'muted'}
    >
      <div style={{ padding: '12px var(--space-4)' }}>
        <CustomFieldSections
          groups={groups}
          draft={draft}
          onChange={setField}
          // Uploads go straight to GHL rather than waiting for Save — a file
          // is not a draft value, and batching would risk discarding an
          // upload that already succeeded because a text field was rejected.
          onUpload={async (fieldKey, files) => {
            const res = await contactsAPI.uploadCustomFieldFiles(
              contact.id, fieldKey, files
            )
            return res.files || []
          }}
          disabled={state === 'saving'}
        />
      </div>

      {/* Only once something has changed. A permanent Save bar on a panel
          that is usually just read is noise. */}
      {dirtyIds.length > 0 && (
        <div className="pp-cf-foot">
          <span className="pp-cf-foot-note">
            {dirtyIds.length} field{dirtyIds.length === 1 ? '' : 's'} changed
          </span>
          <button
            type="button"
            onClick={revert}
            disabled={state === 'saving'}
            className="pp-cf-btn"
          >
            Discard
          </button>
          <button
            type="button"
            onClick={save}
            disabled={state === 'saving'}
            className="pp-cf-btn pp-cf-btn-go"
          >
            {state === 'saving' ? 'Saving…' : 'Save fields'}
          </button>
        </div>
      )}
    </Panel>
  )
}

// What goes on the wire for one field.
//
// A multi-select holds an array; GHL stores those as a comma-joined string on
// the contact, and sending an array where it wants a scalar is one of the
// shapes it accepts and then ignores. An empty value is '' rather than a
// dropped key — omitting it leaves the old value in place.
function normaliseOut(v) {
  if (v == null) return ''
  if (Array.isArray(v)) return v.join(',')
  return v
}

// ── Do not disturb ────────────────────────────────────────────────────

// Two hints per row: what is true now, not one description that only makes
// sense in the muted state. "No outbound email" beside a switch reading ON
// described a state the contact was not in.
const DND_ROWS = [
  ['all', 'All channels', 'block',
    'Reachable on every channel', 'Muted everywhere — master switch'],
  ['email', 'Email', 'mail',
    'We can email them', 'No outbound email'],
  ['sms', 'Text messages', 'sms',
    'We can text them', 'No SMS, WhatsApp or iMessage'],
  ['call', 'Calls and voicemail', 'call',
    'We can call them', 'No outbound dials or voicemail drops'],
  ['inbound', 'Inbound calls and SMS', 'call_received',
    'Their calls and texts reach us', 'Their inbound calls and texts are silenced']
]

function DoNotDisturb({ contact, onChange }) {
  const [pending, setPending] = useState(null)
  const dnd = contact.dnd || {}

  const isBlocked = (key) => {
    if (key === 'all') return dnd.all === true
    if (key === 'inbound') return dnd.inbound === true
    // Master switch wins: showing a channel as "on" while everything is muted
    // would be a lie.
    return dnd.all === true || dnd.channels?.[key] === true
  }

  const toggle = async (key) => {
    const next = !isBlocked(key)
    setPending(key)
    try {
      const res = await contactsAPI.setDnd(contact.id, key, next)
      onChange(res.dnd)
    } catch (err) {
      // Nothing changed locally, so there's nothing to roll back.
    } finally {
      setPending(null)
    }
  }

  const blockedCount = dnd.blockedCount || 0
  // Says what is BLOCKED, not what is on. Under a heading reading "Do not
  // disturb", "All channels on" was read as "DND is on for everything" —
  // the exact opposite of what it meant.
  const meta = dnd.all
    ? 'Everything muted'
    : blockedCount > 0
    ? `${blockedCount} channel${blockedCount === 1 ? '' : 's'} muted`
    : 'Nothing muted'

  return (
    <Panel
      icon="do_not_disturb_on"
      title="Do not disturb"
      // Rose only when something IS muted. A permanently red panel over a
      // contact who is fully reachable reads as a warning about nothing —
      // and reinforced the misreading that DND was switched on.
      accent={(dnd.all || blockedCount > 0 || dnd.inbound) ? 'rose' : 'gray'}
      meta={meta}
    >
      <p
        style={{
          margin: 0, padding: '10px var(--space-4)',
          borderTop: '1px solid var(--border-default)',
          borderBottom: '1px solid var(--border-default)',
          background: 'var(--gray-50)',
          fontSize: 'var(--text-base)', lineHeight: 1.5, color: 'var(--text-body)'
        }}
      >
        {/* Says which direction the switch runs, because the panel's own
            title works the other way round. */}
        {/* Says which way the switch runs, in the same sense as GHL's own
            checkboxes: turn it ON to stop contacting them there. */}
        Turn a channel <strong>on</strong> to stop contacting them there —
        the same as ticking its box in your CRM. A muted channel goes quiet
        everywhere this contact appears: deal cards flag it, and the AI will
        not draft a message on it.
      </p>

      {DND_ROWS.map(([key, label, icon, okHint, mutedHint], i) => {
        const blocked = isBlocked(key)
        // A per-channel row is not independently toggleable while the master
        // switch is on — it's already muted, so offering the control would
        // imply an effect it can't have.
        const forced = key !== 'all' && key !== 'inbound' && dnd.all === true
        return (
          <div
            key={key}
            style={{
              display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
              padding: 'var(--space-3) var(--space-4)',
              borderBottom: i === DND_ROWS.length - 1
                ? 'none'
                : '1px solid var(--border-default)',
              opacity: forced ? 0.6 : 1
            }}
          >
            <span
              className="ms"
              style={{ fontSize: 'var(--text-xl)', color: blocked ? 'var(--status-stuck)' : 'var(--text-faint)' }}
            >
              {icon}
            </span>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span
                style={{
                  display: 'block', fontSize: 'var(--text-lg)', fontWeight: 600,
                  color: 'var(--text-heading)'
                }}
              >
                {label}
              </span>
              <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                {blocked ? mutedHint : okHint}
              </span>
            </span>
            <Switch
              // MATCHES GHL. Their panel has a checkbox per channel that you
              // TICK to turn DND on. Ours was the inverse — on = reachable —
              // which was internally consistent but meant the same channel
              // read ON here and unchecked there. Two systems, opposite
              // states, same word.
              on={blocked}
              disabled={forced || pending === key}
              busy={pending === key}
              onToggle={() => toggle(key)}
              label={label}
            />
          </div>
        )
      })}
    </Panel>
  )
}

// On = reachable, Off = blocked. Worth stating, because the underlying data is
// inverted (GHL's "DND active" means blocked) and a switch that reads "on" for
// "muted" would be a trap.
function Switch({ on, disabled, busy, onToggle, label }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', flex: 'none' }}>
      <span
        style={{
          fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: 'var(--tracking-label)',
          // Rose when muted, green when reachable. The switch reads ON for
          // muted now, so keying the colour to `on` would paint a blocked
          // channel green.
          color: on ? 'var(--status-stuck)' : 'var(--green-600)'
        }}
      >
        {/* The switch is now DND itself, so ON means muted — the same sense
            as GHL's checkbox. The words still say what is true of the
            CONTACT rather than relying on the reader to know which way the
            control runs. */}
        {busy ? '···' : on ? 'MUTED' : 'OK'}
      </span>
      <button
        role="switch"
        aria-checked={on}
        // "Email — muted", not "Email — on". A screen-reader user gets no
        // colour and no chance to infer which way the control runs.
        aria-label={`${label} — ${on ? 'muted' : 'reachable'}`}
        disabled={disabled}
        onClick={onToggle}
        style={{
          position: 'relative',
          width: 42, height: 24, flex: 'none',
          border: 'none', borderRadius: 'var(--radius-pill)',
          // Rose when muted. Green for a muted channel would be the same
          // inversion in colour that the labels just lost.
          background: on ? 'var(--status-stuck)' : 'var(--gray-300)',
          cursor: disabled ? 'not-allowed' : 'pointer',
          transition: 'background 0.15s ease-out'
        }}
      >
        <span
          style={{
            position: 'absolute', top: 3, left: on ? 21 : 3,
            width: 18, height: 18, borderRadius: '50%',
            background: '#fff',
            boxShadow: '0 1px 2px rgba(31,36,48,.3)',
            transition: 'left 0.15s ease-out'
          }}
        />
      </button>
    </span>
  )
}

// ── Deals ─────────────────────────────────────────────────────────────

function Deals({ deals = [], onOpenDeal }) {
  return (
    <Panel
      icon="sell"
      title="Deals"
      accent="pine"
      meta={`${deals.length} ${deals.length === 1 ? 'deal' : 'deals'}`}
    >
      <StateMessage
        empty={deals.length === 0}
        emptyText="This contact isn't on any deals yet."
      />
      {deals.map((d, i) => (
        <div
          key={d.id}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
            padding: 'var(--space-3) var(--space-4)',
            borderBottom: i === deals.length - 1 ? 'none' : '1px solid var(--border-default)'
          }}
        >
          <span className="ms" style={{ fontSize: 17, color: 'var(--accent-pine)' }}>sell</span>
          <span style={{ flex: 1, minWidth: 0 }}>
            <Truncate style={{ display: 'block', fontSize: 'var(--text-lg)', fontWeight: 600,
                color: 'var(--text-heading)' }}>
              {d.name || '(unnamed deal)'}
            </Truncate>
            <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
              {[d.stage, d.pipeline].filter(Boolean).join(' · ')}
            </span>
          </span>
          {/* "£0" included — a zero-value deal is still a value, and the
              design shows it. Only a missing one is left blank. */}
          {d.value != null && d.value !== '' && (
            <span
              style={{
                fontSize: 'var(--text-md)', fontWeight: 600,
                fontVariantNumeric: 'tabular-nums',
                color: 'var(--text-heading)', flex: 'none'
              }}
            >
              {Number.isFinite(Number(d.value))
                ? `£${Number(d.value).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
                : d.value}
            </span>
          )}
          {/* The same green chip every other surface uses to open a deal —
              Notes, Tasks, the Deals table, Businesses.

              This was a solid brand-filled button reading "Open deal →",
              made primary because opening the deal is the only thing this
              row is for. That reasoning was sound in isolation, but it made
              a fourth distinct treatment for one action, and a rep who
              learns the chip everywhere else has to learn this separately.
              Consistency wins: the chip is unmistakably the deal control,
              and it is the row's only action either way. */}
          <DealPill name={d.name || d.opportunityName} onClick={() => onOpenDeal && onOpenDeal(d.id)} />
        </div>
      ))}
    </Panel>
  )
}

// ── All messages ──────────────────────────────────────────────────────

// Every message for this contact, whatever deal it is linked to.
//
// This is the view James asked for on 8 Sep: the deal timeline shows what
// belongs to a deal, and this shows EVERYTHING so a manager can find the
// messages that were never attributed and link them by hand.
//
// Cards match the deal timeline's on purpose. A rep moving between the two
// should not have to re-learn how a message reads.
//
// Fetched here rather than with the contact: the list can be long, and a rep
// who never opens this panel should not pay for it on every contact load.
function AllMessages({ contactId, deals = [], onOpenDeal }) {
  // The attachment lightbox, hosted here rather than per card so paging
  // through a message's files works the way it does on the deal timeline.
  const [viewing, setViewing] = useState(null)
  const [messages, setMessages] = React.useState(null)
  const [error, setError] = React.useState(null)
  const [unlinkedOnly, setUnlinkedOnly] = React.useState(false)
  const [picked, setPicked] = React.useState(() => new Set())
  const [saving, setSaving] = React.useState(false)
  const [saveError, setSaveError] = React.useState(null)
  const [target, setTarget] = React.useState('')

  const load = React.useCallback(() => {
    let alive = true
    setError(null)
    contactsAPI.messages(contactId, { unlinkedOnly })
      .then((r) => { if (alive) setMessages(r.messages || []) })
      .catch((e) => {
        if (alive) setError(e?.response?.data?.error || 'Could not load the messages')
      })
    return () => { alive = false }
  }, [contactId, unlinkedOnly])

  React.useEffect(load, [load])

  const rows = messages || []
  const unlinked = rows.filter((m) => !m.deal).length

  const toggle = (id) => setPicked((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })

  async function assign() {
    if (picked.size === 0) return
    setSaving(true)
    setSaveError(null)
    try {
      const r = await contactsAPI.setMessagesMapping(
        contactId, [...picked], target || null
      )
      // `rejected` names ids the server would not move — reported rather than
      // swallowed, or "12 moved" out of 20 looks like a silent failure.
      if (r?.rejected?.length) {
        setSaveError(`${r.rejected.length} could not be moved — they are not on this contact`)
      }
      setPicked(new Set())
      load()
    } catch (e) {
      setSaveError(e?.response?.data?.error || e?.message || 'That did not save')
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      icon="forum"
      title="All messages"
      accent="gold"
      meta={
        messages === null ? '—'
          : `${rows.length}${unlinked > 0 ? ` · ${unlinked} unlinked` : ''}`
      }
    >
      <p style={{
        margin: 0, padding: '10px var(--space-4)',
        borderTop: '1px solid var(--border-default)',
        background: 'var(--gray-50)',
        fontSize: 'var(--text-base)', lineHeight: 1.5, color: 'var(--text-body)'
      }}>
        A message is linked to one deal at most. Messages sent when no deal was
        open stay here until someone links them — tick them and pick a deal
        below.
      </p>

      {/* Filter + bulk bar. Sticky so the action stays reachable on a long
          list rather than scrolling away above the selection it applies to. */}
      <div style={{
        position: 'sticky', top: 0, zIndex: 2,
        display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
        flexWrap: 'wrap',
        padding: '8px var(--space-4)',
        borderTop: '1px solid var(--border-default)',
        borderBottom: '1px solid var(--border-default)',
        background: '#fff'
      }}>
        <label style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          fontSize: 'var(--text-sm)', color: 'var(--text-muted)', cursor: 'pointer'
        }}>
          <input
            type="checkbox"
            checked={unlinkedOnly}
            onChange={(e) => { setUnlinkedOnly(e.target.checked); setPicked(new Set()) }}
            style={{ accentColor: 'var(--brand-primary)' }}
          />
          Unlinked only
        </label>

        <span style={{ flex: 1 }} />

        {picked.size > 0 && (
          <>
            <span style={{
              fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-body)'
            }}>
              {picked.size} selected
            </span>
            <Select
              value={target}
              onChange={(v) => setTarget(v ?? '')}
              disabled={saving}
              // Searchable, and OUR menu: a native <select> renders the OS's
              // own list, which cannot be styled or searched — and a contact
              // with a dozen deals is exactly where searching starts to matter.
              showSearch
              optionFilterProp="label"
              popupClassName="pp-menu"
              // The menu is wider than the control when a deal name needs it,
              // rather than truncating every option to the box.
              popupMatchSelectWidth={false}
              style={{ width: 280 }}
              styles={{ root: { height: 30 } }}
              options={[
                // The blank entry means "no deal", not an action on many —
                // a message is on one deal at most. Phrased as a destination
                // so it reads consistently with the deal names below it.
                { value: '', label: '— No deal (leave on the contact)' },
                ...deals.map((d) => ({
                  value: d.id,
                  label: `${d.name}${d.status && d.status !== 'open' ? ` (${d.status})` : ''}`
                }))
              ]}
            />
            <button
              type="button"
              onClick={assign}
              disabled={saving}
              style={{
                padding: '5px 12px', fontSize: 'var(--text-sm)', fontWeight: 600,
                border: 'none', borderRadius: 'var(--radius-md)',
                background: 'var(--brand-primary)', color: '#fff',
                cursor: saving ? 'wait' : 'pointer'
              }}
            >
              {saving ? 'Filing…' : 'Apply'}
            </button>
          </>
        )}
      </div>

      {saveError && (
        <p role="alert" style={{
          margin: 0, padding: '8px var(--space-4)',
          fontSize: 'var(--text-sm)', color: 'var(--status-stuck)',
          borderBottom: '1px solid var(--border-default)'
        }}>
          {saveError}
        </p>
      )}

      <StateMessage
        loading={messages === null && !error}
        error={error}
        empty={messages !== null && rows.length === 0}
        emptyText={unlinkedOnly ? 'Nothing unlinked — every message is on a deal.' : 'No messages synced for this contact yet.'}
      />

      {rows.map((m, i) => (
        <ContactMessageCard
          key={m.id}
          m={m}
          last={i === rows.length - 1}
          selected={picked.has(m.messageId)}
          onToggle={() => toggle(m.messageId)}
          deals={deals}
          // EmailBody calls this unconditionally when a chip is clicked, so it
          // is not optional — without it a click throws.
          onOpenAttachment={(atts, i) => setViewing({ attachments: atts, index: i })}
          // One message at a time, through the contact route — there is no
          // deal in scope here, so the deal-scoped endpoint does not apply.
          onFile={(messageId, opportunityId) =>
            contactsAPI.setMessagesMapping(contactId, [messageId], opportunityId)}
          onMoved={load}
        />
      ))}

      {viewing && (
        <AttachmentViewer
          attachments={viewing.attachments}
          index={viewing.index}
          onClose={() => setViewing(null)}
        />
      )}
    </Panel>
  )
}

// One message, styled to match the deal timeline's rows.
//
// The deal timeline is where a rep spends their day; a contact's messages
// looking materially different made the same record read as two things.
function ContactMessageCard({ m, last, selected, onToggle, deals, onFile, onMoved, onOpenAttachment }) {
  const inbound = m.direction === 'inbound'
  // GHL labels the same channel several ways — 'Email', 'TYPE_EMAIL' and
  // 'EMAIL' all appear in one contact's history (visible in the screenshot
  // that prompted this). Matching only 'Email' would give the same thread
  // two different card styles on adjacent rows.
  const isEmail = /email/i.test(m.channel || '')
  const icon = m.isCall ? 'call'
    : m.channel === 'Email' ? 'mail'
      : m.channel === 'SMS' ? 'sms' : 'chat'

  return (
    <div style={{
      display: 'flex', alignItems: 'flex-start', gap: 10,
      padding: 'var(--space-3) var(--space-4)',
      borderBottom: last ? 'none' : '1px solid var(--border-default)',
      background: selected ? 'var(--tint-pine)' : 'transparent'
    }}>
      <input
        type="checkbox"
        checked={selected}
        onChange={onToggle}
        aria-label={`Select this ${m.channel || 'message'}`}
        style={{
          marginTop: 3, width: 16, height: 16, flex: 'none',
          accentColor: 'var(--brand-primary)', cursor: 'pointer'
        }}
      />

      <span style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 30, height: 30, flex: 'none', marginTop: 1,
        borderRadius: 'var(--radius-md)', background: 'var(--gray-50)'
      }}>
        <span className="ms" style={{ fontSize: 16, color: 'var(--text-muted)' }}>{icon}</span>
      </span>

      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <span style={{
            fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-heading)'
          }}>
            {m.senderName || (inbound ? 'Customer' : 'Team member')}
          </span>
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {m.channel}
          </span>
        </div>

        {/* An email gets the SAME collapsed card as the deal timeline —
            subject line, chevron, expand to the full body. The contact view
            used to flatten it to a paragraph of stripped text, so the same
            email looked like two different records depending on the page.
            EmailBody is shared rather than copied, so they cannot drift
            apart again. */}
        {isEmail ? (
          <div style={{ marginTop: 4 }}>
            <EmailBody m={m} onOpenAttachment={onOpenAttachment} />
          </div>
        ) : (
          <p style={{
            margin: '3px 0 0', maxWidth: 640,
            fontSize: 'var(--text-md)', lineHeight: 1.5, color: 'var(--text-body)'
          }}>
            {htmlToText(m.body || '').slice(0, 240)
              || <span style={{ color: 'var(--text-faint)' }}>(no readable text)</span>}
          </p>
        )}

        {/* Media on a non-email message. EmailBody renders an email's own
            chips, so this branch is guarded the same way the deal timeline
            guards it — otherwise every email file would render twice. */}
        {!isEmail && m.attachments?.length > 0 && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
            {m.attachments.map((att, i) => (
              <AttachmentChip
                key={`${att.name}-${i}`}
                att={att}
                channelAccent={m.channelAccent}
                onClick={() => onOpenAttachment && onOpenAttachment(m.attachments, i)}
              />
            ))}
          </div>
        )}
      </div>

      <span style={{
        // ONE line: pill, direction, date — matching the deal timeline.
        //
        // This was a column, so the pill sat on a second row under the date
        // and read as a detached control rather than part of the row's
        // metadata.
        display: 'flex', alignItems: 'center', gap: 6,
        flex: 'none', whiteSpace: 'nowrap', flexWrap: 'nowrap',
        // Level with the first line of the message, not the middle of a
        // tall email card.
        alignSelf: 'start'
      }}>
        {/* The deal, AND the control to change it — the same pill the deal
            timeline uses, so the two pages behave identically. Read-only
            here before, which meant the only way to file one message was to
            tick it and use the bulk bar above.

            First, so the dates stay aligned down the right edge: the pill is
            the variable-width element and putting it outside would leave
            them ragged. */}
        <MessageDealPill
          message={m}
          targets={deals}
          onSave={onFile}
          onMoved={onMoved}
        />
        <span style={{
          fontSize: 'var(--text-xs)', fontWeight: 600,
          letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
          color: inbound ? 'var(--accent-pine-text)' : 'var(--text-faint)'
        }}>
          {inbound ? 'Inbound' : 'Outbound'}
        </span>
        <span style={{
          fontSize: 'var(--text-sm)', color: 'var(--text-faint)',
          fontVariantNumeric: 'tabular-nums'
        }}>
          {formatDate(m.ts)}
        </span>
      </span>
    </div>
  )
}
