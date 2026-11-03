import React, { useCallback, useEffect, useMemo, useState } from 'react'
import AttachmentChip from '../dealhub/AttachmentChip'
import AttachmentViewer from '../dealhub/AttachmentViewer'
import ViewSwitch from '../shared/ViewSwitch'
import ContactPicker from '../shared/ContactPicker'
import SyncButton from '../shared/SyncButton'
import { contactsAPI } from '../../api/contacts'
import { businessesAPI } from '../../api/businesses'
import { usePagedList, useInfiniteScroll } from '../../hooks/usePagedList'
import { useTabState } from '../../hooks/useTabState'
import {
  Shell, Panel, Row, Chip, SearchInput, StateMessage,
  SkeletonStyles, Bar, LoadMore, formatDate, DealPill, RecordPill, Truncate } from '../shared/ListChrome'
import { Popover, Select } from 'antd'
import { countryOptions } from '../../constants/countries'
import BusinessEditor from '../shared/BusinessEditor'
import ConfirmDialog from '../shared/ConfirmDialog'
import BusinessGridCard from '../businesses/BusinessGridCard'
import BusinessList from '../businesses/BusinessList'
import BusinessTasksPanel from '../businesses/BusinessTasksPanel'

// A toolbar field with its label stacked ABOVE it — the Figma row's shape,
// shared with the Deals header.
function ToolbarField({ label, children }) {
  return (
    // .pp-filter-field: the dropdown value and chevron weights — see the
    // rule in dealhub-tokens.css.
    <span className="pp-filter-field" style={{ display: 'inline-flex', flexDirection: 'column', gap: 5, minWidth: 0 }}>
      <span className="pp-label" style={{ marginBottom: 0 }}>{label}</span>
      {children}
    </span>
  )
}

// Businesses — the roll-up.
//
// A business is the level above a deal. The thing this page does that no other
// page can: show every conversation with every contact at a company in one
// stream, across all its deals. A message that arrived against no deal at all
// shows up here as "Unassigned" — on the deal-by-deal view it is invisible,
// which is exactly how it goes unanswered.
//
// Company Info comes from GHL's ten Business fields. The bracketed merge key
// sits beside each label so it's obvious which GHL field a value came from.

