import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Select } from 'antd'
import { opsAPI } from '../../api/operations'
import { tasksAPI } from '../../api/tasks'
import { FilterChip, SearchInput, StateMessage, formatDate } from '../shared/ListChrome'
import {
  Badge, Card, StageArrows, jobLabel, statusBadge, dateRange
} from './opsUi'
import { pendingLines } from './opsDecisions'

// The Operations Hub list screens: Pipeline board (s3, s4), Projects (s5),
// Remedials (s14), Tasks across jobs (s24) and Set up.

function useJobs(kind, params) {
  const [state, setState] = useState({ loading: true, error: null, jobs: [], stages: [], connected: true })
  const key = JSON.stringify(params)
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true, error: null }))
    opsAPI.list(kind, JSON.parse(key))
      .then((r) => setState({ loading: false, error: null, jobs: r.jobs || [], stages: r.stages || [], connected: r.connected !== false }))
      .catch((err) => setState({ loading: false, error: err.message, jobs: [], stages: [], connected: true }))
  }, [kind, key])
  useEffect(() => { load() }, [load])
  return { ...state, reload: load }
}

// ── Pipeline board ────────────────────────────────────────────────────

export function PipelineBoard({ kind, onKindChange, onOpen }) {
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const { loading, error, jobs, stages } = useJobs(kind, { status: 'open', ...(search ? { q: search } : {}) })

  const byStage = useMemo(() => {
    const m = {}
    for (const j of jobs) (m[j.stageKey || '_none'] ||= []).push(j)
    return m
  }, [jobs])
  const counts = useMemo(
    () => Object.fromEntries(stages.map((s) => [s.key, (byStage[s.key] || []).length])),
    [stages, byStage]
  )
  const unplaced = byStage._none || []

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <FilterChip label="Projects" active={kind === 'project'} onClick={() => onKindChange('project')} />
        <FilterChip label="Remedials" active={kind === 'remedial'} onClick={() => onKindChange('remedial')} />
        <span style={{ flex: 1 }} />
        <SearchInput
          value={q} onChange={setQ} width={260}
          placeholder="Search job no. or address"
          onKeyDown={(e) => { if (e.key === 'Enter') setSearch(q.trim()) }}
          onBlur={() => setSearch(q.trim())}
        />
      </div>
      <StateMessage loading={loading} error={error} />
      {!loading && !error && (
        <div style={{ overflowX: 'auto' }}>
          <div style={{ minWidth: stages.length * 150, display: 'flex', flexDirection: 'column', gap: 12 }}>
            <StageArrows stages={stages} counts={counts} />
            <div className="pp-ops-kb" style={{ gridTemplateColumns: `repeat(${stages.length}, minmax(0, 1fr))` }}>
              {stages.map((s) => (
                <div key={s.key} className="pp-ops-kc">
                  <h3>{s.name} · {counts[s.key] || 0}</h3>
                  {(byStage[s.key] || []).map((j) => (
                    <button key={j.id} type="button" className="pp-ops-kd" onClick={() => onOpen(j)}>
                      <strong style={{ fontSize: 13 }}>{jobLabel(j)}</strong>
                      <span>{[j.kind === 'project' ? j.contactName : j.dealName, j.postcode].filter(Boolean).join(' · ')}</span>
                      {(j.fitterName || j.installStart) && (
                        <span className="m">
                          {[j.fitterName, j.installStart ? `install ${dateRange(j.installStart, j.installEnd)}` : null].filter(Boolean).join(' · ')}
                        </span>
                      )}
                      {statusBadge(j)}
                    </button>
                  ))}
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
      {unplaced.length > 0 && (
        <Card title={`Not on a known stage · ${unplaced.length}`} attention
          sub="These are in the pipeline but on a stage whose name does not match the plan. Rename the stage in your CRM, or check Set up.">
          {unplaced.map((j) => (
            <div key={j.id} className="pp-ops-row" style={{ gridTemplateColumns: '1fr 200px' }}>
              <button type="button" className="pp-ops-link" onClick={() => onOpen(j)}>{jobLabel(j)}</button>
              <span>{j.stageName || 'No stage'}</span>
            </div>
          ))}
        </Card>
      )}
      <p className="pp-ops-sub">
        A job moves to the next column by itself when every step in its stage is done. Click a card to open it.
      </p>
    </>
  )
}

// ── Projects / Remedials lists ────────────────────────────────────────

export function JobList({ kind, onOpen, decisions, onLogRemedial }) {
  const [q, setQ] = useState('')
  const [search, setSearch] = useState('')
  const [status, setStatus] = useState('open')
  const { loading, error, jobs, stages } = useJobs(kind, { status, ...(search ? { q: search } : {}) })
  const stageName = (k) => stages.find((s) => s.key === k)?.name

  const isProject = kind === 'project'
  const cols = isProject
    ? '230px 160px 160px 140px 100px minmax(0,1fr)'
    : '170px minmax(0,1fr) 90px 130px 130px 140px 130px'

  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
        <FilterChip label="All live" active={status === 'open'} onClick={() => setStatus('open')} />
        <FilterChip label="Completed" active={status === 'won'} onClick={() => setStatus('won')} />
        <FilterChip label="Everything" active={status === 'all'} onClick={() => setStatus('all')} />
        <span style={{ flex: 1 }} />
        {!isProject && onLogRemedial && (
          <Button type="primary" onClick={onLogRemedial}>Log remedial</Button>
        )}
      </div>
      <Card>
        <SearchInput
          value={q} onChange={setQ} width={300}
          placeholder={isProject ? 'Search job no., address or client' : 'Search ref, job no. or address'}
          onKeyDown={(e) => { if (e.key === 'Enter') setSearch(q.trim()) }}
          onBlur={() => setSearch(q.trim())}
        />
        <StateMessage
          loading={loading} error={error}
          empty={!loading && !error && jobs.length === 0}
          emptyText={isProject
            ? 'No projects yet. A deal in the Operations pipeline in your CRM shows up here.'
            : 'No remedials yet. Log one, or add a deal to the Remedials pipeline in your CRM.'}
        />
        {!loading && !error && jobs.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: isProject ? 960 : 1000 }}>
              <div className="pp-ops-row head" style={{ gridTemplateColumns: cols }}>
                {isProject
                  ? <><span>Job</span><span>Client</span><span>Stage</span><span>Company</span><span>Install</span><span>Status</span></>
                  : <><span>Ref</span><span>Issue</span><span>Type</span><span>Category</span><span>Reason</span><span>Stage</span><span>Status</span></>}
              </div>
              {jobs.map((j) => (
                <div key={j.id} className="pp-ops-row" style={{ gridTemplateColumns: cols }}>
                  <button type="button" className="pp-ops-link" onClick={() => onOpen(j)} style={{ overflowWrap: 'anywhere' }}>
                    {jobLabel(j)}{isProject && j.postcode ? <span style={{ fontWeight: 400 }}> · {j.postcode}</span> : null}
                  </button>
                  {isProject ? (
                    <>
                      <span>{j.contactName || '–'}</span>
                      <span><Badge tone="stage">{stageName(j.stageKey) || j.stageName || '–'}</Badge></span>
                      <span>{j.businessName || '–'}</span>
                      <span>{dateRange(j.installStart, j.installEnd) || '–'}</span>
                    </>
                  ) : (
                    <>
                      <span>{j.dealName || '–'}</span>
                      <span>{j.remedialKind === 'product' ? 'Product' : j.remedialKind === 'other' ? 'Other' : '–'}</span>
                      <span>{j.category || '–'}</span>
                      <span>{j.reason || '–'}</span>
                      <span><Badge tone="stage">{stageName(j.stageKey) || j.stageName || '–'}</Badge></span>
                    </>
                  )}
                  <span>{statusBadge(j)}</span>
                </div>
              ))}
            </div>
          </div>
        )}
        {decisions?.jobNumbersAreManual && (
          <p className="pp-ops-sub">
            {isProject ? 'Job numbers' : 'References'} are typed on each job for now — where they come from is still
            to be decided.
          </p>
        )}
      </Card>
    </>
  )
}

