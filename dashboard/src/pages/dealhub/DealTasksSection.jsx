import React, { useCallback, useEffect, useMemo, useState } from 'react'
import PanelHead from './PanelHead'
import { tasksAPI } from '../../api/tasks'
import { notesAPI } from '../../api/notes'
import { formatDue, relativeTime, RichBody, AttachmentCount } from '../shared/ListChrome'
import TaskEditor from '../shared/TaskEditor'
import { useLinkTargets } from '../../hooks/useLinkTargets'
import NoteEditor from '../shared/NoteEditor'
import ConfirmDialog from '../shared/ConfirmDialog'
import { noteColourStyle } from '../../utils/noteColour'

// Tasks and Notes for the open deal, in the Deal Hub's right rail.
//
// Deliberately server-filtered by dealId rather than reusing the Tasks/Notes
// tab data: those lists are location-wide and paginated, so filtering them
// client-side would show only whatever happened to be on the loaded page.
//
// The status filter and both sorts run client-side. That's correct here and not
// a shortcut: the rail fetches every task on the deal in one request (a deal has
// tens, not thousands), so the set is complete and re-sorting it is instant. A
// server round trip per sort click would be slower and no more accurate.
//
// Both are writable: create, edit, delete and (for tasks) tick all reach the
// CRM — see the server's ghlTaskWrite.js and ghlNoteWrite.js.
//
// Tasks and notes both belong to a CONTACT, not to a deal, so creating either
// from here needs a person picked from the deal — which is why `people` is
// passed in.

