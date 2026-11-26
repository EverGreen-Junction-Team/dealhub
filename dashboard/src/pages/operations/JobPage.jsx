import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Button, Input, Select, DatePicker, InputNumber } from 'antd'
import dayjs from 'dayjs'
import { opsAPI } from '../../api/operations'
import { tasksAPI } from '../../api/tasks'
import { StateMessage, formatDate, FilterChip } from '../shared/ListChrome'
import { Badge, Card, StageArrows, jobTitle, jobLabel, dateRange, todayIso } from './opsUi'

// One project (s6, s7, s13) or remedial (s15, s16, s22): header, facts, stage
// arrows and the Overview / Tasks / Add time tabs. The design's other tabs
// (Orders, Schedule, Money & time, Files, Activity) belong to later slices.

const TABS = [
  { key: 'overview', label: 'Overview' },
  { key: 'tasks', label: 'Tasks' },
  { key: 'time', label: 'Add time' }
]

const userOptions = (users) => (users || []).map((u) => ({ value: u.id, label: u.name || u.email || u.id }))
const nameOf = (users, id) => (users || []).find((u) => u.id === id)?.name || null
const dateValue = (iso) => (iso ? dayjs(iso) : null)
const isoOf = (d) => (d ? d.format('YYYY-MM-DD') : null)

export default function JobPage({ kind, id, users, businesses, meId, onOpen, onBack, say }) {
  const [state, setState] = useState({ loading: true, error: null, data: null })
  const [tab, setTab] = useState('overview')

  const load = useCallback(() => {
    return opsAPI.get(kind, id)
      .then((data) => setState({ loading: false, error: null, data }))
      .catch((err) => setState({ loading: false, error: err.message, data: null }))
  }, [kind, id])
  useEffect(() => { setState({ loading: true, error: null, data: null }); setTab('overview'); load() }, [load])

  const d = state.data
  const job = d?.job
  const stageName = (k) => d?.stages.find((s) => s.key === k)?.name

  return (
    <>
      <header style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
        <div style={{ minWidth: 0 }}>
          <p className="pp-ops-sub">
            <button type="button" className="pp-ops-link" onClick={onBack}>
              {kind === 'project' ? 'Projects' : 'Remedials'}
            </button>
            {job ? ` › ${jobLabel(job)}` : ''}
          </p>
          <h1 style={{ margin: '2px 0 0', fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--text-heading)', overflowWrap: 'anywhere' }}>
            {job ? jobTitle(job) : '…'}
          </h1>
        </div>
        {job && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <Button onClick={() => setTab('time')}>Add time</Button>
          </div>
        )}
      </header>
      <StateMessage loading={state.loading} error={state.error} />
      {d && (
        <>
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
            <Badge tone="stage">{stageName(job.stageKey) || job.stageName || 'No stage'}</Badge>
            {job.overdueTasks > 0 && <Badge tone="bad">{job.overdueTasks} overdue task{job.overdueTasks === 1 ? '' : 's'}</Badge>}
            {kind === 'project' && job.installStart && <Badge tone="warn">Install {dateRange(job.installStart, job.installEnd)}</Badge>}
            {kind === 'remedial' && job.remedialKind && <Badge>{job.remedialKind === 'product' ? 'Product' : 'Other'}</Badge>}
          </div>
          <Facts kind={kind} job={job} users={users} businesses={businesses} related={d.related}
            jobNumberEditable={d.jobNumberEditable} onOpen={onOpen}
            onSaved={(next) => setState((s) => ({ ...s, data: { ...s.data, job: next } }))} />
          <StageBar kind={kind} id={id} stages={d.stages} currentKey={job.stageKey} stagesOk={d.stagesOk}
            onMoved={(to) => { say(`Moved to ${stageName(to)}`, 'done'); load() }} say={say} />
          <nav className="pp-ops-tabs">
            {TABS.map((t) => (
              <button key={t.key} type="button" className={`pp-ops-tb${tab === t.key ? ' on' : ''}`} onClick={() => setTab(t.key)}>
                {t.label}{t.key === 'tasks' && d.tasks.length ? ` · ${d.tasks.filter((x) => x.status !== 'completed').length}` : ''}
              </button>
            ))}
          </nav>
          {tab === 'overview' && (
            <Overview kind={kind} id={id} data={d} users={users} reload={load} say={say} onOpenTasks={() => setTab('tasks')} />
          )}
          {tab === 'tasks' && <JobTasks kind={kind} id={id} data={d} users={users} reload={load} say={say} />}
          {tab === 'time' && <JobTime kind={kind} id={id} users={users} meId={meId} activities={d.activities} say={say} onChanged={load} />}
        </>
      )}
    </>
  )
}

