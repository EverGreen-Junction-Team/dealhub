import React from 'react'

// Loading skeletons for the Deal Hub.
//
// Switching deals replaces every panel at once. Without a placeholder the
// stale deal stays on screen and then snaps to the new one, which reads as a
// glitch — you can't tell whether you're looking at the deal you just picked
// or the one before it. These render the *shape* of each panel so the layout
// holds still and it's obvious the content is arriving.
//
// Deliberately not a spinner: a spinner says "something is happening
// somewhere", a skeleton says "this panel, this shape, nearly there".

// Shimmer + Bar come from the shared list kit so the animation is defined
// once for the whole app.
export { SkeletonStyles, Bar } from '../shared/ListChrome'
import { SkeletonStyles, Bar } from '../shared/ListChrome'

export function Pill({ w = 90, h = 30 }) {
  return <Bar w={w} h={h} r="var(--radius-pill)" />
}

// Filter bar: two rows of chips on the left, section tabs on the right.
export function FilterBarSkeleton() {
  return (
    <div
      style={{
        padding: '14px 20px 0',
        maxWidth: 1660, margin: '0 auto', boxSizing: 'border-box'
      }}
    >
      {/* Same grid as the real filter bar and the content row below it, so
          the skeleton doesn't flash a different layout. */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)',
          gap: 14,
          alignItems: 'start'
        }}
      >
        <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--space-2)', minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', alignItems: 'center' }}>
            <Bar w={44} h={10} />
            <Pill w={96} />
            <Pill w={78} />
            <Pill w={78} />
          </div>
          <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap' }}>
            <Pill w={64} />
            <Pill w={112} />
            <Pill w={112} />
            <Pill w={82} />
            <Pill w={70} />
            <Pill w={124} />
          </div>
        </div>
        <div style={{ display: 'flex', gap: 'var(--space-2)', flexWrap: 'wrap', minWidth: 0 }}>
          {[132, 116, 124, 104, 96, 88].map((w, i) => (
            <Pill key={i} w={w} />
          ))}
        </div>
      </div>
    </div>
  )
}

// Accent-bordered panel shell, matching PeopleSection / DealSection framing
// so the skeleton occupies the same box the real content will.
function PanelShell({ accent, children, titleW = 90 }) {
  return (
    <section
      style={{
        border: '1px solid var(--border-default)',
        boxShadow: 'var(--shadow-card)',
        ['--panel-accent']: `var(--accent-${accent}-text)`,
        ['--panel-tint']: `var(--tint-${accent})`,
        borderRadius: 'var(--radius-md)',
        background: '#fff', overflow: 'hidden'
      }}
    >
      {/* The SOLID band, matching the loaded panel. A pale skeleton header
          that turns coloured the moment data arrives reads as the layout
          changing under the reader, not as the same panel filling in. */}
      <header
        style={{
          display: 'flex', alignItems: 'center', gap: 9,
          padding: '13px var(--space-4)',
          borderBottom: `1px solid var(--panel-head-${accent}-border, var(--border-default))`,
          background: `var(--panel-head-${accent}, var(--accent-${accent}))`
        }}
      >
        {/* Translucent white, so the placeholder bars read ON the band rather
            than as grey holes cut out of it. */}
        <Bar w={20} h={20} style={{ background: 'rgba(255,255,255,0.35)' }} />
        <Bar w={titleW} h={14} style={{ background: 'rgba(255,255,255,0.35)' }} />
      </header>
      {children}
    </section>
  )
}

// People / Deal left-rail section.
export function SectionSkeleton({ accent = 'sky', columns = 3 }) {
  return (
    <PanelShell accent={accent}>
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: `repeat(${columns}, minmax(0, 1fr))`
        }}
      >
        {Array.from({ length: columns }).map((_, i) => (
          <div
            key={i}
            style={{
              padding: '14px var(--space-4)',
              borderRight: i < columns - 1 ? '1px solid var(--border-default)' : 'none',
              display: 'grid', gap: 9
            }}
          >
            <Bar w="45%" h={9} />
            <Bar w="80%" h={16} />
            <Bar w="60%" h={11} />
            <Bar w="70%" h={11} />
          </div>
        ))}
      </div>
    </PanelShell>
  )
}

