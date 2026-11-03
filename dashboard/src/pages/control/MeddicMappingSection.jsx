import React from 'react'
import SectionCard from './SectionCard'

// Qualification headings — read from GoHighLevel, nothing to fill in.
//
// The location already has these as opportunity custom fields
// (opportunity.meddic_1 … meddic_10), each with its own name AND its own
// placeholder text. On these fields the placeholder reads as the field's
// description — "What numbers matter", "Who actually signs off the spend" —
// so it IS the mapping the AI needs.
//
// This panel therefore has no inputs. Collecting the same descriptions a
// second time would have created two sources of truth that drift: someone
// edits the field in GoHighLevel, the copy here goes stale, and the AI keeps
// using the stale one. Read-only means GoHighLevel stays authoritative.

export default function MeddicMappingSection({ fields = [] }) {
  const active = fields.filter((f) => f.active !== false)
  const described = active.filter((f) => (f.description || '').trim()).length

  // No fields synced yet — a real state, not an error. The definitions cron
  // may not have run for this location, and saying so beats an empty panel
  // that looks broken.
  if (active.length === 0) {
    return (
      <SectionCard
        icon="checklist"
        title="Qualification headings"
        collapsible
        accent="gold"
        help="Read from your opportunity custom fields."
      >
        <p
          style={{
            margin: 0, padding: 16,
            fontSize: 'var(--text-md)', lineHeight: 1.55, color: 'var(--text-muted)'
          }}
        >
          No qualification fields found for this sub-account yet. They come from
          your opportunity custom fields — the ones keyed{' '}
          <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)' }}>meddic_1</code>{' '}
          onwards — and sync once a day, so they appear here shortly after being
          created in your CRM.
        </p>
      </SectionCard>
    )
  }

  return (
    <SectionCard
      icon="checklist"
      title="Qualification headings"
      collapsible
      accent="gold"
      meta={`${active.length} field${active.length === 1 ? '' : 's'}`}
      help="These are your own opportunity fields, read straight from your CRM — name and description both. Edit them there and this updates on the next daily sync."
    >
      <div>
        {active.map((f, i) => (
          <div
            key={f.fieldKey}
            style={{
              display: 'grid',
              gridTemplateColumns: 'minmax(150px, 220px) 1fr',
              gap: 'var(--space-4)', alignItems: 'baseline',
              padding: 'var(--space-3) var(--space-4)',
              borderBottom: i === active.length - 1
                ? 'none'
                : '1px solid var(--border-default)'
            }}
          >
            <div style={{ minWidth: 0 }}>
              <span
                style={{
                  display: 'block',
                  fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-heading)'
                }}
              >
                {f.name}
              </span>
              {/* The GHL key, so a rep can match this row to the field they
                  see in GoHighLevel. */}
              <span
                style={{
                  display: 'block', marginTop: 2,
                  fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)',
                  color: 'var(--text-faint)'
                }}
              >
                meddic_{f.index}
              </span>
            </div>

            {f.description ? (
              <p
                style={{
                  margin: 0, maxWidth: 620,
                  fontSize: 'var(--text-md)', lineHeight: 1.5, color: 'var(--text-body)'
                }}
              >
                {f.description}
              </p>
            ) : (
              // Say what to do about it, not just that it's missing. A blank
              // description means the AI gets the heading with no guidance on
              // what belongs under it.
              <p
                style={{
                  margin: 0, fontSize: 'var(--text-base)', lineHeight: 1.5,
                  color: 'var(--text-faint)'
                }}
              >
                No description — add placeholder text to this field in
                your CRM and the AI will use it.
              </p>
            )}
          </div>
        ))}
      </div>

      <p
        style={{
          margin: 0, padding: '10px var(--space-4)',
          borderTop: '1px solid var(--border-default)',
          background: 'var(--gray-25)',
          fontSize: 'var(--text-base)', color: 'var(--text-muted)'
        }}
      >
        {described} of {active.length} have a description. The AI files
        qualification evidence under these headings using these exact names.
      </p>
    </SectionCard>
  )
}
