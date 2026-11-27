import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  PROJECT_STAGES, REMEDIAL_STAGES, normaliseStageName, stageKeyForName,
  matchPipelineStages, nextStageKey, templateSteps, parseHours, STEP_TEMPLATES
} from '../opsStages.js';
import * as decisions from '../opsDecisions.js';

// Operations Hub slice 1 — see docs/operations-hub-plan.md.

test('the stages are the ones in the plan, in order', () => {
  assert.deepEqual(PROJECT_STAGES.map((s) => s.name), [
    'Deposit', 'Ordering', "Fitter's drawing", 'Deliveries & check', 'Installation',
    'Snagging', 'Balance & completion', 'Aftercare', 'Job analysis'
  ]);
  assert.deepEqual(REMEDIAL_STAGES.map((s) => s.name), [
    'Reported', 'Parts to order', 'Parts ordered', 'Ready to book', 'Visit booked', 'Fixed and closed'
  ]);
});

test('GHL stage names match loosely: case, &/and, apostrophes, spacing', () => {
  assert.equal(stageKeyForName('project', "Fitter's drawing"), 'fitters_drawing');
  assert.equal(stageKeyForName('project', 'FITTERS  DRAWING'), 'fitters_drawing');
  assert.equal(stageKeyForName('project', 'Fitter’s Drawing'), 'fitters_drawing');
  assert.equal(stageKeyForName('project', 'Deliveries and Check'), 'deliveries_check');
  assert.equal(stageKeyForName('remedial', 'Fixed & closed'), 'fixed_closed');
  assert.equal(normaliseStageName('Balance & completion'), 'balance and completion');
});

test('a name that is not a stage is never guessed', () => {
  assert.equal(stageKeyForName('project', 'Install'), null);
  assert.equal(stageKeyForName('project', ''), null);
  assert.equal(stageKeyForName('project', null), null);
  // A remedial stage is not a project stage.
  assert.equal(stageKeyForName('project', 'Reported'), null);
});

test('a pipeline check names what is missing and what is extra', () => {
  const stages = PROJECT_STAGES.map((s, i) => ({ stage_id: `s${i}`, name: s.name }));
  assert.equal(matchPipelineStages('project', stages).ok, true);
  const short = stages.filter((s) => s.name !== 'Aftercare').concat([{ stage_id: 'x', name: 'Warranty' }]);
  const m = matchPipelineStages('project', short);
  assert.equal(m.ok, false);
  assert.deepEqual(m.missing, ['Aftercare']);
  assert.deepEqual(m.extra, ['Warranty']);
  assert.equal(m.byKey.deposit, 's0');
});

test('a duplicated stage name maps once; the second is reported extra', () => {
  const m = matchPipelineStages('remedial', [
    { stage_id: 'a', name: 'Reported' }, { stage_id: 'b', name: 'reported' }
  ]);
  assert.equal(m.byKey.reported, 'a');
  assert.deepEqual(m.extra, ['reported']);
});

test('next stage, and none after the last', () => {
  assert.equal(nextStageKey('project', 'deliveries_check'), 'installation');
  assert.equal(nextStageKey('project', 'job_analysis'), null);
  assert.equal(nextStageKey('remedial', 'parts_ordered'), 'ready_to_book');
  assert.equal(nextStageKey('remedial', 'nope'), null);
});

test('every template belongs to a real stage', () => {
  for (const [kind, byStage] of Object.entries(STEP_TEMPLATES)) {
    const keys = (kind === 'project' ? PROJECT_STAGES : REMEDIAL_STAGES).map((s) => s.key);
    for (const k of Object.keys(byStage)) assert.ok(keys.includes(k), `${kind}.${k}`);
  }
  assert.ok(templateSteps('remedial', 'parts_ordered').includes('Send client update'));
  assert.deepEqual(templateSteps('project', 'nope'), []);
});

test('hours: more than 0, at most 24, quarter hours', () => {
  assert.equal(parseHours('1.0'), 1);
  assert.equal(parseHours(0.5), 0.5);
  assert.equal(parseHours('2.3'), 2.25);
  assert.equal(parseHours(24), 24);
  for (const bad of [0, -1, 24.5, 'abc', '', null, undefined, 0.1]) {
    assert.equal(parseHours(bad), null, String(bad));
  }
});