// SCOPED TO A DEAL OR TO A CONTACT. The Deal hub passes dealId; the contact
// record passes contactId (and no dealId) to list everything filed against
// that person — the same rail, the same editor, the same save paths.
export function DealTasksSection({ dealId = null, contactId = null, people = [], onOpenAll }) {
  const scope = dealId ? 'deal' : 'contact'
  const { items, loading, error, patchItem, reload, reloadSoon } = useDealList(
    dealId || contactId,
    (id) => tasksAPI.list({ ...(dealId ? { dealId: id } : { contactId: id }), status: 'all', limit: 50 }),
    'tasks'
  )

  const [status, setStatus] = useState('open')
  const [sort, setSort] = useState('due')
  const [editor, setEditor] = useState(null)
  // Companies for the editor's picker. LAZY — nothing is fetched until an
  // editor opens, so a rep who only reads the rail pays nothing.
  //
  // The deal hub never passed these, so the picker seeded empty and showed
  // "Type to search" where the standalone Tasks and Notes tabs offer the
  // list straight away. The same company is equally likely from either
  // place; only the wiring differed.
  const linkTargets = useLinkTargets(!!editor)
  const [saving, setSaving] = useState(() => new Set())
  const [failed, setFailed] = useState(null)
  // The task queued for deletion. Same treatment as notes: the CRM keeps no
  // recycle bin we can reach, so it's confirmed and shown before it goes.
  const [confirming, setConfirming] = useState(null)
  const [confirmError, setConfirmError] = useState(null)
  const [deleting, setDeleting] = useState(null)

  const removeTask = async () => {
    const t = confirming
    if (!t || deleting) return
    setDeleting(t.id)
    setConfirmError(null)
    setFailed(null)
    try {
      await tasksAPI.remove(t.id)
      setConfirming(null)
      reload()
    } catch (err) {
      setConfirmError(err.message || 'Could not delete that task')
    } finally {
      setDeleting(null)
    }
  }

  // Tick now, write, roll back on failure. Same contract as the Tasks page.
  const toggle = async (t) => {
    if (saving.has(t.id)) return
    const was = t.status
    const next = was === 'open'

    setSaving((s) => new Set(s).add(t.id))
    setFailed(null)
    patchItem((x) => x.id === t.id, { status: next ? 'completed' : 'open' })

    try {
      const { task } = await tasksAPI.setCompleted(t.id, next)
      patchItem((x) => x.id === t.id, {
        status: task?.completed === false ? 'open' : 'completed'
      })
    } catch (err) {
      patchItem((x) => x.id === t.id, { status: was })
      setFailed(err.message || 'Could not save that — try again')
    } finally {
      setSaving((s) => { const n = new Set(s); n.delete(t.id); return n })
    }
  }

  const counts = useMemo(() => {
    const open = items.filter((t) => t.status === 'open').length
    return { open, completed: items.length - open, all: items.length }
  }, [items])

  const shown = useMemo(() => {
    const filtered =
      status === 'all' ? items
        : status === 'open' ? items.filter((t) => t.status === 'open')
          : items.filter((t) => t.status !== 'open')

    // Copy before sorting — items is the fetched array and sorting in place
    // would mutate it, so the next filter change would start from a reordered
    // list rather than the server's order.
    return [...filtered].sort((a, b) =>
      sort === 'due'
        // Soonest first, and a task with no due date sorts last: it isn't
        // urgent, and putting it above an overdue one buries what matters.
        ? nullsLast(a.dueAt, b.dueAt, 'asc')
        // Newest first.
        : nullsLast(a.createdAt, b.createdAt, 'desc')
    )
  }, [items, status, sort])

  return (
    <Rail
      icon="task_alt"
      title="Tasks"
      // clay, not rose — the client's header palette (#c25a1f), which is also
      // the --tasks-header the Tasks TAB already wears, so the panel and the
      // tab it links to read as the same thing.
      accent="clay"
      meta={loading ? null : `${counts.open} open`}
      // No blurb: the design goes straight from the band to the filters.
      // The explanatory paragraph lived here; the agent's role in creating
      // tasks is covered by the "AI" badge on rows it made.
      toolbar={
        !loading && items.length > 0 ? [
          <Segment
            key="status"
            options={[
              ['open', 'Open', counts.open],
              ['completed', 'Completed', counts.completed],
              ['all', 'All', counts.all]
            ]}
            value={status}
            onChange={setStatus}
          />,
          <SortControl
            key="sort"
            label="Sort"
            options={[['due', 'Due date'], ['created', 'Created']]}
            value={sort}
            onChange={setSort}
          />
        ] : null
      }
      footer={
        !loading ? (
          <RailFooter
            newLabel="New task"
            allLabel="All tasks"
            onAll={onOpenAll}
            onNew={() => setEditor({ task: null })}
            newDisabledReason={
              people.length === 0
                ? (scope === 'deal'
                  ? 'This deal has no contacts, and a task is stored against a contact'
                  : 'No contact to attach the task to')
                : null
            }
          />
        ) : null
      }
      loading={loading}
      error={error}
      empty={!loading && items.length === 0}
      emptyText={scope === 'deal' ? 'No tasks on this deal yet.' : 'No tasks for this contact yet.'}
    >
      {/* An empty result from a filter is different from an empty deal — say
          which, or the Completed tab on a deal with two open tasks looks
          broken. */}
      {!loading && items.length > 0 && shown.length === 0 && (
        <Muted>
          {status === 'completed' ? 'Nothing completed yet.' : 'No open tasks.'}
        </Muted>
      )}

      {shown.map((t, i) => (
        <Row key={t.id} last={i === shown.length - 1} dim={t.status !== 'open'}>
          <button
            onClick={() => toggle(t)}
            disabled={saving.has(t.id)}
            title={
              saving.has(t.id)
                ? 'Saving…'
                : t.status === 'open' ? 'Mark complete' : 'Reopen this task'
            }
            style={{
              flex: 'none', marginTop: 1,
              width: 24, height: 24, padding: 0,
              border: 'none', background: 'none',
              cursor: saving.has(t.id) ? 'progress' : 'pointer',
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              // A GLYPH, not a drawn ring. The design's open task shows an
              // outlined check-circle in grey — the tick is already there,
              // waiting to be filled — and the done state fills it green.
              // The hand-drawn ring (empty when open, solid when done) read as
              // a radio button beside the design's icon. Overdue keeps its
              // red so the row still warns before the date is read.
              color: t.status !== 'open'
                ? 'var(--status-done)'
                : t.overdue ? 'var(--status-stuck)' : 'var(--text-muted)'
            }}
          >
            {/* .ms-fill is the house filled variant — it keeps the weight,
                grade and optical-size axes the base .ms rule sets, which an
                inline FILL-only override would silently drop. */}
            <span
              className={t.status !== 'open' ? 'ms ms-fill' : 'ms'}
              style={{ fontSize: 24 }}
            >
              check_circle
            </span>
          </button>

          <div style={{ minWidth: 0, flex: 1 }}>
            <span
              style={{
                display: 'block',
                fontSize: 'var(--text-lg)', fontWeight: 600, lineHeight: 1.3,
                color: 'var(--text-heading)',
                textDecoration: t.status === 'open' ? 'none' : 'line-through'
              }}
            >
              {t.title || '(untitled task)'}
            </span>

            {t.body && (
              <div style={{ marginTop: 1 }}>
                {/* Body grey, not muted: the description is the task's own
                    text and the design sets it one step down from the title,
                    not at the meta line's grey. Snug leading — at 1.55 on
                    15px the three lines drifted apart and the row read as
                    three items. */}
                <RichBody
                  html={t.body}
                  color="var(--text-body)"
                  size="var(--text-lg)"
                  leading="var(--leading-snug)"
                  maxWidth={480}
                />
              </div>
            )}

            <span
              style={{
                display: 'flex', alignItems: 'center', gap: 8,
                marginTop: 4, flexWrap: 'wrap',
                fontSize: 'var(--text-base)', color: 'var(--text-muted)'
              }}
            >
              {[
                formatDue(t.dueAt),
                t.createdAt ? `added ${compactAge(t.createdAt)}` : null,
                t.owner
              ].filter(Boolean).join(' · ')}
              {t.overdue && t.status === 'open' && <OverduePill />}
              {/* WHO THE TASK IS ABOUT, as a chip rather than more grey text.
                  A task is filed against a contact in GHL and this rail showed
                  only the assignee — so "call back" gave no indication of who
                  to call on a deal with several people. Distinct from
                  `t.owner`, which is the internal user it is allocated to. */}
              {t.contact?.name && <PersonChip name={t.contact.name} />}
            </span>
          </div>

          <EditButton
            title="Edit this task"
            onClick={() => setEditor({ task: t })}
          />
          <button
            onClick={() => { setConfirmError(null); setConfirming(t) }}
            disabled={deleting === t.id}
            title="Delete this task"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              flex: 'none',
              width: 40, height: 40, padding: 0,
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: '#fff',
              cursor: deleting === t.id ? 'progress' : 'pointer',
              color: 'var(--status-stuck-text)'
            }}
          >
            <span
              className={deleting === t.id ? 'ms pp-spin' : 'ms'}
              style={{ fontSize: 18 }}
            >
              {deleting === t.id ? 'progress_activity' : 'close'}
            </span>
          </button>
        </Row>
      ))}

      {/* A failed write needs saying. The rail has no toast of its own, and a
          checkbox that silently sprang back would look like a glitch. */}
      {failed && (
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 6,
            padding: '9px 14px',
            borderTop: '1px solid var(--border-default)',
            background: 'var(--tint-rose)',
            fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)'
          }}
        >
          <span className="ms" style={{ fontSize: 15, flex: 'none', marginTop: 1 }}>error</span>
          {failed}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Delete this task?"
          message="This cannot be undone from here."
          preview={taskPreview(confirming)}
          confirmLabel="Delete task"
          busy={deleting === confirming.id}
          error={confirmError}
          onConfirm={removeTask}
          onCancel={() => { setConfirming(null); setConfirmError(null) }}
        />
      )}

      {editor && (
        <TaskEditor
          task={editor.task}
          contacts={people}
          businesses={linkTargets.businesses}
          defaultContactId={
            editor.task?.contact?.id
            || people.find((p) => p.primary)?.id
            || people[0]?.id
            || null
          }
          // The DEAL picker is hidden — this rail belongs to one deal, the
          // task is linked to it, and offering a picker here would invite
          // refiling onto a different deal by accident.
          //
          // The COMPANY picker stays. Which company a task concerns is
          // unrelated to which deal's rail it was opened from, and hiding it
          // (as a single showLinks flag used to) meant the association could
          // only be set from the standalone Tasks tab.
          //
          // THE DEAL PICKER IS SHOWN TOO, pre-filled with this rail's deal.
          //
          // It was hidden on the reasoning that the deal is already known
          // here, so a picker only invites refiling by accident. But the
          // result was a rep who could see the Company and not the Deal, with
          // no way to tell what the task was attached to or to correct it
          // when wrong. Showing it pre-filled states the answer; changing it
          // is then a deliberate act, not an accident waiting to happen.
          deals={linkTargets.deals}
          defaultOpportunityId={dealId || null}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            if (editor.task && saved) {
              patchItem((x) => x.id === editor.task.id, {
                title: saved.title ?? editor.task.title,
                body: saved.body ?? editor.task.body,
                dueAt: saved.dueDate ?? editor.task.dueAt,
                // Present only when the editor changed the assignee.
                ...('owner' in saved ? { owner: saved.owner, assignedTo: saved.assignedTo } : {}),
                // Present only when the editor changed the company link.
                ...('businessId' in saved ? { businessId: saved.businessId, business: saved.business } : {})
              })
              // Moved onto a different deal — this rail no longer holds it.
              if ('opportunityId' in saved && (saved.opportunityId || null) !== (dealId || null)) reloadSoon()
            } else {
              // A new task arrives via the CRM's webhook, so refetch rather
              // than inventing a row whose id and attribution we don't know —
              // and wait for that webhook, or the refetch beats it.
              reloadSoon()
            }
          }}
        />
      )}
    </Rail>
  )
}

