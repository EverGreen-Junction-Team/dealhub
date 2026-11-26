import React from 'react'

// Shared pieces for the Operations Hub screens (s1–s24 in
// Operations-Hub-TBCG-all-screens). Colours follow the design: the deep
// operations green for the current stage, a pale wash for done ones.

export const OPS_CSS = `
.pp-ops-card {
  background: #fff;
  border: 1px solid var(--border-default);
  border-radius: 14px;
  padding: 16px;
  display: flex; flex-direction: column; gap: 10px;
  min-width: 0;
  box-shadow: 0 1px 2px rgba(16,24,40,.05);
}
.pp-ops-card.attention { border-color: #E7A8A1; }
.pp-ops-ct { margin: 0; font-size: 15px; font-weight: 700; color: var(--text-heading); }
.pp-ops-sub { margin: 0; font-size: 12.5px; color: var(--text-muted); }
.pp-ops-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; flex-wrap: wrap; }
.pp-ops-badge { font-size: 11.5px; font-weight: 600; padding: 2px 8px; border-radius: 6px; white-space: nowrap; }
.pp-ops-badge.ok { background: #E3F3E8; color: #146B33; }
.pp-ops-badge.warn { background: #FDF1D6; color: #7A5300; }
.pp-ops-badge.bad { background: #FDECEA; color: #8C1D13; }
.pp-ops-badge.grey { background: #ECEEF2; color: #3B4048; }
.pp-ops-badge.stage { background: #E2EFE8; color: #24543F; }
.pp-ops-stages { list-style: none; margin: 0; padding: 0; display: flex; font-size: 12.5px; font-weight: 600; min-width: 900px; }
.pp-ops-stages li {
  flex: 1 1 0; min-width: 0; display: flex; flex-direction: column; align-items: center; justify-content: center;
  min-height: 44px; box-sizing: border-box; padding: 6px 16px 6px 26px; margin-left: -10px; text-align: center;
  line-height: 1.25; background: #DDE0E6; color: #3B4048;
  clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%, 14px 50%);
}
.pp-ops-stages li:first-child {
  margin-left: 0; padding-left: 16px; border-radius: 8px 0 0 8px;
  clip-path: polygon(0 0, calc(100% - 14px) 0, 100% 50%, calc(100% - 14px) 100%, 0 100%);
}
.pp-ops-stages li.done { background: #BFDCCB; color: #163B2A; }
.pp-ops-stages li.current { background: #24543F; color: #fff; }
.pp-ops-stages li.unmapped { opacity: .55; }
.pp-ops-stages li button {
  all: unset; cursor: pointer; display: flex; flex-direction: column; align-items: center; width: 100%;
}
.pp-ops-stages li button:focus-visible { outline: 2px solid #fff; outline-offset: -4px; }
.pp-ops-stages li b { font-size: 17px; font-weight: 700; }
.pp-ops-row { display: grid; gap: 10px; align-items: center; padding: 9px 0; border-top: 1px solid #ECEEF2; font-size: 13.5px; }
.pp-ops-row.head { font-size: 11.5px; color: var(--text-muted); font-weight: 600; border-top: none; padding-top: 0; }
.pp-ops-group { font-size: 12.5px; font-weight: 700; color: #3B4048; background: #F4F5F7; border-radius: 6px; padding: 7px 10px; margin-top: 6px; }
.pp-ops-link { all: unset; cursor: pointer; color: #2F6B50; font-weight: 600; }
.pp-ops-link:hover { color: #24543F; text-decoration: underline; }
.pp-ops-kv { display: grid; grid-template-columns: minmax(0,1fr) auto; gap: 8px; align-items: center; padding: 8px 0; border-top: 1px solid #ECEEF2; font-size: 13.5px; }
.pp-ops-kv:first-of-type { border-top: none; padding-top: 0; }
.pp-ops-lbl { font-size: 11.5px; color: var(--text-muted); margin: 0 0 2px; }
.pp-ops-val { font-size: 14px; color: var(--text-heading); margin: 0; font-weight: 600; overflow-wrap: anywhere; }
.pp-ops-kb { display: grid; gap: 10px; align-items: start; }
.pp-ops-kc { background: #E6E8ED; border-radius: 10px; padding: 8px; display: flex; flex-direction: column; gap: 8px; min-width: 0; }
.pp-ops-kc h3 { margin: 0; font-size: 12px; font-weight: 700; color: #3B4048; padding: 2px 2px 0; }
.pp-ops-kd {
  all: unset; cursor: pointer; background: #fff; border: 1px solid #E3E5EA; border-radius: 8px; padding: 9px 10px;
  font-size: 12.5px; display: flex; flex-direction: column; gap: 4px; align-items: flex-start; color: var(--text-heading);
}
.pp-ops-kd:hover { border-color: #3D7B5E; }
.pp-ops-kd .m { color: var(--text-muted); font-size: 11.5px; }
.pp-ops-tabs { display: flex; flex-wrap: wrap; gap: 4px; border-bottom: 1px solid #D5D9E0; }
.pp-ops-tb {
  all: unset; cursor: pointer; font-size: 14px; font-weight: 600; padding: 11px 14px;
  border-bottom: 3px solid transparent; color: #3B4048;
}
.pp-ops-tb:hover { color: #24543F; }
.pp-ops-tb.on { color: #24543F; border-bottom-color: #3D7B5E; }
.pp-ops-note { padding: 10px 12px; border-radius: 8px; background: #F4F5F7; font-size: 13px; }
`