// ── The decision seams ───────────────────────────────────────────────

test('open client questions are open: no start, manual numbers, Deal Hub task links', () => {
  assert.equal(decisions.START_PROJECT, null);
  assert.equal(decisions.JOB_NUMBER_SOURCE, null);
  assert.equal(decisions.REMEDIAL_REF_FORMAT, null);
  assert.equal(decisions.TASK_LINK_STORE, 'dealhub');
  const snap = decisions.decisionsSnapshot();
  assert.equal(snap.canStartProject, false);
  assert.equal(snap.jobNumbersAreManual, true);
  assert.deepEqual(snap.pending, ['Q1', 'Q2', 'Q4']);
  assert.equal(decisions.resolveJobNumber('TBCG-20049', {}), 'TBCG-20049');
  assert.equal(decisions.resolveJobNumber(null, {}), null);
});

test('nothing outside the seam reads the raw decision values', () => {
  // The answers drop into opsDecisions.js and nowhere else.
  const route = readFileSync(new URL('../../routes/operations.js', import.meta.url), 'utf8');
  const store = readFileSync(new URL('../opsTaskStore.js', import.meta.url), 'utf8');
  assert.ok(!/JOB_NUMBER_SOURCE|REMEDIAL_REF_FORMAT/.test(route));
  assert.ok(!/START_PROJECT\s*=(?!=)/.test(route), 'the route must not set the decision');
  assert.match(store, /STORES\[TASK_LINK_STORE\]/);
});

