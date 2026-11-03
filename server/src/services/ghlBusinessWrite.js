// ghlBusinessWrite.js — create, edit and delete businesses in GoHighLevel.
//
// FLOW — the tasks pattern, not the contacts one, and for a stronger reason.
//
// Contacts, notes and tags all have webhooks, so those services write only to
// GHL and let the webhook write Postgres. Tasks have TaskCreate/Complete/Delete
// but no TaskUpdate, so task EDITS apply the echoed response directly.
//
// BUSINESSES HAVE NO WEBHOOKS AT ALL. Nothing is fired for create, update or
// delete — which is exactly why businessesSync.js is a daily cron rather than a
// webhook handler. So every operation here applies the echo, or a change would
// sit in GHL and not appear in this app until the next nightly sync, up to 24
// hours later.
//
// We apply GHL's ECHOED business rather than the patch we sent, so any
// normalisation they perform (address casing, phone formatting) is what we
// store. Same principle as letting a webhook win, applied to the response body.
//
// SCOPE. businesses.write — NOT contacts.write, and not the businesses.readonly
// the daily sync already uses. The install must be reauthorised after adding it.
//
// TWO RULES OF THEIRS WORTH KNOWING:
//
//   • domainname is UNIQUE PER LOCATION on the public API. A duplicate is a
//     422; we check our own rows first so the message names the business that
//     already holds it.
//
//   • A business with more than 2000 contacts can have its NAME changed at most
//     once per 24 hours. We cannot see their contact count, so this surfaces as
//     a translated 422 rather than a pre-check.

import { ghlRequest } from './ghlClient.js';
import { rejectionMessage, logRejection } from './ghlRejection.js';
import { rawQuery } from '../db.js';
import {
  buildBusinessPatch, assertBusinessId, BusinessWriteError
} from './businessPatch.js';
import { logger } from '../utils/logger.js';

export { buildBusinessPatch, assertBusinessId, BusinessWriteError };

function translateGhlError(err, { businessId = null, verb }) {
  const status = err.response?.status;
  const body = err.response?.data;
  const detail = body?.message || body?.error
    || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);

  if (status === 401 || status === 403) {
    return new BusinessWriteError(
      'This app cannot change businesses yet — the businesses.write permission is missing. Reauthorise the app.',
      { status: 403 }
    );
  }
  if (status === 404) {
    return new BusinessWriteError('That business no longer exists', { status: 404 });
  }
  if (status === 422 || status === 400) {
    // Their 24-hour name-change limit on large businesses. Unrecognisable from
    // the raw message, and the fix (wait, or rename in GHL) is worth stating.
    if (detail && /24\s*hour|once per day|rate/i.test(detail) && /name/i.test(detail)) {
      return new BusinessWriteError(
        'A business with over 2000 contacts can only be renamed once a day — try again tomorrow',
        { status: 422, field: 'name' }
      );
    }
    if (detail && /domain/i.test(detail)) {
      return new BusinessWriteError(
        `That domain cannot be used: ${detail}`, { status: 422, field: 'domainname' }
      );
    }
    if (detail && /custom field/i.test(detail)) {
      return new BusinessWriteError(
        'Custom fields are not supported on the business API yet',
        { status: 422, field: 'customFields' }
      );
    }
    // GHL's own text is LOGGED, never shown — services/ghlRejection.js
    // explains why: it names a field for a validation error, but a raw
    // record id for a missing one, and the whole sales team sees these.
    logRejection('ghlBusinessWrite', { status, detail, body });
    const rej = rejectionMessage('business', detail);
    return new BusinessWriteError(rej.message, { status: rej.status, detail });
  }
  logger.error(
    { err, status, businessId, body },
    `ghlBusinessWrite: ${verb} failed`
  );
  return new BusinessWriteError(
    `Could not ${verb} the business — try again`, { status: 502 }
  );
}

/**
 * Refuse a duplicate domain with a message that names the culprit.
 *
 * Checked against OUR rows, not GHL's: one indexed local lookup instead of a
 * round trip, and it only has to be right often enough to beat a bare 422. If
 * it's stale, GHL still rejects the write and translateGhlError produces a
 * usable message. This is a courtesy, not the enforcement.
 */
async function checkDomainFree(locationId, domain, excludeBusinessId = null) {
  if (!domain) return;
  const { rows } = await rawQuery(
    `SELECT business_id, name
       FROM businesses
      WHERE location_id = $1
        AND domain_name = $2
        AND is_active   = true
        AND ($3::text IS NULL OR business_id <> $3)
      LIMIT 1`,
    [locationId, domain, excludeBusinessId]
  );
  const clash = rows[0];
  if (clash) {
    throw new BusinessWriteError(
      `${clash.name || 'Another business'} already uses ${domain} — a domain can only belong to one business`,
      { status: 422, field: 'domainname' }
    );
  }
}

/**
 * Write GHL's echoed business onto our row.
 *
 * Only the fields GHL confirms, never the patch we sent. Assigned outright
 * rather than COALESCEd: clearing a website or a phone in GHL must clear it
 * here, and COALESCE would make removal impossible.
 *
 * Called for create too, since no webhook will insert the row.
 */
