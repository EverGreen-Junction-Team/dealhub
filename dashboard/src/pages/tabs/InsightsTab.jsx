import React, { useMemo } from 'react'
import { Select } from 'antd'
import { Shell, Panel } from '../shared/ListChrome'
import { useTabState } from '../../hooks/useTabState'
import CARDS from '../insights/cards.json'
import InsightCard from '../insights/InsightCard'

// Insights — the 24 signed-off insight cards, for THIS sub-account.
//
// ── WHERE THE NUMBERS COME FROM ──────────────────────────────────────
//
// Each chart reads a pre-aggregated view (migration 135) through
// /api/insights/charts/:key. The route scopes every read to the session's own
// location, so switching sub-account switches the figures with no filter to
// set and no way to read another account's.
//
// The prototype this came from read Supabase from the browser with a
// service-role key and decoded a hardcoded brand inside each view. Neither
// survived the port: the key would be a standing grant over every table, and
// the brand decode meant a new sub-account silently returned nothing.
//
// ── WHAT IS NOT HERE ─────────────────────────────────────────────────
//
// The 22 insights the tracker marks Blocked or Not started. They have no
// query, so there is nothing to draw and a placeholder card for each would be
// 22 rows of furniture. Cards that are live but have one missing PART keep
// the design's empty frame — see InsightCard's ghost block.
//
// ── THE HEADER, SHARED WITH EVERY OTHER TAB ───────────────────────────
//
// This used to be its own bare <h1> sitting straight on the page background,
// with a paragraph under it and plain-text group headings below — the one
// tab that did not look like the other eight, each of which uses Panel: an
// icon, a coloured title, a count, inside a bordered card. Rebuilt on the
// same component so Insights reads as part of the app rather than a page
// pasted into it.
//
// The group names ("Pipeline Leakage", "Scaling & Rep Performance", …) were
// also plain headings with no way to narrow the page to one section. They
// are now the panel's own filter, as a multi-select — defaulting to every
// group, so the page shows everything until someone deliberately narrows it.
export default function InsightsTab() {
  const groupDefs = useMemo(() => {
    const by = new Map()
    for (const c of CARDS) {
      if (!by.has(c.group_number)) {
        by.set(c.group_number, { number: c.group_number, name: c.group_name })
      }
    }
    // Sorted by group number, not first appearance, so a card added later
    // lands in its own section rather than opening a duplicate.
    return [...by.values()].sort((a, b) => a.number - b.number)
  }, [])

  // Persisted per tab, like every other filter in the app — stepping out to
  // a deal and back keeps the same sections picked.
  //
  // NOTHING TICKED BY DEFAULT (client request, Oct 2026). It opened with
  // every section ticked, so a rep had to untick seven to see one. Now the
  // list starts empty and an empty pick means "every section"; ticking one
  // narrows the page to it.
  const [selectedGroups, setSelectedGroups] = useTabState('insights', 'groups', [])
  const picked = useMemo(() => (Array.isArray(selectedGroups) ? selectedGroups : []), [selectedGroups])
  const showAll = picked.length === 0

  const groups = useMemo(() => {
    const by = new Map()
    for (const c of CARDS) {
      if (!showAll && !picked.includes(c.group_number)) continue
      if (!by.has(c.group_number)) {
        by.set(c.group_number, { number: c.group_number, name: c.group_name, cards: [] })
      }
      by.get(c.group_number).cards.push(c)
    }
    return [...by.values()].sort((a, b) => a.number - b.number)
  }, [picked, showAll])

  const shownCount = groups.reduce((n, g) => n + g.cards.length, 0)

  return (
    <Shell>
      <Panel
        icon="insights"
        title="Insights"
        accent="plum"
        // The shared solid band, like every other tab (Oct 2026), with the
        // Section filter on the grey toolbar row below it, label stacked
        // above — the Deals and Businesses toolbar shape. It was a pale band
        // with the filter squeezed onto the title row.
        solidHeader
        count={shownCount === CARDS.length ? CARDS.length : `${shownCount} of ${CARDS.length}`}
        countTitle={`${CARDS.length} questions about this sub-account, each answered from its own query`}
        toolbarBackground="var(--gray-100)"
        toolbar={
          <span className="pp-filter-field" style={{ display: 'inline-flex', flexDirection: 'column', gap: 5 }}>
            <span className="pp-label" style={{ marginBottom: 0 }}>Section</span>
            <Select
              mode="multiple"
              value={picked}
              onChange={(v) => setSelectedGroups(v)}
              popupClassName="pp-menu"
              // A TEXT SUMMARY, not chips. Chips in a one-line box fell back
              // to a bare "+6" that named none of the picked sections.
              // maxTagCount 0 hides every chip and the placeholder function
              // says what is picked: its name for one, "N sections" for more.
              maxTagCount={0}
              maxTagPlaceholder={(omitted) => (
                omitted.length === 1
                  ? (groupDefs.find((g) => g.number === omitted[0].value)?.name || '1 section')
                  : `${omitted.length} sections`
              )}
              style={{ minWidth: 220, maxWidth: 480 }}
              styles={{ root: { height: 34 } }}
              popupMatchSelectWidth={320}
              options={groupDefs.map((g) => ({ value: g.number, label: g.name }))}
              // Nothing picked = every section shown.
              placeholder="All sections"
              allowClear
            />
          </span>
        }
      >
        <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-5)' }}>
          {groups.length === 0 ? (
            <p style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
              No insights to show yet.
            </p>
          ) : (
            groups.map((g) => (
              <section key={g.number} style={{ display: 'grid', gap: 'var(--space-3)', minWidth: 0 }}>
                <h3 style={{
                  margin: 0,
                  fontSize: 'var(--text-sm)', fontWeight: 600,
                  letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
                  color: 'var(--text-muted)'
                }}>
                  {g.name}
                </h3>
                {/* Two columns on a wide screen, one on a narrow. A 420px
                    floor rather than a fixed 1fr 1fr: these cards are mostly
                    prose, and two narrow columns of it read worse than one
                    wide one. */}
                <div style={{
                  display: 'grid', gap: 'var(--space-3)',
                  gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
                  alignItems: 'start'
                }}>
                  {g.cards.map((c) => <InsightCard key={c.card_id} card={c} />)}
                </div>
              </section>
            ))
          )}
        </div>
      </Panel>
    </Shell>
  )
}
