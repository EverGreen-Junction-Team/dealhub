import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Select } from 'antd'
import ViewSwitch from '../shared/ViewSwitch'
import ContactTable, { CONTACT_COLUMNS } from '../contacts/ContactTable'
import ContactFilters, { activityParams, contactFilterLabels } from '../contacts/ContactFilters'
import DealToolbar from '../deals/DealToolbar'
import ConfirmDialog from '../shared/ConfirmDialog'
import { savedViewsAPI, dealsAPI } from '../../api/deals'
import { DealPill, LabelledControl, CardGridSkeleton, LoadMore, formatDue, relativeTime } from '../shared/ListChrome'
import { LinkedRow, LINK_TONES } from '../shared/LinkedRecords'
import { contactsAPI } from '../../api/contacts'
import BusinessPickerModal from '../shared/BusinessPickerModal'
import { usePagedList, useInfiniteScroll } from '../../hooks/usePagedList'
import { useTabState } from '../../hooks/useTabState'
import { viewNoteInTab, viewTaskInTab } from '../shared/viewInTab'
import { useAuth } from '../../context/AuthContext'
import { OwnerFilter, TagFilter } from '../shared/ListFilters'
import ContactDetail from '../contacts/ContactDetail'
import ContactCreatePanel from '../contacts/ContactCreatePanel'


