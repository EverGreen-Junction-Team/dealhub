import React from 'react'
import { formatMoney } from '../../utils/money'

// PIPELINE VALUE — every stage's count, value and share of the pipeline, with
// the pipeline total on the right.
//
// Fed by the Deals tab from ?summary=stages — the same filtered set as the
// count beside the heading, so the two cannot disagree. Shown above every
// view: the board, the grid and the list. A stage not yet loaded
// shows a dash rather than £0, which would read as "worth nothing".
export default function PipelineStrip({ label, stages, stats }) {
  const rows = stages.map((st) => ({ id: st.id, name: st.name, ...stats[st.id] }))
  const loaded = rows.filter((r) => typeof r.count === 'number')
  const totalValue = loaded.reduce((n, r) => n + (r.value || 0), 0)
  const totalDeals = loaded.reduce((n, r) => n + r.count, 0)
  const withDeals = loaded.filter((r) => r.count > 0).length
  const currency = loaded.find((r) => r.currency)?.currency

  return (
    <section style={{
      display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) auto',
      background: 'var(--surface-card)',
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-lg)',
      overflow: 'hidden'
    }}>
      <div style={{ minWidth: 0 }}>
        <header style={{
          display: 'flex', alignItems: 'center', gap: 8,
          padding: '12px 16px',
          borderBottom: '1px solid var(--border-default)'
        }}>
          <span className="ms" style={{ fontSize: 18, color: 'var(--accent-pine-text)' }}>account_tree</span>
          <span className="pp-label" style={{ marginBottom: 0, color: 'var(--text-heading)' }}>Pipeline value</span>
          <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
            {label} · {totalDeals} {totalDeals === 1 ? 'deal' : 'deals'}
          </span>
        </header>

        {/* One cell per stage, in board order. Scrolls sideways on its own
            when there are more stages than fit, like the board below it. */}
        <div style={{ display: 'flex', overflowX: 'auto' }}>
          {rows.map((r, i) => {
            const ready = typeof r.count === 'number'
            const share = ready && totalValue > 0 ? Math.round((r.value / totalValue) * 100) : 0
            return (
              <div
                key={r.id}
                style={{
                  flex: '1 0 160px', minWidth: 160,
                  display: 'grid', gap: 8,
                  padding: '12px 16px',
                  borderLeft: i === 0 ? 'none' : '1px solid var(--border-default)'
                }}
              >
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  <span title={r.name} className="pp-label" style={{
                    marginBottom: 0, minWidth: 0,
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap'
                  }}>
                    {r.name}
                  </span>
                  <span style={{
                    flex: 'none', minWidth: 20, height: 20, padding: '0 6px',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    borderRadius: 'var(--radius-pill)', background: 'var(--gray-100)',
                    fontSize: 'var(--text-sm)', fontWeight: 600,
                    fontVariantNumeric: 'tabular-nums', color: 'var(--text-muted)'
                  }}>
                    {ready ? r.count : '–'}
                  </span>
                </div>
                <span style={{
                  fontFamily: 'var(--font-mono)',
                  fontSize: 'var(--text-lg)', fontWeight: 600,
                  fontVariantNumeric: 'tabular-nums',
                  color: ready && r.value > 0 ? 'var(--text-heading)' : 'var(--text-faint)'
                }}>
                  {ready ? formatMoney(r.value || 0, r.currency || currency) : '—'}
                </span>
                {/* Share of the pipeline's value, as a bar and a figure — the
                    bar for the scan across, the figure for the exact read. */}
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <span style={{
                    flex: 1, height: 4, borderRadius: 2,
                    background: 'var(--gray-100)', overflow: 'hidden'
                  }}>
                    <span style={{
                      display: 'block', height: '100%', width: `${share}%`,
                      background: 'var(--green-600)', borderRadius: 2
                    }} />
                  </span>
                  <span style={{
                    fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
                    fontVariantNumeric: 'tabular-nums', minWidth: 30, textAlign: 'right'
                  }}>
                    {share}%
                  </span>
                </div>
              </div>
            )
          })}
        </div>
      </div>

      <div style={{
        display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 6,
        minWidth: 200, padding: '16px 20px',
        background: 'var(--tint-pine)',
        borderLeft: '1px solid var(--border-default)'
      }}>
        <span className="pp-label" style={{ marginBottom: 0 }}>Total in pipeline</span>
        <span style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 28, fontWeight: 600, lineHeight: 1.1,
          fontVariantNumeric: 'tabular-nums', color: 'var(--text-heading)'
        }}>
          {formatMoney(totalValue, currency)}
        </span>
        <span style={{ fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
          {totalDeals} {totalDeals === 1 ? 'deal' : 'deals'} across {withDeals} {withDeals === 1 ? 'stage' : 'stages'}
        </span>
      </div>
    </section>
  )
}
