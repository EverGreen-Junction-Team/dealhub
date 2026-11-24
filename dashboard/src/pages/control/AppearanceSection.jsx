import React, { useEffect, useMemo, useState } from 'react'
import { Slider, Radio, Tooltip } from 'antd'
import SectionCard, { PrimaryButton, GhostButton } from './SectionCard'
import { useAppearance, LIMITS, clampPrefs } from '../../context/AppearanceContext'

// Appearance — how big this dashboard draws itself.
//
// ── WHY THE PREVIEW IS LIVE AND WHY THAT IS THE WHOLE DESIGN ─────────
//
// Nobody knows what "zoom 0.9" means. They know whether the screen in front
// of them is comfortable. So moving a slider changes the app immediately,
// including this card — the section you are reading grows and shrinks with
// everything else, which is the most honest preview available and costs
// nothing to build.
//
// Nothing is written until Save. Navigating away, or pressing Discard,
// throws the preview out and the saved values come back. That matters more
// than usual here: the control that is easiest to get wrong is also the one
// that makes the app hard to use while it is wrong, so the way back has to
// be obvious and must never depend on reading tiny text.
//
// ── TWO SCOPES, SIDE BY SIDE ─────────────────────────────────────────
//
//   Just me        a row keyed to this user. Beats the account's.
//   Everyone here  the sub-account's default, for anyone who has not set
//                  their own.
//
// Shown as a choice rather than two separate cards because it is one
// decision — "who am I changing this for" — and splitting it into two
// panels with identical sliders invites setting one and meaning the other.
//
// WHO MAY SET THE ACCOUNT DEFAULT. Anybody here. The session carries no
// role, so there is nothing to check without a second lookup, and a
// half-enforced permission is worse than an honest one — the same rule
// saved views already use for sharing. The card says so plainly, and the
// server records who last changed it.
//
// ── WHY TWO SLIDERS ──────────────────────────────────────────────────
//
// "Everything is too big" and "the words are too small" are different
// complaints with different answers, and one slider can only serve one of
// them. See AppearanceContext.

const PRESETS = [
  // Named for the problem they solve, not for their numbers. Someone
  // arriving here knows which sentence describes them; they do not know
  // which decimal does.
  { key: 'compact',     label: 'Compact',     prefs: { zoom: 0.75, textScale: 1 },
    hint: 'More on screen. For a large monitor.' },
  { key: 'default',     label: 'Default',     prefs: { zoom: 0.85, textScale: 1 },
    hint: 'What the app ships with.' },
  { key: 'comfortable', label: 'Comfortable', prefs: { zoom: 1, textScale: 1 },
    hint: 'Nothing scaled down. For a laptop.' },
  { key: 'large-text',  label: 'Large text',  prefs: { zoom: 0.9, textScale: 1.2 },
    hint: 'Bigger words without giving up much space.' }
]

const PCT = (n) => `${Math.round(n * 100)}%`

function samePrefs(a, b) {
  if (!a || !b) return false
  return a.zoom === b.zoom && a.textScale === b.textScale
}

