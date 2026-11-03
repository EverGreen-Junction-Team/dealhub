import React, { useEffect, useRef, useState } from 'react'
import { controlAPI } from '../../api/control'
import MeddicMappingSection from '../control/MeddicMappingSection'
import SkillsSection from '../control/SkillsSection'
import SectionCard, { PrimaryButton, GhostButton } from '../control/SectionCard'
import SyncButton from '../shared/SyncButton'
import { Bar, SkeletonStyles, formatDate, Panel } from '../shared/ListChrome'

// Control panel — v5.
//
// One markdown file of business context per sub-account, plus the read-only
// Qualification headings from GHL's own custom fields.
//
// v5 retired the four-section Control centre (tone samples, products table,
// MEDDIC descriptions, business info textarea). The file replaces all of it:
// no schema, the business writes whatever it wants the agent to know.
//
// The file lives in Postgres, not on the VM's filesystem — it has to survive a
// restart or a redeploy, or the agent silently loses its grounding and nobody
// notices until an answer goes generic.

const RichEditor = React.lazy(() => import('../shared/RichEditor'))

export default function ControlCentreTab() {
  const [data, setData] = useState(null)
  const [error, setError] = useState(null)

  useEffect(() => {
    let alive = true
    controlAPI.get()
      .then((d) => alive && setData(d))
      .catch((err) => alive && setError(err.message || 'Failed to load the control panel'))
    return () => { alive = false }
  }, [])

  if (error) {
    return (
      <Shell>
        <p
          style={{
            margin: 0, padding: 16,
            borderLeft: '3px solid var(--status-stuck)',
            borderRadius: 'var(--radius-md)',
            background: 'var(--tint-rose)', color: 'var(--status-stuck)',
            fontSize: 'var(--text-md)'
          }}
        >
          {error}
        </p>
      </Shell>
    )
  }

  if (!data) {
    return (
      <Shell>
        <SkeletonStyles />
        {[300, 200].map((h, i) => (
          <div
            key={i}
            style={{
              border: '2px solid var(--gray-200)',
              borderRadius: 'var(--radius-md)',
              background: '#fff', overflow: 'hidden'
            }}
          >
            <div
              style={{
                display: 'flex', gap: 9, padding: 'var(--space-3) var(--space-4)', alignItems: 'center'
              }}
            >
              <Bar w={20} h={20} style={{ flex: 'none' }} />
              <Bar w={160} h={15} />
            </div>
            <div style={{ padding: 16, display: 'grid', gap: 10 }}>
              <Bar w="100%" h={h / 4} r="var(--radius-md)" />
              <Bar w="80%" h={13} />
            </div>
          </div>
        ))}
      </Shell>
    )
  }

  return (
    <Shell>
      {/* First: it belongs to the rep reading the page, where everything
          below is account-wide configuration. */}
      <SignatureSection />
      <BusinessContextSection
        file={data.businessContext}
        onSaved={(businessContext) => setData((d) => ({ ...d, businessContext }))}
      />
      {/* Sits next to business context because the two are the same kind of
          thing: what the AI knows. Qualification mapping below is a different
          job — how a deal is scored.

          Loads its own data: skills change far more often than the page's
          other sections, and a rep toggling one should not refetch the
          qualification headings and the whole business-context preview. */}
      <SkillsSection />

      <MeddicMappingSection fields={data.meddicFields || []} />
      {/* Last of the configuration sections: it is maintenance rather than
          something to set up, and nobody comes to this page to press it
          first. */}
      <CatalogueSyncSection />
      <Footnote />
    </Shell>
  )
}

function Shell({ children }) {
  return (
    // Full width, like every other tab. The 1100px cap left a third of a wide
    // screen empty for a page whose main content is a two-column table of
    // qualification headings — the width is exactly what it needed.
    //
    // THE SHARED SOLID HEADER BAND (Oct 2026), like Deals, Businesses and
    // Tasks, with the sections on one grey ground inside it. It was a plain
    // title row, still subtitled "One markdown file of business context —
    // this is the entire control panel in v1" long after the page grew to
    // five sections.
    <div style={{ width: '100%', padding: 'var(--space-3) 20px var(--space-7)', boxSizing: 'border-box' }}>
      <Panel icon="tune" title="Control panel" accent="teal" solidHeader>
        <div style={{
          display: 'grid', gap: 18,
          padding: 'var(--space-3)',
          background: 'var(--gray-100)'
        }}>
          {children}
        </div>
      </Panel>
    </div>
  )
}

// ── Business context ──────────────────────────────────────────────────