export default function BusinessesTab({
  onOpenDeal, onOpenContact, openBusinessId, onBusinessViewed,
  // See ContactsTab — opening a card inside this tab is navigation the shell
  // never sees, so it has to be reported for Back to work.
  onNavigate
}) {
  const [q, setQ] = useTabState('businesses', 'q', '')
  // Plain state, not useTabState — see ContactsTab for why. Leaving the tab
  // and returning should land on the list, not reopen the last record.
  const [openId, setOpenId] = useState(null)

  // Rows or a grid — see TasksTab.
  const [view, setView] = useState(() => {
    try { return localStorage.getItem('pp.businesses.view') || 'grid' } catch { return 'grid' }
  })
  useEffect(() => {
    try { localStorage.setItem('pp.businesses.view', view) } catch { /* private mode */ }
  }, [view])

  // A business link elsewhere in the app (the Deal card) hands us an id to
  // open. Mirrors how ContactsTab handles openContactId.
  useEffect(() => {
    if (openBusinessId) setOpenId(openBusinessId)
  }, [openBusinessId, setOpenId])

  // The toolbar's Sort. Server-side (GET /api/businesses?sort=), so the order
  // covers every business, not just the loaded page. Remembered like the
  // search. "Last activity" is the design's default.
  const [sort, setSort] = useTabState('businesses', 'sort', 'activity')

  const fetchPage = useCallback(
    ({ cursor }) =>
      businessesAPI.list({
        ...(q.trim() ? { q: q.trim() } : {}),
        sort,
        ...(cursor ? { cursor } : {})
      }),
    [q, sort]
  )

  const { items, error, hasMore, loadingMore, loadMore, reload, patchItem } = usePagedList({
    fetchPage,
    key: 'businesses',
    // A sort change starts the list over — a cursor from one order is
    // meaningless in another, and the server refuses it.
    deps: [q, sort]
  })

  const sentinelRef = useInfiniteScroll(loadMore, { enabled: hasMore && !loadingMore })
  const [creating, setCreating] = useState(false)


  const openBusiness = (id) => {
    setOpenId(id)
    if (onNavigate) onNavigate({ businessId: id })
  }

  if (openId) {
    return (
      <BusinessDetail
        businessId={openId}
        onBack={() => {
          setOpenId(null)
          if (onBusinessViewed) onBusinessViewed()
          // Keep the shell's Back in step — see ContactsTab.
          if (onNavigate) onNavigate({ businessId: null })
        }}
        onOpenDeal={onOpenDeal}
        onOpenContact={onOpenContact}
        onDeleted={reload}
      />
    )
  }

  return (
    <Shell>
      {/* No PageHeader — the panel below is the only header, the same shape
          as Tasks and Notes. It repeated the tab name the nav already shows,
          with a subtitle explaining what the tab is. */}
      {creating && (
        <BusinessEditor
          onClose={() => setCreating(false)}
          onSaved={() => {
            // The server already wrote our row from the echo (no webhook
            // exists), so the new business is there to be fetched immediately.
            reload()
          }}
        />
      )}

      {/* THE FIGMA HEADER: a solid purple band with the title and count, then
          one grey row of labelled fields — Search, Type, Owner, Sort — with
          Filters, the view switch, Sync and Add business on the right.

          Shown in every state, loading and empty included: it holds Search
          and Add business, and a page that drops its own header when a search
          matches nothing leaves no way to change the search. */}
      <Panel
        icon="domain"
        title="Businesses"
        accent="plum"
        solidHeader
        count={items ? `${items.length}${hasMore ? '+' : ''}` : null}
        toolbarBackground="var(--gray-100)"
        toolbar={
          <div style={{
            flex: 1, minWidth: 0,
            display: 'flex', alignItems: 'flex-end', flexWrap: 'wrap',
            gap: 'var(--space-3)'
          }}>
            <ToolbarField label="Search">
              <SearchInput
                value={q}
                onChange={setQ}
                // Says only what the search can do: the server matches name,
                // email, city and website — not contacts.
                placeholder="Search business, email or location"
                width={320}
              />
            </ToolbarField>

            {/* Type, Owner and Sort are in the design but have nothing to
                filter on yet — businesses carry no type or owner, and the list
                is keyset-paged on last update only. Shown, disabled, so the
                layout is final and they switch on when the API does. */}
            <ToolbarField label="Type">
              <Select
                aria-label="Type"
                value=""
                disabled
                title="Business type isn't available yet"
                options={[{ value: '', label: 'All types' }]}
                style={{ width: 160 }}
                styles={{ root: { height: 36 } }}
              />
            </ToolbarField>
            <ToolbarField label="Owner">
              <Select
                aria-label="Owner"
                value=""
                disabled
                title="Business owner isn't available yet"
                options={[{ value: '', label: 'Everyone' }]}
                style={{ width: 160 }}
                styles={{ root: { height: 36 } }}
              />
            </ToolbarField>
            <ToolbarField label="Sort">
              {/* Newest / largest first in every option. No name sort — the
                  server pages on a date or a number, see BUSINESS_SORTS in
                  routes/businesses.js. */}
              <Select
                aria-label="Sort"
                value={sort}
                onChange={setSort}
                options={[
                  { value: 'activity', label: 'Last activity' },
                  { value: 'recent', label: 'Last updated' },
                  { value: 'created', label: 'Newest added' },
                  { value: 'value', label: 'Pipeline value' }
                ]}
                popupClassName="pp-menu"
                popupMatchSelectWidth={false}
                style={{ width: 160 }}
                styles={{ root: { height: 36 } }}
              />
            </ToolbarField>

            <span style={{
              marginLeft: 'auto',
              display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)'
            }}>
              {/* FILTERS — the design's button. There are no business filters
                  yet, so it holds the one action that has no other home on the
                  design's header: Sync. Businesses arrive by NO webhook (GHL
                  fires nothing when one is created, renamed or deleted), so
                  this is how a rep fetches one made in the CRM this morning
                  rather than waiting for the nightly run. */}
              <Popover
                trigger="click"
                placement="bottomRight"
                // Rendered at the document root, outside [data-dealhub]; the
                // class is what gives it the tokens.
                rootClassName="pp-portal"
                content={
                  <div style={{ display: 'grid', gap: 10, width: 260 }}>
                    <span className="pp-label" style={{ marginBottom: 0 }}>Filters</span>
                    <p style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
                      Type and owner filters are coming.
                    </p>
                    <div style={{
                      display: 'grid', gap: 6, paddingTop: 10,
                      borderTop: '1px solid var(--border-default)'
                    }}>
                      <span className="pp-label" style={{ marginBottom: 0 }}>Sync from CRM</span>
                      <p style={{ margin: 0, fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                        New businesses otherwise appear after the nightly sync.
                      </p>
                      <SyncButton
                        kind="businesses"
                        label="Sync now"
                        noun="businesses"
                        onSynced={reload}
                        compact
                      />
                    </div>
                  </div>
                }
              >
                <button
                  type="button"
                  style={{
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    height: 36, padding: '0 12px', flex: 'none',
                    border: '1px solid var(--border-strong)',
                    borderRadius: 'var(--radius-md)',
                    background: 'var(--surface-card)', color: 'var(--text-body)',
                    fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
                    cursor: 'pointer'
                  }}
                >
                  <span className="ms" style={{ fontSize: 17 }}>tune</span>
                  Filters
                </button>
              </Popover>
              <ViewSwitch
                value={view}
                onChange={setView}
                options={[
                  { id: 'grid', icon: 'grid_view', label: 'Grid' },
                  { id: 'rows', icon: 'view_agenda', label: 'List' }
                ]}
              />
              <button
                type="button"
                onClick={() => setCreating(true)}
                style={{
                  display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
                  height: 36, padding: '0 15px',
                  border: 'none', borderRadius: 'var(--radius-md)',
                  background: 'var(--panel-head-plum, var(--accent-plum))', color: '#fff',
                  fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
                  cursor: 'pointer'
                }}
              >
                <span className="ms" style={{ fontSize: 18 }}>add</span>
                Add business
              </button>
            </span>
          </div>
        }
      >
        {error && <StateMessage error={error} />}

        {/* Bespoke skeleton rather than StateMessage's generic rows — these
            cards have a distinct shape and a mismatched placeholder reads as a
            layout glitch when the real rows land. */}
        {items === null && !error && <ListSkeleton />}

        <StateMessage
          empty={items?.length === 0}
          emptyText={
            q
              ? 'No businesses match that search — try a company name, city, email or website.'
              : 'No businesses yet. Businesses sync once a day, so a newly added one appears after the next sync.'
          }
        />

        {items?.length > 0 && (
          view === 'grid'
            ? (
              <div style={{
                display: 'grid',
                gridTemplateColumns: 'repeat(auto-fill, minmax(340px, 1fr))',
                gap: 'var(--space-3)', padding: 'var(--space-3)',
                alignItems: 'start'
              }}>
                {items.map((b) => (
                  <BusinessGridCard
                    key={b.id}
                    business={b}
                    onOpen={() => openBusiness(b.id)}
                    onOpenContact={onOpenContact}
                    onOpenDeal={onOpenDeal}
                    onSaved={(patch) => patchItem((x) => x.id === b.id, patch)}
                  />
                ))}
              </div>
            )
            : (
              // The Figma List view.
              <div style={{ padding: 'var(--space-3)' }}>
                <BusinessList
                  items={items}
                  onOpen={openBusiness}
                  onOpenContact={onOpenContact}
                  onOpenDeal={onOpenDeal}
                  onSaved={(id, patch) => patchItem((x) => x.id === id, patch)}
                />
              </div>
            )
        )}
      </Panel>

      {items?.length > 0 && (
        <LoadMore
          sentinelRef={sentinelRef}
          hasMore={hasMore}
          loadingMore={loadingMore}
          count={items.length}
          noun="business"
          plural="businesses"
        />
      )}
    </Shell>
  )
}

// ── Detail ────────────────────────────────────────────────────────────

function BusinessDetail({ businessId, onBack, onOpenDeal, onOpenContact, onDeleted }) {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)
  const [confirming, setConfirming] = useState(false)
  const [confirmError, setConfirmError] = useState(null)
  const [deleting, setDeleting] = useState(false)

  const remove = async () => {
    if (deleting) return
    setDeleting(true)
    setConfirmError(null)
    try {
      await businessesAPI.remove(businessId)
      setConfirming(false)
      // Back to the list — the record we were looking at is gone, and leaving
      // its detail page on screen would show something that no longer exists.
      if (onDeleted) onDeleted()
      onBack()
    } catch (err) {
      setConfirmError(err.message || 'Could not delete that business')
    } finally {
      setDeleting(false)
    }
  }

  React.useEffect(() => {
    let alive = true
    setData(null)
    setError(null)
    businessesAPI.get(businessId)
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(err.message || 'Could not load the business'))
    return () => { alive = false }
  }, [businessId])

  // Refetch the whole record after a link or unlink.
  //
  // NOT an optimistic paint. A contact row carries four things this component
  // cannot work out for itself — the deal count, the role, the initials and
  // the avatar accent, which is a hash of the id computed server-side
  // (accentFor in routes/businesses.js). A hand-built row got `undefined
  // deals` under the name and a blank circle beside it, and the roll-up counts
  // on the panels above stayed one link behind.
  //
  // Businesses have no webhooks and the contact PATCH writes
  // contacts.business_id synchronously, so the server is already correct by
  // the time this runs — there is no race to wait out.
  const reload = useCallback(() => {
    businessesAPI.get(businessId)
      .then((d) => setData(d))
      .catch(() => { /* The write succeeded; the row list is stale until the
                        next visit, which is better than clearing the page. */ })
  }, [businessId])

  return (
    <Shell>
      <div style={{ marginBottom: 14 }}>
        <button
          onClick={onBack}
          // Dark, like the shell's own Back chip — the design draws both the
          // same, and they do the same thing at two levels.
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
            height: 32, padding: '0 var(--space-3)',
            border: 'none',
            borderRadius: 'var(--radius-pill)',
            background: 'var(--gray-800)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
            color: '#fff'
          }}
        >
          <span className="ms" style={{ fontSize: 16 }}>arrow_back</span>
          All businesses
        </button>
      </div>

      {error && <StateMessage error={error} />}
      {!data && !error && <DetailSkeleton />}

      {data && (
        <div style={{ display: 'grid', gap: 18 }}>
          <CompanyInfoPanel
            business={data.business}
            onSaved={(saved) => {
              // Apply the CRM's echo. No webhook exists for businesses, so the
              // server already wrote our row — this refreshes what's on screen
              // without a refetch, and shows any value GHL normalised.
              if (saved) {
                setData((prev) => prev && {
                  ...prev,
                  business: {
                    ...prev.business,
                    ...pickBusinessFields(saved),
                    companyInfo: mergeCompanyInfo(prev.business.companyInfo, saved)
                  }
                })
              }
            }}
            onDelete={() => { setConfirmError(null); setConfirming(true) }}
          />

          <div
            style={{
              display: 'grid', gap: 18,
              gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))'
            }}
          >
            <DealsPanel deals={data.deals} onOpenDeal={onOpenDeal} />
            <ContactsPanel
              contacts={data.contacts}
              businessId={businessId}
              onOpenContact={onOpenContact}
              // Both re-read the record rather than patching it in place —
              // see reload() for why a hand-built row is not enough.
              onLinked={reload}
              onUnlinked={reload}
            />
          </div>

          {/* Between the people and the conversation, where the design puts
              it: what is owed to this business, before what was said. */}
          <BusinessTasksPanel businessId={businessId} contacts={data.contacts} />

          <ConversationsPanel
            businessId={businessId}
            total={data.business.messageCount}
            dealCount={data.business.dealCount}
            onOpenDeal={onOpenDeal}
          />
        </div>
      )}

      {confirming && data && (
        <ConfirmDialog
          title="Delete this business?"
          message={
            (data.business.contactCount || 0) > 0
              ? `${data.business.contactCount} contact${data.business.contactCount === 1 ? '' : 's'} `
                + 'will stay, but stop being linked to a business.'
              : 'This cannot be undone from here.'
          }
          preview={data.business.name}
          confirmLabel="Delete business"
          busy={deleting}
          error={confirmError}
          onConfirm={remove}
          onCancel={() => { setConfirming(false); setConfirmError(null) }}
        />
      )}
    </Shell>
  )
}

