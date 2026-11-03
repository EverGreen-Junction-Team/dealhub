import React, { useRef, useState } from 'react'
import PanelHead from './PanelHead'

// Qualification — the deal's own custom field values, against the headings
// configured in GoHighLevel.
//
// Not AI output, and deliberately not AI INPUT either. These are the
// opportunity's meddic_1..10 columns — what a REP typed. A filled heading is
// something a person wrote and a missing one is a real gap in the record.
//
// THE AI DOES NOT READ THESE. get_deal_detail used to return the values, so
// the model saw a rep's own summary beside the conversation and could not
// tell the two apart — it would state "the budget is £40k" from a field
// someone typed months ago and cite it as fact, quoting the record back at
// the person who wrote it. The headings themselves are still in the system
// prompt, so the model knows what to file evidence under; it simply never
// sees the answers. A rep who wants the AI to consider something pastes it
// into a message or a note.
//
// Editable here because the alternative was leaving the CRM to fill one in.
//
// The missing count is the point of the panel. A heading with no value is a
// question nobody has answered on this deal, which is exactly what a manager
// reviewing it wants to see first.

// GHL's placeholders are written wrapped in parentheses —
// "(What are their requirements?)" — which is the convention for a HINT in a
// form, not for a question standing on its own line. The design shows them
// bare, so the wrapping pair is dropped for display.
//
// Only a pair that wraps the WHOLE string, and only when there is no other
// bracket inside it: "(A) or (B)" is not a wrapped string and must survive
// intact. The stored value is untouched — this is a display rule.
function unwrapParens(text) {
  const t = String(text || '').trim()
  if (!t.startsWith('(') || !t.endsWith(')')) return t
  const inner = t.slice(1, -1)
  return inner.includes('(') || inner.includes(')') ? t : inner
}