// `onNoteSaved(noteId, patch)` lets the page patch its OTHER copy of the note —
// the timeline renders the same note from its own fetch, and without this it
// kept showing the pre-edit text after the rail had updated.
// Deal or contact scope — see DealTasksSection.
export function DealNotesSection({ dealId = null, contactId = null, people = [], onOpenAll, onNoteSaved }) {
  const scope = dealId ? 'deal' : 'contact'
  const { items, loading, error, patchItem, reload, reloadSoon } = useDealList(
    dealId || contactId,
    (id) => notesAPI.list({ ...(dealId ? { dealId: id } : { contactId: id }), limit: 50 }),
    'notes'
  )

  const [sort, setSort] = useState('newest')
  const [editor, setEditor] = useState(null)
  // Companies for the editor's picker. LAZY — nothing is fetched until an
  // editor opens, so a rep who only reads the rail pays nothing.
  //
  // The deal hub never passed these, so the picker seeded empty and showed
  // "Type to search" where the standalone Tasks and Notes tabs offer the
  // list straight away. The same company is equally likely from either
  // place; only the wiring differed.
  const linkTargets = useLinkTargets(!!editor)
  const [failed, setFailed] = useState(null)
  const [busy, setBusy] = useState(null)

  // Who a new note attaches to: the note's own contact when editing, else the
  // deal's primary. GHL names an opportunity after its contact and the primary
  // is who the deal is about, so that's the sensible default.
  const targetContactId = editor?.note?.contact?.id
    || people.find((p) => p.primary)?.id
    || people[0]?.id
    || null

  // The note queued for deletion. Final — the CRM has no restore over OAuth —
  // so the dialog says so and shows the note's own text.
  const [confirming, setConfirming] = useState(null)
  const [confirmError, setConfirmError] = useState(null)

  const remove = async () => {
    const n = confirming
    if (!n || busy) return
    setBusy(n.id)
    setConfirmError(null)
    setFailed(null)
    try {
      await notesAPI.remove(n.id)
      setConfirming(null)
      reload()
    } catch (err) {
      // Inside the dialog, which stays open, rather than in the rail's error
      // strip behind it.
      setConfirmError(err.message || 'Could not delete that note')
    } finally {
      setBusy(null)
    }
  }

  const shown = useMemo(
    () => [...items].sort((a, b) =>
      nullsLast(a.createdAt, b.createdAt, sort === 'newest' ? 'desc' : 'asc')
    ),
    [items, sort]
  )

  return (
    <Rail
      icon="sticky_note_2"
      title="Notes"
      // brown (#8a5a2b) in the client's palette. Gold is Qualification's
      // band — two adjacent panels in the same yellow read as one section.
      accent="brown"
      meta={loading ? null : `${items.length} ${items.length === 1 ? 'note' : 'notes'}`}
      toolbar={
        !loading && items.length > 0 ? (
          // The label is SortControl's own, beside the pills — not a
          // separate span with a spacer shoving the pills to the far edge.
          <SortControl
            label="Sort by created"
            options={[['newest', 'Newest'], ['oldest', 'Oldest']]}
            value={sort}
            onChange={setSort}
          />
        ) : null
      }
      footer={
        !loading ? (
          <RailFooter
            newLabel="New note"
            allLabel="All notes"
            onAll={onOpenAll}
            onNew={() => setEditor({ note: null })}
            newDisabledReason={
              people.length === 0
                ? (scope === 'deal'
                  ? 'This deal has no contacts, and a note is stored against a contact'
                  : 'No contact to attach the note to')
                : null
            }
          />
        ) : null
      }
      loading={loading}
      error={error}
      empty={!loading && items.length === 0}
      emptyText={scope === 'deal' ? 'No notes on this deal yet.' : 'No notes for this contact yet.'}
    >
      {shown.map((n, i) => {
        // The note's OWN title when the author gave one — the server has
        // always sent it (routes/notes.js), and the timeline already renders
        // it, but this rail went straight to splitNote. So a note titled
        // "test note" with body "body" showed only "body": splitNote took the
        // body's first line as the heading and the real title never appeared,
        // unlike the task rail right above it which shows both.
        const { heading, rest } = n.title
          ? { heading: n.title, rest: (n.body || '').trim() || null }
          : splitNote(n.body)
        // The colour a rep set on the note, in GHL or here. The server has
        // always sent it on /api/notes; nothing rendered it until now.
        const col = noteColourStyle(n.color)
        return (
          <Row key={n.id} last={i === shown.length - 1} stripe={col.stripe}>
            <span
              title={col.name ? `${col.name} note` : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 36, height: 36, flex: 'none',
                borderRadius: 'var(--radius-md)',
                // The note's own colour when it has one, so the square and the
                // stripe read as one object. Falls back to the rail's gold —
                // NOT to grey, which would make every uncoloured note look
                // like a deliberately grey one.
                background: col.tint || 'var(--tint-gold)',
                // The glyph stays dark either way: these are pastels, and the
                // gold-on-pastel accent colour was the only thing that made
                // the icon legible at 15px.
                color: col.hex ? 'var(--text-heading)' : 'var(--accent-gold-text)'
              }}
            >
              <span className="ms" style={{ fontSize: 18 }}>sticky_note_2</span>
            </span>

            <div style={{ minWidth: 0, flex: 1 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 'var(--text-lg)', fontWeight: 600, color: 'var(--text-heading)'
                }}
              >
                {heading}
              </span>
              {rest && (
                <div style={{ marginTop: 3 }}>
                  {/* The narrow rail still gets readable body text — 13px, one
                      step down from the timeline's 14px because the column is
                      half the width, but not the 12px muted it was. */}
                  <RichBody
                    html={rest}
                    color="var(--text-body)"
                    size="var(--text-lg)"
                    leading="var(--leading-normal)"
                    maxWidth={480}
                  />
                </div>
              )}
              <div
                style={{
                  display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap',
                  marginTop: 5
                }}
              >
                <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                  {[n.author, relativeTime(n.createdAt)].filter(Boolean).join(' · ')}
                </span>
                {/* The contact the note is filed against — the author is who
                    WROTE it, which is a different question and was the only
                    person named here. */}
                {n.contact?.name && <PersonChip name={n.contact.name} />}
                <AttachmentCount count={n.attachmentCount} />
              </div>
            </div>

            <EditButton
              title="Edit this note"
              onClick={() => setEditor({ note: n })}
            />
            <button
              onClick={() => { setConfirmError(null); setConfirming(n) }}
              disabled={busy === n.id}
              title="Delete this note"
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                flex: 'none',
                width: 40, height: 40, padding: 0,
                border: '1px solid var(--border-strong)',
                borderRadius: 'var(--radius-md)',
                background: '#fff',
                cursor: busy === n.id ? 'progress' : 'pointer',
                color: 'var(--status-stuck-text)'
              }}
            >
              <span
                className={busy === n.id ? 'ms pp-spin' : 'ms'}
                style={{ fontSize: 18 }}
              >
                {busy === n.id ? 'progress_activity' : 'close'}
              </span>
            </button>
          </Row>
        )
      })}

      {failed && (
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 6,
            padding: '9px 14px',
            borderTop: '1px solid var(--border-default)',
            background: 'var(--tint-rose)',
            fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)'
          }}
        >
          <span className="ms" style={{ fontSize: 15, flex: 'none', marginTop: 1 }}>error</span>
          {failed}
        </div>
      )}

      {confirming && (
        <ConfirmDialog
          title="Delete this note?"
          message="This cannot be undone — your CRM has no restore for notes."
          preview={notePreview(confirming)}
          confirmLabel="Delete note"
          busy={busy === confirming.id}
          error={confirmError}
          onConfirm={remove}
          onCancel={() => { setConfirming(null); setConfirmError(null) }}
        />
      )}

      {editor && (
        <NoteEditor
          note={editor.note}
          contacts={people}
          businesses={linkTargets.businesses}
          defaultContactId={targetContactId}
          // Both pickers shown — see the note on TaskEditor above. The deal
          // is pre-filled with this rail's, so the rep can see what the note
          // is attached to and change it if it is wrong.
          deals={linkTargets.deals}
          defaultOpportunityId={dealId || null}
          // How many notes are already pinned on the target contact, so the pin
          // toggle can say when there's no room rather than failing on save.
          pinnedCount={
            items.filter((x) => x.pinned && x.contact?.id === targetContactId).length
          }
          onClose={() => setEditor(null)}
          onSaved={(saved, applied) => {
            // Moved to a DIFFERENT deal? This rail is fetched by dealId, so
            // the note no longer belongs in it. Patching the row in place
            // would leave it sitting under a deal it is not on any more —
            // reload so it leaves the list, the same as any other row that
            // stops matching.
            //
            // ONLY when the save actually reports a deal. A text/title edit
            // returns GHL's copy of the note, and GHL does not hold the
            // note→deal link at all (it lives only in our database), so that
            // copy has NO opportunityId. Reading the absence as null made
            // every ordinary edit look like a move: the row was never
            // patched, and the 2.5s reload read our DB before the
            // NoteUpdate webhook had landed — so the old text stayed on
            // screen until a manual refresh. NoteEditor adds opportunityId
            // to `saved` itself when the deal link really changed.
            // Only a DEAL-scoped rail loses a note by moving it: the contact
            // rail lists the note whatever deal it is filed against.
            const movedAway = scope === 'deal' && editor.note && saved && 'opportunityId' in saved
              && (saved.opportunityId ?? null) !== (editor.note.opportunityId ?? null)
            if (editor.note && saved && !movedAway) {
              // `applied` first: GHL's note PUT does not reliably echo
              // every field it was sent, and `saved.title ?? null` blanked
              // the name a rep had just typed — the old body-derived heading
              // reappeared and the rename looked like it had failed.
              const patch = {
                body: applied?.body ?? saved.body ?? editor.note.body,
                title: applied?.title ?? saved.title ?? editor.note.title ?? null,
                color: applied?.color ?? saved.color ?? editor.note.color ?? null,
                pinned: applied?.pinned ?? (saved.pinned === true),
                // Changed links, whole — present only when they changed.
                ...('business' in saved ? { businessId: saved.businessId, business: saved.business } : {}),
                ...('deal' in saved ? { opportunityId: saved.opportunityId, deal: saved.deal } : {})
              }
              patchItem((x) => x.id === editor.note.id, patch)
              if (onNoteSaved) onNoteSaved(editor.note.id, patch)
            } else {
              // A new note arrives via the webhook, so refetch rather than
              // inventing a row whose id and attribution we don't know — and
              // wait for that webhook, or the refetch beats it.
              reloadSoon()
            }
          }}
        />
      )}
    </Rail>
  )
}

