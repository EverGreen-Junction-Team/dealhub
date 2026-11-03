import { useEffect, useRef, useState } from 'react'
import { insightsAPI } from '../../api/insights'
import { CHARTS } from './charts'

// Fetch a chart's rows the first time its card is near the viewport.
//
// WHY LAZY. 26 charts across 27 views, every one a separate query. Fetching
// them all on mount means a page that cannot paint until the slowest view
// returns, for cards most people never scroll to. An IntersectionObserver
// with a generous margin starts the request slightly BEFORE the card is on
// screen, so a normal scroll never actually waits.
//
// WHY ONCE. `done` latches as soon as a fetch starts. Without it the observer
// re-fires on every scroll past the card and re-runs the query — the chart
// would be correct and the database would be doing the same work repeatedly.
//
// A failure is kept on the card rather than thrown: one view that cannot be
// read must not take the other 25 charts down with it.
export function useChart(key) {
  const ref = useRef(null)
  const done = useRef(false)
  const [state, setState] = useState({ status: 'idle', data: null, error: null })

  useEffect(() => {
    const el = ref.current
    if (!el || done.current) return undefined

    const load = () => {
      if (done.current) return
      done.current = true
      setState({ status: 'loading', data: null, error: null })
      insightsAPI.chart(key)
        .then((r) => {
          const spec = CHARTS[key]
          if (!spec) throw new Error(`No adapter for chart "${key}"`)
          // The adapter turns raw rows into bars. It runs HERE rather than in
          // the component so a throw inside it is caught by this same handler
          // — a malformed row should show as a card-level error, not a blank
          // card with a console trace.
          const rows = spec.build(r.sets || [])
          const heat = spec.heat ? spec.heat(r.sets || []) : null
          const n = spec.sample ? spec.sample(r.sets || []) : null
          setState({
            status: 'ready',
            data: { rows, heat, meta: { ...spec.meta, n: n ?? spec.meta?.n ?? null } },
            error: null
          })
        })
        .catch((e) => setState({
          status: 'error', data: null, error: e?.message || 'Could not read this insight'
        }))
    }

    // No IntersectionObserver (jsdom, very old browsers): load immediately
    // rather than never. Degrading to eager is the right failure here — a
    // slower page beats a page of empty frames.
    if (typeof IntersectionObserver === 'undefined') { load(); return undefined }

    const obs = new IntersectionObserver(
      (entries) => { if (entries.some((e) => e.isIntersecting)) { load(); obs.disconnect() } },
      { rootMargin: '300px' }
    )
    obs.observe(el)
    return () => obs.disconnect()
  }, [key])

  return { ref, ...state }
}
