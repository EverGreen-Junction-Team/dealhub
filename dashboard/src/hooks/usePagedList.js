import { useCallback, useEffect, useRef, useState } from 'react'

// Cursor-paginated list with infinite scroll.
//
// One hook for Contacts / Deals / Tasks / Notes, because all four have the same
// shape: fetch a page, append, load the next when the user reaches the bottom.
//
// Two things it has to get right:
//   • A filter change is a NEW list, not more of the old one. So the cursor
//     resets and rows are replaced, never appended.
//   • Requests can land out of order (change a filter mid-flight and the old
//     response may arrive second). Each fetch carries a sequence number and a
//     stale response is dropped rather than merged into the wrong list.

/**
 * @param {object}   opts
 * @param {Function} opts.fetchPage  ({ cursor, signal }) => { <key>: [], nextCursor }
 * @param {string}   opts.key        response property holding the rows
 * @param {Array}    opts.deps       filters — changing any of these restarts the list
 */
export function usePagedList({ fetchPage, key, deps = [] }) {
  const [items, setItems] = useState(null)
  const [error, setError] = useState(null)
  const [loadingMore, setLoadingMore] = useState(false)
  const [hasMore, setHasMore] = useState(false)
  // The server's count for the CURRENT filter, not the loaded page. null
  // until the first response, and for any endpoint that sends no total.
  const [total, setTotal] = useState(null)

  const cursorRef = useRef(null)
  // Guards against two loadMore calls racing (fast scroll, or the observer
  // firing twice before state settles).
  const inFlight = useRef(false)
  // Monotonic token: only the newest request may write to state.
  const seq = useRef(0)

  const load = useCallback(
    async (mode) => {
      if (inFlight.current) return
      const token = mode === 'reset' ? ++seq.current : seq.current
      inFlight.current = true
      if (mode === 'more') setLoadingMore(true)

      try {
        const res = await fetchPage({ cursor: mode === 'reset' ? null : cursorRef.current })
        // A newer request started while this was in flight — its result is the
        // one the user is waiting for, so discard this.
        if (token !== seq.current) return
        const rows = res?.[key] || []
        cursorRef.current = res?.nextCursor || null
        setHasMore(!!res?.nextCursor)
        // Every page carries it, and it must not go stale when a filter
        // changes mid-scroll. Number() because 0 is a real, falsy total.
        setTotal(typeof res?.totalCount === 'number' ? res.totalCount : null)
        setItems((prev) => (mode === 'reset' || prev === null ? rows : [...prev, ...rows]))
        setError(null)
      } catch (err) {
        if (token !== seq.current) return
        setError(err?.message || 'Failed to load')
        // On a failed first page there's nothing to show; on a failed
        // subsequent page keep what we have and stop asking for more.
        setItems((prev) => prev ?? [])
        setHasMore(false)
        // A stale total beside a failed load is worse than none.
        setTotal(null)
      } finally {
        inFlight.current = false
        setLoadingMore(false)
      }
    },
    // fetchPage is recreated per render by callers; deps are what actually
    // define the list.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [key, ...deps]
  )

  // Filter change → new list.
  useEffect(() => {
    cursorRef.current = null
    setItems(null)
    setHasMore(false)
    setError(null)
    load('reset')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, ...deps])

  const loadMore = useCallback(() => {
    if (!hasMore || inFlight.current) return
    load('more')
  }, [hasMore, load])

  // Optimistic local edit without a refetch — used when a row changes in place
  // (a task completed, a contact renamed).
  const patchItem = useCallback((match, patch) => {
    setItems((prev) =>
      prev ? prev.map((it) => (match(it) ? { ...it, ...patch } : it)) : prev
    )
  }, [])

  return {
    items,
    error,
    hasMore,
    total,
    loadingMore,
    loading: items === null && !error,
    loadMore,
    patchItem,
    reload: () => load('reset')
  }
}

/**
 * Sentinel to render at the end of a list. Calls onVisible when scrolled into
 * view. IntersectionObserver rather than a scroll handler, so it costs nothing
 * while the user isn't near the bottom.
 */
export function useInfiniteScroll(onVisible, { enabled = true, rootMargin = '400px' } = {}) {
  const ref = useRef(null)
  // Keep the latest callback without re-creating the observer on every render.
  const cb = useRef(onVisible)
  cb.current = onVisible

  useEffect(() => {
    if (!enabled) return
    const el = ref.current
    if (!el) return
    const io = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) cb.current()
      },
      // Fire before the sentinel is actually visible, so the next page is
      // usually there by the time the user reaches it.
      { rootMargin }
    )
    io.observe(el)
    return () => io.disconnect()
  }, [enabled, rootMargin])

  return ref
}