// ── Shared ────────────────────────────────────────────────────────────

// A task as plain text for the confirm dialog. The title alone is often
// "Follow Up" — identical across a dozen rows — so the due date goes in too, as
// that is what actually distinguishes them in the queue.
function taskPreview(task) {
  const title = (task.title || '').trim() || '(untitled task)'
  const due = formatDue(task.dueAt)
  return due ? `${title} · ${due}` : title
}

// A note as plain text for the confirm dialog. Bodies are markup, so the tags
// have to come off — otherwise the reader sees "<p>Hi Ollie</p>" and can't tell
// whether it's the right note.
function notePreview(note) {
  const title = (note.title || '').trim()
  const raw = String(note.body || '')
  let text = raw
  if (/<[a-z][^>]*>/i.test(raw)) {
    const doc = new DOMParser().parseFromString(raw, 'text/html')
    // Block boundaries are NOT whitespace in textContent, so
    // "<p>Hi Ollie</p><p>Thanks</p>" reads as "Hi OllieThanks" without this —
    // two sentences fused into a non-word, in the one place the reader is
    // checking they picked the right note.
    doc.querySelectorAll('br').forEach((el) => el.replaceWith(' '))
    doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6')
      .forEach((el) => el.append(' '))
    text = doc.body.textContent || ''
  }
  const body = text.replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim()
  if (title && body) return `${title} — ${body}`
  return title || body || '(empty note)'
}