// The panel renders from companyInfo, not from the flat fields, so the echo has
// to be folded into THAT array as well. Missing this was the bug where a saved
// value flicked back to its old text on the next render.
//
// Keyed on the descriptor's own `name`, which the server sets to GHL's field
// name — so this needs no mapping table of its own and can't drift from the
// server's COMPANY_INFO_FIELDS.
function mergeCompanyInfo(companyInfo, echoed) {
  if (!Array.isArray(companyInfo)) return companyInfo
  return companyInfo.map((f) => (
    f.name in echoed ? { ...f, value: echoed[f.name] ?? null } : f
  ))
}

// GHL's echoed business uses its own field names. Map only what the detail view
// renders — spreading the raw echo would put `domainname` beside our
// `domainname` and `postalCode` beside `postalCode` inconsistently.
function pickBusinessFields(b) {
  return {
    name: b.name || 'Unnamed business',
    description: b.description || null,
    website: b.website || null,
    email: b.email || null,
    phone: b.phone || null,
    address: b.address || null,
    city: b.city || null,
    state: b.state || null,
    postalCode: b.postalCode || null,
    country: b.country || null,
    domainname: b.domainname || null
  }
}

// Edited IN PLACE, not in a modal.
//
// A modal would hide the page you were reading and duplicate the field list in a
// second component — two places to keep in step with the server's
// COMPANY_INFO_FIELDS. Here the same grid becomes editable: every box is an
// input, and one Save sends only what changed.
//
// Save is per-panel, not per-field. A rep correcting an address touches three
// boxes; three round trips would be three chances to half-fail, and GHL's update
// endpoint takes a partial body in one call.
function CompanyInfoPanel({ business: b, onSaved, onDelete }) {
  // name → edited value. Absent = untouched, which is what makes the diff
  // exact: '' is a deliberate clear and must be distinguishable from "not
  // edited".
  const [edits, setEdits] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errorField, setErrorField] = useState(null)
  const [saved, setSaved] = useState(false)
  // Fields whose pencil was clicked — they show an input; the rest show their
  // value. Edits still collect into ONE save (the design's Save button), so
  // opening a field is not committing it.
  const [open, setOpen] = useState(() => new Set())
  const openField = (name) => setOpen((prev) => new Set(prev).add(name))

  const valueOf = (f) => (f.name in edits ? edits[f.name] : (f.value ?? ''))

  const changes = useMemo(() => {
    const out = {}
    for (const f of b.companyInfo) {
      if (!(f.name in edits)) continue
      const now = String(edits[f.name] ?? '').trim()
      const was = String(f.value ?? '').trim()
      if (now !== was) out[f.name] = now
    }
    return out
  }, [b.companyInfo, edits])

  const dirty = Object.keys(changes).length > 0

  const setField = (name, v) => {
    setEdits((prev) => ({ ...prev, [name]: v }))
    setError(null)
    setErrorField(null)
    setSaved(false)
  }

  const revert = () => {
    setEdits({})
    setOpen(new Set())
    setError(null)
    setErrorField(null)
  }

  const save = async () => {
    if (!dirty || saving) return
    setSaving(true)
    setError(null)
    setErrorField(null)
    try {
      const res = await businessesAPI.update(b.id, changes)
      // Clear the local edits so the panel reads from the refreshed record —
      // otherwise a value GHL normalised (a trimmed domain, an upper-cased
      // country) would keep showing what was typed.
      setEdits({})
      setOpen(new Set())
      setSaved(true)
      window.setTimeout(() => setSaved(false), 2200)
      if (onSaved) onSaved(res.business || null)
    } catch (err) {
      setError(err.message || 'Could not save that — try again')
      setErrorField(err.data?.field || null)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Panel
      icon="domain"
      title={b.name}
      // Plum, the business colour everywhere else — the list's header band,
      // the grid's badge. No helper paragraph and no {{business.x}} merge
      // keys: the design has neither, and the keys were developer detail.
      accent="plum"
      meta="Company info"
    >
      {/* THE DESIGN'S FIELD TABLE — three columns of label | value | ✎.
          Description takes a full row; it is the one field that runs long. */}
      <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
        <div style={{
          display: 'grid',
          // AT MOST THREE COLUMNS, the design's. Each column's minimum is a
          // third of the row (or 300px, whichever is larger), so a wide screen
          // cannot fit a fourth — plain auto-fit at 300px put four or five
          // across, and the fields wrapped into different places from the
          // design. Narrow screens still drop to two, then one.
          gridTemplateColumns: 'repeat(auto-fit, minmax(max(300px, calc((100% - 2px) / 3)), 1fr))',
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-sm)',
          overflow: 'hidden',
          // White, with each cell drawing its own right and bottom rule. The
          // old grey-background-through-a-1px-gap trick painted any empty
          // space at the end of a row grey — the gap beside Country.
          background: '#fff'
        }}>
          {COMPANY_FIELD_ORDER
            .map(([name, icon]) => [b.companyInfo.find((f) => f.name === name), icon])
            .filter(([f]) => f)
            .map(([f, icon]) => (
              <CompanyField
                key={f.name}
                field={f}
                icon={icon}
                value={valueOf(f)}
                open={open.has(f.name) || errorField === f.name}
                onOpen={() => openField(f.name)}
                onChange={(v) => setField(f.name, v)}
                disabled={saving || f.writable === false}
                invalid={errorField === f.name}
                dirty={f.name in changes}
                error={errorField === f.name ? error : null}
              />
            ))}
        </div>
      </div>

      {/* An error with no field of its own — a permission problem, a rename
          rate-limit, a connection failure. */}
      {error && !errorField && (
        <div
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 7,
            margin: '0 16px 16px',
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
      {/* Actions at the BOTTOM RIGHT, after the fields.
          In the panel header they sat above the form, so the eye met Save
          before it met anything to save — and Delete was the first control on
          a panel whose job is editing. Reading order is now fields, then what
          to do with them. */}
      <div
        style={{
          display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
          justifyContent: 'flex-end',
          padding: '11px var(--space-4)',
          borderTop: '1px solid var(--border-default)',
          background: 'var(--gray-25)'
        }}
      >
        {/* Says what will happen before you commit it, and takes the left of
            the row so the buttons stay where the eye expects them. */}
        <span
          style={{
            flex: 1, minWidth: 0,
            fontSize: 'var(--text-sm)', color: 'var(--text-faint)'
          }}
        >
          {saving
            ? 'Saving to your CRM…'
            : saved
              ? 'Saved'
              : dirty
                ? `${Object.keys(changes).length} unsaved change${Object.keys(changes).length === 1 ? '' : 's'}`
                : ''}
        </span>

        {dirty && (
          <button
            onClick={revert}
            disabled={saving}
            style={{
              height: 34, padding: '0 15px',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: '#fff', color: 'var(--text-body)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 500,
              cursor: saving ? 'default' : 'pointer'
            }}
          >
            Cancel
          </button>
        )}
        <button
          onClick={save}
          disabled={!dirty || saving}
          title={dirty ? 'Save to your CRM' : 'Nothing changed yet'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            height: 34, padding: '0 18px',
            border: 'none', borderRadius: 'var(--radius-md)',
            background: dirty ? 'var(--brand-primary)' : 'var(--gray-200)',
            color: dirty ? '#fff' : 'var(--text-faint)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
            cursor: dirty && !saving ? 'pointer' : 'default'
          }}
        >
          {saving && (
            <span className="ms pp-spin" style={{ fontSize: 15 }}>progress_activity</span>
          )}
          {saving ? 'Saving' : 'Save'}
        </button>
        {/* Separated by a rule: deleting is not a variant of saving, and
            sitting flush against Save invites the wrong click. */}
        <span
          aria-hidden
          style={{
            width: 1, height: 22, flex: 'none',
            background: 'var(--border-default)', margin: '0 2px'
          }}
        />
        <button
          onClick={onDelete}
          disabled={saving}
          title="Delete this business"
          // Round and red-edged, as the design draws it.
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 34, height: 34,
            border: '1px solid var(--status-stuck)',
            borderRadius: '50%',
            background: '#fff', color: 'var(--status-stuck)',
            cursor: saving ? 'default' : 'pointer'
          }}
        >
          <span className="ms" style={{ fontSize: 17 }}>delete</span>
        </button>
      </div>

    </Panel>
  )
}

