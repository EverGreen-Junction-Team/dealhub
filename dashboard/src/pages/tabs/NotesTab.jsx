import React, { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { htmlToText } from '../../utils/sanitiseHtml'
import ViewSwitch from '../shared/ViewSwitch'
import WorkFilters from '../shared/WorkFilters'
import { useTabState } from '../../hooks/useTabState'
import { useAuth } from '../../context/AuthContext'
import { OwnerFilter, SortSelect, defaultOwner, resolveOwner } from '../shared/ListFilters'
import { notesAPI } from '../../api/notes'
import { usePagedList, useInfiniteScroll } from '../../hooks/usePagedList'
import NoteEditor from '../shared/NoteEditor'
import { useLinkTargets } from '../../hooks/useLinkTargets'
import ConfirmDialog from '../shared/ConfirmDialog'
import { noteColourStyle } from '../../utils/noteColour'
import {
  Shell, DealPill, RowAction, LabelledControl,
  NoteChip, StateMessage, LoadMore, RichBody, relativeTime,
  AttachmentCount
} from '../shared/ListChrome'
import { LinkedRecords } from '../shared/LinkedRecords'

// Notes — v5.
//
// Changes from v4: "Add note" moves to the page header, the deal chip always
// renders (showing "No deal" when unattached), Delete joins the row actions,
// and notes linked to this note appear as gold chips beneath.
//
// October 2026: a brown section header and a labelled toolbar band (Author,
// Sort), as on Tasks, and a card per note in the grid — see NoteCard. Search
// sends `q` to /api/notes, which may not honour it yet.
//
// GHL notes have no title column (migration 017), so the heading is derived
// from the body's first block — see splitNote.

export default function NotesTab({ onOpenDeal, onOpenContact, onOpenBusiness }) {
  // Contact / deal filters. useTabState, not plain state: stepping out to a
  // deal or a contact and back should not discard them.
  const [filters, setFilters] = useTabState('notes', 'filters', {})

  // The note open in the reader. Null = none.
  const [reading, setReading] = useState(null)
  // A note to open on arrival — set by another tab before switching here
  // (the Contacts list's "View note"), along with a filter that brings it
  // into the first page. Cleared once used, so it opens once.
  const [focusNoteId, setFocusNoteId] = useTabState('notes', 'focus', null)

  // Defaults to the signed-in rep's own notes, and REMEMBERS a change — the
  // same pattern as Tasks, Deals and Contacts. A rep opening Notes almost
  // always wants what they wrote; a manager switches to everyone once and it
  // sticks for the session.
  const { session } = useAuth()
  const [author, setAuthor] = useTabState('notes', 'author', defaultOwner(session))
  // Newest first by default. Always the date the note was WRITTEN — the
  // import date is when we synced it, and on backfilled data every note
  // shares one, so ordering by it looks chronological and is not.
  const [sort, setSort] = useTabState('notes', 'sort', 'desc')
  // Search by who a note is about — business, contact or deal — as on Tasks.
  //
  // Sent to the SERVER as `q`: the list is paged, so a client-side filter
  // would only search the notes already loaded. Whether /api/notes honours
  // `q` is unconfirmed — see PENDING_FUNCTIONALITY.md. If it does not, the
  // box is ignored and the list is simply unfiltered.
  const [q, setQ] = useTabState('notes', 'q', '')

  const fetchPage = useCallback(
    ({ cursor }) => notesAPI.list({
      limit: 20, cursor, sort,
      // Omitted when empty, so the request carries no q= at all.
      ...(q.trim() ? { q: q.trim() } : {}),
      authorId: resolveOwner(author),
      contactId: filters.contactId || undefined,
      dealId: filters.dealId || undefined
    }),
    [filters, author, sort, q]
  )
  const { items, error, hasMore, loadingMore, loading, loadMore, patchItem, reload } =
    usePagedList({ fetchPage, key: 'notes', deps: [filters, author, sort, q] })
  const sentinelRef = useInfiniteScroll(loadMore, { enabled: hasMore && !loadingMore })

  const notes = items || []

  // Open the focused note once the first page has it. If the page has
  // loaded without it (deleted, or past the first page), let it go rather
  // than waiting forever — the list is still filtered to its contact.
  useEffect(() => {
    if (!focusNoteId || loading || !items) return
    const hit = items.find((n) => n.id === focusNoteId)
    if (hit) setReading(hit)
    setFocusNoteId(null)
  }, [focusNoteId, loading, items, setFocusNoteId])

  // null = closed. { note } = editing that one; { note: null } = creating.
  const [editor, setEditor] = useState(null)
  // Deals and companies for the editor's link pickers. Lazy: fetched when
  // an editor first opens, so reading the list costs nothing extra.
  const linkTargets = useLinkTargets(!!editor)
  const [busy, setBusy] = useState(null)
  const [toast, setToast] = useState(null)

  // Rows or a grid — see TasksTab. Persisted per tab, so the two can differ.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('pp.notes.view') || 'grid' } catch { return 'grid' }
  })
  useEffect(() => {
    try { localStorage.setItem('pp.notes.view', view) } catch { /* private mode */ }
  }, [view])


  const say = (message, tone = 'done') => {
    setToast({ message, tone })
    window.setTimeout(() => setToast(null), tone === 'done' ? 2200 : 4200)
  }

  // The note queued for deletion, plus any failure from trying. The CRM has no
  // restore over OAuth, so this genuinely can't be undone — the dialog says so
  // and shows the note's own text, rather than asking the reader to trust they
  // clicked the right row.
  const [confirming, setConfirming] = useState(null)
  const [confirmError, setConfirmError] = useState(null)

  // Wait for a newly-created note to arrive via the webhook.
  //
  // Backs off rather than hammering: most notes land on the second or third
  // try. Gives up after ~8s and says so — a spinner that never resolves is
  // worse than an honest "refresh in a moment".
  const pollTimers = useRef([])
  useEffect(() => () => pollTimers.current.forEach(window.clearTimeout), [])

  const pollForNote = (noteId) => {
    const delays = [600, 1000, 1500, 2000, 3000]
    let attempt = 0

    const tick = async () => {
      try {
        const res = await notesAPI.list({ limit: 20 })
        const arrived = !noteId || (res.notes || []).some((n) => n.id === noteId)
        if (arrived) {
          reload()
          say('Note added')
          return
        }
      } catch {
        // Ignore and retry — a failed poll is not a failed save.
      }
      attempt++
      if (attempt >= delays.length) {
        reload()
        say('Note saved — it will appear here shortly', 'done')
        return
      }
      pollTimers.current.push(window.setTimeout(tick, delays[attempt]))
    }

    pollTimers.current.push(window.setTimeout(tick, delays[0]))
  }

  const remove = async () => {
    const n = confirming
    if (!n || busy) return
    setBusy(n.id)
    setConfirmError(null)
    try {
      await notesAPI.remove(n.id)
      setConfirming(null)
      reload()
      say('Note deleted')
    } catch (err) {
      // Reported inside the dialog, which stays open — the reader can read why
      // and retry without hunting for the row again.
      setConfirmError(err.message || 'Could not delete that note')
    } finally {
      setBusy(null)
    }
  }

  return (
    <Shell>
      {/* One title, one control row — the same shape as the Tasks tab.
          There was a PageHeader repeating the tab name with a subtitle
          explaining what a note is, and the list below it in a second
          container. */}
      {/* A SECTION CARD with a solid brown header and a toolbar band beneath
          it — the same build as the Tasks tab, in the Notes colour. */}
      <section style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        boxShadow: 'var(--shadow-card)',
        background: '#fff',
        overflow: 'hidden'
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 9,
          padding: '12px 16px',
          background: 'var(--notes-header)',
          borderBottom: '1px solid var(--notes-header-border)'
        }}>
          <span className="ms" style={{ fontSize: 19, color: '#fff' }}>sticky_note_2</span>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff' }}>Notes</h2>
          {!loading && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              minWidth: 24, height: 22, padding: '0 8px', flex: 'none',
              borderRadius: 'var(--radius-pill)',
              background: 'rgba(255,255,255,.22)',
              fontSize: 13, fontWeight: 600, color: '#fff',
              fontVariantNumeric: 'tabular-nums'
            }}>
              {notes.length}{hasMore ? '+' : ''}
            </span>
          )}
        </header>

        {/* The toolbar band — labelled controls left, the view controls and
            Add note right. pp-task-toolbar gives the chosen values the same
            medium weight as the Tasks toolbar. */}
        <div className="pp-task-toolbar" style={{
          display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
          padding: '12px 14px',
          background: 'var(--gray-100)',
          borderBottom: '1px solid var(--border-default)'
        }}>
          <LabelledControl label="Search">
            <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
              <span className="ms" style={{
                position: 'absolute', left: 10, fontSize: 18,
                color: 'var(--text-faint)', pointerEvents: 'none'
              }}>
                search
              </span>
              <input
                className="pp-task-search"
                value={q}
                onChange={(e) => setQ(e.target.value)}
                placeholder="Search business, contact or deal"
                style={{
                  width: 300, maxWidth: '100%',
                  height: 34, boxSizing: 'border-box', padding: '0 12px 0 34px',
                  border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-md)',
                  background: '#fff', fontFamily: 'var(--font-sans)',
                  fontSize: 'var(--text-md)', color: 'var(--text-heading)'
                }}
              />
            </span>
          </LabelledControl>
          {/* "Author", not "Owner": a note is not assigned to anyone and
              cannot be reassigned, so calling it an owner would promise
              something the record does not support. "No author" covers
              notes synced before attribution existed. */}
          <LabelledControl label="Author">
            <OwnerFilter
              value={author}
              onChange={setAuthor}
              // Still passed when bare: it names the "All authors" option.
              label="Author"
              noneLabel="No author"
              width={190}
              bare
            />
          </LabelledControl>
          <LabelledControl label="Sort">
            <SortSelect
              value={sort}
              onChange={setSort}
              options={[
                { value: 'desc', label: 'Newest first' },
                { value: 'asc', label: 'Oldest first' }
              ]}
              width={150}
              bare
            />
          </LabelledControl>

          {/* ONE GROUP, pushed right, so it wraps as a unit — see TasksTab. */}
          <span style={{
            marginLeft: 'auto', flex: 'none',
            display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap'
          }}>
            <WorkFilters filters={filters} onChange={setFilters} noun="notes" />
            <ViewSwitch
              value={view}
              onChange={setView}
              options={[
                { id: 'grid', icon: 'grid_view', label: 'Grid' },
                { id: 'rows', icon: 'view_agenda', label: 'Rows' }
              ]}
            />
            <button
              onClick={() => setEditor({ note: null })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                height: 38, padding: '0 16px', flex: 'none',
                border: 'none', borderRadius: 'var(--radius-pill)',
                background: 'var(--notes-header)', color: '#fff',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                fontWeight: 600, cursor: 'pointer'
              }}
            >
              <span className="ms" style={{ fontSize: 17 }}>add</span>Add note
            </button>
          </span>
        </div>

        <StateMessage
          loading={loading}
          error={error}
          empty={!loading && notes.length === 0}
          emptyText="No notes yet. Notes are information worth keeping — saved by you, or by the agent when you agree in chat that something should be stored."
          loadingText="Loading notes…"
        />

        {/* Grey behind the list in BOTH views — see TasksTab for why.
            GRID lays NoteCards out at the same 460px minimum as the Tasks
            cards, so the two tabs' grids line up column for column. */}
        <div style={{
          background: 'var(--gray-50)',
          padding: 'var(--space-3)',
          display: view === 'grid' ? 'grid' : 'flex',
          ...(view === 'grid'
            ? { gridTemplateColumns: 'repeat(auto-fill, minmax(min(460px, 100%), 1fr))' }
            : { flexDirection: 'column' }),
          gap: 'var(--space-3)'
        }}>
        {notes.map((n) => {
          // Rows and the grid are separate components, as on the Tasks tab —
          // a stacked card and a single-line row share almost no layout.
          const shared = {
            note: n,
            onRead: () => setReading(n),
            onEdit: () => setEditor({ note: n }),
            onDelete: () => { setConfirmError(null); setConfirming(n) },
            onOpenDeal,
            onOpenContact,
            onOpenBusiness
          }
          return view === 'grid'
            ? <NoteCard key={n.id} {...shared} />
            : <NoteRow key={n.id} {...shared} />
        })}
        </div>

        {!loading && notes.length > 0 && (
          <LoadMore
            sentinelRef={sentinelRef}
            hasMore={hasMore}
            loadingMore={loadingMore}
            count={notes.length}
            noun="note"
          />
        )}
      </section>

      {editor && (
        <NoteEditor
          note={editor.note}
          contacts={editor.note?.contact ? [editor.note.contact] : []}
          // There is no deal in scope on this page, so the rep picks one. The
          // lists load on the first editor open, not on page load.
          deals={linkTargets.deals}
          businesses={linkTargets.businesses}
          onClose={() => setEditor(null)}
          onSaved={(saved, applied) => {
            if (editor.note && saved) {
              // Prefer what we KNOW we applied, then the CRM's echo, then
              // what the row already held.
              //
              // GHL's note PUT does not reliably echo every field it was
              // sent. Renaming a note sent {"title":"test4"} and the response
              // came back with no title, so `saved.title ?? null` blanked it
              // — the new name vanished and the old body-derived heading
              // came back. `applied` carries exactly the fields we sent, so
              // it is the only source that can speak for them.
              patchItem((x) => x.id === editor.note.id, {
                body: applied?.body ?? saved.body ?? editor.note.body,
                title: applied?.title ?? saved.title ?? editor.note.title ?? null,
                color: applied?.color ?? saved.color ?? editor.note.color ?? null,
                pinned: applied?.pinned ?? (saved.pinned === true),
                // The company, which the CRM echoes back on the note.
                //
                // Missing here, reopening the editor showed the OLD company
                // however well the save went: our row only catches up when
                // the NoteUpdate webhook lands a second or two later, and the
                // list still held the pre-save copy until then.
                //
                // `applied` is what the editor actually sent, used in
                // preference to the echo: GHL's note PUT is not confirmed to
                // return businessId, and trusting an absent field would blank
                // a company the rep just chose. Falls back to the echo, then
                // to the row's existing value.
                businessId: applied && 'businessId' in applied
                  ? applied.businessId
                  : (saved.businessId ?? editor.note.businessId ?? null),
                // The chips too, whole — NoteEditor adds them to `saved`
                // only when that link changed.
                ...('business' in saved ? { business: saved.business } : {}),
                ...('deal' in saved ? { opportunityId: saved.opportunityId, deal: saved.deal } : {})
              })
              say('Note saved')
            } else {
              // A new note reaches our database via the CRM's webhook, and that
              // round trip (our POST → CRM → webhook → the CRM fetch the webhook
              // makes → our DB) takes a second or two. A single immediate
              // reload() therefore lost the race almost every time, and the note
              // only appeared on a manual refresh.
              //
              // Poll instead, until it shows up or we give up. `saved.id` is the
              // CRM's own note id, which is what our rows are keyed on.
              say('Note added — syncing…')
              pollForNote(saved?.id)
            }
          }}
        />
      )}

      {confirming && (
        <ConfirmDialog
          title="Delete this note?"
          message="This cannot be undone — your CRM has no restore for notes."
          preview={previewOf(confirming)}
          confirmLabel="Delete note"
          busy={busy === confirming.id}
          error={confirmError}
          onConfirm={remove}
          onCancel={() => { setConfirming(null); setConfirmError(null) }}
        />
      )}

      {toast && (
        <Toast tone={toast.tone}>{toast.message}</Toast>
      )}

      {/* READER — the whole note, rendered as it was written.
          A clamped card shows three lines; this is where the rest lives.
          Read-only: editing is the pencil, and a modal that both shows
          and edits invites a rep to type into what they meant to read. */}
      {reading && (
        <NoteReader note={reading} onClose={() => setReading(null)} />
      )}

    </Shell>
  )
}

