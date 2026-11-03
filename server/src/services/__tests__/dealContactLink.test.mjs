// Adding a person to a deal.
//
// Reported from the People rail: picking a contact returned
//   "Your CRM would not allow that — Pipeline ID is required for
//    opportunity contact association"
// which is GHL's own message, passed straight through. It validates this
// association against the opportunity's pipeline and rejects the write
// without one — and our payload never carried it.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const assoc = readFileSync(join(root, 'src/services/ghlAssociations.js'), 'utf8');
const deals = readFileSync(join(root, 'src/routes/deals.js'), 'utf8');

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

t('the relation payload can carry a pipeline id',
  /\.\.\.\(opts\.pipelineId \? \{ pipelineId: opts\.pipelineId \} : \{\}\)/.test(assoc));

// ONLY when supplied. A task or note relation has no pipeline, and sending
// the key as null would be rejected in the other direction.
t('it is omitted when there is none', /opts\.pipelineId \?/.test(assoc));

t('addDealContact takes the pipeline', /export async function addDealContact\(install, opportunityId, contactId, pipelineId/.test(assoc));
t('and forwards it', /\{ pipelineId \}/.test(assoc));

// The route already had it: resolveDealForWrite selects pipeline_id, so
// nothing extra is read.
t('the route destructures the deal it already resolved',
  /const \{ install, deal \} = await resolveDealForWrite/.test(deals));
t('and passes the deal own pipeline', /deal\.pipeline_id/.test(deals));

// opportunities.pipeline_id is NULLABLE. Without a guard the request still
// reaches GHL and comes back with the same opaque message.
t('a deal with no pipeline is refused locally, with a usable sentence',
  /if \(!deal\.pipeline_id\)/.test(deals)
  && /Open the deal in your CRM and set its pipeline/.test(deals));

// The payload shape itself.
{
  const build = (opts = {}) => ({
    locationId: 'LOC', associationId: 'A', firstRecordId: 'opp1', secondRecordId: 'c1',
    ...(opts.pipelineId ? { pipelineId: opts.pipelineId } : {})
  });
  t('a deal↔contact payload carries pipelineId', build({ pipelineId: 'p1' }).pipelineId === 'p1');
  t('a task payload has no pipelineId key', !('pipelineId' in build()));
  t('a null pipeline does not add the key', !('pipelineId' in build({ pipelineId: null })));
}

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