// ── Facts ──────────────────────────────────────────────────────────────

function Facts({ kind, job, users, businesses, related, jobNumberEditable, onOpen, onSaved }) {
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState({})
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  const start = () => {
    setDraft(kind === 'project'
      ? {
          jobNumber: job.jobNumber || '', businessId: job.businessId, showroomUserId: job.showroomUserId,
          orderingUserId: job.orderingUserId, adminUserId: job.adminUserId, fitterName: job.fitterName || '',
          installStart: job.installStart, installEnd: job.installEnd
        }
      : {
          ref: job.ref || '', remedialKind: job.remedialKind, reason: job.reason || '', category: job.category || '',
          fitterName: job.fitterName || '', reportedVia: job.reportedVia || '', takenByUserId: job.takenByUserId,
          reportedAt: job.reportedAt
        })
    setError(null)
    setEditing(true)
  }
  const set = (k) => (v) => setDraft((x) => ({ ...x, [k]: v }))

  const save = async () => {
    setSaving(true)
    setError(null)
    try {
      const patch = { ...draft }
      if (kind === 'project' && !jobNumberEditable) delete patch.jobNumber
      for (const k of Object.keys(patch)) if (patch[k] === undefined) patch[k] = null
      const res = await opsAPI.update(kind, job.id, patch)
      onSaved(res.job)
      setEditing(false)
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  const projectFacts = [
    ['Job no.', job.jobNumber || '–'],
    ['Showroom contact', nameOf(users, job.showroomUserId) || '–'],
    ['Ordering', nameOf(users, job.orderingUserId) || '–'],
    ['Admin', nameOf(users, job.adminUserId) || '–'],
    ['Company', job.businessName || '–'],
    ['Fitter', job.fitterName || '–'],
    ['Install', dateRange(job.installStart, job.installEnd) || '–']
  ]
  const remedialFacts = [
    ['Ref', job.ref || '–'],
    ['Type', job.remedialKind === 'product' ? 'Product' : job.remedialKind === 'other' ? 'Other' : '–'],
    ['Reason', job.reason || '–'],
    ['Category', job.category || '–'],
    ['Fitter', job.fitterName || '–'],
    ['Taken by', nameOf(users, job.takenByUserId) || '–'],
    ['Project', related?.[0]
      ? <button type="button" className="pp-ops-link" onClick={() => onOpen(related[0])}>{related[0].label}</button>
      : '–']
  ]
  const facts = kind === 'project' ? projectFacts : remedialFacts

  if (!editing) {
    return (
      <Card>
        <div style={{ display: 'flex', gap: 14, alignItems: 'flex-start' }}>
          <div style={{ flex: 1, minWidth: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 14 }}>
            {facts.map(([l, v]) => (
              <div key={l}><p className="pp-ops-lbl">{l}</p><p className="pp-ops-val">{v}</p></div>
            ))}
          </div>
          <Button size="small" onClick={start}>Edit</Button>
        </div>
        {kind === 'project' && related?.length > 0 && (
          <p className="pp-ops-sub">
            Remedials on this job:{' '}
            {related.map((r, i) => (
              <React.Fragment key={r.id}>
                {i ? ', ' : ''}
                <button type="button" className="pp-ops-link" onClick={() => onOpen(r)}>{r.label}</button>
              </React.Fragment>
            ))}
          </p>
        )}
      </Card>
    )
  }

  const field = (label, control) => (
    <label key={label} className="pp-ops-lbl" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>{label}{control}</label>
  )
  const userSelect = (k) => (
    <Select allowClear showSearch optionFilterProp="label" value={draft[k] || undefined} onChange={(v) => set(k)(v ?? null)}
      options={userOptions(users)} popupClassName="pp-menu" placeholder="Choose" />
  )

  return (
    <Card title="Edit details" actions={
      <>
        <Button size="small" onClick={() => setEditing(false)} disabled={saving}>Cancel</Button>
        <Button size="small" type="primary" loading={saving} onClick={save}>Save</Button>
      </>
    }>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(200px, 1fr))', gap: 12 }}>
        {kind === 'project' ? [
          field('Job no.', jobNumberEditable
            ? <Input value={draft.jobNumber} onChange={(e) => set('jobNumber')(e.target.value)} placeholder="e.g. TBCG-20049" />
            : <Input value={job.jobNumber || ''} disabled title="Comes from the CRM" />),
          field('Company', <Select allowClear value={draft.businessId || undefined} onChange={(v) => set('businessId')(v ?? null)}
            options={(businesses || []).map((b) => ({ value: b.id, label: b.name }))} popupClassName="pp-menu" placeholder="Choose" />),
          field('Showroom contact', userSelect('showroomUserId')),
          field('Ordering', userSelect('orderingUserId')),
          field('Admin', userSelect('adminUserId')),
          field('Fitter', <Input value={draft.fitterName} onChange={(e) => set('fitterName')(e.target.value)} placeholder="Name" />),
          field('Install starts', <DatePicker value={dateValue(draft.installStart)} onChange={(v) => set('installStart')(isoOf(v))} format="D MMM YYYY" />),
          field('Install ends', <DatePicker value={dateValue(draft.installEnd)} onChange={(v) => set('installEnd')(isoOf(v))} format="D MMM YYYY" />)
        ] : [
          field('Ref', <Input value={draft.ref} onChange={(e) => set('ref')(e.target.value)} placeholder="e.g. R-TBCG-19871-01" />),
          field('Type', <Select allowClear value={draft.remedialKind || undefined} onChange={(v) => set('remedialKind')(v ?? null)}
            options={[{ value: 'product', label: 'Product' }, { value: 'other', label: 'Other' }]} popupClassName="pp-menu" placeholder="Choose" />),
          field('Reason', <Input value={draft.reason} onChange={(e) => set('reason')(e.target.value)} />),
          field('Category', <Input value={draft.category} onChange={(e) => set('category')(e.target.value)} />),
          field('Fitter', <Input value={draft.fitterName} onChange={(e) => set('fitterName')(e.target.value)} />),
          field('Reported by', <Input value={draft.reportedVia} onChange={(e) => set('reportedVia')(e.target.value)} placeholder="Customer (phone)" />),
          field('Taken by', userSelect('takenByUserId')),
          field('Reported on', <DatePicker value={dateValue(draft.reportedAt)} onChange={(v) => set('reportedAt')(isoOf(v))} format="D MMM YYYY" />)
        ]}
      </div>
      {error && <StateMessage error={error} />}
    </Card>
  )
}

// ── Stage bar ──────────────────────────────────────────────────────────

function StageBar({ kind, id, stages, currentKey, stagesOk, onMoved, say }) {
  const [pending, setPending] = useState(null)
  const [busy, setBusy] = useState(false)
  const move = async () => {
    setBusy(true)
    try {
      await opsAPI.moveStage(kind, id, pending.key)
      setPending(null)
      onMoved(pending.key)
    } catch (err) {
      say(err.message)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <StageArrows stages={stages} currentKey={currentKey} onPick={setPending} disabled={busy} />
      {!stagesOk && (
        <p className="pp-ops-sub">Some stages are not in the CRM pipeline yet, so the job cannot be moved to them. See Set up.</p>
      )}
      {pending && (
        <div className="pp-ops-note" style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ flex: 1 }}>Move to <b>{pending.name}</b>? This changes the stage in your CRM.</span>
          <Button size="small" onClick={() => setPending(null)} disabled={busy}>Cancel</Button>
          <Button size="small" type="primary" loading={busy} onClick={move}>Move</Button>
        </div>
      )}
    </>
  )
}

