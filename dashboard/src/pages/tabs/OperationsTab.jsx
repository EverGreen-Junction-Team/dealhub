import React, { useCallback, useEffect, useState } from 'react'
import { Button } from 'antd'
import { opsAPI } from '../../api/operations'
import { dealsAPI } from '../../api/deals'
import { businessesAPI } from '../../api/businesses'
import { useAuth } from '../../context/AuthContext'
import { Shell, StateMessage } from '../shared/ListChrome'
import { OpsStyles, Card } from '../operations/opsUi'
import { PipelineBoard, JobList, LogRemedial, OpsTasks, SetUp } from '../operations/OpsViews'
import JobPage from '../operations/JobPage'

// Operations Hub — after the deal is won: projects, remedials and fitting.
// Slice 1 of docs/operations-hub-plan.md, behind VITE_FEATURE_OPERATIONS.
//
// One tab component for the operations menu, switched by `view` (the shell's
// tab id). A job page opens over whichever list it was opened from, and the
// "Projects" / "Remedials" crumb goes back to that list.

const TITLES = {
  opsPipeline: 'Pipeline',
  opsProjects: 'Projects',
  opsRemedials: 'Remedials',
  opsTasks: 'Tasks',
  opsSetup: 'Set up'
}

export default function OperationsTab({ view = 'opsPipeline', onNavigate }) {
  const { session } = useAuth()
  const meId = session?.user?.id || null
  const [refs, setRefs] = useState({ users: [], businesses: [] })
  const [decisions, setDecisions] = useState(null)
  const [connection, setConnection] = useState({ loading: true, error: null, connected: false })
  const [open, setOpen] = useState(null)
  const [boardKind, setBoardKind] = useState('project')
  const [logging, setLogging] = useState(false)
  const [toast, setToast] = useState(null)

  const say = useCallback((text, tone = 'error') => {
    setToast({ text, tone })
    window.setTimeout(() => setToast((t) => (t && t.text === text ? null : t)), tone === 'done' ? 3500 : 6000)
  }, [])

  const checkConnection = useCallback(() => {
    opsAPI.settings()
      .then((s) => setConnection({ loading: false, error: null, connected: Boolean(s.operationsPipelineId && s.remedialsPipelineId) }))
      .catch((err) => setConnection({ loading: false, error: err.message, connected: false }))
  }, [])

  useEffect(() => {
    checkConnection()
    opsAPI.decisions().then(setDecisions).catch(() => {})
    Promise.all([
      dealsAPI.users().catch(() => null),
      businessesAPI.list({ limit: 50 }).catch(() => null)
    ]).then(([u, b]) => setRefs({ users: u?.users || [], businesses: b?.businesses || [] }))
  }, [checkConnection])

  // A different menu item closes the job page.
  useEffect(() => { setOpen(null); setLogging(false) }, [view])

  const openJob = (j) => setOpen({ kind: j.kind, id: j.id })

  let body
  if (open) {
    body = (
      <JobPage kind={open.kind} id={open.id} users={refs.users} businesses={refs.businesses} meId={meId}
        onOpen={openJob} onBack={() => setOpen(null)} say={say} />
    )
  } else if (view === 'opsSetup') {
    body = <SetUp decisions={decisions} onSaved={checkConnection} />
  } else if (connection.loading) {
    body = <StateMessage loading />
  } else if (connection.error) {
    body = <StateMessage error={connection.error} />
  } else if (!connection.connected) {
    body = (
      <Card title="Connect the Operations and Remedials pipelines first"
        sub="Projects and remedials are deals in two pipelines in your CRM. Tell Deal Hub which pipelines they are and everything here fills in."
        actions={<Button type="primary" onClick={() => onNavigate?.('opsSetup')}>Set up</Button>} />
    )
  } else if (view === 'opsProjects') {
    body = <JobList kind="project" decisions={decisions} onOpen={openJob} />
  } else if (view === 'opsRemedials') {
    body = (
      <>
        {logging && (
          <LogRemedial onClose={() => setLogging(false)}
            onLogged={() => { setLogging(false); say('Remedial logged — it appears in a moment, once your CRM confirms it', 'done') }} />
        )}
        <JobList kind="remedial" decisions={decisions} onOpen={openJob} onLogRemedial={() => setLogging(true)} />
      </>
    )
  } else if (view === 'opsTasks') {
    body = <OpsTasks meId={meId} onOpen={openJob} />
  } else {
    body = <PipelineBoard kind={boardKind} onKindChange={setBoardKind} onOpen={openJob} />
  }

  return (
    <Shell maxWidth={1440}>
      <OpsStyles />
      {!open && (
        <header style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'space-between', alignItems: 'flex-end', gap: 12 }}>
          <div>
            <p className="pp-ops-sub">Operations hub</p>
            <h1 style={{ margin: '2px 0 0', fontSize: 'var(--text-2xl)', fontWeight: 700, color: 'var(--text-heading)' }}>
              {TITLES[view] || 'Pipeline'}
            </h1>
          </div>
          {view !== 'opsSetup' && (
            <Button onClick={() => onNavigate?.('opsSetup')}>Set up</Button>
          )}
        </header>
      )}
      {body}
      {toast && (
        <div role="status" style={{
          position: 'fixed', bottom: 20, right: 20, zIndex: 40, maxWidth: 420,
          padding: '10px 14px', borderRadius: 'var(--radius-md)', background: '#fff',
          border: `1px solid ${toast.tone === 'done' ? 'var(--status-done)' : 'var(--status-stuck)'}`,
          boxShadow: 'var(--shadow-overlay)', fontSize: 'var(--text-md)', color: 'var(--text-heading)'
        }}>
          {toast.text}
        </div>
      )}
    </Shell>
  )
}
