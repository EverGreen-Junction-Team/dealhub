// The opportunities INSERT: every column must line up with its parameter.
//
// Run: node src/services/__tests__/oppParamAlignment.test.mjs
//
// WHY THIS EXISTS. upsertOpportunity binds 53 parameters positionally. Two of
// them — master_initial_enquiry and all_initial_enquiry — are declared LAST in
// the column list but were being supplied in the MIDDLE of the values array,
// right after upload_from_enquiry. Every parameter from $43 on therefore landed
// one column to the left:
//
//   custom_fields  <- master_initial_enquiry
//   raw_opportunity <- the enquiry history array
//   is_deleted     <- the custom-fields JSON blob     ← boolean column
//
// which Postgres rejected with
//   22P02 invalid input syntax for type boolean: "{"product_system":[...]}"
// rolling back the whole OpportunityUpdate transaction. Nothing was written,
// and the webhook logged "opportunity writer failed".
//
// It hid for as long as it did because NULL binds to any type: while those
// deals carried no custom fields the mismatched params were all null and
// Postgres never complained. It surfaced the moment a deal had real values.
//
// This test parses the statement rather than trusting the comments beside it:
// the column list's own note already SAID these two were last, and the array
// disagreed with it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const src = readFileSync(new URL('../stageHistoryWriter.js', import.meta.url), 'utf8');

const stripComments = (s) => s.replace(/--[^\n]*/g, '').replace(/\/\/[^\n]*/g, '');

// ---- the column list -------------------------------------------------------
const insertAt = src.indexOf('INSERT INTO opportunities');
assert.ok(insertAt > 0, 'the INSERT statement moved');
// Anchored on the real clause, not the phrase: an SQL comment inside the
// statement mentions "ON CONFLICT" too, and slicing at that cut the statement
// in half.
const conflictAt = src.indexOf('\n     ON CONFLICT', insertAt);
assert.ok(conflictAt > insertAt, 'the ON CONFLICT clause moved');
const stmt = src.slice(insertAt, conflictAt);
const colsRaw = stmt.slice(stmt.indexOf('(') + 1, stmt.indexOf('VALUES'));
const columns = stripComments(colsRaw)
  .replace(/\n/g, ' ')
  .split(',')
  .map((c) => c.trim().replace(/\)$/, ''))
  .filter(Boolean);

// ---- the values array ------------------------------------------------------
const arrStart = src.lastIndexOf('[', src.indexOf('p.meddic_1, p.meddic_2'));
const arrEnd = src.indexOf(']\n  );', arrStart);
assert.ok(arrStart > 0 && arrEnd > arrStart, 'the values array moved');

// Split on TOP-LEVEL commas only — several entries are calls or ternaries that
// contain commas of their own.
const splitTopLevel = (text) => {
  const out = [];
  let depth = 0;
  let cur = '';
  for (const ch of text) {
    if (ch === '(' || ch === '[') depth++;
    if (ch === ')' || ch === ']') depth--;
    if (ch === ',' && depth === 0) { out.push(cur); cur = ''; } else cur += ch;
  }
  if (cur.trim()) out.push(cur);
  return out.map((v) => v.replace(/\s+/g, ' ').trim()).filter(Boolean);
};
const values = splitTopLevel(stripComments(src.slice(arrStart + 1, arrEnd)));

// The last two columns are now(), now() — supplied by SQL, not bound.
const bound = columns.slice(0, -2);

let passed = 0;
const t = (name, fn) => { fn(); passed++; console.log(`  ok  ${name}`); };

t('every bound column has exactly one parameter', () => {
  assert.equal(
    bound.length, values.length,
    `${bound.length} columns vs ${values.length} values — a column was added `
    + 'without its parameter, or the reverse'
  );
});

t('the placeholder count matches the values supplied', () => {
  const highest = Math.max(
    ...[...stmt.matchAll(/\$(\d+)/g)].map((m) => Number(m[1]))
  );
  assert.equal(highest, values.length, `highest placeholder $${highest}, ${values.length} values`);
});

t('custom_fields and raw_opportunity get the JSONB blobs, not the enquiry pair', () => {
  // The exact swap that caused the 22P02.
  assert.match(values[bound.indexOf('custom_fields')], /customFields/);
  assert.match(values[bound.indexOf('raw_opportunity')], /rawOpportunity/);
});

t('is_deleted gets the boolean', () => {
  // This is the column that actually threw: it received the custom-fields JSON.
  const v = values[bound.indexOf('is_deleted')];
  assert.match(v, /markDeleted/);
  assert.doesNotMatch(v, /jsonbParam/);
});

t('the enquiry pair is bound LAST, where the column list declares it', () => {
  assert.match(values[bound.indexOf('master_initial_enquiry')], /master_initial_enquiry/);
  assert.match(values[bound.indexOf('all_initial_enquiry')], /enquiryHistory/);
});

t('every JSONB column is bound through jsonbParam', () => {
  // A raw JS array binds as a Postgres array literal ({"a","b"}), which JSONB
  // rejects with the same 22P02 — the trap that hid this bug's sibling.
  for (const col of ['client_type', 'product_system', 'product_type',
    'first_contact_method', 'custom_fields', 'raw_opportunity', 'all_initial_enquiry']) {
    assert.match(
      values[bound.indexOf(col)], /jsonbParam/,
      `${col} is JSONB and must be bound through jsonbParam`
    );
  }
});

// ---- all_initial_enquiry: NOT NULL on insert, preserved on update ----------
//
// 136 created the column JSONB NOT NULL DEFAULT '[]'. The parameter is NULL
// whenever there is nothing to append, and a DEFAULT does not apply to an
// explicitly supplied NULL — so a brand-new deal failed with
//   23502 null value in column "all_initial_enquiry"
// Migration 137 drops the constraint: NULL is the writer's "no append this
// turn" signal and has to survive to the ON CONFLICT clause.
//
// Two fixes were tried first and BOTH destroy data silently rather than
// erroring, so they are pinned here:
//
//   • binding '[]' instead of NULL     -> indistinguishable from a real empty
//                                          history; the ON CONFLICT COALESCE
//                                          then wipes the stored one every update
//   • COALESCEing $53 in the INSERT    -> EXCLUDED then carries that '[]' and
//     and reading EXCLUDED below          is never NULL, wiping it just the same

t('the INSERT binds the enquiry history parameter unchanged', () => {
  // The column is nullable (migration 137), so NULL — the writer's "no append
  // this turn" signal — reaches the SQL intact. Wrapping it here would make it
  // indistinguishable from a real empty history in the ON CONFLICT clause.
  assert.match(stmt, /\$52, \$53,/);
  assert.doesNotMatch(stmt, /COALESCE\(\$53/);
});

t('the UPDATE path reads the RAW parameter, never EXCLUDED', () => {
  const conflict = src.slice(conflictAt);
  const line = conflict.split('\n').find((l) => l.includes('all_initial_enquiry'));
  assert.ok(line, 'the all_initial_enquiry update clause moved');
  // EXCLUDED here would silently erase the history on every update.
  assert.doesNotMatch(line, /EXCLUDED/);
  assert.match(line, /COALESCE\(\$53, opportunities\.all_initial_enquiry\)/);
});

t('NULL still means "no append" at the binding', () => {
  // The signal has to survive to the SQL; '[]' here would erase the history.
  assert.match(values[bound.indexOf('all_initial_enquiry')], /undefined \? null :/);
});

console.log(`\n${passed} passed`);
