import React, { useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { Select } from 'antd'
import { controlAPI } from '../../api/control'
import { useAuth } from '../../context/AuthContext'
import SectionCard, { PrimaryButton, GhostButton } from './SectionCard'
import { Truncate } from '../shared/ListChrome'

// AI skills — point the AI at a database view.
//
// WHAT THIS IS FOR. Every answer today comes from SQL written into the app.
// A skill lets the data team's own views answer questions instead, without a
// deploy: name the view, say which columns can be filtered on, and the AI
// gains a new tool.
//
// WHAT IT DELIBERATELY IS NOT. There is no SQL box. A form that executes
// typed SQL is arbitrary query execution behind an HTTP endpoint, and no
// read-only role makes that comfortable. The view is written in a migration
// where it gets reviewed; this page points at it.
//
// THE FORM'S ONE REAL IDEA: check the view as soon as its name is entered,
// then drive every column picker from what actually came back. Nobody types a
// column name, so nobody mistypes one — and an unusable view (missing,
// a table, no security_invoker) is refused at the point of entry rather than
// inside a rep's question three weeks later.

const BLANK = {
  name: '', description: '', viewName: '',
  params: [], columns: [], orderBy: '', rowLimit: 50,
  // Insights AI only by DEFAULT — Deal AI is now a real choice (it runs the
  // same tool loop, so skillToolsFor(locationId, 'deal') serves it), but it
  // is left unticked. A portfolio skill reads across every deal, and most do;
  // turning that on for a single-deal chat by default would offer the model a
  // tool whose answer is about the wrong scope.
  surfaces: ['portfolio'], isEnabled: true
}

export default function SkillsSection() {
  const [skills, setSkills] = useState([])
  const [loading, setLoading] = useState(true)
  const [editing, setEditing] = useState(null)   // a skill, BLANK, or null
  // Every view a skill may point at. Fetched once for the section rather than
  // per-form: the list is the same for every skill, and refetching it each
  // time a row is opened would make the dropdown empty for a beat on a slow
  // connection — exactly when someone is reaching for it.
  const [views, setViews] = useState([])
  const [error, setError] = useState(null)

  // Skills are per sub-account, so everything here is too. Without this the
  // section kept the previous account's state on a switch: an empty list is
  // correct in a new account, but a half-filled form and a "this sub-account
  // already has a skill called X" error from the OLD one are not — they say
  // the opposite of what the list says, about a different account.
  const { session } = useAuth()
  const locationId = session?.locationId

  const load = () => controlAPI.listSkills()
    .then((r) => setSkills(r?.skills || []))
    .catch((e) => setError(e?.message || 'Could not load skills'))
    .finally(() => setLoading(false))

  useEffect(() => {
    // Clear first, then reload: a stale form or error belongs to the account
    // it came from.
    setEditing(null)
    setError(null)
    setSkills([])
    setViews([])
    setLoading(true)
    load()
    // The view catalogue is per-account too — a view exists in the database
    // the account's role can reach, so switching accounts must not leave the
    // previous one's names in the dropdown. A failure here is NOT surfaced as
    // an error: the dropdown falls back to free typing, which is what the
    // form did before it existed, so a skill can still be saved.
    controlAPI.listViews()
      .then((r) => setViews(r?.views || []))
      .catch(() => setViews([]))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [locationId])

  const enabled = skills.filter((s) => s.isEnabled).length

  return (
    <SectionCard
      icon="database"
      title="AI skills"
      collapsible
      accent="plum"
      // "0 of 0 active" is a count of nothing presented as a statistic. With no
      // skills the empty state below already says so; the meta slot stays empty.
      meta={loading || skills.length === 0 ? null : `${enabled} of ${skills.length} active`}
      help={
        'Point the AI at a database view and it becomes a tool it can use to answer '
        + 'questions — no deploy needed. The view itself is created by whoever owns the '
        + 'data; this page only says which ones the AI may read and how.'
      }
    >
      {/* SectionCard renders children with no padding of its own — each
          section pads its own body (see MeddicMappingSection). Without this
          the form ran flush to the card edges. */}
      <div style={{ padding: 'var(--space-3) var(--space-4)', display: 'grid', gap: 12 }}>
      {error && <Banner tone="error" onDismiss={() => setError(null)}>{error}</Banner>}

      {/* THE LIST STAYS. Editing used to REPLACE it — `editing ? form : list`
          — so clicking Edit on one of 56 skills emptied the page down to a
          single form, and the only way back to the others was Cancel. It read
          as though the skills had been deleted.

          Now the form opens in place of the row it belongs to, with every
          other skill still listed above and below it. The one being edited
          keeps its position, so you can see what you are editing and what it
          sits between. Adding appends the form to the end of the list. */}
      {loading ? (
        <Muted>Loading…</Muted>
      ) : skills.length === 0 && !editing ? (
        <Empty onAdd={() => setEditing(BLANK)} />
      ) : (
        <div style={{
          display: 'grid', gap: 10,
          // TWO COLUMNS, auto-collapsing to one. Stacked full-width, a skill's
          // card was a paragraph of model-facing prose and 56 of them were an
          // endless scroll. auto-fill with a 420px floor rather than a fixed
          // `1fr 1fr`: the control panel is also opened on a narrow window,
          // and two 300px columns of this text would be worse than one.
          gridTemplateColumns: 'repeat(auto-fill, minmax(420px, 1fr))',
          // Cards in a row match the tallest, so the action buttons line up
          // (see SkillRow's marginTop:auto).
          alignItems: 'stretch'
        }}>
          {skills.map((s) => (
            editing?.id === s.id ? (
              // Spans every column: the form is a full-width object, and
              // squeezed into one of two it would be unusable.
              <div key={s.id} style={{ gridColumn: '1 / -1' }}>
                <SkillForm
                  skill={editing}
                  views={views}
                  onCancel={() => setEditing(null)}
                  onSaved={() => { setEditing(null); load() }}
                />
              </div>
            ) : (
              <SkillRow
                key={s.id}
                skill={s}
                onEdit={() => setEditing(s)}
                onToggled={load}
                onDeleted={load}
                onError={setError}
              />
            )
          ))}
          {editing && !editing.id && (
            <div style={{ gridColumn: '1 / -1' }}>
              <SkillForm
                skill={editing}
                views={views}
                onCancel={() => setEditing(null)}
                onSaved={() => { setEditing(null); load() }}
              />
            </div>
          )}
        </div>
      )}
      {!editing && skills.length > 0 && (
        <div>
          <PrimaryButton onClick={() => setEditing(BLANK)}>Add a skill</PrimaryButton>
        </div>
      )}
      </div>
    </SectionCard>
  )
}

// ── One saved skill ──────────────────────────────────────────────────

// Everything about one skill, in full.
//
// The card can only show four lines of a description written for the model —
// the AI picks a tool almost entirely on that text, so it is long on purpose
// and the full wording is exactly what someone tuning a skill needs to read.
function SkillDetail({ skill, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  const row = (label, value) => (
    <div style={{ display: 'grid', gridTemplateColumns: '140px 1fr', gap: 12, alignItems: 'start' }}>
      <span style={{
        fontSize: 'var(--text-sm)', fontWeight: 600, color: 'var(--text-muted)',
        letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase'
      }}>
        {label}
      </span>
      <div style={{ minWidth: 0, fontSize: 'var(--text-base)', color: 'var(--text-body)' }}>
        {value}
      </div>
    </div>
  )

  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`skill_${skill.name}`}
      className="pp-portal"
      onMouseDown={(e) => { if (e.target === e.currentTarget) onClose() }}
      style={{
        position: 'fixed', inset: 0, zIndex: 920,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        background: 'rgba(15, 23, 42, 0.32)',
        backdropFilter: 'blur(4px)', WebkitBackdropFilter: 'blur(4px)',
        padding: 16
      }}
    >
      <div style={{
        width: 'min(760px, 100%)', maxHeight: '86vh',
        background: '#fff',
        borderRadius: 'var(--radius-lg)',
        boxShadow: 'var(--shadow-overlay)',
        display: 'grid', gridTemplateRows: 'auto 1fr',
        overflow: 'hidden'
      }}>
        <div style={{
          display: 'flex', alignItems: 'flex-start', gap: 12,
          padding: '18px 22px 14px',
          borderBottom: '1px solid var(--border-default)'
        }}>
          <div style={{ minWidth: 0, flex: 1 }}>
            <code style={{
              fontFamily: 'var(--font-mono)', fontSize: 'var(--text-lg)',
              fontWeight: 600, color: 'var(--text-heading)'
            }}>
              skill_{skill.name}
            </code>
            <div style={{ display: 'flex', gap: 6, marginTop: 6, flexWrap: 'wrap' }}>
              {skill.surfaces?.map((sf) => (
                <Pill key={sf} tone={sf === 'deal' ? 'gold' : 'plum'}>
                  {sf === 'deal' ? 'Deal AI' : 'Insights AI'}
                </Pill>
              ))}
              {!skill.isEnabled && <Pill tone="gray">Off</Pill>}
            </div>
          </div>
          <button
            onClick={onClose}
            aria-label="Close"
            style={{
              display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
              width: 30, height: 30, flex: 'none',
              border: 'none', borderRadius: 'var(--radius-sm)',
              background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer'
            }}
          >
            <span className="ms" style={{ fontSize: 19 }}>close</span>
          </button>
        </div>

        <div style={{ overflowY: 'auto', padding: '16px 22px 20px', display: 'grid', gap: 14 }}>
          {row('Database view', (
            <code style={{ fontFamily: 'var(--font-mono)', wordBreak: 'break-all' }}>
              {skill.viewName}
            </code>
          ))}
          {row('When to use it', (
            // Whitespace preserved: these are written as paragraphs and read
            // as one run-on block otherwise.
            <p style={{ margin: 0, whiteSpace: 'pre-wrap', lineHeight: 'var(--leading-normal)' }}>
              {skill.description}
            </p>
          ))}
          {skill.params?.length > 0 && row('Filters', (
            <div style={{ display: 'grid', gap: 6 }}>
              {skill.params.map((prm) => (
                <div key={prm.name}>
                  <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>
                    {prm.name}
                  </code>
                  {prm.description && (
                    <span style={{ color: 'var(--text-muted)', fontSize: 'var(--text-sm)' }}>
                      {' — '}{prm.description}
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
          {skill.orderBy && row('Sorted by', (
            <code style={{ fontFamily: 'var(--font-mono)', fontSize: 'var(--text-sm)' }}>
              {skill.orderBy}
            </code>
          ))}
          {row('Most rows', String(skill.rowLimit ?? 50))}
          {row('Times used', skill.useCount > 0
            ? `${skill.useCount}×`
            : 'Never — usually a sign the description needs work')}
        </div>
      </div>
    </div>,
    document.body
  )
}

function SkillRow({ skill, onEdit, onToggled, onDeleted, onError }) {
  const [busy, setBusy] = useState(false)
  const [confirming, setConfirming] = useState(false)
  const [showing, setShowing] = useState(false)

  const toggle = async () => {
    setBusy(true)
    try {
      await controlAPI.updateSkill(skill.id, { isEnabled: !skill.isEnabled })
      onToggled()
    } catch (e) {
      onError(e?.message || 'Could not change that skill')
    } finally { setBusy(false) }
  }

  const remove = async () => {
    setBusy(true)
    try {
      await controlAPI.deleteSkill(skill.id)
      onDeleted()
    } catch (e) {
      onError(e?.message || 'Could not delete that skill')
      setBusy(false)
    }
  }

  return (
    <div
      style={{
        border: '1px solid var(--border-default)',
        borderRadius: 'var(--radius-sm)',
        padding: '11px 13px',
        background: skill.isEnabled ? '#fff' : 'var(--gray-50)',
        opacity: skill.isEnabled ? 1 : 0.72,
        // A column, so the action row can be pushed to the bottom with
        // marginTop:auto — side by side, two cards in a row are the height of
        // the taller one, and without this the buttons float mid-card on the
        // shorter one.
        display: 'flex', flexDirection: 'column',
        minWidth: 0
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' }}>
        <code style={{
          fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)',
          fontWeight: 600, color: 'var(--text-heading)'
        }}>
          skill_{skill.name}
        </code>
        {skill.surfaces?.map((s) => (
          <Pill key={s} tone={s === 'deal' ? 'gold' : 'plum'}>
            {s === 'deal' ? 'Deal AI' : 'Insights AI'}
          </Pill>
        ))}
        {!skill.isEnabled && <Pill tone="gray">Off</Pill>}
        <span style={{ flex: 1 }} />
        {/* Usage is how you find a skill with a bad description: the AI only
            picks a tool it understands, so one never used is usually one
            nobody explained properly. */}
        {skill.useCount > 0 && (
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-faint)' }}>
            used {skill.useCount}×
          </span>
        )}
      </div>

      {/* CLAMPED TO FOUR LINES. A skill's description is written for the
          MODEL — it is the only thing the AI picks a tool on, so it runs to
          two or three hundred words and says the same thing several ways on
          purpose. Printed in full, one skill filled the viewport and 56 of
          them were an unreadable column. Four lines is enough to tell which
          skill this is; the rest is a click away. */}
      <p style={{
        margin: '5px 0 0', fontSize: 'var(--text-base)', color: 'var(--text-body)',
        display: '-webkit-box', WebkitLineClamp: 4, WebkitBoxOrient: 'vertical',
        overflow: 'hidden',
        // Belt and braces: -webkit-line-clamp is near-universal but a browser
        // without it would otherwise print all 300 words again.
        maxHeight: 'calc(var(--leading-normal) * 4em)',
        lineHeight: 'var(--leading-normal)'
      }}>
        {skill.description}
      </p>

      <button
        type="button"
        onClick={() => setShowing(true)}
        style={{
          margin: '4px 0 0', padding: 0, border: 'none', background: 'none',
          color: 'var(--accent-plum-text)', fontFamily: 'var(--font-sans)',
          fontSize: 'var(--text-sm)', fontWeight: 600, cursor: 'pointer'
        }}
      >
        View more
      </button>

      <p style={{
        margin: '6px 0 0', fontSize: 'var(--text-sm)', color: 'var(--text-muted)',
        fontFamily: 'var(--font-mono)',
        // The view name plus five filter names is longer than a half-width
        // card. Truncated rather than wrapped: it is an identifier line, and
        // the full list is in the modal.
        whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis'
      }}>
        {skill.viewName}
        {skill.params?.length > 0 && ` · ${skill.params.map((p) => p.name).join(', ')}`}
      </p>

      <div style={{ display: 'flex', gap: 6, marginTop: 'auto', paddingTop: 9, flexWrap: 'wrap' }}>
        <GhostButton onClick={onEdit} disabled={busy}>Edit</GhostButton>
        <GhostButton onClick={toggle} disabled={busy}>
          {skill.isEnabled ? 'Turn off' : 'Turn on'}
        </GhostButton>
        <span style={{ flex: 1 }} />
        {confirming ? (
          <>
            <span style={{
              fontSize: 'var(--text-sm)', color: 'var(--text-muted)', alignSelf: 'center'
            }}>
              Delete this skill?
            </span>
            <GhostButton onClick={() => setConfirming(false)} disabled={busy}>Keep</GhostButton>
            <GhostButton onClick={remove} disabled={busy} danger>Delete</GhostButton>
          </>
        ) : (
          <GhostButton onClick={() => setConfirming(true)} disabled={busy} danger>Delete</GhostButton>
        )}
      </div>

      {showing && <SkillDetail skill={skill} onClose={() => setShowing(false)} />}
    </div>
  )
}

// ── The form ─────────────────────────────────────────────────────────

function SkillForm({ skill, views = [], onCancel, onSaved }) {
  const [form, setForm] = useState(() => ({ ...BLANK, ...skill }))
  const [cols, setCols] = useState(null)        // the view's real columns
  const [viewDoc, setViewDoc] = useState(null)  // the view's own description
  const [checking, setChecking] = useState(false)
  const [viewError, setViewError] = useState(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState(null)
  const [errorField, setErrorField] = useState(null)
  const checkSeq = useRef(0)

  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }))


  // Check the view as soon as its name settles. Everything below — the column
  // pickers, the sort field — is driven by what comes back, so there is no
  // free-text column entry anywhere and no chance to mistype one.
  useEffect(() => {
    const name = form.viewName?.trim()
    if (!name) { setCols(null); setViewError(null); return }
    const seq = ++checkSeq.current
    setChecking(true)
    const id = window.setTimeout(() => {
      controlAPI.describeView(name)
        .then((r) => {
          if (seq !== checkSeq.current) return   // a newer keystroke won
          setCols(r?.columns || [])
          setViewDoc(r?.viewComment || null)
          setViewError(null)
          // Prefill the description from the view's own comment, but only
          // when the field is untouched — overwriting something someone typed
          // because they paused on the view name would be infuriating.
          setForm((f) => (f.description.trim() || !r?.viewComment
            ? f
            : { ...f, description: r.viewComment }))
        })
        .catch((e) => {
          if (seq !== checkSeq.current) return
          setCols(null)
          setViewDoc(null)
          setViewError(e?.message || 'That view could not be used')
        })
        .finally(() => { if (seq === checkSeq.current) setChecking(false) })
    }, 400)
    return () => window.clearTimeout(id)
  }, [form.viewName])

  const save = async () => {
    setSaving(true); setError(null); setErrorField(null)
    try {
      const body = {
        name: form.name.trim(),
        description: form.description.trim(),
        viewName: form.viewName.trim(),
        params: form.params,
        // Always [] now that the form has no column picker. The server
        // resolves this to the view's full list at save time — sending the
        // stored list back would silently freeze a skill's columns as they
        // were the day it was created, so a column added to the view later
        // would never reach the AI.
        columns: [],
        orderBy: form.orderBy?.trim() || null,
        rowLimit: Number(form.rowLimit) || 50,
        surfaces: form.surfaces,
        isEnabled: form.isEnabled
      }
      if (form.id) await controlAPI.updateSkill(form.id, body)
      else await controlAPI.createSkill(body)
      onSaved()
    } catch (e) {
      setError(e?.message || 'Could not save that skill')
      // The server names the field that failed, so the form can point at it
      // instead of showing a banner and leaving someone to hunt.
      //
      // `e.data`, not `e.response.data`: the API client's interceptor rejects
      // with its own Error carrying the body on `.data` (see api/client.js),
      // so reaching for `.response` here would silently never match and no
      // field would ever highlight.
      setErrorField(e?.data?.field || null)
      setSaving(false)
    }
  }


  const ready = form.name.trim() && form.description.trim().length >= 20 && cols?.length

  // What is stopping the save, in the order someone fills the form in. One
  // reason at a time: a list of four faults on an empty form is noise.
  const blocker =
    !form.viewName.trim() ? 'Enter a view to get started'
      : checking ? null
        : !cols?.length ? null              // the view error already shows above
          : !form.name.trim() ? 'Give the skill a name'
            : form.description.trim().length < 20 ? 'Add a description'
              : !form.surfaces.length ? 'Pick where it can be used'
                : null

  return (
    // Framed, because the form now sits INSIDE the list rather than replacing
    // it. Without a border it reads as the page having changed state; with
    // one it reads as the row you clicked, opened.
    <div style={{
      display: 'grid', gap: 14,
      padding: 'var(--space-3)',
      border: '1px solid var(--accent-plum-text)',
      borderRadius: 'var(--radius-md)',
      background: 'var(--gray-50)'
    }}>
      <div style={{
        fontSize: 'var(--text-sm)', fontWeight: 600,
        letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
        color: 'var(--accent-plum-text)'
      }}>
        {skill?.id ? 'Editing this skill' : 'New skill'}
      </div>

      {/* Only when the error is not already pinned to a field. The server
          names the field that failed, and showing the same sentence as a
          banner AND under the input says it twice — which reads as two
          problems rather than one. */}
      {error && !errorField && <Banner tone="error">{error}</Banner>}

      <Field
        label="Database view"
        hint="The view the AI reads. Created by whoever owns the data, in a migration."
        error={errorField === 'viewName' ? error : viewError}
      >
        {/* Capped rather than full-bleed: a view name is ~30 characters, and a
            900px input with a short placeholder adrift in it reads as an
            unfinished layout. The status sits beside it, not under, so the
            row stays one line once a view resolves. */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          {/* A DROPDOWN, not a text box — the names are in the database
              catalogue, so asking someone to recall
              "vw_close_reason_by_stage" exactly, underscores and all, only
              created typos that surfaced as a validation error afterwards.

              showSearch because the list is long: typing filters it, by name
              OR by the view's own comment, so near-identical names are told
              apart by what they are for.

              The plain input is kept for the case where the catalogue call
              FAILED. A single-select antd dropdown cannot commit a value that
              is not in its options, so an empty list would leave the field
              impossible to fill — the form would be unusable rather than
              merely less convenient. Two explicit branches, rather than one
              control that silently stops working. */}
          {views.length > 0 ? (
            <Select
              showSearch
              value={form.viewName || undefined}
              onChange={(v) => set('viewName', v || '')}
              placeholder="Pick a view…"
              popupClassName="pp-menu"
              status={viewError ? 'error' : undefined}
              style={{ width: '100%', maxWidth: 340 }}
              styles={{ root: { height: 32 } }}
              optionFilterProp="value"
              filterOption={(q, opt) => {
                const needle = q.toLowerCase()
                return String(opt?.value || '').toLowerCase().includes(needle)
                  || String(opt?.comment || '').toLowerCase().includes(needle)
              }}
              options={views.map((v) => ({
                value: v.name,
                comment: v.comment,
                label: (
                  <span style={{ display: 'block', lineHeight: 1.3 }}>
                    <span style={{ fontFamily: 'var(--font-mono)' }}>{v.name}</span>
                    {v.comment && (
                      <Truncate style={{ display: 'block',
                        fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
                        {v.comment}
                      </Truncate>
                    )}
                  </span>
                )
              }))}
            />
          ) : (
            <input
              style={{ ...input(viewError), maxWidth: 340, fontFamily: 'var(--font-mono)' }}
              value={form.viewName}
              onChange={(e) => set('viewName', e.target.value)}
              placeholder="vw_quiet_deals_by_rep"
              spellCheck={false}
              autoComplete="off"
            />
          )}
          {checking && (
            <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
              Checking…
            </span>
          )}
          {cols && !checking && (
            <span style={{
              display: 'inline-flex', alignItems: 'center', gap: 5,
              fontSize: 'var(--text-sm)', color: 'var(--accent-pine-text)'
            }}>
              <span className="ms" style={{ fontSize: 15 }}>check_circle</span>
              {cols.length} column{cols.length === 1 ? '' : 's'} · access rules confirmed
            </span>
          )}
        </div>
        {/* What the view is for, in its author's words. Confirms at a glance
            that the right view was named — a typo that happens to match
            another real view is otherwise invisible. */}
        {viewDoc && !checking && (
          <p style={{
            margin: '7px 0 0', padding: '8px 11px',
            background: 'var(--gray-50)',
            borderLeft: '2px solid var(--accent-plum-text)',
            borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
            fontSize: 'var(--text-sm)', lineHeight: 1.5, color: 'var(--text-body)'
          }}>
            {viewDoc}
          </p>
        )}
      </Field>

      {/* Everything past this point needs the view's real columns, so it stays
          hidden until one resolves. A form that lets you fill in parameters
          for a view that does not exist is a form that wastes your time. */}
      {cols?.length > 0 && (
        <>
          <Field
            label="Skill name"
            hint="What the AI calls it. Lower case, no spaces."
            error={errorField === 'name' ? error : null}
          >
            <div style={{ display: 'flex', alignItems: 'center', gap: 0, maxWidth: 340 }}>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 'var(--text-base)',
                color: 'var(--text-faint)', padding: '0 2px 0 10px',
                border: '1px solid var(--border-default)', borderRight: 'none',
                borderRadius: 'var(--radius-sm) 0 0 var(--radius-sm)',
                height: 32, display: 'flex', alignItems: 'center',
                background: 'var(--gray-50)'
              }}>
                skill_
              </span>
              <input
                style={{
                  ...input(),
                  borderRadius: '0 var(--radius-sm) var(--radius-sm) 0',
                  maxWidth: 280, fontFamily: 'var(--font-mono)'
                }}
                value={form.name}
                onChange={(e) => set('name', e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, '_'))}
                placeholder="quiet_deals_by_rep"
                spellCheck={false}
                autoComplete="off"
              />
            </div>
          </Field>

          <Field
            label="When should the AI use this?"
            hint="The AI picks tools almost entirely on this text — describe the questions it answers, in the words a rep would use."
            error={errorField === 'description' ? error : null}
          >
            <textarea
              style={{ ...input(), height: 'auto', minHeight: 62, padding: '8px 10px', resize: 'vertical' }}
              value={form.description}
              onChange={(e) => set('description', e.target.value)}
              placeholder="Deals with no customer reply for a number of days, by owner. Use for 'which of Sarah's deals have gone quiet'."
            />
            {form.description.trim().length > 0 && form.description.trim().length < 20 && (
              <Muted small>A little more detail — the AI needs to know when to reach for this.</Muted>
            )}
          </Field>

          {/* FILTERS AND SORT ARE NOT EDITED HERE ANY MORE.
              Both were row-builders over the view's columns — the densest
              part of the form and the part nobody filled in by hand, since
              a seeded skill arrives with its filters already written. They
              are still STORED and still sent on save (form.params and
              form.orderBy pass through untouched), so an existing skill
              keeps everything it had; there is simply no editor for them.
              A new filter belongs in the skill's JSON, beside the view. */}

          <div style={{ display: 'grid', gap: 14, gridTemplateColumns: '1fr 1fr' }}>
            <Field label="Most rows to return" hint="1–500.">
              <input
                style={{ ...input(), maxWidth: 110 }}
                type="number"
                min={1}
                max={500}
                value={form.rowLimit}
                onChange={(e) => set('rowLimit', e.target.value)}
              />
            </Field>
          </div>

          <Field
            label="Available in"
            hint="Which assistant may use it."
          >
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              {[['portfolio', 'Insights AI'], ['deal', 'Deal AI']].map(([key, label]) => {
                const on = form.surfaces.includes(key)
                return (
                  <button
                    key={key}
                    type="button"
                    onClick={() => set('surfaces',
                      on ? form.surfaces.filter((s) => s !== key) : [...form.surfaces, key])}
                    style={{
                      padding: '5px 12px', borderRadius: 'var(--radius-pill)',
                      border: `1px solid ${on ? 'var(--accent-plum-text)' : 'var(--border-default)'}`,
                      background: on ? 'var(--tint-plum)' : '#fff',
                      color: on ? 'var(--accent-plum-text)' : 'var(--text-muted)',
                      fontSize: 'var(--text-base)', fontWeight: on ? 600 : 400,
                      fontFamily: 'var(--font-sans)', cursor: 'pointer'
                    }}
                  >
                    {label}
                  </button>
                )
              })}
            </div>
            {form.surfaces.length === 0 && (
              <Muted small>Pick at least one, or nothing can use this skill.</Muted>
            )}
          </Field>
        </>
      )}

      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        paddingTop: 12, borderTop: '1px solid var(--border-default)'
      }}>
        <PrimaryButton onClick={save} disabled={!ready || !form.surfaces.length || saving}>
          {saving ? 'Saving…' : form.id ? 'Save changes' : 'Create skill'}
        </PrimaryButton>
        <GhostButton onClick={onCancel} disabled={saving}>Cancel</GhostButton>
        {/* A greyed-out button with no reason beside it reads as broken. Say
            what is still missing — this is the first thing anyone sees on an
            empty form, where nothing is filled in yet and Create is off. */}
        {!saving && blocker && (
          <span style={{ fontSize: 'var(--text-sm)', color: 'var(--text-muted)' }}>
            {blocker}
          </span>
        )}
      </div>
    </div>
  )
}

const input = (hasError) => ({
  width: '100%', boxSizing: 'border-box', height: 32, padding: '0 10px',
  border: `1px solid ${hasError ? 'var(--status-stuck)' : 'var(--border-default)'}`,
  borderRadius: 'var(--radius-sm)', fontFamily: 'var(--font-sans)',
  fontSize: 'var(--text-base)', color: 'var(--text-heading)', background: '#fff'
})

function Field({ label, hint, error, children }) {
  return (
    <label style={{ display: 'block' }}>
      <span style={{
        display: 'block', marginBottom: 4,
        fontSize: 'var(--text-xs)', fontWeight: 600,
        letterSpacing: 'var(--tracking-label)', textTransform: 'uppercase',
        color: 'var(--text-muted)'
      }}>
        {label}
      </span>
      {hint && (
        <span style={{
          display: 'block', marginBottom: 5,
          fontSize: 'var(--text-sm)', color: 'var(--text-faint)'
        }}>
          {hint}
        </span>
      )}
      {children}
      {error && (
        <span style={{
          display: 'block', marginTop: 4,
          fontSize: 'var(--text-sm)', color: 'var(--status-stuck)'
        }}>
          {error}
        </span>
      )}
    </label>
  )
}

function Banner({ tone, children, onDismiss }) {
  return (
    <p style={{
      margin: 0, padding: '9px 12px', borderRadius: 'var(--radius-sm)',
      background: tone === 'error' ? 'var(--tint-rose)' : 'var(--gray-50)',
      border: `1px solid ${tone === 'error' ? 'var(--status-stuck)' : 'var(--border-default)'}`,
      color: tone === 'error' ? 'var(--status-stuck-text)' : 'var(--text-body)',
      fontSize: 'var(--text-base)',
      display: 'flex', alignItems: 'flex-start', gap: 8
    }}>
      <span style={{ flex: 1 }}>{children}</span>
      {onDismiss && (
        <button
          onClick={onDismiss}
          style={{
            border: 'none', background: 'none', cursor: 'pointer',
            color: 'inherit', padding: 0, fontSize: 'var(--text-base)'
          }}
        >
          ×
        </button>
      )}
    </p>
  )
}

function Muted({ children, small }) {
  return (
    <p style={{
      margin: small ? '4px 0 0' : 0,
      fontSize: small ? 'var(--text-sm)' : 'var(--text-base)',
      color: 'var(--text-muted)'
    }}>
      {children}
    </p>
  )
}

function Pill({ tone, children }) {
  const color = tone === 'gray' ? 'var(--text-muted)' : `var(--accent-${tone}-text)`
  const bg = tone === 'gray' ? 'var(--gray-100)' : `var(--tint-${tone})`
  return (
    <span style={{
      padding: '1px 7px', borderRadius: 'var(--radius-pill)',
      background: bg, color, fontSize: 'var(--text-xs)', fontWeight: 600
    }}>
      {children}
    </span>
  )
}

function Empty({ onAdd }) {
  return (
    <div style={{ textAlign: 'center', padding: '18px 0' }}>
      <p style={{ margin: '0 0 3px', fontSize: 'var(--text-md)', color: 'var(--text-body)' }}>
        No skills yet.
      </p>
      <p style={{ margin: '0 0 12px', fontSize: 'var(--text-base)', color: 'var(--text-muted)' }}>
        Add one and the AI can answer questions straight from your own views.
      </p>
      <PrimaryButton onClick={onAdd}>Add a skill</PrimaryButton>
    </div>
  )
}
