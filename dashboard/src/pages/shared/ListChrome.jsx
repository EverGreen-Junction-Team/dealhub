import React, { useMemo, useState, useRef, useEffect } from 'react'
import { sanitiseHtml } from '../../utils/sanitiseHtml'

// Shared chrome for the list tabs (Notes / Tasks / Deals).
//
// All three share a vocabulary: a page header with a subtitle and an optional
// action, an accent-bordered section with a count, contact + deal chips, and
// the same loading/empty/error states. Before this, each tab re-implemented
// all of it with slightly different padding and chip borders.

export function PageHeader({ title, subtitle, action }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: 'center', gap: 14,
        flexWrap: 'wrap', marginBottom: 4
      }}
    >
      <h1 style={{ fontSize: 'var(--text-2xl)', fontWeight: 600, margin: 0 }}>{title}</h1>
      {subtitle && (
        <p
          style={{
            margin: 0, flex: 1, minWidth: 200,
            // --text-lg (14px), not --text-md (13px): this line explains what
            // the page does and sits beside a 24px title, where 13px read as
            // fine print rather than the page's own description. Shared by
            // every tab's header, so all of them gain the same legibility.
            fontSize: 'var(--text-lg)', color: 'var(--text-muted)'
          }}
        >
          {subtitle}
        </p>
      )}
      {action}
    </div>
  )
}

export function Panel({
  icon, title, accent, meta, children, toolbar,
  // A number shown as a pill beside the title. Prefer this to `meta` for a
  // simple count — see the badge below. `countTitle` is its tooltip, for the
  // context a bare number loses (Tasks counts only what the status filter
  // selected, so "10" means "10 open" or "10 completed").
  count, countTitle,
  // Let the action slot grow — for an action that is a full control row.
  actionFill = false,
  // A SECOND header row, below the title row and starting at the panel's own
  // left padding. For the controls that narrow a list — filters, their chips,
  // save view — which belong under the search/owner/tag row rather than
  // squeezed onto it.
  //
  // A sibling of the title row, not a child of `action`: nested inside it,
  // every line began at the action box's left edge, which is the title's right
  // edge (~175px in), so the second row started mid-panel.
  actionBreak = null,
  // Air between the header and the content. Off by default: a panel whose
  // children are Rows wants them flush under the header line. A table or a
  // card grid, whose own first row is another rule, wants the gap.
  contentPad = false,
  // A single primary action, rendered IN the header beside `meta`.
  //
  // Distinct from `toolbar`, which draws its own band below the header —
  // right for a row of filter chips or a segmented control, wrong for one
  // button: "Add task" sat alone in a full-width grey strip under the title,
  // which read as a section of its own rather than an action on the panel.
  action,
  // How to read `meta`. Default 'muted' — a count or a status, said quietly.
  // 'error' when it is a failure the reader has to act on: at --text-muted a
  // rejected save sat in the same grey as "Editable", which is how "That
  // email address is not valid" went unnoticed in the corner of the header.
  metaTone = 'muted',
  // SOLID HEADER BAND — the client's Deal hub design (Oct 2026).
  //
  // Opt-in, and deliberately so: Panel is the shared chrome for seven tabs,
  // so flipping the default here would restyle Businesses, Contacts, Tasks,
  // Notes and the rest at the same time. Deal hub passes it; nothing else
  // does, until the same design lands on those tabs too.
  solidHeader = false,
  // The toolbar band's fill. White by default (see the note on the band);
  // the Deals design puts its labelled field row on a grey band instead.
  toolbarBackground = 'var(--surface-card)'
}) {
  // On a solid band the title and icon are white and the band carries the
  // accent; on the pale default the band is the tint and the TEXT carries the
  // accent. Both read from the same `accent` name.
  const color = solidHeader ? '#fff' : `var(--accent-${accent}-text)`
  const tint = solidHeader
    ? `var(--panel-head-${accent}, var(--accent-${accent}))`
    : `var(--tint-${accent})`
  // 13px white on clay (4.40:1) and gold (3.25:1) misses AA for normal text —
  // see the measured table in dealhub-tokens.css. The title is 18px/600 and
  // clears AA-large on every band; the smaller meta beside it does not, so on
  // a solid header it gets full white rather than the 85% the design shows.
  const metaColor = solidHeader ? 'rgba(255,255,255,0.92)' : 'var(--text-muted)'
  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: color,
        ['--panel-tint']: tint,
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        overflow: 'hidden'
      }}
    >
      <header
        style={{
          display: 'flex', gap: 9,
          // WRAPS: with actionFill the action takes a full row of its own
          // below the title (see its flexBasis), which is what puts its
          // controls at the panel's left margin rather than indented to the
          // title's right edge.
          //
          // Items stay CENTRED — the title is alone on its row now, so there
          // is nothing taller beside it to align against, and flex-start would
          // only lift the count badge off the title's baseline.
          flexWrap: 'wrap',
          alignItems: 'center',
          padding: 'var(--space-3) var(--space-4)',
          // The band itself. Pale tint by default; the accent at full
          // strength when solidHeader is set.
          background: tint,
          // A line under the title, separating the header from whatever
          // follows — the filter band or the list itself. Always drawn now:
          // the toolbar used to bring its own top border, but it is white
          // rather than tinted, so without this line the header and the
          // filter row ran together as one white block.
          //
          // On a solid band the default grey rule disappears into the colour,
          // so it steps to a darker shade of the band's own accent.
          borderBottom: solidHeader
            ? `1px solid var(--panel-head-${accent}-border, var(--border-default))`
            : '1px solid var(--border-default)'
        }}
      >
        <span className="ms" style={{ fontSize: 20, color }}>{icon}</span>
        <h2 style={{ fontSize: 'var(--text-xl)', fontWeight: 600, color, margin: 0 }}>
          {title}
        </h2>
        {/* A count BADGE beside the title.
            `meta` renders as plain text on the far right, which reads as a
            caption about the panel. A number pressed against the title reads
            as part of it — "Notes 9" — and does not need the noun repeated. */}
        {count != null && (
          <span title={countTitle} style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            minWidth: 24, height: 22, padding: '0 8px', flex: 'none',
            borderRadius: 'var(--radius-pill)',
            // On a solid band the grey pill disappears into the colour, so it
            // inverts: white chip, accent text — the same pairing the design
            // uses for the "DEAL" pill on the deal-name card.
            background: solidHeader ? '#fff' : 'var(--gray-100)',
            fontSize: 'var(--text-base)', fontWeight: 600,
            fontVariantNumeric: 'tabular-nums',
            color: solidHeader
              ? `var(--panel-head-${accent}, var(--accent-${accent}))`
              : 'var(--text-muted)'
          }}>
            {count}
          </span>
        )}
        {/* Pushes a lone action to the right. NOT when the action fills the
            row itself — two things claiming the free space leaves the toolbar
            no width to right-align its own controls within. */}
        {!actionFill && <span style={{ flex: 1 }} />}
        {meta != null && (
          <span
            // An error is announced, not just displayed: a screen reader user
            // gets no colour, and this text is the only report of the failure.
            role={metaTone === 'error' ? 'alert' : undefined}
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 'var(--text-md)',
              fontWeight: metaTone === 'error' ? 600 : 400,
              // An error keeps its red on a pale band. On a SOLID one red on
              // clay or plum is unreadable, so the failure stays white and
              // leans on its icon and weight instead — the role="alert" above
              // is what actually reports it either way.
              color: metaTone === 'error'
                ? (solidHeader ? '#fff' : 'var(--status-stuck-text)')
                : metaColor
            }}
          >
            {metaTone === 'error' && (
              <span className="ms" style={{ fontSize: 16 }}>error</span>
            )}
            {meta}
          </span>
        )}
        {/* After the count, so the header reads "Task queue … 9 open [+ Add
            task]" — the state first, then what you can do about it. */}
        {action && (
          <span style={{
            // GROWS to fill the title row when the action is a whole control
            // row rather than a lone button — a toolbar with its own
            // right-aligned group needs the width to push against.
            //
            // NOT a full row of its own. The title, search, owner and tag
            // belong on ONE line: making this flexBasis:100% pushed the whole
            // group below the title and cost a third line to say nothing.
            //
            // The action's OWN second row (filters, chips, save view) is
            // handled by `actionBreak` below, which is a sibling of this box
            // in the header — so it wraps against the header's left padding
            // rather than this box's left edge.
            flex: actionFill ? 1 : 'none',
            minWidth: 0,
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            flexWrap: 'nowrap',
            rowGap: 'var(--space-2)'
          }}>
            {action}
          </span>
        )}
        {/* Second row: wraps to 100% so it starts at the header's left
            padding, in line with the title above and the list below. Inside
            the same <header>, so it shares the header's padding and the
            border beneath it rather than drawing a band of its own. */}
        {actionBreak && (
          <div style={{
            flexBasis: '100%', minWidth: 0,
            display: 'flex', alignItems: 'center', gap: 'var(--space-2)',
            flexWrap: 'wrap', rowGap: 'var(--space-2)'
          }}>
            {actionBreak}
          </div>
        )}
      </header>

      {toolbar && (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap',
            padding: '10px var(--space-4)',
            // White, like the rest of the panel. The tinted band read as its
            // own section wedged between the title and the list, which is
            // exactly what the panel is trying not to be. A single bottom
            // border is enough to separate it from the rows below — the top
            // edge is already implied by the header above it.
            borderBottom: '1px solid var(--border-default)',
            background: toolbarBackground
          }}
        >
          {toolbar}
        </div>
      )}

      <div style={{ paddingTop: contentPad ? 'var(--space-3)' : 0 }}>
        {children}
      </div>
    </section>
  )
}

