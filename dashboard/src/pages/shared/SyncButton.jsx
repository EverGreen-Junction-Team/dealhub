import React, { useState } from 'react'
import { controlAPI } from '../../api/control'
import { Truncate } from './ListChrome'

// Pull a catalogue from GHL now, rather than waiting for the 3am run.
//
// ── WHY ──────────────────────────────────────────────────────────────
//
// Businesses, tags and custom field definitions arrive by NO webhook. GHL
// fires nothing when one is created, renamed or deleted, so they land only
// on the nightly reconciliation. A business made at 09:00 is invisible here
// until the next morning — correct for a catalogue, wrong for the person who
// just made it and has come looking.
//
// ── WHAT IT REPORTS ──────────────────────────────────────────────────
//
// The count, not just "done". "Synced" leaves a reader wondering whether it
// actually found their new business; "6 businesses" answers it. A run that
// changed nothing says so rather than staying silent, because silence after
// pressing a button reads as a failure.
//
// The result is held until dismissed rather than fading: a rep who presses
// this and looks away must still be able to see what happened.
export default function SyncButton({
  kind,
  label = 'Sync',
  // What the counts are OF, for the result line: "6 businesses".
  noun = 'records',
  // Called after a successful run so the caller can reload its list — the
  // numbers are stale the moment the sync writes.
  onSynced,
  compact = false
}) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState(null)

  const run = async () => {
    if (busy) return
    setBusy(true)
    setError(null)
    setResult(null)
    try {
      const r = await controlAPI.runSync(kind)
      // `synced` is what every sync service returns; `deactivated` only comes
      // back from businesses, where a row that vanished from GHL is marked
      // inactive rather than deleted.
      setResult({
        synced: r?.synced ?? 0,
        deactivated: r?.deactivated ?? 0
      })
      onSynced && onSynced(r)
    } catch (err) {
      setError(err.message || 'Could not sync — try again')
    } finally {
      setBusy(false)
    }
  }

  return (
    <span style={{ display: 'inline-flex', alignItems: 'center', gap: 'var(--space-2)', minWidth: 0 }}>
      <button
        onClick={run}
        disabled={busy}
        title={`Fetch ${noun} from your CRM now, instead of waiting for the nightly sync`}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 6, flex: 'none',
          height: compact ? 30 : 34, padding: compact ? '0 11px' : '0 13px',
          border: '1px solid var(--border-strong)',
          borderRadius: 'var(--radius-md)',
          background: '#fff',
          fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-md)',
          color: busy ? 'var(--text-faint)' : 'var(--text-body)',
          cursor: busy ? 'default' : 'pointer'
        }}
      >
        {/* The icon spins while the request is in flight. These syncs page
            through a catalogue and can take a few seconds; without this the
            button looks dead and gets pressed again.

            The CLASS, not an inline animation: .pp-spin is already guarded by
            prefers-reduced-motion, and an inline rule would spin regardless of
            that setting. */}
        <span className={busy ? 'ms pp-spin' : 'ms'} style={{ fontSize: 16 }}>
          sync
        </span>
        {busy ? 'Syncing' : label}
      </button>

      {result && (
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0,
            fontSize: 'var(--text-base)', color: 'var(--green-600)'
          }}
        >
          <span className="ms" style={{ fontSize: 15 }}>check_circle</span>
          <Truncate>
            {`${result.synced} ${noun}${result.deactivated > 0
              ? `, ${result.deactivated} no longer in your CRM` : ''}`}
          </Truncate>
        </span>
      )}

      {error && (
        <span
          // Announced, not just coloured: a screen reader user gets no colour,
          // and this is the only report that the run failed.
          role="alert"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 5, minWidth: 0,
            fontSize: 'var(--text-base)', color: 'var(--status-stuck-text)'
          }}
        >
          <span className="ms" style={{ fontSize: 15 }}>error</span>
          <Truncate>{error}</Truncate>
        </span>
      )}
    </span>
  )
}