// Contacts tab — every contact in this location.
//
// October 2026: a blue section header over a labelled toolbar band, as on
// Tasks and Notes, and a card per contact whose fields read as a ruled table
// with the contact's deals and business listed beneath.
export default function ContactsTab({
  onOpenDeal, onOpenBusiness, openContactId, onContactViewed,
  // Opening a card is navigation the shell never sees — it happens entirely
  // inside this tab. Report it so the Back button has a step to return to,
  // and so pressing Back doesn't restore a record the user has already left.
  onNavigate,
  // Switch to another tab — the contact record's "All tasks →" / "All notes →".
  onOpenTab
}) {
  // Which contact's record is open. Null = the grid. Local navigation within
  // this tab, except when another tab hands us a contact to open (a contact
  // chip on a task or note) — openContactId is that entry point.
  //
  // PLAIN STATE, not useTabState. It was persisted in the tab store, which
  // survives unmount — so leaving Contacts and coming back reopened whichever
  // record was last viewed, and the rep had to press Back to reach the list
  // they asked for. The search text and scroll position below DO persist;
  // those are where a rep was, while an open record is where they went.
  const [openId, setOpenId] = useState(null)

  useEffect(() => {
    if (openContactId) setOpenId(openContactId)
  }, [openContactId, setOpenId])
  const [q, setQ] = useTabState('contacts', 'q', '')
  // Server-side search: 19 contacts fits in one page today, but Crittall has
  // thousands — filtering the loaded page would quietly miss most of them.
  const [search, setSearch] = useTabState('contacts', 'search', '')

  // Cards or table. Persisted in localStorage: a display preference that
  // should outlive the session.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('pp.contacts.view') || 'cards' } catch { return 'cards' }
  })
  useEffect(() => {
    try { localStorage.setItem('pp.contacts.view', view) } catch { /* private mode */ }
  }, [view])

  // Filters and saved views — the same machinery the deals tab uses, so a
  // saved contacts view is stored, listed and applied by the same endpoints.
  // useTabState, not plain state: these are WHERE THE REP WAS, and stepping
  // into a contact record and back should not discard them.
  const [filters, setFilters] = useTabState('contacts', 'filters', {})
  const [views, setViews] = useTabState('contacts', 'views', [])
  const [activeViewId, setActiveViewId] = useTabState('contacts', 'activeViewId', null)
  const [dirtyView, setDirtyView] = useTabState('contacts', 'dirtyView', null)
  const [viewError, setViewError] = useState(null)
  // The saved view awaiting a delete confirmation, or null.
  const [confirmingView, setConfirmingView] = useState(null)
  // Which linked records the cards list — see ShowOnCards. Persisted with
  // the rest of the tab's state.
  const [showOn, setShowOn] = useTabState('contacts', 'showOn', { deals: true })
  // Selected contact ids, for bulk actions. Plain state: a selection is a
  // moment's work, not somewhere to come back to. No bulk action exists yet —
  // see PENDING_FUNCTIONALITY.md — so selecting only counts for now.
  const [selected, setSelected] = useState(() => new Set())
  const toggleSelected = (id) => setSelected((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id); else next.add(id)
    return next
  })
  // A passing message under the toolbar — Add contact's "not yet".
  const [notice, setNotice] = useState(null)
  // The list's visible columns, by key — see CONTACT_COLUMNS. Starts with all.
  const [columns, setColumns] = useTabState(
    'contacts', 'columns', CONTACT_COLUMNS.map((c) => c.key)
  )
  const [tagList, setTagList] = useState([])
  const [userList, setUserList] = useState([])

  useEffect(() => {
    let alive = true
    savedViewsAPI.list('contacts')
      .then((r) => { if (alive) setViews(r?.views || []) })
      // A failed fetch leaves the strip empty, which is still a working page.
      .catch(() => {})
    contactsAPI.tagCatalogue()
      .then((r) => { if (alive) setTagList((r?.tags || []).map((t) => t.name || t)) })
      .catch(() => {})
    dealsAPI.users()
      .then((r) => { if (alive) setUserList(r?.users || []) })
      // Same as above: no owner dropdown is better than a broken page.
      .catch(() => {})
    return () => { alive = false }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Owner defaults to the signed-in user, and a change sticks: `filters` is
  // useTabState, so switching to All owners survives a tab switch and a reload
  // rather than snapping back to Mine on every visit.
  //
  // Seeded once, and only when nothing has been chosen yet — re-applying the
  // default on later renders would undo the rep's own choice, and re-applying
  // it after they picked "All owners" would look like the control was broken.
  const { session } = useAuth()
  const ownerSeeded = useRef(false)
  useEffect(() => {
    if (ownerSeeded.current) return
    if (!session?.user?.id) return
    ownerSeeded.current = true
    if (filters.assignedTo === undefined) {
      setFilters({ ...filters, assignedTo: session.user.id })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [session])

  const fetchPage = useCallback(
    ({ cursor }) => contactsAPI.list({
      limit: 20, cursor, q: search || undefined,
      // `view` is the display mode, not a filter — stripped when a saved view
      // is applied, so it never reaches the query.
      contactType: filters.contactType || undefined,
      assignedTo: filters.assignedTo || undefined,
      tag: filters.tag || undefined,
      minValue: filters.minValue || undefined,
      maxValue: filters.maxValue || undefined,
      hasDeals: filters.hasDeals || undefined,
      // One UI control, two server parameters — see activityParams.
      ...activityParams(filters.activity)
    }),
    [search, filters]
  )
  const { items, error, hasMore, total, loadingMore, loading, loadMore, patchItem, reload } =
    usePagedList({ fetchPage, key: 'contacts', deps: [search, filters] })
  // The Add-contact form, over the list.
  const [creating, setCreating] = useState(false)
  const sentinelRef = useInfiniteScroll(loadMore, { enabled: hasMore && !loadingMore })

  // Saved-view actions. DECLARED HERE, below the state they close over —
  // `const` is not hoisted, and a callback reading `filters` or `search` from
  // above throws on first render.
  const applyView = useCallback((id) => {
    setActiveViewId(id)
    setDirtyView(null)
    const v = views.find((x) => x.id === id)
    const f = { ...(v?.filters || {}) }
    // `view` is NOT restored — it is the layout (cards / table), not a filter,
    // and forcing it threw a rep out of the view they were working in. Old
    // views still carry the key, so it is deleted rather than trusted.
    delete f.view
    setFilters(f)
    if (f.q !== undefined) { setQ(f.q || ''); setSearch(f.q || '') }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [views])

  const saveView = useCallback(async (name) => {
    try {
      const r = await savedViewsAPI.save({
        scope: 'contacts',
        name,
        // No `view`: a saved view is a set of FILTERS. The layout is a
        // per-rep preference that outlives any one view — see applyView.
        filters: { ...filters, ...(search ? { q: search } : {}) }
      })
      // Replace by id so re-saving a name updates its tab rather than adding
      // a second one — the server upserts, and the list must agree.
      setViews((prev) => [...prev.filter((v) => v.id !== r.view.id), r.view])
      setActiveViewId(r.view.id)
      setDirtyView(null)
    } catch (e) {
      setViewError(e.message || 'That view could not be saved')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filters, search])

  const deleteView = useCallback(async (id) => {
    try {
      await savedViewsAPI.remove(id)
      setViews((prev) => prev.filter((v) => v.id !== id))
      if (activeViewId === id) { setActiveViewId(null); setFilters({}) }
    } catch (e) {
      setViewError(e.message || 'That view could not be deleted')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeViewId])

  const contacts = items || []
  const activeView = views.find((v) => v.id === activeViewId) || null

  // One toolbar filter changed — empty clears it — and any applied saved view
  // is marked edited, so "Update <view>" can offer to keep the change.
  const setFilter = (key, value) => {
    setFilters({ ...filters, [key]: value || undefined })
    setDirtyView(activeViewId)
  }

  const openRecord = (id) => {
    setOpenId(id)
    if (onNavigate) onNavigate({ contactId: id })
  }

  if (openId) {
    return (
      <ContactDetail
        contactId={openId}
        onBack={() => {
          setOpenId(null)
          // Clear the shell's request too, or coming back to this tab would
          // reopen the same record.
          if (onContactViewed) onContactViewed()
          // Tell the shell we're back on the list, so its Back button doesn't
          // reopen the record we just closed.
          if (onNavigate) onNavigate({ contactId: null })
        }}
        onOpenDeal={onOpenDeal}
        onOpenTab={onOpenTab}
      />
    )
  }

  return (
    <div
      style={{
        maxWidth: 1660, width: '100%', boxSizing: 'border-box',
        margin: '0 auto', padding: 'var(--space-4) 20px 28px'
      }}
    >
      {/* A SECTION CARD with a solid blue header and a toolbar band beneath
          it — the same build as the Tasks and Notes tabs, in the Contacts
          colour. */}
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
          background: 'var(--contacts-header)',
          borderBottom: '1px solid var(--contacts-header-border)'
        }}>
          <span className="ms" style={{ fontSize: 19, color: '#fff' }}>group</span>
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 600, color: '#fff' }}>Contacts</h2>
          {/* The server's total for the CURRENT filter, not the loaded row
              count — "20+" then "25" as you scrolled answered no question a
              rep actually has. */}
          {!loading && (
            <span
              title={total != null ? `${total} contacts match these filters` : undefined}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                minWidth: 24, height: 22, padding: '0 8px', flex: 'none',
                borderRadius: 'var(--radius-pill)',
                background: 'rgba(255,255,255,.22)',
                fontSize: 13, fontWeight: 600, color: '#fff',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {total ?? contacts.length}
            </span>
          )}
        </header>

        {/* The toolbar band, two rows.
            Row 1 — the labelled controls a rep changes constantly, with the
            display switch at the right.
            Row 2 — the occasional ones: the Filters drawer, the chips it
            produces, Save view, and what the cards show. */}
        <div className="pp-task-toolbar" style={{
          display: 'grid', gap: 12,
          padding: '12px 14px',
          background: 'var(--gray-100)',
          borderBottom: '1px solid var(--border-default)'
        }}>
          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
            <LabelledControl label="Search">
              <ContactSearch
                value={q}
                onChange={setQ}
                // Server-side, on Enter or blur — not per keystroke. Crittall
                // has thousands of contacts and the list is paged.
                onCommit={() => setSearch(q.trim())}
              />
            </LabelledControl>

            <LabelledControl label="Owner">
              <OwnerFilter
                value={filters.assignedTo ?? ''}
                onChange={(v) => setFilter('assignedTo', v)}
                bare
              />
            </LabelledControl>

            <LabelledControl label="Type">
              <Select
                value={filters.contactType || ''}
                onChange={(v) => setFilter('contactType', v)}
                options={[{ value: '', label: 'All' }, ...CONTACT_TYPES]}
                popupClassName="pp-menu"
                style={{ width: 140 }}
                styles={{ root: { height: 34 } }}
              />
            </LabelledControl>

            {/* Only when the account HAS tags — an empty dropdown invites a
                rep to open it and wonder what broke. */}
            {tagList.length > 0 && (
              <LabelledControl label="Tag">
                <TagFilter
                  value={filters.tag || ''}
                  onChange={(v) => setFilter('tag', v)}
                  bare
                />
              </LabelledControl>
            )}

            <LabelledControl label="Saved view">
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <Select
                  value={activeViewId || ''}
                  onChange={(id) => applyView(id || null)}
                  options={[
                    { value: '', label: 'All contacts' },
                    ...views.map((v) => ({ value: v.id, label: v.name }))
                  ]}
                  popupClassName="pp-menu"
                  style={{ width: 170 }}
                  styles={{ root: { height: 34 } }}
                  popupMatchSelectWidth={240}
                />
                {/* Deleting lives beside the picker, and only for your own
                    views — a shared one belongs to whoever made it. */}
                {activeView?.isMine && (
                  <button
                    onClick={() => setConfirmingView(activeView)}
                    title={`Delete "${activeView.name}"`}
                    aria-label={`Delete the saved view ${activeView.name}`}
                    style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 34, height: 34, flex: 'none',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 'var(--radius-md)',
                      background: 'var(--surface-card)', color: 'var(--status-stuck)',
                      cursor: 'pointer'
                    }}
                  >
                    <span className="ms" style={{ fontSize: 16 }}>delete</span>
                  </button>
                )}
              </span>
            </LabelledControl>

            <span style={{
              marginLeft: 'auto', flex: 'none',
              display: 'inline-flex', alignItems: 'center', gap: 8
            }}>
              <ViewSwitch
                value={view}
                onChange={setView}
                options={[
                  { id: 'cards', icon: 'grid_view', label: 'Grid' },
                  { id: 'table', icon: 'view_agenda', label: 'List' }
                ]}
              />
              {/* Opens the create form. The route lands the new row locally
                  before answering, so a reload shows it at once. */}
              <button
                onClick={() => setCreating(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 7,
                  height: 38, padding: '0 16px', flex: 'none',
                  border: 'none', borderRadius: 'var(--radius-pill)',
                  background: 'var(--contacts-header)', color: '#fff',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                  fontWeight: 600, cursor: 'pointer'
                }}
              >
                <span className="ms" style={{ fontSize: 17 }}>add</span>Add contact
              </button>
            </span>
          </div>

          <DealToolbar
            bare
            countLabel="contacts"
            views={views}
            // The Saved view dropdown above lists them; tabs here would show
            // the same views twice.
            showViewTabs={false}
            activeViewId={activeViewId}
            onSelectView={applyView}
            onSaveView={saveView}
            onDeleteView={deleteView}
            dirtyViewId={dirtyView}
            onUpdateView={(id) => {
              const v = views.find((x) => x.id === id)
              if (v) saveView(v.name)
            }}
            filters={filters}
            // Chips read as sentences, not raw values — "Quiet for 30+ days"
            // rather than "Activity quiet:30".
            filterLabels={contactFilterLabels(filters, userList)}
            onClearFilter={(k) => {
              setFilters((f) => { const next = { ...f }; delete next[k]; return next })
              setDirtyView(activeViewId)
            }}
            onClearAll={() => { setFilters({}); setActiveViewId(null); setDirtyView(null) }}
            filterControl={
              <ContactFilters
                filters={filters}
                tags={tagList}
                users={userList}
                onChange={(next) => { setFilters(next); setDirtyView(activeViewId) }}
              />
            }
            afterViews={view === 'cards' && (
              <ShowOnCards value={showOn} onChange={setShowOn} />
            )}
          >
            {view === 'table' && (
              <ColumnsControl value={columns} onChange={setColumns} />
            )}
          </DealToolbar>
          {viewError && (
            <p style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--status-stuck-text)' }}>
              {viewError}
            </p>
          )}
          {notice && (
            <p role="status" style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
              {notice}
            </p>
          )}
        </div>

        <div style={{ background: 'var(--gray-50)', padding: 'var(--space-3)' }}>
          {error && (
            <div
              style={{
                padding: 16, marginBottom: 14,
                border: '1px solid var(--status-stuck)',
                borderRadius: 'var(--radius-md)',
                background: 'var(--tint-rose)', color: 'var(--status-stuck)', fontSize: 'var(--text-md)'
              }}
            >
              {error}
            </div>
          )}

          {/* Card-shaped, so the layout doesn't jump when the real contacts
              land. minWidth matches the real grid's track. */}
          {loading && <CardGridSkeleton cards={6} minWidth={430} />}

          {!loading && contacts.length === 0 && !error && (
            <div style={{ padding: 24, color: 'var(--text-muted)', fontSize: 'var(--text-md)' }}>
              {/* Names what a rep can actually change — the search and the
                  filters — rather than claiming an account with thousands of
                  contacts is empty because an owner filter matched nothing. */}
              {search || Object.keys(filters).length > 0
                ? `No contacts match ${
                    [search && 'the search',
                     Object.keys(filters).length > 0 && 'the filters']
                      .filter(Boolean).join(' and ')
                  } — clear ${Object.keys(filters).length > 0 ? 'them' : 'it'} to see everything.`
                : 'No contacts in this sub-account yet.'}
            </div>
          )}

          {/* BULK ACTIONS — only while something is selected, above the list
              in either view. */}
          {selected.size > 0 && (
            <BulkBar
              selected={contacts.filter((c) => selected.has(c.id))}
              count={selected.size}
              tagList={tagList}
              onClear={() => setSelected(new Set())}
              onNotice={(msg) => {
                setNotice(msg)
                window.setTimeout(() => setNotice(null), 5000)
              }}
              onPatch={(id, p) => patchItem((x) => x.id === id, p)}
              // After a bulk delete the rows are gone server-side; the paged
              // list has no remove, so it reloads from the top.
              onReload={reload}
            />
          )}

          {/* LIST — the same paged `contacts`, as a table. */}
          {view === 'table' && contacts.length > 0 && (
            <ContactTable
              contacts={contacts}
              columns={columns}
              tagList={tagList}
              onOpen={openRecord}
              onOpenDeal={onOpenDeal}
              onOpenBusiness={onOpenBusiness}
              // "View" on a task or note: Tasks / Notes, narrowed to this
              // contact, with the item open — see shared/viewInTab.
              onViewNote={onOpenTab ? (contactId, note) => viewNoteInTab(onOpenTab, { contactId }, note.id) : undefined}
              onViewTask={onOpenTab ? (contactId, task) => viewTaskInTab(onOpenTab, { contactId }, task.id) : undefined}
              // Cells write straight to the CRM; the row is patched with the
              // result rather than refetched.
              onPatch={(id, p) => patchItem((x) => x.id === id, p)}
              selected={selected}
              onToggleSelected={toggleSelected}
              // Select-all covers the rows LOADED — the list is paged, and
              // ticking contacts nobody has seen would be a surprise.
              onToggleAll={(on) => setSelected(on ? new Set(contacts.map((c) => c.id)) : new Set())}
            />
          )}

          <div
            style={view === 'table' ? { display: 'none' } : {
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fill, minmax(min(430px, 100%), 1fr))',
              gap: 'var(--space-3)'
            }}
          >
            {contacts.map((c) => (
              <ContactCard
                key={c.id}
                c={c}
                showOn={showOn}
                selected={selected.has(c.id)}
                onToggleSelected={() => toggleSelected(c.id)}
                tagList={tagList}
                onOpen={() => openRecord(c.id)}
                onOpenDeal={onOpenDeal}
                onOpenBusiness={onOpenBusiness}
                // Link/unlink and tags write immediately — there is no Save
                // on them, the way there is for the text fields — so the row
                // is patched here rather than on the card's own save.
                onBusinessChanged={(id, link) => {
                  patchItem((x) => x.id === id, {
                    businessId: link.businessId ?? null,
                    businessName: link.businessName ?? null
                  })
                }}
                onTagsChanged={(id, tags) => patchItem((x) => x.id === id, { tags })}
                onSaved={(id, saved) => {
                  // Apply what the CRM echoed rather than what was typed, so a
                  // reformatted phone or trimmed name shows the stored value.
                  if (!saved) return
                  patchItem((x) => x.id === id, {
                    firstName: saved.firstName ?? null,
                    lastName: saved.lastName ?? null,
                    email: saved.email ?? null,
                    phone: saved.phone ?? null,
                    business: saved.companyName ?? saved.business ?? null,
                    address: saved.address1 ?? saved.address ?? null
                  })
                }}
              />
            ))}
          </div>

          {!loading && contacts.length > 0 && (
            <LoadMore
              sentinelRef={sentinelRef}
              hasMore={hasMore}
              loadingMore={loadingMore}
              count={contacts.length}
              total={total}
              noun="contact"
            />
          )}
        </div>
      </section>

      {creating && (
        <ContactCreatePanel
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false)
            reload()
            setNotice(c ? `Added ${[c.firstName, c.lastName].filter(Boolean).join(' ') || c.email || c.phone || 'the contact'}.` : 'Contact added.')
            window.setTimeout(() => setNotice(null), 5000)
          }}
        />
      )}

      {/* Deleting a saved view cannot be undone. */}
      {confirmingView && (
        <ConfirmDialog
          title="Delete this view?"
          message="This cannot be undone. The contacts it filtered are not affected."
          preview={confirmingView.name}
          confirmLabel="Delete view"
          onConfirm={() => {
            deleteView(confirmingView.id)
            setConfirmingView(null)
          }}
          onCancel={() => setConfirmingView(null)}
        />
      )}
    </div>
  )
}