// A row in a Panel. Last row drops its divider so it doesn't double up with
// the panel's own border.
export function Row({ children, last, align = 'flex-start' }) {
  return (
    <div
      style={{
        display: 'flex', alignItems: align, gap: 'var(--space-3)',
        padding: '13px var(--space-4)',
        borderBottom: last ? 'none' : '1px solid var(--border-default)'
      }}
    >
      {children}
    </div>
  )
}

// ── Truncation ────────────────────────────────────────────────────────

// One line of text that ellipsises rather than overflowing its box, and
// reveals itself on hover WHEN IT HAS BEEN CUT — never otherwise.
//
// The app had 73 places doing the ellipsis by hand and 64 of them had no
// tooltip, so a clipped deal name, email or business was simply unreadable:
// the information was on screen, cut off, with no way to read the rest short
// of opening the record.
//
// The tooltip is CONDITIONAL on purpose. A `title` on every line would fire
// on text that is already fully visible — a tooltip repeating what you are
// looking at is noise. scrollWidth > clientWidth is the only reliable test,
// and it is only knowable after layout, so it is measured rather than
// guessed from string length (which cannot account for font, weight, or the
// width of the box).
export function Truncate({ children, title, as: Tag = 'span', style, ...rest }) {
  const ref = useRef(null)
  const [clipped, setClipped] = useState(false)

  // Re-measured when the text changes AND when the element resizes — a
  // column dragged narrower clips text that fitted a moment ago, and a
  // one-shot measurement on mount would never notice.
  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => setClipped(el.scrollWidth > el.clientWidth + 1)
    measure()
    if (typeof ResizeObserver === 'undefined') return undefined
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [children, title])

  // The caller's own text wins when given (a cell may show "3 days ago" and
  // want the full date); otherwise the text itself is the tooltip, and only
  // when it is a plain string — a tooltip reading "[object Object]" is worse
  // than none at all.
  const full = title != null
    ? title
    : (typeof children === 'string' || typeof children === 'number' ? String(children) : undefined)

  return (
    <Tag
      ref={ref}
      title={clipped ? full : undefined}
      style={{
        minWidth: 0,
        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
        ...style
      }}
      {...rest}
    >
      {children}
    </Tag>
  )
}

