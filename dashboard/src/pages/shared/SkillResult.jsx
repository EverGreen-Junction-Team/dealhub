import React, { useEffect, useMemo, useState } from 'react'
import { Truncate } from './ListChrome'

// A skill's rows, charted — compact under the answer, expandable to full screen.
//
// A skill points at a view whose shape we do not know ahead of time, so this
// infers one: the first text column labels each row, the largest numeric
// column is the bar, and any other numeric columns break that bar into
// segments. That covers the common shape — a label and some counts — without
// anyone configuring a chart per skill.
//
// WHY BARS SCALE TO THE LARGEST ROW, not the column total. A stage with 3 of
// 150 deals is 2% of the total: as a fraction of the total it is an invisible
// sliver, and the chart says nothing about it. Against the biggest row it is a
// short bar you can still see and compare. The percentage of the total is
// printed as a number, where 2% is perfectly legible.
//
// Columns whose name ends `_id`, and any column that is the same on every row
// (a view's per-account totals, repeated by a window function), are dropped:
// neither says anything a chart can show.

const isNum = (v) => v !== null && v !== '' && !Number.isNaN(Number(v))

// A Date, or a string Postgres returned for a date/timestamp column. Number()
// rejects these, so isNum already excludes most — but node-postgres hands back
// real Date objects for DATE columns, and Number(new Date()) is a valid epoch
// integer. Without this a list view charted "created" as a bar of milliseconds
// since 1970: every bar full width, every difference invisible.
const isDateLike = (v) =>
  v instanceof Date ||
  (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}([T ]|$)/.test(v))

// A readable heading from a column name: pct_of_closed -> "Pct of closed".
const humanise = (c) =>
  String(c).replace(/_/g, ' ').replace(/^./, (m) => m.toUpperCase())

// A row label. A date renders as "Aug 2026" for a month bucket or "12 Aug" for
// a day — a raw "2026-08-01T00:00:00.000Z" down the side of a chart is
// unreadable and pushes every bar off the right of the card.
const labelOf = (v) => {
  // trim() too: a whitespace-only value is not null, so it slipped through and
  // rendered a bar with no label at all — which reads as a broken chart rather
  // than as missing data.
  if (v === null || v === undefined || String(v).trim() === '') return '—'
  if (isDateLike(v)) {
    const d = v instanceof Date ? v : new Date(v)
    if (!Number.isNaN(d.getTime())) {
      // LOCAL getters, not UTC. node-postgres turns a Postgres DATE into local
      // midnight, so getUTCDate() is the day BEFORE in any zone behind UTC —
      // at UTC+5:30 every month label read "Jun 30" instead of "Jul 2026",
      // which is both wrong and reads as a daily bucket.
      //
      // A plain date string (2026-07-01, no time) is parsed as UTC midnight by
      // the Date constructor, so that one is read with UTC getters instead.
      // The two cases have to be told apart or one of them is always off by a
      // day.
      const dateOnly = typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)
      const day = dateOnly ? d.getUTCDate() : d.getDate()
      const opts = dateOnly ? { timeZone: 'UTC' } : {}
      // First of the month = a month bucket; anything else is a real day.
      return day === 1
        ? d.toLocaleDateString(undefined, { month: 'short', year: 'numeric', ...opts })
        : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', ...opts })
    }
  }
  // Postgres NUMERIC arrives as a string carrying its full scale —
  // "5161632.0900000000000000" is 24 characters of mostly zeroes. Rendered
  // raw it is unreadable AND it is the widest cell in the table, so it sets
  // the table's width and pushes the card sideways.
  //
  // Thousands separators and at most two decimals, trailing zeroes dropped so
  // whole numbers stay whole. Integers are left alone — an id or a year must
  // not pick up a comma.
  // Only reformat values that ARRIVED with a decimal point. A bare integer is
  // left exactly as it is: ids, years and counts must not pick up a comma, and
  // "2026" becoming "2,026" is worse than the problem being solved.
  if (typeof v !== 'boolean' && isNum(v) && /\./.test(String(v))) {
    const n = Number(v)
    // A small fraction keeps enough precision to stay non-zero — days_to_move
    // of 0.001 must not render as "0", which reads as "instantly".
    const digits = n !== 0 && Math.abs(n) < 1 ? 4 : 2
    return n.toLocaleString(undefined, { maximumFractionDigits: digits })
  }
  return String(v)
}

