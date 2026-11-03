// A custom field created in GHL appears without a manual sync.
//
// Run: node --test src/services/__tests__/cfDefinitionBackfill.test.mjs
//
// THE GAP — LATENCY, not absence.
//
// ghl_custom_field_definitions IS refreshed on a schedule: the daily cron at
// 03:00 (orphanSweep.js) calls syncCustomFieldsForAllInstalls, which upserts
// every field and retires the ones GHL no longer returns.
//
// But that is the ONLY refresh. A field created in GHL at 09:00 has no row for
// eighteen hours, and the custom-field editor cannot render it AT ALL in that
// window: the grid is built from the definitions, so the field is absent
// rather than empty, and its value is unreachable even though we hold it.
//
// The value was never lost. customFieldResolve keeps an unknown field id under
// the bare id instead of dropping it, so it sits in custom_fields unreachable.
//
// getCustomFieldNameMaps already fetches every definition from GHL on each
// cache miss, to build its id→name map. It now stores the ones we do not hold,
// which is why a new field turns up on its own.

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const enrich = readFileSync(join(here, '..', 'ghlEnrichment.js'), 'utf8');
const sync = readFileSync(join(here, '..', 'customFieldsSync.js'), 'utf8');

test('the enrichment path stores definitions it has not seen', () => {
  assert.match(enrich, /await backfillDefinitions\(install\.location_id, allFields\)/);
});

test('it reuses the sync\'s writer rather than a second one', () => {
  // Two writers would drift on column defaults, is_active, and last_synced_at
  // — and the soft-delete pass keys on last_synced_at.
  assert.match(sync, /export async function upsertDefinition/);
  assert.match(enrich, /import \{ upsertDefinition \} from '\.\/customFieldsSync\.js'/);
});

test('only MISSING rows are written', () => {
  // The DAILY sync owns updates and the soft-delete pass that retires a field
  // removed in GHL. This path only closes the gap until that runs — writing
  // existing rows from here would put two writers on the same rows on every
  // webhook, for no gain.
  //
  // The two cannot fight: a row inserted here carries last_synced_at = now(),
  // which is later than the daily run's startedAt, so its soft-delete pass
  // (last_synced_at < startedAt) can never retire a row this just added.
  assert.match(enrich, /WHERE location_id = \$1 AND field_id = ANY\(\$2::text\[\]\)/);
  assert.match(enrich, /const missing = allFields\.filter\(\(f\) => f\.id && !known\.has\(f\.id\)\)/);
  assert.match(enrich, /if \(missing\.length === 0\) return/);
});

test('it never throws into the enrichment path', () => {
  // Enrichment runs on every webhook. A failure here must not break the
  // opportunity write — the field just stays unrenderable, which is the state
  // we were already in.
  const fn = enrich.slice(
    enrich.indexOf('async function backfillDefinitions'),
    enrich.indexOf('export async function getCustomFieldNameMaps')
  );
  assert.match(fn, /catch \(err\) \{/);
  assert.match(fn, /logger\.warn\(/);
  assert.doesNotMatch(fn, /throw /);
});

test('the model is resolved the same way the name map resolves it', () => {
  // GHL omits `model` on some responses; detectCfModel reads the fieldKey
  // prefix instead. upsertDefinition keys object_type on it, so a wrong value
  // files an opportunity field as a contact field and it never renders.
  assert.match(enrich, /model: detectCfModel\(f\) \|\| f\.model/);
});

test('it runs before the cache is set', () => {
  // The cache short-circuits the whole function for an hour. Storing after
  // the early return on a cache hit would mean it ran at most once.
  assert.ok(
    enrich.indexOf('await backfillDefinitions(') < enrich.indexOf('cfMapCache.set(install.location_id, result)'),
    'the backfill must precede the cache write'
  );
});
