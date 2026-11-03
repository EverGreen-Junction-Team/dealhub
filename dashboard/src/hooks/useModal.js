import { useEffect, useRef } from 'react'

// The two behaviours every dialog needs and none of them had: the page must not
// scroll behind an open modal, and Tab must not walk out of it into the list
// underneath.
//
// One hook rather than five copies — the dialogs already drifted once on
// styling, which is why the look moved to CSS.
//
// WHY THIS MATTERS MORE HERE THAN USUAL. The app runs in a GHL iframe. A
// wheel event over an open dialog scrolled the deal list behind it, and because
// the backdrop covers the viewport there was no visual cue that the thing
// moving was not the thing being read.
// NO ESCAPE HANDLING HERE. All five dialogs already bind Escape on document,
// each correctly guarded against firing mid-save (`!saving` / `!busy`), and
// TagPicker's tag list depends on intercepting it first. Adding a second
// handler would close a dialog its own guard had declined to close, and would
// shut both a confirm and the editor beneath it on one keypress.
export function useModal({ active = true } = {}) {
  const ref = useRef(null)

  // ── Scroll lock ─────────────────────────────────────────────────────────
  useEffect(() => {
    if (!active) return
    // The ROOT element, not <body>. The page's scroll container is <html>
    // (index.css: `html { overflow-y: scroll }`) and <body> is sized
    // `height: 100%`. Hiding overflow on <body> therefore collapsed the
    // document to one screen's height, the scroll position had nowhere to
    // be, and the page snapped to the top the moment any dialog opened —
    // an image, a full-screen thread, the reply box. Locking <html> keeps
    // the position; it is also restored explicitly below in case a browser
    // drops it anyway.
    const el = document.documentElement
    const before = el.style.overflow;
    const scrollY = window.scrollY;

    // Compensating for the scrollbar's width prevents the page behind from
    // jumping sideways as it disappears — the tell of a cheap modal.
    const gap = window.innerWidth - el.clientWidth;
    const beforePad = el.style.paddingRight;
    el.style.overflow = 'hidden';
    if (gap > 0) el.style.paddingRight = `${gap}px`;

    return () => {
      // Restore what was there, not a hardcoded '' — another dialog may be
      // open beneath this one (a confirm raised from an editor), and blanking
      // the value would unlock the page while that one is still up.
      el.style.overflow = before;
      el.style.paddingRight = beforePad;
      if (window.scrollY !== scrollY) window.scrollTo(0, scrollY);
    };
  }, [active]);

  // ── Focus: move in, trap, and restore ───────────────────────────────────
  useEffect(() => {
    if (!active) return;
    const panel = ref.current;
    if (!panel) return;

    // Where focus was, so it can go back. Without this, closing a dialog
    // dropped focus to the top of the document and a keyboard user lost their
    // place in the list entirely.
    const previous = document.activeElement;

    const focusable = () =>
      Array.from(
        panel.querySelectorAll(
          'a[href], button:not([disabled]), input:not([disabled]), ' +
          'select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
        )
      // A control inside a collapsed section is in the DOM but not reachable;
      // offsetParent is null for anything display:none.
      ).filter((el) => el.offsetParent !== null || el === document.activeElement);

    const onKeyDown = (e) => {
      if (e.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) {
        e.preventDefault();
        return;
      }
      const first = items[0];
      const last = items[items.length - 1];
      // Wrap at both ends. Without the shift-Tab half, backwards tabbing from
      // the first field still escaped into the page behind.
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    panel.addEventListener('keydown', onKeyDown);
    return () => {
      panel.removeEventListener('keydown', onKeyDown);
      // Only if the element is still in the document — the row that opened the
      // dialog may have been removed by the very save that closed it.
      if (previous && typeof previous.focus === 'function' && previous.isConnected) {
        previous.focus();
      }
    };
  }, [active]);

  return ref;
}
