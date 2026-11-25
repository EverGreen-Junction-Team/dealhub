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
    // A `const` read before its declaration IN THE SAME SCOPE is a
    // guaranteed ReferenceError: `const` is not hoisted the way `function`
    // is. One of these took the whole Calendar tab down — a useMemo placed
    // above the memo it read, both inside the component.
    //
    // `variables: false` is deliberate and is NOT the lax setting. It
    // stops reporting a reference from INSIDE a function to a declaration
    // in an OUTER scope — a style constant at the bottom of the module,
    // read by a component at render time, which is safe because the
    // module has finished evaluating by then and is the house pattern in
    // thirty-odd places. It still reports every same-scope case, which is
    // the shape of the real bug. `true` flagged those thirty as errors,
    // and a rule that is mostly false alarms gets switched off.
    'no-use-before-define': ['error', {
      functions: false, classes: true, variables: false
    }],
    'no-dupe-keys': 'error',
    'no-unreachable': 'error'
  },
  // .jsx is linted when a DIRECTORY is passed, not only via the npm
  // script's --ext. Without this, `eslint src/` checks .js files only and
  // reports every component as clean having never opened one — which is
  // how a rule added here went unenforced on every component for a day.
  overrides: [{ files: ['*.jsx'] }],
  globals: {
    React: 'readonly',
    SpeechRecognition: 'readonly',
    webkitSpeechRecognition: 'readonly'
  }
}
