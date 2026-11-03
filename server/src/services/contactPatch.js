// contactPatch.js — validate and map a contact edit for GHL's update endpoint.
//
// Dependency-free so it can be unit-tested without config, a database or the
// network. This is where silent data loss would live: a mistyped field name
// here means an edit the UI reports as saved and GHL never receives.

// Fields the public UpdateContactDto accepts (API version 2021-07-28 — the
// Version header ghlClient.js actually sends; an earlier comment here said
// 2021-04-15, which was never what was on the wire), mapped from our own
// camelCase. Anything not listed is dropped rather than passed through — an
// unknown key makes GHL reject the whole request, so a typo would lose a
// valid edit alongside it.
const WRITABLE = new Map([
  ['firstName', 'firstName'],
  ['lastName', 'lastName'],
  ['name', 'name'],
  ['email', 'email'],
  ['phone', 'phone'],
  // Our UI calls this `address`; GHL's field is address1. Both accepted so a
  // client using either name works.
  ['address', 'address1'],
  ['address1', 'address1'],
  // companyName is NOT in the documented UpdateContactDto for 2021-04-15, but
  // GHL does send it on the contact payload. Passed through under our own
  // `business` name too — if GHL rejects it the whole patch 422s with its own
  // message, which is better than silently dropping the field and reporting a
  // successful save.
  ['business', 'companyName'],
  ['companyName', 'companyName'],
  ['city', 'city'],
  ['state', 'state'],
  ['postalCode', 'postalCode'],
  ['website', 'website'],
  ['timezone', 'timezone'],
  ['country', 'country'],
  ['dateOfBirth', 'dateOfBirth'],
  ['source', 'source'],
  ['assignedTo', 'assignedTo'],
  // GHL calls it `type` on the contact object, not `contactType`. It is
  // @HideApiProperty on PUT — absent from the marketplace docs — but the
  // service applies it, the same pattern as the opportunity's contactId.
  // Two values only: 'lead' | 'customer'.
  ['contactType', 'type'],
  ['dnd', 'dnd'],
  ['dndSettings', 'dndSettings'],
  ['inboundDndSettings', 'inboundDndSettings'],
  ['customFields', 'customFields'],
  // THE LINK FROM A CONTACT TO ITS BUSINESS.
  //
  // GHL has no opportunities.business_id — a deal reaches a business only
  // through the contacts on it (migration 056). So "add a business to this
  // deal" is really "set businessId on one of its contacts", and that is the
  // write this mapping enables. It was absent, so the Deal Hub could only ever
  // SHOW a business a contact already had; it had no way to set one.
  //
  // The same field name the note patch already sends GHL for the same
  // concept. null clears the link, mirroring how companyName clears above.
  ['businessId', 'businessId']
]);

// GHL's documented max lengths. Truncating silently would be worse than
// failing, so these reject instead.
const MAX_LENGTHS = {
  firstName: 1500, lastName: 1500, name: 1500,
  address1: 5000, website: 1500, source: 1500
};

export class ContactWriteError extends Error {
  constructor(message, { status = 400, field = null } = {}) {
    super(message);
    this.name = 'ContactWriteError';
    this.status = status;
    this.field = field;
  }
}

/**
 * Validate and normalise a patch before it reaches GHL.
 *
 * Exported for tests: the mapping is where a silent data-loss bug would live,
 * and it needs no network or database to check.
 */
// Same field map as an update, minus the two things create doesn't share
// with it: `type`'s "clearing not offered" rule (a brand-new contact has no
// existing type to preserve, so an empty/omitted type is fine — GHL just
// leaves it unset) and the tags block (a NEW contact has no other tags to
// accidentally delete, so there is nothing to protect here the way update
// must). Reuses buildContactPatch for every other validation rule (email
// format, max lengths, dateOfBirth, country) rather than duplicating it —
// those rules don't change between create and update.
export function buildContactCreatePatch(input = {}) {
  const withoutType = { ...input };
  // Route type through unchanged if present, but skip buildContactPatch's
  // "empty type throws" rule — call it only if a value was actually given.
  const hasType = 'contactType' in withoutType && String(withoutType.contactType ?? '').trim() !== '';
  if (!hasType) delete withoutType.contactType;

  const withoutTags = { ...withoutType };
  delete withoutTags.tags; // create has nothing to protect; just drop silently

  const { patch, dropped } = buildContactPatch(withoutTags);

  // The one thing create needs that update never sends: a contact must be
  // addressable by AT LEAST a name or a way to reach them, or GHL creates a
  // nameless, contactless ghost row indistinguishable from a fat-fingered
  // request. Checked here, not left to GHL's own validation, so a rep sees
  // "needs at least a name, phone or email" instead of a raw 422 detail.
  const addressable = patch.firstName || patch.lastName || patch.name
    || patch.email || patch.phone;
  if (!addressable) {
    throw new ContactWriteError(
      'A new contact needs at least a name, phone number or email address',
      { field: 'firstName' }
    );
  }

  return { patch, dropped };
}

