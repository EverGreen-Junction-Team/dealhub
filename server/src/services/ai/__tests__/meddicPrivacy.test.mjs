// The qualification headings are for the REP, not the model.
//
// Asked for directly: "please do not make the fields visible to the AI...
// it will be too confusing for the llm to also read them. we want the llm to
// focus on reading the conversation data."
//
// The failure this prevents is subtle. get_deal_detail returned meddic_1..11
// alongside the conversation, so the model saw a rep's own summary and the
// source material as one undifferentiated blob. It would state "the budget is
// £40k" from a field someone typed months ago and cite it as fact — quoting
// the record back at the person who wrote it, with no way for either to tell.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..', '..');
const registry = readFileSync(join(root, 'src/services/ai/tools/registry.js'), 'utf8');
const prompts = readFileSync(join(root, 'src/services/ai/prompts.js'), 'utf8');
const ctxBuilder = readFileSync(join(root, 'src/services/ai/contextBuilder.js'), 'utf8');

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// ── No tool may SELECT a qualification value ─────────────────────────
// Counting them is fine (see below); returning the text is not.
const selectsValues = /o\.meddic_\d+\s*,\s*o\.meddic_\d+/.test(registry);
t('no tool selects meddic columns as values', !selectsValues);

const getDeal = registry.slice(
  registry.indexOf("name: 'get_deal_detail'"),
  registry.indexOf("name: 'get_deal_contacts'")
);
t('get_deal_detail does not advertise qualification values',
  !/meddic_1\.\.11/.test(getDeal));
t('and says where to look instead',
  /read the\s+' \+\s+'conversation for that|conversation for that/.test(getDeal));

// ── Counting is still allowed ────────────────────────────────────────
// "Which deals are missing qualification" is a coverage question about
// EMPTINESS, not content — it reads whether each column is null, never the
// text. Losing it would cost a real skill for no privacy gain.
t('the gaps tool still counts filled headings',
  /IS NOT NULL AND o\.meddic_1\s+!= ''/.test(registry));
t('and still advertises itself', /meddic_1\.\.10/.test(registry));

// ── Headings themselves still reach the model ────────────────────────
// The model needs to know a heading EXISTS to file evidence under it. The
// names and descriptions come from the field definitions, never the values.
t('the system prompt still names the headings',
  /Qualification headings used in this business/.test(prompts));
t('the context builder reads DEFINITIONS, not values',
  /ghl_custom_field_definitions/.test(ctxBuilder)
  && !/o\.meddic_1/.test(ctxBuilder));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
