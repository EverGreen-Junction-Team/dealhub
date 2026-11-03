// Minimal ESLint config for the server.
//
// WHY IT EXISTS. A `ReferenceError` reached production and failed every
// opportunity webhook for a day: upsertOpportunity referenced a bare `event`
// that is not one of its parameters. Node only throws when the line runs, and
// that line runs inside a try/catch whose failure was recorded in
// processed_events rather than crashing anything — so it was invisible until
// someone noticed a stale monetary value.
//
// `no-undef` catches exactly that class of bug, at zero cost. The dashboard has
// had this since a similar bug there; the server did not.
//
// Deliberately ONE rule. This is not a style config — it is a tripwire for
// references that cannot resolve. Adding stylistic rules here would create
// noise that trains people to ignore the output.

export default [{
  files: ['src/**/*.js'],
  languageOptions: {
    ecmaVersion: 2022, sourceType: 'module',
    globals: { console:'readonly', process:'readonly', Buffer:'readonly',
      setTimeout:'readonly', clearTimeout:'readonly', setInterval:'readonly',
      clearInterval:'readonly', URL:'readonly', URLSearchParams:'readonly',
      fetch:'readonly', AbortController:'readonly', TextEncoder:'readonly',
      TextDecoder:'readonly', crypto:'readonly', __dirname:'readonly',
      FormData:'readonly', Blob:'readonly' }
  },
  rules: { 'no-undef': 'error' }
}]
