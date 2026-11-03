import React, { useCallback, useEffect, useRef, useState } from 'react'
import { DatePicker, Select } from 'antd'
import dayjs from 'dayjs'

const { RangePicker } = DatePicker
import { htmlToText } from '../../utils/sanitiseHtml'
import ViewSwitch from '../shared/ViewSwitch'
import WorkFilters from '../shared/WorkFilters'
import { tasksAPI } from '../../api/tasks'
import { usePagedList, useInfiniteScroll } from '../../hooks/usePagedList'
import { useTabState } from '../../hooks/useTabState'
import { useAuth } from '../../context/AuthContext'
import { OwnerFilter, SortSelect, defaultOwner, resolveOwner } from '../shared/ListFilters'
import TaskEditor from '../shared/TaskEditor'
import TaskDealsPopover from '../shared/TaskDealsPopover'
import { useLinkTargets } from '../../hooks/useLinkTargets'
import ConfirmDialog from '../shared/ConfirmDialog'
import {
  Shell, DealPill, RowAction, LabelledControl,
  NoteChip, StateMessage, LoadMore,
  RichBody, formatDate, formatDue, relativeTime
} from '../shared/ListChrome'
import { LinkedRecords } from '../shared/LinkedRecords'

// Tasks — v5.
//
// Changes from v4: the title is a button that opens the task on the deal hub,
// contact and deal chips sit on the right, linked notes render as gold chips on
// their own line beneath the row, and Add task sits on the panel toolbar.
//
// A task with no deal shows a "No deal" chip rather than hiding the slot — v5
// makes unattached tasks a first-class state, so the absence has to be visible.

const DUE_FILTERS = [
  ['all', 'All'],
  ['overdue', 'Overdue'],
  ['week', 'Due this week'],
  ['month', 'Due next 30 days'],
  // Reveals the range picker beside this select. The presets answer "what is
  // coming up"; a range answers "what happened in March", which no relative
  // window can express.
  ['custom', 'Custom range']
]

// Open is the default because the queue is a to-do list, but a completed task
// is the record of what was actually done — worth being able to look back at,
// and the only way to confirm a task the agent created was seen to.
const STATUS_FILTERS = [
  ['open', 'Open'],
  ['completed', 'Completed'],
  ['all', 'All']
]

// Adding or removing a task's deals is switched off in the UI.
//
// GHL refuses the write outright — not a scope, a platform restriction:
//
//   POST /associations/relations
//     → 400 {"message":"Relations cannot be modified via OAuth channel"}
//
// That is restrictOAuthChannel, the same block that stops marketplace apps
// restoring a deleted note. There is no scope to add and no retry that
// succeeds, so the control could be operated but never saved.
//
// READING is unaffected: the deals a task is linked to still come from the
// task payload (taskWriter mirrors them into task_relations), so the chip and
// the +N count stay accurate. Only changing them from here is gone — it has
// to be done in the CRM.
//
// Everything behind this is intact: the popover component, the routes, the
// association calls, and the webhook handlers. Flip to true if GHL opens the
// endpoint to OAuth apps.
const TASK_DEAL_EDITING = false


// Search by WHO a task is about, not what it is called.
//
// Matches contact, deal and business name — a rep hunting "Cedarstone" wants
// that company's tasks whatever each one is titled. The filtering happens on
// the server (routes/tasks.js): the list is paged, so a client-side filter
// would only search the rows already loaded and silently miss page two.
function TaskSearch({ value, onChange }) {
  return (
    <span style={{ position: 'relative', display: 'inline-flex', alignItems: 'center' }}>
      <span className="ms" style={{
        position: 'absolute', left: 10, fontSize: 18,
        color: 'var(--text-faint)', pointerEvents: 'none'
      }}>
        search
      </span>
      <input
        className="pp-task-search"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search business, contact or deal"
        style={{
          width: 260, maxWidth: 360, flex: '1 1 260px',
          height: 34, padding: '0 32px 0 34px',
          border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-md)',
          background: '#fff', fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-md)', color: 'var(--text-heading)'
        }}
      />
      {value && (
        <button
          onClick={() => onChange('')}
          title="Clear the search"
          style={{
            position: 'absolute', right: 8, display: 'inline-flex',
            border: 'none', background: 'none', padding: 0,
            color: 'var(--text-faint)', cursor: 'pointer'
          }}
        >
          <span className="ms" style={{ fontSize: 16 }}>close</span>
        </button>
      )}
    </span>
  )
}