// ── Chips ─────────────────────────────────────────────────────────────

export function ContactChip({ name, onClick }) {
  return (
    <Chip icon="person" onClick={onClick} title={onClick ? 'Open contact record' : undefined}>
      {name || 'Contact'}
    </Chip>
  )
}

export function DealPill({
  name, onClick, empty = false, draggable, onDragStart,
  // Dense surfaces — the deal board's cards are a column wide, and the
  // full-size pill took roughly four times the width of the 26px icon button
  // it replaced, crowding the title it sits beside. Same shape and the same
  // two halves, scaled down: the control stays recognisable rather than
  // becoming a different control on one screen.
  compact = false
}) {
  const live = typeof onClick === 'function' && !empty
  const Tag = live ? 'button' : 'span'
  // Darkened rose rather than the alert red: this is a STATE, not a failure,
  // and a full-strength red on every unlinked row reads as a page full of
  // errors.
  const fill = empty ? 'var(--status-stuck)' : 'var(--green-500)'

  return (
    <Tag
      onClick={live ? onClick : undefined}
      title={
        empty ? 'Not linked to a deal'
          : live ? `Open ${name || 'this deal'}`
          : (name || undefined)
      }
      draggable={draggable}
      onDragStart={onDragStart}
      style={{
        display: 'inline-flex', alignItems: 'center',
        // COMPACT IS THE LINKED-RECORDS SIZE. It sits in the same stack as
        // LinkedRow's contact and business pills (shared/LinkedRecords.jsx)
        // and ran a size down — 22px/10px against their 24px/text-sm — so
        // the deal pill was the odd one out. These are their numbers
        // exactly; change both or neither.
        gap: compact ? 6 : 7,
        height: compact ? 24 : 26,
        padding: compact ? '0 4px 0 10px' : '0 4px 0 10px',
        flex: 'none',
        border: 'none', borderRadius: 'var(--radius-pill)',
        background: fill,
        fontFamily: 'var(--font-sans)',
        // 11px full-size, two below the token sizes this started on. The
        // pill is a compact control, not running text, and at --text-base
        // the word "View" carried more weight than the deal names beside it.
        fontSize: compact ? 'var(--text-sm)' : 11,
        fontWeight: 600,
        color: '#fff',
        cursor: live ? 'pointer' : 'default',
        whiteSpace: 'nowrap'
      }}
    >
      {empty ? 'No' : 'View'}
      {/* The white capsule. Its colour matches the pill so the two read as
          one object rather than a badge sitting on a button. */}
      {/* Glyph only — a tag for a deal, matching LinkedRow's capsules. The
          word is the tooltip and the accessible name. */}
      <span
        title="Deal"
        aria-label="Deal"
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          height: compact ? 18 : 19, minWidth: compact ? 18 : 19,
          padding: '0 5px',
          borderRadius: 'var(--radius-pill)',
          background: '#fff',
          color: fill
        }}
      >
        <span className="ms" style={{ fontSize: 13 }}>sell</span>
      </span>
    </Tag>
  )
}

// DealPill's shape for the OTHER records — "View | CONTACT" in sky,
// "View | BUSINESS" in plum — so the three ways out of a card read as one
// family that differs only by colour. Inert without an onClick.
const RECORD_FILL = {
  CONTACT: 'var(--accent-sky)',
  BUSINESS: 'var(--panel-head-plum, var(--accent-plum))',
  // The Contacts list's expanded rows — the Tasks and Notes pills' colours.
  TASK: 'var(--panel-head-clay, var(--accent-clay))',
  NOTE: 'var(--panel-head-brown, var(--accent-brown))'
}
// The capsule's icon — the same glyphs LinkedRecords' LINK_TONES use.
const RECORD_GLYPH = { CONTACT: 'person', BUSINESS: 'domain', TASK: 'task_alt', NOTE: 'sticky_note_2' }
export function RecordPill({ kind, name, onClick, draggable, onDragStart }) {
  const live = typeof onClick === 'function'
  const Tag = live ? 'button' : 'span'
  const fill = RECORD_FILL[kind] || 'var(--gray-500)'
  return (
    <Tag
      type={live ? 'button' : undefined}
      onClick={live ? onClick : undefined}
      title={live ? `Open ${name || `this ${kind.toLowerCase()}`}` : (name || undefined)}
      draggable={draggable}
      onDragStart={onDragStart}
      // LinkedRow's pill exactly (shared/LinkedRecords.jsx) — the same
      // numbers DealPill's compact size took. Change all three or none.
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        height: 24, padding: '0 4px 0 10px', flex: 'none',
        border: 'none', borderRadius: 'var(--radius-pill)',
        background: fill,
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)', fontWeight: 600,
        color: '#fff', whiteSpace: 'nowrap',
        cursor: live ? 'pointer' : 'default'
      }}
    >
      View
      {/* GLYPH ONLY, like the DEAL pill: a person for a contact, a building
          for a business. The word is the tooltip and the accessible name —
          the icon says it on its own, and "CONTACT" / "BUSINESS" made the
          capsule wider than the "View" beside it. */}
      <span
        title={kind}
        aria-label={kind}
        style={{
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          height: 18, minWidth: 18, padding: '0 5px',
          borderRadius: 'var(--radius-pill)', background: '#fff', color: fill
        }}
      >
        <span className="ms" style={{ fontSize: 13 }}>{RECORD_GLYPH[kind] || 'link'}</span>
      </span>
    </Tag>
  )
}