const SEGMENT_COLOURS = [
  'var(--accent-plum-text)',
  'var(--accent-clay)',
  'var(--accent-teal-text)',
  'var(--accent-gold)'
]

// Every k-sized subset, in column order. Column counts here are small (a view
// has a handful of numeric columns), and the search is capped at 4, so this
// never explores more than a few dozen candidates.
function combinations(arr, k) {
  if (k === 0) return [[]]
  if (arr.length < k) return []
  const [head, ...rest] = arr
  return [
    ...combinations(rest, k - 1).map((c) => [head, ...c]),
    ...combinations(rest, k)
  ]
}

function shapeOf(rows) {
  if (!rows?.length) return null
  const cols = Object.keys(rows[0])

  // Constant across every row = a total repeated by a window function. Real
  // information, but not something a bar chart can express.
  const varying = cols.filter((c) => new Set(rows.map((r) => String(r[c]))).size > 1)
  // ONE constant text column is kept as a label candidate.
  //
  // "Constant means a repeated total" holds for numbers, not for the column
  // the rows are ABOUT. A themes view filtered to one theme has every row
  // saying "Price too high" — dropping it left buyer_type as the label and
  // drew five bars all reading "homeowner", which tells a reader nothing
  // about what they are comparing. The theme is the subject even when it
  // does not vary; the varying column is the breakdown.
  const constantText = cols.find((c) => (
    !varying.includes(c)
    && !/_id$/.test(c)
    && rows.every((r) => r[c] === null || typeof r[c] === 'string')
    && rows.some((r) => String(r[c] ?? '').trim())
  ))
  const usable = [
    ...varying.filter((c) => !/_id$/.test(c)),
    ...(constantText ? [constantText] : [])
  ]

  // Dates are excluded from `numeric` before anything else: they pass Number()
  // as an epoch and would otherwise win the "biggest total" contest outright.
  const dates = usable.filter((c) => rows.some((r) => isDateLike(r[c])))
  const numeric = usable.filter(
    (c) => !dates.includes(c) && rows.every((r) => r[c] === null || isNum(r[c]))
  )
  const plainText = usable.filter((c) => !numeric.includes(c) && !dates.includes(c))

  // A VIEW CARRYING PROSE IS A LIST, NOT A CHART.
  //
  // vw_requirement_quotes returns what a customer actually said, one row per
  // quote. Its only numeric column is the DEAL's value — a property of the
  // deal, not of the quote — so charting it drew bars comparing deal sizes
  // under an answer about what customers asked for. Nothing on that chart
  // answered the question, and the quotes themselves were not on it at all.
  //
  // The tell is a column of free text: short labels are categories you can
  // group by, sentences are content you have to read. Falling through to the
  // table shows the quotes, which is the entire point of the view.
  const isProse = (c) => {
    const vals = rows.map((r) => String(r[c] ?? '').trim()).filter(Boolean)
    if (vals.length < Math.max(2, rows.length * 0.5)) return false
    const long = vals.filter((v) => v.length > 60 || /\s\S+\s\S+\s\S+\s/.test(v))
    return long.length >= vals.length * 0.6
  }
  if (plainText.some(isProse)) return null

  // A date is not a MEASURE, but it is a perfectly good LABEL — and on a
  // month-by-month view it is the only one. Excluding dates from both roles
  // (the first fix for bars of epoch milliseconds) left every time series
  // unchartable, which is backwards: a trend is the shape that most wants a
  // chart. So dates are barred from the bar and allowed as the label.
  //
  // Preferred over a text column when present, because on a view that has
  // both, the date is what the rows are really organised by.
  // WHICH TEXT COLUMN LABELS THE BARS.
  //
  // Position is the wrong answer. plainText follows column order, so a view
  // returning (objection_theme, buyer_type) labelled its bars "homeowner"
  // five times over — the breakdown, not the subject.
  //
  // A name or a theme is what the rows are ABOUT; a type or a status is how
  // they are split. Prefer the former, fall back to position when neither
  // pattern matches so an unfamiliar view still charts.
  const SUBJECT = /(name|theme|label|title|reason|stage|period|month|question)/i
  const BREAKDOWN = /(type|status|owner|source|channel|band|bucket)/i
  const ranked = [...plainText].sort((a, b) => {
    const score = (c) => (SUBJECT.test(c) ? 0 : BREAKDOWN.test(c) ? 2 : 1)
    return score(a) - score(b) || plainText.indexOf(a) - plainText.indexOf(b)
  })
  // A DATE ONLY LABELS THE ROWS WHEN IT IS WHAT THEY ARE GROUPED BY.
  //
  // Preferring the date unconditionally was right for {month, won_deals} and
  // wrong for everything that merely carries a timestamp. vw_requirement_quotes
  // returns 87 individual quotes with deal_name, requirement_theme and
  // quoted_at — and it charted quoted_at, so four different customers quoted on
  // the same day drew four bars all labelled "15 Sept" with different numbers.
  // A reader cannot tell what separates them, which is worse than no chart.
  //
  // The tell is whether the date identifies a row. On a grouped view there is
  // one row per month and the dates are distinct; on a list view the same day
  // repeats. So the date leads only when it is (near) unique AND no subject
  // column is on offer — a name or theme beats a timestamp whenever both
  // exist, because that is what the rows are about.
  const datesDistinct = dates.length
    && new Set(rows.map((r) => String(r[dates[0]]))).size >= rows.length * 0.9
  const hasSubject = ranked.some((c) => SUBJECT.test(c))
  const text = dates.length && datesDistinct && !hasSubject
    ? [dates[0], ...ranked]
    : [...ranked, ...dates]
  if (!text.length || !numeric.length) return null

  // The bar is a COUNT, never a percentage.
  //
  // Picking the numeric column with the biggest total looked right until real
  // data: three stages of 48/20/16 deals sum to 84, while their
  // pct_lost_in_stage of 27/70/100 sums to 197 — so the percentage won and the
  // chart drew "share of this stage that was lost" as if it were volume. A
  // percentage is a ratio; bars of ratios beside each other do not compare.
  // A probability is a ratio 0-100 — a percentage that is not called one.
  // Bars of ratios side by side do not compare, which is why percentages are
  // excluded, and the same argument applies here: on the per-deal forecast
  // list `probability` beat `value` on raw total and charted the odds instead
  // of the money.
  const isPct = (c) => /^pct|_pct$|percent|_rate$|probability|_odds$/i.test(c)
  // Money is excluded from the bar for the same reason a percentage is: a
  // value column and a count column are different units, and value totals are
  // thousands of times larger, so value always wins the "biggest total"
  // contest and the chart silently becomes a revenue chart. Value is still
  // printed beside the bar as an extra.
  const isMoney = (c) => /value|revenue|amount|cost|spend/i.test(c)
  // An average or a median is a summary of a distribution, not a quantity of
  // anything. Bars of medians next to each other invite "this bar is twice
  // that one" readings that do not hold, and on the won-by-month view
  // median_days_to_win beat won_deals on raw total and became the chart —
  // drawing "how long deals took" where the question was "how many we won".
  const isStat = (c) => /^(median|avg|average|mean|p\d+)_|_(median|avg|average|mean)$|^median|^avg_/i.test(c)
  // A RUNNING TOTAL can only go up, so bars of it slope upward no matter what
  // happened. On the forecast growth view, won_cumulative beat won_value on
  // raw total and became the chart — drawing a rising line across three months
  // in which revenue fell 210k -> 165k -> 150k. The one shape that can state
  // the opposite of the truth and look deliberate doing it.
  const isCumulative = (c) => /cumulative|running|_to_date$|^total_[a-z]+_so_far/i.test(c)
  // A CHANGE column is signed and often negative; a bar chart has no sensible
  // way to draw -72000 beside 96000, and scaling to the largest row makes a
  // single big swing flatten everything else.
  const isDelta = (c) => /_change$|_change_pct$|^delta_|_diff$/i.test(c)
  const counts = numeric.filter(
    (c) => !isPct(c) && !isMoney(c) && !isStat(c) && !isCumulative(c) && !isDelta(c)
  )
  const totalOf = (c) => rows.reduce((n, r) => n + (Number(r[c]) || 0), 0)

  // A column whose name says it is the whole beats one that is a part of it.
  // Real case: the drop-off view returns closed_without_win (10 per stage) and
  // lost (10 per stage) — identical totals, so a plain sort picked whichever
  // came first and charted "lost" as if it were all deaths, hiding the
  // abandoned ones entirely. Totals are the honest default measure.
  const TOTALISH = /^(deals|total|count|leads|enquiries|closed|open_deals|won|notes)/i
  // The fallback must keep the two HARD exclusions. Money and stats are
  // merely poor bar choices and are fine when nothing else exists — a view of
  // only money columns should still chart. A cumulative or a signed change is
  // different: one always rises, the other goes negative, and neither can be
  // drawn as a bar without misleading. On the forecast growth view both real
  // measures were money, so counts was empty, the fallback took the whole
  // numeric list, and won_cumulative won on raw total — the exact bug the
  // exclusion above was added to prevent.
  const safeFallback = numeric.filter((c) => !isCumulative(c) && !isDelta(c))
  const pool = counts.length ? counts : (safeFallback.length ? safeFallback : numeric)
  const measure = [...pool].sort((a, b) => {
    const d = totalOf(b) - totalOf(a)
    if (d !== 0) return d
    // Tie: prefer the name that reads as a whole, then the longer name, which
    // is almost always the more specific one (closed_without_win over lost).
    const at = TOTALISH.test(a) ? 1 : 0
    const bt = TOTALISH.test(b) ? 1 : 0
    return bt - at || b.length - a.length
  })[0]

  // Segments must sum to the measure to be worth stacking — lost + abandoned
  // = closed_without_win, but a percentage column does not, and stacking it
  // would draw a bar that means nothing.
  // Any SUBSET of the other counts that sums to the measure, not all of them.
  // The old test required every remaining count to add up, so a view carrying
  // lost + abandoned (which do sum) alongside total_lost (which does not)
  // failed the check and drew a flat bar, losing the split that was the whole
  // point of the chart.
  const others = counts.filter((c) => c !== measure)
  const sumsTo = (cand) => cand.length >= 2 && rows.every(
    (r) => Math.abs(cand.reduce((n, c) => n + (Number(r[c]) || 0), 0) - (Number(r[measure]) || 0)) < 0.5
  )
  // Longest workable subset first: a 3-way split says more than a 2-way one.
  // Capped at 4 segments — beyond that the bars are too thin to read and the
  // legend is longer than the chart.
  let parts = []
  for (let size = Math.min(4, others.length); size >= 2 && !parts.length; size -= 1) {
    for (const cand of combinations(others, size)) {
      if (sumsTo(cand)) { parts = cand; break }
    }
  }
  const sums = parts.length >= 2

  return {
    label: text[0],
    measure,
    segments: sums ? parts : [],
    // Everything else worth printing beside the bar, percentages last since
    // they qualify the count rather than standing alone.
    extras: [...numeric.filter((c) => c !== measure && !isPct(c)),
             ...numeric.filter((c) => c !== measure && isPct(c))]
  }
}