// What a note shows as its heading and its body.
//
// A real title wins over one derived from the body. Before migration 058
// there was no title column, so an author who DID title their note saw it
// rendered as body text with a heading invented from the first sentence.
function noteParts(n) {
  const derived = splitNote(n.body)
  return {
    heading: n.title || derived.heading,
    rest: n.title ? n.body : derived.rest
  }
}

// The note's colour tile — the sticky-note glyph on the author's colour.
//
// The colour goes through the shared normaliser: a note's colour is
// attacker-influenceable (anyone with sub-account access can set one, and
// integrations write notes too), so a raw value like
// `red; background-image: url(//evil/x)` would escape a style declaration.
// normaliseNoteColour is an allow-list of the two forms GHL itself accepts.
function NoteIcon({ col }) {
  return (
    <span
      title={col.name ? `${col.name} note` : undefined}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        width: 28, height: 28, flex: 'none',
        borderRadius: 'var(--radius-sm)',
        background: col.tint || 'var(--tint-gold)'
      }}
    >
      <span
        className="ms"
        style={{
          fontSize: 16,
          // Dark on the pastel fills — white on #FFF2B2 is about 1.2:1.
          color: col.hex ? 'var(--text-heading)' : 'var(--accent-gold)'
        }}
      >
        sticky_note_2
      </span>
    </span>
  )
}