export function Chip({
  icon, children, onClick, title, tone, danger,
  // Forwarded for chips placed inside a DRAGGABLE card (the deal board). A
  // button inside a draggable element starts its own drag on mousedown,
  // which cancels the click entirely — so the board's chip has to opt out.
  // Omitted everywhere else, where the defaults are correct.
  draggable, onDragStart
}) {
  // A <button> only when it DOES something. A decorative chip inside a card
  // that is itself a button nested a button in a button — invalid HTML, and
  // it put three extra stops in the tab order of every business card for
  // controls that cannot be activated.
  const Tag = onClick ? 'button' : 'span'
  const isDeal = tone === 'deal'
  // An ABSENCE, not a value: dashed border, muted text, no fill. It has to
  // stay legible next to a filled chip without competing with it.
  const isEmpty = tone === 'empty'
  return (
    <Tag
      onClick={onClick}
      title={title}
      draggable={draggable}
      onDragStart={onDragStart}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 6,
        maxWidth: 260,
        height: 30, padding: '0 var(--space-3)',
        border: `1px ${isEmpty ? 'dashed' : 'solid'} ${
          danger ? 'var(--border-default)'
            : isDeal ? 'var(--green-300)'
            : 'var(--border-default)'
        }`,
        borderRadius: 'var(--radius-pill)',
        // tint-pine, not green-50: these chips have a green-300 border so the
        // shape reads either way, but green-50 is 1.13:1 against a white row.
        background: isDeal ? 'var(--tint-pine)' : '#fff',
        color: danger
          ? 'var(--status-stuck)'
          : isDeal ? 'var(--green-600)'
          : isEmpty ? 'var(--text-faint)'
          : 'var(--text-body)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-base)', fontWeight: 500,
        cursor: onClick ? 'pointer' : 'default',
        whiteSpace: 'nowrap'
      }}
    >
      {icon && <span className="ms" style={{ fontSize: 15, flex: 'none' }}>{icon}</span>}
      <Truncate>{children}</Truncate>
    </Tag>
  )
}

// A toolbar control with its label ABOVE it — the Tasks and Notes toolbar
// bands.
//
// flex:none on the stack, so a label and its control always wrap together —
// inline labels let a row break between "ASSIGNEE" and the select it names.
export function LabelledControl({ label, children }) {
  return (
    <span style={{ display: 'flex', flexDirection: 'column', gap: 5, flex: 'none' }}>
      <span style={{
        fontSize: 11, fontWeight: 600, letterSpacing: '.05em',
        textTransform: 'uppercase', color: '#4a515c'
      }}>
        {label}
      </span>
      {children}
    </span>
  )
}

// Small square icon button for row-level edit / delete.
// Live when given an onClick, inert without one. It used to render
// `cursor: pointer` either way, so the actions still waiting on a write path
// looked clickable and did nothing.
export function RowAction({ icon, onClick, title, danger }) {
  const live = typeof onClick === 'function'
  return (
    <button
      onClick={onClick}
      disabled={!live}
      title={title}
      style={{
        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        // A ROUNDED SQUARE, per the design — 26px with a 6px corner. It was
        // 30px on --radius-md, which the Deal hub theme sets to 12px, so the
        // buttons read as circles beside the design's squares.
        width: 26, height: 26, flex: 'none', padding: 0,
        border: '1px solid var(--border-default)',
        borderRadius: 6,
        background: '#fff',
        // Danger keeps its colour either way — the opacity below carries the
        // disabled state, and a greyed-out red would stop reading as danger.
        color: danger
          ? 'var(--status-stuck)'
          : live ? 'var(--text-body)' : 'var(--text-faint)',
        cursor: live ? 'pointer' : 'not-allowed',
        opacity: live ? 1 : 0.6
      }}
    >
      <span className="ms" style={{ fontSize: 15 }}>{icon}</span>
    </button>
  )
}

export function PrimaryAction({ children, onClick, icon = 'add' }) {
  return (
    <button
      onClick={onClick}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 7,
        height: 36, padding: '0 var(--space-4)',
        border: 'none', borderRadius: 'var(--radius-md)',
        background: 'var(--brand-primary)', color: '#fff',
        boxShadow: '0 1px 2px rgba(13, 91, 64, 0.25)',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
        cursor: 'pointer'
      }}
    >
      <span className="ms" style={{ fontSize: 18 }}>{icon}</span>
      {children}
    </button>
  )
}

export function FilterChip({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 32, padding: '0 15px',
        border: active
          ? '1.5px solid var(--brand-primary)'
          : '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-pill)',
        background: active ? 'var(--brand-primary)' : '#fff',
        color: active ? '#fff' : 'var(--text-body)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-md)', fontWeight: active ? 600 : 400,
        cursor: 'pointer'
      }}
    >
      {label}
    </button>
  )
}

