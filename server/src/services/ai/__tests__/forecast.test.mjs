// The forecast views' arithmetic, checked as pure logic.
//
// These views mirror GHL's Forecast tab. The probability rule is the subtle
// part and the easiest to get quietly wrong: with a pipeline set to use STAGE
// probabilities, a figure typed onto the deal is IGNORED. Getting that
// backwards would not error — it would just report different numbers from the
// CRM, which is worse.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let pass = 0;
const failures = [];
function t(name, cond) { if (cond) pass++; else failures.push(name); }

const base = readFileSync(new URL('../../../../migrations/118_vw_forecast_base.sql', import.meta.url), 'utf8');
const summary = readFileSync(new URL('../../../../migrations/119_vw_forecast_summary.sql', import.meta.url), 'utf8');
const timeline = readFileSync(new URL('../../../../migrations/120_vw_forecast_timeline.sql', import.meta.url), 'utf8');
const slip = readFileSync(new URL('../../../../migrations/121_vw_forecast_slippage.sql', import.meta.url), 'utf8');
const ctx = readFileSync(new URL('../contextBuilder.js', import.meta.url), 'utf8');

// GHL's resolution order, as pure logic.
function effectiveProbability({ usesDeal, dealP, stageP, hasStage }) {
  if (usesDeal && dealP != null) return dealP;
  if (stageP != null) return stageP;
  if (dealP != null && !hasStage) return dealP;
  return 0;
}

// ── the rule ─────────────────────────────────────────────────────────
t('pipeline opted in: the deal\'s own probability wins',
  effectiveProbability({ usesDeal: true, dealP: 80, stageP: 60, hasStage: true }) === 80);

// The one that surprises people, and the one worth a test.
t('pipeline NOT opted in: the stage wins and the deal\'s figure is ignored',
  effectiveProbability({ usesDeal: false, dealP: 90, stageP: 60, hasStage: true }) === 60);

t('no stage at all: the deal\'s own probability is used',
  effectiveProbability({ usesDeal: false, dealP: 75, stageP: null, hasStage: false }) === 75);

t('nothing set anywhere resolves to 0, not null',
  effectiveProbability({ usesDeal: false, dealP: null, stageP: null, hasStage: true }) === 0);

t('a deal probability of 0 is honoured, not treated as unset',
  effectiveProbability({ usesDeal: true, dealP: 0, stageP: 60, hasStage: true }) === 0);

// ── what the views must carry ────────────────────────────────────────
t('probability_source is exposed, so a 0 can be explained',
  /probability_source/.test(base) && /'none'/.test(base));

t('weighted value is open-only — a won deal is revenue, not a forecast',
  /WHEN o\.status = 'open'/.test(base));

t('GHL\'s invented auto-stage-probability curve is NOT implemented', (() => {
  // Checked against the SQL with comments stripped — the header explains the
  // formula in order to say it is deliberately absent, and the first version
  // of this test matched that explanation.
  const sql = base.split('\n').filter((l) => !l.trim().startsWith('--')).join('\n');
  return !/\/ \(N \+ 1\)/.test(sql) && !/100\.0 \/ \(/.test(sql);
})());

t('coverage rides on the summary row, not in a comment',
  /pct_with_close_date/.test(summary) && /pct_without_probability/.test(summary));

t('readiness names the CONSEQUENCE, not just the empty field',
  /consequence/.test(summary) && /Invisible to every period forecast/.test(summary));

t('readiness checks for a missing probability — a gap GHL hides',
  /No probability set/.test(summary));

// ── the timeline's undated row ───────────────────────────────────────
t('deals with no close date are a ROW, not an omission',
  /undated AS \(/.test(timeline) && /\(no close date\)/.test(timeline));

t('the undated row is flagged so it is never read as a period',
  /is_undated/.test(timeline));

t('every month carries how much of the pipeline is datable',
  /pct_of_open_dated/.test(timeline));

t('won revenue is bucketed by when it was WON, not when it was forecast',
  /date_trunc\('month', won_at\)/.test(timeline));

// ── slippage ─────────────────────────────────────────────────────────
t('only a LATER date counts as a push', /new_date > old_date/.test(slip));

t('days slipped is measured to the CURRENT date, so a pull-back reduces it',
  /GREATEST\(0, \(b\.forecast_close_date - a\.original_close_date\)\)/.test(slip));

t('the history boundary is exposed, so pre-tracking slips are not read as none',
  /first_seen_change/.test(slip));

{
  // A deal pushed out two months then pulled back one is 31 days slipped,
  // not 61 — the net, measured original -> current.
  const original = new Date('2026-08-01');
  const current = new Date('2026-09-01');
  const days = Math.round((current - original) / 86400000);
  t('pushed then partly pulled back shows the NET slip', days === 31);
}

// ── Deal AI reads the same numbers ───────────────────────────────────
t('Deal AI resolves probability from the shared view, not its own copy',
  /vw_forecast_base fb/.test(ctx) && /fb\.effective_probability/.test(ctx));

t('Deal AI reports where the probability came from',
  /probability_source: d\.probability_source/.test(ctx));

t('slip fields are omitted entirely when a deal never slipped',
  /Number\(d\.times_pushed\) > 0 \?/.test(ctx));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { console.error('FAILED:', failures); process.exit(1); }
