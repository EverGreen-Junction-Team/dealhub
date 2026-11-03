// businessPatch.js — validate and map a business create/edit for GHL's
// /businesses endpoints.
//
// Dependency-free, like contactPatch / taskPatch / notePatch / tagPatch: no
// config, no database, no network, so the mapping can be unit-tested directly.
//
// Endpoints (API version 2021-04-15):
//   POST   /businesses                 (locationId in the body)
//   PUT    /businesses/{businessId}    (locationId NOT accepted — see below)
//   DELETE /businesses/{businessId}
//
// Scope is businesses.write, NOT contacts.write — the businesses.readonly we
// already hold for the daily sync is not enough.

// Fields both write endpoints accept. Anything else is dropped rather than
// passed through: an unknown key makes GHL reject the whole request, so one typo
// would lose the valid fields alongside it.
const WRITABLE = new Set([
  'name', 'phone', 'email', 'website', 'address', 'city',
  'postalCode', 'state', 'country', 'description',
  'domainname', 'companylogo'
]);

// Documented as rejected by the public API with "Custom fields are not
// supported yet", and as import-only. Named explicitly so the error says why
// rather than silently dropping them.
const REFUSED = new Map([
  ['customFields', 'Custom fields are not supported on the business API yet'],
  ['externalObjectId', 'externalObjectId is import-only and not writable here'],
  ['externalImportMetaData', 'externalImportMetaData is import-only and not writable here'],
  ['relations', 'The business API has no relations field']
]);

const MAX_DOMAIN = 253;

export class BusinessWriteError extends Error {
  // `reason` is a machine-readable code for cases the message alone cannot
  // convey — 'reauth_required' vs 'not_installed' need different fixes and
  // used to share one message. Null for ordinary validation errors.
  constructor(message, { status = 400, field = null, reason = null } = {}) {
    super(message);
    this.name = 'BusinessWriteError';
    this.status = status;
    this.field = field;
    this.reason = reason;
  }
}

/**
 * GHL wants a bare domain: no protocol, no path, no spaces, max 253 chars, and
 * unique per location.
 *
 * A rep pasting from the address bar supplies "https://acme.com/" — normalise
 * rather than reject, since the intent is unambiguous. Anything genuinely
 * ambiguous (two dots' worth of nothing, an email address) fails here with a
 * message, not as an opaque 422.
 */
export function normaliseDomain(value, { field = 'domainname' } = {}) {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') {
    throw new BusinessWriteError('Domain must be text', { field });
  }

  let d = value.trim().toLowerCase();
  if (!d) return null;

  // Strip what a paste from the browser brings with it.
  d = d.replace(/^[a-z][a-z0-9+.-]*:\/\//, '');   // protocol
  d = d.replace(/^www\./, '');                     // www. is not part of the domain
  d = d.split('/')[0];                             // path
  d = d.split('?')[0].split('#')[0];               // query / fragment
  d = d.replace(/\.$/, '');                        // trailing dot (valid DNS, not wanted here)

  if (!d) throw new BusinessWriteError('That is not a domain', { field });
  if (d.includes('@')) {
    throw new BusinessWriteError(
      'That looks like an email address, not a domain', { field }
    );
  }
  if (/\s/.test(d)) {
    throw new BusinessWriteError('A domain cannot contain spaces', { field });
  }
  if (d.length > MAX_DOMAIN) {
    throw new BusinessWriteError(
      `A domain must be ${MAX_DOMAIN} characters or fewer`, { field }
    );
  }
  // At least one dot and only domain-legal characters. Deliberately loose about
  // the TLD — new ones appear constantly and a strict list would reject valid
  // domains.
  if (!/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)+$/.test(d)) {
    throw new BusinessWriteError(
      'That is not a valid domain — use the bare domain, like acme.com', { field }
    );
  }
  return d;
}

/**
 * companylogo is an array of { url, meta? }, max one entry, url must be https.
 *
 * A bare string url is accepted and wrapped: it's the obvious thing a caller
 * sends, and rejecting it would be pedantry.
 */
