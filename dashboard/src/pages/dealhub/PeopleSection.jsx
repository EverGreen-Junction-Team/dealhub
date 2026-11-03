import React, { useMemo, useState } from 'react'
import PanelHead from './PanelHead'
import { FieldRow } from './FieldCard'
import { dealsAPI } from '../../api/deals'
import ContactPicker from '../shared/ContactPicker'
import { nameFor } from '../shared/ListChrome'
import ConfirmDialog from '../shared/ConfirmDialog'
import BusinessPickerModal from '../shared/BusinessPickerModal'
import EditableContactRow from './ContactFieldEdit'

// Deal Hub — People section (opp-associated contacts).
//
// One card per contact linked to this opportunity via
// OPPORTUNITIES_CONTACTS_ASSOCIATION. Primary contact first, then followers.
// Each card takes the contact's own accent colour (stable hash) so the same
// person looks the same across every screen (People card, timeline sender
// dot, filter chips, contact record).
//
// Actions on each card:
//   Show in thread     → filters the timeline to this person's messages
//   View contact       → opens the contact record on the Contacts tab
//   Remove             → unlinks this contact from this opp. Hidden on the
//                        last remaining contact (GHL files notes and tasks
//                        against a contact, so a deal with none can hold
//                        neither) and on a synthesised primary, which has no
//                        relation row to delete.
//   Make primary       → reassigns the deal's own contactId. Hidden on the
//                        contact that is already primary.
//
// A note on "primary": it is the OPPORTUNITY's contactId, not a flag on the
// relation. POST /associations/relations takes no `primary` field and
// relations have no update endpoint — our opportunity_contacts.is_primary is
// only ever reported to us, via `event.primary` on RelationCreate. Changing
// it means changing the opportunity, which PUT /opportunities/:id does accept
// (undocumented; see PersonCard).