// The badges that ride beside a heading: AI-written, pinned, attachments.
function HeadingBadges({ note: n }) {
  return (
    <>
      {isAIAuthored(n) && <AIBadge />}
      {n.pinned && (
        <span
          title="Pinned to the top of this contact"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            padding: '2px 8px',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--tint-gold)', color: 'var(--accent-gold-text)',
            fontSize: 'var(--text-sm)', fontWeight: 600
          }}
        >
          <span className="ms" style={{ fontSize: 13 }}>push_pin</span>
          Pinned
        </span>
      )}
      <AttachmentCount count={n.attachmentCount} />
    </>
  )
}

// "6 hours ago · by Deal Hub Agent" — when, then who.
function noteMeta(n) {
  return [relativeTime(n.createdAt), n.author && `by ${n.author}`]
    .filter(Boolean).join(' · ')
}

// A note in the GRID — the October 2026 card design.
//
//   ┌ ▣ heading ─────────────────── [View DEAL] ┐   header: what, and its
//   │ body, two lines                            │   deal (or No DEAL)
//   │ 👤 contact                 [View CONTACT]  │   linked records — only
//   │ 🏷 deal                    [View DEAL]     │   the ones it HAS
//   │ 🏢 business               [View BUSINESS]  │
//   └ 6 hours ago · by Deal Hub Agent      ✎  ✕ ┘   footer: when, who, act
//
// The header's deal pill ALWAYS renders — "No DEAL" is a real state worth
// seeing on a note, not an absence to hide.
function NoteCard({
  note: n, onRead, onEdit, onDelete,
  onOpenDeal, onOpenContact, onOpenBusiness
}) {
  const { heading, rest } = noteParts(n)
  const col = noteColourStyle(n.color)
  const hasChips = n.noteChips?.length > 0
  const rule = '1px solid var(--border-default)'

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      // A CARD IN BOTH VIEWS — the same border, radius and surface as a row.
      border: rule,
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface-card)',
      boxShadow: 'var(--shadow-card)',
      overflow: 'hidden'
    }}>
      {/* HEADER — colour tile, heading, and the deal pill on the right. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 10,
        padding: '14px 16px',
        borderBottom: rule
      }}>
        <NoteIcon col={col} />
        <span style={{
          flex: 1, minWidth: 0,
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap'
        }}>
          <span style={{
            fontSize: 'var(--text-xl)', fontWeight: 600,
            lineHeight: 1.3, letterSpacing: '-0.01em',
            color: 'var(--text-heading)',
            overflowWrap: 'anywhere'
          }}>
            {heading}
          </span>
          <HeadingBadges note={n} />
        </span>
        <span style={{ flex: 'none' }}>
          <DealPill
            name={n.deal?.name || 'No deal'}
            empty={!n.deal}
            onClick={n.deal && onOpenDeal ? () => onOpenDeal(n.deal.id) : undefined}
          />
        </span>
      </div>

      {/* BODY — two reserved lines, so every card in a grid row starts its
          linked records at the same depth whether or not it has a body. */}
      <div style={{ padding: '14px 16px', borderBottom: rule }}>
        <div style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: 'calc(var(--text-lg) * 1.5 * 2)'
        }}>
          {rest ? (
            <RichBody
              html={rest}
              color="var(--text-body)"
              size="var(--text-lg)"
              leading="var(--leading-normal)"
              showPlainToggle={false}
            />
          ) : (
            <span style={{ fontSize: 'var(--text-lg)', color: 'var(--text-faint)' }}>
              No further text
            </span>
          )}
        </div>
        {/* Only when there IS more to read. Measured on the TEXT, not the
            HTML — markup length says nothing about how many lines it takes.
            ~90 characters is where two lines at this width run out. */}
        {htmlToText(rest || '').length > 90 && (
          <button
            onClick={onRead}
            style={{
              marginTop: 4,
              border: 'none', background: 'none', padding: 0,
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
              fontWeight: 600, color: 'var(--text-link)',
              cursor: 'pointer'
            }}
          >
            Read more
          </button>
        )}
      </div>

      {/* LINKED RECORDS — flex:1 takes the card's spare height, so the footer
          sits on the card's floor and lines up across a grid row. */}
      <div style={{ flex: 1, padding: '0 16px', display: 'flex', flexDirection: 'column' }}>
        <LinkedRecords
          record={n}
          onOpenDeal={onOpenDeal}
          onOpenContact={onOpenContact}
          onOpenBusiness={onOpenBusiness}
        />
        {hasChips && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '4px 0 12px' }}>
            {n.noteChips.map((c) => (
              <NoteChip key={c.id} label={c.label} />
            ))}
          </div>
        )}
      </div>

      {/* FOOTER — when and who on the left, edit and delete on the right. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        padding: '10px 16px',
        borderTop: rule
      }}>
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 'var(--text-base)', color: 'var(--text-muted)'
        }}>
          {noteMeta(n)}
        </span>
        <RowAction icon="edit" title="Edit this note" onClick={onEdit} />
        <RowAction icon="close" danger title="Delete this note" onClick={onDelete} />
      </div>
    </div>
  )
}

// A note in ROWS — the October 2026 row design, the same four ruled columns
// as a task row:
//
//   ▣ │ 👤 contact  [View CONTACT] │ 🕓 CREATED    │ heading            │
//     │ 🏷 deal     [View DEAL]    │ 6 hours ago   │ body               │
//     │ 🏢 business [View BUSINESS]│ [No DEAL]     │ by Jordan Blake ✎ ✕│
//
// Which note · who it is about · when (and whether a deal is missing) · what
// it says. Fixed widths up to the heading, so the tiles, View pills and dates
// land on the same x down the whole list.
function NoteRow({
  note: n, onEdit, onDelete,
  onOpenDeal, onOpenContact, onOpenBusiness
}) {
  const { heading, rest } = noteParts(n)
  const col = noteColourStyle(n.color)
  const hasChips = n.noteChips?.length > 0
  const rule = '1px solid var(--border-default)'

  return (
    <div style={{
      display: 'grid',
      // tile · records · created · heading+body+actions — the Tasks row's
      // columns, so the two tabs' rows line up. No `order` anywhere: the
      // children are written in the order they appear (see TasksTab).
      gridTemplateColumns: '56px minmax(280px, 400px) minmax(140px, auto) minmax(0, 1fr)',
      // Stretch, so each column's divider runs the full row height.
      alignItems: 'stretch',
      // A CARD IN BOTH VIEWS — the same border, radius and surface as
      // NoteCard; the grey list ground separates rows.
      border: rule,
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface-card)',
      overflow: 'hidden'
    }}>
      {/* 1 · WHICH — the colour tile, centred in its own ruled column. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRight: rule
      }}>
        <NoteIcon col={col} />
      </div>

      {/* 2 · WHO — only the records the note has. */}
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        minWidth: 0, padding: '4px 16px',
        borderRight: rule
      }}>
        <LinkedRecords
          record={n}
          onOpenDeal={onOpenDeal}
          onOpenContact={onOpenContact}
          onOpenBusiness={onOpenBusiness}
        />
      </div>

      {/* 3 · WHEN — "CREATED" over how long ago, and the No DEAL pill
          beneath when the note is off any deal. */}
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: 'flex-start', gap: 4,
        padding: '12px 14px',
        borderRight: rule
      }}>
        <span style={{ display: 'flex', alignItems: 'center', gap: 5, color: 'var(--text-muted)' }}>
          <span className="ms" style={{ fontSize: 15 }}>schedule</span>
          <span className="pp-label" style={{ marginBottom: 0, color: 'inherit' }}>Created</span>
        </span>
        <span style={{
          fontSize: 'var(--text-lg)', fontWeight: 500,
          color: 'var(--text-heading)', whiteSpace: 'nowrap'
        }}>
          {relativeTime(n.createdAt) || 'Unknown'}
        </span>
        {!n.deal && <DealPill name="No deal" empty compact />}
      </div>

      {/* 4 · WHAT — heading, body and author, with edit and delete in the
          bottom-right corner. */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 'var(--space-3)',
        minWidth: 0, padding: '14px 16px'
      }}>
        <div style={{ flex: 1, minWidth: 0, alignSelf: 'center' }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)', flexWrap: 'wrap'
          }}>
            <span style={{
              fontSize: 'var(--text-lg)', fontWeight: 600,
              lineHeight: 1.3, color: 'var(--text-heading)',
              overflowWrap: 'anywhere'
            }}>
              {heading}
            </span>
            <HeadingBadges note={n} />
          </div>
          {rest && (
            <div style={{ marginTop: 6 }}>
              <RichBody
                html={rest}
                color="var(--text-muted)"
                size="var(--text-md)"
                leading="var(--leading-normal)"
                maxWidth={680}
                showPlainToggle
              />
            </div>
          )}
          {n.author && (
            <div style={{ marginTop: 6, fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
              by {n.author}
            </div>
          )}
          {hasChips && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
              {n.noteChips.map((c) => (
                <NoteChip key={c.id} label={c.label} />
              ))}
            </div>
          )}
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <RowAction icon="edit" title="Edit this note" onClick={onEdit} />
          <RowAction icon="close" danger title="Delete this note" onClick={onDelete} />
        </span>
      </div>
    </div>
  )
}

