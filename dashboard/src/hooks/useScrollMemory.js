import { useCallback, useEffect, useRef } from 'react'
import { getTabState, setTabState } from './useTabState.js'

// Where you were ON the page, not just what the page was showing.
//
// useTabState already remembers the filters, the view and the sort. It does
// not remember that you were four hundred pixels down the deals list, or
// scrolled across to the fifth pipeline column — so returning to a tab put
// the right rows on screen and then showed you the top of them. On a long
// list that is the same work as re-applying a filter: you have to find your
// place again.
//
// Two axes, because the app scrolls both ways and they are different
// containers. The page scrolls vertically on the document; the pipeline
// board, the tables and the calendar scroll horizontally inside themselves.
//
// ── WHY RESTORING IS NOT ONE LINE ────────────────────────────────────
//
// You cannot scroll to 800px on a page that is currently 200px tall. Every
// tab here mounts empty and fetches, so at the moment of mount the content
// does not exist yet and any scroll is clamped to zero. Restoring therefore
// has to keep trying until the page is tall enough — and then stop, both
// when it succeeds and when it is clearly not going to.

// How long to keep trying before accepting the page is as tall as it gets.
// Two seconds covers a slow list fetch; beyond that the user is looking at
// the top of the page and has moved on, and yanking them down would be worse
// than leaving them.
const RESTORE_WINDOW_MS = 3000

const SAVE_EVERY_MS = 250

/**
 * One frame of a restore: should we keep trying?
 *
 * ── WHY THIS IS AS DUMB AS IT IS ─────────────────────────────────────
 *
 * The first version gave up as soon as the target looked unreachable. At
 * mount the page is empty — the fetch has not landed — so the furthest you
 * can scroll is 0 and EVERY target is unreachable. It stopped on frame one,
 * always, and the symptom was a position that never came back.
 *
 * The obvious repair was to wait for the height to hold still before
 * believing it. That does not work either, and the test for it is what
 * showed why: a list renders a skeleton, then its first page, then the rest,
 * so the height holds still at an INTERMEDIATE value for long enough to look
 * settled. Any threshold short enough to release a genuinely short page is
 * also short enough to be fooled by a page mid-load. The two are not
 * distinguishable from height alone.
 *
 * So it does not try. Keep aiming at the target, clamped to whatever the
 * page can currently do, until one of three things is true:
 *
 *   it arrives                  the common case, usually within a few frames
 *   the window expires          the backstop, for a page that never gets there
 *   the rep scrolls themselves  handled by the caller — their input wins
 *
 * On a page that is genuinely shorter than it was, this parks at the bottom
 * — the closest it can get to where they were — and keeps re-parking there
 * for a second or two. That costs a few hundred no-op scrollTo calls and is
 * invisible, which is a better trade than a heuristic that silently gives up
 * on the case it was written for.
 *
 * @param {number} current   where we are now
 * @param {number} target    where we want to be
 * @param {number} elapsedMs since the restore began
 */
export function restoreStep({ current, target, elapsedMs }) {
  // Sub-pixel layout and the page zoom both mean the final offset is rarely
  // exact, so landing within a couple of pixels counts as landing. Without
  // the tolerance every successful restore would run until the clock.
  if (Math.abs(current - target) < 2) return { done: true }
  if (elapsedMs >= RESTORE_WINDOW_MS) return { done: true }
  return { done: false }
}

function useThrottledSave(page, key) {
  const timer = useRef(null)
  const latest = useRef(null)

  useEffect(() => () => {
    // Flush on unmount. This is the important one: leaving the tab IS the
    // moment worth recording, and it is exactly when a pending throttle
    // would otherwise be thrown away.
    if (timer.current) {
      window.clearTimeout(timer.current)
      timer.current = null
      if (latest.current != null) setTabState(page, key, latest.current)
    }
  }, [page, key])

  return useCallback((value) => {
    latest.current = value
    if (timer.current) return
    timer.current = window.setTimeout(() => {
      timer.current = null
      setTabState(page, key, latest.current)
    }, SAVE_EVERY_MS)
  }, [page, key])
}

