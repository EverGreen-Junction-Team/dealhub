import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Spin } from 'antd'
import { contactsAPI } from '../../api/contacts'
import { initialsFor, Truncate } from './ListChrome'

// Pick the contact a task or note belongs to.
//
// WHY THIS EXISTS. Tasks and notes are stored against a CONTACT in GHL, so
// creating either needs one. On the Deal Hub that's easy — the deal supplies its
// people. On the standalone Tasks and Notes pages there is no deal in scope, and
// the editors were being handed an empty list: the Select rendered disabled with
// "No contacts", so a task could not be created there at all.
//
// Searches OUR contacts table (GET /api/contacts?q=), not GHL's endpoint
// directly. Three reasons: it runs under RLS so a search can only ever return
// this sub-account's people, it matches name, email, phone AND business in one
// query, and it doesn't spend a GHL API call per keystroke.
//
// `options` are seeded from whatever the caller already has (a deal's people),
// so the common case needs no request at all.

const DEBOUNCE_MS = 250
const PAGE = 20

export default function ContactPicker({
  value,
  onChange,
  // Contacts the caller already holds — a deal's people. Shown before any
  // search, so picking from a deal stays a single click.
  seed = [],
  // Contact ids to REMOVE from every list. The deal's existing people, so the
  // picker cannot offer someone who is already on it — previously a duplicate
  // was only caught after the click, as an error message, which made the user
  // do the work of remembering who was already there.
  exclude = [],
  // Load a first page before anything is typed.
  //
  // DEFAULTS ON. Without it the dropdown opens on "Start typing to find a
  // contact", which is a dead end for a rep who does not know who is in the
  // CRM — most sub-accounts have few enough contacts that the first page IS
  // the answer. Two callers were opting in and four were not, so the same
  // control behaved differently depending on where it was opened.
  //
  // Pass false only where an empty list is genuinely the right first screen.
  showInitial = true,
  disabled,
  invalid,
  autoFocus
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)

  // The contact currently chosen, kept so its label survives a new search that
  // doesn't include it — otherwise the box would go blank mid-edit.
  const [chosen, setChosen] = useState(null)

  const reqId = useRef(0)

  useEffect(() => {
    const q = query.trim()
    // An empty query still fetches when showInitial is set: the server treats
    // a missing `q` as "first page, ordered by name", which is what a rep
    // opening the box with no one in mind actually wants.
    if (!q && !showInitial) {
      setResults([])
      setLoading(false)
      return
    }
    setLoading(true)
    setError(false)
    const id = ++reqId.current
    const t = window.setTimeout(() => {
      contactsAPI.list({ ...(q ? { q } : {}), limit: PAGE })
        .then((res) => {
          // Ignore a response that arrived after a newer one — typing fast
          // otherwise leaves an earlier query's results on screen.
          if (id !== reqId.current) return
          setResults(res.contacts || [])
        })
        .catch(() => { if (id === reqId.current) setError(true) })
        .finally(() => { if (id === reqId.current) setLoading(false) })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, showInitial])

  const options = useMemo(() => {
    const seen = new Set()
    // Anyone already linked. Filtered OUT of the list rather than rejected
    // after the click: offering someone who cannot be picked makes the reader
    // do the remembering.
    const blocked = new Set(exclude.filter(Boolean))

    const rows = []
    // Chosen first so it is always present, then the seed, then results.
    for (const c of [chosen, ...seed, ...results].filter(Boolean)) {
      if (!c.id || seen.has(c.id)) continue
      // The CURRENT value is never excluded — in an editor the contact already
      // on the task is in `exclude` by definition, and dropping it would blank
      // the field the moment the list refreshed.
      if (blocked.has(c.id) && c.id !== value) continue
      seen.add(c.id)
      rows.push({ value: c.id, label: labelFor(c), contact: c })
    }
    return rows.map(({ value: v, label, contact }) => ({
      value: v,
      label,
      // Two lines, like GHL's own user picker: who they are, then how to tell
      // them apart. A list of "Contact / lead" rows is unusable.
      title: label,
      renderLabel: contact
    }))
  }, [chosen, seed, results, exclude, value])

  return (
    <Select
      className={invalid ? 'pp-invalid-select' : undefined}
      value={value || undefined}
      onChange={(v, opt) => {
        setChosen(opt?.renderLabel || null)
        onChange(v || '')
      }}
      onSearch={setQuery}
      // Server-side search — antd must not also filter the results it was given,
      // or a match on phone or business gets hidden because the visible label
      // doesn't contain the query.
      filterOption={false}
      options={options}
      optionRender={(opt) => <ContactRow contact={opt.data.renderLabel} />}
      labelRender={(opt) => opt.label}
      showSearch
      // THE SPINNER GOES IN THE SUFFIX, not only in notFoundContent.
      //
      // notFoundContent is rendered by antd ONLY when the option list is
      // empty. Typing forward narrows a query while the previous results are
      // still on screen, so there was always something to render and the
      // spinner never appeared — but backspacing often widens to a query with
      // no cached match, the list empties, and it did. Hence "the loader only
      // shows on backspace".
      //
      // `loading` puts it in the control itself, where it is visible whether
      // or not options are showing.
      loading={loading}
      allowClear
      disabled={disabled}
      autoFocus={autoFocus}
      placeholder="Search by name, email, phone or business"
      style={{ width: '100%' }}
      popupClassName="pp-menu"
      listHeight={300}
      notFoundContent={
        loading ? (
          <div style={{ padding: 14, textAlign: 'center' }}>
            <Spin size="small" />
          </div>
        ) : error ? (
          <Empty>Could not search contacts — try again</Empty>
        ) : query.trim() ? (
          <Empty>No contact matches “{query.trim()}”</Empty>
        ) : exclude.length ? (
          // Only when the caller is EXCLUDING people — the deal's existing
          // contacts. Now that showInitial defaults on, this branch was also
          // reached from the Tasks and Notes filters, where there is no deal
          // and nothing is excluded, so it told a rep their sub-account had no
          // contacts left.
          <Empty>Everyone in this account is already on this deal</Empty>
        ) : (
          <Empty>No contacts in this sub-account yet</Empty>
        )
      }
    />
  )
}

function Empty({ children }) {
  return (
    <div
      style={{
        padding: '14px 12px',
        fontSize: 'var(--text-md)', color: 'var(--text-muted)',
        textAlign: 'center'
      }}
    >
      {children}
    </div>
  )
}

// Name on top, the distinguishing detail beneath — the shape GHL's own user
// picker uses, and the only way a list of leads is tellable apart.
// One row in the dropdown: avatar, name, and the detail that tells two people
// with the same name apart.
//
// The avatar is what the row was missing. A list of names with no visual
// anchor is slower to scan than the same list with initials — the eye lands on
// colour before it reads text. `accent` is hashed from the contact id server
// side, so the same person is the same colour on every surface (the deal
// card's pills use the same rule).
function ContactRow({ contact: c }) {
  if (!c) return null
  const detail = [c.email, c.phone, c.business].filter(Boolean)[0]
  const accent = c.accent || 'sky'
  return (
    <span style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
      <span
        aria-hidden="true"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          width: 30, height: 30, flex: 'none',
          borderRadius: '50%',
          background: `var(--tint-${accent})`,
          color: `var(--accent-${accent}-text)`,
          fontSize: 'var(--text-sm)', fontWeight: 600,
          letterSpacing: '0.02em'
        }}
      >
        {initialsFor(c.firstName, c.lastName, nameOf(c))}
      </span>
      <span style={{ display: 'block', minWidth: 0, flex: 1 }}>
        <Truncate style={{ display: 'block',
            fontSize: 'var(--text-md)', fontWeight: 500, color: 'var(--text-heading)' }}>
          {nameOf(c)}
        </Truncate>
        {detail && (
          <Truncate style={{ display: 'block', marginTop: 1,
              fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {detail}
          </Truncate>
        )}
      </span>
    </span>
  )
}

// Never a bare phone number as a name — it reads as a data error. Falls through
// the same chain the contact cards use.
function nameOf(c) {
  const full = [c.firstName, c.lastName].filter(Boolean).join(' ').trim()
  if (full) return full
  if (c.name) return c.name
  if (c.business) return c.business
  if (c.email) return c.email
  if (c.phone) return c.phone
  return 'Unnamed contact'
}

// The collapsed label, once chosen. Carries the detail too, so the closed box
// still says which of two people called James this is.
function labelFor(c) {
  const name = nameOf(c)
  const detail = [c.email, c.phone, c.business].filter(Boolean)[0]
  return detail && detail !== name ? `${name} · ${detail}` : name
}
