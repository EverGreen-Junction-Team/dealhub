// A deal's tags come from its contacts.
//
// GHL has no opportunity tags (migration 048: "no tags[] field on the
// opportunity object, no webhook for opportunity tags"), so the deals list
// tag filter — an EXISTS against tag_history where entity_type =
// 'opportunity' — matched nothing, for every tag, always. Migration 134
// seeds those rows; tagFanout.js keeps them true.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const fanout = readFileSync(join(root, 'src/services/tagFanout.js'), 'utf8');
const stageWriter = readFileSync(join(root, 'src/services/stageHistoryWriter.js'), 'utf8');
const relWriter = readFileSync(join(root, 'src/services/opportunityContactWriter.js'), 'utf8');
const hooks = readFileSync(join(root, 'src/routes/webhooks.js'), 'utf8');
const migration = readFileSync(join(root, 'migrations/134_opportunity_tags_from_contacts.sql'), 'utf8');

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// ── The union is primary + additional ────────────────────────────────
// opportunity_contacts holds ADDITIONAL contacts; the primary lives on
// opportunities.contact_id. Reading only one of them misses contacts —
// which is the same union contactIsOnDeal() enforces for writes.
for (const [label, src] of [['the fanout', fanout], ['the migration', migration]]) {
  t(`${label} reads the primary contact from opportunities`,
    /FROM opportunities/.test(src));
  t(`${label} reads additional contacts from opportunity_contacts`,
    /FROM opportunity_contacts/.test(src));
  t(`${label} UNIONs the two rather than picking one`, /UNION/.test(src));
}

// ── Recompute, never apply the contact's delta ───────────────────────
// A tag removed from one contact does NOT mean the deal loses it: another
// contact on the same deal may still carry it. Applying the diff would drop
// a tag the deal still has.
t('a deal is recomputed from the full union, not patched',
  /export async function fanoutToDeal/.test(fanout)
  && /currentTags: tags/.test(fanout));
t('a contact change fans out to every deal that contact is on',
  /export async function fanoutFromContact/.test(fanout)
  && /dealsForContact/.test(fanout));

// ── Only CURRENT tags fan out ────────────────────────────────────────
t('a removed contact tag does not reach the deal',
  (fanout.match(/removed_at IS NULL/g) || []).length >= 1);
t('the migration seeds from current tags only',
  /th\.removed_at IS NULL/.test(migration));

// ── The three realtime paths ─────────────────────────────────────────
t('a contact tag change fans out', /fanoutFromContact\(locationId, contactId\)/.test(hooks));
t('the fanout runs AFTER the contact own reconcile',
  hooks.indexOf("entityType: 'contact'") < hooks.indexOf('fanoutFromContact(locationId, contactId)'));
t('linking a contact recomputes the deal', /fanoutOnRelationChange\(locationId, pair\.oppId\)/.test(relWriter));
t('unlinking a contact recomputes the deal', /if \(oppId\) await fanoutOnRelationChange/.test(relWriter));

// UNLINK reads the deal id BEFORE deleting. The event carries only the
// relation id, so after the delete there is nothing left to say which deal
// to recompute — and the deal would keep a tag only the unlinked contact
// carried, with no event ever coming to correct it.
t('the unlink path resolves the deal before deleting the row',
  relWriter.indexOf('SELECT opportunity_id FROM opportunity_contacts') <
  relWriter.indexOf('DELETE FROM opportunity_contacts'));

// ── The stale reconcile is gone ──────────────────────────────────────
// It called reconcileTags with entityType 'opportunity' and opp.tags — a
// field GHL never sends, so always []. Harmless while the table was empty;
// once 134 seeds it, reconcileTags closes every open row not in currentTags
// and does NOT scope that by detected_via, so an empty array would have
// closed every fanned-out tag on the next opportunity event.
t('stageHistoryWriter no longer reconciles opportunity tags from the event',
  !/entityType: 'opportunity'/.test(stageWriter));
t('it recomputes from the contacts instead',
  /fanoutToDeal\(locationId, opp\.opportunityId\)/.test(stageWriter));

// ── Derived rows are marked ──────────────────────────────────────────
t('fanned-out rows carry their own detected_via', /contact_fanout/.test(fanout));
t('the migration marks its rows the same way', /'contact_fanout'/.test(migration));

// ── Best effort ──────────────────────────────────────────────────────
// A tag is a filter facet. Losing one must never fail the webhook that
// carried the real change.
t('a fanout failure never throws out of the contact path',
  /catch \(err\)/.test(fanout));

// ── Idempotent seed ──────────────────────────────────────────────────
// tag_history has no unique constraint on (location, type, entity, name) —
// a tag can be applied, removed and re-applied — so ON CONFLICT has nothing
// to conflict on and a re-run would duplicate every row.
// Comments are stripped first: this file EXPLAINS why ON CONFLICT is wrong,
// so a naive search finds it in the prose and fails on correct code.
const migrationSql = migration.replace(/^\s*--.*$/gm, '');
t('the migration guards re-runs with an anti-join, not ON CONFLICT',
  /HAVING NOT EXISTS/.test(migrationSql) && !/ON CONFLICT/.test(migrationSql));
t('a CLOSED session does not block re-application',
  /ex\.removed_at IS NULL/.test(migration));

// ── ContactCreate / ContactUpdate also carry tags ────────────────────
// These were writing only the contacts.tags column; tag_history was left to
// ContactTagUpdate alone. A tag added during an ordinary contact edit
// therefore never opened a session — so it never reached a deal either.
const contactWriter = readFileSync(join(root, 'src/services/contactWriter.js'), 'utf8');

t('a contact upsert reconciles its tags into tag_history',
  /entityType: 'contact'/.test(contactWriter) && /reconcileTags/.test(contactWriter));
t('and fans them out to that contact deals',
  /fanoutFromContact\(locationId, f\.contactId\)/.test(contactWriter));

// THE DANGEROUS CASE. `tags` collapses absent and empty to [], and
// reconciling against [] CLOSES every open session — so a payload that
// simply omitted tags would wipe the contact's history and every deal it
// fans out to. Only a list that was actually SENT may be reconciled.
t('a payload with no tag list is not read as "no tags"',
  /hasTagList:\s+Array\.isArray\(c\.tags\)/.test(contactWriter)
  && /if \(f\.hasTagList\)/.test(contactWriter));

t('a tag failure never costs the contact write',
  /contactWriter: tag reconcile\/fanout failed \(non-fatal\)/.test(contactWriter));

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