export function buildContactPatch(input = {}) {
  const patch = {};
  const dropped = [];

  for (const [key, value] of Object.entries(input)) {
    if (!WRITABLE.has(key)) {
      dropped.push(key);
      continue;
    }
    const target = WRITABLE.get(key);
    if (target === null) {
      dropped.push(key);
      continue;
    }
    if (value === undefined) continue;

    // Contact type. GHL accepts 'lead' or 'customer' and nothing else —
    // anything outside that is rejected, so it fails here with a message
    // naming the field rather than as an opaque 422 upstream.
    if (target === 'type') {
      const v = String(value ?? '').trim().toLowerCase();
      if (v === '') {
        // Clearing is not offered: GHL has no "no type" state, and sending
        // an empty string sets nothing while looking like it saved.
        throw new ContactWriteError(
          'Pick a contact type', { field: 'contactType' }
        );
      }
      if (v !== 'lead' && v !== 'customer') {
        throw new ContactWriteError(
          'Contact type must be Lead or Customer', { field: 'contactType' }
        );
      }
      patch.type = v;
      continue;
    }

    // An empty string is a deliberate clear, so it must survive. Only
    // undefined means "not being changed".
    if (typeof value === 'string') {
      const trimmed = value.trim();
      const max = MAX_LENGTHS[key];
      if (max && trimmed.length > max) {
        throw new ContactWriteError(
          `${key} must be ${max} characters or fewer`, { field: key }
        );
      }
      patch[target] = trimmed;
      continue;
    }
    patch[target] = value;
  }

  // Validate the two fields GHL is strict about, so a bad value fails here
  // with a useful message rather than as an opaque 422 upstream.
  if (patch.email) {
    // Deliberately loose: GHL is the authority on what it accepts, and a
    // strict regex here would reject addresses that are actually valid.
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(patch.email)) {
      throw new ContactWriteError('That email address is not valid', { field: 'email' });
    }
  }
  // Custom fields: [{ id, field_value }].
  //
  // GHL is specific about this shape — note field_value, SNAKE case, unlike
  // every other key in the body. Sending { fieldValue } or a bare object is
  // accepted by the request and then silently ignored, which is worse than a
  // rejection: the rep sees a successful save and an unchanged value.
  if (patch.customFields !== undefined) {
    if (!Array.isArray(patch.customFields)) {
      throw new ContactWriteError(
        'Custom fields must be a list', { field: 'customFields' }
      );
    }
    patch.customFields = patch.customFields.map((f, i) => {
      if (!f || typeof f !== 'object' || Array.isArray(f)) {
        throw new ContactWriteError(
          `Custom field ${i + 1} is not valid`, { field: 'customFields' }
        );
      }
      const id = typeof f.id === 'string' ? f.id.trim() : '';
      if (!id) {
        throw new ContactWriteError(
          `Custom field ${i + 1} has no id`, { field: 'customFields' }
        );
      }
      // Accept either spelling from the caller and always SEND field_value.
      // A clear is an empty string, not a dropped key — omitting it leaves
      // the old value in place.
      const raw = f.field_value !== undefined ? f.field_value : f.fieldValue;
      return { id, field_value: raw === undefined || raw === null ? '' : raw };
    });
  }

  if (patch.dateOfBirth && !/^\d{4}-\d{2}-\d{2}$/.test(patch.dateOfBirth)) {
    throw new ContactWriteError(
      'Date of birth must be YYYY-MM-DD', { field: 'dateOfBirth' }
    );
  }
  if (patch.country && !/^[A-Za-z]{2}$/.test(patch.country)) {
    throw new ContactWriteError(
      'Country must be a two-letter ISO code, e.g. GB', { field: 'country' }
    );
  }
  if (patch.country) patch.country = patch.country.toUpperCase();

  // TAGS ARE DELIBERATELY NOT WRITABLE HERE.
  //
  // GHL's update endpoint OVERWRITES the whole tag array — sending ['vip']
  // silently deletes every other tag on the contact. Our UI shows tags from
  // both the contact and the opportunity, so a partial list is easy to send by
  // accident and impossible to recover. Tag edits need the dedicated
  // Add/Remove Tag endpoints, which patch instead of replace.
  if ('tags' in input) {
    throw new ContactWriteError(
      'Tags cannot be changed here — GHL replaces the whole tag list, which would delete the others',
      { field: 'tags' }
    );
  }

  return { patch, dropped };
}
