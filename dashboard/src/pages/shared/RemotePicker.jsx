import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Select, Spin } from 'antd'

// A Select whose options come from a SERVER search, not a preloaded list.
//
// WHY THIS EXISTS. The deal and company pickers on the note and task editors
// had `showSearch`, which looked right and wasn't: the options came from
// useLinkTargets, which fetches the first 200 records once. Typing filtered
// those 200 client-side, so on a location with more than that the rest were
// unreachable and nothing said so. Search that appears to cover the data but
// silently doesn't is worse than no search.
//
// Both /api/deals and /api/businesses already accept `q` and run it under RLS,
// so the fix is to ask the server. This is ContactPicker's pattern generalised
// rather than copied a third time — same debounce, same out-of-order guard,
// same "keep the chosen option visible" behaviour.
//
// THE THREE THINGS A REMOTE PICKER HAS TO GET RIGHT, and why each is here:
//
//   1. Debounce. One request per keystroke would be a request per keystroke.
//   2. An out-of-order guard. Responses do not arrive in the order they were
//      sent, so a slow early query can overwrite a fast later one and leave
//      the wrong results on screen. reqId fixes the winner.
//   3. Keep the selected option. antd renders the raw value when no option
//      matches it, so a search that no longer returns the current selection
//      makes the box show a bare id. `chosen` pins it.

const DEBOUNCE_MS = 250

export default function RemotePicker({
  value,
  onChange,
  // (query) => Promise<[{ value, label }]>. Owning the mapping here rather
  // than passing a raw endpoint keeps the caller's field names out of this
  // component — deals and businesses shape their rows differently.
  search,
  // Options to show before anything is typed: whatever the caller already has
  // loaded. The common case then needs no request at all.
  seed = [],
  // Load a first page before anything is typed. DEFAULTS ON, matching
  // ContactPicker — a picker that shows nothing until you guess a search term
  // is a dead end. Pass false where an empty list is genuinely correct.
  showInitial = true,
  placeholder,
  disabled = false,
  allowClear = true,
  invalid = false,
  emptyText = 'No matches',
  style
}) {
  const [query, setQuery] = useState('')
  const [results, setResults] = useState([])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(false)
  // The option currently selected, kept even when it falls out of the result
  // set — see point 3 above.
  const [chosen, setChosen] = useState(null)

  const reqId = useRef(0)

  useEffect(() => {
    const q = query.trim()
    // An empty query still FETCHES when showInitial is set.
    //
    // Without it the dropdown opened on "Type to search", which is a dead end
    // for a rep who does not know what is in the CRM — the same problem the
    // contact picker had, and the same fix, under the same prop name.
    if (!q && !showInitial) {
      setResults([])
      setLoading(false)
      setError(false)
      return
    }
    setLoading(true)
    setError(false)
    const id = ++reqId.current
    const t = window.setTimeout(() => {
      Promise.resolve(search(q))
        .then((rows) => {
          if (id !== reqId.current) return
          setResults(Array.isArray(rows) ? rows : [])
        })
        .catch(() => { if (id === reqId.current) setError(true) })
        .finally(() => { if (id === reqId.current) setLoading(false) })
    }, DEBOUNCE_MS)
    return () => window.clearTimeout(t)
  }, [query, search, showInitial])

  const options = useMemo(() => {
    const seen = new Set()
    const rows = []
    // Chosen first so it is always present, then the seed, then results —
    // the same precedence ContactPicker uses.
    for (const o of [chosen, ...seed, ...results].filter(Boolean)) {
      if (!o.value || seen.has(o.value)) continue
      seen.add(o.value)
      rows.push(o)
    }
    return rows
  }, [chosen, seed, results])

  return (
    <Select
      className={invalid ? 'pp-invalid-select' : undefined}
      value={value || undefined}
      onChange={(v, opt) => {
        setChosen(opt || null)
        // The chosen OPTION is passed as a second argument, not just the
        // value. A caller that needs the label — to render a chip before the
        // server round-trip returns, say — otherwise has to re-look-up a row
        // it was just handed. Existing callers take one argument and are
        // unaffected.
        onChange(v || null, opt || null)
      }}
      onSearch={setQuery}
      showSearch
      // Server-side search — antd must NOT also filter what it was given, or a
      // row matched on a field the label doesn't show gets hidden again.
      filterOption={false}
      placeholder={placeholder}
      disabled={disabled}
      allowClear={allowClear}
      options={options}
      popupClassName="pp-menu"
      style={style}
      notFoundContent={
        loading
          ? <div style={{ padding: 10, textAlign: 'center' }}><Spin size="small" /></div>
          : error
            ? 'Could not search — try again'
            : query.trim()
              ? emptyText
              // Reached only when the initial fetch itself came back empty,
              // since showInitial now loads a first page. "Type to search"
              // would be a dead end.
              : showInitial ? 'Nothing to choose from yet' : 'Type to search'
      }
    />
  )
}
