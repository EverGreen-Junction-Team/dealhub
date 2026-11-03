// aiEval.js — the scoreboard. Run every prompt change against this.
//
// Without a test set, prompt tuning is vibes: you fix one case and silently
// break two. This script runs a fixture file of hand-labelled questions
// against real deals and reports a number.
//
// It grades what can be graded mechanically — which is more than it sounds,
// because the expensive failure mode is fabrication, and fabrication IS
// mechanically detectable:
//
//   quote_validity   every citation is a verbatim substring of a real message
//                    → this is the precision guard. Must be 100%.
//   answered_rate    how often the model claimed an answer at all
//   citation_rate    answers that carried at least one verifiable quote
//   expect_answered  matches the fixture's expectation (did/didn't answer)
//   must_cite        the answer cites a message the labeller marked essential
//   must_not_say     the answer avoids strings the labeller marked wrong
//
// Semantic correctness still needs a human read — the script prints every
// answer so a rep can skim them. That's the intended workflow: mechanical
// gates catch fabrication, a person judges usefulness.
//
// Usage:
//   node src/scripts/aiEval.js --file evals/ask.json
//   node src/scripts/aiEval.js --file evals/ask.json --only stalled
//   node src/scripts/aiEval.js --file evals/ask.json --json > run.json

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { pool } from '../db.js';
import { askDeal } from '../services/ai/askDeal.js';
import { buildDealContext } from '../services/ai/contextBuilder.js';
import { __normalise } from '../services/ai/validate.js';
import { isConfigured, MODEL } from '../services/ai/claudeClient.js';

function parseArgs(argv) {
  const out = { file: null, only: null, json: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--file' && argv[i + 1]) out.file = argv[++i];
    else if (argv[i] === '--only' && argv[i + 1]) out.only = argv[++i];
    else if (argv[i] === '--json') out.json = true;
  }
  return out;
}

/*
 * Fixture shape:
 * {
 *   "locationId": "IFcSg4YvuVlx56msjbdf",
 *   "cases": [
 *     {
 *       "id": "stalled",
 *       "opportunityId": "dA7...",
 *       "question": "Why has this deal stalled?",
 *       "expectAnswered": true,
 *       "mustCiteMessageIds": ["abc123"],
 *       "mustNotSay": ["discount", "free"],
 *       "note": "Rep says the blocker is the architect's drawings."
 *     }
 *   ]
 * }
 *
 * Use BGD (the QA sandbox) as locationId — hand-validate there before
 * anything touches Crittall.
 */

async function runCase(locationId, c) {
  const started = Date.now();
  const result = {
    id: c.id,
    opportunityId: c.opportunityId,
    question: c.question,
    pass: true,
    failures: [],
    answerText: null,
    citations: [],
    coverage: null,
    latencyMs: null
  };

  // Grade citations against the same context the call saw, so a quote is
  // checked against exactly what was sent.
  const ctx = await buildDealContext(locationId, c.opportunityId);
  if (!ctx) {
    result.pass = false;
    result.failures.push('deal not found');
    return result;
  }

  let answer;
  try {
    answer = await askDeal({
      locationId,
      opportunityId: c.opportunityId,
      question: c.question,
      userId: 'eval'
    });
  } catch (err) {
    result.pass = false;
    result.failures.push(`call failed: ${err.message}`);
    result.latencyMs = Date.now() - started;
    return result;
  }

  result.latencyMs = Date.now() - started;
  result.answerText = answer.answerText;
  result.citations = answer.citations || [];
  result.coverage = answer.coverage;
  result.answered = answer.answered;
  result.confidence = answer.confidence;
  result.cached = answer.cached;

  // ── quote_validity — the precision guard ──────────────────────────
  // askDeal already drops unverifiable citations, so anything surviving here
  // should be valid. Re-checking independently means a regression in the
  // validator itself shows up as an eval failure rather than passing quietly.
  const bodies = new Map();
  for (const m of ctx.messages) bodies.set(m.message_id, __normalise(m.body_text));
  for (const n of ctx.notes) bodies.set(n.note_id, __normalise(n.body));

  for (const cite of result.citations) {
    const hay = bodies.get(cite.messageId);
    if (hay == null) {
      result.pass = false;
      result.failures.push(`citation references unknown message ${cite.messageId}`);
      continue;
    }
    if (!hay.includes(__normalise(cite.quoteText))) {
      result.pass = false;
      result.failures.push(`citation quote not verbatim in ${cite.messageId}`);
    }
  }

  // ── expectations from the label ───────────────────────────────────
  if (typeof c.expectAnswered === 'boolean' && answer.answered !== c.expectAnswered) {
    result.pass = false;
    result.failures.push(
      `expected answered=${c.expectAnswered}, got ${answer.answered}`
    );
  }

  if (Array.isArray(c.mustCiteMessageIds) && c.mustCiteMessageIds.length) {
    const cited = new Set(result.citations.map((x) => x.messageId));
    for (const need of c.mustCiteMessageIds) {
      if (!cited.has(need)) {
        result.pass = false;
        result.failures.push(`did not cite required message ${need}`);
      }
    }
  }

  if (Array.isArray(c.mustNotSay) && c.mustNotSay.length) {
    const hay = __normalise(answer.answerText);
    for (const bad of c.mustNotSay) {
      if (hay.includes(__normalise(bad))) {
        result.pass = false;
        result.failures.push(`answer contained forbidden phrase "${bad}"`);
      }
    }
  }

  // An answered claim with zero verifiable quotes is the failure mode that
  // matters most — a confident answer nobody can check.
  if (answer.answered && result.citations.length === 0) {
    result.pass = false;
    result.failures.push('answered with no verifiable citation');
  }

  return result;
}

