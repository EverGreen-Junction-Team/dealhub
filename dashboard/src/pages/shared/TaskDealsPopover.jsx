import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import RemotePicker from './RemotePicker'
import { searchDeals, dealOption } from '../../hooks/useLinkTargets'
import { tasksAPI } from '../../api/tasks'

// Attach and detach the deals a task belongs to, inline on the task card.
//
// WHY A POPOVER AND NOT THE TASK EDITOR. The editor has one deal picker,
// because until now a task HAD one deal — `tasks.opportunity_id` is a scalar.
// GHL's cap is 10 (TASK_OPPORTUNITY_ASSOCIATION), and a task like "chase the
// survey" genuinely spans several deals for the same customer. Opening a modal
// to add a second deal, then reopening it to add a third, is the wrong shape
// for that; this sits beside the chips it edits.
//
// Notes deliberately have no equivalent. NOTE_OPPORTUNITY_ASSOCIATION caps at
// 1, so a note has one deal and one contact — attaching a second REPLACES the
// first. That is a picker, which the note editor already has, not a list.
//
// EACH CHANGE IS ITS OWN REQUEST, applied one at a time rather than collected
// and saved. Every link is a separate GHL association call, so a batch would
// half-succeed and leave us reporting one error for four changes with no way
// to say which.
//
// onApply({ deals, deal }) PATCHES THE ROW IN PLACE — it does not refetch.
// Three reasons: PUT /relations returns { ok: true } rather than the task, so
// there is nothing to re-read from the response; a full reload resets an
// infinite-scrolled list to page one and unmounts this popover mid-edit; and
// our own row will not reflect the change until GHL's RelationCreate webhook
// lands and taskNoteRelationWriter writes it, which is not synchronous with
// this request. So we apply what GHL just accepted and let the webhook
// reconcile.
export default function TaskDealsPopover({
  task, limit = 10, onApply, onClose,
  // The ELEMENT to position against — the icon that opened this. Required:
  // the popover renders in a PORTAL (see below), so it has no ancestor to
  // anchor to and must be told where to sit.
  //
  // A GETTER returning the element, not the element itself.
  //
  // A caller with one row per task cannot call useRef per row, so it keeps a
  // map keyed by id. That map is populated by ref callbacks during the SAME
  // commit that mounts this child, so the element read during the parent's
  // render — `map[id]` — is still undefined in the props we first receive.
  // Passing it directly meant `pos` never resolved and the popover rendered
  // nothing, with no later render to correct it.
  //
  // A getter defers the read to our layout effect, which runs after the
  // commit, when the map is populated.
  getAnchor,
  // The deals the page already has loaded, so opening this costs no request.
  // Typing still searches the server — the seed is a head start, not the
  // whole list.
  seed = []
}) {
  const [busy, setBusy] = useState(null)     // the deal id currently in flight
  const [error, setError] = useState(null)
  const [adding, setAdding] = useState(null) // the picked-but-not-yet-saved deal
  const boxRef = useRef(null)
  const [pos, setPos] = useState(null)

  // Deal search scoped to this task's contact, keyed so a different task's
  // popover never reuses the previous contact's cached results.
  const taskContactId = task?.contact?.id || null
  const dealSearch = React.useCallback(
    (q) => searchDeals(q, { contactId: taskContactId }),
    [taskContactId]
  )

  // PORTALLED TO THE BODY, not positioned inside the card.
  //
  // The list sits in a Panel with `overflow: hidden` — it needs that to clip
  // its own rounded corners — so an absolutely-positioned child extending
  // past the card was being CLIPPED, and landed nowhere near the icon that
  // opened it. No amount of top/right fixes that: the popover has to leave
  // the clipping ancestor entirely.
  //
  // Measured from the anchor's viewport rect, so it tracks the icon whatever
  // the card's height or the page's scroll position.
  useLayoutEffect(() => {
    const place = () => {
      const el = getAnchor?.()
      if (!el) return
      const r = el.getBoundingClientRect()
      const W = 320
      const GAP = 6
      // Right-aligned to the icon, then pulled back inside the window — near
      // the right edge of a narrow viewport the natural position would run
      // off-screen.
      const left = Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8))
      // Flip above the icon when there is not room below: this list scrolls,
      // and a task near the bottom would otherwise open a popover the rep
      // cannot see.
      const below = window.innerHeight - r.bottom
      const flip = below < 260 && r.top > below
      setPos({
        left,
        top: flip ? undefined : r.bottom + GAP,
        bottom: flip ? window.innerHeight - r.top + GAP : undefined
      })
    }
    place()
    // Reposition rather than close: the rep may scroll the list slightly
    // while reading it, and closing on any scroll would feel broken.
    window.addEventListener('scroll', place, true)
    window.addEventListener('resize', place)
    return () => {
      window.removeEventListener('scroll', place, true)
      window.removeEventListener('resize', place)
    }
  }, [getAnchor])

  const deals = task.deals || []
  const full = deals.length >= limit

  // Dismiss on an outside click or Escape. Both, because this opens from an
  // icon in a scrolling list: a rep who scrolls away and clicks another task
  // should not leave a popover floating over an unrelated row.
  useEffect(() => {
    const onDown = (e) => {
      if (boxRef.current?.contains(e.target)) return
      // The trigger toggles on its own click. Without this the popover would
      // close here and reopen from the toggle in the same gesture.
      if (getAnchor?.()?.contains(e.target)) return
      // antd renders its dropdown in ANOTHER portal, outside our box —
      // clicking an option would otherwise dismiss the popover before the
      // selection was handled, which looks exactly like "nothing happened".
      if (e.target.closest?.('.ant-select-dropdown')) return
      onClose()
    }
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [onClose, getAnchor])

  async function run(dealId, fn, nextDeals) {
    setBusy(dealId)
    setError(null)
    try {
      const r = await fn()
      // The server returns relationError with the task intact when the
      // association call fails — a 200 does not mean the link landed.
      if (r?.relationError) throw new Error(r.relationError)
      if (onApply) {
        onApply({
          deals: nextDeals,
          // tasks.opportunity_id is the primary and drives the card's chip.
          // First link wins on insert (COALESCE server-side) and another is
          // promoted on delete, so mirroring "the first remaining" here keeps
          // the chip matching what the webhook will store.
          deal: nextDeals[0]
            ? { id: nextDeals[0].id, name: nextDeals[0].name, stage: nextDeals[0].stage }
            : null
        })
      }
    } catch (e) {
      // The GHL message, verbatim. "Could not link deal" tells the rep
      // nothing they can act on; "maximum of 10 associations" tells them
      // exactly what to do.
      setError(e?.response?.data?.error || e?.message || 'The link did not save')
    } finally {
      setBusy(null)
    }
  }

  // RemotePicker's onChange hands back the VALUE first and the option second
  // — not an option object. Reading `opt.value` off the string silently did
  // nothing on every selection: the dropdown closed and no link was made.
  const add = (dealId, opt) => {
    setAdding(null)
    if (!dealId) return
    if (deals.some((d) => d.id === dealId)) {
      setError('That deal is already linked')
      return
    }
    // The label for the chip we render before the server answers. It comes
    // from the option when antd supplies one; the fallback covers a value
    // arriving without it, and the webhook corrects the name either way.
    // dealOption is the one place that decides what a deal is called in a
    // picker. Reading `dealTag` directly here would diverge from it the
    // moment a deal has no tag — it falls through to opportunityName, then
    // name, then the id.
    const fromSeed = seed.find((d) => d.id === dealId)
    const label = opt?.label || (fromSeed && dealOption(fromSeed).label) || 'Linked deal'
    run(
      dealId,
      () => tasksAPI.setRelations(task.id, { opportunityId: dealId }),
      // Appended, not prepended: the primary must not change when a second
      // deal is added, matching COALESCE(opportunity_id, $3) on the server.
      [...deals, { id: dealId, relationId: null, name: label, stage: null }]
    )
  }

  const remove = (dealId) =>
    run(
      dealId,
      () => tasksAPI.removeRelations(task.id, { opportunityId: dealId }),
      deals.filter((d) => d.id !== dealId)
    )

  // Nothing until the anchor has been measured — one frame, in a layout
  // effect, so there is no visible jump from an unpositioned first paint.
  if (!pos) return null

  return createPortal(
    <div
      ref={boxRef}
      // .pp-portal — the Material Symbols rule is scoped to [data-dealhub]
      // and this renders outside it, so without the class every icon here
      // renders as its ligature text ("sell", "close").
      className="pp-portal"
      style={{
        // `fixed`, in a body portal: viewport coordinates, no clipping
        // ancestor, no dependence on the card's height.
        position: 'fixed',
        left: pos.left, top: pos.top, bottom: pos.bottom,
        // Above the sticky list header and the row hover states, below the
        // dialogs (60+) so an editor opened from here still covers it.
        zIndex: 50,
        width: 320, padding: 'var(--space-3)',
        background: '#fff',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-lg)',
        boxShadow: '0 12px 32px rgba(15, 34, 26, 0.16)',
        textAlign: 'left', cursor: 'default'
      }}
      onClick={(e) => e.stopPropagation()}
    >
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 8, marginBottom: 'var(--space-2)'
      }}>
        <span style={{
          fontSize: 12, fontWeight: 600, letterSpacing: '0.04em',
          textTransform: 'uppercase', color: 'var(--text-muted)'
        }}>
          Linked deals
        </span>
        <span style={{
          fontSize: 11, fontVariantNumeric: 'tabular-nums',
          color: full ? 'var(--status-stuck)' : 'var(--text-faint)'
        }}>
          {deals.length} / {limit}
        </span>
      </div>

      {deals.length === 0 && (
        <p style={{ margin: '0 0 var(--space-2)', fontSize: 12, color: 'var(--text-faint)' }}>
          Not linked to a deal yet.
        </p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
        {deals.map((d, i) => (
          <div
            key={d.id}
            style={{
              display: 'flex', alignItems: 'center', gap: 6,
              padding: '5px 6px 5px 8px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--surface-sunken)',
              opacity: busy === d.id ? 0.5 : 1
            }}
          >
            <span className="ms" style={{ fontSize: 14, color: 'var(--text-muted)', flex: 'none' }}>
              sell
            </span>
            {/* min-width: 0 — without it a long deal name refuses to
                truncate and pushes the remove button out of the popover. */}
            <span style={{
              flex: 1, minWidth: 0, fontSize: 12.5, color: 'var(--text-body)',
              overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
            }} title={d.name}>
              {d.name}
              {/* Which one the rest of the app calls "the" deal, since
                  tasks.opportunity_id is still a scalar and drives the card's
                  own chip and the deal-hub rail. */}
              {i === 0 && deals.length > 1 && (
                <span style={{
                  marginLeft: 6, fontSize: 10.5,
                  // --text-faint measures 2.75:1 on --surface-sunken, under
                  // the 3:1 floor. This label carries meaning — which deal
                  // the card's chip and the deal-hub rail will show — so it
                  // gets a colour that can actually be read.
                  color: 'var(--text-muted)', fontWeight: 600,
                  letterSpacing: '0.03em', textTransform: 'uppercase'
                }}>
                  primary
                </span>
              )}
            </span>
            <button
              onClick={() => remove(d.id)}
              disabled={busy !== null}
              title={`Unlink ${d.name}`}
              aria-label={`Unlink ${d.name}`}
              style={{
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                width: 22, height: 22, flex: 'none', padding: 0,
                border: 'none', borderRadius: 'var(--radius-sm)',
                background: 'transparent', color: 'var(--text-faint)',
                cursor: busy !== null ? 'not-allowed' : 'pointer'
              }}
            >
              <span className="ms" style={{ fontSize: 15 }}>close</span>
            </button>
          </div>
        ))}
      </div>

      <div style={{ marginTop: 'var(--space-2)' }}>
        {full ? (
          <p style={{ margin: 0, fontSize: 11.5, color: 'var(--text-muted)' }}>
            GoHighLevel allows {limit} deals per task. Unlink one to add another.
          </p>
        ) : (
          <RemotePicker
            value={adding}
            onChange={add}
            // Scoped to the task's contact — see searchDeals. A task on
            // Alice should not offer Bob's deals.
            search={dealSearch}
            // Already-linked deals filtered out so the picker does not
            // offer what is listed a line above.
            seed={seed
              .map(dealOption)
              .filter((o) => !deals.some((d) => d.id === o.value))}
            placeholder={busy ? 'Linking…' : 'Add a deal…'}
            disabled={busy !== null}
            allowClear={false}
            emptyText="No deals match"
            style={{ width: '100%' }}
          />
        )}
      </div>

      {error && (
        <p role="alert" style={{
          margin: 'var(--space-2) 0 0', fontSize: 11.5,
          color: 'var(--status-stuck)'
        }}>
          {error}
        </p>
      )}
    </div>,
    document.body
  )
}
