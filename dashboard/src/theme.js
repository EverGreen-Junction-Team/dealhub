// Brand theme for antd.
//
// These values MIRROR styles/dealhub-tokens.css. They were divergent — antd
// was themed blue (#3563e9) with system fonts while the Deal Hub is evergreen
// with Poppins, so the same app had two visual identities depending on which
// component you were looking at.
//
// Kept as literals rather than reading the CSS variables because antd resolves
// its theme in JS at render time and cannot see them. If a token changes in the
// CSS, change it here too.
//
// Lives in its own module so AppearanceProvider can build a scaled copy; see
// scaledTheme below and the note on why antd cannot be left out of the text
// size setting.
export const BASE_THEME = {
  token: {
    colorPrimary: '#1f7a5c',        // --green-500
    colorSuccess: '#00a25b',        // --status-done
    colorWarning: '#f5a300',        // --status-working
    colorError: '#d83a52',          // --status-stuck
    colorTextBase: '#323844',       // --gray-700
    colorBorder: '#dcdfe4',         // --gray-200
    colorBgLayout: '#f5f6f8',       // --gray-50
    borderRadius: 8,                // --radius-md
    fontFamily: "'Poppins', -apple-system, 'Segoe UI', sans-serif",
    fontSize: 13,                   // --text-md, the app's body size
    controlHeight: 36,              // --control-h-md
    colorTextPlaceholder: '#6b7482', // --gray-450, AA on white
  },
  components: {
    // antd's default input border is lighter than the app's, so a native
    // control and an antd one sat side by side didn't match. These pin the
    // three the Deal cards use.
    Input: { colorBorder: '#c3c8d0', activeBorderColor: '#16855f' },
    DatePicker: { colorBorder: '#c3c8d0', activeBorderColor: '#16855f' },
    Select: { colorBorder: '#c3c8d0', optionSelectedBg: '#d8ede4' },
  },
}

/**
 * The theme at a given text scale.
 *
 * ── WHY antd CANNOT BE LEFT OUT OF THE TEXT SIZE SETTING ─────────────
 *
 * The CSS tokens cover our own components. antd resolves its sizing in JS
 * and never looks at a CSS variable, so with only the CSS half wired up,
 * raising the text size moved our headings, labels and cards while every
 * Select, Input, Button, Table and Tooltip stayed at 13px. Half the screen
 * responding to a slider reads as a broken setting, not a partial one.
 *
 * controlHeight scales with it, and that is the part that is easy to
 * forget: text growing inside a box whose height is pinned at 36px clips,
 * so the two have to move together or "bigger text" produces cut-off
 * inputs.
 *
 * Rounded to whole pixels. antd does arithmetic on these to derive its own
 * sizes (fontSizeLG, fontSizeSM, line heights), and feeding it 15.600000001
 * pushes fractional pixels through the whole derived scale.
 */
export function scaledTheme(textScale = 1) {
  const scale = Number.isFinite(textScale) && textScale > 0 ? textScale : 1
  if (scale === 1) return BASE_THEME
  return {
    ...BASE_THEME,
    token: {
      ...BASE_THEME.token,
      fontSize: Math.round(BASE_THEME.token.fontSize * scale),
      controlHeight: Math.round(BASE_THEME.token.controlHeight * scale),
    },
  }
}