async function main() {
  const { file, only, json } = parseArgs(process.argv);
  if (!file) {
    console.error('Usage: node src/scripts/aiEval.js --file evals/ask.json [--only <caseId>] [--json]');
    process.exit(1);
  }
  if (!isConfigured()) {
    console.error('ANTHROPIC_API_KEY is not set — nothing to evaluate.');
    process.exit(1);
  }

  const raw = await fs.readFile(path.resolve(file), 'utf8');
  const fixture = JSON.parse(raw);
  const cases = (fixture.cases || []).filter((c) => !only || c.id === only);

  if (!cases.length) {
    console.error('No cases to run.');
    process.exit(1);
  }

  const results = [];
  for (const c of cases) {
    const r = await runCase(fixture.locationId, c);
    results.push(r);
    if (!json) {
      const mark = r.pass ? 'PASS' : 'FAIL';
      console.log(`\n${'─'.repeat(72)}`);
      console.log(`${mark}  ${r.id}  (${r.latencyMs}ms${r.cached ? ', cached' : ''})`);
      console.log(`Q: ${r.question}`);
      if (r.answerText) console.log(`A: ${r.answerText}`);
      if (r.coverage) {
        console.log(
          `   coverage: read ${r.coverage.messagesRead}/${r.coverage.messagesTotal}` +
            (r.coverage.unreadReasons?.length ? ` — ${r.coverage.unreadReasons.join('; ')}` : '')
        );
      }
      for (const cite of r.citations) {
        console.log(`   ⤷ [${cite.messageId}] "${truncate(cite.quoteText, 100)}"`);
      }
      for (const f of r.failures) console.log(`   ✗ ${f}`);
    }
  }

  const passed = results.filter((r) => r.pass).length;
  const summary = {
    model: MODEL,
    cases: results.length,
    passed,
    failed: results.length - passed,
    passRate: results.length ? Math.round((passed / results.length) * 100) : 0,
    answeredRate: pct(results, (r) => r.answered === true),
    citationRate: pct(results, (r) => (r.citations?.length || 0) > 0),
    medianLatencyMs: median(results.map((r) => r.latencyMs).filter(Boolean))
  };

  if (json) {
    console.log(JSON.stringify({ summary, results }, null, 2));
  } else {
    console.log(`\n${'═'.repeat(72)}`);
    console.log(
      `${summary.passed}/${summary.cases} passed (${summary.passRate}%)  ` +
        `answered ${summary.answeredRate}%  cited ${summary.citationRate}%  ` +
        `median ${summary.medianLatencyMs}ms  model ${summary.model}`
    );
    if (summary.failed > 0) {
      console.log(`\nFailures:`);
      for (const r of results.filter((x) => !x.pass)) {
        console.log(`  ${r.id}: ${r.failures.join('; ')}`);
      }
    }
  }

  await pool.end();
  process.exit(summary.failed > 0 ? 1 : 0);
}

function pct(results, fn) {
  if (!results.length) return 0;
  return Math.round((results.filter(fn).length / results.length) * 100);
}

function median(nums) {
  if (!nums.length) return null;
  const s = [...nums].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
}

function truncate(s, n) {
  const t = String(s || '');
  return t.length > n ? `${t.slice(0, n)}…` : t;
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
