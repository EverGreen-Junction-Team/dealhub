import React from 'react'
import BarRow from './BarRow'
import { useChart } from './useChart'
import { CHARTS } from './charts'

// One chart inside a card: its subtitle, its legend, and the bars.
//
// Every state is drawn — loading, error, empty, ready. A chart that silently
// renders nothing is indistinguishable from one whose view returned no rows,
// and those need different responses: one is a bug, the other is an answer.
export default function ChartBlock({ block }) {
  const { ref, status, data, error } = useChart(block.key)

  // A chart the build cannot draw at all.
  //
  // Cards 3.6 and 9.4 name keys (c36, c94a, c94b) that have no adapter — not
  // here and not in the prototype this came from. They are marked live in the
  // tracker, so the copy shipped, but nothing was ever written to turn rows
  // into bars for them.
  //
  // Said plainly rather than shown as a failed fetch. "Could not read this
  // insight" would send someone looking at the database for a problem that is
  // not there; this is unfinished work, and the card should say so.
  if (!CHARTS[block.key]) {
    return (
      <div style={{
        padding: 'var(--space-4)',
        border: '1px dashed var(--border-strong)',
        borderRadius: 'var(--radius-sm)',
        background: 'var(--gray-50)',
        textAlign: 'center'
      }}>
        {block.subtitle && (
          <p style={{
            margin: 0, fontSize: 'var(--text-sm)', fontWeight: 600,
            letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
            color: 'var(--text-muted)'
          }}>
            {block.subtitle}
          </p>
        )}
        <p style={{ margin: '6px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
          This chart is not built yet.
        </p>
      </div>
    )
  }

  return (
    <div ref={ref} style={{ display: 'grid', gap: 'var(--space-2)' }}>
      {block.subtitle && (
        <p style={{
          margin: 0, fontSize: 'var(--text-sm)', fontWeight: 600,
          letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
          color: 'var(--text-muted)'
        }}>
          {block.subtitle}
        </p>
      )}

      {block.legends?.length > 0 && status === 'ready' && (
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-3)' }}>
          {block.legends.map((l, i) => (
            <span key={i} style={{
              display: 'inline-flex', alignItems: 'center', gap: 6,
              fontSize: 'var(--text-sm)', color: 'var(--text-muted)'
            }}>
              <span style={{
                width: 10, height: 10, borderRadius: 3, background: l.color, flex: 'none'
              }} />
              {l.label}
            </span>
          ))}
        </div>
      )}

      {(status === 'idle' || status === 'loading') && (
        // A fixed-height skeleton, so a card does not jump when its rows
        // arrive — 26 cards each resizing on load is a page that will not
        // sit still while you read it.
        <div style={{ display: 'grid', gap: 10, paddingTop: 4 }}>
          {Array.from({ length: block.rows_hint || 4 }).map((_, i) => (
            <div key={i} style={{ display: 'grid', gap: 5 }}>
              <div style={{ height: 11, width: `${45 + ((i * 13) % 30)}%`, background: 'var(--gray-100)', borderRadius: 4 }} />
              <div style={{ height: 12, background: 'var(--gray-100)', borderRadius: 'var(--radius-pill)' }} />
            </div>
          ))}
        </div>
      )}

      {status === 'error' && (
        <p style={{
          margin: 0, padding: '9px 11px',
          background: 'var(--tint-clay)', color: 'var(--accent-clay-text)',
          borderLeft: '3px solid var(--accent-clay)',
          borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
          fontSize: 'var(--text-sm)'
        }}>
          {error}
        </p>
      )}

      {status === 'ready' && data.rows.length === 0 && (
        // NOT an error. The query ran and this account has nothing matching —
        // which is itself the answer, and saying so beats an empty frame.
        <p style={{ margin: 0, fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
          Nothing to show for this account yet.
        </p>
      )}

      {status === 'ready' && data.rows.length > 0 && (
        <div style={{ display: 'grid', gap: 11 }}>
          {data.rows.map((r, i) => <BarRow key={i} row={r} />)}
        </div>
      )}

      {status === 'ready' && data.meta?.statuses && (
        <p style={{ margin: '2px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
          Counted on {data.meta.statuses}
          {data.meta.n != null && ` · ${Number(data.meta.n).toLocaleString()} deals`}
        </p>
      )}
    </div>
  )
}