export default function TasksTab({ onOpenDeal, onOpenContact, onOpenBusiness }) {
  // Remembered across tab switches — see useTabState. Clicking a task through
  // to its deal and coming back used to reset this to 'all'.
  const [dueFilter, setDueFilter] = useTabState('tasks', 'dueFilter', 'all')
  // The custom date range, as ['YYYY-MM-DD', 'YYYY-MM-DD'] or null.
  //
  // Stored as STRINGS, not dayjs objects: useTabState persists through
  // localStorage, and a dayjs instance does not survive JSON — it would come
  // back as a plain object that throws the moment the picker calls .format().
  const [dueRange, setDueRange] = useTabState('tasks', 'dueRange', null)
  const [status, setStatus] = useTabState('tasks', 'status', 'open')
  // Per TAB, like every other filter here: stepping out to a deal and back
  // keeps the search you were in the middle of.
  const [q, setQ] = useTabState('tasks', 'q', '')
  const [toast, setToast] = useState(null)

  // Rows or a grid. Persisted: a display preference, not a navigation step, so
  // a rep who prefers the grid should not be handed rows every time they come
  // back to this tab.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('pp.tasks.view') || 'grid' } catch { return 'grid' }
  })
  useEffect(() => {
    try { localStorage.setItem('pp.tasks.view', view) } catch { /* private mode */ }
  }, [view])

  // Contact / deal filters. useTabState, not plain state: stepping out to a
  // deal or a contact and back should not discard them.
  const [filters, setFilters] = useTabState('tasks', 'filters', {})

  // Defaults to the signed-in user's own tasks, and REMEMBERS a change:
  // useTabState survives a tab switch and a reload for two hours, so a manager
  // who switches to "All owners" is not put back on Mine every visit.
  const { session } = useAuth()
  const [owner, setOwner] = useTabState('tasks', 'owner', defaultOwner(session))
  // Due date by default — a task list is for what is coming up. Created date
  // answers a different question ("what came in recently"), so it is an
  // option rather than a replacement. Persisted like every other filter.
  const [sort, setSort] = useTabState('tasks', 'sort', 'due')

  const fetchPage = useCallback(
    ({ cursor }) => tasksAPI.list({
      status, due: dueFilter, sort, limit: 20, cursor,
      // Omitted when empty so the request carries no q= at all, rather than
      // an empty one the route then has to treat as "match everything".
      ...(q.trim() ? { q: q.trim() } : {}),
      // Only sent with due=custom — the server ignores them otherwise, and
      // sending them regardless would make the request vary for no reason.
      dueFrom: dueFilter === 'custom' ? (dueRange?.[0] || undefined) : undefined,
      dueTo: dueFilter === 'custom' ? (dueRange?.[1] || undefined) : undefined,
      assignedTo: resolveOwner(owner),
      contactId: filters.contactId || undefined,
      dealId: filters.dealId || undefined
    }),
    [status, dueFilter, dueRange, filters, owner, session, sort, q]
  )
  // dueRange is a DEP: without it, picking a different range while already on
  // 'custom' leaves dueFilter unchanged, so page one is never refetched and
  // the list keeps showing the previous range.
  const { items, error, hasMore, loadingMore, loading, loadMore, patchItem, reload } =
    usePagedList({ fetchPage, key: 'tasks', deps: [status, dueFilter, dueRange, filters, owner, sort, q] })
  const sentinelRef = useInfiniteScroll(loadMore, { enabled: hasMore && !loadingMore })

  const tasks = items || []
  const openCount = tasks.length
  // The panel meta said "N open" whatever was on screen, so the Completed
  // filter read "20+ open" over a list of finished tasks.
  const countNoun =
    status === 'open' ? 'open' : status === 'completed' ? 'completed' : 'tasks'

  // Tick straight away, then write. The round trip to the CRM and back takes a
  // moment (their API waits ~2s internally to keep its own stores in sync), and
  // a checkbox that doesn't move until then feels broken.
  //
  // On failure the tick is rolled back and the reason is shown — a box that
  // silently didn't save is worse than one that visibly bounces and says why.
  const [saving, setSaving] = useState(() => new Set())
  // null = closed. { task } = editing that one; { task: null } = creating.
  const [editor, setEditor] = useState(null)

  // A task to open on arrival — set by another tab's "View" before switching
  // here (see shared/viewInTab), with a filter that brings it into the first
  // page. It opens in the editor, which shows all of it; once only. If the
  // page loads without it, it is let go — the list is still narrowed.
  const [focusTaskId, setFocusTaskId] = useTabState('tasks', 'focus', null)
  useEffect(() => {
    if (!focusTaskId || loading || !items) return
    const hit = items.find((t) => t.id === focusTaskId)
    if (hit) setEditor({ task: hit })
    setFocusTaskId(null)
  }, [focusTaskId, loading, items, setFocusTaskId])
  // Which task's deal popover is open, by id. One at a time — two open
  // popovers in a scrolling list would overlap each other.
  //
  // Declared BEFORE linkTargets, which reads it: `const` is not hoisted, so
  // the other order throws on first render.
  const [dealsFor, setDealsFor] = useState(null)
  // One anchor element per row, keyed by task id. A single useRef holding a
  // map rather than a hook per row — hooks cannot be called inside a map, and
  // the popover is portalled so it needs a real element to position against.
  const anchors = useRef({})
  // Deals and companies for the link pickers. Lazy: nothing is fetched until
  // an editor or the deals popover opens, so reading the list costs nothing
  // extra. The popover needs the same list — without it its picker opens with
  // no options and the rep has to type to add a deal already on screen.
  const linkTargets = useLinkTargets(!!editor || !!dealsFor)
  // The task queued for deletion, and any failure from trying.
  const [confirming, setConfirming] = useState(null)
  const [confirmError, setConfirmError] = useState(null)
  const [deleting, setDeleting] = useState(null)

  const removeTask = async () => {
    const t = confirming
    if (!t || deleting) return
    setDeleting(t.id)
    setConfirmError(null)
    try {
      await tasksAPI.remove(t.id)
      setConfirming(null)
      reload()
      setToast('Task deleted')
      window.setTimeout(() => setToast(null), 2200)
    } catch (err) {
      // In the dialog, which stays open, so the reason is where the click was.
      setConfirmError(err.message || 'Could not delete that task')
    } finally {
      setDeleting(null)
    }
  }

  const toggle = async (t) => {
    if (saving.has(t.id)) return          // don't race a click with itself
    const was = t.status
    const next = was === 'open'

    setSaving((s) => new Set(s).add(t.id))
    patchItem((x) => x.id === t.id, { status: next ? 'completed' : 'open' })

    try {
      const { task } = await tasksAPI.setCompleted(t.id, next)
      // Apply what the CRM echoed rather than what we assumed. If it stored
      // something different, the row should show that.
      patchItem((x) => x.id === t.id, {
        status: task?.completed === false ? 'open' : 'completed',
        completedAt: task?.completed ? (t.completedAt || new Date().toISOString()) : null
      })
      setToast(next ? 'Task completed' : 'Task reopened')
      window.setTimeout(() => setToast(null), 1600)
    } catch (err) {
      patchItem((x) => x.id === t.id, { status: was })
      setToast(err.message || 'Could not save that — try again')
      window.setTimeout(() => setToast(null), 3800)
    } finally {
      setSaving((s) => { const n = new Set(s); n.delete(t.id); return n })
    }
  }

  return (
    <Shell>
      {/* No PageHeader. It sat above the panel repeating the tab name the
          nav already shows, with a subtitle explaining what a task list is —
          and everything it used to carry (Add task, the filters, the view
          switch) now lives on the panel itself. */}
      {/* A SECTION CARD, not the shared Panel.
          The spec gives this page its own identity: a solid burnt-orange
          header carrying only the icon, title and count, with every control
          in a band beneath it. The shared Panel puts controls in the header
          and tints it rather than filling it — right for the other tabs,
          wrong here. Built directly rather than adding a fourth mode to
          Panel that only one page would use. */}
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
          background: 'var(--tasks-header)',
          borderBottom: '1px solid var(--tasks-header-border)'
        }}>
          <span className="ms" style={{ fontSize: 19, color: '#fff' }}>task_alt</span>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff' }}>Tasks</h2>
          {/* The count follows the filters, so it answers "how many am I
              looking at" rather than "how many exist". */}
          {!loading && (
            <span
              title={`${openCount} ${countNoun}`}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 24, height: 22, padding: '0 8px', flex: 'none',
                borderRadius: 'var(--radius-pill)',
                background: 'rgba(255,255,255,.22)',
                fontSize: 13, fontWeight: 600, color: '#fff',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {openCount}{hasMore ? '+' : ''}
            </span>
          )}
        </header>

        {/* The toolbar band. Darker than the list area behind the cards, so
            the controls read as chrome rather than as another card. */}
        <div className="pp-task-toolbar" style={{
          display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap',
          padding: '12px 14px',
          background: 'var(--gray-100)',
          borderBottom: '1px solid var(--border-default)'
        }}>
          <LabelledControl label="Search">
            <TaskSearch value={q} onChange={setQ} />
          </LabelledControl>

          <LabelledControl label="Status">
            <Select
              value={status} onChange={setStatus}
              options={STATUS_FILTERS.map(([value, label]) => ({ value, label }))}
              popupClassName="pp-menu" style={{ width: 150 }}
              styles={{ root: { height: 34 } }}
            />
          </LabelledControl>

          <LabelledControl label="Assignee">
            {/* `bare`: the label is stacked above by LabelledControl, so
                this must not draw its own beside the select. */}
            <OwnerFilter value={owner} onChange={setOwner} width={190} bare />
          </LabelledControl>

          <LabelledControl label="Due">
            <Select
              value={dueFilter} onChange={setDueFilter}
              options={DUE_FILTERS.map(([value, label]) => ({ value, label }))}
              popupClassName="pp-menu" style={{ width: 180 }}
              styles={{ root: { height: 34 } }}
            />
          </LabelledControl>

          {/* Only once 'Custom range' is chosen. A range picker sitting
              permanently beside a preset select reads as a second, competing
              filter — and most of the time it would be inert.

              Kept when the toolbar was rebuilt: the spec lists four Due
              presets and does not mention this, but it is existing behaviour
              a rep relies on and the presets cannot express an arbitrary
              window. */}
          {dueFilter === 'custom' && (
            <LabelledControl label="Range">
              <RangePicker
                // Same portal class as every other calendar here: antd renders
                // this to document.body, outside [data-dealhub], where none of
                // the design tokens resolve. See .pp-cal.
                popupClassName="pp-cal"
                value={dueRange ? [
                  dueRange[0] ? dayjs(dueRange[0]) : null,
                  dueRange[1] ? dayjs(dueRange[1]) : null
                ] : null}
                onChange={(range) => {
                  // Clearing keeps the filter on 'custom' with no bounds —
                  // "every dated task", which is what the picker now shows,
                  // rather than silently reverting to a preset nobody picked.
                  setDueRange(range && (range[0] || range[1])
                    ? [
                        range[0] ? range[0].format('YYYY-MM-DD') : null,
                        range[1] ? range[1].format('YYYY-MM-DD') : null
                      ]
                    : null)
                }}
                format="D MMM YYYY"
                allowEmpty={[true, true]}
                placeholder={['From', 'To']}
                style={{ width: 260 }}
                styles={{ root: { height: 34 } }}
              />
            </LabelledControl>
          )}

          {/* The SHARED control, not a second hand-rolled one: two copies
              drift in width, height and wording the first time either is
              touched. It also carries the direction toggle that only applies
              to created date. */}
          <LabelledControl label="Sort">
            <SortSelect
              value={sort} onChange={setSort}
              // The spec lists "Due date | Created". Created keeps its
              // direction here because a date sorted one way only is half a
              // control — and the existing behaviour, which reps rely on.
              // Due date has no direction: overdue first is the only order
              // a task list is read in.
              options={[
                { value: 'due', label: 'Due date' },
                { value: 'created_desc', label: 'Created, newest' },
                { value: 'created_asc', label: 'Created, oldest' }
              ]}
              width={150} bare
            />
          </LabelledControl>

          {/* ONE GROUP, pushed right. flex:none and nowrap so that when the
              band runs out of width the three drop to the next line together
              rather than Add task stranding itself. */}
          <span style={{
            marginLeft: 'auto', flex: 'none',
            display: 'inline-flex', alignItems: 'center', gap: 8, flexWrap: 'nowrap'
          }}>
            <WorkFilters filters={filters} onChange={setFilters} noun="tasks" />
            <ViewSwitch
              value={view} onChange={setView}
              options={[
                { id: 'grid', icon: 'grid_view', label: 'Grid' },
                { id: 'rows', icon: 'view_agenda', label: 'Rows' }
              ]}
            />
            <button
              onClick={() => setEditor({ task: null })}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 7,
                height: 38, padding: '0 16px', flex: 'none',
                border: 'none', borderRadius: 'var(--radius-pill)',
                background: 'var(--tasks-header)', color: '#fff',
                fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                fontWeight: 600, cursor: 'pointer'
              }}
            >
              <span className="ms" style={{ fontSize: 17 }}>add</span>Add task
            </button>
          </span>
        </div>
        <StateMessage
          loading={loading}
          error={error}
          empty={!loading && openCount === 0}
          emptyText={
            status === 'completed'
              ? (dueFilter === 'all'
                  ? 'Nothing completed yet.'
                  : 'Nothing completed matches this due filter.')
              : dueFilter === 'all'
                ? 'No open tasks — you are clear.'
                : 'Nothing matches these filters — you are clear.'
          }
          loadingText="Loading tasks…"
        />

        {/* GRID lays TaskCards out in a responsive grid; ROWS stack the
            five-column row layout.

            auto-fill with a minimum width: the column count follows the
            window rather than a breakpoint, so a wide screen shows more and a
            narrow one shows one, with no layout that fits neither.

            460px minimum: the card puts each linked record and its "View X"
            pill on one line, and the footer carries the date plus three
            controls — at 340px both wrapped. min() keeps a single column
            from overflowing a narrow window. */}
        {/* GREY BEHIND THE LIST, in both views.
            The cards were white on white, so each one's edge was carrying the
            whole job of separating it from the page. On grey they read as
            cards sitting on a surface, which is what they are.
            Rows get the same padding and gap as the grid: the only difference
            between the two views should be how many fit across. */}
        <div style={{
          background: 'var(--gray-50)',
          padding: 'var(--space-3)',
          display: view === 'grid' ? 'grid' : 'flex',
          ...(view === 'grid'
            ? { gridTemplateColumns: 'repeat(auto-fill, minmax(min(460px, 100%), 1fr))' }
            : { flexDirection: 'column' }),
          gap: 'var(--space-3)'
        }}>
        {tasks.map((t) => {
          const done = t.status !== 'open'
          // A completed task isn't overdue, whatever its due date says.
          const overdue = t.overdue && !done
          const dueToday = t.dueToday && !t.overdue && !done
          // deals[] falls back to the scalar server-side, so this counts 1
          // for an ordinary single-deal task and 0 for an unlinked one.
          const dealCount = t.deals?.length || 0

          // Rows and the grid are separate components, each built to its own
          // October 2026 design — a four-column row and a stacked card.
          // Sharing one markup tree between them meant every element carried
          // a branch for each view.
          const shared = {
            task: t,
            done,
            overdue,
            dueToday,
            busy: saving.has(t.id),
            onToggle: () => toggle(t),
            onEdit: () => setEditor({ task: t }),
            onDelete: () => { setConfirmError(null); setConfirming(t) },
            onOpenDeal,
            onOpenContact,
            onOpenBusiness
          }
          if (view === 'grid') return <TaskCard key={t.id} {...shared} />

          return (
            <TaskRow
              key={t.id}
              {...shared}
              extraDeals={dealCount > 1 ? dealCount - 1 : 0}
              dealEditor={TASK_DEAL_EDITING && (
                <span
                  ref={(el) => {
                    if (el) anchors.current[t.id] = el
                    else delete anchors.current[t.id]
                  }}
                  style={{ display: 'inline-flex' }}
                >
                  <RowAction
                    icon="sell"
                    title={
                      dealCount
                        ? `Deals on this task (${dealCount})`
                        : 'Link this task to a deal'
                    }
                    onClick={() =>
                      setDealsFor(dealsFor === t.id ? null : t.id)}
                  />
                  {dealsFor === t.id && (
                    <TaskDealsPopover
                      task={t}
                      limit={t.dealLimit || 10}
                      seed={linkTargets.deals}
                      // A getter, not the element: the ref callback above
                      // populates the map during the same commit that mounts
                      // this child, so reading it here would hand over
                      // undefined.
                      getAnchor={() => anchors.current[t.id]}
                      onApply={(patch) =>
                        patchItem((it) => it.id === t.id, patch)}
                      onClose={() => setDealsFor(null)}
                    />
                  )}
                </span>
              )}
            />
          )
        })}
        </div>

        {!loading && openCount > 0 && (
          <LoadMore
            sentinelRef={sentinelRef}
            hasMore={hasMore}
            loadingMore={loadingMore}
            count={openCount}
            noun="task"
          />
        )}
      </section>

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
          // Editing: the one contact already on the task. Creating from this
          // page there's no deal in scope to offer people from, so a create
          // needs the contact chosen elsewhere — see the empty-contacts note
          // in the editor.
          contacts={editor.task?.contact ? [editor.task.contact] : []}
          // No deal in scope on this page, so the rep picks one. Lists load on
          // the first editor open, not on page load.
          deals={linkTargets.deals}
          businesses={linkTargets.businesses}
          onClose={() => setEditor(null)}
          onSaved={(saved) => {
            if (editor.task && saved) {
              // Apply what the CRM echoed, not what we sent.
              patchItem((x) => x.id === editor.task.id, {
                title: saved.title ?? editor.task.title,
                body: saved.body ?? editor.task.body,
                dueAt: saved.dueDate ?? editor.task.dueAt,
                // Present only when the editor changed the assignee.
                ...('owner' in saved ? { owner: saved.owner, assignedTo: saved.assignedTo } : {}),
                // Present only when the editor changed the company link.
                ...('businessId' in saved ? { businessId: saved.businessId, business: saved.business } : {}),
                // And the deal link.
                ...('opportunityId' in saved
                  ? { opportunityId: saved.opportunityId, deal: saved.deal, deals: saved.deals }
                  : {})
              })
              setToast('Task saved')
            } else {
              // A new task reaches our database via the CRM's webhook, which
              // takes a moment — so it isn't in this list yet. Say so rather
              // than showing a list that looks like the save failed.
              setToast('Task created — it appears here once your CRM syncs it back')
              reload()
            }
            window.setTimeout(() => setToast(null), 4000)
          }}
        />
      )}

      {toast && <Toast tone={toastTone(toast)}>{toast}</Toast>}
    </Shell>
  )
}
// A task as plain text for the confirm dialog. The title alone is often
// "Follow Up" — identical across a dozen rows — so the due date goes in too, as
// that is what distinguishes them in the queue.
function taskPreview(task) {
  const title = (task.title || '').trim() || '(untitled task)'
  const due = formatDue(task.dueAt)
  return due ? `${title} · ${due}` : title
}

