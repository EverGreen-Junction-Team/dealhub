import React, {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState
} from 'react'
import { ConfigProvider } from 'antd'
import { preferencesAPI } from '../api/preferences'
import { scaledTheme } from '../theme'

// How big this dashboard draws itself, and who decided.
//
// ── WHY THERE ARE TWO NUMBERS AND NOT ONE ────────────────────────────
//
//   zoom       scales EVERYTHING — text, padding, borders, card heights.
//              The right control for "this screen is too cramped" or "I sit
//              too far back", because the proportions stay exactly as
//              designed and you simply get more or less of the page.
//   textScale  scales ONLY type. The right control for "I can read the
//              layout fine, the words are too small" — which is a different
//              complaint, and answering it with zoom means giving up screen
//              space to fix an eyesight problem.
//
// They multiply, which is intended: zoom 0.8 with textScale 1.15 is a dense
// layout with readable labels, and no single slider can express that.
//
// ── WHY THE VALUES LIVE ON THE SERVER ────────────────────────────────
//
// localStorage would be simpler and wrong twice over. The app runs inside a
// GHL iframe, where storage is partitioned and routinely cleared, so a
// setting would quietly vanish; and the same person on a laptop and on an
// office machine would have to set it twice. More to the point, the feature
// is per sub-account AND per user — an agency setting a house default for a
// client's team is half the reason it exists, and that is not something a
// browser can hold.
//
// ── THE ORDER THAT MATTERS ───────────────────────────────────────────
//
// user → account → the app's shipped defaults, resolved PER KEY on the
// server. Somebody who only ever changed the text size still follows the
// account's zoom, including when it changes later.
//
// ── WHY IT IS A CONTEXT AND NOT JUST A FETCH IN THE SETTINGS SCREEN ──
//
// The settings screen needs to show a live preview — a slider you have to
// save before you can see is a slider you set by trial and error. So the
// values are applied to the document from here, and the screen can push a
// provisional set through `preview` without writing anything. Anything
// previewed and not saved is discarded when the provider next reloads.

const AppearanceContext = createContext(null)

// Matches the server's DEFAULTS. Duplicated on purpose: this is what the app
// renders at before the request comes back and if it never does, and it has
// to be a literal for that — a dashboard that cannot reach its own API
// should still draw at the size it always drew at.
export const FALLBACK = Object.freeze({ zoom: 0.85, textScale: 1 })

// Mirrors the server's RANGES. The server is the guarantee; this is so a
// slider cannot offer a value that will be rejected when it is saved.
export const LIMITS = Object.freeze({
  zoom: { min: 0.6, max: 1.2, step: 0.05 },
  textScale: { min: 0.85, max: 1.3, step: 0.05 }
})

export function clampPrefs(prefs) {
  const out = {}
  for (const [k, v] of Object.entries(prefs || {})) {
    const lim = LIMITS[k]
    if (!lim) continue
    const n = Number(v)
    if (!Number.isFinite(n)) continue
    out[k] = Math.round(Math.min(lim.max, Math.max(lim.min, n)) * 100) / 100
  }
  return out
}

/**
 * Paint the numbers onto the document.
 *
 * On <html>, not <body>. The zoom itself is applied to <body> by index.css,
 * so the variable it reads has to be set on an ancestor — setting it on the
 * same element would still work, but putting both on <body> invites someone
 * to "tidy up" by moving the zoom to :root and silently breaking the 17
 * portals that render outside #root.
 */
function paint(values) {
  const el = document.documentElement
  el.style.setProperty('--app-zoom', String(values.zoom))
  el.style.setProperty('--app-text-scale', String(values.textScale))
}

export function AppearanceProvider({ children }) {
  const [state, setState] = useState({
    defaults: FALLBACK, account: null, mine: null, effective: FALLBACK
  })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // A provisional set from the settings screen's sliders. Never saved, never
  // in `state`, and dropped the moment the screen stops previewing — so a
  // user who drags a slider and navigates away gets their real setting back
  // rather than an accidental one.
  const [preview, setPreviewState] = useState(null)

  const applied = useMemo(
    () => ({ ...state.effective, ...(preview || {}) }),
    [state.effective, preview]
  )

  // A layout effect would be better in principle — it paints before the
  // browser does — but the first paint happens long before this resolves
  // anyway, and the CSS default covers it. An ordinary effect keeps the
  // preview path from blocking the slider's own render.
  useEffect(() => { paint(applied) }, [applied])

  const alive = useRef(true)
  useEffect(() => () => { alive.current = false }, [])

  const load = useCallback(async () => {
    try {
      const res = await preferencesAPI.get()
      if (!alive.current) return
      setState({
        defaults: res.defaults || FALLBACK,
        account: res.account || null,
        mine: res.mine || null,
        effective: { ...FALLBACK, ...(res.effective || {}) }
      })
      setError(null)
    } catch (err) {
      if (!alive.current) return
      // NOT fatal, and deliberately not shown as a banner over the app. A
      // failure here means the dashboard draws at its default size, which is
      // what it did before this feature existed. The settings screen reports
      // it; everywhere else carries on.
      setError(err.message || 'Could not load your display settings')
    } finally {
      if (alive.current) setLoading(false)
    }
  }, [])

  useEffect(() => { load() }, [load])

  const save = useCallback(async (scope, prefs) => {
    const res = await preferencesAPI.save(scope, clampPrefs(prefs))
    if (!alive.current) return res
    setState({
      defaults: res.defaults || FALLBACK,
      account: res.account || null,
      mine: res.mine || null,
      effective: { ...FALLBACK, ...(res.effective || {}) }
    })
    // The saved values ARE the live values now, so a leftover preview would
    // sit on top of them and make the screen disagree with the database.
    setPreviewState(null)
    return res
  }, [])

  const clear = useCallback(async (scope) => {
    const res = await preferencesAPI.clear(scope)
    if (!alive.current) return res
    setState({
      defaults: res.defaults || FALLBACK,
      account: res.account || null,
      mine: res.mine || null,
      effective: { ...FALLBACK, ...(res.effective || {}) }
    })
    setPreviewState(null)
    return res
  }, [])

  const value = useMemo(() => ({
    ...state,
    applied,
    loading,
    error,
    // Pass null to stop previewing and snap back to what is saved.
    preview: setPreviewState,
    previewing: preview,
    save,
    clear,
    reload: load
  }), [state, applied, loading, error, preview, save, clear, load])

  // antd sizes itself in JS and never reads a CSS variable, so the token
  // block in index.css reaches our own components and none of antd's. With
  // only that half wired up, raising the text size moved the headings and
  // left every Select, Input, Button and Table at 13px — which reads as a
  // broken slider rather than a partial one. A nested ConfigProvider merges
  // into the one in main.jsx, so only the two sizes that change are named.
  const antdTheme = useMemo(() => scaledTheme(applied.textScale), [applied.textScale])

  return (
    <AppearanceContext.Provider value={value}>
      <ConfigProvider theme={antdTheme}>
        {children}
      </ConfigProvider>
    </AppearanceContext.Provider>
  )
}

export function useAppearance() {
  const ctx = useContext(AppearanceContext)
  if (!ctx) throw new Error('useAppearance must be used inside AppearanceProvider')
  return ctx
}
