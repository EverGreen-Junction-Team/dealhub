import React, { useEffect, useState } from 'react'
import { Switch } from 'antd'
import SectionCard from './SectionCard'
import { opsAPI, OPS_ENABLED_EVENT } from '../../api/operations'

// Operations Hub, switched on per sub-account (migration 147).
//
// Shown only when the build has the feature (VITE_FEATURE_OPERATIONS). Turning
// it on here shows the Operations menu and Home section for everyone in this
// sub-account, and lets the server answer the /api/ops routes; turning it off
// hides them again and keeps everything already entered.
export default function OperationsSection() {
  const [enabled, setEnabled] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)

  useEffect(() => {
    opsAPI.enabled().then((r) => setEnabled(r?.enabled === true)).catch((err) => setError(err.message))
  }, [])

  const change = async (next) => {
    setSaving(true)
    setError(null)
    try {
      const r = await opsAPI.setEnabled(next)
      setEnabled(r.enabled)
      // The shell's menu and Home follow without a reload.
      window.dispatchEvent(new CustomEvent(OPS_ENABLED_EVENT, { detail: r.enabled }))
    } catch (err) {
      setError(err.message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <SectionCard
      icon="engineering"
      title="Operations Hub"
      accent="pine"
      help="Projects, remedials and fitting after a deal is won. For this sub-account only."
    >
      <label style={{ display: 'flex', alignItems: 'center', gap: 12, fontSize: 'var(--text-md)', color: 'var(--text-body)' }}>
        <Switch checked={enabled === true} loading={enabled === null || saving} disabled={enabled === null}
          onChange={change} aria-label="Show the Operations Hub for this sub-account" />
        <span>
          {enabled
            ? 'On — everyone in this sub-account sees the Operations menu.'
            : 'Off — the Operations menu is hidden in this sub-account.'}
        </span>
      </label>
      <p style={{ margin: '8px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
        Turning it off hides it again and keeps everything already entered. Nothing changes in your CRM either way.
      </p>
      {error && <p style={{ margin: '8px 0 0', color: 'var(--status-stuck)', fontSize: 'var(--text-sm)' }}>{error}</p>}
    </SectionCard>
  )
}