// Search now runs server-side (pagination means filtering the loaded page
// would hide matches further down), so callers commit on Enter/blur rather
// than on every keystroke — hence the extra handlers.
export function SearchInput({ value, onChange, placeholder, width = 300, onKeyDown, onBlur }) {
  return (
    <input
      value={value}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
      onBlur={onBlur}
      placeholder={placeholder}
      style={{
        width, maxWidth: '100%', height: 36, boxSizing: 'border-box',
        padding: '0 var(--space-3)',
        border: '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', color: 'var(--text-body)'
      }}
    />
  )
}

// Loading / empty / error, so every tab words these the same way.
//
// `loading` renders row skeletons rather than a text line: these panels are
// the page's whole content, so a bare "Loading…" leaves the layout empty and
// then snaps. Pass skeletonRows to match the density of the real rows.
// The empty state takes an icon and tint so a panel can match its own accent
// instead of every empty state in the app being gold with an inbox glyph — a
// teal Timeline panel showing a gold card read as a warning rather than as
// "nothing here yet".
//
// `inline` drops the border, tint and margin for an empty state rendered
// INSIDE an already-bordered panel, where the default card-in-a-card looks
// like a layout bug. It keeps the padding and centring so the panel still has
// deliberate height rather than collapsing to nothing.
//
// `emptyTitle` is the short answer ("No messages yet"); `emptyText` is the
// explanation under it. Title alone is fine — a state nobody needs explaining
// shouldn't be padded out with a sentence.
export function StateMessage({
  loading, error, empty, emptyText, emptyTitle, loadingText, skeletonRows = 4,
  emptyIcon = 'inbox', inline = false, action = null
}) {
  if (error) {
    return (
      <div
        style={{
          display: 'flex', alignItems: 'flex-start', gap: 'var(--space-2)',
          margin: 'var(--space-2) 0',
          padding: 'var(--space-3) var(--space-4)',
          border: '1px solid var(--status-stuck)',
          borderLeft: '4px solid var(--status-stuck)',
          borderRadius: 'var(--radius-md)',
          background: 'var(--tint-rose)',
          fontSize: 'var(--text-md)', lineHeight: 'var(--leading-normal)',
          color: 'var(--text-heading)'
        }}
      >
        <span className="ms" style={{ fontSize: 18, color: 'var(--status-stuck)', flex: 'none' }}>
          error
        </span>
        <span>{error}</span>
      </div>
    )
  }
  if (loading) {
    return <RowSkeletons rows={skeletonRows} label={loadingText} />
  }
  if (empty) {
    return (
      <div
        style={{
          margin: inline ? 0 : 'var(--space-2) 0',
          padding: inline ? '44px var(--space-5)' : '28px var(--space-5)',
          border: inline ? 'none' : '1px dashed var(--accent-gold)',
          borderRadius: inline ? 0 : 'var(--radius-md)',
          background: inline ? 'transparent' : 'var(--tint-gold)',
          textAlign: 'center'
        }}
      >
        {/* A tinted disc behind the glyph. A bare icon on a white panel reads
            as a stray character; the disc makes it deliberate. */}
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 46, height: 46, borderRadius: '50%',
            background: inline ? 'var(--panel-tint, var(--gray-50))' : 'transparent'
          }}
        >
          <span
            className="ms"
            style={{
              fontSize: 26,
              color: inline
                ? 'var(--panel-accent, var(--text-faint))'
                : 'var(--accent-gold-text)'
            }}
          >
            {emptyIcon}
          </span>
        </span>
        {emptyTitle && (
          <p
            style={{
              margin: '10px 0 0',
              fontSize: 'var(--text-lg)', fontWeight: 600,
              color: 'var(--text-heading)'
            }}
          >
            {emptyTitle}
          </p>
        )}
        {emptyText && (
          <p
            style={{
              margin: emptyTitle ? '4px auto 0' : '8px auto 0', maxWidth: 380,
              fontSize: 'var(--text-md)', lineHeight: 'var(--leading-normal)',
              color: 'var(--text-muted)'
            }}
          >
            {emptyText}
          </p>
        )}
        {action && <div style={{ marginTop: 'var(--space-3)' }}>{action}</div>}
      </div>
    )
  }
  return null
}

// ── Skeletons ─────────────────────────────────────────────────────────
//
// Shared with the Deal Hub's shimmer (pages/dealhub/Skeleton.jsx) via the
// same .pp-sk class, so there's one animation definition in the app. This
// module injects it too, since the list tabs render without the Deal Hub
// mounted.

const SHIMMER_CSS = `
@keyframes pp-shimmer {
  0%   { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
.pp-sk {
  background: linear-gradient(
    90deg,
    var(--gray-100) 25%,
    var(--gray-50)  37%,
    var(--gray-100) 63%
  );
  background-size: 200% 100%;
  animation: pp-shimmer 1.4s ease-in-out infinite;
  border-radius: var(--radius-sm);
}
@media (prefers-reduced-motion: reduce) {
  .pp-sk { animation: none; }
}
`

export function SkeletonStyles() {
  return <style>{SHIMMER_CSS}</style>
}

export function Bar({ w = '100%', h = 12, r, style }) {
  return (
    <span
      className="pp-sk"
      style={{
        display: 'block', width: w, height: h,
        borderRadius: r ?? 'var(--radius-sm)',
        ...style
      }}
    />
  )
}