export default function PeopleSection({
  people = [],
  peopleFilter = [],
  onPeopleFilterChange,
  // Opens the contact's record on the Contacts tab. "View contact" was
  // hardcoded disabled with a "coming next" title only because nothing passed
  // this down — the shell has had openContact all along.
  onOpenContact,
  // (contactId, patch) after a field is edited in place on a card.
  onContactSaved,
  // (business, person) after the Business pencil links a company.
  onBusinessLinked,
  // Needed to add someone — the link is made against the opportunity.
  dealId,
  // Called after a successful add or remove so the parent refetches; the
  // Relation webhooks are what actually write and delete the row.
  onPeopleChanged
}) {
  // Which contact is mid-unlink, and any failure to report.
  const [removingId, setRemovingId] = useState(null)
  const [removeError, setRemoveError] = useState(null)

  const [primaryId, setPrimaryId] = useState(null)
  // The person a Remove click is asking about. Unlinking is not reversible
  // from here — re-adding is a fresh GHL relation — and the button sits
  // beside "Make primary", so a misfire is easy.
  const [confirming, setConfirming] = useState(null)
  // The person whose Business pencil opened the company picker.
  const [linking, setLinking] = useState(null)

  const makePrimary = async (p) => {
    if (!p?.id || p.primary || primaryId) return
    setPrimaryId(p.id)
    setRemoveError(null)
    try {
      await dealsAPI.setPrimaryContact(dealId, p.id)
      onPeopleChanged && onPeopleChanged()
    } catch (err) {
      setRemoveError(err.message || 'Could not change the primary contact')
      window.setTimeout(() => setRemoveError(null), 4000)
    } finally {
      setPrimaryId(null)
    }
  }

  const removePerson = async (p) => {
    // The LINK id, not the contact id.
    if (!p?.relationId || removingId) return
    setRemovingId(p.id)
    setRemoveError(null)
    try {
      await dealsAPI.removeContact(dealId, p.relationId)
      setConfirming(null)
      onPeopleChanged && onPeopleChanged()
    } catch (err) {
      // Reported INSIDE the dialog, which stays open — the reader can read
      // the reason and retry without hunting for the row again.
      setRemoveError(err.message || 'Could not remove that person — try again')
    } finally {
      setRemovingId(null)
    }
  }

  if (!people || people.length === 0) return null

  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: 'var(--accent-sky-text)',
        ['--panel-tint']: 'var(--tint-sky)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        overflow: 'hidden'
      }}
    >
      <PanelHead
        icon="group"
        title="People"
        accent="sky"
        subtitle={`${people.length} ${people.length === 1 ? 'person' : 'people'}`}
      />

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: 0
        }}
      >
        {people.map((p) => (
          <PersonCard
            key={p.id}
            p={p}
            filterActive={peopleFilter.includes(p.id)}
            // A TOGGLE, not a one-way set. It always sent [p.id], so once a
            // person was filtered the only way back to the whole thread was
            // the "Everyone" chip below — and the button stayed lit while
            // doing nothing on a second press.
            onShowInThread={() => {
              if (!onPeopleFilterChange) return
              onPeopleFilterChange(
                peopleFilter.includes(p.id)
                  ? peopleFilter.filter((id) => id !== p.id)
                  : [...peopleFilter, p.id]
              )
            }}
            // The deal must keep at least one contact: GHL files notes and
            // tasks against a contact, so a deal with none can hold neither.
            allowRemove={people.length > 1}
            onRemove={() => { setRemoveError(null); setConfirming(p) }}
            removing={removingId === p.id}
            onMakePrimary={() => makePrimary(p)}
            settingPrimary={primaryId === p.id}
            onViewContact={onOpenContact ? () => onOpenContact(p.id) : undefined}
            onContactSaved={onContactSaved}
            onLinkBusiness={() => setLinking(p)}
          />
        ))}
      </div>

      {/* A failed action, reported where the cards are rather than as a toast.
          Only when NO dialog is open: a removal failure renders inside the
          confirm, and showing it in both places at once reads as two errors.
          "Make primary" has no dialog, so this is still its only channel. */}
      {removeError && !confirming && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 7,
            margin: '0 var(--space-4) 10px',
            padding: '8px 11px',
            border: '1px solid var(--status-stuck)',
            borderRadius: 'var(--radius-sm)',
            background: 'var(--tint-rose)',
            fontSize: 'var(--text-md)', color: 'var(--status-stuck-text)'
          }}
        >
          <span className="ms" style={{ fontSize: 16, flex: 'none' }}>error</span>
          {removeError}
        </div>
      )}

      <AddContactFooter dealId={dealId} people={people} onAdded={onPeopleChanged} />

      {linking && (
        <BusinessPickerModal
          contact={linking}
          blurb={`Links ${nameFor(linking)} to the business, so it shows on every deal they are on.`}
          onClose={() => setLinking(null)}
          onLinked={(business) => {
            const person = linking
            setLinking(null)
            // The card's Business row reads the contact's company name.
            onContactSaved && onContactSaved(person.id, { business: business.name || null })
            onBusinessLinked && onBusinessLinked(business, person)
          }}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title="Remove from this deal?"
          message={
            `${nameFor(confirming)} will no longer be linked to this deal. `
            + 'Their contact record and its history are not deleted.'
          }
          // What is about to go, so the reader can check they clicked the
          // right card before confirming.
          preview={[nameFor(confirming), confirming.email || confirming.phone]
            .filter(Boolean).join(' · ')}
          confirmLabel="Remove"
          busy={removingId === confirming.id}
          error={removeError}
          onConfirm={() => removePerson(confirming)}
          onCancel={() => { setConfirming(null); setRemoveError(null) }}
        />
      )}
    </section>
  )
}

// Contacts in GHL are often skeletal — sometimes just a phone or an email,
// no name at all. Rather than falling back to a generic "Contact" label
// (which the user can't tell apart from every other unnamed person), pick
// the best identifier we actually have, in this order:
//   1. first + last  (e.g. "Mark Whitmore")
//   2. first only    (e.g. "Mark")
//   3. last only     (e.g. "Whitmore")
//   4. email         (e.g. "mark@example.com")
//   5. phone         (e.g. "+447338628553")
//   6. business      (e.g. "SSEN")
//   7. "Contact"     — genuine last resort, no data at all
// Initials follow the same fallback: initials of a real name if we have
// one, else first char of the chosen identifier, else "?".
// What to show as the card's heading, and which field it came from.
//
// `usedField` matters: whatever gets promoted to the heading must not also
// appear as a detail row below it. The card was printing "SSEN" as the name and
// then "📞 SSEN" underneath — a business name behind a phone icon.
//
// Order is business → email → phone, not the old email → phone → business. A
// business is the most human label of the three, and a phone number is the
// least — it was winning over "SSEN" purely because of where it sat.
function displayFor(p) {
  const first = (p.firstName || '').trim()
  const last  = (p.lastName || '').trim()
  if (first && last) {
    return { name: `${first} ${last}`, initials: (first[0] + last[0]).toUpperCase(), usedField: null }
  }
  if (first) return { name: first, initials: first.slice(0, 2).toUpperCase(), usedField: null }
  if (last)  return { name: last,  initials: last.slice(0, 2).toUpperCase(), usedField: null }

  if (p.business) {
    return {
      name: p.business,
      initials: initialsFromWords(p.business),
      usedField: 'business'
    }
  }
  if (p.email) {
    return { name: p.email, initials: p.email[0].toUpperCase(), usedField: 'email' }
  }
  if (p.phone) {
    // A person icon, not '#'. The old placeholder read as a broken glyph — the
    // card showed a literal hash in the avatar circle.
    return { name: p.phone, initials: null, usedField: 'phone' }
  }
  return { name: 'Unnamed contact', initials: null, usedField: null }
}