function Label({ children }) {
  return (
    <span
      style={{
        fontSize: 'var(--text-sm)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
        textTransform: 'uppercase', color: 'var(--text-muted)'
      }}
    >
      {children}
    </span>
  )
}

// A failed save and a successful one must not look identical. Derived from the
// message rather than threaded through as state — there's one toast at a time
// and its wording already carries the outcome.
function toastTone(message) {
  return /^Task (completed|reopened|saved|created|deleted)/.test(message)
    ? 'done'
    : 'error'
}

const TOAST_TONES = {
  done:  { icon: 'check_circle', colour: 'var(--status-done)' },
  error: { icon: 'error',        colour: 'var(--status-stuck)' }
}

function Toast({ children, tone = 'error' }) {
  const { icon, colour } = TOAST_TONES[tone] || TOAST_TONES.error
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
      <span className="ms" style={{ fontSize: 17, color: colour, flex: 'none' }}>
        {icon}
      </span>
      {children}
    </div>
  )
}


// A task in the GRID — the October 2026 card design.
//
//   ┌ title ─────────────────────── [No DEAL] ┐   header: what to do, and
//   │ description                              │   whether a deal is missing
//   │ 👤 contact                 [View CONTACT] │   linked records — only the
//   │ 🏷 deal                    [View DEAL]    │   ones the task HAS
//   │ 🏢 business               [View BUSINESS] │
//   └ 📅 DUE 18 Sep (overdue)    ✓ ✎ ✕ ─────────┘   footer: when, and act on it
//
// A missing deal is the one absence the header calls out: a task off any deal
// is the state a rep needs to spot. A missing contact or business simply has
// no row — three "No X" lines on an unattached task were most of its card.
function TaskCard({
  task: t, done, overdue, dueToday, busy,
  onToggle, onEdit, onDelete,
  onOpenDeal, onOpenContact, onOpenBusiness
}) {
  const hasChips = t.noteChips?.length > 0
  const due = dueLine(t, done, overdue, dueToday)

  return (
    <div style={{
      display: 'flex', flexDirection: 'column',
      // A CARD IN BOTH VIEWS — the same border, radius and surface as a row.
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface-card)',
      boxShadow: 'var(--shadow-card)',
      overflow: 'hidden',
      opacity: done ? 0.6 : 1
    }}>
      {/* HEADER — the title, and the No DEAL pill when there is no deal. */}
      <div style={{
        display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
        padding: '16px 20px 14px',
        borderBottom: '1px solid var(--border-default)'
      }}>
        <button
          onClick={() => t.deal && onOpenDeal && onOpenDeal(t.deal.id)}
          title={t.deal ? 'Open this task on the deal hub' : undefined}
          style={{
            flex: 1, minWidth: 0,
            border: 'none', background: 'none', padding: 0,
            textAlign: 'left',
            cursor: t.deal ? 'pointer' : 'default',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-xl)', fontWeight: 600,
            lineHeight: 1.3, letterSpacing: '-0.01em',
            color: 'var(--text-heading)',
            textDecoration: done ? 'line-through' : 'none',
            // A raw record id as a title is one unbroken word — wrap it rather
            // than let it push the pill out of the card.
            overflowWrap: 'anywhere'
          }}
        >
          {t.title || '(untitled task)'}
        </button>
        {!t.deal && (
          <span style={{ flex: 'none', marginTop: 1 }}>
            <DealPill name="No deal" empty />
          </span>
        )}
      </div>

      {/* BODY — two reserved lines, so every card in a grid row starts its
          linked records at the same depth whether or not it has a
          description. */}
      <div style={{
        padding: '14px 20px',
        borderBottom: '1px solid var(--border-default)'
      }}>
        <div style={{
          display: '-webkit-box',
          WebkitLineClamp: 2,
          WebkitBoxOrient: 'vertical',
          overflow: 'hidden',
          minHeight: 'calc(var(--text-lg) * 1.5 * 2)'
        }}>
          {t.body ? (
            <RichBody
              html={t.body}
              size="var(--text-lg)"
              color="var(--text-body)"
              showPlainToggle={false}
            />
          ) : (
            <span style={{ fontSize: 'var(--text-lg)', color: 'var(--text-faint)' }}>
              No description
            </span>
          )}
        </div>
        {/* Opens the EDITOR, which already shows the whole description — a
            read-only modal here would be a second surface for the same text. */}
        {htmlToText(t.body || '').length > 90 && (
          <button
            onClick={onEdit}
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
      {/* Every section pads 20px at the sides, so left edges line up down
          the card. */}
      <div style={{ flex: 1, padding: '0 20px', display: 'flex', flexDirection: 'column' }}>
        <LinkedRecords
          record={t}
          large
          onOpenDeal={onOpenDeal}
          onOpenContact={onOpenContact}
          onOpenBusiness={onOpenBusiness}
        />

        {hasChips && (
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, padding: '4px 0 12px' }}>
            {t.noteChips.map((c) => (
              <NoteChip key={c.id} label={c.label} />
            ))}
          </div>
        )}
      </div>

      {/* FOOTER — due date left; mark complete, edit and delete right. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-3)',
        flexWrap: 'wrap',
        padding: '12px 20px',
        borderTop: '1px solid var(--border-default)'
      }}>
        <span style={{
          display: 'inline-flex', alignItems: 'center', gap: 8,
          minWidth: 0, color: due.colour
        }}>
          <span className="ms" style={{ fontSize: 18, flex: 'none' }}>
            {done ? 'event_available' : 'calendar_today'}
          </span>
          <span style={{
            fontSize: 11, fontWeight: 700, letterSpacing: '.06em',
            textTransform: 'uppercase', color: 'var(--text-muted)'
          }}>
            {due.label}
          </span>
          <span style={{
            fontSize: 'var(--text-lg)',
            fontWeight: overdue ? 600 : 500,
            whiteSpace: 'nowrap'
          }}>
            {due.text}
          </span>
        </span>

        <span style={{
          marginLeft: 'auto', flex: 'none',
          display: 'inline-flex', alignItems: 'center', gap: 8
        }}>
          <CompleteToggle
            done={done}
            busy={busy}
            label={t.title || 'task'}
            onToggle={onToggle}
            stacked
          />
          <RowAction icon="edit" title="Edit this task" onClick={onEdit} />
          <RowAction icon="close" danger title="Delete this task" onClick={onDelete} />
        </span>
      </div>
    </div>
  )
}

// A task in ROWS — the October 2026 row design. Four columns, ruled apart:
//
//   ○ │ 👤 contact  [View CONTACT] │ 📅 DUE DATE      │ title          │
//     │ 🏷 deal     [View DEAL]    │ 18 Sep (overdue) │ description    │
//     │ 🏢 business [View BUSINESS]│ [No DEAL]        │          ✎  ✕  │
//
// Done · who it is about · when (and whether a deal is missing) · what to do.
// The columns are fixed widths up to the title, so every row's tick, View
// pills and date land on the same x down the whole list.
//
// `extraDeals` is the +N for a task on several deals; `dealEditor` is the
// switched-off deal-linking control (TASK_DEAL_EDITING), handed in whole
// because it needs the tab's popover state.
function TaskRow({
  task: t, done, overdue, dueToday, busy,
  onToggle, onEdit, onDelete,
  onOpenDeal, onOpenContact, onOpenBusiness,
  extraDeals = 0, dealEditor
}) {
  const hasChips = t.noteChips?.length > 0
  const due = dueLine(t, done, overdue, dueToday)
  const rule = '1px solid var(--border-default)'

  return (
    <div
      style={{
        display: 'grid',
        // tick · records · due · title+body+actions.
        //
        // NO `order` ANYWHERE. The children are written in the order they
        // appear. An earlier version moved them with `order` and shipped
        // broken, because the due date was NESTED inside the title column —
        // `order` sorts siblings, so it never became a column at all.
        gridTemplateColumns: '56px minmax(280px, 400px) minmax(150px, auto) minmax(0, 1fr)',
        // Stretch, so each column's divider runs the full row height.
        alignItems: 'stretch',
        // A CARD IN BOTH VIEWS — the same border, radius and surface as
        // TaskCard; the grey list ground separates rows, not divider rules.
        border: rule,
        borderRadius: 'var(--radius-md)',
        background: 'var(--surface-card)',
        overflow: 'hidden',
        opacity: done ? 0.6 : 1,
        transition: 'background 120ms ease'
      }}
      onMouseEnter={(e) => { e.currentTarget.style.background = 'var(--surface-sunken)' }}
      // Back to the CARD surface, not transparent — transparent let the grey
      // list ground show through once the pointer left.
      onMouseLeave={(e) => { e.currentTarget.style.background = 'var(--surface-card)' }}
    >
      {/* 1 · DONE — the tick, centred in its own ruled column. */}
      <div style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        borderRight: rule
      }}>
        <CompleteToggle
          done={done}
          busy={busy}
          label={t.title || 'task'}
          onToggle={onToggle}
          compact
        />
      </div>

      {/* 2 · WHO — only the records the task has. */}
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        minWidth: 0, padding: '4px 16px',
        borderRight: rule
      }}>
        <LinkedRecords
          record={t}
          onOpenDeal={onOpenDeal}
          onOpenContact={onOpenContact}
          onOpenBusiness={onOpenBusiness}
        />
        {(extraDeals > 0 || dealEditor) && (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, paddingBottom: 6 }}>
            {extraDeals > 0 && (
              <span
                title={`Linked to ${extraDeals + 1} deals`}
                style={{
                  fontSize: 11, fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  color: 'var(--text-muted)'
                }}
              >
                +{extraDeals} more {extraDeals === 1 ? 'deal' : 'deals'}
              </span>
            )}
            {dealEditor}
          </span>
        )}
      </div>

      {/* 3 · WHEN — "DUE DATE" over the date, and the No DEAL pill beneath
          when the task is off any deal. LABELLED: a bare "14 Oct" could be
          when the task was made. */}
      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center',
        alignItems: 'flex-start', gap: 4,
        padding: '12px 14px',
        borderRight: rule
      }}>
        {/* Only the ICON and the DATE carry overdue red, as the design draws
            it — the "DUE DATE" label stays grey on every row, so the one red
            word on a row is the date that is late. */}
        <span style={{ display: 'flex', alignItems: 'center', gap: 5 }}>
          <span className="ms" style={{
            fontSize: 15,
            color: overdue ? 'var(--status-stuck)' : 'var(--text-heading)'
          }}>
            {done ? 'event_available' : 'calendar_today'}
          </span>
          <span className="pp-label" style={{ marginBottom: 0, color: 'var(--text-muted)' }}>
            {done ? 'Done' : 'Due date'}
          </span>
        </span>
        <span style={{
          fontSize: 'var(--text-lg)',
          fontWeight: overdue ? 600 : 500,
          color: due.colour,
          whiteSpace: 'nowrap'
        }}>
          {due.text}
        </span>
        {!t.deal && <DealPill name="No deal" empty compact />}
      </div>

      {/* 4 · WHAT — title and description, with edit and delete in the
          bottom-right corner. */}
      <div style={{
        display: 'flex', alignItems: 'flex-end', gap: 'var(--space-3)',
        minWidth: 0, padding: '14px 16px'
      }}>
        <div style={{ flex: 1, minWidth: 0, alignSelf: 'center' }}>
          <button
            onClick={() => t.deal && onOpenDeal && onOpenDeal(t.deal.id)}
            title={t.deal ? 'Open this task on the deal hub' : undefined}
            style={{
              border: 'none', background: 'none', padding: 0,
              textAlign: 'left',
              cursor: t.deal ? 'pointer' : 'default',
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-lg)', fontWeight: 600,
              lineHeight: 1.3,
              color: 'var(--text-heading)',
              textDecoration: done ? 'line-through' : 'none',
              // A raw record id as a title is one unbroken word — wrap it
              // rather than let it set the row's width.
              maxWidth: '100%',
              overflowWrap: 'anywhere'
            }}
          >
            {t.title || '(untitled task)'}
          </button>
          {t.body && (
            <div style={{ marginTop: 6 }}>
              <RichBody
                html={t.body}
                size="var(--text-md)"
                color="var(--text-muted)"
                maxWidth={680}
                showPlainToggle
              />
            </div>
          )}
          {hasChips && (
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 5, marginTop: 8 }}>
              {t.noteChips.map((c) => (
                <NoteChip key={c.id} label={c.label} />
              ))}
            </div>
          )}
        </div>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
          <RowAction icon="edit" title="Edit this task" onClick={onEdit} />
          <RowAction icon="close" danger title="Delete this task" onClick={onDelete} />
        </span>
      </div>
    </div>
  )
}

