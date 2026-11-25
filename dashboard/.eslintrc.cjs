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
    // A `const` read before its declaration is a guaranteed
    // ReferenceError, not a style question: `const` is not hoisted into
    // scope the way `function` is. One of these took the whole Calendar tab
    // down — a useMemo placed above the memo it read — and both the build
    // and this linter passed it, because neither of them runs the
    // component. `functions: false` because a function declaration IS
    // hoisted, and calling one defined lower in the file is normal here.
    'no-use-before-define': ['error', {
      functions: false, classes: true, variables: true
    }],
    'no-dupe-keys': 'error',
    'no-unreachable': 'error'
  },
  globals: {
    React: 'readonly',
    SpeechRecognition: 'readonly',
    webkitSpeechRecognition: 'readonly'
  }
}
