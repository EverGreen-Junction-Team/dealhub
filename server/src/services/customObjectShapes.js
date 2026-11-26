// Pure shaping for GHL custom objects and associations — no I/O, no config,
// so it can be tested on its own. The calls live in ghlCustomObjects.js.

// Custom object keys are always namespaced like this; standard objects
// (contact, opportunity, business) are not.
export const CUSTOM_PREFIX = 'custom_objects.';

/** The custom object schemas from a GET /objects/ response. Pure. */
export function pickCustomSchemas(data) {
  const rows = Array.isArray(data?.objects) ? data.objects : [];
  return rows
    .filter((o) => typeof o?.key === 'string' && o.key.startsWith(CUSTOM_PREFIX))
    .map((o) => ({
      key: o.key,
      singular: o.labels?.singular || o.key.slice(CUSTOM_PREFIX.length),
      plural: o.labels?.plural || o.labels?.singular || o.key.slice(CUSTOM_PREFIX.length),
      primaryProperty: o.primaryDisplayProperty || null
    }));
}

/**
 * The associations that join a CONTACT to a custom object, with which side
 * the contact is on. Pure.
 *
 * ORIENTATION MATTERS: a relation's firstRecordId must be the record of the
 * association's firstObjectKey. An admin may have defined "Pets ↔ Contacts"
 * or "Contacts ↔ Pets", and both exist in the wild.
 */
export function contactAssociations(data, schemas) {
  const keys = new Map(schemas.map((s) => [s.key, s]));
  const rows = associationRows(data);
  const out = [];
  for (const a of rows) {
    const first = a?.firstObjectKey;
    const second = a?.secondObjectKey;
    const id = a?.id || a?._id;
    if (!id) continue;
    if (first === 'contact' && keys.has(second)) {
      out.push({ id, objectKey: second, contactSide: 'first', label: a.secondObjectLabel || a.key || null });
    } else if (second === 'contact' && keys.has(first)) {
      out.push({ id, objectKey: first, contactSide: 'second', label: a.firstObjectLabel || a.key || null });
    }
  }
  return out;
}

/**
 * What a record is called: its primary display property, else the first
 * non-empty text property, else its id. Pure.
 *
 * primaryDisplayProperty is the FULL key ("custom_objects.pets.name") while
 * a record's `properties` are keyed by the short one ("name").
 */
export function recordLabel(record, schema) {
  const props = record?.properties && typeof record.properties === 'object' ? record.properties : {};
  const short = schema?.primaryProperty ? String(schema.primaryProperty).split('.').pop() : null;
  const asText = (v) => {
    if (v == null) return '';
    if (typeof v === 'string' || typeof v === 'number') return String(v).trim();
    if (Array.isArray(v)) return v.map(asText).filter(Boolean).join(', ');
    return '';
  };
  if (short && asText(props[short])) return asText(props[short]);
  for (const v of Object.values(props)) {
    const t = asText(v);
    if (t) return t.length > 80 ? `${t.slice(0, 79)}…` : t;
  }
  return record?.id || 'Record';
}

/** For one relation, the custom record's id, given which side the contact is. Pure. */
export function otherSide(relation, contactId) {
  if (relation?.firstRecordId === contactId) return relation.secondRecordId;
  if (relation?.secondRecordId === contactId) return relation.firstRecordId;
  return null;
}

/**
 * The rows of a GET /associations/ page. GHL's spec documents the ITEM shape
 * but not the wrapper, so every plausible one is accepted rather than
 * guessing one and showing "no record types" when the guess is wrong. Pure.
 */
export function associationRows(data) {
  if (Array.isArray(data)) return data;
  for (const k of ['associations', 'data', 'items', 'results']) {
    if (Array.isArray(data?.[k])) return data[k];
  }
  return [];
}

/**
 * Which contact association a relation belongs to. Pure.
 *
 * By id first, then BY OBJECT KEYS. Live GHL responses have been seen to
 * carry an opaque associationId that matches nothing we listed — the same
 * trap backfillOpportunityContacts.js documents for deal↔contact — while
 * firstObjectKey/secondObjectKey are always the real keys.
 */
export function matchRelation(relation, associations) {
  const byId = associations.find((a) => a.id === relation?.associationId);
  if (byId) return byId;
  const f = relation?.firstObjectKey;
  const sk = relation?.secondObjectKey;
  const other = f === 'contact' ? sk : (sk === 'contact' ? f : null);
  if (!other) return null;
  return associations.find((a) => a.objectKey === other) || null;
}