// ── Overview: needs attention + this stage's checklist ─────────────────

function Overview({ kind, id, data, users, reload, say, onOpenTasks }) {
  const { job, steps, tasks } = data
  const today = todayIso()
  const current = steps.filter((s) => s.stageKey === job.stageKey)
  const doneCount = current.filter((s) => s.done).length
  const stageName = data.stages.find((s) => s.key === job.stageKey)?.name

  const overdueTasks = tasks.filter((t) => t.status !== 'completed' && t.dueAt && new Date(t.dueAt) < new Date(`${today}T00:00:00`))
  const overdueSteps = steps.filter((s) => !s.done && s.dueOn && s.dueOn < today)

  const [adding, setAdding] = useState({ title: '', dueOn: null, assigneeUserId: null })
  const [busy, setBusy] = useState(null)

  const tick = async (s) => {
    setBusy(s.id)
    try {
      const res = await opsAPI.updateStep(s.id, { done: !s.done })
      if (res.advancedTo) {
        say(`Every step done — moved to ${data.stages.find((x) => x.key === res.advancedTo)?.name}`, 'done')
      } else if (res.advanceError) {
        say(res.advanceError)
      }
      await reload()
    } catch (err) {
      say(err.message)
    } finally {
      setBusy(null)
    }
  }
  const add = async () => {
    setBusy('add')
    try {
      await opsAPI.addStep(kind, id, { ...adding, stageKey: job.stageKey })
      setAdding({ title: '', dueOn: null, assigneeUserId: null })
      await reload()
    } catch (err) {
      say(err.message)
    } finally {
      setBusy(null)
    }
  }
  const remove = async (s) => {
    setBusy(s.id)
    try { await opsAPI.removeStep(s.id); await reload() } catch (err) { say(err.message) } finally { setBusy(null) }
  }

  const cols = '40px minmax(0,1fr) 140px 110px 90px 32px'
  return (
    <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 2fr) minmax(260px, 1fr)', gap: 16, alignItems: 'start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        {(overdueTasks.length > 0 || overdueSteps.length > 0) && (
          <Card title="Needs attention" attention>
            {overdueSteps.map((s) => (
              <div key={s.id} className="pp-ops-kv"><span>{s.title}</span><Badge tone="bad">Due {formatDate(s.dueOn, false)}</Badge></div>
            ))}
            {overdueTasks.map((t) => (
              <div key={t.id} className="pp-ops-kv">
                <button type="button" className="pp-ops-link" onClick={onOpenTasks}>{t.title}</button>
                <Badge tone="bad">Due {formatDate(t.dueAt, false)}</Badge>
              </div>
            ))}
          </Card>
        )}
        <Card
          title={`To do in this stage${stageName ? ` · ${stageName}` : ''}`}
          actions={current.length > 0 && <Badge>{doneCount} of {current.length} done</Badge>}
          sub="The stage moves on by itself when every step is done."
        >
          {!job.stageKey && <p className="pp-ops-sub">This job is on a stage Deal Hub does not recognise, so it has no checklist.</p>}
          {job.stageKey && (
            <>
              <div className="pp-ops-row head" style={{ gridTemplateColumns: cols }}>
                <span /><span>Step</span><span>Who</span><span>Due</span><span /><span />
              </div>
              {current.length === 0 && <p className="pp-ops-sub">No steps for this stage. Add one below, or move the stage by hand.</p>}
              {current.map((s) => (
                <div key={s.id} className="pp-ops-row" style={{ gridTemplateColumns: cols }}>
                  <span><input type="checkbox" checked={s.done} disabled={busy === s.id} onChange={() => tick(s)} aria-label={`Done: ${s.title}`} /></span>
                  <span style={{ textDecoration: s.done ? 'line-through' : 'none', color: s.done ? 'var(--text-muted)' : undefined }}>{s.title}</span>
                  <span>{s.assigneeName || '–'}</span>
                  <span>{s.dueOn ? formatDate(s.dueOn, false) : '–'}</span>
                  <span>{s.done ? <Badge tone="ok">Done</Badge> : s.dueOn && s.dueOn < today ? <Badge tone="bad">Late</Badge> : <Badge>To do</Badge>}</span>
                  <span>
                    <button type="button" className="pp-ops-link" aria-label={`Remove ${s.title}`} title="Remove step"
                      disabled={busy === s.id} onClick={() => remove(s)}>×</button>
                  </span>
                </div>
              ))}
              <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 160px 140px auto', gap: 8, paddingTop: 8 }}>
                <Input value={adding.title} onChange={(e) => setAdding((a) => ({ ...a, title: e.target.value }))} placeholder="Add a step"
                  onPressEnter={() => adding.title.trim() && add()} />
                <Select allowClear showSearch optionFilterProp="label" value={adding.assigneeUserId || undefined}
                  onChange={(v) => setAdding((a) => ({ ...a, assigneeUserId: v ?? null }))}
                  options={userOptions(users)} popupClassName="pp-menu" placeholder="Who" />
                <DatePicker value={dateValue(adding.dueOn)} onChange={(v) => setAdding((a) => ({ ...a, dueOn: isoOf(v) }))}
                  format="D MMM" placeholder="Due" />
                <Button onClick={add} loading={busy === 'add'} disabled={!adding.title.trim()}>Add</Button>
              </div>
            </>
          )}
        </Card>
      </div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 16, minWidth: 0 }}>
        <Card title="People">
          <div className="pp-ops-kv"><span>Client · {job.contactName || '–'}</span><span>{job.phone || ''}</span></div>
          {job.email && <div className="pp-ops-kv"><span>Email</span><span style={{ overflowWrap: 'anywhere' }}>{job.email}</span></div>}
          {kind === 'project' && <div className="pp-ops-kv"><span>Fitter</span><span>{job.fitterName || '–'}</span></div>}
        </Card>
        <Card title="Time logged">
          <div className="pp-ops-kv"><span>Total</span><span>{data.time.total} hrs</span></div>
          <div className="pp-ops-kv"><span>This week</span><span>{data.time.thisWeek} hrs</span></div>
          {data.time.biggest && <div className="pp-ops-kv"><span>Biggest activity</span><span>{data.time.biggest.activity} · {data.time.biggest.hours}</span></div>}
        </Card>
      </div>
    </div>
  )
}