export default function AppearanceSection() {
  const {
    defaults, account, mine, effective, applied, error, preview, save, clear
  } = useAppearance()

  const [scope, setScope] = useState('user')
  const [draft, setDraft] = useState(null)
  const [busy, setBusy] = useState(false)
  const [saveError, setSaveError] = useState(null)
  const [saved, setSaved] = useState(false)

  // What the chosen scope currently holds, falling back to what the app is
  // actually rendering at. Starting the sliders anywhere else would make the
  // first drag jump the screen before the user has asked for anything.
  const baseline = useMemo(() => {
    const layer = scope === 'account' ? account : mine
    return { ...effective, ...(layer || {}) }
  }, [scope, account, mine, effective])

  // Switching scope abandons the draft. The alternative — carrying the
  // numbers across — would turn "actually, set this for everyone" into a
  // silent write of values the user picked while thinking about themselves.
  useEffect(() => {
    setDraft(null)
    setSaveError(null)
    setSaved(false)
    preview(null)
  }, [scope, preview])

  // Stop previewing when this card goes away, so a half-dragged slider
  // cannot follow the user to another tab.
  useEffect(() => () => preview(null), [preview])

  const values = draft || baseline
  const dirty = draft != null && !samePrefs(draft, baseline)

  const set = (key, value) => {
    const next = clampPrefs({ ...values, [key]: value })
    setDraft(next)
    setSaved(false)
    // THE PREVIEW IS THE POINT. Applied for both scopes, including
    // "Everyone here" — you are previewing on your own screen what the
    // default will look like, which is the only screen available to preview
    // it on. It is discarded unless you save.
    preview(next)
  }

  const onSave = async () => {
    setBusy(true)
    setSaveError(null)
    try {
      await save(scope, values)
      setDraft(null)
      setSaved(true)
    } catch (err) {
      setSaveError(err.message || 'Could not save that')
    } finally {
      setBusy(false)
    }
  }

  const discard = () => {
    setDraft(null)
    setSaveError(null)
    setSaved(false)
    preview(null)
  }

  const onReset = async () => {
    setBusy(true)
    setSaveError(null)
    try {
      await clear(scope)
      setDraft(null)
      setSaved(true)
    } catch (err) {
      setSaveError(err.message || 'Could not reset that')
    } finally {
      setBusy(false)
    }
  }

  const activePreset = PRESETS.find((p) => samePrefs(p.prefs, values))
  const hasOwnRow = scope === 'account' ? !!account : !!mine

  return (
    <SectionCard
      icon="format_size"
      title="Appearance"
      collapsible
      accent="gold"
      meta={`Now at ${PCT(applied.zoom)} · text ${PCT(applied.textScale)}`}
      help="How big this dashboard draws itself. Moving a slider changes the screen straight away so you can see it — nothing is kept until you press Save."
    >
      <div style={{ display: 'grid', gap: 'var(--space-4)', padding: 'var(--space-4)' }}>
        {error && (
          <Note tone="warn">
            {/* The app still works; it is drawing at its defaults. Saying so
                is better than a silent slider that appears to do nothing. */}
            {error}. The dashboard is using its standard size until this loads.
          </Note>
        )}

        <div>
          <Label>Change it for</Label>
          <Radio.Group
            value={scope}
            onChange={(e) => setScope(e.target.value)}
            optionType="button"
            buttonStyle="solid"
            options={[
              { value: 'user', label: 'Just me' },
              { value: 'account', label: 'Everyone here' }
            ]}
          />
          <Explain>
            {scope === 'user'
              ? 'Only your own screen, on every device you sign in from. This wins over the sub-account default.'
              : 'The default for everyone in this sub-account who has not set their own. Anyone here can change it.'}
          </Explain>
        </div>

        <div>
          <Label>Presets</Label>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--space-2)' }}>
            {PRESETS.map((p) => (
              <Tooltip key={p.key} title={p.hint} mouseEnterDelay={0.3}>
                <button
                  type="button"
                  onClick={() => { setDraft(p.prefs); setSaved(false); preview(p.prefs) }}
                  style={{
                    padding: '6px 12px',
                    border: `1px solid ${activePreset?.key === p.key
                      ? 'var(--brand-primary)' : 'var(--border-strong)'}`,
                    borderRadius: 'var(--radius-pill)',
                    background: activePreset?.key === p.key
                      ? 'var(--tint-pine)' : '#fff',
                    fontFamily: 'var(--font-sans)',
                    fontSize: 'var(--text-sm)',
                    color: 'var(--text-body)',
                    cursor: 'pointer'
                  }}
                >
                  {p.label}
                </button>
              </Tooltip>
            ))}
          </div>
        </div>

        <SliderRow
          label="Overall size"
          hint="Scales everything — text, spacing, card heights. Lower fits more on screen."
          value={values.zoom}
          limits={LIMITS.zoom}
          onChange={(v) => set('zoom', v)}
        />

        <SliderRow
          label="Text size"
          hint="Scales the words only, on top of the overall size. For when the layout is fine but the text is hard to read."
          value={values.textScale}
          limits={LIMITS.textScale}
          onChange={(v) => set('textScale', v)}
        />

        {saveError && <Note tone="bad">{saveError}</Note>}
        {saved && !dirty && <Note tone="good">Saved.</Note>}

        <div
          style={{
            display: 'flex', alignItems: 'center', flexWrap: 'wrap',
            gap: 'var(--space-2)',
            paddingTop: 'var(--space-3)',
            borderTop: '1px solid var(--border-default)'
          }}
        >
          <PrimaryButton onClick={onSave} disabled={busy || !dirty} icon="check">
            {scope === 'account' ? 'Save for everyone' : 'Save for me'}
          </PrimaryButton>
          {dirty && (
            <GhostButton onClick={discard} disabled={busy} icon="undo">
              Discard
            </GhostButton>
          )}
          {hasOwnRow && !dirty && (
            <GhostButton onClick={onReset} disabled={busy} icon="restart_alt">
              {scope === 'account' ? 'Back to the app default' : 'Use the account default'}
            </GhostButton>
          )}
          <span
            style={{
              marginLeft: 'auto',
              fontSize: 'var(--text-xs)', color: 'var(--text-faint)'
            }}
          >
            {/* The resolution order, stated. Without it "I saved it and
                nothing changed" is unexplainable — the usual cause is a
                personal setting quietly beating the account default you
                just edited. */}
            {scope === 'account' && mine
              ? 'Your own setting is overriding this on your screen.'
              : `App default ${PCT(defaults.zoom)} · text ${PCT(defaults.textScale)}`}
          </span>
        </div>
      </div>
    </SectionCard>
  )
}

