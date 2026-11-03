import React, { useEffect, useMemo, useState } from 'react'
import { Select } from 'antd'
import { dealsAPI } from '../../api/deals'
import { useAuth } from '../../context/AuthContext'
import { TAG_CACHE } from './tagCatalogue'
import { contactsAPI } from '../../api/contacts'

// Owner and tag filters, shared by Contacts, Deals and Tasks.
//
// WHY THE OWNER FILTER DEFAULTS TO THE SIGNED-IN USER.
// A rep opening Deals wants their own deals. Before this, all three tabs
// opened on the whole sub-account and a rep with 14 deals scrolled past 300 to
// find them — the filter existed in the API and had no control in the UI at
// all.
//
// The default is applied ONCE, on first mount, and the choice is then
// remembered per tab by useTabState (2-hour expiry, so a new session starts
// clean). That matters for a manager: they switch to "All owners" once and it
// stays, rather than fighting a default that reasserts itself on every visit.
//
// "Mine" IS a preselected row in the list, labelled.
//
// It was briefly a separate sentinel value resolved to an id at request time.
// That split one fact across two representations and they immediately
// disagreed — see the note on OwnerFilter. The signed-in user's own id is the
// value; "Mine" is what their row is called.

export const ALL = ''
export const UNASSIGNED = 'unassigned'

// The value to send to the API.
//
// The value IS the user id now (see OwnerFilter), so this only strips the
// empty "All owners" case. Kept as a function because every tab calls it, and
// because the place to add any future special value is here rather than in
// three fetch bodies.
export function resolveOwner(value) {
  return value || undefined
}

// Users are location-wide and change rarely, so one fetch serves every tab for
// the session — three tabs each fetching on mount was three identical requests
// for a list that had not changed.
const USER_CACHE = { users: null, promise: null }

// Exported for the task editor's Assign to picker — one cached user list.
export function useUsers() {
  const [users, setUsers] = useState(USER_CACHE.users || [])
  useEffect(() => {
    // NO EARLY RETURN WHEN THE CACHE IS WARM.
    //
    // This read `if (USER_CACHE.users) return`, which looked like a harmless
    // skip and was the bug that put a raw user id on screen. The window is
    // narrow but routine: the useState initialiser runs, reads a null cache
    // and sets []; the shared fetch RESOLVES; then this effect runs, sees a
    // populated cache and returns without ever calling setUsers. The component
    // holds [] for its whole life, so the selected id matches no option and
    // antd renders the id itself.
    //
    // It only ever bit the tabs that also fetch users themselves — their own
    // request warms this cache in exactly that gap — which is why Contacts
    // showed the id while its own filter chip showed "J srini" from the same
    // data.
    if (USER_CACHE.users) { setUsers(USER_CACHE.users); return }
    if (!USER_CACHE.promise) {
      USER_CACHE.promise = dealsAPI.users()
        .then((r) => { USER_CACHE.users = r?.users || r || []; return USER_CACHE.users })
        // A failed user list must not take the page with it: the filter falls
        // back to All / Unassigned, which need no lookup.
        .catch(() => { USER_CACHE.users = []; return [] })
    }
    let alive = true
    USER_CACHE.promise.then((u) => { if (alive) setUsers(u) })
    return () => { alive = false }
  }, [])
  return users
}

// Exported for the list views' Tags chip — one cached tag catalogue.
export function useTags() {
  const [tags, setTags] = useState(TAG_CACHE.tags || [])
  useEffect(() => {
    // Same as useUsers: setting state rather than returning, or a cache that
    // warms between the initialiser and this effect leaves the control empty.
    if (TAG_CACHE.tags) { setTags(TAG_CACHE.tags); return }
    if (!TAG_CACHE.promise) {
      // Same shape TagSelect stores: an array of NAMES, not objects. Sharing
      // the cache means whichever control mounts first pays for the fetch and
      // the other is instant — and a tag a rep invents in the editor shows up
      // in this filter without a reload.
      TAG_CACHE.promise = contactsAPI.tagCatalogue()
        .then((r) => {
          TAG_CACHE.tags = (r?.tags || []).map((t) => t.name).filter(Boolean)
          return TAG_CACHE.tags
        })
        .catch(() => { TAG_CACHE.tags = []; return [] })
    }
    let alive = true
    TAG_CACHE.promise.then((t) => { if (alive) setTags(t) })
    return () => { alive = false }
  }, [])
  return tags
}