/**
 * Remember how far down the PAGE this tab was scrolled.
 *
 * @param {string} page  the useTabState namespace — 'deals', 'contacts'…
 */
export function usePageScrollMemory(page) {
  const save = useThrottledSave(page, 'scrollY')

  useEffect(() => {
    const onScroll = () => save(window.scrollY)
    window.addEventListener('scroll', onScroll, { passive: true })
    return () => window.removeEventListener('scroll', onScroll)
  }, [save])

  useEffect(() => {
    const target = getTabState(page, 'scrollY', 0)
    if (!target) return undefined

    let cancelled = false
    const started = Date.now()

    // ANY deliberate scroll abandons the restore.
    //
    // Without this, a rep who starts reading from the top while the list is
    // still loading gets dragged down mid-sentence by a restore that was
    // still retrying. Their input wins over our memory, always.
    const abandon = () => { cancelled = true }
    const opts = { passive: true }
    window.addEventListener('wheel', abandon, opts)
    window.addEventListener('touchstart', abandon, opts)
    window.addEventListener('keydown', abandon)

    const attempt = () => {
      if (cancelled) return
      const max = Math.max(
        0,
        document.documentElement.scrollHeight - window.innerHeight
      )
      window.scrollTo(0, Math.min(target, max))

      const { done } = restoreStep({
        current: window.scrollY,
        target,
        elapsedMs: Date.now() - started
      })
      if (!done) window.requestAnimationFrame(attempt)
    }
    window.requestAnimationFrame(attempt)

    return () => {
      cancelled = true
      window.removeEventListener('wheel', abandon)
      window.removeEventListener('touchstart', abandon)
      window.removeEventListener('keydown', abandon)
    }
    // Mount only. Re-running on every render would fight the user for the
    // whole life of the page.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}

/**
 * Remember how far an ELEMENT was scrolled — across, and down.
 *
 * Returns a ref to put on the scrolling element. The pipeline board is the
 * case this was written for: scrolling to the fifth stage and stepping into
 * a deal should not send you back to the first.
 *
 * @param {string} page  the useTabState namespace
 * @param {string} key   which scroller, when a page has more than one
 */
export function useElementScrollMemory(page, key) {
  const ref = useRef(null)
  const save = useThrottledSave(page, `scroll:${key}`)

  useEffect(() => {
    const el = ref.current
    if (!el) return undefined

    const onScroll = () => save({ x: el.scrollLeft, y: el.scrollTop })
    el.addEventListener('scroll', onScroll, { passive: true })

    const target = getTabState(page, `scroll:${key}`, null)
    let cancelled = false
    const started = Date.now()
    const abandon = () => { cancelled = true }
    el.addEventListener('wheel', abandon, { passive: true })
    el.addEventListener('touchstart', abandon, { passive: true })

    if (target && (target.x || target.y)) {
      const wantX = target.x || 0
      const wantY = target.y || 0

      const attempt = () => {
        if (cancelled || !ref.current) return
        const node = ref.current
        const maxX = Math.max(0, node.scrollWidth - node.clientWidth)
        const maxY = Math.max(0, node.scrollHeight - node.clientHeight)
        node.scrollLeft = Math.min(wantX, maxX)
        node.scrollTop = Math.min(wantY, maxY)

        // Both axes, same rule as the page — see restoreStep. A board with
        // no columns yet can scroll nowhere, so there is nothing clever to
        // infer from how far it currently goes.
        const here = restoreStep({
          current: node.scrollLeft, target: wantX, elapsedMs: Date.now() - started
        })
        const there = restoreStep({
          current: node.scrollTop, target: wantY, elapsedMs: Date.now() - started
        })
        if (here.done && there.done) return
        window.requestAnimationFrame(attempt)
      }
      window.requestAnimationFrame(attempt)
    }

    return () => {
      cancelled = true
      el.removeEventListener('scroll', onScroll)
      el.removeEventListener('wheel', abandon)
      el.removeEventListener('touchstart', abandon)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [page, key])

  return ref
}
