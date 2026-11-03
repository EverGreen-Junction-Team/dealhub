import React, { useEffect, useMemo, useRef, useState } from 'react'
import { useModal } from '../../hooks/useModal'
import { DatePicker, Input, Select } from 'antd'
import { useAuth } from '../../context/AuthContext'
import { useUsers } from './ListFilters'
import dayjs from 'dayjs'
import { tasksAPI } from '../../api/tasks'
import ContactPicker from './ContactPicker'
import RemotePicker from './RemotePicker'
import { sanitiseHtml, htmlToText } from '../../utils/sanitiseHtml'

// Lazy, same reason as the note editor: TipTap is ~127 KB gzipped and only
// needed once a dialog opens. Shares the chunk with NoteEditor's copy.
const RichEditor = React.lazy(() => import('./RichEditor'))
import {
  searchDeals, searchBusinesses, dealOption, businessOption
} from '../../hooks/useLinkTargets'
import { Truncate } from './ListChrome'

// Create or edit one task. Shared by the Tasks page and the Deal Hub's task
// rail so the two can't drift apart in what they accept.
//
// Writes go to the CRM, which owns the record — see the server's
// ghlTaskWrite.js. What that means here:
//
//   • Tasks live on the CONTACT, not the deal. Creating one therefore needs a
//     contact, and on a deal with several people that's a choice the rep has to
//     make rather than one we can guess. Hence the Contact field.
//   • A save takes a moment (their API waits internally before responding), so
//     the button shows progress rather than appearing to do nothing.
//   • A rejected field comes back named, so the error lands on the input that
//     caused it instead of in a banner that doesn't say which box is wrong.

// A task's deal and company links are switched off in the UI.
//
// GHL refuses these writes outright — a platform restriction, not a scope.
// Confirmed in their tasks.service.ts:
//
//   const isOAuthChannel = request.channel === Channel.OAUTH
//   if (isOAuthChannel && 'relations' in body) {
//     throw new BadRequestException('Relations cannot be modified via OAuth channel')
//   }
//
// The check lives in the task service, so every route in is closed: the
// associations API (it calls tasksService.update internally), its bulk
// variant, PUT /locations/:id/tasks/:id with relations, and create-with-
// relations. No scope, version or retry changes it.
//
// Hidden on CREATE as well as edit, unlike the note editor's pickers. A new
// task's links go through the same blocked call, so the picker would collect
// a choice that is silently dropped — the task is still created and the
// server returns `relationError`, but a control that never works is worse
// than no control.
//
// WHAT STILL WORKS: the CONTACT link, which is a plain field rather than a
// relation — PUT /locations/:locationId/tasks/:taskId { contactId }. That is
// unaffected and stays.
//
// READING is unaffected too: the deals a task is linked to still come from
// the task payload, so the chips and counts elsewhere stay accurate.
//
// Everything behind this is intact — routes, association calls, webhook
// handlers. Flip to true if GHL opens task relations to OAuth apps.
// Back ON — but saved LOCALLY, not to GHL.
//
// GHL blocks task relation writes on the OAuth channel (their
// tasks.service.ts rejects any task write carrying `relations`), so these
// links live in our database and are set through PUT /api/tasks/:id/local-links.
// The rep gets the control; the CRM simply does not learn about it.
//
// A GHL task payload that DOES carry relations still wins — taskWriter mirrors
// those on every TaskCreate. So upstream stays authoritative whenever it says
// anything, and we only fill the silence.
const TASK_RELATION_EDITING = true