// Read-only value, styled as a field so the panel still reads as a record.
// An empty field says "Not set" rather than rendering blank — a blank box looks
// like a loading failure.
// Built once, not per render — 247 options rebuilt on every keystroke made the
// dropdown stutter while typing.
const COUNTRY_OPTIONS = countryOptions()

// One editable field. The whole panel is a form now, so this is an input rather
// than the read-only span it used to be.
//
// The LINK affordance is kept: a website, email or phone still opens, via a
// small button beside the box. Making the value itself a link would mean you
// couldn't click into it to edit — and losing "call this number" to gain
// editing would be a bad trade.
// The design's order and icon per Company info field. Fields the server
// sends that are not listed here are not drawn.
const COMPANY_FIELD_ORDER = [
  ['name', 'domain'],
  ['website', 'language'],
  ['email', 'mail'],
  ['phone', 'call'],
  ['domainname', 'public'],
  ['address', 'location_on'],
  ['city', 'location_city'],
  ['state', 'map'],
  ['postalCode', 'markunread_mailbox'],
  ['country', 'flag'],
  ['description', 'notes']
]

// One cell of the field table: label | value | ✎.
//
// Shows the VALUE until its pencil is clicked, then FieldInput — the same
// input the panel always used, so validation and the one-Save flow are
// unchanged. Country is a picker in the design (a chevron, no pencil), so it
// is always its Select. Description spans the full row.
function CompanyField({ field: f, icon, value, open, onOpen, onChange, disabled, invalid, dirty, error }) {
  const isSelect = f.type === 'select' || f.type === 'country'
  const wide = f.type === 'multiline'
  const empty = value == null || String(value).trim() === ''
  const editing = open || isSelect
  const linkable = !empty && !editing && ['url', 'email', 'phone', 'domain'].includes(f.type)
  const href = !linkable ? null
    : f.type === 'email' ? `mailto:${value}`
      : f.type === 'phone' ? `tel:${String(value).replace(/\s+/g, '')}`
        : withProtocol(value)

  return (
    <div style={{
      gridColumn: wide ? '1 / -1' : undefined,
      display: 'grid', gridTemplateColumns: '130px minmax(0, 1fr) auto',
      background: '#fff', minWidth: 0,
      // This cell's right and bottom rules. Drawn as an inset-free shadow so
      // they sit on the cell's edge without changing its size; the table's
      // own border and overflow:hidden absorb the outermost ones.
      boxShadow: '1px 0 0 var(--border-default), 0 1px 0 var(--border-default)'
    }}>
      <span style={{
        display: 'flex', alignItems: wide ? 'flex-start' : 'center', gap: 6,
        padding: '9px 10px', minWidth: 0,
        background: 'var(--gray-25)',
        borderRight: '1px solid var(--border-default)'
      }}>
        <span className="ms" style={{ fontSize: 15, color: 'var(--text-muted)', flex: 'none' }}>{icon}</span>
        <span className="pp-label" style={{ marginBottom: 0 }}>{f.label}</span>
      </span>

      <span style={{ display: 'grid', alignItems: 'center', padding: editing ? '5px 8px' : '9px 10px', minWidth: 0 }}>
        {editing ? (
          <FieldInput
            field={f}
            value={value}
            onChange={onChange}
            disabled={disabled}
            invalid={invalid}
            dirty={dirty}
          />
        ) : (
          <span title={empty ? undefined : String(value)} style={{
            fontSize: 'var(--text-md)',
            color: empty ? 'var(--text-faint)' : 'var(--text-body)',
            // The description keeps its line breaks; the rest stay one line.
            whiteSpace: wide ? 'pre-wrap' : 'nowrap',
            overflow: 'hidden', textOverflow: 'ellipsis', overflowWrap: 'anywhere'
          }}>
            {empty ? '…' : value}
          </span>
        )}
        {error && (
          <span style={{ display: 'block', marginTop: 4, fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)' }}>
            {error}
          </span>
        )}
      </span>

      <span style={{ display: 'flex', alignItems: wide ? 'flex-start' : 'center', gap: 2, padding: '6px 8px 6px 0' }}>
        {href && (
          <a
            href={href}
            target={f.type === 'email' || f.type === 'phone' ? undefined : '_blank'}
            rel="noreferrer noopener"
            title={f.type === 'email' ? `Email ${value}` : f.type === 'phone' ? `Call ${value}` : `Open ${value}`}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, color: 'var(--text-muted)', textDecoration: 'none'
            }}
          >
            <span className="ms" style={{ fontSize: 15 }}>
              {f.type === 'email' ? 'mail' : f.type === 'phone' ? 'call' : 'open_in_new'}
            </span>
          </a>
        )}
        {!isSelect && !open && (
          <button
            type="button"
            onClick={onOpen}
            disabled={disabled}
            title={`Edit ${f.label.toLowerCase()}`}
            aria-label={`Edit ${f.label.toLowerCase()}`}
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 24, height: 24, padding: 0, border: 'none', background: 'none',
              color: 'var(--text-muted)', cursor: disabled ? 'default' : 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>edit</span>
          </button>
        )}
      </span>
    </div>
  )
}