// Text formats only. A PDF read as text is mojibake, and the agent would be
// grounded in noise rather than failing visibly.
const ACCEPT = '.md,.markdown,.txt,text/markdown,text/plain'

function isReadableAsText(file) {
  if (file.type.startsWith('text/')) return true
  return /\.(md|markdown|txt)$/i.test(file.name)
}

function BusinessContextSection({ file, onSaved }) {
  const [state, setState] = useState('idle')
  const [error, setError] = useState(null)
  const inputRef = useRef(null)

  const upload = async (fileList) => {
    const picked = Array.from(fileList || [])[0]
    if (!picked) return
    if (!isReadableAsText(picked)) {
      setError('Markdown or plain text only — a PDF cannot be read as text')
      setState('error')
      return
    }

    setState('saving')
    setError(null)
    try {
      const content = await picked.text()
      if (!content.trim()) {
        setError('That file is empty')
        setState('error')
        return
      }
      const res = await controlAPI.saveBusinessContext(content, picked.name)
      onSaved(res.businessContext)
      setState('saved')
      window.setTimeout(() => setState('idle'), 2500)
    } catch (err) {
      setError(err.message || 'Could not save the file')
      setState('error')
    } finally {
      if (inputRef.current) inputRef.current.value = ''
    }
  }

  return (
    <SectionCard
      icon="description"
      title="Business context"
      collapsible
      accent="sky"
      meta="One file per sub-account"
      help="Whatever the business wants the agent to know — products, lead times, how it operates, tone, objection answers — written however you like. No schema. The agent reads this file at the start of every conversation."
    >
      {file ? (
        <div
          style={{
            display: 'flex', alignItems: 'center', gap: 'var(--space-3)', flexWrap: 'wrap',
            padding: 'var(--space-3) var(--space-4)',
            borderBottom: '1px solid var(--border-default)'
          }}
        >
          <span
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 34, height: 34, flex: 'none',
              borderRadius: 'var(--radius-sm)',
              background: 'var(--tint-sky)', color: 'var(--accent-sky-text)',
              fontFamily: 'var(--font-mono)', fontSize: 'var(--text-xs)', fontWeight: 600
            }}
          >
            md
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span
              style={{
                display: 'block',
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-md)',
                color: 'var(--text-heading)'
              }}
            >
              {file.filename}
            </span>
            <span style={{ display: 'block', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
              {[
                formatSize(file.sizeBytes),
                file.uploadedAt ? `Uploaded ${formatDate(file.uploadedAt)}` : null,
                replacedLabel(file.replaceCount)
              ].filter(Boolean).join(' · ')}
            </span>
          </span>

          <PrimaryButton
            icon="upload"
            onClick={() => inputRef.current?.click()}
            disabled={state === 'saving'}
          >
            {state === 'saving' ? 'Uploading…' : 'Replace file'}
          </PrimaryButton>
          <GhostButton
            icon="download"
            onClick={() => controlAPI.downloadBusinessContext()}
          >
            Download
          </GhostButton>
        </div>
      ) : (
        <div style={{ padding: 16, display: 'grid', gap: 'var(--space-3)', justifyItems: 'start' }}>
          <p
            style={{
              margin: 0, fontSize: 'var(--text-md)', lineHeight: 1.55, color: 'var(--text-muted)'
            }}
          >
            No file yet. Until one is uploaded the agent answers from the deal's
            messages alone — it knows nothing about your products, lead times or
            how you work.
          </p>
          <PrimaryButton
            icon="upload"
            onClick={() => inputRef.current?.click()}
            disabled={state === 'saving'}
          >
            {state === 'saving' ? 'Uploading…' : 'Upload file'}
          </PrimaryButton>
        </div>
      )}

      <input
        ref={inputRef}
        type="file"
        accept={ACCEPT}
        onChange={(e) => upload(e.target.files)}
        style={{ display: 'none' }}
      />

      {(state === 'error' || state === 'saved') && (
        <p
          style={{
            margin: 0, padding: '10px var(--space-4)',
            borderBottom: '1px solid var(--border-default)',
            background: state === 'error' ? 'var(--tint-rose)' : 'var(--tint-pine)',
            fontSize: 'var(--text-base)',
            color: state === 'error' ? 'var(--status-stuck)' : 'var(--green-600)'
          }}
        >
          {state === 'error'
            ? error
            : 'Saved — the agent uses this from its next answer.'}
        </p>
      )}

      {file?.preview && (
        <div style={{ padding: 'var(--space-3) var(--space-4)' }}>
          <span
            style={{
              display: 'block', marginBottom: 7,
              fontSize: 'var(--text-xs)', fontWeight: 600, letterSpacing: 'var(--tracking-label)',
              textTransform: 'uppercase', color: 'var(--text-muted)'
            }}
          >
            Preview
          </span>
          <pre
            style={{
              margin: 0, maxHeight: 300, overflow: 'auto',
              padding: 'var(--space-3) 14px',
              borderRadius: 'var(--radius-md)',
              background: 'var(--gray-50)',
              fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)', lineHeight: 1.6,
              color: 'var(--text-body)',
              whiteSpace: 'pre-wrap', overflowWrap: 'anywhere'
            }}
          >
            {file.preview}
          </pre>
          {/* Say the preview is partial — otherwise it reads as the whole file. */}
          {file.truncated && (
            <p style={{ margin: '6px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
              First 2,000 characters — download the file to read all of it.
            </p>
          )}
        </div>
      )}
    </SectionCard>
  )
}