// The contact types a card can show and the toolbar can filter by. Contact
// type is a GHL custom field, so these are the values that field holds.
const CONTACT_TYPES = [
  { value: 'lead', label: 'Lead' },
  { value: 'customer', label: 'Customer' }
]

// The search box, with its icon inside and a clear button once typed in.
function ContactSearch({ value, onChange, onCommit }) {
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
        onKeyDown={(e) => { if (e.key === 'Enter') onCommit() }}
        onBlur={onCommit}
        placeholder="Search name, email, phone or business"
        style={{
          width: 320, maxWidth: '100%',
          height: 34, boxSizing: 'border-box', padding: '0 12px 0 34px',
          border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-md)',
          background: '#fff', fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-md)', color: 'var(--text-heading)'
        }}
      />
    </span>
  )
}

// "SHOW ON CARDS" — which linked records each card lists.
//
// Tasks and Notes show a COUNT row ("3 open tasks · View TASK") that opens
// the contact, not the items themselves: the contacts list returns only the
// counts. See PENDING_FUNCTIONALITY.md.
const SHOW_ON_CARDS = [
  { key: 'deals', label: 'Deals', colour: 'var(--green-500)', tint: 'var(--tint-pine)' },
  { key: 'tasks', label: 'Tasks', colour: 'var(--accent-clay)', tint: 'var(--tint-clay)' },
  { key: 'notes', label: 'Notes', colour: 'var(--accent-brown)', tint: 'var(--tint-gold)' }
]