function FieldInput({ field: f, value, onChange, disabled, invalid, dirty }) {
  const empty = value == null || value === ''

  const box = {
    width: '100%', boxSizing: 'border-box',
    minHeight: 38,
    padding: '8px 11px',
    border: `1px solid ${
      invalid ? 'var(--status-stuck)'
        : dirty ? 'var(--brand-primary)'
          : 'var(--border-default)'
    }`,
    borderRadius: 'var(--radius-sm)',
    background: disabled ? 'var(--gray-50)' : '#fff',
    fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
    lineHeight: 1.45,
    color: 'var(--text-body)',
    outline: 'none',
    overflowWrap: 'anywhere'
  }

  const linkable = !empty && ['url', 'email', 'phone', 'domain'].includes(f.type)
  const href = !linkable ? null
    : f.type === 'email' ? `mailto:${value}`
      : f.type === 'phone' ? `tel:${String(value).replace(/\s+/g, '')}`
        : withProtocol(value)

  const control = f.type === 'multiline' ? (
    <textarea
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      rows={2}
      placeholder="Not set"
      style={{ ...box, resize: 'vertical' }}
    />
  ) : f.type === 'select' || f.type === 'country' ? (
    // antd's Select, not a <datalist>. The datalist this replaces looked like a
    // plain text box, and the list Chrome showed over it was its own autofill —
    // addresses, "Manage addresses…" — rather than anything we rendered.
    //
    // Full 247-country list, common ones grouped at the top. `label` holds
    // "United Kingdom (GB)" so optionFilterProp="label" matches on the name AND
    // the code without a custom filter.
    <Select
      // pp-dirty-select paints the same green border the text inputs get, via
      // antd's selector element — our `box` style cannot reach inside it.
      className={dirty ? 'pp-dirty-select' : undefined}
      value={value || undefined}
      onChange={(v) => onChange(v || '')}
      options={COUNTRY_OPTIONS}
      placeholder="Not set"
      disabled={disabled}
      showSearch
      allowClear
      optionFilterProp="label"
      status={invalid ? 'error' : undefined}
      style={{ width: '100%' }}
      // 247 rows — virtualise (antd does by default) and cap the height so the
      // list doesn't run off the panel.
      popupClassName="pp-menu"
      listHeight={280}
      notFoundContent="No country matches that"
    />
  ) : (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      disabled={disabled}
      placeholder={f.type === 'domain' ? 'example.com' : 'Not set'}
      style={box}
    />
  )

  if (!href) return control

  return (
    <span style={{ display: 'flex', alignItems: 'flex-start', gap: 5 }}>
      <span style={{ minWidth: 0, flex: 1 }}>{control}</span>
      <a
        href={href}
        target={f.type === 'email' || f.type === 'phone' ? undefined : '_blank'}
        rel="noreferrer noopener"
        title={
          f.type === 'email' ? `Email ${value}`
            : f.type === 'phone' ? `Call ${value}`
              : `Open ${value}`
        }
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          flex: 'none',
          width: 32, height: 38,
          border: '1px solid var(--border-default)',
          borderRadius: 'var(--radius-sm)',
          background: 'var(--gray-25)',
          color: 'var(--accent-sky)',
          textDecoration: 'none'
        }}
      >
        <span className="ms" style={{ fontSize: 16 }}>
          {f.type === 'email' ? 'mail' : f.type === 'phone' ? 'call' : 'open_in_new'}
        </span>
      </a>
    </span>
  )
}