// ── Log a remedial ────────────────────────────────────────────────────

export function LogRemedial({ onClose, onLogged }) {
  const [form, setForm] = useState({ name: '', projectId: null, remedialKind: null, category: '', reason: '', reportedVia: '' })
  const [projects, setProjects] = useState([])
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  useEffect(() => {
    opsAPI.list('project', { status: 'all' }).then((r) => setProjects(r.jobs || [])).catch(() => {})
  }, [])
  const set = (k) => (v) => setForm((f) => ({ ...f, [k]: v }))

  const submit = async () => {
    setSaving(true)
    setError(null)
    try {
      const body = Object.fromEntries(Object.entries(form).filter(([, v]) => v !== '' && v != null))
      const res = await opsAPI.logRemedial(body)
      onLogged?.(res.id)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card title="Log a remedial" actions={<Button size="small" onClick={onClose} disabled={saving}>Cancel</Button>}
      sub="Creates it in the Remedials pipeline at Reported. The customer is the project's.">
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12 }}>
        <label className="pp-ops-lbl">What is wrong
          <Input value={form.name} onChange={(e) => set('name')(e.target.value)} placeholder="e.g. Shower screen leaking" />
        </label>
        <label className="pp-ops-lbl">Project
          <Select
            showSearch allowClear optionFilterProp="label" value={form.projectId} onChange={set('projectId')}
            placeholder="Choose the original job" style={{ width: '100%' }} popupClassName="pp-menu"
            options={projects.map((p) => ({ value: p.id, label: `${jobLabel(p)} · ${p.contactName || ''}` }))}
          />
        </label>
        <label className="pp-ops-lbl">Type
          <Select value={form.remedialKind} onChange={set('remedialKind')} placeholder="Product or other"
            style={{ width: '100%' }} popupClassName="pp-menu" allowClear
            options={[{ value: 'product', label: 'Product' }, { value: 'other', label: 'Other' }]} />
        </label>
        <label className="pp-ops-lbl">Category
          <Input value={form.category} onChange={(e) => set('category')(e.target.value)} placeholder="Shower screen, Tiling…" />
        </label>
        <label className="pp-ops-lbl">Reason
          <Input value={form.reason} onChange={(e) => set('reason')(e.target.value)} placeholder="Supplier fault, Wear…" />
        </label>
        <label className="pp-ops-lbl">Reported by
          <Input value={form.reportedVia} onChange={(e) => set('reportedVia')(e.target.value)} placeholder="Customer (phone)" />
        </label>
      </div>
      {error && <StateMessage error={error} />}
      <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
        <Button type="primary" loading={saving} disabled={!form.name.trim() || !form.projectId} onClick={submit}>
          Log remedial
        </Button>
      </div>
    </Card>
  )
}