// The bulk action bar — "1 selected | Add tag · Assign owner · Delete |
// Clear".
//
// Change type and Export were REMOVED (Oct 2026, at the client's request).
// The October design drew both; Change type had no confirmed write path for
// contact type, and Export's CSV download depended on the GHL iframe
// allowing downloads.
//
// `selected` is the selected contacts that are LOADED; `count` is every id
// selected. They differ only if a selection outlives a filter change.
function BulkBar({ selected, count, tagList, onClear, onNotice, onPatch, onReload }) {
  // The two pickers and the delete confirm. One at a time — a second
  // control opening beside the first would be two half-finished actions.
  const [picking, setPicking] = useState(null)   // 'owner' | null
  const [users, setUsers] = useState(null)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [deleting, setDeleting] = useState(false)
  useEffect(() => {
    if (picking !== 'owner' || users !== null) return
    dealsAPI.users()
      .then((r) => setUsers(r?.users || []))
      .catch(() => setUsers([]))
  }, [picking, users])

  // One PATCH per contact, like addTag: GHL has no bulk contact update, and
  // a server loop would only move the same requests behind one response
  // while hiding which of them failed.
  const applyToAll = async (label, patch, local) => {
    setPicking(null)
    let failed = 0
    for (const c of selected) {
      try {
        await contactsAPI.update(c.id, patch)
        onPatch(c.id, typeof local === 'function' ? local(c) : local)
      } catch {
        failed++
      }
    }
    onNotice(failed
      ? `${label} ${selected.length - failed} of ${selected.length} — ${failed} could not be changed.`
      : `${label} ${selected.length} contact${selected.length === 1 ? '' : 's'}.`)
  }

  const deleteAll = async () => {
    setDeleting(true)
    let failed = 0
    for (const c of selected) {
      try { await contactsAPI.remove(c.id) } catch { failed++ }
    }
    setDeleting(false)
    setConfirmDelete(false)
    onClear()
    onReload && onReload()
    onNotice(failed
      ? `Deleted ${selected.length - failed} of ${selected.length} — ${failed} could not be deleted.`
      : `Deleted ${selected.length} contact${selected.length === 1 ? '' : 's'}.`)
  }

  const [tagging, setTagging] = useState(false)
  const [tag, setTag] = useState('')
  const [busy, setBusy] = useState(false)
  const inputRef = useRef(null)

  useEffect(() => { if (tagging) inputRef.current?.focus() }, [tagging])

  const addTag = async () => {
    const t = tag.trim()
    setTagging(false); setTag('')
    if (!t || busy) return
    setBusy(true)
    let failed = 0
    // One contact at a time: the endpoint is per contact, and a burst of
    // parallel writes to the CRM is how rate limits get hit.
    for (const c of selected) {
      const tags = c.tags || []
      if (tags.some((x) => x.toLowerCase() === t.toLowerCase())) continue
      try {
        await contactsAPI.addTags(c.id, [t])
        onPatch(c.id, { tags: [...tags, t] })
      } catch {
        failed++
      }
    }
    setBusy(false)
    onNotice(failed
      ? `Tagged ${selected.length - failed} of ${selected.length} — ${failed} could not be tagged.`
      : `Tagged ${selected.length} contact${selected.length === 1 ? '' : 's'} "${t}".`)
  }

  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap',
      marginBottom: 'var(--space-3)', padding: '8px 12px',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface-card)'
    }}>
      <span style={{
        paddingRight: 10, marginRight: 2,
        borderRight: '1px solid var(--border-default)',
        fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--accent-sky-text)'
      }}>
        {count} selected
      </span>

      {tagging ? (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
          <input
            ref={inputRef}
            className="pp-cc-input"
            value={tag}
            list="pp-bulk-tags"
            onChange={(e) => setTag(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); addTag() }
              if (e.key === 'Escape') { e.preventDefault(); setTagging(false); setTag('') }
            }}
            placeholder="Tag name"
            style={{ width: 160, height: 32 }}
          />
          <datalist id="pp-bulk-tags">
            {tagList.map((t) => <option key={t} value={t} />)}
          </datalist>
          <BulkButton icon="check" onClick={addTag}>Add</BulkButton>
          <BulkButton icon="close" onClick={() => { setTagging(false); setTag('') }}>Cancel</BulkButton>
        </span>
      ) : (
        <BulkButton icon="sell" onClick={() => setTagging(true)} disabled={busy}>
          {busy ? 'Tagging…' : 'Add tag'}
        </BulkButton>
      )}
      {picking === 'owner' ? (
        <Select
          autoFocus
          defaultOpen
          showSearch
          optionFilterProp="label"
          placeholder={users === null ? 'Loading…' : 'Assign to…'}
          loading={users === null}
          options={[
            { value: '', label: 'Unassigned' },
            ...(users || []).map((u) => ({ value: u.id, label: u.name || u.email || u.id }))
          ]}
          onChange={(v) => {
            const u = (users || []).find((x) => x.id === v)
            applyToAll('Assigned', { assignedTo: v || null },
              { assignedTo: v || null, owner: u ? (u.name || u.email || u.id) : null })
          }}
          onOpenChange={(o) => { if (!o) setPicking(null) }}
          popupClassName="pp-menu"
          style={{ width: 220 }}
          styles={{ root: { height: 32 } }}
        />
      ) : (
        <BulkButton icon="person_add" onClick={() => setPicking('owner')} disabled={busy}>Assign owner</BulkButton>
      )}
      <BulkButton icon="delete" danger onClick={() => setConfirmDelete(true)} disabled={busy || deleting}>
        {deleting ? 'Deleting…' : 'Delete'}
      </BulkButton>
      {confirmDelete && (
        <ConfirmDialog
          title={`Delete ${count} contact${count === 1 ? '' : 's'}?`}
          message="This deletes them in your CRM as well. It cannot be undone — GHL has no restore for contacts. Their deals, notes and messages stay, without a contact behind them."
          preview={selected.slice(0, 5).map((c) => c.name || c.email || c.phone).filter(Boolean).join(', ') + (count > 5 ? ` and ${count - 5} more` : '')}
          confirmLabel={`Delete ${count}`}
          busy={deleting}
          onConfirm={deleteAll}
          onCancel={() => setConfirmDelete(false)}
        />
      )}

      <button
        onClick={onClear}
        style={{
          height: 32, padding: '0 6px',
          border: 'none', background: 'none',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
          color: 'var(--accent-sky-text)', cursor: 'pointer'
        }}
      >
        Clear
      </button>
    </div>
  )
}