// The due date as both views show it: "18 Sep (overdue)", "30 Sep",
// "2 days ago" once done. The year only appears when it is not this year — a
// task list is almost all this year, and "2026" on every item is noise.
//
// RED FOR OVERDUE ONLY; every other open date is black, as the design has it.
// Today's tasks say "(today)" rather than taking a colour of their own, so
// the list has one alarm colour and it means late.
function dueLine(t, done, overdue, dueToday) {
  if (done) {
    return {
      label: 'Done',
      text: t.completedAt ? relativeTime(t.completedAt) : 'Completed',
      colour: 'var(--accent-pine-text)'
    }
  }
  if (!t.dueAt) {
    return { label: 'Due', text: 'No due date', colour: 'var(--text-faint)' }
  }
  const sameYear = new Date(t.dueAt).getFullYear() === new Date().getFullYear()
  const date = formatDate(t.dueAt, !sameYear) || 'No due date'
  if (overdue) {
    return { label: 'Due', text: `${date} (overdue)`, colour: 'var(--status-stuck-text)' }
  }
  if (dueToday) {
    return { label: 'Due', text: `${date} (today)`, colour: 'var(--text-heading)' }
  }
  return { label: 'Due', text: date, colour: 'var(--text-heading)' }
}

// Mark complete / mark open — a tick in a circle: outlined while the task is
// open, filled green once done, so the state reads from the glyph alone.
//
// Two forms, one per view:
//   `compact` — ROWS: the bare glyph, centred in the row's leading column.
//   `stacked` — the CARD footer: a small two-line "MARK / COMPLETE" caption
//               beside the glyph. Caption and circle are ONE button, so the
//               words are part of the hit area rather than a label a rep
//               clicks expecting something to happen.
function CompleteToggle({ done, busy, label, onToggle, compact = false, stacked = false }) {
  return (
    <button
      onClick={(e) => { e.stopPropagation(); onToggle() }}
      disabled={busy}
      title={done ? 'Mark this task open again' : 'Mark this task complete'}
      aria-label={`Mark ${label} ${done ? 'open' : 'complete'}`}
      aria-pressed={done}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none',
        border: 'none', background: 'none', padding: compact ? 4 : '2px 0',
        borderRadius: 'var(--radius-pill)',
        fontFamily: 'var(--font-sans)',
        color: done ? 'var(--green-600)' : 'var(--text-muted)',
        cursor: busy ? 'progress' : 'pointer'
      }}
    >
      {stacked && (
        <span style={{
          fontSize: 10, fontWeight: 700, lineHeight: 1.15,
          letterSpacing: '.06em', textTransform: 'uppercase', textAlign: 'right'
        }}>
          {done ? <>Mark<br />open</> : <>Mark<br />complete</>}
        </span>
      )}
      <span
        className={done ? 'ms ms-fill' : 'ms'}
        style={{
          fontSize: compact ? 28 : 30,
          color: done ? 'var(--green-500)' : 'var(--text-muted)'
        }}
      >
        check_circle
      </span>
    </button>
  )
}