const TOAST_TONES = {
  done:  { icon: 'check_circle', colour: 'var(--status-done)' },
  error: { icon: 'error',        colour: 'var(--status-stuck)' }
}

// A failed save and a successful one must not look identical.
function Toast({ children, tone = 'done' }) {
  const { icon, colour } = TOAST_TONES[tone] || TOAST_TONES.done
  return (
    <div
      role="status"
      style={{
        position: 'fixed', bottom: 20, right: 20, zIndex: 40,
        display: 'flex', alignItems: 'center', gap: 7,
        maxWidth: 420,
        padding: '10px 14px',
        border: `1px solid ${colour}`,
        borderRadius: 'var(--radius-md)',
        background: '#fff', boxShadow: 'var(--shadow-overlay)',
        fontSize: 'var(--text-md)', color: 'var(--text-heading)'
      }}
    >
      <span className="ms" style={{ fontSize: 17, color: colour, flex: 'none' }}>{icon}</span>
      {children}
    </div>
  )
}

// A note as plain text, for the confirm dialog's preview. Bodies are markup, so
// the tags have to come off or the reader sees "<p>Hi Ollie</p>" and can't tell
// whether it's the right note.
function previewOf(note) {
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
  // Both when they differ — the title alone may not be enough to recognise it,
  // and the body alone loses the heading the reader was looking at.
  if (title && body) return `${title} — ${body}`
  return title || body || '(empty note)'
}