// "SSEN" -> "SS", "Halloran Architects" -> "HA". Two letters either way, so
// every avatar is the same visual weight.
function initialsFromWords(value) {
  const words = String(value).trim().split(/\s+/).filter(Boolean)
  if (words.length >= 2) return (words[0][0] + words[1][0]).toUpperCase()
  return (words[0] || '').slice(0, 2).toUpperCase() || null
}

function PersonCard({ p, filterActive, onShowInThread, allowRemove, onRemove, removing, onMakePrimary, settingPrimary, onViewContact, onContactSaved, onLinkBusiness }) {
  // `usedField` is no longer read: the detail cells render every field
  // unconditionally now, so there is nothing to suppress as "already shown in
  // the heading".
  const { name: fullName, initials } = displayFor(p)
  // Two variants, two jobs. The vivid fill is right for a 3px border; as TEXT
  // on its own tint it's 4.13:1, below AA — so the avatar initials use the
  // darkened -text pair.
  const accent = `var(--accent-${p.accent})`
  const accentText = `var(--accent-${p.accent}-text)`
  const tint = `var(--tint-${p.accent})`

  return (
    <div
      style={{
        minWidth: 0,
        padding: '14px var(--space-4)',
        borderRight: '1px solid var(--border-default)',
        borderBottom: '1px solid var(--border-default)',
        borderTop: `3px solid ${accent}`,
        // filter-active state — subtle green ring around the card
        boxShadow: filterActive ? '0 0 0 2px var(--brand-primary) inset' : 'none'
      }}
    >
      {/* Head — avatar + name + primary + DND pill */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34, flex: 'none',
            borderRadius: '50%',
            background: tint, color: accentText,
            fontSize: 'var(--text-md)', fontWeight: 600
          }}
        >
          {/* No usable initials (a phone-only contact) gets a person icon.
              The old fallback was a literal '#', which read as a broken glyph
              rather than "we don't know who this is". */}
          {initials || <span className="ms" style={{ fontSize: 19 }}>person</span>}
        </span>
        <div style={{ minWidth: 0, flex: 1 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
            <span style={{ fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-heading)' }}>
              {fullName}
            </span>
            {p.primary && (
              <span
                style={{
                  fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
                  textTransform: 'uppercase',
                  padding: '2px 6px', borderRadius: 'var(--radius-sm)',
                  // Solid: on green-50 (1.13:1 against the white card) the badge
            // was invisible and PRIMARY read as ordinary small text.
            background: 'var(--green-600)', color: '#fff'
                }}
              >
                Primary
              </span>
            )}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            {p.contactType && (
              <span
                style={{
                  display: 'inline-block',
                  fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
                  textTransform: 'uppercase',
                  padding: '2px var(--space-2)', borderRadius: 'var(--radius-sm)',
                  background: tint, color: accent
                }}
              >
                {p.contactType}
              </span>
            )}
            {/* Contact permissions. Shown on the card because this is where a
                rep decides how to follow up — and the AI draft gate refuses
                these channels, so the two must visibly agree. */}
            <DndChip dnd={p.dnd} />
          </div>
        </div>
      </div>

      {/* Contact details — the same bordered cells the deal card's CUSTOMER
          block uses, so a person reads the same way wherever they appear.
          EVERY field renders, filled or not: these lines used to be hidden
          when empty, which made a contact with no email look complete rather
          than incomplete. A gap is the thing a rep needs to notice.

          The pencils open the CONTACT'S OWN RECORD rather than editing in
          place. Four inline editors here would be a second copy of the form
          that record already is — and these four fields are the ones most
          likely to be wrong together (a contact with no email usually has no
          business either), so the destination that shows all of them at once
          is the useful one. */}
      <div style={{
        marginTop: 10,
        border: '1px solid var(--gray-200)',
        borderRadius: 'var(--radius-sm)',
        overflow: 'hidden'
      }}>
        {/* EMAIL AND TELEPHONE EDIT IN PLACE (client request, Oct 2026) —
            the pencils used to open the contact's record. See
            ContactFieldEdit. */}
        <EditableContactRow
          contactId={p.id} field="email" type="email"
          icon="mail" label="Email" value={p.email}
          onSaved={onContactSaved}
        />
        <EditableContactRow
          contactId={p.id} field="phone" type="tel"
          icon="call" label="Telephone" value={p.phone}
          onSaved={onContactSaved}
        />
        {/* BUSINESS: the pencil opens the company picker right here — the
            same one the deal card's "+ Add business" uses — and links the
            contact to the business it picks. */}
        <FieldRow
          icon="business"
          label="Business"
          value={p.business}
          onEdit={onLinkBusiness}
          editTitle={`Link ${nameFor(p)} to a business`}
        />
        {/* The CUSTOM field, not p.contactType. That one is GHL's built-in
            lead/customer type and is already the badge beside the name;
            showing it again here as "Role" repeated one fact and hid the
            other. This is {{contact.contact_type}} — "Homeowner", "Partner".
            Its options live on the field's definition, so it still edits on
            the contact's record. */}
        <FieldRow
          icon="work"
          label="Contact type"
          value={p.contactTypeField}
          last
          onEdit={onViewContact}
          editTitle={onViewContact ? `Edit on ${nameFor(p)}'s record` : undefined}
        />
      </div>

      {/* Actions row */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 8, marginTop: 12, flexWrap: 'wrap'
        }}
      >
        <GhostBtn
          icon={filterActive ? 'filter_alt_off' : 'filter_alt'}
          onClick={onShowInThread}
          active={filterActive}
          // The label says what the next press DOES, so a lit button is not
          // just a state but a way out of it.
          title={
            filterActive
              ? `Stop filtering the timeline to ${nameFor(p)}`
              : `Show only ${nameFor(p)}'s messages in the timeline`
          }
        >
          {filterActive ? 'Showing in thread' : 'Show in thread'}
        </GhostBtn>
        {/* "Open CONTACT", the design's pairing — the verb plus a chip naming
            the record type, so the destination is on the button rather than
            only in its tooltip. */}
        <GhostBtn
          primary
          onClick={onViewContact}
          chip="CONTACT"
          title={onViewContact ? `Open ${nameFor(p)}'s record` : 'Contact record unavailable here'}
        >
          Open
        </GhostBtn>
        {/* MAKE PRIMARY.
            contactId is @HideApiProperty on GHL's PUT /opportunities/:id — it
            is absent from the marketplace docs, which is why this button read
            "coming next" for so long — but the service still applies it:

                if (body.contactId) opportunity.contactId = body.contactId

            It validates the contact exists and is not deleted, then updates.
            Routed through PUT /api/deals/:id/primary-contact rather than the
            ordinary deal patch: the field is undocumented on this verb, so
            isolating it means a withdrawal breaks reassignment alone rather
            than every deal edit. */}
        {!p.primary && (
          <GhostBtn
            icon={settingPrimary ? 'progress_activity' : 'star'}
            onClick={onMakePrimary}
            title={`Make ${nameFor(p)} the primary contact on this deal`}
          >
            {settingPrimary ? 'Setting' : 'Make primary'}
          </GhostBtn>
        )}

        {/* REMOVE, now wired. It sat inert as "coming next" because the deal
            detail route never sent relationId — the endpoint has always
            existed. `p.relationId` is null for a synthesised primary (a deal
            whose contact has no opportunity_contacts row), where there is no
            link to delete. */}
        {allowRemove && p.relationId && (
          <GhostBtn
            icon={removing ? 'progress_activity' : 'person_remove'}
            danger
            // Far right, away from the two that open things.
            style={{ marginLeft: 'auto' }}
            onClick={onRemove}
            title={`Remove ${nameFor(p)} from this deal`}
          >
            {removing ? 'Removing' : 'Remove'}
          </GhostBtn>
        )}
      </div>
    </div>
  )
}

// A person-card action: a SOLID PILL, per the client's design.
//
// These were borderless text-and-icon, which made four different actions —
// one of them a destructive Remove — read at exactly the same weight. The
// design gives each a fill, so the thing you can undo and the thing you
// cannot look different before you click.
//
//   default   slate   Show in thread, Make primary
//   primary   blue    Open contact
//   danger    red     Remove
//   active    pine    Show in thread, while the filter is on
// `style` is spread last so a caller can place the button — the Remove
// action takes marginLeft:auto to sit at the row's far right, as the design
// separates the destructive action from the two that open things.
function GhostBtn({ icon, children, onClick, active, danger, primary, title, chip, style }) {
  const fill = active
    ? 'var(--green-500)'
    : danger
      ? 'var(--status-stuck)'
      : primary
        ? 'var(--accent-sky)'
        // gray-600, not gray-700. 700 is the body-text colour and on a pill
        // it read as pure black; the design's neutral pill is a mid-dark
        // grey. White on it is 7.98:1 — AA with room.
        : 'var(--gray-600)';
  return (
    <button
      onClick={onClick}
      title={title}
      disabled={!onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        cursor: onClick ? 'pointer' : 'default',
        // A size up from 30px/text-base — the design's pills are the card's
        // footer controls, not tags.
        height: 36, padding: chip ? '0 5px 0 14px' : '0 14px',
        border: 'none',
        borderRadius: 'var(--radius-pill)',
        background: fill,
        color: '#fff',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-md)', fontWeight: 600,
        // Dimmed rather than hidden: a disabled action still says the action
        // exists, which is why these render at all when their handler is
        // missing.
        opacity: !onClick ? 0.45 : 1,
        ...style
      }}
    >
      {icon && <span className="ms" style={{ fontSize: 17 }}>{icon}</span>}
      {children}
      {/* The design's "Open CONTACT" pairing — a white chip naming the record
          type, inside the button. */}
      {chip && (
        <span style={{
          display: 'inline-flex', alignItems: 'center',
          height: 24, padding: '0 10px',
          borderRadius: 'var(--radius-pill)',
          background: '#fff', color: fill,
          fontSize: 11, fontWeight: 700,
          letterSpacing: 'var(--tracking-label)'
        }}>
          {chip}
        </span>
      )}
    </button>
  )
}

