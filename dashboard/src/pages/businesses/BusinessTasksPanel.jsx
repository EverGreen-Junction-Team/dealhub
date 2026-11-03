import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { tasksAPI } from '../../api/tasks'
import { Panel, Row, formatDue } from '../shared/ListChrome'
import TaskEditor from '../shared/TaskEditor'
import { useLinkTargets } from '../../hooks/useLinkTargets'

// A business's open TASKS — the Figma business detail (Oct 2026):
//
//   Tasks                                      2 open  [+ New task]
//   ○ Confirm site visit date with Mark                  [👤 Jordan Blake]
//     due 14 Oct · Yusuf Lala · Brighton Road
//
// LOADED BY BUSINESS (fallback: through its contacts). The task list cannot filter by business yet,
// but it can by contact, and a task in GHL always belongs to a contact — so
// this asks for each contact's open tasks and merges them. One request per
// contact on the business; a task linked to two of them is shown once.
// When the server grows a businessId filter, `load` becomes one request.

export default function BusinessTasksPanel({ businessId = null, contacts = [] }) {
  const [items, setItems] = useState(null)   // null = loading
  const [error, setError] = useState(null)
  const [saving, setSaving] = useState(() => new Set())
  const [failed, setFailed] = useState(null)
  const [editor, setEditor] = useState(false)
  const linkTargets = useLinkTargets(editor)

  const contactKey = contacts.map((c) => c.id).join(',')

  const load = useCallback(async () => {
    setError(null)
    try {
      // ONE REQUEST, by business: the server matches a task's own company
      // link (kept in our database — GHL refuses task relation writes over
      // OAuth) as well as its contact's company. So a task linked to this
      // business by hand shows here even when its contact works elsewhere.
      //
      // Trusted only when the server echoes the filter back: an older server
      // ignores ?businessId= and would return the whole account's tasks.
      if (businessId) {
        const r = await tasksAPI.list({ businessId, status: 'open', limit: 50 })
        if (r?.businessId === businessId) { setItems(r.tasks || []); return }
      }
      // Older server: through the contacts, as before.
      if (!contacts.length) { setItems([]); return }
      const pages = await Promise.all(
        contacts.map((c) => tasksAPI.list({ contactId: c.id, status: 'open', limit: 50 }))
      )
      const byId = new Map()
      for (const p of pages) for (const t of (p?.tasks || [])) byId.set(t.id, t)
      setItems([...byId.values()])
    } catch (e) {
      setError(e.message || 'Could not load tasks')
      setItems([])
    }
  // contactKey stands for `contacts`: the array is rebuilt on every render of
  // the detail, and refetching on identity alone would loop.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [businessId, contactKey])

  useEffect(() => { load() }, [load])

  // Soonest first; a task with no due date last — it isn't urgent, and
  // putting it above an overdue one buries what matters.
  const shown = useMemo(() => (items || []).slice().sort((a, b) => {
    if (!a.dueAt && !b.dueAt) return 0
    if (!a.dueAt) return 1
    if (!b.dueAt) return -1
    return new Date(a.dueAt) - new Date(b.dueAt)
  }), [items])
  const openCount = (items || []).filter((t) => t.status === 'open').length

  // Tick now, write, roll back on failure — the Deal hub rail's contract.
  const toggle = async (t) => {
    if (saving.has(t.id)) return
    const was = t.status
    const next = was === 'open'
    const patch = (status) => setItems((prev) => prev.map((x) => (x.id === t.id ? { ...x, status } : x)))
    setSaving((s) => new Set(s).add(t.id))
    setFailed(null)
    patch(next ? 'completed' : 'open')
    try {
      const { task } = await tasksAPI.setCompleted(t.id, next)
      patch(task?.completed === false ? 'open' : 'completed')
    } catch (e) {
      patch(was)
      setFailed(e.message || 'Could not save that — try again')
    } finally {
      setSaving((s) => { const n = new Set(s); n.delete(t.id); return n })
    }
  }

  return (
    <Panel
      icon="task_alt"
      title="Tasks"
      // Clay — the tasks colour on the Deal hub rail and the Tasks tab.
      accent="clay"
      meta={items === null ? null : `${openCount} open`}
      action={
        <button
          type="button"
          onClick={() => setEditor(true)}
          disabled={!contacts.length}
          title={contacts.length ? 'Add a task' : 'Link a contact first — a task is stored against a contact'}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 4,
            height: 28, padding: '0 11px 0 8px',
            border: '1px solid var(--border-strong)', borderRadius: 'var(--radius-pill)',
            background: 'var(--surface-card)',
            color: contacts.length ? 'var(--text-body)' : 'var(--text-faint)',
            fontFamily: 'var(--font-sans)', fontSize: 'var(--text-sm)',
            cursor: contacts.length ? 'pointer' : 'not-allowed'
          }}
        >
          <span className="ms" style={{ fontSize: 15 }}>add</span>
          New task
        </button>
      }
    >
      {items === null && (
        <p style={{ margin: 0, padding: '13px var(--space-4)', fontSize: 'var(--text-md)', color: 'var(--text-muted)' }}>
          Loading tasks…
        </p>
      )}
      {error && (
        <p style={{ margin: 0, padding: '13px var(--space-4)', fontSize: 'var(--text-md)', color: 'var(--status-stuck-text)' }}>
          {error}
        </p>
      )}
      {items && !error && shown.length === 0 && (
        <p style={{ margin: 0, padding: '13px var(--space-4)', fontSize: 'var(--text-md)', color: 'var(--text-faint)' }}>
          No open tasks for this business.
        </p>
      )}

      {shown.map((t, i) => {
        const done = t.status !== 'open'
        const meta = [formatDue(t.dueAt), t.contact?.name, t.deals?.[0]?.name].filter(Boolean).join(' · ')
        return (
          <Row key={t.id} last={i === shown.length - 1} align="center">
            <button
              type="button"
              onClick={() => toggle(t)}
              disabled={saving.has(t.id)}
              title={saving.has(t.id) ? 'Saving…' : done ? 'Reopen this task' : 'Mark complete'}
              style={{
                flex: 'none', width: 24, height: 24, padding: 0,
                border: 'none', background: 'none',
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                cursor: saving.has(t.id) ? 'progress' : 'pointer',
                color: done ? 'var(--status-done)' : t.overdue ? 'var(--status-stuck)' : 'var(--text-muted)'
              }}
            >
              <span className={done ? 'ms ms-fill' : 'ms'} style={{ fontSize: 22 }}>
                {done ? 'check_circle' : 'radio_button_unchecked'}
              </span>
            </button>
            <span style={{ flex: 1, minWidth: 0 }}>
              <span style={{
                display: 'block', fontSize: 'var(--text-md)', fontWeight: 600,
                color: 'var(--text-heading)',
                textDecoration: done ? 'line-through' : 'none'
              }}>
                {t.title || '(untitled task)'}
              </span>
              {meta && (
                <span style={{ display: 'block', fontSize: 'var(--text-base)', color: t.overdue && !done ? 'var(--status-stuck-text)' : 'var(--text-muted)' }}>
                  {meta}
                </span>
              )}
            </span>
            {/* Who it is ASSIGNED to — a person chip, or a dashed
                "Unassigned" so a task nobody owns is visible as such. */}
            {t.owner ? (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
                height: 24, padding: '0 9px',
                border: '1px solid var(--accent-sky)', borderRadius: 'var(--radius-pill)',
                fontSize: 'var(--text-base)', color: 'var(--accent-sky-text)'
              }}>
                <span className="ms" style={{ fontSize: 14 }}>person</span>
                {t.owner}
              </span>
            ) : (
              <span style={{
                display: 'inline-flex', alignItems: 'center', gap: 4, flex: 'none',
                height: 24, padding: '0 9px',
                border: '1px dashed var(--border-strong)', borderRadius: 'var(--radius-pill)',
                fontSize: 'var(--text-base)', color: 'var(--text-muted)'
              }}>
                <span className="ms" style={{ fontSize: 14 }}>person_off</span>
                Unassigned
              </span>
            )}
          </Row>
        )
      })}

      {failed && (
        <p role="alert" style={{
          margin: 0, padding: '9px var(--space-4)',
          borderTop: '1px solid var(--border-default)', background: 'var(--tint-rose)',
          fontSize: 'var(--text-sm)', color: 'var(--status-stuck-text)'
        }}>
          {failed}
        </p>
      )}

      {editor && (
        <TaskEditor
          task={null}
          contacts={contacts}
          defaultContactId={contacts.length === 1 ? contacts[0].id : null}
          // Made from this business's page, so it is linked to it — kept in
          // our database, and shown back here by the businessId filter.
          defaultBusinessId={businessId}
          deals={linkTargets.deals}
          businesses={linkTargets.businesses}
          onClose={() => setEditor(false)}
          // A new task reaches our database through the CRM's webhook, so wait
          // for it before refetching — an immediate reload beats it.
          onSaved={() => { window.setTimeout(load, 2500) }}
        />
      )}
    </Panel>
  )
}