function BulkButton({ icon, children, onClick, danger, disabled }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 32, padding: '0 12px',
        border: `1px solid ${danger ? 'var(--status-stuck)' : 'var(--border-strong)'}`,
        borderRadius: 'var(--radius-pill)',
        background: 'var(--surface-card)',
        color: danger ? 'var(--status-stuck-text)' : 'var(--text-body)',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
        cursor: disabled ? 'default' : 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 16 }}>{icon}</span>
      {children}
    </button>
  )
}

function ShowOnCards({ value, onChange }) {
  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' }}>
      <span aria-hidden="true" style={{
        width: 1, height: 22, background: 'var(--border-default)', margin: '0 4px'
      }} />
      <span style={{
        fontSize: 11, fontWeight: 600, letterSpacing: '.05em',
        textTransform: 'uppercase', color: '#4a515c'
      }}>
        Show on cards
      </span>
      {SHOW_ON_CARDS.map((o) => {
        const on = value[o.key] !== false
        return (
          <button
            key={o.key}
            onClick={() => onChange({ ...value, [o.key]: !on })}
            aria-pressed={on}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              height: 30, padding: '0 12px',
              border: `1px solid ${on ? o.colour : 'var(--border-strong)'}`,
              borderRadius: 'var(--radius-pill)',
              background: on ? o.tint : 'var(--surface-card)',
              color: on ? o.colour : 'var(--text-muted)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
              cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 15 }}>{on ? 'check' : 'add'}</span>
            {o.label}
          </button>
        )
      })}
    </span>
  )
}

// "Columns · 9 of 10" — which list columns show. Name always does, so it is
// counted but not offered.
function ColumnsControl({ value, onChange }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)
  const total = CONTACT_COLUMNS.length + 1

  useEffect(() => {
    if (!open) return
    const close = (e) => {
      if (e.type === 'keydown' && e.key !== 'Escape') return
      if (e.type === 'mousedown' && ref.current?.contains(e.target)) return
      setOpen(false)
    }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', close)
    return () => {
      document.removeEventListener('mousedown', close)
      document.removeEventListener('keydown', close)
    }
  }, [open])

  const toggle = (key) => onChange(
    value.includes(key)
      ? value.filter((k) => k !== key)
      // Kept in the table's own order, whatever order they were ticked in.
      : CONTACT_COLUMNS.map((c) => c.key).filter((k) => k === key || value.includes(k))
  )

  return (
    <span ref={ref} style={{ position: 'relative', display: 'inline-flex' }}>
      <button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6,
          height: 34, padding: '0 10px 0 12px',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-pill)',
          background: 'var(--surface-card)', color: 'var(--text-body)',
          fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
          cursor: 'pointer'
        }}
      >
        <span className="ms" style={{ fontSize: 16 }}>view_column</span>
        Columns · {value.length + 1} of {total}
        <span className="ms" style={{ fontSize: 16 }}>{open ? 'expand_less' : 'expand_more'}</span>
      </button>
      {open && (
        <span style={{
          position: 'absolute', top: 'calc(100% + 4px)', right: 0, zIndex: 20,
          display: 'grid', gap: 2, minWidth: 190, padding: 6,
          background: 'var(--surface-card)',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-md)',
          boxShadow: 'var(--shadow-overlay)'
        }}>
          {CONTACT_COLUMNS.map((c) => (
            <label key={c.key} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '6px 8px', borderRadius: 'var(--radius-sm)',
              fontSize: 'var(--text-md)', color: 'var(--text-body)', cursor: 'pointer'
            }}>
              <input
                type="checkbox"
                checked={value.includes(c.key)}
                onChange={() => toggle(c.key)}
              />
              {c.label}
            </label>
          ))}
        </span>
      )}
    </span>
  )
}

// ── The contact's link to a business, on a card ───────────────────────
//
// Mirrors BusinessLink on the contact detail page, in the row shape the card
// uses. Both open the SAME BusinessPickerModal, so "link a business" means
// one thing in this app rather than three.
//
// Writes straight through: there is no Save button on this control, unlike
// the text fields beside it. Linking is a single, reversible decision and
// making a rep press Save afterwards would be ceremony — but it does mean
// the parent row has to be patched here rather than on the card's own save.
function CardBusinessLink({ contact, disabled, onChanged }) {
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
      onChanged && onChanged({ businessId: null, businessName: null })
    } catch (err) {
      setError(err?.message || 'Could not unlink')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      {/* A <div> row, not the <button> the editable rows use: this row has
          its own controls inside it, and a button containing buttons is
          invalid HTML. */}
      <div className="pp-cc-row" style={{ cursor: 'default' }}>
        <span className="pp-cc-key">
          <span className="ms pp-cc-icon">business</span>
          <span className="pp-cc-label">Business</span>
        </span>
        <button
          onClick={() => setPicking(true)}
          disabled={disabled || busy}
          title={linked ? 'Link a different business' : 'Link a business'}
          className={linked ? 'pp-cc-value' : 'pp-cc-value pp-cc-value-empty'}
          style={{
            border: 'none', background: 'none', textAlign: 'left',
            fontFamily: 'inherit', cursor: disabled ? 'default' : 'pointer'
          }}
        >
          {linked ? linked.name : 'Add a business'}
        </button>
        {linked && (
          <button
            onClick={unlink}
            disabled={disabled || busy}
            className="pp-cc-act"
            title="Unlink this business from the contact"
            aria-label="Unlink business"
            style={{ paddingRight: 0 }}
          >
            <span className="ms" style={{ fontSize: 15 }}>{busy ? 'progress_activity' : 'link_off'}</span>
          </button>
        )}
        <button
          onClick={() => setPicking(true)}
          disabled={disabled || busy}
          className="pp-cc-act"
          title={linked ? 'Change the business' : 'Link a business'}
          aria-label={linked ? 'Change business' : 'Link a business'}
        >
          <span className="ms" style={{ fontSize: 15 }}>edit</span>
        </button>
      </div>

      {error && <RowError>{error}</RowError>}

      {picking && (
        <BusinessPickerModal
          contact={contact}
          blurb="Type a name to search the businesses in this sub-account."
          onClose={() => setPicking(false)}
          onLinked={(business) => {
            setPicking(false)
            onChanged && onChanged({ businessId: business.id, businessName: business.name })
          }}
        />
      )}
    </>
  )
}