export default function SkillResult({ result }) {
  const [open, setOpen] = useState(false)
  // Memoised: `result?.rows || []` builds a NEW empty array on every render,
  // so shapeOf would re-run each time — and it walks every row of every
  // column to work out the shape.
  const rows = useMemo(() => result?.rows || [], [result])
  const shape = useMemo(() => shapeOf(rows), [rows])

  useEffect(() => {
    if (!open) return
    const onKey = (e) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open])

  if (!rows.length) return null

  // No label + measure pair means this view is not chartable — a table is the
  // honest fallback rather than an invented chart.
  const body = shape
    ? <Chart rows={rows} shape={shape} expanded={open} />
    : <Rows rows={rows} expanded={open} />

  return (
    <>
      <section style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-md)',
        background: '#fff',
        overflow: 'hidden'
      }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '9px 13px',
          borderBottom: '1px solid var(--border-default)',
          background: 'var(--gray-50)'
        }}>
          <span className="ms" style={{ fontSize: 16, color: 'var(--accent-plum-text)' }}>
            insights
          </span>
          {/* Truncates rather than pushing the row count and expand button
              off the card — a long skill name is the common case, not the
              edge one. */}
          <Truncate style={{ fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-heading)' }}>
            {humanise(result.name)}
          </Truncate>
          <span style={{
            fontSize: 'var(--text-sm)', color: 'var(--text-muted)', flex: 'none'
          }}>
            {rows.length} row{rows.length === 1 ? '' : 's'}
          </span>
          <span style={{ flex: 1 }} />
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Expand"
            style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              border: 'none', background: 'none', cursor: 'pointer',
              padding: 0, color: 'var(--text-muted)',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)'
            }}
          >
            <span className="ms" style={{ fontSize: 16 }}>open_in_full</span>
            Expand
          </button>
        </header>
        <div style={{ padding: '11px 13px' }}>{body}</div>
      </section>

      {open && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label={`${humanise(result.name)} — full view`}
          onClick={(e) => { if (e.target === e.currentTarget) setOpen(false) }}
          style={{
            position: 'fixed', inset: 0, zIndex: 900,
            background: 'rgba(17, 22, 20, 0.45)',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            padding: 'var(--space-4)'
          }}
        >
          <div style={{
            width: 'min(1100px, 100%)', maxHeight: '90vh',
            display: 'flex', flexDirection: 'column',
            background: '#fff', borderRadius: 'var(--radius-md)',
            boxShadow: '0 20px 60px rgba(0,0,0,0.25)', overflow: 'hidden'
          }}>
            <header style={{
              display: 'flex', alignItems: 'center', gap: 10,
              padding: '13px 18px', borderBottom: '1px solid var(--border-default)'
            }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <h2 style={{
                  margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600,
                  color: 'var(--text-heading)'
                }}>
                  {humanise(result.name)}
                </h2>
                <p style={{
                  margin: '2px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-muted)'
                }}>
                  {rows.length} row{rows.length === 1 ? '' : 's'}
                  {result.source ? ` · ${result.source}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(false)}
                aria-label="Close"
                style={{
                  border: 'none', background: 'none', cursor: 'pointer',
                  padding: 4, color: 'var(--text-muted)', lineHeight: 1
                }}
              >
                <span className="ms" style={{ fontSize: 22 }}>close</span>
              </button>
            </header>
            <div style={{ padding: 18, overflowY: 'auto' }}>{body}</div>
          </div>
        </div>
      )}
    </>
  )
}

function Chart({ rows, shape, expanded }) {
  const { label, measure, segments, extras } = shape
  // Scaled to the biggest row, not the column total — see the header note.
  const max = Math.max(...rows.map((r) => Number(r[measure]) || 0), 1)
  // Collapsed, show enough to see the shape of the distribution without
  // taking over the answer. Expanded, show everything.
  const shown = expanded ? rows : rows.slice(0, 8)

  return (
    <div style={{ display: 'grid', gap: expanded ? 13 : 9 }}>
      {segments.length > 0 && (
        <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
          {segments.map((c, i) => (
            <span key={c} style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 'var(--text-sm)', color: 'var(--text-muted)'
            }}>
              <span style={{
                width: 9, height: 9, borderRadius: 2,
                background: SEGMENT_COLOURS[i % SEGMENT_COLOURS.length]
              }} />
              {humanise(c)}
            </span>
          ))}
        </div>
      )}

      {shown.map((r, i) => {
        const value = Number(r[measure]) || 0
        return (
          <div key={i} style={{ display: 'grid', gap: 4 }}>
            {/* WRAPS. A view like vw_lead_map_area_route has ten numeric
                columns, every one of which lands here as an `extras` span —
                on one unwrapped line that runs metres past the card and off
                the screen, taking the warning banner and the table with it
                because the overflow widens the whole conversation column.

                flexWrap lets the extras fall onto a second line instead;
                minWidth:0 on the row lets it shrink below its content width
                in the first place, which a flex item will not do by default.
                The label already truncates, so the only unbounded thing left
                was the extras run. */}
            <div style={{
              display: 'flex', alignItems: 'baseline', gap: 8,
              flexWrap: 'wrap', minWidth: 0,
              fontSize: expanded ? 'var(--text-base)' : 'var(--text-sm)'
            }}>
              <Truncate style={{ flex: '1 1 40%', color: 'var(--text-heading)' }}>
                {labelOf(r[label])}
              </Truncate>
              <span style={{
                color: 'var(--text-body)', fontWeight: 600,
                fontVariantNumeric: 'tabular-nums'
              }}>
                {value}
              </span>
              {extras.map((c) => (
                r[c] === null || r[c] === undefined ? null : (
                  <span key={c} style={{
                    color: 'var(--text-faint)', fontSize: 'var(--text-sm)',
                    fontVariantNumeric: 'tabular-nums'
                  }}>
                    {/^pct|_pct$|percent/i.test(c) ? `${r[c]}%` : `${humanise(c)} ${r[c]}`}
                  </span>
                )
              ))}
            </div>
            <div style={{
              display: 'flex', height: expanded ? 10 : 7,
              borderRadius: 999, overflow: 'hidden', background: 'var(--gray-100)'
            }}>
              {segments.length > 0
                ? segments.map((c, si) => {
                    const part = Number(r[c]) || 0
                    if (!part) return null
                    return (
                      <span
                        key={c}
                        title={`${humanise(c)}: ${part}`}
                        style={{
                          width: `${(part / max) * 100}%`,
                          background: SEGMENT_COLOURS[si % SEGMENT_COLOURS.length]
                        }}
                      />
                    )
                  })
                : (
                  <span style={{
                    width: `${(value / max) * 100}%`,
                    background: 'var(--accent-plum-text)'
                  }} />
                )}
            </div>
          </div>
        )
      })}

      {!expanded && rows.length > shown.length && (
        <p style={{ margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
          {rows.length - shown.length} more — expand to see all
        </p>
      )}
    </div>
  )
}

// Fallback when the rows have no label + number pair to chart. A table is
// honest about what the data is; an invented chart is not.
function Rows({ rows, expanded }) {
  const cols = Object.keys(rows[0])
  const shown = expanded ? rows : rows.slice(0, 6)
  // The scroller needs minWidth:0 or it inherits the table's content width
  // from its parent grid and never actually scrolls — the overflow just
  // moves up the tree and widens the card instead. A 13-column view like
  // lead_to_won_deal_ratio is wider than 760px no matter what, so the table
  // keeps its natural width and scrolls sideways WITHIN the card rather
  // than dragging the page with it.
  return (
    <div style={{ overflowX: 'auto', minWidth: 0, maxWidth: '100%' }}>
      <table style={{
        width: 'max-content', minWidth: '100%',
        borderCollapse: 'collapse', fontSize: 'var(--text-sm)'
      }}>
        <thead>
          <tr>
            {cols.map((c) => (
              <th key={c} style={{
                textAlign: 'left', padding: '4px 10px 6px 0',
                borderBottom: '1px solid var(--border-default)',
                fontSize: 'var(--text-xs)', letterSpacing: 'var(--tracking-label)',
                textTransform: 'uppercase', color: 'var(--text-muted)', whiteSpace: 'nowrap'
              }}>
                {humanise(c)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((r, i) => (
            <tr key={i}>
              {cols.map((c) => (
                <td key={c} style={{
                  padding: '6px 10px 6px 0',
                  borderBottom: '1px solid var(--border-default)',
                  color: 'var(--text-body)', whiteSpace: 'nowrap'
                }}>
                  {labelOf(r[c])}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!expanded && rows.length > shown.length && (
        <p style={{ margin: '7px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
          {rows.length - shown.length} more — expand to see all
        </p>
      )}
    </div>
  )
}
