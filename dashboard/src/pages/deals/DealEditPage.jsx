import React, { useEffect } from 'react'
import DealEditPanel from './DealEditPanel'

// A deal's editor as a PAGE — the tab's whole content, not a row that expands.
//
// Expanding inline put a tall form inside a scrolling list: on the board it
// was clipped by the column strip, and on the card list it pushed every other
// deal off screen while the rep worked.
//
// NOT a portal, and not fixed-position. It was both, and that covered the
// shell's own navigation — the tab strip, the Back button, the location name —
// so a rep on this page had no way anywhere except the button in its header.
// ContactDetail solves the same problem by simply REPLACING its tab's content
// (an early return in ContactsTab), which leaves the shell's chrome in place.
// This matches that.
//
// NOT a route either. Adding a fifth field to the shell's position (tab,
// dealId, contactId, businessId) means touching history, the localStorage
// restore and labelForPlace — for a surface whose back action is one button.
// The position a rep actually wants from here is the deal hub, which IS a
// real position, and that button is in the header.

export default function DealEditPage({
  deal, pipelines, users, refError,
  onClose, onSaved, onDeleted, onOpenInHub, onOpenContact
}) {
  // Escape returns to the list — the keyboard equivalent of Back.
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  if (!deal) return null

  // THE APP'S DETAIL-PAGE SHAPE (Oct 2026), the business page's: a dark
  // "All deals" pill above, then the editor's own cards — each section a
  // white card with a solid header band. It was a white header strip with an
  // outlined Back button over one grey box of underlined headings, which read
  // as the old style beside every redesigned tab.
  return (
    <div style={{ display: 'grid', gap: 14, minHeight: 0 }}>
      <div>
        <button
          onClick={onClose}
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
          All deals
        </button>
      </div>

      <DealEditPanel
        deal={deal}
        pipelines={pipelines}
        users={users}
        refError={refError}
        onSaved={onSaved}
        onDeleted={onDeleted}
        onClose={onClose}
        // The way ONWARD, in the first card's header band. This page edits
        // the record's own fields; the hub is where its timeline, tasks,
        // notes and people live.
        onOpenInHub={onOpenInHub}
        onOpenContact={onOpenContact}
      />
    </div>
  )
}