// The design's closing note. Worth keeping: it sets the expectation that the
// agent doesn't learn, so what it knows is exactly what's in this file.
// A rep's email sign-off, used on every email the AI drafts for them.
//
// WHY IT LIVES HERE AND NOT IN THE COMPOSER. A signature is written once and
// changed rarely; the composer is where it is USED. Putting the editor on the
// composer would ask a rep to re-check it on every email, which is how a
// signature ends up half-deleted.
function SignatureSection() {
  const [html, setHtml] = useState(null)      // null while loading
  const [saved, setSaved] = useState('')      // what the server last stored
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState(null)
  const [note, setNote] = useState(null)

  useEffect(() => {
    let alive = true
    controlAPI.getSignature()
      .then((r) => { if (!alive) return; const v = r?.signature?.html || ''; setHtml(v); setSaved(v) })
      .catch((err) => alive && setError(err.message || 'Could not load your signature'))
    return () => { alive = false }
  }, [])

  const dirty = html !== null && html !== saved

  async function save() {
    setBusy(true); setError(null); setNote(null)
    try {
      const r = await controlAPI.saveSignature(html || '')
      // The SERVER's version, not ours — it sanitises on save, so a signature
      // pasted from Outlook comes back without the table markup. Showing what
      // was actually stored means a rep finds that out here rather than when
      // an email looks different from the draft.
      const stored = r?.signature?.html || ''
      setHtml(stored); setSaved(stored)
      setNote(stored ? 'Saved' : 'Signature removed')
    } catch (err) {
      setError(err.message || 'Could not save your signature')
    } finally {
      setBusy(false)
    }
  }

  return (
    <SectionCard
      icon="signature"
      title="Your email signature"
      accent="plum"
      meta="Yours only, in this sub-account"
      // Folds like the others, but starts OPEN — it is the one section a rep
      // comes here to change.
      collapsible
      defaultOpen
      help="Added to the end of every email the AI drafts for you, where you can still edit or trim it before sending. Paste yours from Outlook or write one here. Working in more than one brand? Each has its own — set it there too."
    >
      <div style={{ padding: 'var(--space-4)', display: 'grid', gap: 'var(--space-3)' }}>
        {html === null ? (
          <div style={{
            minHeight: 140, borderRadius: 'var(--radius-sm)', background: 'var(--gray-50)'
          }} />
        ) : (
          <React.Suspense fallback={<div style={{ minHeight: 140 }} />}>
            <RichEditor
              value={html}
              onChange={setHtml}
              // Empty, not omitted: the prop defaults to "Write a note…",
              // which is wrong here and worse than no placeholder at all.
              // A signature is the rep's own, and a worked example in the
              // box reads as a house style to copy rather than a hint.
              placeholder=""
              minHeight={140}
              disabled={busy}
              // The one place rich mode is on: a signature is branded layout,
              // not prose, so colour and a logo are the content rather than
              // decoration. Notes and tasks keep the plain toolbar.
              rich
            />
          </React.Suspense>
        )}

        {error && (
          <p style={{
            margin: 0, padding: '7px 10px', borderRadius: 'var(--radius-sm)',
            background: 'var(--tint-rose)', color: 'var(--status-stuck-text)',
            fontSize: 'var(--text-base)'
          }}>
            {error}
          </p>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 'var(--space-3)' }}>
          <button
            type="button"
            onClick={save}
            disabled={busy || !dirty}
            style={{
              height: 34, padding: '0 14px', border: 'none',
              borderRadius: 'var(--radius-md)',
              background: (busy || !dirty) ? 'var(--gray-200)' : 'var(--brand-primary)',
              color: (busy || !dirty) ? 'var(--text-faint)' : '#fff',
              fontFamily: 'var(--font-sans)', fontSize: 'var(--text-md)', fontWeight: 600,
              cursor: (busy || !dirty) ? 'default' : 'pointer'
            }}
          >
            {busy ? 'Saving…' : 'Save signature'}
          </button>
          {/* Deliberately not a separate Delete button: clearing the box and
              saving removes it, which is one concept rather than two. */}
          <span style={{ fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
            {note || (dirty ? 'Unsaved changes' : 'Clear the box and save to remove it')}
          </span>
        </div>
      </div>
    </SectionCard>
  )
}


// ── Catalogue sync ────────────────────────────────────────────────────
//
// The three things GHL sends NO webhook for. Nothing arrives when a business,
// a tag or a custom field is created, renamed or deleted — they are picked up
// only by the 3am reconciliation, so a field added this morning is missing
// from every dropdown until tomorrow.
//
// That is the right trade for a catalogue (polling three endpoints per
// sub-account on every change would be far more traffic than it is worth) but
// it leaves one bad moment: somebody adds a field in the CRM, comes here to
// use it, and it is not there. These buttons are for that moment.
//
// Each is scoped to the current sub-account. The nightly job still runs for
// everyone; this is the same work, now, for one tenant.
function CatalogueSyncSection() {
  const ROWS = [
    { kind: 'businesses', title: 'Businesses',
      noun: 'businesses',
      help: 'Companies and their details — name, address, website, logo. A business deleted in your CRM is kept here and marked inactive, because contacts still point at it.' },
    { kind: 'tags', title: 'Tags',
      noun: 'tags',
      help: 'The tag list itself. Tags ON a contact arrive with the contact; this is the catalogue of what exists.' },
    { kind: 'customFields', title: 'Custom fields',
      noun: 'fields',
      help: 'Field definitions for contacts and opportunities — names, types and picklist options. The values on each record arrive with the record.' },
    { kind: 'users', title: 'Users',
      noun: 'users',
      help: 'Everyone on this sub-account — role, agency or account type, which sub-accounts they belong to, and any two-way email sync. Runs nightly; run it now after changing a rep\'s role or connecting their mailbox in your CRM.' },
    { kind: 'deals', title: 'Deals',
      noun: 'deals',
      help: 'Every opportunity in your CRM, refreshed from the source, and any deal your CRM no longer has is marked deleted here. Deals normally arrive by webhook; run this when one was deleted or changed in your CRM and still shows the old state here.' }
  ]

  return (
    <SectionCard
      icon="sync"
      title="Sync from your CRM"
      collapsible
      accent="teal"
      meta="Runs for this sub-account"
      help="Most of these arrive by no webhook — your CRM does not tell us when one changes — so they refresh overnight. Press a button here to fetch them now, if you have just added something and want to use it straight away."
    >
      <div style={{ display: 'grid' }}>
        {ROWS.map((r, i) => (
          <div
            key={r.kind}
            style={{
              display: 'flex', alignItems: 'flex-start', gap: 'var(--space-4)',
              flexWrap: 'wrap',
              padding: 'var(--space-3) var(--space-4)',
              borderBottom: i === ROWS.length - 1 ? 'none' : '1px solid var(--border-default)'
            }}
          >
            <div style={{ flex: 1, minWidth: 220 }}>
              <div style={{ fontSize: 'var(--text-md)', fontWeight: 600, color: 'var(--text-heading)' }}>
                {r.title}
              </div>
              <p style={{ margin: '3px 0 0', fontSize: 'var(--text-base)', lineHeight: 1.5, color: 'var(--text-muted)' }}>
                {r.help}
              </p>
            </div>
            <SyncButton kind={r.kind} label="Sync now" noun={r.noun} />
          </div>
        ))}
      </div>
    </SectionCard>
  )
}

function Footnote() {
  return (
    <p
      style={{
        margin: 0, padding: '14px var(--space-4)',
        borderRadius: 'var(--radius-md)',
        background: 'var(--gray-50)',
        fontSize: 'var(--text-md)', lineHeight: 1.55, color: 'var(--text-body)'
      }}
    >
      The agent runs with fixed guardrails and is not self-learning. This file —
      with the messages on each deal and the deal's own fields — is everything an
      answer is grounded in.
    </p>
  )
}

function formatSize(bytes) {
  if (!bytes) return null
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function replacedLabel(n) {
  if (!n) return null
  if (n === 1) return 'replaced once'
  if (n === 2) return 'replaced twice'
  return `replaced ${n} times`
}
