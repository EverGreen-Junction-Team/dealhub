// AI skills — the parts that must not be got wrong.
//
// A skill points the AI at a database view. It stores no SQL, but it DOES
// contribute identifiers that get interpolated into one, because SQL cannot
// parameterise a column name. Everything below exists to make that safe:
// validate the identifier, confirm it against the view's real catalogue entry,
// and refuse a view that could bypass row-level security.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const R = (p) => readFileSync(join(root, p), 'utf8');

const validator = R('src/services/ai/skillValidator.js');
const store     = R('src/services/ai/skillStore.js');
const bridge    = R('src/services/ai/tools/skillTools.js');
const loop      = R('src/services/ai/tools/toolLoop.js');
const migration = R('migrations/083_ai_skills.sql');
const control   = R('src/routes/control.js');

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// ── The RLS guarantee ────────────────────────────────────────────────
// A view without security_invoker runs as its OWNER and ignores RLS — one
// sub-account's data inside another's answer. Migration 042 exists because
// this was missed once on ordinary views; through a web form it would be
// worse. This is the single most important check in the feature.
t('a view without security_invoker is refused',
  /security_invoker/.test(validator) && /runs as its owner/i.test(validator));
t('the refusal explains the consequence, not just the rule',
  /read another's data/.test(validator));
t('a materialised view is refused',
  /relkind === 'm'/.test(validator) && /cannot enforce/.test(validator));
t('a table is refused — only a view carries the tenant filter',
  /is not a view/.test(validator));
t('the check reads the real catalogue, not a stored flag',
  /FROM pg_class/.test(validator) && /reloptions/.test(validator));

// ── Injection surface ────────────────────────────────────────────────
t('identifiers are constrained by regex', /const IDENT = \/\^\[a-z\]/.test(validator));
t('every param column is checked against the view',
  /columnSet\.has\(p\.column\)/.test(validator));
t('returned columns are still validated server-side', /columnSet\.has\(c\)/.test(validator));
// order_by is INTERPOLATED into the SQL, so this grammar is the injection
// boundary. It now also admits NULLS FIRST/LAST — needed because Postgres
// sorts NULLs FIRST under DESC, so a list ordered "value DESC" led with the
// rows whose value was missing. Still a fixed grammar: no expressions, no
// function calls, no second column.
t('order_by accepts only a column, a direction and an optional NULLS clause',
  /\^\(\[a-z\]\[a-z0-9_\]\*\)\(\\s\+\(asc\|desc\)\)\?\(\\s\+nulls\\s\+\(first\|last\)\)\?\$/.test(validator));
t('order_by still refuses an expression or a second column', (() => {
  const re = /^([a-z][a-z0-9_]*)(\s+(asc|desc))?(\s+nulls\s+(first|last))?$/i;
  return !re.test('count(*) DESC') && !re.test('value; DROP TABLE x')
      && !re.test('value DESC, id') && re.test('value DESC NULLS LAST');
})());
t('order_by column is checked against the view', /columnSet\.has\(m\[1\]\)/.test(validator));
t('operators come from a fixed set, never from input',
  /PARAM_OPS = new Set/.test(validator) && /Unsupported operator/.test(validator));
t('values are bound, not interpolated',
  /values\.push\(value\)/.test(store) && /\$\$\{values\.length\}/.test(store.replace(/\$\{/g, '$${')));
t('a contains filter wraps the value at bind time, not in the SQL',
  /value = `%\$\{String\(raw\)\}%`/.test(store));
t('no skill stores SQL', !/req\.body\.sql|skill\.sql\b/.test(store + control));

// ── The tool bridge ──────────────────────────────────────────────────
t('skills are prefixed so they cannot shadow a built-in',
  /const PREFIX = 'skill_'/.test(bridge));
t('the prefix reason is recorded', /would otherwise shadow/.test(bridge));
t('a broken skills table does not take the AI down',
  /could not load skills/.test(bridge) && /return \[\]/.test(bridge));
t('skills are surface-scoped', /surface/.test(bridge) && /surface/.test(loop));
t('the loop routes skill calls separately', /isSkillTool\(call\.name\)/.test(loop));
// toolCatalogue now takes the surface — the list is still ONE list, which is
// what this guards; it is just filtered before the skills are appended.
t('built-ins and skills share one tool list',
  /\[\.\.\.toolCatalogue\([^)]*\), \.\.\.skillTools\]/.test(loop));
t('no parameter is required — omitting one means "no filter"',
  /No `required`/.test(bridge));

// ── Schema ───────────────────────────────────────────────────────────
t('skill names are constrained to tool-name shape',
  /name\s+TEXT\s+NOT NULL\s*\n\s*CHECK \(name ~ '\^\[a-z\]/.test(migration));
t('a description is mandatory and non-trivial',
  /length\(trim\(description\)\) >= 20/.test(migration));
t('row limit is capped', /row_limit BETWEEN 1 AND 500/.test(migration));
t('surfaces are constrained to known values', /surfaces <@ ARRAY\['deal', 'portfolio'\]/.test(migration));
t('the table is RLS-protected',
  /ENABLE ROW LEVEL SECURITY/.test(migration) && /CREATE POLICY tenant_iso/.test(migration));
t('names are unique per location', /UNIQUE \(location_id, name\)/.test(migration));

// ── Behaviour at query time ──────────────────────────────────────────
t('the row limit is re-clamped at run time, not trusted from the row',
  /Math\.min\(skill\.rowLimit \|\| 50, 500\)/.test(store));
t('a bad number is reported rather than silently dropped',
  /must be a number/.test(store));
t('a dropped or altered view fails as a setup problem, not a retry',
  /not something to retry or reword/.test(store));
t('usage tracking cannot fail a question', /markUsed\(.*\)\.catch\(\(\) => \{\}\)/.test(store));
t('an update validates the MERGED skill, not just the patch',
  /\{ \.\.\.existing, \.\.\.patch \}/.test(store));

// ── The form's affordances ───────────────────────────────────────────
t('the API exposes a view\'s real columns for the form',
  /skills\/views\/:name/.test(control));
t('validation errors name the offending field',
  /field: err\.field/.test(control));

// ── The @-mention picker ─────────────────────────────────────────────
// Reps pick skills by typing @. The list must come from a REP-facing endpoint,
// not the admin one — a sales rep has no business seeing view names, column
// mappings or SQL operators.
const aiRoutes = R('src/routes/ai.js');
const dash = (p) => readFileSync(join(root, '..', '..', 'pipelinePulse-dashboard', p), 'utf8');

t('there is a rep-facing skills endpoint', /aiRouter\.get\('\/skills'/.test(aiRoutes));
t('it returns only a name and a description',
  /skills: skills\.map\(\(s\) => \(\{\s*name: s\.name,/.test(aiRoutes));
t('it leaks no view name to a rep',
  !/viewName/.test(aiRoutes.slice(aiRoutes.indexOf("aiRouter.get('/skills'"),
                                  aiRoutes.indexOf("aiRouter.post('/portfolio/ask'"))));
t('it is scoped to the portfolio surface',
  /surface: 'portfolio'/.test(aiRoutes));
t('it returns only enabled skills', /enabledOnly: true/.test(aiRoutes));

// The @-mention PICKER is Insights AI only. Deal AI can now run skills (the
// deal surface got the tool loop), so the old reason — "a menu there would
// offer things that silently do nothing" — no longer holds. The picker is
// still not mounted there, deliberately: only 3 skills carry the 'deal'
// surface today, and a menu listing three entries is worse than typing the
// question. Revisit when that number grows.
// Guarded with existsSync, not try/catch: production runs a server-only clone
// and an unguarded read fails the whole suite (see crossRepoReads.test.mjs).
// A silent skip is just as bad — it looks identical to a passing test — so it
// says so.
const dashRoot = join(root, '..', '..', 'pipelinePulse-dashboard');
const haveDash = existsSync(join(dashRoot, 'src/pages/dealhub/SkillMentions.jsx'));

if (!haveDash) {
  console.log('  (dashboard not checked out — skipping the @-mention UI assertions)');
}

if (haveDash) {
  const mentions = dash('src/pages/dealhub/SkillMentions.jsx');
  const copilot  = dash('src/pages/tabs/CopilotTab.jsx');
  const askDeal2 = dash('src/pages/dealhub/AskDeal.jsx');

  t('the picker is mounted in Insights AI', /SkillMentions/.test(copilot));
  t('the picker is NOT mounted in Deal AI', !/SkillMentions/.test(askDeal2));
  t('an empty list says so rather than doing nothing', /No skills yet/.test(mentions));
  t('the empty state says where skills come from', /Control panel/.test(mentions));
  t('an email address does not open the menu', /if \(before && !\/\\s\/\.test\(before\)\)/.test(mentions));
  // A space no longer closes the menu outright: skill names are several words
  // ("response time by rep"), and refusing any space meant a multi-word search
  // could never reach the matcher. It still cannot stay open forever, or an @
  // mid-sentence would hold a menu over the rest of the question.
  t('the menu survives a space but closes once it stops looking like a name',
    /words\.length > 3/.test(mentions)
    && /\[\.,;:!\?\]\\s\*\$/.test(mentions)
    && /\\s\\s\$/.test(mentions));
  // The comment wraps across lines in both files, so normalise before matching.
  const prose = (mentions + copilot).replace(/\s*\n\s*\/\/\s*/g, ' ').replace(/\s+/g, ' ');
  t('the mention is inserted as plain text, not a hidden parameter',
    /strong hint, not a separate instruction channel/.test(prose));
  t('skills are fetched on first use, not on every page load',
    /Fetched on the first @/.test(copilot));
}

// ── The columns list must survive JSON ───────────────────────────────
// describeView returned `columns` as a Set. Membership checks need one, but
// the same value is sent to the form by GET /skills/views/:name — and
// JSON.stringify turns a Set into {}. The form got an object with no .length,
// so its truthiness check hid the entire form and the status line read
// "columns" with no number. Two names now, each for its own caller.
t('describeView returns columns as an array', /columns: names/.test(validator));
t('it also returns a Set for membership checks', /columnSet: new Set\(names\)/.test(validator));
t('nothing sends a Set to JSON', !/columns: new Set/.test(validator));
t('validateSkill uses the Set, not the array',
  /const \{ columns, columnSet \} = await describeView/.test(validator));

// The actual serialisation, proven rather than asserted about.
t('an array survives JSON with its length intact',
  JSON.parse(JSON.stringify({ c: ['a', 'b'] })).c.length === 2);
t('a Set does not — which is the bug',
  JSON.parse(JSON.stringify({ c: new Set(['a', 'b']) })).c.length === undefined);

// ── The view describes itself ────────────────────────────────────────
// Whoever writes the view already describes it in a COMMENT. Asking someone
// to write that again on the form is duplicated work that goes out of sync
// the first time the view changes.
t('the view comment is read', /obj_description/.test(validator));
t('column comments are read', /col_description/.test(validator));
t('both are returned to the form', /viewComment/.test(validator) && /columnComments/.test(validator));
t('the route passes them on', /columnComments, viewComment/.test(control));
t('column order is the view\'s own, not alphabetical',
  /ORDER BY c\.ordinal_position/.test(validator));

const cmts = R('migrations/085_vw_close_without_win_comments.sql');
t('every column of the sample view is documented',
  (cmts.match(/COMMENT ON COLUMN/g) || []).length === 6);
t('pct_of_closed says what it is a percentage OF',
  /Not a percentage of deals that ENTERED the stage/.test(cmts));

if (haveDash) {
  const sk = dash('src/pages/control/SkillsSection.jsx');
  t('the form offers the view comment as the starting description',
    /setForm\(\(f\) => \(f\.description\.trim\(\)/.test(sk));
  t('it never overwrites something already typed',
    /overwriting something someone typed/.test(sk));
  // The COLUMN pickers are gone — filters and sort are no longer edited in
  // this form (they are still stored, and still sent on save). So there is
  // nothing left to hang a per-column tooltip on. What replaced it is the
  // VIEW's own comment, which now has two jobs: the starting description, as
  // above, and the second line of each option in the view dropdown — so a
  // view is recognised by what it does, not by its name alone.
  t('the view dropdown shows each view\'s own comment', /\{v\.comment\}/.test(sk));
}

// ── location_id is never returned or offered ─────────────────────────
// A skill only runs inside withTenant(), so every row already belongs to the
// one sub-account asking. The column is constant across the result: returning
// it repeats a known value on every row, and offering it as a filter invites
// one that can only match everything or nothing.
t('location_id is dropped from the select list',
  /filter\(\(c\) => c !== 'location_id'\)/.test(store));
t('the reason is recorded where the filter is',
  /already belongs to the one sub-account asking/.test(store));
// Strip comments first: the file EXPLAINS why it does not use SELECT *, and
// matching that sentence is not the same as matching the code.
const storeCode = store.replace(/^\s*\/\/.*$/gm, '');
t('no skill selects *', !/SELECT \*/.test(storeCode) && !/viewName\}\.\*/.test(storeCode));

// Columns are resolved once, at save time — a catalogue lookup on every
// question would be three extra queries for something that changes only with
// a migration.
t('columns are resolved when the skill is saved', /async function resolveColumns/.test(store));
t('createSkill resolves them', /columns: await resolveColumns/.test(store));
// Columns are resolved at SAVE time for speed, but an empty stored list has
// to fall back to the view rather than fail — a skill saved before that
// resolution existed, or a view that gained a column since, both leave it
// empty. Failing told a rep the view "has no columns available" about a view
// that plainly has six.
t('an empty stored column list falls back to the view',
  /if \(!columns\.length\)/.test(store) && /await describeView/.test(store));
t('a skill with no usable columns fails loudly', /has no columns to return/.test(store));

if (haveDash) {
  const sk2 = dash('src/pages/control/SkillsSection.jsx');
  t('the column picker is gone', !/ColumnChips/.test(sk2));
  // location_id used to be filtered out of the form's column list. There is
  // no column list any more, so the UI cannot be where this is guaranteed —
  // and it never should have been: a form is not a security boundary.
  // skillStore.js strips it when it builds the SELECT, which is the only
  // place it actually matters, and that is asserted directly below.
  t('location_id is stripped where the SELECT is built',
    /columns\.filter\(\(c\) => c !== 'location_id'\)/.test(store));
  t('the form sends an empty column list so the server resolves it',
    /columns: \[\],/.test(sk2));
}

// ── Skill rows reach the UI ──────────────────────────────────────────
const loop2 = R('src/services/ai/tools/toolLoop.js');
const portfolio = R('src/services/ai/askPortfolio.js');
t('the loop captures skill rows', /skillRows: Array\.isArray\(out\?\.rows\)/.test(loop2));
t('it records which view they came from', /skillSource: out\?\.source/.test(loop2));
t('the answer carries the last skill result', /skillResult/.test(portfolio));
t('the last call wins, not the first', /reverse\(\)\.find\(\(c\) => c\.skillRows/.test(portfolio));
t('the skill_ prefix is stripped for display', /replace\(\/\^skill_\/, ''\)/.test(portfolio));

if (haveDash) {
  const chart = dash('src/pages/shared/SkillResult.jsx');
  t('there is a chart for skill rows', /export default function SkillResult/.test(chart));
  t('it can expand to full screen', /aria-modal="true"/.test(chart));
  t('Escape closes it', /e\.key === 'Escape'/.test(chart));
  // A percentage as the bar was a real bug: three stages of 48/20/16 deals
  // sum to 84, while their pct_lost_in_stage of 27/70/100 sums to 197 — so
  // the ratio won and the chart drew it as if it were volume.
  t('a percentage is never the bar', /const isPct = /.test(chart)
    && /const pool = counts\.length \? counts :/.test(chart));
  // A running total only ever rises and a change column goes negative —
  // neither can be a bar without misleading, so they are excluded from the
  // FALLBACK too, not just the preferred list. On the forecast growth view
  // both real measures were money, the preferred list came back empty, and
  // the fallback charted won_cumulative: a rising line across three months in
  // which revenue fell.
  t('a running total or a signed change is never the bar, even as a fallback',
    /const isCumulative = /.test(chart) && /const isDelta = /.test(chart)
    && /safeFallback = numeric\.filter\(\(c\) => !isCumulative\(c\) && !isDelta\(c\)\)/.test(chart));
  // Scaling to the column total makes a 3-of-150 row an invisible sliver.
  t('bars scale to the largest row, not the total',
    /Math\.max\(\.\.\.rows\.map/.test(chart));
  t('window-function totals are dropped', /new Set\(rows\.map/.test(chart));
  // Segments are now the longest SUBSET of the other counts that sums to the
  // measure, not all of them. Requiring every remaining count to add up meant
  // one unrelated total nearby (a window-function per-account figure) killed
  // the split and drew a flat bar.
  t('segments must sum to the measure before stacking',
    /const sumsTo = \(cand\) => cand\.length >= 2 && rows\.every/.test(chart));
  t('segments are a subset, so an unrelated total does not kill the split',
    /combinations\(others, size\)/.test(chart));
  t('an unchartable view falls back to a table', /function Rows\(/.test(chart));
}

// A failed skill must not be quietly replaced by other tools. The model
// answered "I can approximate this instead using get_pipeline_summary" — which
// answers a DIFFERENT question than the one the rep asked, without saying so.
t('every skill error forbids substituting other tools',
  (store.match(/Do not answer the question with other tools instead/g) || []).length === 3);
t('the no-columns error names the view', /exposes nothing beyond location_id/.test(store));

// ── The tenant filter is in the QUERY, not just the policy ───────────
// Production connects as a role with rolbypassrls = true, so every RLS policy
// is skipped. The 37 hand-written tools in registry.js survive that because
// each carries `location_id = $1` in its own SQL — a skill had no predicate at
// all, so it was the one query in the system relying on RLS alone, and it
// returned every sub-account's rows.
t('runSkill filters by location in the SQL',
  /where\.unshift\(`location_id = \$\$\{values\.length\}`\)/.test(store.replace(/\$\{/g, '$${')));
t('the tenant value is bound, not interpolated', /values\.push\(locationId\)/.test(store));
t('the reason is recorded where the predicate is',
  /rolbypassrls = true/.test(store));
t('the view must expose location_id', /has no location_id column/.test(validator));
t('that is refused at save time, not at query time',
  /columnSet\.has\('location_id'\)/.test(validator));

// Placeholder numbering must survive prepending the clause: $n binds to the
// value pushed at position n, whatever order the clauses appear in.
const where = []; const values = [];
values.push('%quote%'); where.push(`stage_name = $${values.length}`);
values.push(3);         where.push(`closed_without_win = $${values.length}`);
values.push('LOC');     where.unshift(`location_id = $${values.length}`);
t('the tenant placeholder binds to the tenant value', values[2] === 'LOC');
t('user filters keep their own placeholders',
  where.join(' ').includes('stage_name = $1') && where.join(' ').includes('closed_without_win = $2'));
t('the tenant clause comes first in the WHERE', where[0].startsWith('location_id'));

// An empty skill result is an ANSWER, not a fault. The model described the
// same zero-row case two different wrong ways — "no record in the system"
// (it is one sub-account) and "no data came back from that view" (sounds
// broken) — because an empty array carries no way to tell them apart.
t('an empty result carries a note', /rows\.length === 0 \? \{/.test(store));
t('it says an empty result is not a failure', /not a failure/.test(store));
t('it forbids blaming the view', /not "the view returned nothing"/.test(store));
t('it forbids claiming the whole system is empty',
  /only this\s*'\s*\+\s*'sub-account was searched|only this .*sub-account was searched/
    .test(store.replace(/\n\s*/g, ' ')));
t('a non-empty result carries no note',
  store.indexOf('rows.length === 0 ?') > store.indexOf('count: rows.length'));

// ── Window functions must be partitioned by sub-account ──────────────
// 086 wrote `sum(...) OVER ()`, which is the whole result set. Under RLS the
// result set IS one sub-account, so it tested clean — and was wrong the
// moment RLS did not apply, which is this database's actual state (the app
// connects with rolbypassrls = true). BGD's nine stages sum to 160; the view
// reported 305, every account added together, and every percentage was
// computed against that. The top stage read 17% when it is 33%.
const partitionMig = R('migrations/087_vw_close_without_win_partition.sql');
const sqlOnly = partitionMig.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
t('no window function is left unpartitioned', !/OVER \(\s*\)/.test(sqlOnly));
t('every window is partitioned by location',
  (sqlOnly.match(/OVER \(PARTITION BY location_id\)/g) || []).length === 4);
t('the view keeps security_invoker', /security_invoker = true/.test(sqlOnly));
t('the reason is recorded for the next person', /rolbypassrls = true/.test(partitionMig));

// The arithmetic the bug got wrong, pinned.
const bgd = [53, 27, 21, 16, 16, 13, 10, 3, 1];
const total = bgd.reduce((a, b) => a + b, 0);
t('BGD stages sum to its own total, not every account\'s', total === 160);
t('the top stage is a third of BGD losses, not a sixth',
  Math.round(100 * 53 / total) === 33);

// ── Option lists get real markers ────────────────────────────────────
// The model writes bare lines and the reply says "reply with a number", so
// the renderer numbers them. The first version required a CAPITAL first
// letter and broke on "iMessage" — a real sender name — which split the run
// and left the whole list unnumbered.
if (haveDash) {
  const md = dash('src/pages/dealhub/MarkdownAnswer.jsx');
  t('bare option lines are numbered', /function numberOptions/.test(md));
  t('a lowercase product name still matches', /\[A-Za-z\]/.test(md));
  t('the reason is recorded', /Product names do not agree to be capitalised/.test(md));
  t('numbering only fires when a number was asked for',
    /reply with \(a \|the \)\?number/.test(md));
  t('a run of two is left alone', /run\.length >= 3/.test(md));

  // The regex itself, against the real sender names.
  const m = md.match(/const BARE_OPTION = (\/.*\/);/);
  if (m) {
    const re = new RegExp(m[1].slice(1, -1));
    for (const name of ['SMS (native)', 'iMessage', 'WhatsApp QR', 'SMS Android']) {
      t(`"${name}" is recognised as an option`, re.test(name));
    }
    t('prose is not', !re.test('Found the contact — bindu (lead, phone +916301199891).'));
  }
}

// ── An email draft gets a real editor ────────────────────────────────
// The body is sent to GHL as `html` and rendered as HTML, but the card gave a
// plain textarea — so a rep could write a paragraph and nothing else: no
// bold, no link, no list, and a line break that may not survive.
if (haveDash) {
  const cardSrc = dash('src/pages/shared/ActionCard.jsx');
  t('email content uses the shared rich editor', /<RichEditor/.test(cardSrc));
  t('it is lazy-loaded like the note and task dialogs',
    /React\.lazy\(\(\) => import\('\.\/RichEditor'\)\)/.test(cardSrc));
  t('it has a sized fallback so the card does not jump',
    /React\.Suspense/.test(cardSrc) && /minHeight: 120/.test(cardSrc));
  t('SMS and WhatsApp keep a plain textarea',
    /isEmail \? \(/.test(cardSrc) && /<textarea/.test(cardSrc));
  t('the reason plain-text channels stay plain is recorded',
    /formatting controls there would offer something the channel/.test(cardSrc));
  t('the editor writes back to html, not message',
    /onChange=\{\(html\) => setField\('html', html\)\}/.test(cardSrc));
  // The model puts the body in `html` OR `message`; both must reach the editor.
  t('plain text from the model still opens in the editor',
    /fields\.html \|\| fields\.message \|\| ''/.test(cardSrc));
}

// ── The skill registry ───────────────────────────────────────────────
// data/skills/registry.json is the one list someone reads to know what
// exists. It is only useful while it agrees with the definition files and the
// migrations — a registry that has drifted is worse than none, because it is
// believed.
const registry = JSON.parse(R('data/skills/registry.json'));
t('the registry lists every skill file',
  registry.skills.length ===
    readdirSync(join(root, 'data/skills')).filter((f) => f !== 'registry.json').length);

for (const entry of registry.skills) {
  const def = JSON.parse(R(entry.file));
  t(`${entry.skill}: registry name matches its file`, def.name === entry.skill);
  t(`${entry.skill}: registry view matches its file`, def.viewName === entry.view);
  t(`${entry.skill}: the view's migration exists`,
    readdirSync(join(root, 'migrations'))
      .some((f) => f.startsWith(entry.migration.slice(0, 3))));
  t(`${entry.skill}: the name is a valid tool name`,
    /^[a-z][a-z0-9_]{2,48}$/.test(entry.skill));
  t(`${entry.skill}: has a human title`, !!entry.title && entry.title !== entry.skill);
}

// Cross-references between descriptions must name skills that exist — a
// pointer to a renamed skill sends the model looking for nothing.
const allNames = registry.skills.map((s) => s.skill);
for (const entry of registry.skills) {
  const def = JSON.parse(R(entry.file));
  for (const m of def.description.matchAll(/\b([a-z][a-z0-9_]{10,})\s+skill\b/g)) {
    t(`${entry.skill}: points at a real skill (${m[1]})`, allNames.includes(m[1]));
  }
}

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL: ${f}`); process.exit(1); }
