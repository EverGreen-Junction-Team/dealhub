// The initial enquiry, and the history behind it.
//
// GHL gets a `master_initial_enquiry` opportunity custom field that the
// lead-source automations write into. It is OVERWRITTEN on each new enquiry,
// so without preserving the old value the earlier wording is gone the moment
// a customer enquires again — and a second enquiry is usually a changed
// scope, which is exactly what a rep needs to see.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const writer = readFileSync(join(root, 'src/services/stageHistoryWriter.js'), 'utf8');
const migration = readFileSync(join(root, 'migrations/136_initial_enquiry.sql'), 'utf8');
// 136 created the column NOT NULL DEFAULT '[]'. A DEFAULT applies only when a
// column is OMITTED, and upsertOpportunity always names it — so every INSERT
// of a new deal failed with 23502 until 137 dropped the constraint. NULL has
// to reach the SQL: it is the writer's "no append this turn" signal.
const nullable = readFileSync(join(root, 'migrations/137_enquiry_history_nullable.sql'), 'utf8');
const deals = readFileSync(join(root, 'src/routes/deals.js'), 'utf8');

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// ── Schema ───────────────────────────────────────────────────────────
t('both columns are added', /master_initial_enquiry TEXT/.test(migration)
  && /all_initial_enquiry\s+JSONB/.test(migration));
t('the history defaults to an empty array when the column is omitted',
  /DEFAULT '\[\]'::jsonb/.test(migration));
t('the migration is re-runnable', (migration.match(/IF NOT EXISTS/g) || []).length >= 3);

// ── The append rule ──────────────────────────────────────────────────
const fn = writer.slice(
  writer.indexOf('async function enquiryHistoryFor'),
  writer.indexOf('async function upsertOpportunity')
);

t('it reads the row BEFORE the upsert overwrites it',
  writer.indexOf('const enquiryHistory = await enquiryHistoryFor') <
  writer.indexOf('INSERT INTO opportunities'));

// THE FOUR WAYS THIS GOES WRONG, each one a silent corruption:
t('a field GHL did not send is not a change',
  /if \(incoming === undefined\) return undefined/.test(fn));
t('the same text arriving again does not append',
  /if \(\(prev \|\| ''\) === \(next \|\| ''\)\) return undefined/.test(fn));
t('an empty previous value is not worth keeping',
  /if \(!prev \|\| !String\(prev\)\.trim\(\)\) return undefined/.test(fn));
t('a replayed change does not duplicate the entry',
  /hist\.some\(\(e\) => e && e\.text === prev\)/.test(fn));

t('the OLD value is what gets appended, not the new one',
  /\[\.\.\.hist, \{ text: prev/.test(fn));
t('a deal we have not seen has nothing to preserve',
  /if \(!rows\.length\) return undefined/.test(fn));

// ── The write ────────────────────────────────────────────────────────
t('an event without the field leaves the enquiry alone',
  /master_initial_enquiry\s+= COALESCE\(EXCLUDED\.master_initial_enquiry, opportunities\.master_initial_enquiry\)/.test(writer));
// $53, NOT EXCLUDED — and the difference is the whole point.
//
// all_initial_enquiry is JSONB NOT NULL DEFAULT '[]', and a DEFAULT does not
// apply to an explicitly supplied NULL, so the INSERT column list has to
// COALESCE the parameter to '[]' or every new deal fails with 23502. That
// makes EXCLUDED.all_initial_enquiry never NULL — so reading it here would
// always pick '[]' and ERASE the stored history on every update. The raw
// parameter is the only place the "no append this turn" signal survives.
t('and leaves the history alone',
  /all_initial_enquiry\s+= COALESCE\(\$53, opportunities\.all_initial_enquiry\)/.test(writer));
t('the history column is nullable, so NULL can mean "no append"',
  /ALTER COLUMN all_initial_enquiry DROP NOT NULL/.test(nullable));
t('the history is bound as JSONB',
  /jsonbParam\(enquiryHistory\)/.test(writer));

// PLACEHOLDER ALIGNMENT. The columns were first added mid-list while their
// params went on the end, which silently shifted every column after position
// 42 — values would have landed in the wrong columns.
{
  const ins = writer.slice(writer.indexOf('INSERT INTO opportunities'),
                           writer.indexOf('ON CONFLICT (location_id, opportunity_id)'));
  const colBlock = ins.slice(ins.indexOf('('), ins.indexOf('VALUES'));
  const cols = colBlock.replace(/--[^\n]*/g, '').replace(/[()]/g, '')
    .split(',').map((c) => c.trim()).filter(Boolean);
  t('master_initial_enquiry sits at the position its placeholder binds',
    cols.indexOf('master_initial_enquiry') + 1 === 52);
  t('all_initial_enquiry sits at the position its placeholder binds',
    cols.indexOf('all_initial_enquiry') + 1 === 53);
}

// ── The API ──────────────────────────────────────────────────────────
t('the deal detail returns the current enquiry', /initialEnquiry: d\.master_initial_enquiry/.test(deals));
t('and the earlier ones', /earlierEnquiries: Array\.isArray\(d\.all_initial_enquiry\)/.test(deals));
t('an absent history reads as empty, not null',
  /Array\.isArray\(d\.all_initial_enquiry\) \? d\.all_initial_enquiry : \[\]/.test(deals));

// ── Nothing is written back to GHL ───────────────────────────────────
// A second custom field there would be one more thing for the automation to
// maintain, and our write would fire an OpportunityUpdate that looks like a
// rep's edit — so the next sync could append our own append.
t('all_initial_enquiry is never sent to GHL',
  !/all_initial_enquiry/.test(readFileSync(join(root, 'src/services/opportunityPatch.js'), 'utf8')));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