// Add a person to the deal.
//
// This was a bare <input> that typed into local state and printed
// "Add-contact search wires up next" — it searched nothing and saved nothing.
//
// ContactPicker is the app's existing searchable contact control: it queries
// GET /api/contacts?q= under RLS, matches name, email, phone AND business in
// one query, debounces, and guards against out-of-order responses. Rebuilding
// a search box here would have been a third copy of that.
//
// COLLAPSED until clicked, like the tag and field editors: a rail listing who
// is on a deal should not carry a permanently open search field.
// The most people one deal may carry: a primary contact plus ten more.
//
// A PRODUCT RULE, not GHL's limit. GHL's OPPORTUNITIES_CONTACTS_ASSOCIATION
// caps at 25 (see associationConstants.js on the server) — 11 is the tighter
// rule this client asked for, and being tighter it can never produce a call
// GHL would reject. If the two ever need to agree, the server constant is the
// one that describes the API; this one describes the product.
const MAX_PEOPLE = 11

function AddContactFooter({ dealId, people = [], onAdded }) {
  const [open, setOpen] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  // Everyone already on the deal, so the picker cannot offer a duplicate —
  // GHL would accept the second link and the rail would show the person twice.
  const alreadyOn = useMemo(
    () => new Set((people || []).map((p) => p.id).filter(Boolean)),
    [people]
  )

  const full = (people?.length || 0) >= MAX_PEOPLE

  const add = async (contactId) => {
    if (!contactId || saving) return
    // Belt and braces: the button is disabled at the cap and the picker
    // excludes existing people, but a stale render could still get here.
    if (full) {
      setError(`A deal can hold ${MAX_PEOPLE} people — remove someone first`)
      window.setTimeout(() => setError(null), 4000)
      return
    }
    if (alreadyOn.has(contactId)) {
      setError('That person is already on this deal')
      window.setTimeout(() => setError(null), 4000)
      return
    }
    setSaving(true)
    setError(null)
    try {
      await dealsAPI.addContact(dealId, contactId)
      setOpen(false)
      // The RelationCreate webhook writes opportunity_contacts, so the rail
      // refreshes from the server rather than us inventing a row — the same
      // reason nothing is written locally on the server side.
      onAdded && onAdded()
    } catch (err) {
      setError(err.message || 'Could not add that person — try again')
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap',
        padding: '10px var(--space-4)',
        borderTop: '1px solid var(--border-default)'
      }}
    >
      {!open ? (
        <button
          onClick={() => setOpen(true)}
          disabled={!dealId || full}
          title={
            !dealId ? 'No deal in scope'
              : full ? `This deal already has ${MAX_PEOPLE} people, the maximum`
                : 'Add someone to this deal'
          }
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 8,
            height: 40, padding: '0 18px 0 14px',
            // A SOLID yellow pill, the design's one loud control on the rail.
            // It was a dashed-outline ghost, which read as a drop target. Flat
            // grey when it cannot act, so the disabled state is not a
            // slightly paler yellow nobody would notice.
            border: 'none',
            borderRadius: 'var(--radius-pill)',
            background: (dealId && !full) ? 'var(--accent-sun)' : 'var(--gray-100)',
            color: (dealId && !full) ? 'var(--accent-sun-text)' : 'var(--text-faint)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
            cursor: (dealId && !full) ? 'pointer' : 'not-allowed'
          }}
        >
          <span className="ms" style={{ fontSize: 18 }}>person_add</span>
          {/* Says WHY it is disabled. A greyed "Add someone" with no
              explanation reads as broken. */}
          {full ? `${MAX_PEOPLE} people — limit reached` : 'Add someone'}
        </button>
      ) : (
        <>
          <span className="ms" style={{ fontSize: 17, color: 'var(--text-muted)' }}>
            person_add
          </span>
          <span style={{ minWidth: 280, flex: '0 1 340px' }}>
            <ContactPicker
              value={null}
              onChange={add}
              // Seeded with nobody: the people already on the deal are the ones
              // NOT to offer, so seeding with them would surface exactly the
              // wrong candidates first.
              seed={[]}
              // …and they are excluded outright, so a duplicate cannot be
              // clicked at all. Previously it was only caught afterwards, as
              // an error, which made the rep remember who was already there.
              exclude={[...alreadyOn]}
              // Show a first page immediately. "Start typing to find a
              // contact" is a dead end for anyone who does not already know
              // who is in the CRM.
              showInitial
              invalid={!!error}
            />
          </span>
          <button
            onClick={() => { setOpen(false); setError(null) }}
            disabled={saving}
            style={{
              height: 30, padding: '0 11px',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-card)', color: 'var(--text-body)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
              cursor: saving ? 'default' : 'pointer'
            }}
          >
            Cancel
          </button>
        </>
      )}

      {saving && (
        <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
          Adding…
        </span>
      )}
      {error && (
        <span style={{ fontSize: 'var(--text-base)', color: 'var(--status-stuck-text)' }}>
          {error}
        </span>
      )}
    </div>
  )
}

// Blocked-channel chip for a person card. Reads the same payload the AI draft
// gate uses (routes/deals.js people[].dnd), so a rep never sees "Email
// available" next to a draft that refused to use email.
function DndChip({ dnd }) {
  if (!dnd) return null
  if (dnd.all) {
    return (
      <span
        title="This contact has asked not to be contacted on any channel"
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
          fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
          textTransform: 'uppercase',
          padding: '2px var(--space-2)', borderRadius: 'var(--radius-sm)',
          background: 'var(--status-stuck)', color: '#fff'
        }}
      >
        <span className="ms" style={{ fontSize: 12 }}>block</span>
        Do not contact
      </span>
    )
  }
  const blocked = dnd.blockedChannels || []
  if (blocked.length === 0) return null
  return (
    <span
      title={`Switched off: ${blocked.map((b) => (b === 'sms' ? 'SMS' : b)).join(', ')}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
        fontSize: 'var(--text-xs)', fontWeight: 600,
        padding: '2px var(--space-2)', borderRadius: 'var(--radius-sm)',
        background: 'var(--tint-rose)', color: 'var(--status-stuck)'
      }}
    >
      <span className="ms" style={{ fontSize: 12 }}>block</span>
      {blocked.length} off
    </span>
  )
}