// Timeline: message rows with the channel gutter square + card.
export function TimelineSkeleton({ rows = 4 }) {
  return (
    <PanelShell accent="teal" titleW={104}>
      <div style={{ padding: 'var(--space-3) 14px' }}>
        {Array.from({ length: rows }).map((_, i) => (
          <div
            key={i}
            style={{
              display: 'grid', gridTemplateColumns: '40px 1fr',
              gap: 'var(--space-1)', marginBottom: 10
            }}
          >
            <div style={{ display: 'grid', gap: 5, justifyItems: 'center', paddingTop: 11 }}>
              <Bar w={28} h={28} />
              <Bar w={26} h={9} />
            </div>
            <div
              style={{
                border: '1px solid var(--border-default)',
                borderRadius: 'var(--radius-md)',
                overflow: 'hidden'
              }}
            >
              <div style={{ padding: 'var(--space-3) 14px', display: 'grid', gap: 'var(--space-2)' }}>
                <div style={{ display: 'flex', gap: 'var(--space-2)', alignItems: 'center' }}>
                  <Bar w={8} h={8} r="50%" />
                  <Bar w={104} h={12} />
                  <Bar w={54} h={10} />
                </div>
                {/* Varying line widths so it reads as prose, not a table. */}
                <Bar w={i % 2 ? '72%' : '92%'} h={11} />
                <Bar w={i % 2 ? '48%' : '64%'} h={11} />
              </div>
              <div
                style={{
                  display: 'flex', alignItems: 'center',
                  padding: '6px var(--space-3)',
                  borderTop: '1px solid var(--border-default)',
                  background: 'var(--gray-25)'
                }}
              >
                <Bar w={40} h={9} />
                <span style={{ marginLeft: 'auto' }}>
                  <Pill w={116} h={22} />
                </span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </PanelShell>
  )
}

// Right-hand commitments rail.
export function RailSkeleton({ rows = 3 }) {
  return (
    <PanelShell accent="clay" titleW={112}>
      <div style={{ padding: 'var(--space-3) var(--space-4)', display: 'grid', gap: 14 }}>
        <Bar w="52%" h={9} />
        {Array.from({ length: rows }).map((_, i) => (
          <div key={i} style={{ display: 'flex', gap: 10, alignItems: 'flex-start' }}>
            <Bar w={16} h={16} />
            <div style={{ flex: 1, display: 'grid', gap: 6 }}>
              <Bar w={i % 2 ? '74%' : '88%'} h={12} />
              <Bar w="42%" h={10} />
            </div>
          </div>
        ))}
      </div>
    </PanelShell>
  )
}

// The whole deal body — everything that swaps when the selected deal changes.
export function DealBodySkeleton() {
  return (
    <>
      <SkeletonStyles />
      <div
        style={{
          padding: '14px 20px 0',
          maxWidth: 1660, margin: '0 auto', boxSizing: 'border-box'
        }}
      >
        <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
          <Pill w={92} h={32} />
          <Pill w={76} h={32} />
          <Pill w={84} h={32} />
        </div>
        <SectionSkeleton accent="sky" columns={3} />
      </div>

      <FilterBarSkeleton />

      <div
        style={{
          padding: '14px 20px var(--space-5)',
          maxWidth: 1660, margin: '0 auto', boxSizing: 'border-box'
        }}
      >
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'minmax(0, 2fr) minmax(320px, 1fr)',
            gap: 14, alignItems: 'start'
          }}
        >
          <TimelineSkeleton />
          <RailSkeleton />
        </div>
      </div>
    </>
  )
}

// First load, before the deal list exists — there's no header or switcher to
// frame yet, so this stands in for the whole tab.
export function DealHubSkeleton() {
  return (
    <div>
      <SkeletonStyles />
      <div style={{ padding: '14px 20px 0' }}>
        <div
          style={{
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--radius-md)',
            background: '#fff',
            padding: 14,
            maxWidth: 1660, margin: '0 auto', boxSizing: 'border-box',
            display: 'grid', gap: 'var(--space-3)'
          }}
        >
          <div style={{ display: 'flex', gap: 'var(--space-3)', alignItems: 'center' }}>
            <Bar w={320} h={38} r="var(--radius-md)" />
            <span style={{ marginLeft: 'auto' }}><Bar w={128} h={26} /></span>
          </div>
          {/* Matches StageStepper: 40px tall, full width, equal segments. As
              26px fixed-width pills this covered half the card, so the header
              collapsed and rebounded when the real stepper arrived. */}
          <div style={{ display: 'flex', gap: 2 }}>
            {[0, 1, 2, 3, 4].map((i) => (
              <span key={i} style={{ flex: 1, minWidth: 0 }}>
                <Bar w="100%" h={40} r="var(--radius-sm)" />
              </span>
            ))}
          </div>
        </div>
      </div>
      <DealBodySkeleton />
    </div>
  )
}
