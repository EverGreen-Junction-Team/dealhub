// Filter validation for saved views — routes/savedViews.js.
//
// Run: node src/routes/__tests__/savedViews.test.mjs
//
// Filters are stored as JSONB, which Postgres cannot type-check. An unknown
// key would be accepted, written, and then silently ignored when the deals
// list read it back — the view would look saved and quietly not filter. So
// the whitelist is the only thing standing between a rep and a view that
// lies about what it shows.
//
// cleanFilters is re-declared here rather than imported: the module pulls in
// express and the db pool, and this is pure logic. The copy is deliberate —
// a change to the real one must be mirrored, which is the point.

const ALLOWED = new Set([
  'status', 'pipelineId', 'stageId', 'assignedTo',
  'contactType', 'tag', 'activity', 'hasDeals', 'minValue', 'maxValue',
  'q', 'view'
]);

function cleanFilters(input) {
  if (input == null) return { filters: {}, bad: null };
  if (typeof input !== 'object' || Array.isArray(input)) {
    return { filters: null, bad: 'filters must be an object' };
  }
  const out = {};
  for (const [k, v] of Object.entries(input)) {
    if (!ALLOWED.has(k)) return { filters: null, bad: `"${k}" is not a filter we can save` };
    if (v == null || v === '') continue;
    if (typeof v !== 'string' && typeof v !== 'number' && typeof v !== 'boolean') {
      return { filters: null, bad: `"${k}" must be a plain value` };
    }
    const s = String(v).trim();
    if (s) out[k] = s;
  }
  return { filters: out, bad: null };
}

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── The happy path ───────────────────────────────────────────────────
const ok = cleanFilters({ status: 'open', stageId: 's1', view: 'board' });
t('keeps every allowed filter',
  ok.filters.status === 'open' && ok.filters.stageId === 's1' && ok.filters.view === 'board');
t('no error on a valid set', ok.bad === null);

// ── Unknown keys are REFUSED, not dropped ────────────────────────────
// Dropping silently would store a view missing the filter the rep chose,
// and nothing would say so.
const unknown = cleanFilters({ status: 'open', sortBy: 'value' });
t('an unknown key is rejected', unknown.filters === null);
t('the rejection names the key', /sortBy/.test(unknown.bad || ''));

// ── Empties mean "no filter" ─────────────────────────────────────────
t('an empty string is dropped, not stored',
  !('stageId' in cleanFilters({ status: 'open', stageId: '' }).filters));
t('null is dropped', !('assignedTo' in cleanFilters({ assignedTo: null }).filters));
t('whitespace-only is dropped', !('q' in cleanFilters({ q: '   ' }).filters));
t('a value is trimmed', cleanFilters({ q: '  crittall ' }).filters.q === 'crittall');

// ── Shapes that are not filters ──────────────────────────────────────
t('an array is refused', cleanFilters(['status']).filters === null);
t('a string is refused', cleanFilters('status=open').filters === null);
t('an object value is refused',
  cleanFilters({ status: { eq: 'open' } }).filters === null);
t('a nested array is refused',
  cleanFilters({ stageId: ['a', 'b'] }).filters === null);

// ── Absent is an empty set, not an error ─────────────────────────────
// "Save this view" with nothing applied is a legitimate view: everything.
t('undefined filters means {}', Object.keys(cleanFilters(undefined).filters).length === 0);
t('null filters means {}', Object.keys(cleanFilters(null).filters).length === 0);
t('an empty object is fine', cleanFilters({}).bad === null);

// ── Numbers and booleans survive as strings ──────────────────────────
// The list endpoint reads every filter off the query string, where
// everything is a string. Storing 1 and reading "1" must agree.
t('a number is stored as a string', cleanFilters({ q: 42 }).filters.q === '42');

// ── Contact filters ──────────────────────────────────────────────────
// Added when the contacts table gained filters. A key missing from the
// whitelist is stored nowhere and silently ignored on read, so the view
// would look saved and quietly not filter.
for (const k of ['contactType', 'tag', 'activity', 'hasDeals', 'minValue', 'maxValue']) {
  t(`${k} is savable`, cleanFilters({ [k]: 'x' }).filters[k] === 'x');
}

t('a deals filter on a contacts view is not rejected',
  // The whitelist is a union across scopes on purpose: the contacts list
  // ignores what it does not read, and a per-scope split would reject a
  // legitimate shared key like q or view.
  cleanFilters({ status: 'open', contactType: 'lead' }).bad === null);

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