function useDealList(dealId, fetcher, key) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Bumped to refetch — used after creating a task, whose row only exists once
  // the CRM's webhook has reached our database.
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (!dealId) return
    let alive = true
    setLoading(true)
    setError(null)
    fetcher(dealId)
      .then((r) => { if (alive) setItems(r?.[key] || []) })
      .catch((err) => { if (alive) setError(err?.message || 'Failed to load') })
      .finally(() => { if (alive) setLoading(false) })
    return () => { alive = false }
    // fetcher is recreated per render; dealId is what defines the request.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dealId, key, nonce])

  // Patch one row in place. A tick that refetched the whole rail would flicker
  // and lose the rep's filter position for no gain.
  const patchItem = useCallback((match, patch) => {
    setItems((prev) => prev.map((x) => (match(x) ? { ...x, ...patch } : x)))
  }, [])

  const reload = useCallback(() => setNonce((n) => n + 1), [])

  // RELOAD AFTER THE WEBHOOK HAS LANDED.
  //
  // Neither POST inserts our row: /notes and /tasks write to GHL, and the
  // NoteCreate / TaskCreate webhook is what inserts here. An immediate
  // refetch therefore races that insert and comes back without the row the
  // rep just created — which is why a new note only appeared after a manual
  // refresh.
  //
  // 2.5s is the delay the deal card already uses for every GHL-backed write
  // (DealHubTab's refreshDeal). The first reload still runs straight away, so
  // an edit to an EXISTING row stays instant; this only covers the create.
  const reloadSoon = useCallback(() => {
    window.setTimeout(() => setNonce((n) => n + 1), 2500)
  }, [])

  return { items, loading, error, patchItem, reload, reloadSoon }
}