export default function TaskEditor({
  // Editing an existing task: pass it. Creating: leave null.
  task = null,
  // Seed text for a CREATE — used by Co-Pilot's "Create task". It fills the
  // DESCRIPTION, not the title: an agent's answer is a paragraph, and a task
  // titled with a paragraph is unreadable in a queue. The rep writes the title.
  initialBody = '',
  // Contacts the task can be attached to. On the Tasks page this is the one
  // contact already on the task; on a deal it's everyone on that deal.
  contacts = [],
  // Pre-selected contact for a create — the deal's primary, usually.
  defaultContactId = null,
  // The deal and company this task is about — GHL associations, not task
  // fields. An empty list hides its picker rather than showing an empty
  // dropdown.
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
  defaultOpportunityId = null,
  // Pre-selected company for a CREATE — the business page passes its own.
  defaultBusinessId = null,
  onClose,
  // Called with the CRM's echoed task after a successful save.
  onSaved
}) {
  const editing = !!task

  const modalRef = useModal()

  // UNLIKE NOTES, a task's GHL caps are 10 rather than 1, so these links are
  // genuinely additive — attaching a second deal adds it instead of replacing
  // the first. The UI still offers one, because "the deal this task belongs to"
  // is the question a rep is answering; the difference is that changing it
  // needs an explicit detach of the old one, handled in save().
  const [opportunityId, setOpportunityId] = useState(
    task?.opportunityId || defaultOpportunityId || null
  )
  const [businessId, setBusinessId] = useState(task?.businessId || defaultBusinessId || null)
  // The picked company's NAME, kept so a save can hand the caller a whole
  // { id, name } to paint — a searched-for company is not in `businesses`.
  const [businessName, setBusinessName] = useState(null)
  // Same for the deal picker.
  const [dealName, setDealName] = useState(null)

  const [title, setTitle] = useState(task?.title || '')
  // HTML, not stripped text — see the note in NoteEditor. initialBody comes
  // from Co-Pilot as PLAIN text, so it is escaped and wrapped in a paragraph.
  const [body, setBody] = useState(() => {
    const raw = task?.body || ''
    if (raw) return sanitiseHtml(raw)
    if (!initialBody) return ''
    const esc = String(initialBody)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    return `<p>${esc}</p>`
  })
  const [dueDate, setDueDate] = useState(
    task?.dueAt ? dayjs(task.dueAt) : null
  )

  // ASSIGN TO — who the task is for (client request, Oct 2026). Without it
  // every task made here was unassigned, so filtering Tasks by a salesperson
  // never found it.
  //
  // A NEW task defaults to the signed-in user: most tasks are made for
  // yourself, and it is the default that keeps the filter honest. An EDIT
  // starts from the task's assignee — its id when the list sends one, else
  // the user whose name matches `owner` (older servers send only the name).
  // undefined = not resolved yet; nothing is sent for it until it is.
  const { session } = useAuth()
  const users = useUsers()
  const [assignee, setAssignee] = useState(() => (
    editing ? (task.assignedTo ?? (task.owner ? undefined : null)) : undefined
  ))
  const [initialAssignee, setInitialAssignee] = useState(() => (editing ? (task.assignedTo ?? undefined) : null))
  // A NEW task's default waits for the user list: the signed-in user only
  // when they are IN it. An agency login is not a user of the sub-account
  // (/api/deals/users leaves them out), so defaulting to its id put the raw
  // id in the field — and would have assigned the task to someone no
  // Assignee filter can pick. Then it starts Unassigned instead.
  useEffect(() => {
    if (editing || assignee !== undefined || !users.length) return
    const me = session?.user?.id
    setAssignee(me && users.some((u) => u.id === me) ? me : null)
  }, [editing, assignee, users, session])
  useEffect(() => {
    if (!editing || assignee !== undefined || !users.length) return
    const match = users.find((u) => (u.name || '').toLowerCase() === String(task.owner || '').toLowerCase())
    setAssignee(match ? match.id : null)
    setInitialAssignee(match ? match.id : null)
  }, [editing, assignee, users, task])
  // A new task's due date is a commitment being made now — it can't be in
  // the past. Kept as `useMemo` (not a plain function) only so the identity
  // is stable across renders; antd re-invokes disabledDate on every open
  // day either way.
  //
  // The task's OWN original due date is exempt: editing an already-overdue
  // task (title, body, contact — anything but bumping the date itself) must
  // not be blocked by the very date it's already carrying. Only picking a
  // DIFFERENT past date is refused.
  const originalDueDate = useMemo(
    () => (task?.dueAt ? dayjs(task.dueAt).startOf('day') : null),
    [task?.dueAt]
  )
  const disabledDate = (d) => {
    if (!d) return false
    if (originalDueDate && d.isSame(originalDueDate, 'day')) return false
    return d.startOf('day').isBefore(dayjs().startOf('day'))
  }
  const [contactId, setContactId] = useState(
    task?.contact?.id || defaultContactId || (contacts.length === 1 ? contacts[0].id : null)
  )

  // Deal search bound to the chosen contact. Keyed on contactId so switching
  // contact does not leave the previous one's deals in the picker's cache.
  const dealSearchForContact = React.useCallback(
    (q) => searchDeals(q, { contactId }),
    [contactId]
  )

  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errorField, setErrorField] = useState(null)

  const titleRef = useRef(null)
  useEffect(() => {
    // Focus the title on open — it's the one field every task needs.
    const t = window.setTimeout(() => titleRef.current?.focus(), 40)
    return () => window.clearTimeout(t)
  }, [])

  // Esc closes. Bound on the document so it works wherever focus sits.
  useEffect(() => {
    const onKey = (e) => {
      if (e.key === 'Escape' && !saving) onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose, saving])


  // What's actually changed. Sending only this means an edit can't overwrite a
  // field someone else changed in the CRM meanwhile.
  const changes = useMemo(() => {
    if (!editing) return null
    const out = {}
    if (title.trim() !== (task.title || '')) out.title = title.trim()
    // Both sides sanitised, so markup our sanitiser would strip is not
    // mistaken for an edit.
    if (body.trim() !== sanitiseHtml(task.body || '').trim()) out.body = body.trim()
    const wasDue = task.dueAt ? dayjs(task.dueAt) : null
    const sameDue = (!wasDue && !dueDate)
      || (wasDue && dueDate && wasDue.isSame(dueDate, 'minute'))
    if (!sameDue) out.dueDate = dueDate ? dueDate.toISOString() : null
    // null clears the assignee — taskPatch accepts it as "unassigned".
    if (assignee !== undefined && (assignee || null) !== (initialAssignee ?? (task.assignedTo || null))) {
      out.assignedTo = assignee || null
    }
    return out
  }, [editing, task, title, body, dueDate, assignee, initialAssignee])

  // Relations count as changes, but are NOT part of `changes`: that object is
  // the task PATCH body and the server rejects unknown fields there. They go
  // through their own endpoint in save() below — which handled them already,
  // while this check ignored them, so Save sat disabled on "No changes yet"
  // for a deal or company edit with no way to save it.
  // Gated too: with the pickers hidden these can still differ (a caller may
  // pass defaultOpportunityId), which would enable Save with nothing on
  // screen to explain it and then fire a write GHL always refuses.
  const oppChanged = editing && TASK_RELATION_EDITING
    && (opportunityId || null) !== (task.opportunityId || null)
  const bizChanged = editing && TASK_RELATION_EDITING
    && (businessId || null) !== (task.businessId || null)
  const relationsChanged = oppChanged || bizChanged

  const dirty = editing
    ? Object.keys(changes).length > 0 || relationsChanged
    : title.trim().length > 0
  // Over the limit blocks the save.
  //
  // The editor's counter turned red but Save stayed enabled, so the only way
  // to discover the limit was a rejected request. Counted as TEXT, matching
  // both the counter and the server — the HTML is far longer than what is
  // stored against the limit.
  const bodyLength = htmlToText(body).length
  const tooLong = bodyLength > 2000
  const canSave = !saving && dirty && !tooLong
    && title.trim().length > 0
    && (editing || (!!contactId && !!dueDate))

  // The deal link as the row draws it: `deal` for the card, `deals` for the
  // Tasks tab's list. Named from the picker, else from the seeded deals.
  const dealPatch = () => {
    const seeded = deals.find((x) => x.id === opportunityId)
    const deal = opportunityId
      ? { id: opportunityId, name: dealName || (seeded ? dealOption(seeded).label : null) }
      : null
    return { opportunityId: opportunityId || null, deal, deals: deal ? [deal] : [] }
  }

  const save = async () => {
    if (!canSave) return
    setSaving(true)
    setError(null)
    setErrorField(null)
    try {
      let res
      if (editing) {
        // Skip the PATCH when only a relation changed — an empty body is an
        // error server-side. Falls back to the task we hold so onSaved still
        // receives one: its callers read the result to patch their row.
        res = Object.keys(changes).length
          ? await tasksAPI.update(task.id, changes)
          : { task }
        // oppChanged/bizChanged come from above, so the dirty check and the
        // save cannot disagree about what changed.
        //
        // LOCAL endpoint, not the GHL relations one: that path 400s with
        // "Relations cannot be modified via OAuth channel" for every task.
        if (relationsChanged) {
          await tasksAPI.setLocalLinks(task.id, {
            ...(oppChanged ? { opportunityId: opportunityId || null } : {}),
            ...(bizChanged ? { businessId: businessId || null } : {})
          })
        }
      } else {
        res = await tasksAPI.create({
          contactId,
          title: title.trim(),
          body: body.trim() || undefined,
          dueDate: dueDate.toISOString(),
          assignedTo: assignee || undefined,
          // NOT sent on create: the server would forward them to GHL's
          // relations endpoint, which rejects every task relation write. The
          // links are applied locally straight after instead.
        })
        // The task exists now, so its links can be set in our database. A
        // failure here must not read as "the task was not created" — it was.
        if (res?.task?.id && (opportunityId || businessId)) {
          try {
            await tasksAPI.setLocalLinks(res.task.id, {
              opportunityId: opportunityId || null,
              businessId: businessId || null
            })
          } catch (linkErr) {
            setError(
              `Task created, but its links did not save: ${linkErr?.response?.data?.error || linkErr.message}`
            )
            setSaving(false)
            return
          }
        }
        // The task saved but its link did not — report without discarding it.
        if (res?.relationError) {
          setError(`Task saved, but couldn't link it: ${res.relationError}`)
          setSaving(false)
          return
        }
      }
      // The assignee as we SENT it, id and display name, so the caller can
      // repaint its row now — GHL's echo carries the id but not the name, and
      // the row's chip shows the name.
      const assignedPatch = editing && changes && 'assignedTo' in changes
        ? {
            assignedTo: changes.assignedTo,
            owner: changes.assignedTo
              ? ((users.find((u) => u.id === changes.assignedTo) || {}).name || null)
              : null
          }
        : null
      // The links as we SET them. They live only in our database, so neither
      // GHL's echo nor the task we were opened with carries the new value —
      // without this the row kept its old company and the editor reopened
      // blank until a page refresh.
      const linkPatch = editing && relationsChanged
        ? {
            ...(bizChanged
              ? {
                  businessId: businessId || null,
                  business: businessId
                    ? {
                        id: businessId,
                        name: businessName
                          || (businesses.find((b) => b.id === businessId) || {}).name
                          || null
                      }
                    : null
                }
              : {}),
            ...(oppChanged ? dealPatch() : {})
          }
        : null
      onSaved(res.task ? { ...res.task, ...(assignedPatch || {}), ...(linkPatch || {}) } : null)
      onClose()
    } catch (err) {
      setError(err.message || 'Could not save that — try again')
      // The server names the rejected field so the message can sit under the
      // input responsible.
      setErrorField(err.data?.field || null)
      setSaving(false)
    }
  }

  // Cmd/Ctrl+Enter saves from anywhere in the form. Plain Enter is left alone —
  // the description is a textarea and newlines matter in it.
  const onFormKeyDown = (e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault()
      save()
    }
  }

  return (
    <div
      className="pp-backdrop"
      // Click the backdrop to dismiss, but never mid-save.
      onMouseDown={(e) => { if (e.target === e.currentTarget && !saving) onClose() }}
    >
      <div
        // Scroll lock + focus trap, shared by every dialog. Escape stays
        // with each component: theirs is guarded against mid-save.
        ref={modalRef}
        className="pp-modal"
        role="dialog"
        aria-modal="true"
        aria-label={editing ? 'Edit task' : 'New task'}
        onKeyDown={onFormKeyDown}
        style={{ width: 'min(560px, 100%)' }}
      >
        <header
          className="pp-modal-head"
          style={{
            display: 'flex', alignItems: 'center', gap: 10,
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          {/* The accent survives as a small badged icon rather than a full
              tinted band. A rose header made an ordinary task edit look like
              the delete confirmation, which uses the same colour to MEAN
              danger. */}
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, flex: 'none',
              borderRadius: 'var(--radius-md)',
              background: 'var(--tint-rose)'
            }}
          >
            <span className="ms" style={{ fontSize: 18, color: 'var(--accent-rose-text)' }}>
              task_alt
            </span>
          </span>
          <h2 className="pp-modal-title" style={{ flex: 1 }}>
            {editing ? 'Edit task' : 'New task'}
          </h2>
          <button
            onClick={onClose}
            disabled={saving}
            title="Close"
            style={{
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              width: 28, height: 28,
              borderRadius: 'var(--radius-md)',
              // A real border now the header is white — the translucent white
              // fill was designed to sit on the tinted band and is invisible
              // against --surface-card.
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
          <Field label="Title" required error={errorField === 'title' ? error : null}>
            <Input
              ref={titleRef}
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="What needs doing?"
              maxLength={1500}
              status={errorField === 'title' ? 'error' : undefined}
            />
          </Field>

          <Field label="Description" error={errorField === 'body' ? error : null}>
            {/* Rich text, like the note editor. Task bodies already RENDER as
                HTML through RichBody, so a plain textarea here was the same
                asymmetry notes had: formatting could be displayed but never
                written, and editing a formatted task flattened it. */}
            <React.Suspense
              fallback={
                <div
                  style={{
                    minHeight: 110,
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
                placeholder="Anything worth remembering about it"
                disabled={saving}
                invalid={errorField === 'body'}
                // Mirrors taskPatch.js's MAX_LENGTHS.body on the server, which
                // is the enforcing rule — this only stops the rep discovering
                // it via a rejected save.
                maxLength={2000}
                minHeight={110}
              />
            </React.Suspense>
          </Field>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 'var(--space-3)' }}>
            <Field
              label="Due"
              required={!editing}
              error={errorField === 'dueDate' ? error : null}
            >
              <DatePicker
                popupClassName="pp-cal"
                value={dueDate}
                onChange={setDueDate}
                format="D MMM YYYY"
                placeholder="Pick a date"
                style={{ width: '100%' }}
                status={errorField === 'dueDate' ? 'error' : undefined}
                disabledDate={disabledDate}
              />
            </Field>

            {/* READ-ONLY when editing.
                Moving a task to another contact isn't a field the CRM's update
                endpoint accepts, so a picker here would be a control that
                silently does nothing — but hiding the contact entirely left
                the rep unable to see whose task this is. That matters most
                when the deal picker rejects a choice: the error reads "that
                deal is not on this contact" while the contact it refers to was
                nowhere on screen. */}
            {editing && task?.contact?.name && (
              <Field label="Contact">
                <div
                  style={{
                    display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
                    height: 32, padding: '0 11px',
                    border: '1px solid var(--border-default)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-sunken)',
                    color: 'var(--text-body)', fontSize: 'var(--text-md)'
                  }}
                  title="A task cannot be moved to another contact"
                >
                  <span className="ms" style={{ fontSize: 15, color: 'var(--text-faint)' }}>
                    person
                  </span>
                  <Truncate>
                    {task.contact.name}
                  </Truncate>
                </div>
              </Field>
            )}

            {/* Only on create — see above. */}
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

            {/* In both create and edit mode: which deal and company a task is
                filed against is exactly what a rep corrects later. Rendered
                only when there is something to pick. */}
            {/* Server-searched, like the note editor's — the seed list was
                capped at 200, so anything beyond that was unreachable through
                a client-side filter. */}
            {showDealLink && TASK_RELATION_EDITING && (
              <Field label="Deal" error={errorField === 'opportunityId' ? error : null}>
                <RemotePicker
                  value={opportunityId}
                  onChange={(v, opt) => { setOpportunityId(v); setDealName(opt?.label || null) }}
                  // Scoped to this contact's deals — a task lives on a
                  // contact, so a deal they are not on is never a valid answer.
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

            {showCompanyLink && TASK_RELATION_EDITING && (
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
                {/* Says where the link lives. GHL refuses task relation writes
                    from apps ("Relations cannot be modified via OAuth
                    channel"), so it is kept in our database — it shows on the
                    business's page here, and not in GHL's own task panel. */}
                <span style={{ display: 'block', marginTop: 4, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                  Linked in PipelinePulse — shows on this business's page here, not in GoHighLevel.
                </span>
              </Field>
            )}
          </div>

          {/* ASSIGN TO — the user the task is for. Full width, as GHL's own
              task panel draws it. Searchable: a sub-account can have dozens. */}
          <Field label="Assign to" error={errorField === 'assignedTo' ? error : null}>
            <Select
              value={assignee === undefined ? undefined : (assignee || '')}
              onChange={(v) => setAssignee(v || null)}
              disabled={saving}
              loading={assignee === undefined && !users.length}
              showSearch
              optionFilterProp="label"
              placeholder="Select assignee"
              options={[
                { value: '', label: 'Unassigned' },
                ...users.map((u) => ({
                  value: u.id,
                  label: (u.name || u.email || u.id) + (u.id === session?.user?.id ? ' (you)' : '')
                })),
                // An EDIT whose assignee is not in the list (an agency user,
                // or someone since removed): named, never the bare id.
                ...(assignee && users.length && !users.some((u) => u.id === assignee)
                  ? [{ value: assignee, label: task?.owner || 'Not a user of this account' }]
                  : [])
              ]}
              status={errorField === 'assignedTo' ? 'error' : undefined}
              popupClassName="pp-menu"
              style={{ width: '100%' }}
            />
          </Field>

          {/* A task belongs to a contact, and that's worth saying once rather
              than leaving the rep to wonder why a deal isn't enough.

              The old wording promised it would "appear on any deal they're
              linked to". With deal links unavailable (see
              TASK_RELATION_EDITING) that is no longer true, and a hint that
              overpromises is worse than none — the rep would look for the
              task on a deal and conclude the app had lost it. */}
          {!editing && (
            <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              {TASK_RELATION_EDITING
                ? 'Tasks are stored against the contact, so it appears on their '
                  + "record and on any deal they're linked to."
                : 'Tasks are stored against the contact, so it appears on their '
                  + 'record. Linking a task to a deal has to be done in your CRM.'}
            </p>
          )}

          {/* An error with no field of its own — a permission problem, a
              connection failure — needs somewhere to land. */}
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
              ? `The description is ${(bodyLength - 2000).toLocaleString()} characters over the limit`
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
            {saving ? 'Saving' : editing ? 'Save changes' : 'Create task'}
          </button>
        </footer>
      </div>
    </div>
  )
}

function Field({ label, required, error, children }) {
  return (
    <div style={{ minWidth: 0 }}>
      {/* .pp-label: 11px with lighter tracking and --text-faint, so the label
          is findable and then recedes. At 10px with 0.07em tracking and
          --text-muted it drew as much attention as the value it names. */}
      <span className="pp-label">
        {label}
        {required && <span className="pp-req">*</span>}
      </span>
      {children}
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

// Task bodies come back as markup (the CRM's editor is rich text), but this
// form edits plain text — sending HTML the rep didn't write would compound
// every time they saved.