// Rows inside a Panel: icon block, two text lines, chips right. Matches the
// shape of a Notes / Tasks row so the layout doesn't jump when data lands.
export function RowSkeletons({ rows = 4, label }) {
  return (
    <>
      <SkeletonStyles />
      {label && (
        <span
          style={{
            position: 'absolute', width: 1, height: 1,
            overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap'
          }}
        >
          {label}
        </span>
      )}
      {Array.from({ length: rows }).map((_, i) => (
        <div
          key={i}
          style={{
            display: 'flex', alignItems: 'flex-start', gap: 'var(--space-3)',
            padding: '13px var(--space-4)',
            borderBottom: i === rows - 1 ? 'none' : '1px solid var(--border-default)'
          }}
        >
          <Bar w={30} h={30} r="var(--radius-md)" style={{ flex: 'none' }} />
          <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 7 }}>
            {/* Widths vary per row so it reads as text arriving, not a table. */}
            <Bar w={i % 2 ? '38%' : '52%'} h={13} />
            <Bar w={i % 3 === 0 ? '78%' : '62%'} h={11} />
            <Bar w={112} h={10} />
          </div>
          <div style={{ display: 'flex', gap: 6, flex: 'none' }}>
            <Bar w={104} h={30} r="var(--radius-pill)" />
            <Bar w={124} h={30} r="var(--radius-pill)" />
            <Bar w={30} h={30} r="var(--radius-md)" />
          </div>
        </div>
      ))}
    </>
  )
}