// ── Tasks across jobs (s24) ───────────────────────────────────────────

const TASK_FILTERS = [
  { key: 'mine', label: 'My tasks' },
  { key: 'overdue', label: 'Overdue' },
  { key: 'today', label: 'Due today' },
  { key: 'week', label: 'This week' },
  { key: 'open', label: 'All open' },
  { key: 'done', label: 'Done' }
]

function dueGroup(iso) {
  if (!iso) return 'Later'
  const d = new Date(iso); d.setHours(0, 0, 0, 0)
  const t = new Date(); t.setHours(0, 0, 0, 0)
  const days = Math.round((d - t) / 86400000)
  if (days < 0) return 'Overdue'
  if (days === 0) return 'Today'
  if (days < 7) return 'This week'
  return 'Later'
}
const GROUP_ORDER = ['Overdue', 'Today', 'This week', 'Later']

export function OpsTasks({ meId, onOpen }) {
  const [filter, setFilter] = useState('mine')
  const [state, setState] = useState({ loading: true, error: null, tasks: [] })
  const [busy, setBusy] = useState(null)
  const load = useCallback(() => {
    setState((s) => ({ ...s, loading: true }))
    const params = filter === 'mine'
      ? { filter: 'open', ...(meId ? { assignedTo: meId } : {}) }
      : { filter }
    opsAPI.tasks(params)
      .then((r) => setState({ loading: false, error: null, tasks: r.tasks || [] }))
      .catch((err) => setState({ loading: false, error: err.message, tasks: [] }))
  }, [filter, meId])
  useEffect(() => { load() }, [load])

  const toggle = async (t) => {
    setBusy(t.id)
    try {
      await tasksAPI.setCompleted(t.id, t.status !== 'completed')
      load()
    } catch (err) {
      setState((s) => ({ ...s, error: err.message }))
    } finally {
      setBusy(null)
    }
  }

  const groups = useMemo(() => {
    if (filter === 'done') return [['Done', state.tasks]]
    const m = {}
    for (const t of state.tasks) (m[dueGroup(t.dueAt)] ||= []).push(t)
    return GROUP_ORDER.filter((g) => m[g]).map((g) => [g, m[g]])
  }, [state.tasks, filter])

  const cols = '40px minmax(0,1fr) 230px 170px 120px 110px'
  return (
    <>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {TASK_FILTERS.map((f) => (
          <FilterChip key={f.key} label={f.label} active={filter === f.key} onClick={() => setFilter(f.key)} />
        ))}
      </div>
      <Card>
        <StateMessage
          loading={state.loading} error={state.error}
          empty={!state.loading && !state.error && state.tasks.length === 0}
          emptyText="No tasks here. Tasks are added from a project or remedial."
        />
        {!state.loading && state.tasks.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 900 }}>
              <div className="pp-ops-row head" style={{ gridTemplateColumns: cols }}>
                <span /><span>Task</span><span>On</span><span>Stage</span><span>Who</span><span>Due</span>
              </div>
              {groups.map(([g, list]) => (
                <React.Fragment key={g}>
                  <div className="pp-ops-group">{g} · {list.length}</div>
                  {list.map((t) => (
                    <div key={t.id} className="pp-ops-row" style={{ gridTemplateColumns: cols }}>
                      <span>
                        <input type="checkbox" checked={t.status === 'completed'} disabled={busy === t.id}
                          onChange={() => toggle(t)} aria-label={`Complete ${t.title}`} />
                      </span>
                      <span>{t.title}</span>
                      <span><button type="button" className="pp-ops-link" onClick={() => onOpen(t.job)}>{t.job.label}</button></span>
                      <span>{t.job.stageName || '–'}</span>
                      <span>{t.assignedToName || 'Unassigned'}</span>
                      <span>
                        {g === 'Overdue'
                          ? <Badge tone="bad">{formatDate(t.dueAt, false)}</Badge>
                          : g === 'Today' ? <Badge tone="warn">Today</Badge> : formatDate(t.dueAt, false) || '–'}
                      </span>
                    </div>
                  ))}
                </React.Fragment>
              ))}
            </div>
          </div>
        )}
        <p className="pp-ops-sub">Every task belongs to one project or remedial; click “On” to open it.</p>
      </Card>
    </>
  )
}