export function normaliseLogo(value, { field = 'companylogo' } = {}) {
  if (value === null || value === '') return null;

  const items = typeof value === 'string' ? [{ url: value }] : value;
  if (!Array.isArray(items)) {
    throw new BusinessWriteError(
      'Logo must be a URL, or a list of one { url }', { field }
    );
  }
  if (items.length === 0) return [];
  if (items.length > 1) {
    throw new BusinessWriteError('Only one logo is allowed', { field });
  }

  const item = items[0];
  const url = typeof item === 'string' ? item : item?.url;
  if (typeof url !== 'string' || !url.trim()) {
    throw new BusinessWriteError('The logo needs a URL', { field });
  }
  const trimmed = url.trim();
  // GHL requires https. http would be accepted by us and rejected by them.
  if (!/^https:\/\//i.test(trimmed)) {
    throw new BusinessWriteError(
      'The logo URL must start with https://', { field }
    );
  }

  // Preserve meta if the caller sent it — dropping it would lose data on an
  // edit that wasn't about the logo at all.
  const out = { url: trimmed };
  if (item && typeof item === 'object' && item.meta !== undefined) {
    out.meta = item.meta;
  }
  return [out];
}

/**
 * Validate and normalise a business body before it reaches GHL.
 *
 * @param {object} input
 * @param {object} opts
 * @param {boolean} opts.create true for POST — `name` becomes required
 * @returns {{ patch: object, dropped: string[] }}
 */
export function buildBusinessPatch(input = {}, { create = false } = {}) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new BusinessWriteError('Nothing to save', { status: 400 });
  }

  const patch = {};
  const dropped = [];

  for (const [key, value] of Object.entries(input)) {
    // locationId is handled by the caller, not here: it is REQUIRED on create
    // and REJECTED on update (a business cannot move location). Letting it
    // through would 422 every edit.
    if (key === 'locationId') {
      dropped.push(key);
      continue;
    }
    if (REFUSED.has(key)) {
      throw new BusinessWriteError(REFUSED.get(key), { field: key });
    }
    if (!WRITABLE.has(key)) {
      dropped.push(key);
      continue;
    }
    if (value === undefined) continue;

    if (key === 'domainname') {
      patch.domainname = normaliseDomain(value);
      continue;
    }
    if (key === 'companylogo') {
      patch.companylogo = normaliseLogo(value);
      continue;
    }

    // Everything else is a plain string. Null and '' are deliberate clears and
    // must survive — except `name`, guarded below.
    if (value === null) {
      patch[key] = null;
      continue;
    }
    if (typeof value !== 'string') {
      throw new BusinessWriteError(`${key} must be text`, { field: key });
    }
    const trimmed = value.trim();

    if (key === 'email' && trimmed) {
      // Deliberately loose — GHL is the authority on what it accepts, and a
      // strict pattern here would reject addresses that are actually valid.
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
        throw new BusinessWriteError('That email address is not valid', { field: 'email' });
      }
    }
    if (key === 'country' && trimmed) {
      if (!/^[A-Za-z]{2}$/.test(trimmed)) {
        throw new BusinessWriteError(
          'Country must be a two-letter code, e.g. GB', { field: 'country' }
        );
      }
      patch.country = trimmed.toUpperCase();
      continue;
    }

    patch[key] = trimmed;
  }

  // name: required on create, and never clearable. GHL rejects an empty name
  // outright, so an edit that blanks it would fail anyway — better to say so
  // with the field named.
  if (create) {
    if (!patch.name) {
      throw new BusinessWriteError('A business needs a name', { field: 'name' });
    }
  } else {
    if (Object.keys(patch).length === 0) {
      throw new BusinessWriteError('Nothing to update', { status: 400 });
    }
    if ('name' in patch && !patch.name) {
      throw new BusinessWriteError(
        'A business needs a name — it cannot be cleared', { field: 'name' }
      );
    }
  }

  return { patch, dropped };
}

/**
 * GHL business ids are Mongo ObjectIds, and their guard rejects anything else
 * before it reaches the record.
 *
 * Checked locally so a malformed id fails with a clear message instead of a 400
 * whose body says "Invalid ObjectId" — and so a caller can't aim a request at
 * a path segment that isn't an id at all.
 */
export function assertBusinessId(businessId) {
  if (typeof businessId !== 'string' || !/^[0-9a-fA-F]{24}$/.test(businessId)) {
    throw new BusinessWriteError(
      'That is not a valid business id', { status: 400, field: 'businessId' }
    );
  }
  return businessId;
}