// TYPE — a GHL custom field, which the contact update endpoint rejects (the
// server's contactPatch drops it too). The pencil is there because the design
// draws one on every row; pressing it says where Type is changed instead of
// opening an input whose value would be thrown away.
// Type, as a picker in the card's draft — it saves with the other fields
// in the card's single PATCH, through contactPatch's `contactType → type`.
// It was a pencil that only explained the type is set in the CRM, which was
// never true of the server; the client just never sent it.
function TypeRow({ value, dirty, disabled, onChange }) {
  const [editing, setEditing] = useState(false)
  const current = String(value || '').toLowerCase()
  const label = CONTACT_TYPES.find((t) => t.value === current)?.label || value
  if (editing) {
    return (
      <div className="pp-cc-row" style={{ cursor: 'default' }}>
        <span className="pp-cc-key">
          <span className="ms pp-cc-icon">badge</span>
          <span className="pp-cc-label">Type</span>
        </span>
        <Select
          autoFocus
          defaultOpen
          value={current || undefined}
          allowClear
          placeholder="Not set"
          options={CONTACT_TYPES}
          disabled={disabled}
          onChange={(v) => { onChange(v || null); setEditing(false) }}
          onOpenChange={(o) => { if (!o) setEditing(false) }}
          popupClassName="pp-menu"
          style={{ flex: 1, minWidth: 0 }}
          styles={{ root: { height: 30 } }}
        />
      </div>
    )
  }
  return (
    <button
      type="button"
      className={dirty ? 'pp-cc-row pp-cc-row-dirty' : 'pp-cc-row'}
      onClick={() => !disabled && setEditing(true)}
      title="Change the type"
    >
      <span className="pp-cc-key">
        <span className="ms pp-cc-icon">badge</span>
        <span className="pp-cc-label">Type</span>
      </span>
      <span className={label ? 'pp-cc-value' : 'pp-cc-value pp-cc-value-empty'}>
        {label || 'Not set'}
      </span>
      <span className="ms pp-cc-pencil">edit</span>
    </button>
  )
}

// TAGS — chips, removable on hover, and a dashed "+ Tag" that becomes an
// input with the account's own tags offered as you type, so a rep picks an
// existing tag rather than inventing a near-duplicate.
//
// Writes straight through, like the business link: the tag endpoints are
// ADDITIVE (see contactsAPI.addTags), which the card's batched Save is not.
function TagsRow({ contact, tagList, disabled, onChanged }) {
  const tags = contact.tags || []
  const [adding, setAdding] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const inputRef = useRef(null)
  const listId = `pp-tags-${contact.id}`

  useEffect(() => { if (adding) inputRef.current?.focus() }, [adding])

  const write = async (next, call) => {
    setBusy(true); setError(null)
    try {
      await call()
      onChanged && onChanged(next)
    } catch (err) {
      setError(err?.message || 'Could not update tags')
    } finally {
      setBusy(false)
    }
  }

  const add = () => {
    const tag = draft.trim()
    setAdding(false); setDraft('')
    if (!tag || tags.some((t) => t.toLowerCase() === tag.toLowerCase())) return
    write([...tags, tag], () => contactsAPI.addTags(contact.id, [tag]))
  }

  const remove = (tag) =>
    write(tags.filter((t) => t !== tag), () => contactsAPI.removeTags(contact.id, [tag]))

  return (
    <>
      <div className="pp-cc-row" style={{ cursor: 'default' }}>
        <span className="pp-cc-key">
          <span className="ms pp-cc-icon">sell</span>
          <span className="pp-cc-label">Tags</span>
        </span>
        <span className="pp-cc-tags">
          {tags.map((t) => (
            <span key={t} className="pp-cc-tag" title={t}>
              {/* The text in its own span so a long name ellipsises on one
                  line instead of wrapping inside the 24px pill. */}
              <span className="pp-cc-tag-text">{t}</span>
              <button
                className="pp-cc-tag-x"
                onClick={() => remove(t)}
                disabled={disabled || busy}
                title={`Remove ${t}`}
                aria-label={`Remove tag ${t}`}
              >
                <span className="ms" style={{ fontSize: 13 }}>close</span>
              </button>
            </span>
          ))}
          {adding ? (
            <>
              <input
                ref={inputRef}
                className="pp-cc-input"
                value={draft}
                list={listId}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={add}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') { e.preventDefault(); add() }
                  if (e.key === 'Escape') { e.preventDefault(); setAdding(false); setDraft('') }
                }}
                placeholder="Tag name"
                style={{ flex: '0 1 140px', height: 26 }}
              />
              <datalist id={listId}>
                {tagList.filter((t) => !tags.includes(t)).map((t) => <option key={t} value={t} />)}
              </datalist>
            </>
          ) : (
            <button
              className="pp-cc-tag-add"
              onClick={() => setAdding(true)}
              disabled={disabled || busy}
            >
              <span className="ms" style={{ fontSize: 14 }}>add</span>Tag
            </button>
          )}
        </span>
      </div>
      {error && <RowError>{error}</RowError>}
    </>
  )
}

// A message under a field row — a failed write, or Type's explanation.
function RowError({ children, tone = 'error' }) {
  return (
    <p role={tone === 'error' ? 'alert' : 'status'} style={{
      margin: 0, padding: '6px 12px',
      background: 'var(--surface-card)',
      fontSize: 'var(--text-sm)',
      color: tone === 'error' ? 'var(--status-stuck-text)' : 'var(--text-muted)'
    }}>
      {children}
    </p>
  )
}