export default function QualificationSection({ qualification = [], onSave, savingField }) {
  // Collapsed by default. Ten rows of "Not filled yet" is the longest panel in
  // the rail and the least actionable — the counts in the header already say
  // everything a reviewer needs, so the detail is opt-in.
  const [open, setOpen] = useState(false)
  // Which heading is being edited, and the text in the box. One at a time:
  // these are long free-text answers, and a panel of ten open textareas is a
  // form nobody finishes.
  const [editing, setEditing] = useState(null)
  const [draft, setDraft] = useState('')
  // Set synchronously by Escape, read by the blur handler it triggers.
  //
  // setEditing(null) is QUEUED, but .blur() fires onBlur in the same tick — so
  // the handler still sees `editing === q.fieldKey` from this render's closure
  // and would save the draft the rep just abandoned. A ref is the only value
  // that changes before the blur is dispatched.
  //
  // Declared with the other hooks, above the early return: a hook after a
  // conditional return runs in a different order on the renders that take it.
  const abandoning = useRef(false)

  if (qualification.length === 0) return null

  // No handler, or a field with no GHL id, means read-only. The id is what
  // the opportunity patch writes against (opportunityPatch.js prefers it
  // over the key), so without one there is nothing to save to — and a box
  // that looks editable but cannot save is worse than plain text.
  const canEdit = typeof onSave === 'function'

  const commit = async (q) => {
    const next = draft.trim()
    // Unchanged: close without a round trip. An empty box on an already
    // empty heading is the common accidental case.
    if (next === (q.value || '')) { setEditing(null); setDraft(''); return }
    // The same shape the deal card's own custom-field pickers use, so this
    // goes through one write path rather than inventing a second.
    await onSave('customField', { id: q.fieldId, value: next, dealKey: null })
    // Close THIS heading only. The save takes ~700ms, and blur is what fires
    // it — so by the time it lands the rep has usually clicked into the next
    // box and is typing there. Clearing unconditionally shut that box under
    // them: still focused, but rendering the stored value, so every keystroke
    // and backspace bounced off. The draft is left alone for the same reason;
    // focus re-seeds it.
    setEditing((cur) => (cur === q.fieldKey ? null : cur))
  }


  const missing = qualification.filter((q) => !q.filled)
  const filled = qualification.length - missing.length

  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: 'var(--accent-gold-text)',
        ['--panel-tint']: 'var(--tint-gold)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        overflow: 'hidden',
        // Its own spacing now that it is a full-width section rather than an
        // item in the rail's gap-14 column — without this it sat flush
        // against Co-Pilot's band below it.
        marginTop: 14
      }}
    >
      <PanelHead
        as="button"
        icon="checklist"
        title="Qualification"
        accent="gold"
        // The count and the "N missing" pill sit BESIDE THE TITLE, as the
        // design places them — one reading, "Qualification · 0 of 10 · 10
        // missing", in the subtitle slot. They were in the right-hand action
        // slot next to the chevron, which an earlier mockup showed; the
        // current one leaves only the chevron on the right.
        subtitle={
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 9 }}>
            <span>{filled} of {qualification.length}</span>
            {missing.length > 0 && (
              <span
                style={{
                  display: 'inline-flex', alignItems: 'center',
                  height: 24, padding: '0 10px',
                  borderRadius: 'var(--radius-pill)',
                  // Inverted on the solid band: rose-on-gold is unreadable,
                  // and a white chip is how the count badge reads elsewhere.
                  background: '#fff', color: 'var(--status-stuck)',
                  fontSize: 'var(--text-sm)', fontWeight: 600
                }}
              >
                {missing.length} missing
              </span>
            )}
          </span>
        }
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        tooltip={open ? 'Hide the headings' : 'Show all ten headings'}
        // Closed, the header IS the whole panel — a bottom rule would read as
        // an empty body below it.
        style={{ borderBottom: open ? undefined : 'none' }}
        action={
          <span className="ms" style={{ fontSize: 'var(--text-xl)', color: '#fff' }}>
            {open ? 'expand_less' : 'expand_more'}
          </span>
        }
      />

      {open && (() => {
        // TWO COLUMNS, READ DOWN THEN ACROSS — 1 to 5 on the left, 6 to 10
        // on the right, as the design numbers them. A single grid fills
        // row-major (1,2 / 3,4 / …), so the columns are two explicit
        // stacks instead. That also keeps the order right on a narrow panel,
        // where .pp-qual-grid drops to one column: the stacks follow each
        // other, 1–5 then 6–10, rather than interleaving.
        const half = Math.ceil(qualification.length / 2)
        const columns = [qualification.slice(0, half), qualification.slice(half)]
        return (
        <div
          className="pp-qual-grid"
          style={{
            display: 'grid',
            gap: 'var(--space-3)',
            // A grey panel with SEPARATE CARDS on it, not a seamless grid of
            // white cells divided by 1px rules. The design's ten headings are
            // ten boxes; the gaps between them are what make each one a
            // thing you can see the edges of.
            padding: 'var(--space-4)',
            background: 'var(--gray-50)',
            borderTop: '1px solid var(--border-default)'
          }}
        >
          {columns.map((col, ci) => (
          <div key={ci} style={{ display: 'grid', gap: 'var(--space-3)', alignContent: 'start' }}>
          {col.map((q, i) => {
            const n = ci * half + i + 1
            // THE ORDINAL COMES OFF THE NAME. GHL's own field names carry it
            // — "1. Project Scope" — so a number rendered in front of the
            // name doubled it ("1. 1. Project Scope"), and that span was
            // removed. But with the number left inside the title it took the
            // title's weight and colour, and the design sets it light and
            // regular. Split it off here; fall back to the card's position
            // for a name that has none.
            const om = /^\s*(\d+)\s*[.)]\s*(.+)$/.exec(q.name || '')
            const ordinal = om ? om[1] : String(n)
            const name = om ? om[2] : q.name
            // The saver marks a custom field by its GHL id, not the key.
            const saving = savingField === q.fieldId
            const active = editing === q.fieldKey
            return (
            <div
              key={q.fieldKey}
              style={{
                display: 'grid',
                // The heading panel is a third of the card — fixed by
                // proportion so every answer box in a column starts at the
                // same x.
                gridTemplateColumns: 'minmax(150px, 34%) minmax(0, 1fr)',
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
                background: '#fff',
                overflow: 'hidden'
              }}
            >
              {/* The heading panel: tinted, with the number and name on one
                  line, a rule under them, and the question beneath. */}
              <div style={{
                minWidth: 0, padding: '12px 14px',
                background: 'var(--gray-25)',
                borderRight: '1px solid var(--border-default)'
              }}>
                <div style={{
                  display: 'flex', alignItems: 'baseline', gap: 7,
                  paddingBottom: 8,
                  borderBottom: '1px solid var(--border-default)'
                }}>
                  <span style={{
                    flex: 'none',
                    fontSize: 'var(--text-sm)', fontWeight: 400,
                    fontVariantNumeric: 'tabular-nums',
                    // The design's light ordinal. gray-450 on this panel's
                    // gray-25 is 4.36:1 — under AA (4.5) by a hair; it
                    // clears 4.52 on white, which is where that token's
                    // "faintest readable" reputation comes from. Accepted
                    // because the number is redundant with the card's
                    // position and the title beside it carries the meaning.
                    // text-muted is the AA fallback if this is contested.
                    color: 'var(--gray-450)'
                  }}>
                    {ordinal}.
                  </span>
                  <span style={{
                    minWidth: 0,
                    fontSize: 'var(--text-lg)', fontWeight: 600,
                    color: 'var(--text-heading)'
                  }}>
                    {name}
                  </span>
                </div>
                {/* The heading's own question, from GHL's placeholder — so a
                    rep filling a gap knows what's being asked. */}
                {q.description && (
                  <span style={{
                    display: 'block', marginTop: 8,
                    fontSize: 'var(--text-base)', lineHeight: 1.45,
                    color: 'var(--text-muted)'
                  }}>
                    {unwrapParens(q.description)}
                  </span>
                )}
              </div>

              {/* A REAL TEXTAREA, always — not a button that becomes one.
                  The click-to-edit box looked like a field but was not one:
                  a rep who clicked and started typing lost the first
                  keystroke, because the click only opened the editor. The
                  design shows ten boxes you can type straight into, resize
                  handle and all, so that is what these are.

                  BORDERLESS: the card is the border. A second box inside it
                  read as a field inside a field. The editing state shows as
                  a gold rule instead — same colour the border used to turn.

                  The draft is held per-heading in `editing`/`draft`, the same
                  state the old editor used — focus claims the row, blur
                  commits it. */}
              <div style={{
                position: 'relative', minWidth: 0,
                display: 'grid', gap: 7, alignContent: 'start',
                padding: '10px 12px'
              }}>
                <textarea
                  value={active ? draft : (q.value || '')}
                  readOnly={!canEdit}
                  placeholder={canEdit ? 'Add answer…' : 'Not filled yet'}
                  onFocus={() => {
                    if (!canEdit || active) return
                    setEditing(q.fieldKey)
                    setDraft(q.value || '')
                  }}
                  // Typing into a box that is focused but not the active one
                  // claims it. Otherwise the controlled value stays pinned to
                  // the stored answer and the keystroke is thrown away.
                  onChange={(e) => {
                    if (!active) setEditing(q.fieldKey)
                    setDraft(e.target.value)
                  }}
                  // COMMIT ON BLUR. Focus is what opens the editor now, so
                  // clicking from one box into another switches `editing` —
                  // and without this the first box's typing was discarded
                  // silently, which is data loss on a click-through.
                  //
                  // It costs nothing on a stray click: commit() returns
                  // without a request when the value has not changed.
                  onBlur={() => {
                    if (abandoning.current) { abandoning.current = false; return }
                    if (canEdit && active) commit(q)
                  }}
                  onKeyDown={(e) => {
                    // Escape abandons. Enter inserts a newline, as it must in
                    // a free-text answer — Cmd/Ctrl+Enter commits, which is
                    // the convention everywhere else in the app.
                    if (e.key === 'Escape') {
                      abandoning.current = true
                      setEditing(null); setDraft('')
                      e.currentTarget.blur()
                    }
                    // Through blur, not commit() directly: committing in place
                    // closed the editor while focus stayed in the box, and
                    // the blur that followed saved a second time.
                    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) e.currentTarget.blur()
                  }}
                  rows={3}
                  style={{
                    width: '100%', minWidth: 0,
                    // Room on the right for the pencil, so a long first line
                    // does not run underneath it.
                    padding: '2px 28px 2px 2px',
                    // A transparent border that turns gold when active —
                    // same box either way, so nothing shifts on focus.
                    border: `1px solid ${active ? 'var(--accent-gold-text)' : 'transparent'}`,
                    borderRadius: 'var(--radius-sm)',
                    background: 'transparent', outline: 'none',
                    fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)',
                    lineHeight: 1.5, color: 'var(--text-body)',
                    resize: 'vertical'
                  }}
                />
                {/* The pencil says "editable" before a rep tries. It sits
                    over the textarea's padding and takes no clicks, so it
                    never gets between the cursor and the text. Hidden while
                    editing — the Save/Cancel pair says it louder. */}
                {canEdit && !active && (
                  <span
                    className="ms"
                    aria-hidden="true"
                    style={{
                      position: 'absolute', top: 12, right: 14,
                      fontSize: 16, color: 'var(--text-faint)',
                      pointerEvents: 'none'
                    }}
                  >
                    edit
                  </span>
                )}
                {/* Save/Cancel appear only on the row being edited — ten
                    permanent button pairs would be louder than the answers. */}
                {active && (
                  <span style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
                    <button
                      type="button"
                      onClick={() => commit(q)}
                      disabled={saving}
                      style={{
                        height: 28, padding: '0 12px',
                        border: 'none', borderRadius: 'var(--radius-pill)',
                        background: 'var(--green-500)', color: '#fff',
                        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
                        fontWeight: 600, cursor: saving ? 'progress' : 'pointer'
                      }}
                    >
                      {saving ? 'Saving…' : 'Save'}
                    </button>
                    <button
                      type="button"
                      onClick={() => { setEditing(null); setDraft('') }}
                      // Disabled mid-write: abandoning while the PATCH is in
                      // flight leaves the rep on the old value with a save
                      // still landing behind it.
                      disabled={saving}
                      style={{
                        height: 28, padding: '0 12px',
                        border: '1px solid var(--border-strong)',
                        borderRadius: 'var(--radius-pill)',
                        background: '#fff', color: 'var(--text-body)',
                        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
                        cursor: 'pointer'
                      }}
                    >
                      Cancel
                    </button>
                  </span>
                )}
              </div>
            </div>
            )
          })}
          </div>
          ))}
        </div>
        )
      })()}

      {/* The footnote explains the rows, so it belongs with them — showing it
          under a collapsed header would describe a list nobody can see. */}
      {open && (
        <p
          style={{
            margin: 0, padding: '10px var(--space-4)',
            borderTop: '1px solid var(--border-default)',
            background: 'var(--gray-25)',
            fontSize: 'var(--text-base)', color: 'var(--text-muted)'
          }}
        >
          {missing.length === 0
            ? 'Every heading filled on this deal.'
            : `${missing.length} of ${qualification.length} headings are not filled on this deal${canEdit ? ' — click one to fill it in.' : ' — edit the opportunity in your CRM to fill them in.'}`}
        </p>
      )}
    </section>
  )
}