// ── Tasks on this job ─────────────────────────────────────────────────

function JobTasks({ kind, id, data, users, reload, say }) {
  const [show, setShow] = useState('open')
  const [form, setForm] = useState({ title: '', dueDate: null, assignedTo: null, stageKey: data.job.stageKey })
  const [busy, setBusy] = useState(null)
  const stageName = (k) => data.stages.find((s) => s.key === k)?.name || '–'
  const list = data.tasks.filter((t) => (show === 'done' ? t.status === 'completed' : t.status !== 'completed'))

  const add = async () => {
    setBusy('add')
    try {
      await opsAPI.addTask(kind, id, form)
      setForm((f) => ({ ...f, title: '', dueDate: null }))
      say('Task added — it appears here as soon as your CRM confirms it', 'done')
      window.setTimeout(reload, 2500)
    } catch (err) {
      say(err.message)
    } finally {
      setBusy(null)
    }
  }
  const toggle = async (t) => {
    setBusy(t.id)
    try { await tasksAPI.setCompleted(t.id, t.status !== 'completed'); await reload() } catch (err) { say(err.message) } finally { setBusy(null) }
  }

  const cols = '40px minmax(0,1fr) 170px 140px 110px'
  return (
    <Card title={`Tasks on this ${kind}`}
      sub={`Every task on this ${kind}, soonest first. They are tasks on the customer in your CRM, linked to this ${kind} here.`}>
      <div style={{ display: 'flex', gap: 6 }}>
        <FilterChip label="Open" active={show === 'open'} onClick={() => setShow('open')} />
        <FilterChip label="Done" active={show === 'done'} onClick={() => setShow('done')} />
      </div>
      <div className="pp-ops-row head" style={{ gridTemplateColumns: cols }}>
        <span /><span>Task</span><span>Stage</span><span>Who</span><span>Due</span>
      </div>
      {list.length === 0 && <p className="pp-ops-sub">{show === 'done' ? 'Nothing done yet.' : 'No open tasks.'}</p>}
      {list.map((t) => {
        const late = t.status !== 'completed' && t.dueAt && new Date(t.dueAt) < new Date(`${todayIso()}T00:00:00`)
        return (
          <div key={t.id} className="pp-ops-row" style={{ gridTemplateColumns: cols }}>
            <span><input type="checkbox" checked={t.status === 'completed'} disabled={busy === t.id} onChange={() => toggle(t)} aria-label={`Complete ${t.title}`} /></span>
            <span>{t.title}</span>
            <span>{stageName(t.stageKey)}</span>
            <span>{t.assignedToName || 'Unassigned'}</span>
            <span>{late ? <Badge tone="bad">{formatDate(t.dueAt, false)}</Badge> : formatDate(t.dueAt, false) || '–'}</span>
          </div>
        )
      })}
      <div style={{ display: 'grid', gridTemplateColumns: 'minmax(0,1fr) 150px 150px 170px auto', gap: 8, paddingTop: 10, borderTop: '1px solid #ECEEF2' }}>
        <Input value={form.title} onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))} placeholder="New task" />
        <DatePicker value={dateValue(form.dueDate)} onChange={(v) => setForm((f) => ({ ...f, dueDate: isoOf(v) }))} format="D MMM" placeholder="Due" />
        <Select allowClear showSearch optionFilterProp="label" value={form.assignedTo || undefined}
          onChange={(v) => setForm((f) => ({ ...f, assignedTo: v ?? null }))} options={userOptions(users)}
          popupClassName="pp-menu" placeholder="Who" />
        <Select value={form.stageKey || undefined} onChange={(v) => setForm((f) => ({ ...f, stageKey: v }))}
          options={data.stages.map((s) => ({ value: s.key, label: s.name }))} popupClassName="pp-menu" placeholder="Stage" />
        <Button type="primary" onClick={add} loading={busy === 'add'} disabled={!form.title.trim() || !form.dueDate}>Add task</Button>
      </div>
    </Card>
  )
}