// One contact, as a record card — the October 2026 design.
//
//   ┌ Clare Martin ─────────────────── [Open CONTACT] ┐   header
//   │ CONTACT                                          │
//   │ ┌ 👤 NAME     │ Clare Martin                ✎ ┐ │   the record, as a
//   │ │ ✉ EMAIL    │ …                           ✎ │ │   ruled two-column
//   │ └ 🏷 TAGS     │ (website) (warm-lead) (+ Tag)  ┘ │   table
//   │ 🏷 Riverside Extension            [View DEAL]   │   linked records
//   └ 🏢 Sample Homeowner           [View BUSINESS]   ┘
//
// Fields are readable lines that become inputs on click; the text fields
// batch into one Save, while the business link and tags write straight
// through.
function ContactCard({
  c, showOn, tagList, selected, onToggleSelected, onOpen, onOpenDeal, onOpenBusiness,
  onSaved, onBusinessChanged, onTagsChanged
}) {
  // name → edited value. Absent = untouched, which keeps '' (a deliberate
  // clear) distinguishable from "not edited".
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errorField, setErrorField] = useState(null)
  const [saved, setSaved] = useState(false)

  const valueOf = (name) => (name in edits ? edits[name] : (c[name] ?? ''))

  const changes = useMemo(() => {
    const out = {}
    for (const [name, v] of Object.entries(edits)) {
      const now = String(v ?? '').trim()
      const was = String(c[name] ?? '').trim()
      if (now !== was) out[name] = now
    }
    return out
  }, [c, edits])

  const dirty = Object.keys(changes).length > 0

  const setField = (name, v) => {
    setEdits((prev) => ({ ...prev, [name]: v }))
    setError(null)
    setErrorField(null)
    setSaved(false)
  }

  const revert = () => {
    setEdits({})
    setError(null)
    setErrorField(null)
  }

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    setErrorField(null)
    try {
      const res = await contactsAPI.update(c.id, changes)
      // Clear the local edits so the card reads from the refreshed record —
      // otherwise a value the CRM normalised (a reformatted phone number) would
      // keep showing what was typed.
      setEdits({})
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2000)
      if (onSaved) onSaved(c.id, res.contact || null)
    } catch (err) {
      setError(err.message || 'Could not save that — try again')
      setErrorField(err.data?.field || null)
    } finally {
      setSaving(false)
    }
  }

  // The linked records the card lists — deals (when Show on cards has them
  // on) and the business. Built as a list so the last row drops its divider.
  const links = []
  if (showOn.deals !== false) {
    for (const d of c.deals || []) {
      // The row keeps the deal's detail the old card showed — its value and
      // stage after the name, and PRIMARY when this contact OWNS the deal
      // rather than is merely linked to it (an architect appears on a deal
      // without owning it). Quiet, so the row still reads as the design's
      // "name · View DEAL".
      const meta = [d.value != null && money(d.value), d.stage].filter(Boolean).join(' · ')
      links.push(
        <LinkedRow
          key={`deal-${d.id}`}
          icon="sell"
          name={d.name || 'Untitled deal'}
          meta={meta || undefined}
          iconColour={LINK_TONES.deal.fill}
          large
          action={(
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none' }}>
              {d.primary && (
                <span
                  title="This contact owns the deal"
                  style={{
                    padding: '1px 6px',
                    borderRadius: 'var(--radius-sm)',
                    background: 'var(--green-600)', color: '#fff',
                    fontSize: 'var(--text-xs)', fontWeight: 700,
                    letterSpacing: 'var(--tracking-label)'
                  }}
                >
                  PRIMARY
                </span>
              )}
              <DealPill
                name={d.name}
                onClick={onOpenDeal ? () => onOpenDeal(d.id) : undefined}
              />
            </span>
          )}
        />
      )
    }
  }
  if (c.businessId) {
    links.push(
      <LinkedRow
        key="business"
        icon="business"
        name={c.businessName || 'Linked business'}
        tone={LINK_TONES.business}
        iconColour={LINK_TONES.business.fill}
        large
        onOpen={onOpenBusiness ? () => onOpenBusiness(c.businessId) : undefined}
      />
    )
  }
  // Tasks and notes as COUNT rows — the list carries no items, so the View
  // pill opens the contact, where they are.
  const tasks = c.openTaskCount || 0
  const notes = c.noteCount || 0
  // THE ITEMS, as the design lists them — one row per open task and per
  // note, from the first five the list route now sends. A contact with more
  // gets a final "+N more" row that opens the record. The count-only row
  // stays as the fallback for a page served by an older server.
  const taskRows = Array.isArray(c.tasks) ? c.tasks : []
  const noteRows = Array.isArray(c.notes) ? c.notes : []
  if (showOn.tasks !== false && tasks > 0) {
    if (taskRows.length) {
      taskRows.forEach((t) => links.push(
        <LinkedRow
          key={`task-${t.id}`}
          icon="task_alt"
          name={t.title || '(untitled task)'}
          meta={t.dueAt ? formatDue(t.dueAt) : null}
          tone={{ fill: 'var(--accent-clay)', label: 'TASK' }}
          iconColour="var(--accent-clay)"
          large
          onOpen={onOpen}
        />
      ))
      if (tasks > taskRows.length) links.push(
        <LinkedRow key="tasks-more" icon="task_alt" name={`+${tasks - taskRows.length} more open`}
          tone={{ fill: 'var(--accent-clay)', label: 'TASK' }} iconColour="var(--accent-clay)" large onOpen={onOpen} />
      )
    } else {
      links.push(
        <LinkedRow
          key="tasks"
          icon="task_alt"
          name={`${tasks} open task${tasks === 1 ? '' : 's'}`}
          tone={{ fill: 'var(--accent-clay)', label: 'TASK' }}
          iconColour="var(--accent-clay)"
          large
          onOpen={onOpen}
        />
      )
    }
  }
  if (showOn.notes !== false && notes > 0 && noteRows.length) {
    noteRows.forEach((n) => links.push(
      <LinkedRow
        key={`note-${n.id}`}
        icon="sticky_note_2"
        name={n.title || plainText(n.body) || '(empty note)'}
        meta={n.createdAt ? relativeTime(n.createdAt) : null}
        tone={{ fill: 'var(--accent-brown)', label: 'NOTE' }}
        iconColour="var(--accent-brown)"
        large
        onOpen={onOpen}
      />
    ))
    if (notes > noteRows.length) links.push(
      <LinkedRow key="notes-more" icon="sticky_note_2" name={`+${notes - noteRows.length} more`}
        tone={{ fill: 'var(--accent-brown)', label: 'NOTE' }} iconColour="var(--accent-brown)" large onOpen={onOpen} />
    )
  } else if (showOn.notes !== false && notes > 0) {
    links.push(
      <LinkedRow
        key="notes"
        icon="sticky_note_2"
        name={`${notes} note${notes === 1 ? '' : 's'}`}
        tone={{ fill: 'var(--accent-brown)', label: 'NOTE' }}
        iconColour="var(--accent-brown)"
        large
        onOpen={onOpen}
      />
    )
  }

  return (
    <div
      className="pp-card"
      style={{ display: 'flex', flexDirection: 'column', overflow: 'hidden' }}
    >
      {/* HEADER — select, the name, and the way into the full record. */}
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        padding: '14px 16px',
        borderBottom: '1px solid var(--border-default)'
      }}>
        <input
          type="checkbox"
          className="pp-check"
          checked={!!selected}
          onChange={onToggleSelected}
          aria-label={`Select ${c.name || 'this contact'}`}
        />
        <span style={{
          flex: 1, minWidth: 0,
          fontSize: 'var(--text-xl)', fontWeight: 600, color: 'var(--text-heading)',
          overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
        }}>
          {c.name || '—'}
        </span>
        {/* Save and Cancel sit BEFORE Open, so the action that keeps your
            work is nearer than the one that navigates away from it. Both
            appear only when something is edited. */}
        {dirty && !saving && (
          <button onClick={revert} title="Discard these changes" style={smallBtn}>
            Cancel
          </button>
        )}
        {(dirty || saving || saved) && (
          <button
            onClick={save}
            disabled={!dirty || saving}
            title={`Save ${Object.keys(changes).length} change${Object.keys(changes).length === 1 ? '' : 's'} to your CRM`}
            style={{
              ...smallBtn,
              gap: 5, border: 'none',
              background: saved ? 'var(--status-done)' : 'var(--brand-primary)',
              color: '#fff', fontWeight: 600,
              cursor: saving ? 'default' : 'pointer'
            }}
          >
            {saving && <span className="ms pp-spin" style={{ fontSize: 14 }}>progress_activity</span>}
            {saved && <span className="ms" style={{ fontSize: 14 }}>check</span>}
            {saving ? 'Saving' : saved ? 'Saved' : 'Save'}
          </button>
        )}
        <OpenContactPill onClick={onOpen} />
      </div>

      {/* THE RECORD — a ruled table of fields. */}
      <div style={{ padding: '12px 16px 14px', display: 'grid', gap: 8 }}>
        <FieldLabel>Contact</FieldLabel>
        <div className="pp-cc-fields">
          <InlineEdit
            label="Name" icon="person"
            value={[valueOf('firstName'), valueOf('lastName')].filter(Boolean).join(' ')}
            placeholder="Add a name"
            disabled={saving}
            dirty={'firstName' in changes || 'lastName' in changes}
            invalid={errorField === 'firstName' || errorField === 'lastName'}
            // One line for what a person calls themselves, split back on save.
            onChange={(v) => {
              const parts = String(v).trim().split(/\s+/).filter(Boolean)
              setField('firstName', parts.shift() || '')
              setField('lastName', parts.join(' '))
            }}
          />
          <InlineEdit
            label="Email" icon="mail"
            value={valueOf('email')} placeholder="Add an email"
            disabled={saving} dirty={'email' in changes}
            invalid={errorField === 'email'}
            onChange={(v) => setField('email', v)}
          />
          <InlineEdit
            label="Phone" icon="call"
            value={valueOf('phone')} placeholder="Add a phone"
            disabled={saving} dirty={'phone' in changes}
            invalid={errorField === 'phone'}
            onChange={(v) => setField('phone', v)}
          />
          {/* A LINK to a business record, not free text — the same picker
              the detail page and the Deal Hub use. */}
          <CardBusinessLink
            contact={c}
            disabled={saving}
            onChanged={(link) => onBusinessChanged && onBusinessChanged(c.id, link)}
          />
          <InlineEdit
            label="Address" icon="location_on"
            value={valueOf('address')} placeholder="Add an address"
            disabled={saving} dirty={'address' in changes}
            invalid={errorField === 'address'}
            onChange={(v) => setField('address', v)}
          />
          <TypeRow
            value={valueOf('contactType')}
            dirty={'contactType' in changes}
            disabled={saving}
            onChange={(v) => setField('contactType', v)}
          />
          <TagsRow
            contact={c}
            tagList={tagList}
            disabled={saving}
            onChanged={(tags) => onTagsChanged && onTagsChanged(c.id, tags)}
          />
        </div>

        {error && (
          <div
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 6,
              padding: '8px 10px',
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

        {/* Contact permissions. Loud on purpose — the AI draft gate refuses
            these channels outright (spec rule 7), and a rep needs to see it
            before picking up the phone. */}
        {(c.dnd?.all || c.dnd?.blockedCount > 0) && <DndLine dnd={c.dnd} />}
      </div>

      {/* LINKED RECORDS — flex:1 so cards in a grid row share a floor. */}
      <div style={{
        flex: 1,
        padding: '0 16px 4px',
        borderTop: '1px solid var(--border-default)',
        display: 'flex', flexDirection: 'column'
      }}>
        {links.length
          ? links.map((row, i) =>
              i === links.length - 1 ? React.cloneElement(row, { last: true }) : row)
          : (
            <span style={{ padding: '12px 0', fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
              Nothing linked yet
            </span>
          )}
      </div>
    </div>
  )
}

const smallBtn = {
  display: 'inline-flex', alignItems: 'center', flex: 'none',
  height: 30, padding: '0 11px',
  border: '1px solid var(--border-strong)',
  borderRadius: 'var(--radius-sm)',
  background: '#fff',
  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
  color: 'var(--text-body)', cursor: 'pointer'
}

// "Open CONTACT" — the View pill's shape in the contact blue, opening the
// full record.
function OpenContactPill({ onClick }) {
  const fill = LINK_TONES.contact.fill
  return (
    <button
      onClick={onClick}
      title="Open the full contact record"
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7, flex: 'none',
        height: 26, padding: '0 4px 0 10px',
        border: 'none', borderRadius: 'var(--radius-pill)',
        background: fill, color: '#fff',
        fontFamily: 'var(--font-sans)', fontSize: 11, fontWeight: 600,
        cursor: 'pointer', whiteSpace: 'nowrap'
      }}
    >
      Open
      <span style={{
        display: 'inline-flex', alignItems: 'center',
        height: 19, padding: '0 8px',
        borderRadius: 'var(--radius-pill)',
        background: '#fff', color: fill,
        fontSize: 10, fontWeight: 700, letterSpacing: 'var(--tracking-label)'
      }}>
        CONTACT
      </span>
    </button>
  )
}

