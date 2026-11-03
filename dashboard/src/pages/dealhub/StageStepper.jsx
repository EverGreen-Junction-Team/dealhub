import React from 'react'

// Chevron stage stepper — one segment per stage in the deal's pipeline.
// Past stages fill green-600, the current one green-700 (the darkest fill),
// future stages gray-100. The chevron is a clip-path polygon; each segment
// overlaps the next by the notch depth so the arrows nest cleanly.
//
// stages: [{ name, isCurrent, isPast }]
export default function StageStepper({ stages, onStageClick }) {
  if (!stages || stages.length === 0) return null

  // The chevron's point depth. 14px against a 40px band gave a shallow
  // arrow that read as a rectangle with a bevel; the design's is a clear
  // arrowhead.
  const notch = 18
  const seg = stages.length

  return (
    <div
      style={{
        display: 'flex',
        borderTop: '1px solid var(--border-default)',
        borderRadius: '0 0 var(--radius-md) var(--radius-md)',
        // Clip only the stepper itself so chevrons don't bleed past the
        // rounded corners. Kept off the parent card so the deal-switcher
        // dropdown can hang below without being clipped.
        overflow: 'hidden'
      }}
    >
      {stages.map((s, i) => {
        const isFirst = i === 0
        const isLast = i === seg - 1
        // The chevron clip-path — each segment ends in a pointed arrow, and
        // (unless first) starts with a notched indent matching the previous
        // segment's tail.
        const clip = isFirst
          ? `polygon(0 0, calc(100% - ${notch}px) 0, 100% 50%, calc(100% - ${notch}px) 100%, 0 100%)`
          : isLast
          ? `polygon(0 0, 100% 0, 100% 100%, 0 100%, ${notch}px 50%)`
          : `polygon(0 0, calc(100% - ${notch}px) 0, 100% 50%, calc(100% - ${notch}px) 100%, 0 100%, ${notch}px 50%)`

        // Progression reads left to right, and the CURRENT stage is the
        // darkest thing in the row — which is the design's ordering and the
        // opposite of what shipped.
        //
        //   done    — mid green. Complete, and visibly so, but it yields to
        //             the stage the deal is actually on.
        //   current — deep green, the darkest fill. "Where is this deal" is
        //             the question the stepper exists to answer.
        //   upcoming— grey, the only pale state of the three.
        //
        // These were the other way round (past darker than current), so the
        // eye landed on work already finished.
        //
        // Contrast, computed:
        //   #fff on green-600 #186349 = 7.19:1
        //   #fff on green-700 #124d39 = 9.78:1
        //   gray-600 on gray-100      = 6.87:1 light, 8.32:1 dark
        //
        // That last one is a FIX, not a restatement: upcoming stages were
        // --text-muted on --gray-100, which is 4.36:1 — under AA for text
        // this size. gray-600 clears it in both themes.
        const bg = s.isCurrent
          ? 'var(--green-700)'
          : s.isPast
          ? 'var(--green-600)'
          : 'var(--gray-100)'
        const fg = s.isCurrent || s.isPast
          ? '#fff'
          : 'var(--gray-600)'

        return (
          <button
            key={s.name + i}
            onClick={() => onStageClick && onStageClick(s)}
            title={
              s.isCurrent
                ? 'Current stage'
                : onStageClick
                ? `Move deal to ${s.name}`
                : s.name
            }
            style={{
              flex: 1,
              minWidth: 0,
              cursor: onStageClick ? 'pointer' : 'default',
              border: 'none',
              height: 56,
              padding: `0 12px 0 ${isFirst ? 12 : 24}px`,
              marginLeft: isFirst ? 0 : -notch,
              clipPath: clip,
              background: bg,
              color: fg,
              fontFamily: 'var(--font-sans)',
              fontSize: 'var(--text-base)',
              fontWeight: s.isCurrent ? 600 : 500,
              whiteSpace: 'nowrap',
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              transition: 'background 0.15s ease-out'
            }}
          >
            {s.name}
          </button>
        )
      })}
    </div>
  )
}
