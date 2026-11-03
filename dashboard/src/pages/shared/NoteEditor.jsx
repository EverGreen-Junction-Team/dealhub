import React, { useEffect, useMemo, useState } from 'react'
import { useModal } from '../../hooks/useModal'
import { Input } from 'antd'
import { notesAPI } from '../../api/notes'
import ContactPicker from './ContactPicker'
// LAZY. TipTap and ProseMirror are ~180 KB gzipped and are only needed once a
// note dialog opens — a rep reading the deals list should not download an
// editor. Suspense falls back to a sized placeholder so the dialog does not
// jump when it arrives.
const RichEditor = React.lazy(() => import('./RichEditor'))
import { sanitiseHtml, htmlToText } from '../../utils/sanitiseHtml'
import RemotePicker from './RemotePicker'
import {
  searchDeals, searchBusinesses, dealOption, businessOption
} from '../../hooks/useLinkTargets'
import { NOTE_COLOURS } from '../../utils/noteColour'

// Create or edit one note. Shared by the Notes page and the Deal Hub's note
// rail so the two can't drift apart in what they accept.
//
// Notes live on the CONTACT, not the deal — every GHL note endpoint is
// /contacts/{contactId}/notes/... — so creating one needs a person chosen. On a
// deal with several people that's the rep's call, not a guess we can make.
//
// Two GHL rules this UI has to respect:
//
//   • AT MOST TWO PINNED NOTES per contact. The third is rejected. The server
//     checks first and returns a readable message, but the count is shown here
//     too so the rep isn't surprised at save time.
//
//   • COLOUR IS A HEX STRING (#FFF or #FFAA00). A named colour or rgb() is
//     rejected, so this offers a fixed palette rather than a free text box.

// The palette now lives in utils/noteColour.js: the deal rail, the timeline
// and the notes tab all RENDER the colour, and four private copies of seven
// hex values is how one note ends up yellow in one list and grey in another.
// NOTE_COLOURS is that same list, and normaliseNoteColour is the allow-list
// those renderers use before putting the value in a style attribute.

// CHANGING a note's deal or company is switched off in the UI.
//
// GHL's note relations endpoint needs `notes.write`, which this app's OAuth
// token does not carry — confirmed by probing the live token, not inferred:
//
//   PUT /notes/{id}/relations → 401 "The token is not authorized for this scope."
//   GET /notes/{id}           → 401, needs notes.readonly
//
// So the pickers could be operated but never saved. Worse, the failing call
// used to mark the install reauth_required, which halted every sync for the
// location — that is fixed server-side (scopeOptional), but the write still
// cannot succeed, so offering the control is offering a dead end.
//
// The BACKEND IS UNCHANGED and still handles these relations: routes, the
// relation calls, and the dirty-state fix all remain. Only the two controls
// are hidden. Flip this to true once `notes.readonly` + `notes.write` are
// added to the marketplace app and each sub-account has re-consented.
//
// Note CREATION is deliberately unaffected: on the deal hub a new note is
// filed against the deal in scope via defaultOpportunityId, the server
// attaches it on create, and a failure there returns 201 with `relationError`
// so the note itself survives. That path is worth keeping even while it may
// fail — losing it would mean deal-hub notes stopped being filed at all.
// Back ON — the DEAL is saved LOCALLY.
//
// GHL's note relations endpoint needs the `notes.write` scope this app does
// not hold, so the deal link lives in our database and is set through
// PUT /api/notes/:id/local-links. If that scope is granted later, switch back
// to the real endpoint and this flag can go.
//
// The COMPANY is unaffected and still saves upstream — see
// NOTE_COMPANY_EDITING below.
const NOTE_RELATION_EDITING = true

// The COMPANY link is a separate case and stays available.
//
// `businessId` is a plain field on PUT /contacts/{contactId}/notes/{noteId} —
// the endpoint every note edit already uses — so it saves with
// `contacts.write` and never touches the relations endpoint that needs
// `notes.write`. Only the DEAL link is stuck behind that scope.
const NOTE_COMPANY_EDITING = true

