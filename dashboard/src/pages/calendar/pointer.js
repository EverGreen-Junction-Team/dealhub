// Where on the grid a pointer is, in the grid's OWN pixels.
//
// ── THE BUG THIS EXISTS TO PREVENT ───────────────────────────────────
//
// The app renders with CSS `zoom` on the body (0.85 by default, set from
// the Appearance setting). Inside that, an element's layout pixels — the
// ones PIXELS_PER_MINUTE is defined in — are not the pixels the pointer
// reports. `e.clientY - rect.top` comes back in ZOOMED pixels, so it was
// 15% short of the real offset.
//
// Every pointer-to-time conversion on the board was doing exactly that.
// Found by clicking 14:20 on the live board and getting a booking card for
// 12:15: 735 minutes where 860 were meant, and 735/860 is 0.85 to three
// places. A click lands early by 15% of its distance from midnight — about
// two hours in the afternoon — and so did every DROP, which is worse: a
// dragged appointment was rescheduled in the CRM to a time nobody chose.
//
// So the conversion lives here, once, and nothing on the board computes
// an offset from clientY by hand.

/** The app's current zoom, from the custom property the Appearance
 *  setting paints on <html>. 1 when unset or unreadable. */
export function appZoom() {
  if (typeof document === 'undefined') return 1
  const z = Number(getComputedStyle(document.documentElement).getPropertyValue('--app-zoom'))
  return Number.isFinite(z) && z > 0 ? z : 1
}

/** Vertical offset of a pointer event from the top of `el`, in layout px. */
export function offsetY(e, el) {
  return (e.clientY - el.getBoundingClientRect().top) / appZoom()
}