// Card-grid skeleton for the Contacts tab.
export function CardGridSkeleton({ cards = 8, minWidth = 260 }) {
  return (
    <>
      <SkeletonStyles />
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(auto-fill, minmax(${minWidth}px, 1fr))`,
          gap: 'var(--space-3)'
        }}
      >
        {Array.from({ length: cards }).map((_, i) => (
          <div
            key={i}
            style={{
              border: '1px solid var(--border-default)',
              borderTop: '3px solid var(--gray-200)',
              borderRadius: 'var(--radius-md)',
              background: '#fff',
              padding: 14, display: 'grid', gap: 10
            }}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <Bar w={34} h={34} r="50%" style={{ flex: 'none' }} />
              <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
                <Bar w={i % 2 ? '58%' : '74%'} h={13} />
                <Bar w="40%" h={10} />
              </div>
            </div>
            <div style={{ display: 'grid', gap: 6 }}>
              <Bar w="86%" h={11} />
              <Bar w="64%" h={11} />
            </div>
          </div>
        ))}
      </div>
    </>
  )
}

// Deal cards on the Deals tab — header, four field controls, contact pills.
export function DealCardsSkeleton({ cards = 3 }) {
  return (
    <>
      <SkeletonStyles />
      {Array.from({ length: cards }).map((_, i) => (
        <section
          key={i}
          style={{
            border: '2px solid var(--gray-200)',
            borderRadius: 'var(--radius-md)',
            background: '#fff', overflow: 'hidden'
          }}
        >
          <div style={{ display: 'flex', gap: 'var(--space-3)', padding: '14px var(--space-4) 0', alignItems: 'flex-start' }}>
            <Bar w={20} h={20} style={{ flex: 'none', marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0, display: 'grid', gap: 6 }}>
              <Bar w={i % 2 ? '32%' : '44%'} h={17} />
              <Bar w="58%" h={11} />
            </div>
            <Bar w={112} h={34} r="var(--radius-md)" style={{ flex: 'none' }} />
          </div>
          <div
            style={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))',
              gap: 'var(--space-3)', padding: 'var(--space-3) var(--space-4) 0'
            }}
          >
            {[0, 1, 2, 3].map((k) => (
              <div key={k} style={{ display: 'grid', gap: 5 }}>
                <Bar w={72} h={9} />
                <Bar w="100%" h={36} r="var(--radius-md)" />
              </div>
            ))}
          </div>
          <div style={{ padding: 'var(--space-3) var(--space-4) 0' }}>
            <Bar w="66%" h={11} />
          </div>
          <div style={{ padding: 'var(--space-3) var(--space-4) var(--space-4)', display: 'grid', gap: 7 }}>
            <Bar w={132} h={9} />
            <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
              <Bar w={186} h={42} r="var(--radius-pill)" />
              <Bar w={168} h={42} r="var(--radius-pill)" />
            </div>
          </div>
        </section>
      ))}
    </>
  )
}


// The page container.
//
// FULL WIDTH BY DEFAULT. It was capped at 1140px and centred, which left a
// third of a wide screen empty on every tab — a task queue, a note list and a
// business roll-up are all scanned in rows, and a row that stops two thirds
// of the way across wastes the space it needed. A caller can still pass a cap
// where reading length genuinely matters.
export function Shell({ children, maxWidth = 'none' }) {
  return (
    <div
      style={{
        maxWidth, width: '100%', boxSizing: 'border-box',
        // space-3 on top, not space-1 (4px): a focused search box draws a
        // ring outside its border, and at 4px that ring was clipped by the
        // tab strip directly above it. Applies to every tab's page.
        margin: '0 auto', padding: 'var(--space-3) 20px var(--space-7)',
        display: 'grid', gap: 'var(--space-4)'
      }}
    >
      {children}
    </div>
  )
}

// ── Date helpers, shared so the tabs word dates identically ───────────

const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec']

export function formatDate(iso, withYear = true) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return `${d.getDate()} ${MONTHS[d.getMonth()]}${withYear ? ` ${d.getFullYear()}` : ''}`
}

// Relative phrasing for recent things ("2 days ago"), absolute past a
// fortnight where "23 days ago" stops being easier to read than a date.
export function relativeTime(iso) {
  if (!iso) return null
  const then = new Date(iso).getTime()
  if (Number.isNaN(then)) return null
  const mins = Math.round((Date.now() - then) / 60000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const hours = Math.round(mins / 60)
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`
  const days = Math.round(hours / 24)
  if (days === 1) return 'yesterday'
  if (days <= 14) return `${days} days ago`
  return formatDate(iso)
}

// Due dates read as "due yesterday / today / tomorrow" near now, and as a
// date further out — matching the design's phrasing.
export function formatDue(iso) {
  if (!iso) return null
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  const startOfToday = new Date()
  startOfToday.setHours(0, 0, 0, 0)
  const startOfDue = new Date(d)
  startOfDue.setHours(0, 0, 0, 0)
  const days = Math.round((startOfDue - startOfToday) / 86400000)
  if (days === 0) return 'due today'
  if (days === -1) return 'due yesterday'
  if (days === 1) return 'due tomorrow'
  if (days < -1 && days >= -14) return `due ${Math.abs(days)} days ago`
  return `due ${formatDate(iso, false)}`
}

export function initialsFor(firstName, lastName, fallback) {
  const a = (firstName || '').trim()
  const b = (lastName || '').trim()
  if (a && b) return (a[0] + b[0]).toUpperCase()
  if (a) return a.slice(0, 2).toUpperCase()
  if (b) return b.slice(0, 2).toUpperCase()
  const f = (fallback || '').trim()
  return f ? f[0].toUpperCase() : '?'
}

export function nameFor(p) {
  const first = (p?.firstName || '').trim()
  const last = (p?.lastName || '').trim()
  if (first && last) return `${first} ${last}`
  if (first || last) return first || last
  // No name on the contact. A business reads as a party you're dealing with;
  // an email at least looks like a person. A raw phone number does not — it
  // goes on the pill's detail line instead, where it reads as a contact method
  // rather than as somebody's name.
  return p?.business || p?.email || 'Unnamed contact'
}

// End-of-list sentinel + status. Render after the rows; the ref goes on the
// element an IntersectionObserver watches, so reaching it loads the next page.
// `plural` for a noun that does not take a plain s — "business" read as
// "2 businesss — that's everything".
export function LoadMore({ sentinelRef, hasMore, loadingMore, count, total = null, noun = 'item', plural = null }) {
  return (
    <div
      ref={sentinelRef}
      style={{
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        gap: 'var(--space-2)', padding: 'var(--space-4)',
        fontSize: 'var(--text-base)', color: 'var(--text-muted)'
      }}
    >
      {loadingMore ? (
        <>
          <SkeletonStyles />
          <Bar w={16} h={16} r="50%" />
          <span>Loading more…</span>
        </>
      ) : hasMore ? (
        <span>
          {total != null
            ? `Showing ${count} of ${total} — scroll for more`
            : 'Scroll for more'}
        </span>
      ) : count > 0 ? (
        <span>
          {count} {count === 1 ? noun : (plural || `${noun}s`)} — that's everything
        </span>
      ) : null}
    </div>
  )
}

// Note and task bodies. GHL's editor is rich text, so these are stored as
// markup — render them as HTML rather than showing the user raw tags.
//
// The plain-text toggle is there because markup isn't always wanted: copying a
// note into an email, or reading a body whose formatting is noise rather than
// meaning. Stripping happens here in the browser — no server round trip and
// nothing stored differently.
// "2 files" — the count only, never the files themselves.
//
// GHL does not send attachments on a note webhook, so noteWriter fetches
// GET /notes/:id and the response lands in raw_note; the server counts the
// array in SQL. The URLs GHL returns are signed and expire, so offering them
// from our stored copy would hand out links that may already be dead. A count
// tells a rep the note has files and to open it in the CRM to read them.
export function AttachmentCount({ count }) {
  if (!count) return null
  return (
    <span
      title={`${count} ${count === 1 ? 'file' : 'files'} attached — open the note in your CRM to view`}
      style={{
        display: 'inline-flex', alignItems: 'center', gap: 4,
        padding: '2px 8px',
        borderRadius: 'var(--radius-pill)',
        background: 'var(--surface-sunken)', color: 'var(--text-muted)',
        fontSize: 'var(--text-sm)', fontWeight: 600
      }}
    >
      <span className="ms" style={{ fontSize: 13 }}>attach_file</span>
      {count} {count === 1 ? 'file' : 'files'}
    </span>
  )
}

export function RichBody({
  html, maxWidth = 640, size = 'var(--text-md)',
  // Callers that pair this with a heading need it muted, so the two lines
  // separate by colour as well as size. Defaults to body text.
  color = 'var(--text-body)',
  // Paragraph-length bodies want more air between lines than a one-line
  // caption does. Overridable so a caller sizing the text up can loosen the
  // leading to match — the two have to move together or a bigger font just
  // reads as more crowded.
  leading = 1.5,
  // Hide the "Show plain text" toggle.
  //
  // For a CARD: the body is clamped to three lines with its own "Read note"
  // link, and a second control offering a different way to see the same text
  // is one control too many in a 340px card — it also took the line that
  // pushed the edit and delete buttons out of view.
  showPlainToggle = true
}) {
  const [plain, setPlain] = useState(false)

  // SANITISED HERE, at the single render site.
  //
  // This component is the ONLY place note/task HTML reaches
  // dangerouslySetInnerHTML, and it is used by six callers (the notes tab, the
  // tasks tab, the deal timeline, the task rail, the note rail). Nothing
  // filtered the markup: not the server — notePatch validates type and length
  // only — and not the client.
  //
  // A note body is attacker-influenceable. Anyone with access to the
  // sub-account can write one through GoHighLevel, and inbound integrations
  // write them too. So a <script> or an onerror= attribute in a note executed
  // inside this dashboard, with the session's credentials.
  //
  // Sanitising in RichBody rather than at each caller means a new caller
  // cannot forget. useMemo because this parses HTML, and a timeline of 200
  // notes would otherwise re-parse every one on each render.
  //
  // Before the early return below: a hook cannot sit after a conditional
  // return, and disabling the lint rule there would have hidden a real bug
  // rather than a false positive — React tracks hooks by call order, so a
  // render that bailed early would desynchronise every hook after it.
  const safe = useMemo(() => sanitiseHtml(html), [html])

  if (!html) return null

  const text = plain ? toPlainText(html) : null
  const base = {
    margin: 0, maxWidth,
    fontSize: size, lineHeight: leading, color
  }

  return (
    <div style={{ display: 'grid', gap: 'var(--space-1)' }}>
      {plain ? (
        <p style={{ ...base, whiteSpace: 'pre-line' }}>{text}</p>
      ) : (
        <div
          className="pp-rich"
          style={{ ...base, overflowWrap: 'anywhere' }}
          dangerouslySetInnerHTML={{ __html: safe }}
        />
      )}

      {/* Only when stripping would change what you read — not merely when
          markup exists. See hasMeaningfulFormatting. */}
      {showPlainToggle && hasMeaningfulFormatting(html) && (
        <button
          onClick={() => setPlain((v) => !v)}
          style={{
            justifySelf: 'start',
            border: 'none', background: 'none', padding: 0, cursor: 'pointer',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
            color: 'var(--text-link)', textDecoration: 'underline'
          }}
        >
          {plain ? 'Show formatted' : 'Show plain text'}
        </button>
      )}
    </div>
  )
}

// Whether stripping the markup would actually change what you READ.
//
// Every GHL body arrives wrapped in <p style="...">, so hasMarkup() is true for
// all of them and the toggle appeared on every single note and task — a
// permanent line of chrome for an escape hatch almost nobody uses.
//
// This asks the narrower question: is there formatting worth toggling? A single
// wrapper paragraph is not; a list, a link, bold text or several blocks is.
function hasMeaningfulFormatting(html) {
  const raw = String(html || '')
  if (!raw) return false
  if (/<(ul|ol|li|table|a|strong|b|em|i|u|code|pre|blockquote|h[1-6]|img|br)\b/i.test(raw)) {
    return true
  }
  // More than one block element means real paragraph structure.
  const blocks = raw.match(/<(p|div)\b/gi) || []
  return blocks.length > 1
}

// Browser-native parse — no dependency, and the same engine that rendered the
// markup above does the stripping.
function toPlainText(html) {
  const doc = new DOMParser().parseFromString(String(html || ''), 'text/html')
  doc.querySelectorAll('script, style').forEach((el) => el.remove())
  // Block boundaries become newlines, or every paragraph runs together.
  doc.querySelectorAll('br').forEach((el) => el.replaceWith('\n'))
  doc.querySelectorAll('p, div, li, tr, h1, h2, h3, h4, h5, h6')
    .forEach((el) => el.append('\n'))
  return (doc.body.textContent || '')
    .replace(/\u00a0/g, ' ')
    .replace(/[ \t]+/g, ' ')
    .replace(/ *\n */g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

// Sort control. Square and small — deliberately unlike the pill FilterChips,
// because sorting and filtering do different things and shouldn't look alike.
//
// Not used by Tasks or Notes: the v5 design has no sort on those pages. Kept
// here for the list pages the spec does call for (Deals, Contacts).
export function SortButton({ label, active, onClick }) {
  return (
    <button
      onClick={onClick}
      style={{
        height: 26, padding: '0 9px', cursor: 'pointer',
        border: active
          ? '1px solid var(--brand-primary)'
          : '1px solid var(--border-strong)',
        borderRadius: 'var(--radius-sm)',
        background: active ? 'var(--brand-primary)' : '#fff',
        color: active ? '#fff' : 'var(--text-body)',
        fontFamily: 'var(--font-sans)',
        fontSize: 'var(--text-sm)', fontWeight: active ? 600 : 400
      }}
    >
      {label}
    </button>
  )
}

// A note linked to a task or another note (migration 054). Gold, matching the
// Notes accent, so a linked note is recognisable wherever it appears.
export function NoteChip({ label, onClick }) {
  return (
    <span
      title={label}
      onClick={onClick}
      style={{
        display: 'flex', alignItems: 'center', gap: 'var(--space-1)',
        maxWidth: 240,
        padding: '3px 9px',
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-pill)',
        background: 'var(--tint-gold)', color: 'var(--text-body)',
        fontSize: 'var(--text-sm)', fontWeight: 500,
        cursor: onClick ? 'pointer' : 'default'
      }}
    >
      <span className="ms" style={{ fontSize: 12, color: 'var(--accent-gold)' }}>
        sticky_note_2
      </span>
      <Truncate>
        {label}
      </Truncate>
    </span>
  )
}

// Open tasks and notes as small chips. Shared by the deal card and the
// contact card, so the two cannot drift on wording or threshold.
//
// Renders NOTHING at zero. "0 tasks" on every untouched record is noise, and
// the whole point is that a non-empty chip is worth noticing.
export function FollowUpChips({ tasks = 0, notes = 0 }) {
  if (!tasks && !notes) return null
  return (
    <span style={{ display: 'inline-flex', gap: 6, flex: 'none' }}>
      {tasks > 0 && (
        <span
          className="pp-followup pp-followup-task"
          title={`${tasks} open task${tasks === 1 ? '' : 's'}`}
        >
          <span className="ms" style={{ fontSize: 13 }}>task_alt</span>
          {tasks}
        </span>
      )}
      {notes > 0 && (
        <span
          className="pp-followup"
          title={`${notes} note${notes === 1 ? '' : 's'}`}
        >
          <span className="ms" style={{ fontSize: 13 }}>sticky_note_2</span>
          {notes}
        </span>
      )}
    </span>
  )
}

