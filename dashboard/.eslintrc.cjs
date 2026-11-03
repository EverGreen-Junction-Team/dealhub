/* Catches the class of bug Vite ships silently: identifiers that don't exist
 * at runtime. Three have reached the client this way — `chatCount`,
 * `useEffect`, `formatClock` — plus a stale `toggleDictation` caught in review.
 *
 * Deliberately narrow. This is not a style config: only rules that catch real
 * runtime errors are enabled, so a clean run means something.
 */
module.exports = {
  root: true,
  env: { browser: true, es2022: true },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true }
  },
  plugins: ['react', 'react-hooks'],
  settings: { react: { version: '18' } },
  rules: {
    // The main event: an undefined identifier is a runtime ReferenceError.
    'no-undef': 'error',
    // JSX counts as a use, or every component reads as unused.
    'react/jsx-uses-vars': 'error',
    'react/jsx-uses-react': 'error',
    // no-undef does NOT cover <Component /> references — a missing component
    // builds fine and crashes at render. This is the JSX equivalent.
    'react/jsx-no-undef': 'error',
    // A leftover after a rename — how `chatCount` survived.
    'no-unused-vars': ['warn', {
      args: 'none',
      varsIgnorePattern: '^_',
      ignoreRestSiblings: true
    }],
    // Hooks called conditionally corrupt React's state ordering — a real
    // runtime failure, not style.
    'react-hooks/rules-of-hooks': 'error',
    // Warn only: a missing dep is often deliberate here, and the existing
    // eslint-disable comments explain each case.
    'react-hooks/exhaustive-deps': 'warn',
    'no-dupe-keys': 'error',
    'no-unreachable': 'error'
  },
  globals: {
    React: 'readonly',
    SpeechRecognition: 'readonly',
    webkitSpeechRecognition: 'readonly'
  }
}
