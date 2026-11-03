// The list and detail deal responses must agree on the fields the dashboard
// reads, because the Deals tab PATCHES A LIST ROW WITH A DETAIL RESPONSE.
//
// After an inline edit, DealsTab calls dealsAPI.get(id) and merges the result
// into the list row via usePagedList.patchItem. Any field the two routes name
// differently leaves that row half-updated: the card reads `deal.pipeline`, the
// detail route originally sent only `pipelineName`, so a saved row rendered a
// blank pipeline. Same for `assignedTo` vs `ownerId` and a missing `stageId`.
//
// Source-parsed rather than served: booting the router needs a database, a
// session and GHL credentials, and the question here is purely which keys each
// res.json() object literal carries.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(here, '..', 'deals.js'), 'utf8');

// Every field the inline editor and the card bind to. If one of these stops
// being sent by either route, an input silently renders empty.
const SHARED = [
  'id', 'opportunityName', 'dealTag',
  'value', 'monetaryValue', 'currency',
  'stage', 'stageId',
  'pipeline', 'pipelineId',
  'owner', 'assignedTo',
  'status', 'forecastCloseDate', 'source',
  'people'
];

// Slice each route's handler body: from its declaration to the next
// dealsRouter registration.
function handlerBody(startMarker) {
  const i = src.indexOf(startMarker);
  assert.ok(i !== -1, `could not find ${startMarker}`);
  const rest = src.slice(i + startMarker.length);
  const j = rest.search(/\ndealsRouter\.(get|post|patch|put|delete)\(/);
  return j === -1 ? rest : rest.slice(0, j);
}

const listBody = handlerBody("dealsRouter.get('/', async");
const detailBody = handlerBody("dealsRouter.get('/:id', async");

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('deal response shape parity');

for (const field of SHARED) {
  t(`both routes send ${field}`, () => {
    // `field:` as an object key, OR ES6 shorthand (`people,` / `people\n`).
    // The detail route builds some keys as shorthand from a local of the same
    // name, so matching only `field:` reported a missing field that was in
    // fact sent — this test's own bug on first run.
    const key = new RegExp(
      `(^|[\\s{,])${field}\\s*(:|,|$)`, 'm'
    );
    assert.ok(key.test(listBody), `GET / does not send ${field}`);
    assert.ok(key.test(detailBody), `GET /:id does not send ${field}`);
  });
}

// The specific trap this file exists for: a display-formatted value must always
// be accompanied by the raw number, or an editable input binds to "£26,000" and
// posts the formatted string back.
t('a formatted value is always paired with monetaryValue', () => {
  for (const [label, body] of [['GET /', listBody], ['GET /:id', detailBody]]) {
    assert.ok(
      /monetaryValue\s*:/.test(body),
      `${label} sends a formatted value with no raw monetaryValue`
    );
  }
});

console.log(`\n${n + 1} passed`);
