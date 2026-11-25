// ghlCustomObjects.js — custom object records linked to a CUSTOMER.
//
// ── WHY THROUGH THE CONTACT, NOT THE APPOINTMENT ─────────────────────
//
// GHL's associations join objects that the association service knows about:
// contacts, opportunities, businesses and custom objects. An APPOINTMENT is
// not one of them — there is no `appointment` object key that a relation can
// point at. So "the records on this booking" is answered the only way the CRM
// can answer it: the records linked to the booking's customer. Linking from
// the calendar creates a real contact↔record relation in GHL, which is what
// GHL's own contact page shows too.
//
// ── WHAT IS LOOKED UP, AND WHY NOTHING IS STORED ─────────────────────
//
// Custom object schemas and associations are per location and change when an
// admin edits them in Settings, so they are read live rather than mirrored.
// The calendar asks for them only when someone opens the links dialog — never
// on hover, never on board load — so the cost is a few requests per click.
//
// SCOPES. Each call below needs its own:
//   GET  /objects/                       objects/schema.readonly
//   POST /objects/:key/records/search    objects/record.readonly
//   GET  /objects/:key/records/:id       objects/record.readonly
//   GET  /associations/                  associations.readonly
//   GET  /associations/relations/:id     associations/relation.readonly
//   POST /associations/relations         associations/relation.write
//   DEL  /associations/relations/:id     associations/relation.write
// All are called scopeOptional, so a missing one answers GHL_SCOPE_MISSING for
// THIS feature and does not flag the install for reauth.

import { ghlRequest } from './ghlClient.js';
import { logger } from '../utils/logger.js';
import { AssociationError, translateOAuthChannelBlock } from './associationConstants.js';
import { translateRelationError } from './ghlAssociations.js';

import {
  pickCustomSchemas, contactAssociations, recordLabel, otherSide
} from './customObjectShapes.js';

export { pickCustomSchemas, contactAssociations, recordLabel, otherSide };

const RECORD_LIMIT = 25;

// ── Live reads ─────────────────────────────────────────────────────────

/** Schemas + the contact associations that can be linked from here. */
export async function linkableObjects(install) {
  const locationId = install.location_id;
  const { data: objects } = await ghlRequest(install, {
    method: 'GET', url: '/objects/', params: { locationId }, scopeOptional: true
  });
  const schemas = pickCustomSchemas(objects);
  if (schemas.length === 0) return { schemas: [], associations: [] };

  // Paged; a location with more than a few hundred associations would be
  // unusual, so two pages is a generous ceiling rather than a loop with no end.
  const rows = [];
  for (let skip = 0; skip < 400; skip += 200) {
    const { data } = await ghlRequest(install, {
      method: 'GET', url: '/associations/',
      params: { locationId, skip, limit: 200 }, scopeOptional: true
    });
    const page = Array.isArray(data?.associations) ? data.associations : [];
    rows.push(...page);
    if (page.length < 200) break;
  }
  const associations = contactAssociations({ associations: rows }, schemas);
  // Only the object types a contact can actually be linked to.
  const linkable = new Set(associations.map((a) => a.objectKey));
  return { schemas: schemas.filter((s) => linkable.has(s.key)), associations };
}

/** The custom object records linked to one contact. */
export async function recordsForContact(install, contactId, { schemas, associations }) {
  if (!contactId || associations.length === 0) return [];
  const locationId = install.location_id;
  const byAssoc = new Map(associations.map((a) => [a.id, a]));
  const schemaByKey = new Map(schemas.map((s) => [s.key, s]));

  const { data } = await ghlRequest(install, {
    method: 'GET',
    url: `/associations/relations/${encodeURIComponent(contactId)}`,
    params: { locationId, skip: 0, limit: 100 },
    scopeOptional: true
  });
  const relations = (Array.isArray(data?.relations) ? data.relations : [])
    .filter((r) => byAssoc.has(r?.associationId))
    .slice(0, RECORD_LIMIT);

  // One request per record — GHL has no batch read. Bounded by RECORD_LIMIT,
  // and a record that fails to load still shows (by id) rather than vanishing.
  return Promise.all(relations.map(async (r) => {
    const assoc = byAssoc.get(r.associationId);
    const schema = schemaByKey.get(assoc.objectKey);
    const recordId = otherSide(r, contactId);
    let label = recordId;
    try {
      const { data: rec } = await ghlRequest(install, {
        method: 'GET',
        url: `/objects/${encodeURIComponent(assoc.objectKey)}/records/${encodeURIComponent(recordId)}`,
        params: { locationId },
        scopeOptional: true
      });
      label = recordLabel(rec?.record || rec, schema);
    } catch (err) {
      logger.warn({ err, objectKey: assoc.objectKey, recordId }, 'customObjects: record read failed');
    }
    return {
      relationId: r.id || r._id,
      associationId: r.associationId,
      objectKey: assoc.objectKey,
      objectLabel: schema?.singular || assoc.objectKey,
      id: recordId,
      label
    };
  }));
}

/** Search one object's records, for the picker. */
export async function searchRecords(install, objectKey, q, schema) {
  const { data } = await ghlRequest(install, {
    method: 'POST',
    url: `/objects/${encodeURIComponent(objectKey)}/records/search`,
    data: { locationId: install.location_id, page: 1, pageLimit: 20, query: q || '' },
    scopeOptional: true
  });
  const rows = Array.isArray(data?.records) ? data.records : [];
  return rows
    .filter((r) => r?.id)
    .map((r) => ({ value: r.id, label: recordLabel(r, schema) }));
}

// ── Writes ─────────────────────────────────────────────────────────────

/** Link a record to a contact, honouring the association's orientation. */
export async function linkRecord(install, assoc, contactId, recordId) {
  const [firstRecordId, secondRecordId] = assoc.contactSide === 'first'
    ? [contactId, recordId]
    : [recordId, contactId];
  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: '/associations/relations',
      data: { locationId: install.location_id, associationId: assoc.id, firstRecordId, secondRecordId },
      scopeOptional: true
    });
    logger.info({ associationId: assoc.id, firstRecordId, secondRecordId }, 'customObjects: relation created');
    return data || null;
  } catch (err) {
    if (err.code === 'GHL_SCOPE_MISSING') throw err;
    const blocked = translateOAuthChannelBlock(err, 'That link');
    if (blocked !== err) throw blocked;
    throw translateRelationError(err, 'That record');
  }
}

/** Remove one contact↔record relation by its own id. */
export async function unlinkRecord(install, relationId) {
  if (!relationId) throw new AssociationError('A relation id is required', { field: 'relationId' });
  try {
    await ghlRequest(install, {
      method: 'DELETE',
      url: `/associations/relations/${encodeURIComponent(relationId)}`,
      params: { locationId: install.location_id },
      scopeOptional: true
    });
    logger.info({ relationId }, 'customObjects: relation deleted');
    return true;
  } catch (err) {
    if (err.code === 'GHL_SCOPE_MISSING') throw err;
    const blocked = translateOAuthChannelBlock(err, 'That link');
    if (blocked !== err) throw blocked;
    throw translateRelationError(err, 'That link');
  }
}