async function applyEcho(locationId, business) {
  if (!business?.id) return null;

  const logo = Array.isArray(business.companylogo) && business.companylogo.length
    ? JSON.stringify(business.companylogo)
    : null;

  const { rows } = await rawQuery(
    `INSERT INTO businesses (
       location_id, business_id, name, description, website, email, phone,
       address, city, state, postal_code, country,
       domain_name, company_logo,
       created_by, updated_by, raw_business, is_active,
       created_at_ghl, updated_at_ghl, last_synced_at, imported_at, updated_at
     ) VALUES (
       $1,$2,$3,$4,$5,$6,$7,
       $8,$9,$10,$11,$12,
       $13,$14,
       $15,$16,$17,true,
       $18,$19, now(), now(), now()
     )
     ON CONFLICT (location_id, business_id) DO UPDATE SET
       name           = EXCLUDED.name,
       description    = EXCLUDED.description,
       website        = EXCLUDED.website,
       email          = EXCLUDED.email,
       phone          = EXCLUDED.phone,
       address        = EXCLUDED.address,
       city           = EXCLUDED.city,
       state          = EXCLUDED.state,
       postal_code    = EXCLUDED.postal_code,
       country        = EXCLUDED.country,
       domain_name    = EXCLUDED.domain_name,
       company_logo   = EXCLUDED.company_logo,
       created_by     = COALESCE(EXCLUDED.created_by, businesses.created_by),
       updated_by     = EXCLUDED.updated_by,
       raw_business   = EXCLUDED.raw_business,
       is_active      = true,
       created_at_ghl = COALESCE(EXCLUDED.created_at_ghl, businesses.created_at_ghl),
       updated_at_ghl = EXCLUDED.updated_at_ghl,
       last_synced_at = now(),
       updated_at     = now()
     RETURNING business_id`,
    [
      locationId, business.id,
      business.name ?? null, business.description ?? null, business.website ?? null,
      business.email ?? null, business.phone ?? null,
      business.address ?? null, business.city ?? null, business.state ?? null,
      business.postalCode ?? null, business.country ?? null,
      business.domainname ?? null, logo,
      business.createdBy ?? null, business.updatedBy ?? null,
      business,
      business.createdAt ? new Date(business.createdAt) : null,
      business.updatedAt ? new Date(business.updatedAt) : null
    ]
  );
  return rows[0]?.business_id || null;
}

/**
 * POST /businesses
 *
 * locationId goes in the BODY here (the only endpoint that takes it), and comes
 * from the session's install — never from the caller, or a client could create a
 * business in another tenant.
 */
export async function createGhlBusiness(install, input) {
  const locationId = install.location_id;
  const { patch, dropped } = buildBusinessPatch(input, { create: true });

  if (dropped.length) {
    logger.warn({ dropped }, 'ghlBusinessWrite: ignored non-writable fields');
  }
  await checkDomainFree(locationId, patch.domainname);

  let business;
  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: '/businesses/',
      data: { ...patch, locationId }
    });
    business = data?.business || null;
  } catch (err) {
    throw translateGhlError(err, { verb: 'create' });
  }

  // No webhook will insert this row, so the insert happens here or the business
  // is invisible in this app until the nightly sync.
  try {
    await applyEcho(locationId, business);
  } catch (err) {
    logger.error(
      { err, businessId: business?.id },
      'ghlBusinessWrite: created in GHL but the local row was not written'
    );
  }

  logger.info(
    { businessId: business?.id, fields: Object.keys(patch) },
    'ghlBusinessWrite: business created'
  );
  return business;
}

/**
 * PUT /businesses/{businessId}
 *
 * locationId is NOT accepted — a business cannot move location. buildBusinessPatch
 * drops it, so a client sending a whole record doesn't 422 the whole edit.
 */
export async function updateGhlBusiness(install, businessId, input) {
  assertBusinessId(businessId);
  const locationId = install.location_id;
  const { patch, dropped } = buildBusinessPatch(input, { create: false });

  if (dropped.length) {
    logger.warn({ businessId, dropped }, 'ghlBusinessWrite: ignored non-writable fields');
  }
  if (patch.domainname) {
    await checkDomainFree(locationId, patch.domainname, businessId);
  }

  let business;
  try {
    const { data } = await ghlRequest(install, {
      method: 'PUT',
      url: `/businesses/${encodeURIComponent(businessId)}`,
      data: patch
    });
    business = data?.business || null;
  } catch (err) {
    throw translateGhlError(err, { businessId, verb: 'update' });
  }

  // The write succeeded in GHL. A local failure after this point must not be
  // reported as a failed save — GHL is the source of truth and it has the
  // change. Log loudly; the nightly sync reconciles.
  try {
    await applyEcho(locationId, business);
  } catch (err) {
    logger.error(
      { err, businessId },
      'ghlBusinessWrite: saved to GHL but the local row did not update'
    );
  }

  logger.info(
    { businessId, fields: Object.keys(patch) },
    'ghlBusinessWrite: business updated'
  );
  return business;
}

/**
 * DELETE /businesses/{businessId}
 *
 * A soft delete on their side (`deleted: true`), which matches what we do
 * locally: is_active = false, the row kept. businessesSync already treats
 * is_active = false as "gone from GHL", so the two agree.
 */
export async function deleteGhlBusiness(install, businessId) {
  assertBusinessId(businessId);

  try {
    await ghlRequest(install, {
      method: 'DELETE',
      url: `/businesses/${encodeURIComponent(businessId)}`
    });
  } catch (err) {
    throw translateGhlError(err, { businessId, verb: 'delete' });
  }

  try {
    await rawQuery(
      `UPDATE businesses
          SET is_active = false, updated_at = now()
        WHERE location_id = $1 AND business_id = $2 AND is_active = true`,
      [install.location_id, businessId]
    );
  } catch (err) {
    logger.error(
      { err, businessId },
      'ghlBusinessWrite: deleted in GHL but the local row did not update'
    );
  }

  logger.info({ businessId }, 'ghlBusinessWrite: business deleted');
  return true;
}