// A bare domain in an href resolves relative to the current page, which inside
// the GHL iframe is not the site the user wanted.
function withProtocol(url) {
  return /^https?:\/\//i.test(url) ? url : `https://${url}`
}

function DealsPanel({ deals, onOpenDeal }) {
  return (
    <Panel
      icon="sell"
      title="Deals"
      accent="pine"
      meta={`${deals.length} ${deals.length === 1 ? 'deal' : 'deals'}`}
    >
      {deals.length === 0 ? (
        <EmptyLine text="No deals at this business yet." />
      ) : (
        deals.map((d, i) => (
          <Row key={d.id} last={i === deals.length - 1} align="center">
            <span className="ms" style={{ fontSize: 16, color: 'var(--accent-pine)', flex: 'none' }}>
              sell
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <Truncate style={{ display: 'block', fontSize: 'var(--text-md)', fontWeight: 600,
                  color: 'var(--text-heading)' }}>
                {d.name}
              </Truncate>
              {d.stage && (
                <span style={{ display: 'block', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                  {d.stage}
                </span>
              )}
            </span>
            <span
              style={{
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)',
                color: 'var(--text-heading)', flex: 'none',
                fontVariantNumeric: 'tabular-nums'
              }}
            >
              {formatMoney(d.value)}
            </span>
            {/* The same green chip Notes, Tasks and the Deals table use to
                open a deal. This was a ghost button reading "Open deal →" —
                the same action wearing a third different face, and the
                faintest of the three on the one surface where a business's
                deals are the point. */}
            <DealPill name={d.name || d.opportunityName} onClick={() => onOpenDeal?.(d.id)} />
          </Row>
        ))
      )}
    </Panel>
  )
}

function ContactsPanel({ contacts, businessId, onOpenContact, onLinked, onUnlinked }) {
  // The contact awaiting an unlink confirmation, or null.
  const [confirming, setConfirming] = useState(null)
  const [adding, setAdding] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)

  // THE REVERSE OF THE CONTACT PAGE'S LINK, and the same single write.
  //
  // contacts.business_id is the only link GHL has (migration 056), so
  // "add a contact to this company" is "set this company on that contact".
  // Offering it from both sides matters because a rep lands on whichever
  // record they were already looking at — before this, neither side could
  // create the link at all.
  const link = async (contactId) => {
    if (!contactId || busy) return
    setBusy(true); setError(null)
    try {
      await contactsAPI.update(contactId, { businessId })
      setAdding(false)
      // The parent refetches. Building the row here meant guessing the deal
      // count, the role, the initials and the accent — and the accent is a
      // server-side hash of the id, so it cannot be guessed correctly at all.
      onLinked && onLinked()
    } catch (err) {
      setError(err?.message || 'Could not link that contact')
    } finally {
      setBusy(false)
    }
  }

  // Unlink ONE contact — businessId: null, the same single write the contact
  // record's own chip makes.
  //
  // The contact itself is untouched: it keeps its deals and its history and
  // simply stops belonging to this business. That is worth saying on the
  // confirm, because "remove" next to a person reads like a delete.
  const unlink = async (contact) => {
    if (busy) return
    setBusy(true); setError(null)
    try {
      await contactsAPI.update(contact.id, { businessId: null })
      setConfirming(null)
      onUnlinked && onUnlinked()
    } catch (err) {
      setError(err?.message || 'Could not unlink that contact')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Panel
      icon="group"
      title="Contacts"
      // Sky, the contact colour — the design's band, and the same blue as
      // every View CONTACT pill.
      accent="sky"
      meta={`${contacts.length} ${contacts.length === 1 ? 'contact' : 'contacts'}`}
      action={
        adding ? (
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, minWidth: 260 }}>
            <ContactPicker
              value={null}
              onChange={link}
              seed={[]}
              // The ones already here are not candidates — offering them
              // invites a click that does nothing.
              exclude={contacts.map((c) => c.id)}
              showInitial
            />
            <button
              type="button"
              onClick={() => { setAdding(false); setError(null) }}
              disabled={busy}
              style={{
                height: 28, padding: '0 10px',
                border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-sm)',
                background: '#fff', fontFamily: 'var(--font-sans)',
                fontSize: 'var(--text-sm)', cursor: 'pointer'
              }}
            >
              Cancel
            </button>
          </span>
        ) : (
          <button
            type="button"
            onClick={() => setAdding(true)}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              height: 28, padding: '0 11px 0 8px',
              border: '1px dashed var(--border-strong)',
              borderRadius: 'var(--radius-pill)',
              background: 'var(--surface-card)', color: 'var(--text-body)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
              cursor: 'pointer'
            }}
          >
            {/* Coloured: the contact blue, matching the panel's header and
                its View CONTACT pills — it inherited the button's grey. */}
            <span className="ms" style={{ fontSize: 15, color: 'var(--accent-sky)' }}>person_add</span>
            Link a contact
          </button>
        )
      }
    >
      {error && (
        <p style={{
          margin: 0, padding: '8px var(--space-4)',
          fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)'
        }}>
          {error}
        </p>
      )}
      {contacts.length === 0 ? (
        <EmptyLine text="No contacts linked to this business." />
      ) : (
        contacts.map((c, i) => (
          <Row key={c.id} last={i === contacts.length - 1} align="center">
            <span
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 30, height: 30, flex: 'none',
                borderRadius: '50%',
                background: `var(--tint-${c.accent})`,
                color: `var(--accent-${c.accent}-text)`,
                fontSize: 'var(--text-sm)', fontWeight: 600
              }}
            >
              {c.initials}
            </span>
            <span style={{ minWidth: 0, flex: 1 }}>
              <Truncate style={{ display: 'block', fontSize: 'var(--text-md)', fontWeight: 600,
                  color: 'var(--text-heading)' }}>
                {c.name}
              </Truncate>
              <span style={{ display: 'block', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
                {[
                  c.role,
                  // Number()-guarded: the template literal is ALWAYS truthy,
                  // so .filter(Boolean) cannot catch a missing count — it
                  // printed "undefined deals" under the name instead.
                  Number.isFinite(Number(c.dealCount))
                    ? `${Number(c.dealCount)} ${Number(c.dealCount) === 1 ? 'deal' : 'deals'}`
                    : null
                ].filter(Boolean).join(' · ')}
              </span>
            </span>
            {/* The shared View CONTACT pill, as the design draws it — the
                same control every other surface uses to open a person. */}
            <RecordPill kind="CONTACT" name={c.name} onClick={onOpenContact ? () => onOpenContact(c.id) : undefined} />
            {/* Icon only, and muted: unlinking is the rarer of the two
                actions on this row, and a second full-width button beside
                "Record" would read as its equal. */}
            <button
              type="button"
              onClick={() => { setError(null); setConfirming(c) }}
              disabled={busy}
              title={`Unlink ${c.name} from this business`}
              aria-label={`Unlink ${c.name} from this business`}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 30, height: 30, flex: 'none',
                border: '1px solid var(--border-default)',
                borderRadius: '50%',
                background: 'var(--surface-card)',
                color: 'var(--text-muted)',
                cursor: busy ? 'default' : 'pointer'
              }}
            >
              <span className="ms" style={{ fontSize: 16 }}>link_off</span>
            </button>
          </Row>
        ))
      )}

      {confirming && (
        <ConfirmDialog
          title="Unlink this contact?"
          // Says what SURVIVES, not just what changes: next to a person's
          // name, "remove" reads like a delete, and this deletes nothing.
          message={
            'They stay in the CRM with their deals and history — they just stop '
            + 'being linked to this business.'
          }
          preview={confirming.name}
          confirmLabel="Unlink"
          busy={busy}
          error={error}
          onConfirm={() => unlink(confirming)}
          onCancel={() => { setConfirming(null); setError(null) }}
        />
      )}
    </Panel>
  )
}