export function OpsStyles() {
  return <style>{OPS_CSS}</style>
}

export function Badge({ tone = 'grey', children, title }) {
  return <span className={`pp-ops-badge ${tone}`} title={title}>{children}</span>
}

export function Card({ title, sub, actions, attention, children, style }) {
  return (
    <section className={`pp-ops-card${attention ? ' attention' : ''}`} style={style}>
      {(title || actions) && (
        <div className="pp-ops-head">
          {title && <h3 className="pp-ops-ct">{title}</h3>}
          {actions && <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>{actions}</div>}
        </div>
      )}
      {sub && <p className="pp-ops-sub">{sub}</p>}
      {children}
    </section>
  )
}

/**
 * The stage arrows (s6, s15). counts → the board's numbers inside each arrow.
 * onPick → each arrow is a button (the job page uses it to move the stage).
 */
export function StageArrows({ stages, currentKey, counts, onPick, disabled }) {
  const currentIndex = stages.findIndex((s) => s.key === currentKey)
  return (
    <div style={{ overflowX: 'auto' }}>
      <ol className="pp-ops-stages" aria-label="Stages">
        {stages.map((s, i) => {
          const cls = [
            counts ? 'done' : (i < currentIndex ? 'done' : i === currentIndex ? 'current' : ''),
            s.mapped === false ? 'unmapped' : ''
          ].join(' ').trim()
          const label = (
            <>
              {counts && <b>{counts[s.key] || 0}</b>}
              {s.name}{!counts && i < currentIndex ? ' ✓' : ''}
            </>
          )
          return (
            <li key={s.key} className={cls} aria-current={i === currentIndex ? 'step' : undefined}
              title={s.mapped === false ? 'Not in the GHL pipeline — see Set up' : undefined}>
              {onPick && !disabled && i !== currentIndex && s.mapped !== false
                ? <button type="button" onClick={() => onPick(s)} aria-label={`Move to ${s.name}`}>{label}</button>
                : label}
            </li>
          )
        })}
      </ol>
    </div>
  )
}

/** "TBCG-20049 · Laura Bell · 12 Cheapside Street · G76 0JZ" */
export function jobTitle(job) {
  if (!job) return ''
  const lead = job.kind === 'project'
    ? (job.jobNumber || 'No job no.')
    : (job.ref || 'No ref')
  const parts = job.kind === 'project'
    ? [lead, job.contactName, job.address, job.postcode]
    : [lead, job.address, job.dealName]
  return parts.filter(Boolean).join(' · ')
}

/** The short label a list or card leads with. */
export function jobLabel(job) {
  if (job.kind === 'project') return job.jobNumber || job.dealName || 'Project'
  return job.ref || job.dealName || 'Remedial'
}

export function statusBadge(job) {
  if (job.overdueTasks > 0) return <Badge tone="bad">{job.overdueTasks} overdue</Badge>
  if (job.openTasks > 0) return <Badge tone="grey">{job.openTasks} open task{job.openTasks === 1 ? '' : 's'}</Badge>
  return <Badge tone="ok">On track</Badge>
}

/** "3 Dec" or "3–9 Dec" from two ISO dates. */
export function dateRange(start, end) {
  if (!start) return null
  const fmt = (iso, withMonth = true) => {
    const d = new Date(`${iso}T12:00:00`)
    return withMonth ? d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' }) : String(d.getDate())
  }
  if (!end || end === start) return fmt(start)
  const sameMonth = start.slice(0, 7) === end.slice(0, 7)
  return `${sameMonth ? fmt(start, false) : fmt(start)}–${fmt(end)}`
}

/** Today in the browser, as YYYY-MM-DD. */
export function todayIso() {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