function Rail({
  icon, title, accent, meta, blurb, toolbar, footer,
  loading, error, empty, emptyText, children
}) {
  const color = `var(--accent-${accent}-text)`
  const tint = `var(--tint-${accent})`
  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: color,
        ['--panel-tint']: tint,
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        overflow: 'hidden'
      }}
    >
      <PanelHead icon={icon} title={title} subtitle={meta} accent={accent} />

      {blurb && (
        <p
          style={{
            margin: 0, padding: '11px 14px',
            borderBottom: '1px solid var(--border-default)',
            background: 'var(--gray-50)',
            fontSize: 'var(--text-base)', lineHeight: 1.55, color: 'var(--text-body)'
          }}
        >
          {blurb}
        </p>
      )}

      {/* One bordered row per toolbar entry. The design stacks the Tasks
          rail's status pills and its SORT row as two rows with a rule
          between; a single flex row with a spacer put them side by side. An
          array renders a row each; a single node is still one row. */}
      {toolbar && (Array.isArray(toolbar) ? toolbar : [toolbar]).filter(Boolean).map((row, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap',
            padding: '12px 16px',
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          {row}
        </div>
      ))}

      {loading && <Muted>Loading…</Muted>}
      {error && (
        <p
          style={{
            margin: 0, padding: 'var(--space-3) 14px',
            borderLeft: '3px solid var(--status-stuck)',
            background: 'var(--tint-rose)',
            fontSize: 'var(--text-base)', color: 'var(--status-stuck)'
          }}
        >
          {error}
        </p>
      )}
      {empty && <Muted>{emptyText}</Muted>}
      {children}
      {footer}
    </section>
  )
}