// ── Conversations ─────────────────────────────────────────────────────

const CHANNELS = ['EMAIL', 'SMS', 'WHATSAPP', 'CALL']

function ConversationsPanel({ businessId, total, dealCount, onOpenDeal }) {
  // The attachment lightbox, hosted on the panel so paging through a
  // message's files works as it does on the deal timeline.
  const [viewing, setViewing] = useState(null)
  const [channel, setChannel] = useState(null)

  const fetchPage = useCallback(
    ({ cursor }) =>
      businessesAPI.conversations(businessId, {
        ...(channel ? { channel } : {}),
        ...(cursor ? { cursor } : {})
      }),
    [businessId, channel]
  )

  const { items, error, hasMore, loadingMore, loadMore } = usePagedList({
    fetchPage,
    key: 'messages',
    deps: [businessId, channel]
  })

  const sentinelRef = useInfiniteScroll(loadMore, { enabled: hasMore && !loadingMore })

  // Both counts come from the server already coerced to numbers, so this
  // normally just formats them. The guards are for the case where they do NOT
  // arrive — an older cached bundle, or a response shape that changed — where
  // a template literal would print "undefined across undefined deals" in the
  // panel header. A count we cannot state is better left unsaid than stated
  // wrongly, so the line is dropped entirely rather than showing a zero we
  // have not actually counted.
  const meta = useMemo(() => {
    if (channel) return `${channel.toLowerCase()} only`
    const n = Number(total)
    const d = Number(dealCount)
    if (!Number.isFinite(n)) return null
    if (!Number.isFinite(d)) return `${n} ${n === 1 ? 'message' : 'messages'}`
    return `${n} across ${d} ${d === 1 ? 'deal' : 'deals'}`
  }, [channel, total, dealCount])

  return (
    <Panel
      icon="forum"
      title="Conversations"
      // Grey — the design's band. Teal was a sixth colour for a panel that
      // is the page's reading area, not a kind of record.
      accent="gray"
      meta={meta}
      toolbar={
        <>
          <ChannelChip label="All" active={!channel} onClick={() => setChannel(null)} />
          {CHANNELS.map((c) => (
            <ChannelChip
              key={c}
              label={titleCase(c)}
              active={channel === c}
              onClick={() => setChannel(channel === c ? null : c)}
            />
          ))}
        </>
      }
    >

      {error && <EmptyLine text={error} />}
      {items === null && !error && <ConversationSkeleton />}
      {items?.length === 0 && (
        <EmptyLine
          text={channel ? `No ${titleCase(channel)} messages at this business.` : 'No messages yet.'}
        />
      )}

      {items?.map((m, i) => (
        <MessageRow
          key={m.id}
          message={m}
          last={i === items.length - 1 && !hasMore}
          onOpenDeal={onOpenDeal}
          onOpenAttachment={(atts, idx) => setViewing({ attachments: atts, index: idx })}
        />
      ))}

      {viewing && (
        <AttachmentViewer
          attachments={viewing.attachments}
          index={viewing.index}
          onClose={() => setViewing(null)}
        />
      )}

      {items?.length > 0 && (
        <div style={{ padding: '0 var(--space-4)' }}>
          <LoadMore
            sentinelRef={sentinelRef}
            hasMore={hasMore}
            loadingMore={loadingMore}
            count={items.length}
            noun="message"
          />
        </div>
      )}
    </Panel>
  )
}