export function OwnerFilter({
  value, onChange, label = 'Owner', width = 190,
  // Render the SELECT ONLY, with no label beside it.
  //
  // The Tasks toolbar stacks each label above its control, so this one's own
  // inline label would be a second "Assignee" sitting next to the stacked
  // one. The label is not dropped — it moves to the caller.
  bare = false,
  // What the "everyone" and "nobody" options are CALLED.
  //
  // "All owners" is right on Contacts and Deals, where a record is owned. A
  // task is ASSIGNED to someone and a note was WRITTEN by someone — calling
  // either an owner invites a rep to expect a reassignment that does not
  // exist on notes at all. The control is the same; only the words change.
  allLabel = null, noneLabel = 'Unassigned'
}) {
  const { session } = useAuth()
  const users = useUsers()
  const myId = session?.user?.id || null

  // THE VALUE IS ALWAYS A REAL USER ID, NEVER A TOKEN.
  //
  // This first shipped with a MINE sentinel that the caller resolved to an id
  // at request time. Two things went wrong. The tabs seed the filter with the
  // raw id (so the value was never MINE), and this list then filtered the
  // signed-in user OUT of the options on the grounds that "Mine" covered them
  // — leaving a selected value with no matching option, which antd renders as
  // the raw id: "h07KvFvGuKUVREXi...".
  //
  // So the id IS the value, the signed-in user stays in the list, and "Mine"
  // is only a LABEL on their row. One representation, nothing to resolve, and
  // no way for the two to disagree.
  const me = myId ? users.find((u) => u.id === myId) : null

  const options = useMemo(() => {
    const head = [
      { value: ALL, label: allLabel || `All ${label.toLowerCase()}s` },
      { value: UNASSIGNED, label: noneLabel }
    ]
    // Your own row first and labelled, so the common choice is reachable
    // without reading a list of colleagues to find yourself in it.
    if (myId) {
      head.unshift({
        value: myId,
        label: me ? `Mine (${me.name || me.email || 'you'})` : 'Mine'
      })
    }
    const rest = users
      .filter((u) => u.id && u.id !== myId)
      .map((u) => ({ value: u.id, label: u.name || u.email || u.id }))
    return rest.length ? [...head, { label: '──────────', options: rest }] : head
  }, [users, myId, me, label, allLabel, noneLabel])

  // A value that is not ALL, not UNASSIGNED, and not a user we know.
  //
  // Three ways to get here: the list is still loading (transient, resolves in
  // a moment); the owner has left the sub-account (real, and their records are
  // still theirs); or a snapshot from an older build is holding a value whose
  // meaning changed — '__mine__' survived in localStorage past the release
  // that removed it, and every request carried it to an API that matched
  // nothing.
  //
  // Only the last is a fault, and it is the one worth clearing automatically:
  // a value the API cannot match returns an empty list forever, and nothing on
  // screen suggests the filter is the reason.
  const loading = users.length === 0
  const orphaned = !loading && value && value !== ALL && value !== UNASSIGNED
    && !users.some((u) => u.id === value)

  useEffect(() => {
    // Not a user id at all — a leftover sentinel. Anything that looks like a
    // GHL id is left alone: a departed colleague's records are still real, and
    // silently widening someone's filter would be worse than showing nothing.
    if (orphaned && !/^[A-Za-z0-9]{15,}$/.test(String(value))) onChange(ALL)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [orphaned, value])

  return (
    <span style={bare
      ? { display: 'inline-flex' }
      : { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      {!bare && (
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{label}</span>
      )}
      <Select
        value={value}
        onChange={onChange}
        options={options}
        popupClassName="pp-menu"
        style={{ width }}
        styles={{ root: { height: 34 } }}
        // Wider than the control, for the same reason as the tag filter — but
        // less so: these are names, not phrases. "Mine (Charlotte
        // Fitzgerald-Smythe)" is about as long as it gets and needs ~250px.
        popupMatchSelectWidth={260}
        // antd renders the raw value when nothing matches. While the list
        // loads that is a flash of a 24-character id; for a departed user it
        // is permanent. Neither belongs on screen.
        // Short enough for a 190px control — the full sentence goes in the
        // tooltip rather than being truncated to "Former owne…".
        labelRender={(o) => o?.label ?? (loading ? 'Loading\u2026' : 'Former owner')}
        title={orphaned
          ? 'This owner is no longer in the sub-account. Their records are still here — pick another owner or All owners to move on.'
          : undefined}
      />
    </span>
  )
}

export function TagFilter({
  value, onChange, label = 'Tag', width = 170,
  // Select only, for a toolbar that stacks its own label above — see
  // OwnerFilter's `bare`.
  bare = false
}) {
  const tags = useTags()
  const options = useMemo(() => ([
    { value: '', label: 'Any tag' },
    ...[...tags].sort((a, b) => String(a).localeCompare(String(b)))
      .map((name) => ({ value: name, label: name }))
  ]), [tags])

  // No tags in the account = nothing to filter by. Rendering an empty dropdown
  // invites a rep to open it, find nothing and wonder what broke.
  if (tags.length === 0) return null

  return (
    <span style={bare
      ? { display: 'inline-flex' }
      : { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      {!bare && (
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{label}</span>
      )}
      <Select
        value={value}
        onChange={onChange}
        options={options}
        popupClassName="pp-menu"
        // Searchable: an account with 80 tags is a scroll, not a pick.
        showSearch
        optionFilterProp="label"
        style={{ width }}
        styles={{ root: { height: 34 } }}
        // THE PANEL IS WIDER THAN THE CONTROL.
        //
        // antd matches the dropdown to the select's width by default, which is
        // right for short options and wrong here: these are GHL tags, and this
        // account's run to whole phrases — "(high) projects expected this
        // month" wrapped onto three lines inside a 160px panel, so four tags
        // filled the list and picking one meant reading a paragraph.
        //
        // A number, not `false`: false sizes the panel to its longest option,
        // which a 60-character tag would drag across half the screen. 340px
        // fits the realistic cases on one or two lines and stops there.
        popupMatchSelectWidth={340}
        // Long tags still need to wrap rather than be clipped — a truncated
        // tag is unpickable, since the part that distinguishes it is usually
        // at the end ("… expected this month" vs "… expected next month").
        optionRender={(opt) => (
          <span style={{ whiteSpace: 'normal', lineHeight: 1.35 }}>
            {opt.label}
          </span>
        )}
      />
    </span>
  )
}


// Sort order, as a dropdown.
//
// Shared rather than written per tab because the two that need it have
// different toolbars — Tasks has antd Selects and a Label helper, Notes has
// neither — and a second hand-rolled version would drift in width, height and
// wording the first time either was touched.
//
// The OPTIONS are the caller's: "Due date / Date created" means something on
// tasks and nothing on notes, where the real choice is when it was written
// versus when we synced it.
export function SortSelect({
  value, onChange, options, label = 'Sort', width = 160,
  // Select only — the Tasks toolbar stacks its label above, and this one's
  // own inline label would be a second "Sort" beside it. Same reasoning as
  // OwnerFilter's `bare`.
  bare = false
}) {
  return (
    <span style={bare
      ? { display: 'inline-flex' }
      : { display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)' }}>
      {!bare && (
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>{label}</span>
      )}
      <Select
        value={value}
        onChange={onChange}
        options={options}
        popupClassName="pp-menu"
        style={{ width }}
        styles={{ root: { height: 34 } }}
      />
    </span>
  )
}

// The default a tab starts on: your own records if we know who you are,
// everything if we do not — an empty list with no explanation is the worse
// failure.
export function defaultOwner(session) {
  return session?.user?.id || ALL
}