// Who a task or note is filed against.
//
// A chip rather than another segment in the grey meta line: the meta line is
// dates and roles ("due 6 Feb · added 3d · James Stevens"), and a person's
// name buried in that reads as one more attribute. It is the answer to "who is
// this about", which is usually why a rep is looking at the row.
//
// Not clickable here. The rail has no contact-drawer route — TasksTab and
// NotesTab pass onOpenContact, this section does not — and a chip that looks
// interactive but does nothing is worse than a plain one.
function PersonChip({ name }) {
  return (
    <span
      title={`Filed against ${name}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 5,
        maxWidth: '100%',
        height: 26, padding: '0 11px',
        borderRadius: 'var(--radius-pill)',
        // The same blue outlined chip the timeline uses — a contact looks
        // like a contact in both places, rather than grey here and blue one
        // panel away. -text, not the bare accent: sky on its own tint is
        // 4.13:1, below AA.
        border: '1px solid var(--accent-sky)',
        background: 'var(--tint-sky)',
        fontSize: 'var(--text-base)', fontWeight: 500,
        color: 'var(--accent-sky-text)',
        // A contact with no name falls back to an email address, which has no
        // spaces to wrap on.
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
      }}
    >
      <span className="ms" style={{ fontSize: 15, flex: 'none' }}>person</span>
      {name}
    </span>
  )
}

function Row({ children, last, dim, stripe = null }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'flex-start', gap: 12,
        // The stripe replaces the left padding rather than adding to it, so a
        // coloured row and an uncoloured one keep their text on the same
        // vertical line — otherwise a mixed list looks ragged.
        padding: stripe ? '14px 16px 14px 13px' : '14px 16px',
        // THE NOTE'S COLOUR, as a 3px left edge.
        //
        // borderLeft, not a positioned child: it participates in layout, so it
        // cannot overlap the icon square, and it stretches to the row's full
        // height however tall the note's text runs.
        //
        // Only ever a normalised hex — see normaliseNoteColour. A raw value
        // from GHL interpolated here would be a CSS injection.
        borderLeft: stripe ? `3px solid ${stripe}` : 'none',
        borderBottom: last ? 'none' : '1px solid var(--border-default)',
        // A completed task stays visible but recedes — useful history, not
        // something needing attention.
        opacity: dim ? 0.55 : 1
      }}
    >
      {children}
    </div>
  )
}

// Open / Completed / All, each with its count.
function Segment({ options, value, onChange }) {
  return (
    <span style={{ display: 'inline-flex', gap: 6, flexWrap: 'wrap' }}>
      {options.map(([id, label, count]) => {
        const active = value === id
        return (
          <button
            key={id}
            onClick={() => onChange(id)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              cursor: 'pointer',
              height: 34, padding: '0 14px',
              border: active
                ? '1.5px solid var(--brand-primary)'
                : '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-pill)',
              background: active ? 'var(--brand-primary)' : '#fff',
              color: active ? '#fff' : 'var(--text-body)',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-md)', fontWeight: active ? 600 : 400
            }}
          >
            {label}
            {count != null && (
              <span
                style={{
                  // The same face as the label, one step down — the design
                  // sets "Open 1" as one phrase, not a label with a code.
                  fontSize: 'var(--text-base)', fontWeight: active ? 600 : 500,
                  // Brand digits on a now-solid-brand chip would be invisible.
                  color: active ? 'rgba(255,255,255,0.9)' : 'var(--text-muted)'
                }}
              >
                {count}
              </span>
            )}
          </button>
        )
      })}
    </span>
  )
}

// A two-option sort toggle, with the label the design puts beside it.
function SortControl({ label, options, value, onChange }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 7 }}>
      {label && (
        <span
          style={{
            fontSize: 'var(--text-sm)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
            textTransform: 'uppercase', color: 'var(--text-muted)'
          }}
        >
          {label}
        </span>
      )}
      <span style={{ display: 'inline-flex', gap: 8 }}>
        {options.map(([id, text]) => {
          const active = value === id
          return (
            <button
              key={id}
              onClick={() => onChange(id)}
              style={{
                cursor: 'pointer',
                height: 34, padding: '0 14px',
                border: active
                  ? '1.5px solid var(--brand-primary)'
                  : '1px solid var(--border-strong)',
                // Pills, like the status filters above them — one shape for
                // every toggle on the rail.
                borderRadius: 'var(--radius-pill)',
                background: active ? 'var(--brand-primary)' : '#fff',
                color: active ? '#fff' : 'var(--text-body)',
                fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-md)', fontWeight: active ? 600 : 400
              }}
            >
              {text}
            </button>
          )
        })}
      </span>
    </span>
  )
}

// "New task" + "All tasks →".
//
// Both are live now — the comment here used to say neither was. Creating writes
// to GHL (onNew), and the "all" link navigates to the full tab (onAll, threaded
// down from the shell).
//
// Each still degrades on its own: a footer given no handler renders that button
// disabled rather than throwing, and `newDisabledReason` lets a live feature
// refuse for a reason worth stating — a deal with no contacts cannot take a
// task, since tasks hang off the contact.
function RailFooter({ newLabel, allLabel, onNew, onAll, newDisabledReason }) {
  // The "all" link is live when the shell hands down a navigator. It was
  // hardcoded disabled with a "Coming next" title because the rail had no way
  // to reach the shell's navigate() — DealHubTab now threads one through.
  const allLive = typeof onAll === 'function'
  const live = typeof onNew === 'function' && !newDisabledReason
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-4)',
        padding: '12px 16px',
        borderTop: '1px solid var(--border-default)'
      }}
    >
      <button
        onClick={live ? onNew : undefined}
        disabled={!live}
        title={
          newDisabledReason
            // Scope-neutral: the rail also lives on the contact record.
            || (live ? newLabel : 'Creating writes back to your CRM — coming next')
        }
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          cursor: live ? 'pointer' : 'not-allowed',
          height: 40, padding: '0 16px',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-pill)',
          background: '#fff',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
          color: live ? 'var(--text-body)' : 'var(--text-faint)',
          opacity: live ? 1 : 0.7
        }}
      >
        <span className="ms" style={{ fontSize: 16 }}>add</span>
        {newLabel}
      </button>
      <button
        onClick={allLive ? onAll : undefined}
        disabled={!allLive}
        title={allLive ? `Open the ${allLabel.replace(/^All /, '')} tab` : 'Coming next'}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 5,
          cursor: allLive ? 'pointer' : 'not-allowed',
          border: 'none', background: 'none', padding: 0,
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-lg)',
          color: allLive ? 'var(--text-link)' : 'var(--text-faint)',
          fontWeight: allLive ? 600 : 400,
          opacity: allLive ? 1 : 0.75
        }}
      >
        {allLabel}
        <span className="ms" style={{ fontSize: 18 }}>arrow_forward</span>
      </button>
    </div>
  )
}

// Live when given an onClick, disabled without one. Both the task and note
// rails pass handlers now — an earlier version of this comment said notes had
// no write path, which stopped being true when the note write endpoints
// landed.
function EditButton({ title, onClick }) {
  const live = typeof onClick === 'function'
  return (
    <button
      onClick={onClick}
      disabled={!live}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        flex: 'none',
        width: 40, height: 40, padding: 0,
        border: `1px solid ${live ? 'var(--border-strong)' : 'var(--border-default)'}`,
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        cursor: live ? 'pointer' : 'not-allowed',
        color: live ? 'var(--text-muted)' : 'var(--text-faint)',
        opacity: live ? 1 : 0.7
      }}
    >
      <span className="ms" style={{ fontSize: 18 }}>edit</span>
    </button>
  )
}

function OverduePill() {
  return (
    <span
      style={{
        padding: '2px 7px', borderRadius: 'var(--radius-sm)',
        background: 'var(--status-stuck)', color: '#fff',
        fontSize: 'var(--text-xs)', fontWeight: 600
      }}
    >
      Overdue
    </span>
  )
}

function Muted({ children }) {
  return (
    <p style={{ margin: 0, padding: 'var(--space-4) 14px', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
      {children}
    </p>
  )
}

// Sort comparator that always puts missing dates at the end, in both
// directions. A plain `a - b` on a null date yields NaN, which leaves the pair
// in whatever order it arrived — so a task with no due date can land above an
// overdue one, which is the opposite of useful.
function nullsLast(a, b, dir) {
  const ta = a ? new Date(a).getTime() : null
  const tb = b ? new Date(b).getTime() : null
  const va = ta != null && !Number.isNaN(ta) ? ta : null
  const vb = tb != null && !Number.isNaN(tb) ? tb : null
  if (va == null && vb == null) return 0
  if (va == null) return 1
  if (vb == null) return -1
  return dir === 'asc' ? va - vb : vb - va
}

// "3d ago" / "14d ago" — the compact form the design uses on the meta line,
// where relativeTime's "14 days ago" is too long beside a due date and an owner.
function compactAge(iso) {
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 60) return 'just now'
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.round(hours / 24)
  if (days < 30) return `${days}d ago`
  const months = Math.round(days / 30)
  if (months < 12) return `${months}mo ago`
  return `${Math.round(months / 12)}y ago`
}

// Notes have no title column, so the first block becomes the heading and the
// rest is the body. Bodies are markup, so "first block" means the first
// paragraph/line element — splitting on "\n" finds nothing in
// "<p>a</p><p>b</p>" and would make the whole markup string the heading.
function splitNote(body) {
  const raw = (body || '').trim()
  if (!raw) return { heading: '(empty note)', rest: null }

  // Plain text (no markup): first line is the heading, as before.
  if (!/<[a-z][^>]*>/i.test(raw)) {
    const lines = raw.split('\n')
    const heading = lines[0].trim()
    const rest = lines.slice(1).join('\n').trim()
    if (!rest && heading.length > 120) return { heading: 'Note', rest: heading }
    return { heading, rest: rest || null }
  }

  // Markup: take the first block element's text as the heading and hand the
  // remaining markup back intact, so its formatting survives.
  const doc = new DOMParser().parseFromString(raw, 'text/html')
  const blocks = [...doc.body.children]
  if (blocks.length > 1) {
    const heading = (blocks[0].textContent || '').trim()
    const rest = blocks.slice(1).map((el) => el.outerHTML).join('')
    if (heading) return { heading, rest: rest || null }
  }

  // One block, or nothing usable: the whole thing is the body. No invented
  // heading — a truncated first sentence in bold reads worse than none.
  const text = (doc.body.textContent || '').trim()
  if (text.length <= 120) return { heading: text, rest: null }
  return { heading: 'Note', rest: raw }
}
