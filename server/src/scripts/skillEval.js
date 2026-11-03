#!/usr/bin/env node
//
// skillEval.js — does the model pick the RIGHT skill for a question?
//
// WHY THIS EXISTS. Skills are offered to the model as ordinary tools; nobody
// selects one by hand. So the whole feature rests on the model reading ~90
// tool descriptions and choosing well — and nothing was checking that. A
// description that reads fine to a person can still lose to its neighbour,
// and the failure is silent: the answer looks right, sourced from the wrong
// view.
//
// WHAT IT MEASURES. One real API call per case, stopped at the FIRST tool
// call. Selection is what is being tested, not the answer, so there is no
// reason to pay for the rest of the loop — and the first choice is the one
// that decides everything downstream.
//
// WHAT IT CANNOT MEASURE. Whether the answer is any good. A correct skill
// badly summarised still reads as a pass here. That needs a human, same as
// aiEval.js.
//
// `alsoOk` vs `avoid` is the heart of the fixture:
//   expect   the best answer
//   alsoOk   defensible — a different route to the same truth. Not a failure;
//            counting it as one would push us to write narrower descriptions
//            that win the eval and serve reps worse.
//   avoid    answers plausibly and WRONGLY — history where a forecast was
//            asked for, a snapshot where a trend was. The real bugs.
//
// Usage:
//   node src/scripts/skillEval.js --location <id>
//   node src/scripts/skillEval.js --location <id> --only forecast
//   node src/scripts/skillEval.js --location <id> --json > run.json

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getClient, MODEL } from '../services/ai/claudeClient.js';
import { toolCatalogue } from '../services/ai/tools/registry.js';
import { skillToolsFor } from '../services/ai/tools/skillTools.js';
import { TOOL_SYSTEM_PROMPT } from '../services/ai/tools/prompt.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURE = path.resolve(__dirname, '../../evals/skillSelection.json');

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i === -1 ? fallback : process.argv[i + 1];
}

async function main() {
  const locationId = arg('location');
  if (!locationId) throw new Error('--location <id> is required');
  const only = arg('only');
  const asJson = process.argv.includes('--json');

  const fixture = JSON.parse(await fs.readFile(FIXTURE, 'utf8'));
  const cases = only
    ? fixture.cases.filter((c) => c.id.includes(only) || c.expect.includes(only))
    : fixture.cases;

  // The exact tool list a real question would see — built-ins plus this
  // location's skills. If the skills are not registered, the eval is
  // measuring nothing, so that is checked rather than assumed.
  const skillTools = await skillToolsFor(locationId, 'portfolio');
  if (!skillTools.length) {
    throw new Error(
      `No skills registered for ${locationId}. Run seed:skills first — `
      + 'otherwise this eval would grade the built-in tools alone.'
    );
  }
  const tools = [...toolCatalogue(), ...skillTools].map((t) => ({
    name: t.name, description: t.description, input_schema: t.inputSchema
  }));

  const anthropic = getClient();
  const results = [];
  // Set when the API itself is unusable — see the catch below.
  let fatal = null;

  if (!asJson) {
    console.log(
      `${cases.length} questions against ${tools.length} tools `
      + `(${skillTools.length} skills) on ${MODEL}\n`
    );
  }

  for (const c of cases) {
    let picked = null;
    let error = null;
    try {
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 512,
        system: TOOL_SYSTEM_PROMPT,
        tools,
        // Forced: a model that answers from memory instead of calling anything
        // would score as "no pick" and hide a selection problem behind an
        // abstention.
        tool_choice: { type: 'any' },
        messages: [{ role: 'user', content: c.q }]
      });
      const call = res.content.find((b) => b.type === 'tool_use');
      picked = call?.name ?? null;
    } catch (err) {
      error = err.message;
      // A FATAL error stops the run rather than repeating 21 more times.
      //
      // When the credit balance ran out, this made every remaining call
      // anyway — each one returning the same 400 — and then reported
      // "exact 1/22", which reads as the skills failing. They were never
      // asked. Auth, billing and rate limits all behave this way: the next
      // call cannot succeed either.
      if (/credit balance|rate_limit|authentication|invalid x-api-key|permission/i.test(error)) {
        results.push({ ...c, picked: null, ok: false, acceptable: false, bad: false, error });
        if (!asJson) process.stdout.write(`ERR  ${c.id.padEnd(26)}  ${error}\n`);
        fatal = error;
        break;
      }
    }

    const ok = picked === c.expect;
    const acceptable = ok || (c.alsoOk || []).includes(picked);
    const bad = (c.avoid || []).includes(picked);
    results.push({ ...c, picked, ok, acceptable, bad, error });

    // Printed AS IT LANDS, not batched at the end.
    //
    // 22 sequential API calls is a minute of total silence after the npm
    // header, which reads as a hung script — and a hung script gets a
    // Ctrl-C, losing the run and the money it cost. A line per case also
    // means a failure part-way through still tells you what it got to.
    if (!asJson) {
      const mark = error ? 'ERR ' : ok ? 'ok  ' : bad ? 'BAD ' : acceptable ? '~   ' : 'MISS';
      process.stdout.write(`${mark} ${c.id.padEnd(26)}  ${picked || error || '(nothing)'}\n`);
      if (!ok && !error) {
        process.stdout.write(`${''.padEnd(32)}expected ${c.expect}\n`);
        if (bad && c.why) process.stdout.write(`${''.padEnd(32)}WHY IT MATTERS: ${c.why}\n`);
      }
    }
  }

  if (asJson) {
    console.log(JSON.stringify({ model: MODEL, locationId, results }, null, 2));
    return;
  }

  const exact = results.filter((r) => r.ok).length;
  const fine = results.filter((r) => r.acceptable).length;
  const wrong = results.filter((r) => r.bad).length;
  const asked = results.filter((r) => !r.error).length;

  console.log('');
  if (fatal) {
    // Scored out of what was actually ASKED, and said plainly that the rest
    // were not. "exact 1/22" after a billing failure reads as 21 wrong
    // answers; the truth is 21 unasked questions.
    console.log(`STOPPED after ${results.length} of ${cases.length}: ${fatal}`);
    console.log(`Of the ${asked} that ran: exact ${exact}, acceptable ${fine}, actively wrong ${wrong}.`);
    console.log('Nothing here says anything about the remaining questions — re-run when the API is usable.');
    process.exit(2);
  }
  console.log(`exact ${exact}/${results.length}   acceptable ${fine}/${results.length}   `
    + `actively wrong ${wrong}`);
  // Only `avoid` hits fail the run. A near-miss is information, not a
  // regression — failing on those would push the fixture toward whatever the
  // model already does, which measures nothing.
  process.exit(wrong ? 1 : 0);
}

main().catch((err) => { console.error(err.message); process.exit(1); });