export default function NoteEditor({
  note = null,
  contacts = [],
  defaultContactId = null,
  // Seed text for a CREATE — used by Co-Pilot's "Save as note", where the
  // agent's answer is a draft the rep can edit before it's stored. Deliberately
  // separate from `note`: passing a fake note would put this in edit mode and
  // PATCH a record that doesn't exist.
  initialBody = '',
  // How many notes are already pinned on the target contact, so the pin toggle
  // can say when there's no room. Optional — omitted means don't claim.
  pinnedCount = null,
  // The deal and company this note is about — GHL associations, not note
  // fields. `deals` and `businesses` are the pickable lists; omitting a list
  // hides its picker rather than showing an empty dropdown.
  // Seed lists only — the pickers search the server, so empty means "nothing
  // preloaded", not "hide".
  deals = [],
  businesses = [],
  // TWO FLAGS, not one.
  //
  // These were a single `showLinks`, which the Deal Hub rails set to false so a
  // rep could not refile onto a different deal from a rail belonging to this
  // one. That reasoning holds for the DEAL picker and not at all for the
  // COMPANY picker — which company a note concerns has nothing to do with
  // which deal's rail it was opened from, and hiding it meant the association
  // could not be set anywhere except the standalone tab.
  showDealLink = true,
  showCompanyLink = true,
  // Preselected when the editor is opened from a deal, which already knows.
  defaultOpportunityId = null,
  onClose,
  onSaved
}) {
  const editing = !!note

  const modalRef = useModal()

  const [title, setTitle] = useState(note?.title || '')
  // HTML, not stripped text. stripHtml() here was the data loss: a formatted
  // note opened for editing became plain text, and saving wrote that back.
  //
  // initialBody comes from Co-Pilot's "Save as note" as plain text, so it is
  // wrapped in a paragraph — otherwise ProseMirror treats a bare string as an
  // empty document.
  const [body, setBody] = useState(() => {
    const raw = note?.body || ''
    if (raw) return sanitiseHtml(raw)
    return initialBody ? `<p>${escapeHtml(initialBody)}</p>` : ''
  })
  const [colour, setColour] = useState(note?.color || null)
  const [pinned, setPinned] = useState(note?.pinned === true)
  // A note links to ONE deal — GHL's note→opportunity cap is 1, so attaching a
  // second replaces the first. Modelled as a single value for that reason, not
  // as a simplification.
  const [opportunityId, setOpportunityId] = useState(
    note?.opportunityId || defaultOpportunityId || null
  )
  const [businessId, setBusinessId] = useState(note?.businessId || null)
  // The picked deal's and company's NAMES, so a save can hand the caller
  // whole { id, name } links to paint — a searched-for record is not in the
  // seeded lists.
  const [dealName, setDealName] = useState(null)
  const [businessName, setBusinessName] = useState(null)

  const [contactId, setContactId] = useState(
    note?.contact?.id || defaultContactId || (contacts.length === 1 ? contacts[0].id : null)
  )

  // The deal search, bound to the chosen contact.
  //
  // useCallback keyed on contactId: RemotePicker caches results per search
  // function, so reusing one identity across contacts showed the previous
  // contact's deals until the dialog was reopened.
  const dealSearchForContact = React.useCallback(
    (q) => searchDeals(q, { contactId }),
    [contactId]
  )

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errorField, setErrorField] = useState(null)

  // No focus effect: RichEditor takes autoFocus and focuses the ProseMirror
  // surface itself. A ref-and-timeout here would have targeted a textarea
  // that no longer exists.

  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape' && !saving) onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])


  // GHL's limit. Only blocks turning pinning ON, and never for a note that's
  // already pinned — it already holds one of the two slots.
  const alreadyPinned = note?.pinned === true
  const pinRoom = pinnedCount == null
    || alreadyPinned
    || pinnedCount < 2

  const changes = useMemo(() => {
    if (!editing) return null
    const out = {}
    // Both sides sanitised, so a note whose stored HTML differs only in what
    // our sanitiser would strip is not reported as an edit.
    if (body.trim() !== sanitiseHtml(note.body || '').trim()) out.body = body.trim()
    if (title.trim() !== (note.title || '')) out.title = title.trim()
    if ((colour || null) !== (note.color || null)) out.color = colour || null
    if (pinned !== (note.pinned === true)) out.pinned = pinned
    // A plain field on PUT /contacts/:contactId/notes/:noteId, so it belongs
    // in the patch rather than the relations call. null detaches — the server
    // maps null and '' to null, and an absent key means "unchanged", so a
    // clear has to be explicit.
    if (NOTE_COMPANY_EDITING && (businessId || null) !== (note.businessId || null)) {
      out.businessId = businessId || null
    }
    return out
  }, [editing, note, body, title, colour, pinned, businessId])

  // Relations are dirty state too, but they are NOT part of `changes`:
  // `changes` is the note PATCH body and the server rejects unknown fields,
  // so putting opportunityId in it would fail the whole save. They travel
  // through their own endpoint in save() below — which already handled them
  // correctly, while this check ignored them. The result was Save stuck
  // disabled on "No changes yet" for a deal or company edit, with no way to
  // save it at all.
  //
  // Gated on NOTE_RELATION_EDITING as well. With the pickers hidden these can
  // still differ — defaultOpportunityId seeds opportunityId on the deal hub
  // even in edit mode — and that would enable Save with nothing on screen to
  // explain why, then fire a write that 401s.
  const oppChanged = editing && NOTE_RELATION_EDITING
    && (opportunityId || null) !== (note.opportunityId || null)
  // No bizChanged here. The company is a plain field on the note patch (see
  // NOTE_COMPANY_EDITING) and `changes` already detects it, so a second
  // comparison would be dead weight that lint correctly flagged.
  const relationsChanged = oppChanged

  const dirty = editing
    ? Object.keys(changes).length > 0 || relationsChanged
    : body.trim().length > 0
  // Over the limit blocks the save.
  //
  // The editor's counter turned red but Save stayed enabled, so the only way
  // to discover the limit was a rejected request. Counted as TEXT, matching
  // both the counter and the server — the HTML is far longer than what is
  // stored against the limit.
  const bodyLength = htmlToText(body).length
  const tooLong = bodyLength > 65000
  const canSave = !saving && dirty && !tooLong
    && body.trim().length > 0
    && (editing || !!contactId)

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    setErrorField(null)
    try {
      let res
      if (editing) {
        // Only when there is something to patch: a note whose ONLY edit is
        // its deal would otherwise send an empty PATCH, and the server treats
        // a body with no known fields as an error.
        //
        // Falls back to the note we already hold rather than null. onSaved's
        // contract is "the saved note", and NotesTab reads a null as "a new
        // note was created" — it would announce "Note added" and then poll for
        // an id that does not exist.
        res = Object.keys(changes).length
          ? await notesAPI.update(note.id, changes)
          : { note }
        // Relations go separately — a different GHL endpoint, and the note
        // patch rejects unknown fields. Only when they actually changed, so
        // editing the text alone stays one request. oppChanged/bizChanged are
        // computed once above, so the dirty check and the save agree.
        if (relationsChanged) {
          // Detach first, then attach. Skipping the detach would leave the old
          // company attached (its cap is 1000, so it appends) — only the deal
          // link replaces itself.
          // Deal only, and through the LOCAL route — the GHL relations
          // endpoint 401s without notes.write. The company is not here: it
          // travels in `changes` above as a plain field on the note patch,
          // which does reach GHL.
          await notesAPI.setLocalLinks(note.id, {
            opportunityId: opportunityId || null
          })
          // Merge the deal back into what we hand to onSaved.
          //
          // `res.note` comes from GHL, and GHL does not hold the note->deal
          // link at all — it lives only in our database (notes.write is not
          // granted, so the relations endpoint is closed). Returning GHL's
          // copy unchanged therefore reported the OLD deal, and the list went
          // on showing it until the page was reloaded or another record was
          // opened.
          res = {
            ...res,
            note: { ...(res?.note || note), opportunityId: opportunityId || null }
          }
        }
      } else {
        res = await notesAPI.create({
          contactId,
          body: body.trim(),
          title: title.trim() || undefined,
          color: colour || undefined,
          pinned: pinned || undefined,
          opportunityId: opportunityId || undefined,
          businessId: businessId || undefined
        })
        // The note saved but its link did not. Report it without discarding
        // the note — the server deliberately returns 201 here.
        if (res?.relationError) {
          // The server's message already says what failed, so the old
          // "Note saved, but couldn't link it: Could not link the note…"
          // said it twice. The prefix keeps the part the server cannot
          // know — that the note itself survived.
          setError(`Note saved. ${res.relationError}`)
          setSaving(false)
          return
        }
      }
      // Second argument: what we KNOW we applied.
      //
      // The caller patches its row from the CRM's echo, but GHL's note PUT
      // does not reliably return every field it was sent — and a caller
      // reading `saved.<field> ?? null` then BLANKS something the rep had
      // just set. Passing the values we sent removes the guess.
      //
      // TITLE is the case that was actually reported: renaming a note sent
      // {"title":"test4"}, GHL's response came back without a title, and
      // both rails patched their row to `saved.title ?? null` — so the new
      // name vanished and the old heading (derived from the body's first
      // line) reappeared. The body survived only because it falls back to
      // what we already held.
      //
      // Everything in `changes` is included: those are exactly the fields we
      // sent, so they are exactly the ones we can speak for.
      // The links as we set them, whole — the deal lives only in our
      // database and GHL's echo may omit the company, so without these the
      // row kept its old chips until a refresh.
      let saved = res.note || null
      if (saved && editing) {
        if (oppChanged) {
          const seeded = deals.find((d) => d.id === opportunityId)
          saved = {
            ...saved,
            opportunityId: opportunityId || null,
            deal: opportunityId
              ? { id: opportunityId, name: dealName || (seeded ? dealOption(seeded).label : null) }
              : null
          }
        }
        if (changes && 'businessId' in changes) {
          const seeded = businesses.find((b) => b.id === businessId)
          saved = {
            ...saved,
            businessId: businessId || null,
            business: businessId
              ? { id: businessId, name: businessName || seeded?.name || null }
              : null
          }
        }
      }
      onSaved(
        saved,
        editing && changes && Object.keys(changes).length ? { ...changes } : null
      )
      onClose()
    } catch (err) {
      setError(err.message || 'Could not save that — try again')
      setErrorField(err.data?.field || null)
      setSaving(false)
    }
  }

  const onFormKeyDown = (e) => {
    // Cmd/Ctrl+Enter only — the body is a textarea and newlines matter in it.
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  return (
    // .pp-backdrop / .pp-modal carry the blur, the layered shadow and the
    // entrance motion — see the Modals block in dealhub-tokens.css. Held in
    // CSS rather than inline styles so the five dialogs cannot drift apart.
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
        aria-label={editing ? 'Edit note' : 'New note'}
        onKeyDown={onFormKeyDown}
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
              background: 'var(--tint-gold)'
            }}
          >
            <span className="ms" style={{ fontSize: 18, color: 'var(--accent-gold-text)' }}>
              sticky_note_2
            </span>
          </span>
          <h2 className="pp-modal-title" style={{ flex: 1 }}>
            {editing ? 'Edit note' : 'New note'}
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
          style={{ display: 'grid', gap: 'var(--space-3)', padding: 'var(--space-4)' }}
        >
          {/* Optional, and worth saying so: before this existed the UI derived
              a heading from the body's first line, so reps had no way to give a
              note a real title. */}
          <Field
            label="Title"
            hint="Optional — without one, the first line is used as the heading"
            error={errorField === 'title' ? error : null}
          >
            <Input
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Short heading"
              maxLength={255}
              autoFocus={!editing}
              status={errorField === 'title' ? 'error' : undefined}
            />
          </Field>

          <Field label="Note" required error={errorField === 'body' ? error : null}>
            {/* Rich text, not a textarea.
                GHL stores a note body as HTML, and this used to strip it on
                read and send plain text on write — so formatting written in
                GHL was destroyed the moment a rep edited the note here.
                Paste is sanitised on the way in, so pasting from Word, Gmail
                or GHL cannot carry markup we would not store. */}
            <React.Suspense
              fallback={
                <div
                  style={{
                    minHeight: 150,
                    border: '1px solid var(--border-strong)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-sunken)'
                  }}
                />
              }
            >
            <RichEditor
              value={body}
              onChange={setBody}
              placeholder="What's worth recording?"
              disabled={saving}
              invalid={errorField === 'body'}
              // Mirrors notePatch.js's MAX_BODY on the server.
              maxLength={65000}
              minHeight={150}
            />
            </React.Suspense>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <Field label="Colour" error={errorField === 'color' ? error : null}>
              {/* A fixed palette, not a text box: GHL only accepts #FFF or
                  #FFAA00 form, so free text would invite a rejected save. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                <Swatch
                  colour={null}
                  label="None"
                  active={!colour}
                  onClick={() => setColour(null)}
                />
                {NOTE_COLOURS.map(([hex, name]) => (
                  <Swatch
                    key={hex}
                    colour={hex}
                    label={name}
                    active={colour === hex}
                    onClick={() => setColour(hex)}
                  />
                ))}
                {/* A colour set in GHL that isn't in the list above — one they
                    added, or an older note. Shown as a selected swatch rather
                    than silently reading as "None", which would make the next
                    save clear a colour the rep never touched. */}
                {colour && !NOTE_COLOURS.some(([hex]) => hex === colour) && (
                  <Swatch colour={colour} label={`${colour} (from your CRM)`} active onClick={() => {}} />
                )}
              </div>
            </Field>

            {!editing && (
              <Field label="Contact" required error={errorField === 'contactId' ? error : null}>
                {/* Searches every contact in the sub-account, not just the ones
                    the caller happened to pass. On this page there is no deal in
                    scope, so the old Select was handed an empty list and
                    rendered DISABLED — a task could not be created here at all.
                    `seed` keeps the deal case a single click. */}
                <ContactPicker
                  value={contactId}
                  onChange={setContactId}
                  seed={contacts}
                  invalid={errorField === 'contactId'}
                />
              </Field>
            )}

            {/* Shown in BOTH create and edit mode, unlike Contact above: a
                note's contact is fixed by GHL once written, but which deal and
                company it is filed against is exactly the thing a rep corrects
                later.

                Rendered only when there is something to pick — an empty
                dropdown is worse than no dropdown. */}
            {/* RemotePicker, not a plain Select: these search the SERVER.
                They used to filter the seed list client-side, so on a location
                with more than 200 deals the rest were unreachable and nothing
                said so. The seed is still passed, so the common case shows
                options with no request.

                No `deals.length > 0` guard any more either — an empty seed no
                longer means "nothing to pick", it just means nothing is
                preloaded. */}
            {showDealLink && (!editing || NOTE_RELATION_EDITING) && (
              <Field
                label="Deal"
                error={errorField === 'opportunityId' ? error : null}
                hint="One deal per note — picking another replaces it"
              >
                <RemotePicker
                  value={opportunityId}
                  onChange={(v, opt) => { setOpportunityId(v); setDealName(opt?.label || null) }}
                  // Scoped to THIS contact's deals — primary or linked. A note
                  // lives on a contact, so a deal they are not on is never a
                  // valid answer. Re-created when the contact changes so the
                  // picker never offers the previous contact's deals.
                  search={dealSearchForContact}
                  seed={deals.map(dealOption)}
                  disabled={saving}
                  invalid={errorField === 'opportunityId'}
                  placeholder="Not linked to a deal"
                  emptyText="No deal matches that"
                  style={{ width: '100%' }}
                />
              </Field>
            )}

            {showCompanyLink && (!editing || NOTE_COMPANY_EDITING) && (
              <Field label="Company" error={errorField === 'businessId' ? error : null}>
                <RemotePicker
                  value={businessId}
                  onChange={(v, opt) => { setBusinessId(v); setBusinessName(opt?.label || null) }}
                  search={searchBusinesses}
                  seed={businesses.map(businessOption)}
                  disabled={saving}
                  invalid={errorField === 'businessId'}
                  placeholder="Not linked to a company"
                  emptyText="No company matches that"
                  style={{ width: '100%' }}
                />
              </Field>
            )}
          </div>

          {/* GHL caps pinned notes at two per contact, so the control has to
              say when there's no room rather than failing at save time. */}
          <label
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              cursor: pinRoom ? 'pointer' : 'not-allowed',
              opacity: pinRoom ? 1 : 0.6
            }}
          >
            <input
              type="checkbox"
              checked={pinned}
              disabled={!pinRoom && !pinned}
              onChange={(e) => setPinned(e.target.checked)}
              style={{
                marginTop: 2, width: 16, height: 16, flex: 'none',
                accentColor: 'var(--brand-primary)'
              }}
            />
            <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-body)' }}>
              Pin to the top of this contact
              <span
                style={{
                  display: 'block',
                  fontSize: 'var(--text-sm)', color: 'var(--text-muted)'
                }}
              >
                {!pinRoom && !pinned
                  ? 'Two notes are already pinned — unpin one first'
                  : 'At most two notes can be pinned per contact'}
              </span>
            </span>
          </label>

          {/* The deal half of this promise depends on the note relations
              endpoint, which needs `notes.write` — the scope the app does not
              yet hold. Create calls setNoteRelations exactly as an edit does,
              so today the link silently fails and the note appears only on the
              contact. Reinstated automatically with NOTE_RELATION_EDITING. */}
          {!editing && (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {NOTE_RELATION_EDITING
                ? 'Notes are stored against the contact, so it appears on their '
                  + "record and on any deal they're linked to."
                : 'Notes are stored against the contact, so it appears on their record.'}
            </p>
          )}

          {error && !errorField && (
            <div
              style={{
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
            borderTop: '1px solid var(--border-default)'
          }}
        >
          {/* Says WHY Save is disabled. An inert button with no reason is
              the worst of the three states. */}
          <span
            className="pp-modal-status"
            style={tooLong ? { color: 'var(--status-stuck-text)' } : undefined}
          >
            {tooLong
              ? `The note is ${(bodyLength - 65000).toLocaleString()} characters over the limit`
              : saving
                ? 'Saving to your CRM…'
                : editing && !dirty ? 'No changes yet' : '⌘↵ to save'}
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
            {saving ? 'Saving' : editing ? 'Save changes' : 'Add note'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function Swatch({ colour, label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        width: 26, height: 26, padding: 0,
        border: active
          ? '2px solid var(--text-heading)'
          : '1px solid var(--border-strong)',
        borderRadius: '50%',
        background: colour || '#fff',
        cursor: 'pointer'
      }}
    >
      {/* "None" needs a mark of its own — an empty white circle beside six
          coloured ones reads as a missing swatch rather than a choice. */}
      {!colour && (
        <span className="ms" style={{ fontSize: 14, color: 'var(--text-faint)' }}>
          block
        </span>
      )}
      {colour && active && (
        <span className="ms" style={{ fontSize: 15, color: '#fff' }}>check</span>
      )}
    </button>
  )
}

// Co-Pilot's "Save as note" passes PLAIN text, which is inserted into a
// paragraph. Escaping it first: an agent answer quoting a customer's
// "<3 the design" would otherwise be parsed as markup and vanish.
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
}

function Field({ label, required, hint, error, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      <span className="pp-label">
        {label}
        {required && <span className="pp-req">*</span>}
      </span>
      {children}
      {hint && !error && (
        <span
          style={{
            display: 'block', marginTop: 4,
            fontSize: 'var(--text-sm)', color: 'var(--text-faint)'
          }}
        >
          {hint}
        </span>
      )}
      {error && (
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
  )
}

// Note bodies come back as markup (GHL's editor is rich text) but this form
// edits plain text — sending HTML the rep didn't write would compound on every
// save.