// ── Set up ────────────────────────────────────────────────────────────

export function SetUp({ decisions, onSaved }) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [draft, setDraft] = useState({ operationsPipelineId: null, remedialsPipelineId: null })
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState(null)

  const load = useCallback(() => {
    opsAPI.settings()
      .then((d) => {
        setState({ loading: false, error: null, data: d })
        setDraft({ operationsPipelineId: d.operationsPipelineId, remedialsPipelineId: d.remedialsPipelineId })
      })
      .catch((err) => setState({ loading: false, error: err.message, data: null }))
  }, [])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setSaving(true)
    setSaveError(null)
    try {
      await opsAPI.saveSettings(draft)
      load()
      onSaved?.()
    } catch (err) {
      setSaveError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const d = state.data
  const options = (d?.pipelines || []).map((p) => ({
    value: p.id,
    label: p.matches.length ? `${p.name} — stages match` : p.name
  }))
  const dirty = d && (draft.operationsPipelineId !== d.operationsPipelineId
    || draft.remedialsPipelineId !== d.remedialsPipelineId)

  return (
    <>
      <StateMessage loading={state.loading} error={state.error} />
      {d && (
        <Card title="Which CRM pipelines are projects and remedials"
          sub="Choosing them only tells Deal Hub where to look — nothing changes in your CRM.">
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))', gap: 16 }}>
            {[
              ['operationsPipelineId', 'Projects (Operations pipeline)', 'project'],
              ['remedialsPipelineId', 'Remedials pipeline', 'remedial']
            ].map(([field, label, kind]) => {
              const check = d.check?.[kind]
              const saved = d[field] === draft[field]
              return (
                <div key={field} style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <span className="pp-ops-lbl" style={{ fontWeight: 600, color: 'var(--text-body)' }}>{label}</span>
                  <Select allowClear value={draft[field]} onChange={(v) => setDraft((x) => ({ ...x, [field]: v ?? null }))}
                    placeholder="Choose a pipeline" options={options} popupClassName="pp-menu" />
                  {saved && check && (check.ok
                    ? <Badge tone="ok">All {d.expected[kind].length} stages found</Badge>
                    : <span className="pp-ops-sub">Missing stages: <b>{check.missing.join(', ')}</b>{check.extra.length ? ` · not used: ${check.extra.join(', ')}` : ''}</span>)}
                  <span className="pp-ops-sub">Expected: {d.expected[kind].join(' → ')}</span>
                </div>
              )
            })}
          </div>
          {saveError && <StateMessage error={saveError} />}
          <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
            <Button type="primary" disabled={!dirty} loading={saving} onClick={save}>Save</Button>
          </div>
          {!d.pipelines.some((p) => p.matches.length) && (
            <div className="pp-ops-note">
              No pipeline in your CRM has these stages yet. They are added once in your CRM (Settings → Opportunities →
              Pipelines) with the stage names above — or by Deal Hub once it is given the permission to create
              pipelines. Deal Hub never creates one without asking.
            </div>
          )}
        </Card>
      )}
      {pendingLines(decisions).length > 0 && (
        <Card title="Waiting on decisions" sub="These work in a simple way for now and change when they are decided.">
          {pendingLines(decisions).map((l) => (
            <div key={l.q} className="pp-ops-kv"><span>{l.text}</span><Badge tone="warn">{l.q}</Badge></div>
          ))}
        </Card>
      )}
    </>
  )
}

