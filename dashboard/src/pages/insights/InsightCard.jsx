import React from 'react'
import ChartBlock from './ChartBlock'

// One insight card.
//
// THE COPY IS THE DESIGN'S, VERBATIM. Title, question, caveat, how-to-read
// and the Learns / Does footer are carried over from the signed-off handoff
// without rewording. The chrome around them is this app's — tokens, card
// border, type scale — so the tab sits with the other eight rather than
// looking pasted in.
//
// A card is mostly WORDS. The chart is one block among several, and the
// question above it and the "what this means" below it are what make a bar
// chart actionable — which is why they are not trimmed to fit.
export default function InsightCard({ card }) {
  return (
    <article style={{
      border: '1px solid var(--border-default)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--surface-card, #fff)',
      boxShadow: 'var(--shadow-card)',
      overflow: 'hidden',
      display: 'flex', flexDirection: 'column',
      minWidth: 0
    }}>
      <header style={{
        padding: '13px var(--space-4) 11px',
        borderBottom: '1px solid var(--border-default)'
      }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
          <h3 style={{
            margin: 0, fontSize: 'var(--text-lg)', fontWeight: 600,
            color: 'var(--text-heading)', lineHeight: 1.3
          }}>
            {card.title}
          </h3>
          <span style={{ flex: 1 }} />
          {/* The tracker's own reference, kept so a figure on screen can be
              traced back to the row it came from. */}
          <code style={{
            fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)',
            color: 'var(--text-faint)'
          }}>
            {card.card_id}
          </code>
        </div>

        {card.question && (
          <p style={{
            margin: '5px 0 0', fontSize: 'var(--text-md)', color: 'var(--text-muted)',
            lineHeight: 'var(--leading-normal)'
          }}>
            {card.question}
          </p>
        )}
      </header>

      <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-4)', flex: 1 }}>
        {card.caveat && (
          // Gold, not rose: a caveat qualifies a number, it does not say the
          // number is wrong. The app uses rose for failure.
          <p style={{
            margin: 0, padding: '8px 11px',
            background: 'var(--tint-gold)', color: 'var(--accent-gold-text)',
            borderRadius: 'var(--radius-sm)',
            fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-normal)'
          }}>
            {card.caveat}
          </p>
        )}

        {card.blocks?.map((b, i) => {
          if (b.kind === 'chart') return <ChartBlock key={i} block={b} />
          if (b.kind === 'ghost') {
            // DELIBERATELY EMPTY. The design draws a block the tracker has no
            // query for — 8.3's Part B is the known case. Inventing a chart
            // here would be the one thing the handoff asks us not to do, so
            // the frame says what is missing instead.
            return (
              <div key={i} style={{
                padding: 'var(--space-4)',
                border: '1px dashed var(--border-strong)',
                borderRadius: 'var(--radius-sm)',
                background: 'var(--gray-50)',
                textAlign: 'center'
              }}>
                {b.subtitle && (
                  <p style={{
                    margin: 0, fontSize: 'var(--text-sm)', fontWeight: 600,
                    letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
                    color: 'var(--text-muted)'
                  }}>
                    {b.subtitle}
                  </p>
                )}
                <p style={{ margin: '6px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
                  {b.label || 'No query recorded for this part yet.'}
                </p>
              </div>
            )
          }
          return null
        })}

        {card.how_to_read && (
          <p style={{
            margin: 0, fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
            lineHeight: 'var(--leading-normal)'
          }}>
            {card.how_to_read}
          </p>
        )}
      </div>

      {(card.footer?.learns || card.footer?.does) && (
        <footer style={{
          borderTop: '1px solid var(--border-default)',
          background: 'var(--gray-25)',
          padding: '11px var(--space-4)',
          display: 'grid', gap: 7
        }}>
          {card.footer.learns && <FooterLine label="Learns" text={card.footer.learns} />}
          {card.footer.does && <FooterLine label="Does" text={card.footer.does} />}
        </footer>
      )}
    </article>
  )
}

function FooterLine({ label, text }) {
  return (
    <p style={{ margin: 0, fontSize: 'var(--text-sm)', lineHeight: 'var(--leading-normal)' }}>
      <span style={{
        fontWeight: 600, letterSpacing: 'var(--tracking-label)',
        textTransform: 'uppercase', color: 'var(--accent-plum-text)',
        marginRight: 7
      }}>
        {label}
      </span>
      <span style={{ color: 'var(--text-body)' }}>{text}</span>
    </p>
  )
}