// ── Add time (s13, s22) ────────────────────────────────────────────────

const HOUR_CHIPS = [0.25, 0.5, 1, 2, 4, 8]
const blankEntry = (meId) => ({ userId: meId || null, workerName: '', workDate: todayIso(), hours: 1, activity: null, notes: '' })

function JobTime({ kind, id, users, meId, activities, say, onChanged }) {
  const [state, setState] = useState({ loading: true, error: null, entries: [], summary: null })
  // The signed-in person by default — the design's "Gillian (you)".
  const [form, setForm] = useState(() => blankEntry(meId))
  const [editingId, setEditingId] = useState(null)
  const [who, setWho] = useState('everyone')
  const [busy, setBusy] = useState(false)

  const load = useCallback(() => {
    opsAPI.time(kind, id)
      .then((r) => setState({ loading: false, error: null, entries: r.entries || [], summary: r.summary }))
      .catch((err) => setState({ loading: false, error: err.message, entries: [], summary: null }))
  }, [kind, id])
  useEffect(() => { load() }, [load])

  const save = async () => {
    setBusy(true)
    try {
      const body = {
        workDate: form.workDate, hours: form.hours, activity: form.activity, notes: form.notes || null,
        ...(form.userId ? { userId: form.userId } : { workerName: form.workerName })
      }
      if (editingId) await opsAPI.updateTime(editingId, body)
      else await opsAPI.addTime(kind, id, body)
      say(editingId ? 'Time updated' : 'Time saved', 'done')
      setEditingId(null)
      setForm((f) => ({ ...blankEntry(f.userId), activity: f.activity }))
      load()
      onChanged?.()
    } catch (err) {
      say(err.message)
    } finally {
      setBusy(false)
    }
  }
  const edit = (e) => {
    setEditingId(e.id)
    setForm({ userId: e.userId, workerName: e.workerName || '', workDate: e.workDate, hours: e.hours, activity: e.activity, notes: e.notes || '' })
  }
  const remove = async (e) => {
    try { await opsAPI.removeTime(e.id); load(); onChanged?.() } catch (err) { say(err.message) }
  }

  const people = useMemo(() => [...new Set(state.entries.map((e) => e.who).filter(Boolean))], [state.entries])
  const shown = who === 'everyone' ? state.entries : state.entries.filter((e) => e.who === who)
  const total = shown.reduce((n, e) => n + e.hours, 0)
  const cols = '110px 140px 200px 70px minmax(0,1fr) 110px'
  const someoneElse = !form.userId

  return (
    <>
      <Card title={editingId ? 'Edit time' : 'Add time'} sub={`Log time against this ${kind}.`}>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, alignItems: 'end' }}>
          <label className="pp-ops-lbl" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Who did the work
            <Select showSearch optionFilterProp="label" value={form.userId || '__other'}
              onChange={(v) => setForm((f) => ({ ...f, userId: v === '__other' ? null : v }))}
              options={[...userOptions(users), { value: '__other', label: 'Someone else (fitter, subbie)…' }]}
              popupClassName="pp-menu" placeholder="Choose" />
          </label>
          {someoneElse && (
            <label className="pp-ops-lbl" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Their name
              <Input value={form.workerName} onChange={(e) => setForm((f) => ({ ...f, workerName: e.target.value }))} placeholder="e.g. Fitter 2" />
            </label>
          )}
          <label className="pp-ops-lbl" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Date
            <DatePicker value={dateValue(form.workDate)} onChange={(v) => setForm((f) => ({ ...f, workDate: isoOf(v) }))}
              format="ddd D MMM" allowClear={false} />
          </label>
          <label className="pp-ops-lbl" style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>Activity
            <Select value={form.activity || undefined} onChange={(v) => setForm((f) => ({ ...f, activity: v }))}
              options={activities.map((a) => ({ value: a, label: a }))} popupClassName="pp-menu" placeholder="Choose" />
          </label>
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
          <span className="pp-ops-lbl" style={{ margin: 0 }}>Hours</span>
          {HOUR_CHIPS.map((h) => (
            <FilterChip key={h} label={h === 8 ? 'Full day' : String(h)} active={form.hours === h} onClick={() => setForm((f) => ({ ...f, hours: h }))} />
          ))}
          <InputNumber min={0.25} max={24} step={0.25} value={form.hours} onChange={(v) => setForm((f) => ({ ...f, hours: v }))} style={{ width: 80 }} />
          <Input value={form.notes} onChange={(e) => setForm((f) => ({ ...f, notes: e.target.value }))}
            placeholder="Notes (optional), e.g. chased Sonas for the seal" style={{ flex: 1, minWidth: 220 }} />
          {editingId && <Button onClick={() => { setEditingId(null); setForm(blankEntry(form.userId)) }}>Cancel</Button>}
          <Button type="primary" loading={busy} onClick={save}
            disabled={!form.activity || !form.hours || !form.workDate || (someoneElse && !form.workerName.trim())}>
            {editingId ? 'Save changes' : 'Save time'}
          </Button>
        </div>
      </Card>
      <Card title={`Time logged on this ${kind}`} sub="Every entry, newest first."
        actions={(
          <>
            <FilterChip label="Everyone" active={who === 'everyone'} onClick={() => setWho('everyone')} />
            {people.map((p) => <FilterChip key={p} label={p} active={who === p} onClick={() => setWho(p)} />)}
          </>
        )}>
        <StateMessage loading={state.loading} error={state.error}
          empty={!state.loading && !state.error && state.entries.length === 0} emptyText="No time logged yet." />
        {state.summary && state.entries.length > 0 && (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(160px, 1fr))', gap: 12 }}>
            {[
              ['Total logged', `${state.summary.total} hrs`],
              ['This week', `${state.summary.thisWeek} hrs`],
              ['Biggest activity', state.summary.biggest ? `${state.summary.biggest.activity} · ${state.summary.biggest.hours}` : '–']
            ].map(([l, v]) => (
              <div key={l} style={{ background: '#F7F8FA', border: '1px solid #ECEEF2', borderRadius: 10, padding: 12 }}>
                <span className="pp-ops-lbl">{l}</span>
                <b style={{ display: 'block', fontSize: 18, marginTop: 2 }}>{v}</b>
              </div>
            ))}
          </div>
        )}
        {shown.length > 0 && (
          <div style={{ overflowX: 'auto' }}>
            <div style={{ minWidth: 760 }}>
              <div className="pp-ops-row head" style={{ gridTemplateColumns: cols }}>
                <span>Date</span><span>Who</span><span>Activity</span><span>Hours</span><span>Notes</span><span />
              </div>
              {shown.map((e) => (
                <div key={e.id} className="pp-ops-row" style={{ gridTemplateColumns: cols }}>
                  <span>{dayjs(e.workDate).format('ddd D MMM')}</span>
                  <span>{e.who || '–'}</span>
                  <span>{e.activity}</span>
                  <span><b>{e.hours}</b></span>
                  <span style={{ overflowWrap: 'anywhere' }}>{e.notes || ''}</span>
                  <span style={{ display: 'flex', gap: 8 }}>
                    <button type="button" className="pp-ops-link" onClick={() => edit(e)}>Edit</button>
                    <button type="button" className="pp-ops-link" onClick={() => remove(e)}>Remove</button>
                  </span>
                </div>
              ))}
              <div className="pp-ops-row" style={{ gridTemplateColumns: cols, fontWeight: 700, borderTop: '2px solid #D5D9E0' }}>
                <span>Total</span><span /><span /><span>{total}</span><span /><span />
              </div>
            </div>
          </div>
        )}
      </Card>
    </>
  )
}