function AIBadge() {
  return (
    <span
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 'var(--space-1)',
        height: 22, padding: '0 9px',
        borderRadius: 'var(--radius-pill)',
        background: 'var(--tint-sky)', color: 'var(--accent-sky-text)',
        fontSize: 'var(--text-sm)', fontWeight: 600
      }}
    >
      <span className="ms" style={{ fontSize: 14 }}>auto_awesome</span>
      AI agent
    </span>
  )
}

// Notes have no title column, so the first block becomes the heading and the
// rest is the body. Bodies are markup, so "first block" means the first
// paragraph/line element — splitting on "\n" finds nothing in
// "<p>a</p><p>b</p>" and would make the whole markup string the heading.
function splitNote(body) {
  const raw = (body || '').trim()
  if (!raw) return { heading: '(empty note)', rest: null }

  // Plain text: first line is the heading, as before.
  if (!/<[a-z][^>]*>/i.test(raw)) {
    const lines = raw.split('\n')
    const heading = lines[0].trim()
    const rest = lines.slice(1).join('\n').trim()
    if (!rest && heading.length > 120) return { heading: 'Note', rest: heading }
    return { heading, rest: rest || null }
  }

  // Markup: first block element's text is the heading; the remaining markup is
  // handed back intact so its formatting survives.
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

// Notes written by the AI agent. GHL has no "authored by AI" flag, so this
// reads the stored author name. Once the agent stamps its own attribution,
// point this at that field.
function isAIAuthored(note) {
  const author = (note.author || '').toLowerCase()
  return author.includes('ai') || author.includes('deal hub') || author.includes('agent')
}


// A note, full text, in a modal.
//
// Portalled for the same reason every other overlay here is: the list sits
// inside a bordered surface with its own overflow, which would clip this.
function NoteReader({ note, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const derived = splitNote(note.body)
  const heading = note.title || derived.title
  const rest = note.title ? note.body : derived.rest

  return createPortal(
    // .pp-portal — tokens and the icon font are scoped to [data-dealhub].
    <div
      className="pp-portal"
      role="dialog"
      aria-modal="true"
      aria-label={heading || 'Note'}
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 1000,
        background: 'rgba(15, 23, 42, 0.32)',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-4)'
      }}
    >
      <div style={{
        width: 'min(720px, 100%)', maxHeight: '80vh',
        background: 'var(--surface-card)',
        borderRadius: 'var(--radius-lg)',
        display: 'flex', flexDirection: 'column',
        boxShadow: '0 10px 40px rgba(0,0,0,0.18)'
      }}>
        <header style={{
          flex: 'none',
          display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between',
          gap: 'var(--space-3)', padding: 'var(--space-4)',
          borderBottom: '1px solid var(--border-default)'
        }}>
          <h2 style={{
            margin: 0, fontSize: 'var(--text-xl)', fontWeight: 600,
            color: 'var(--text-heading)', letterSpacing: '-0.01em',
            overflowWrap: 'anywhere'
          }}>
            {heading || 'Note'}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, flex: 'none',
              border: '1px solid var(--border-default)', borderRadius: '50%',
              background: 'transparent', color: 'var(--text-muted)',
              cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 18 }}>close</span>
          </button>
        </header>

        <div style={{ flex: 1, overflowY: 'auto', padding: 'var(--space-4)' }}>
          {rest
            ? (
              <RichBody
                html={rest}
                color="var(--text-body)"
                size="var(--text-lg)"
                leading="var(--leading-normal)"
              />
            )
            : (
              <p style={{ margin: 0, color: 'var(--text-faint)', fontSize: 'var(--text-lg)' }}>
                This note has no body.
              </p>
            )}
        </div>

        <footer style={{
          flex: 'none', padding: 'var(--space-3) var(--space-4)',
          borderTop: '1px solid var(--border-default)',
          fontSize: 'var(--text-base)', color: 'var(--text-muted)'
        }}>
          {[note.author, relativeTime(note.createdAt)].filter(Boolean).join(' · ')}
        </footer>
      </div>
    </div>,
    document.body
  )
}