function SliderRow({ label, hint, value, limits, onChange }) {
  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <Label>{label}</Label>
        <span
          style={{
            fontSize: 'var(--text-sm)', color: 'var(--text-body)',
            fontVariantNumeric: 'tabular-nums'
          }}
        >
          {PCT(value)}
        </span>
      </div>
      <Slider
        min={limits.min}
        max={limits.max}
        step={limits.step}
        value={value}
        onChange={onChange}
        tooltip={{ formatter: PCT }}
        marks={{
          [limits.min]: PCT(limits.min),
          1: '100%',
          [limits.max]: PCT(limits.max)
        }}
      />
      <Explain>{hint}</Explain>
    </div>
  )
}

function Label({ children }) {
  return (
    <div
      style={{
        marginBottom: 6,
        fontSize: 'var(--text-xs)',
        fontWeight: 'var(--weight-semibold)',
        letterSpacing: 'var(--tracking-label)',
        textTransform: 'uppercase',
        color: 'var(--text-muted)'
      }}
    >
      {children}
    </div>
  )
}

function Explain({ children }) {
  return (
    <p style={{ margin: '4px 0 0', fontSize: 'var(--text-xs)', color: 'var(--text-faint)' }}>
      {children}
    </p>
  )
}

function Note({ tone, children }) {
  const colour = tone === 'bad'
    ? 'var(--status-stuck)'
    : tone === 'good' ? 'var(--status-won, var(--brand-primary))' : 'var(--accent-gold)'
  return (
    <div
      role={tone === 'bad' ? 'alert' : 'status'}
      style={{
        padding: 'var(--space-2) var(--space-3)',
        borderLeft: `3px solid ${colour}`,
        borderRadius: 'var(--radius-sm)',
        background: 'var(--surface-sunken)',
        fontSize: 'var(--text-sm)', color: 'var(--text-body)'
      }}
    >
      {children}
    </div>
  )
}
