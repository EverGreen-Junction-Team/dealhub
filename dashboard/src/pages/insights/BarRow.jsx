import React from 'react'
import { Truncate } from '../shared/ListChrome'

// One bar. Segments are widths in PERCENT, already scaled by the adapter
// against whatever that chart measures against — this component does no
// arithmetic, so a chart's maths lives in exactly one place.
//
// `separate` splits the segments onto their own tracks. On 2.5, 6.2 and 8.5
// the series are percentages of DIFFERENT wholes (a rep can set a next action
// on 56% of deals and have messages on 77%), so stacking them in one bar runs
// past 100% and out of the card. The prototype hit this too; the fix is
// carried over rather than rediscovered.
export default function BarRow({ row }) {
  const tracks = row.separate
    ? row.segments.map((s) => [s])
    : [row.segments]

  return (
    <div style={{ display: 'grid', gap: 5 }}>
      <div style={{
        display: 'flex', alignItems: 'baseline', justifyContent: 'space-between',
        gap: 'var(--space-3)'
      }}>
        <Truncate style={{ fontSize: 'var(--text-md)', color: 'var(--text-heading)' }}>
          {row.label}
        </Truncate>
        {row.note && (
          <span style={{
            fontSize: 'var(--text-sm)', color: 'var(--text-faint)',
            flex: 'none', fontVariantNumeric: 'tabular-nums'
          }}>
            {row.note}
          </span>
        )}
      </div>

      {tracks.map((segs, t) => (
        <div
          key={t}
          style={{
            display: 'flex', height: row.separate ? 8 : 12,
            background: 'var(--gray-100)',
            borderRadius: 'var(--radius-pill)',
            overflow: 'hidden'
          }}
        >
          {segs.map((s, i) => (
            <span
              key={i}
              style={{
                width: `${Math.max(0, Math.min(100, s.widthPct))}%`,
                // A range chart (3.7) draws a leading spacer: it occupies
                // width so the bar starts in the right place, but must not
                // read as a value.
                background: s.transparent ? 'transparent' : s.color,
                borderLeft: s.borderLeft || undefined
              }}
            />
          ))}
        </div>
      ))}
    </div>
  )
}