function FieldLabel({ children }) {
  return (
    <span
      style={{
        display: 'block',
        fontSize: 'var(--text-xs)', fontWeight: 700, letterSpacing: 'var(--tracking-label)',
        textTransform: 'uppercase', color: '#4a515c'
      }}
    >
      {children}
    </span>
  )
}

// "1 channel off" / "Do not contact" as an inline line rather than a corner
// badge — at card width a badge competes with the Open button.
function DndLine({ dnd }) {
  const all = dnd.all
  const n = dnd.blockedCount || 0
  const which = (dnd.blockedChannels || []).map(labelFor).join(', ')
  return (
    <span
      title={all ? 'This contact has asked not to be contacted on any channel' : `Off: ${which}`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        justifySelf: 'start',
        fontSize: 'var(--text-base)', fontWeight: 600, color: 'var(--status-stuck)'
      }}
    >
      <span className="ms" style={{ fontSize: 16 }}>{all ? 'block' : 'notifications_off'}</span>
      {all ? 'Do not contact' : `${n} channel${n === 1 ? '' : 's'} off`}
    </span>
  )
}

function money(v) {
  return `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}

function labelFor(k) {
  if (k === 'sms') return 'SMS'
  if (k === 'whatsapp') return 'WhatsApp'
  return k.charAt(0).toUpperCase() + k.slice(1)
}

// One field as a READABLE LINE that becomes an input on click.
//
// The VALUE matters far more often than the control: a rep scans this list to
// find someone and edits occasionally.
//
// Click or Enter opens it; Enter or blur closes it; Escape abandons the edit.
// Nothing saves here — the change joins the card's own Save, so one editing
// session is one request.
function InlineEdit({
  label, value, placeholder, icon, onChange, disabled, dirty, invalid
}) {
  const [open, setOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const ref = useRef(null)

  useEffect(() => { if (open) ref.current?.focus() }, [open])

  const commit = () => {
    setOpen(false)
    if (draft !== (value || '')) onChange(draft)
  }

  const key = (
    <span className="pp-cc-key">
      {icon && <span className="ms pp-cc-icon">{icon}</span>}
      <span className="pp-cc-label">{label}</span>
    </span>
  )

  if (open) {
    return (
      <label className="pp-cc-row pp-cc-row-open">
        {key}
        <span style={{ flex: 1, display: 'flex', alignItems: 'center', padding: '5px 12px' }}>
          <input
            ref={ref}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); commit() }
              // Escape abandons rather than commits — the reflex when you
              // realise you opened the wrong field.
              if (e.key === 'Escape') { e.preventDefault(); setOpen(false) }
            }}
            className={invalid ? 'pp-cc-input pp-cc-input-bad' : 'pp-cc-input'}
            placeholder={placeholder}
          />
        </span>
      </label>
    )
  }

  return (
    <button
      type="button"
      onClick={() => { if (!disabled) { setDraft(value || ''); setOpen(true) } }}
      disabled={disabled}
      className={dirty ? 'pp-cc-row pp-cc-row-dirty' : 'pp-cc-row'}
      title={`${label} — click to edit`}
    >
      {key}
      <span className={value ? 'pp-cc-value' : 'pp-cc-value pp-cc-value-empty'}>
        {value || placeholder}
      </span>
      <span className="ms pp-cc-pencil">edit</span>
    </button>
  )
}

// A note body is stored as HTML; a card row wants its first line as text.
function plainText(html) {
  const t = String(html || '').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').trim()
  return t.length > 90 ? `${t.slice(0, 88)}…` : t
}