test('starting a project answers "decision pending" while Q1 is open', () => {
  const route = readFileSync(new URL('../../routes/operations.js', import.meta.url), 'utf8');
  assert.match(route, /if \(START_PROJECT === null\) \{[\s\S]*?409, null, 'decision_pending'/);
});

// ── Route helpers (the route module needs config, so set it first) ───

process.env.DATABASE_URL ||= 'postgres://localhost/unused';
const ops = await import('../../routes/operations.js');

test('facts: only whitelisted keys, validated', () => {
  assert.deepEqual(ops.buildFactsPatch('project', { jobNumber: ' TBCG-20049 ', installStart: '2026-12-03' }),
    [['job_number', 'TBCG-20049'], ['install_start', '2026-12-03']]);
  assert.throws(() => ops.buildFactsPatch('project', { status: 'won' }), /cannot be changed here/);
  assert.throws(() => ops.buildFactsPatch('project', { installStart: '3 Dec' }), /date like/);
  assert.throws(() => ops.buildFactsPatch('remedial', { remedialKind: 'fitting' }), /product or other/);
  assert.throws(() => ops.buildFactsPatch('project', {}), /Nothing to change/);
  assert.deepEqual(ops.buildFactsPatch('project', { fitterName: '' }), [['fitter_name', null]]);
});

test('time entries: hours, date, activity from the list, and someone', () => {
  const ok = ops.buildTimeEntry('project', {
    hours: '1.5', workDate: '2026-11-19', activity: 'Supplier chasing', userId: 'u1', notes: 'Chased Sonas'
  });
  assert.deepEqual(ok, {
    hours: 1.5, work_date: '2026-11-19', activity: 'Supplier chasing',
    user_id: 'u1', worker_name: null, notes: 'Chased Sonas'
  });
  assert.equal(ops.buildTimeEntry('remedial', {
    hours: 1, workDate: '2026-11-19', activity: 'Site visit', workerName: 'Fitter 2'
  }).worker_name, 'Fitter 2');
  assert.throws(() => ops.buildTimeEntry('project', { hours: 1, workDate: '2026-11-19', activity: 'Lunch', userId: 'u' }), /activity/);
  assert.throws(() => ops.buildTimeEntry('project', { hours: 25, workDate: '2026-11-19', activity: 'Admin', userId: 'u' }), /at most 24/);
  assert.throws(() => ops.buildTimeEntry('project', { hours: 1, workDate: '2026-11-19', activity: 'Admin' }), /who did the work/);
  // A remedial activity is not a project one.
  assert.throws(() => ops.buildTimeEntry('remedial', { hours: 1, workDate: '2026-11-19', activity: 'Survey', userId: 'u' }), /activity/);
  // Partial edits touch only what was sent.
  assert.deepEqual(ops.buildTimeEntry('project', { hours: 2 }, { partial: true }), { hours: 2 });
});

test('a stage moves on only when its last open step is ticked, and it is current', () => {
  assert.equal(ops.shouldAdvance({ stepStageKey: 'a', currentStageKey: 'a', openInStage: 0, totalInStage: 3 }), true);
  assert.equal(ops.shouldAdvance({ stepStageKey: 'a', currentStageKey: 'a', openInStage: 1, totalInStage: 3 }), false);
  assert.equal(ops.shouldAdvance({ stepStageKey: 'a', currentStageKey: 'b', openInStage: 0, totalInStage: 3 }), false);
  assert.equal(ops.shouldAdvance({ stepStageKey: 'a', currentStageKey: null, openInStage: 0, totalInStage: 3 }), false);
  assert.equal(ops.shouldAdvance({ stepStageKey: 'a', currentStageKey: 'a', openInStage: 0, totalInStage: 0 }), false);
});

test('a job row reads its stage from the GHL stage name', () => {
  const j = ops.shapeJob('project', {
    opportunity_id: 'o1', deal_name: 'Laura Bell', current_stage_name: 'Deliveries & check',
    first_name: 'Laura', last_name: 'Bell', job_number: 'TBCG-20049', install_start: '2026-12-03',
    open_tasks: '2', overdue_tasks: '0', created_at: new Date()
  });
  assert.equal(j.stageKey, 'deliveries_check');
  assert.equal(j.jobNumber, 'TBCG-20049');
  assert.equal(j.installStart, '2026-12-03');
  assert.equal(j.openTasks, 2);
  assert.equal(j.hasRow, true);
  const r = ops.shapeJob('remedial', { opportunity_id: 'o2', current_stage_name: 'Weird', kind: 'product' });
  assert.equal(r.stageKey, null);
  assert.equal(r.remedialKind, 'product');
  assert.equal(r.hasRow, false);
});

test('every ops table is location-scoped with RLS', () => {
  const sql = readFileSync(new URL('../../../migrations/146_operations.sql', import.meta.url), 'utf8');
  for (const t of ['ops_settings', 'projects', 'remedials', 'ops_task_links', 'ops_steps', 'ops_stage_seeds', 'ops_time_entries']) {
    assert.match(sql, new RegExp(`ALTER TABLE ${t} ENABLE ROW LEVEL SECURITY;`), t);
    assert.match(sql, new RegExp(`CREATE POLICY tenant_iso ON ${t}\\s+USING \\(location_id = current_setting\\('app.location_id', true\\)\\)`), t);
  }
});

// ── Per-sub-account switch (migration 147) ───────────────────────────
test('off by default, per sub-account', () => {
  const sql = readFileSync(new URL('../../../migrations/147_ops_location_flag.sql', import.meta.url), 'utf8');
  assert.match(sql, /ADD COLUMN IF NOT EXISTS enabled\s+BOOLEAN NOT NULL DEFAULT false/);
});

test('every ops route except the switch is behind the guard', () => {
  const route = readFileSync(new URL('../../routes/operations.js', import.meta.url), 'utf8');
  const guard = route.indexOf('// Everything below needs the sub-account switched on.');
  assert.ok(guard > 0, 'guard missing');
  assert.ok(route.indexOf("operationsRouter.get('/enabled'") < guard);
  assert.ok(route.indexOf("operationsRouter.put('/enabled'") < guard);
  // The first feature route comes after it.
  assert.ok(route.indexOf("operationsRouter.get('/settings'") > guard);
  assert.match(route, /reason: 'ops_disabled'/);
  // The pipeline mapping upsert must not reset the switch.
  const settingsPut = route.slice(route.indexOf("operationsRouter.put('/settings'"), route.indexOf("operationsRouter.get('/decisions'"));
  assert.ok(!/enabled/.test(settingsPut.replace(/is_active = true/g, '')), 'PUT /settings must not touch enabled');
});