function MessageRow({ message: m, last, onOpenDeal, onOpenAttachment }) {
  const inbound = m.direction === 'in'
  return (
    <Row last={last}>
      <span
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 30, height: 30, flex: 'none',
          border: `1px solid var(--accent-${m.channelAccent})`,
          borderRadius: 'var(--radius-sm)',
          background: `var(--tint-${m.channelAccent})`,
          color: `var(--accent-${m.channelAccent})`
        }}
      >
        <span className="ms" style={{ fontSize: 16 }}>{m.channelIcon}</span>
      </span>

      <span style={{ minWidth: 0, flex: 1 }}>
        <span
          style={{
            display: 'flex', alignItems: 'baseline', gap: 'var(--space-2)',
            flexWrap: 'wrap', marginBottom: 3
          }}
        >
          <span
            style={{
              fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
              textTransform: 'uppercase',
              color: `var(--accent-${m.channelAccent})`
            }}
          >
            {m.channel}
          </span>
          {/* Direction as an arrow as well as a word — at a glance the arrow is
              what separates "they wrote" from "we wrote". */}
          <span
            style={{
              fontSize: 'var(--text-sm)', fontWeight: 600,
              color: inbound ? 'var(--accent-clay)' : 'var(--text-muted)'
            }}
          >
            {inbound ? 'In ←' : '→ Out'}
          </span>
          <span style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-heading)' }}>
            {m.who}
          </span>
          <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
            {formatDate(m.timestamp)}
          </span>
        </span>

        <span
          style={{
            display: 'block',
            fontSize: 'var(--text-md)', lineHeight: 1.5,
            color: m.body ? 'var(--text-body)' : 'var(--text-faint)',
            fontStyle: m.body ? 'normal' : 'italic'
          }}
        >
          {m.body || 'No content'}
        </span>

        {/* Every channel, not just non-email: this row has no EmailBody to
            render an email's own chips, so without this an email's files
            appear on the deal timeline and nowhere else. */}
        {m.attachments?.length > 0 && (
          <span style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginTop: 5 }}>
            {m.attachments.map((att, i) => (
              <AttachmentChip
                key={`${att.name}-${i}`}
                att={att}
                channelAccent={m.channelAccent}
                onClick={() => onOpenAttachment && onOpenAttachment(m.attachments, i)}
              />
            ))}
          </span>
        )}
      </span>

      {/* An unattributed message is the point of this page — flag it rather
          than leaving a blank space where every other row has a deal. */}
      {m.dealId ? (
        <Chip icon="sell" tone="deal" onClick={() => onOpenDeal?.(m.dealId)}>
          {m.dealName || 'Deal'}
        </Chip>
      ) : (
        <Chip icon="link_off" title="Not attributed to any deal">Unassigned</Chip>
      )}
    </Row>
  )
}

function ChannelChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        cursor: 'pointer',
        height: 28, padding: '0 var(--space-3)',
        border: active ? '1px solid var(--brand-primary)' : '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-pill)',
        background: active ? 'var(--brand-primary)' : '#fff',
        color: active ? '#fff' : 'var(--text-body)',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-base)',
        fontWeight: active ? 600 : 400
      }}
    >
      {label}
    </button>
  )
}

// ── Bits ──────────────────────────────────────────────────────────────


function EmptyLine({ text }) {
  return (
    <p
      style={{
        margin: 0, padding: '14px var(--space-4)',
        fontSize: 'var(--text-md)', color: 'var(--text-muted)'
      }}
    >
      {text}
    </p>
  )
}

function formatMoney(v) {
  if (v == null) return '—'
  return `£${Number(v).toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
}

function titleCase(s) {
  if (s === 'SMS') return 'SMS'
  return s.charAt(0) + s.slice(1).toLowerCase()
}

// ── Skeletons ─────────────────────────────────────────────────────────

function ListSkeleton() {
  return (
    <>
      <SkeletonStyles />
      <div style={{ display: 'grid', gap: 'var(--space-3)' }}>
        {Array.from({ length: 5 }).map((_, i) => (
          <div
            key={i}
            style={{
              display: 'flex', alignItems: 'center', gap: 11,
              padding: '14px var(--space-4)',
              border: '1px solid var(--border-strong)',
              borderRadius: 'var(--radius-md)',
              background: '#fff'
            }}
          >
            <Bar w={20} h={20} style={{ flex: 'none' }} />
            <div style={{ flex: 1, display: 'grid', gap: 6 }}>
              <Bar w={`${45 + ((i * 13) % 25)}%`} h={14} />
              <Bar w="30%" h={11} />
            </div>
            <Bar w={78} h={22} r="var(--radius-pill)" style={{ flex: 'none' }} />
            <Bar w={62} h={22} r="var(--radius-pill)" style={{ flex: 'none' }} />
          </div>
        ))}
      </div>
    </>
  )
}

function DetailSkeleton() {
  return (
    <>
      <SkeletonStyles />
      <div style={{ display: 'grid', gap: 18 }}>
        <div
          style={{
            border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: 'var(--accent-sky-text)',
        ['--panel-tint']: 'var(--tint-sky)',
            borderRadius: 'var(--radius-md)',
            background: '#fff', overflow: 'hidden'
          }}
        >
          <div style={{ display: 'flex', gap: 9, padding: 'var(--space-3) var(--space-4)', alignItems: 'center' }}>
            <Bar w={20} h={20} style={{ flex: 'none' }} />
            <Bar w={220} h={16} />
          </div>
          <div
            style={{
              display: 'grid', gap: 14,
              gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
              padding: 16
            }}
          >
            {Array.from({ length: 10 }).map((_, i) => (
              <div key={i} style={{ display: 'grid', gap: 6 }}>
                <Bar w="55%" h={9} />
                <Bar w="100%" h={38} r="var(--radius-sm)" />
              </div>
            ))}
          </div>
        </div>
        <div
          style={{
            display: 'grid', gap: 18,
            gridTemplateColumns: 'repeat(auto-fit, minmax(340px, 1fr))'
          }}
        >
          {['pine', 'clay'].map((a) => (
            <div
              key={a}
              style={{
                border: '1px solid var(--border-default)',
                boxShadow: 'var(--shadow-card)',
                borderRadius: 'var(--radius-md)',
                background: '#fff', overflow: 'hidden'
              }}
            >
              <div style={{ display: 'flex', gap: 9, padding: 'var(--space-3) var(--space-4)', alignItems: 'center' }}>
                <Bar w={20} h={20} style={{ flex: 'none' }} />
                <Bar w={110} h={15} />
              </div>
              {[0, 1].map((i) => (
                <div
                  key={i}
                  style={{
                    display: 'flex', gap: 'var(--space-3)', alignItems: 'center',
                    padding: '13px var(--space-4)',
                    borderTop: '1px solid var(--border-default)'
                  }}
                >
                  <Bar w={30} h={30} r="50%" style={{ flex: 'none' }} />
                  <div style={{ flex: 1, display: 'grid', gap: 5 }}>
                    <Bar w="60%" h={13} />
                    <Bar w="35%" h={11} />
                  </div>
                </div>
              ))}
            </div>
          ))}
        </div>
      </div>
    </>
  )
}

function ConversationSkeleton() {
  return (
    <>
      <SkeletonStyles />
      {Array.from({ length: 4 }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex', gap: 'var(--space-3)', padding: '13px var(--space-4)',
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          <Bar w={30} h={30} r="var(--radius-sm)" style={{ flex: 'none' }} />
          <div style={{ flex: 1, display: 'grid', gap: 6 }}>
            <Bar w="42%" h={11} />
            <Bar w={`${70 + ((i * 7) % 25)}%`} h={13} />
          </div>
          <Bar w={92} h={22} r="var(--radius-pill)" style={{ flex: 'none' }} />
        </div>
      ))}
    </>
  )
}
