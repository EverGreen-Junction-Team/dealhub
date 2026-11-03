// matcher.js — link a call to its contact, rep and deal.
//
//   Contact  customer number → contacts.phone (last-10-digit key, indexed),
//            else GHL contact search by phone (then the contact is stubbed
//            locally so the FK-free join works), else none. Withheld → none.
//
//   Rep      in order: call_user_map 'user' (provider user id) →
//            provider user email ↔ users.email → call_user_map 'extension'
//            → call_user_map 'number' (the DDI / line dialled or used) →
//            users.phone tail. A manual map row always wins over the
//            automatic email match, which is what handles head-office calls
//            routed to an extension: the extension, not the main number,
//            names the rep.
//
//   Deal     attributionEngine.resolveOppForContact — the same rule messages
//            use (earliest open deal; ambiguous / multi-open left unlinked).

import { rawQuery } from '../db.js';
import { getActiveInstall, ghlRequest } from '../services/ghlClient.js';
import { ensureContactExists } from '../services/contactStub.js';
import { resolveOppForContact } from '../services/attributionEngine.js';
import { digitTail, toE164 } from '../utils/phone.js';
import { logger } from '../utils/logger.js';

// ─── contact ─────────────────────────────────────────────────────────────

async function contactByPhoneInDb(locationId, number) {
  const tail = digitTail(number);
  if (!tail) return null;
  const { rows } = await rawQuery(
    `SELECT contact_id, phone, first_name, last_name
       FROM contacts
      WHERE location_id = $1
        AND phone IS NOT NULL
        AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $2
      ORDER BY updated_at DESC NULLS LAST
      LIMIT 2`,
    [locationId, tail]
  );
  if (rows.length === 0) return null;
  if (rows.length > 1) {
    logger.info({ locationId, tail, contacts: rows.map((r) => r.contact_id) },
      'matcher: several contacts share this number — taking the most recently updated');
  }
  return rows[0].contact_id;
}

async function contactByPhoneInGhl(locationId, e164) {
  if (!e164) return null;
  const install = await getActiveInstall(locationId);
  if (!install) return null;
  try {
    const resp = await ghlRequest(install, {
      method: 'POST',
      url: '/contacts/search',
      data: {
        locationId,
        pageLimit: 5,
        filters: [{ field: 'phone', operator: 'eq', value: e164 }]
      },
      scopeOptional: true
    });
    const hit = (resp.data?.contacts || [])[0];
    if (!hit?.id) return null;
    await ensureContactExists(locationId, hit.id);
    return hit.id;
  } catch (err) {
    logger.warn({ err, locationId, e164 }, 'matcher: GHL contact search failed');
    return null;
  }
}

export async function matchContact(locationId, call, settings = {}) {
  const number = call.customer_number
    || (call.direction === 'inbound' ? call.from_e164 : call.to_e164)
    || toE164(call.direction === 'inbound' ? call.from_number : call.to_number, { defaultCountry: settings.defaultCountry });
  if (!number) return { contactId: null, method: 'none', reason: 'no customer number' };

  const fromDb = await contactByPhoneInDb(locationId, number);
  if (fromDb) return { contactId: fromDb, method: 'db_phone' };

  const fromGhl = await contactByPhoneInGhl(locationId, number);
  if (fromGhl) return { contactId: fromGhl, method: 'ghl_search' };

  return { contactId: null, method: 'none', reason: 'no contact with this number' };
}

// ─── rep ─────────────────────────────────────────────────────────────────

async function mapLookup(locationId, provider, keyType, key) {
  if (!key) return null;
  const { rows } = await rawQuery(
    `SELECT user_id, user_name, source FROM call_user_map
      WHERE location_id = $1 AND provider = $2 AND key_type = $3 AND lower(key) = lower($4)`,
    [locationId, provider, keyType, String(key)]
  );
  return rows[0] || null;
}

async function userByEmail(locationId, email) {
  if (!email) return null;
  const { rows } = await rawQuery(
    `SELECT user_id, name FROM users
      WHERE location_id = $1 AND lower(email) = lower($2) AND active IS DISTINCT FROM false
      LIMIT 1`,
    [locationId, email]
  );
  return rows[0] || null;
}

async function userByPhone(locationId, number) {
  const tail = digitTail(number);
  if (!tail) return null;
  const { rows } = await rawQuery(
    `SELECT user_id, name FROM users
      WHERE location_id = $1 AND phone IS NOT NULL AND active IS DISTINCT FROM false
        AND right(regexp_replace(COALESCE(phone, ''), '\\D', '', 'g'), 10) = $2
      LIMIT 2`,
    [locationId, tail]
  );
  return rows.length === 1 ? rows[0] : null;
}

export async function matchUser(locationId, call) {
  const provider = call.provider;
  const ourNumber = call.our_number || (call.direction === 'inbound' ? call.to_e164 : call.from_e164);

  const byUser = await mapLookup(locationId, provider, 'user', call.provider_user_id);
  if (byUser) return { userId: byUser.user_id, method: byUser.source === 'manual' ? 'manual' : 'map_user' };

  const byEmailMap = await mapLookup(locationId, provider, 'email', call.provider_user_email);
  if (byEmailMap) return { userId: byEmailMap.user_id, method: 'map_email' };

  const byEmail = await userByEmail(locationId, call.provider_user_email);
  if (byEmail) return { userId: byEmail.user_id, method: 'email' };

  const byExt = await mapLookup(locationId, provider, 'extension', call.extension);
  if (byExt) return { userId: byExt.user_id, method: 'map_extension' };

  const byNumber = await mapLookup(locationId, provider, 'number', ourNumber);
  if (byNumber) return { userId: byNumber.user_id, method: 'map_number' };

  const byPhone = await userByPhone(locationId, ourNumber);
  if (byPhone) return { userId: byPhone.user_id, method: 'users_phone' };

  return { userId: null, method: 'none' };
}

// ─── deal ────────────────────────────────────────────────────────────────

export async function matchDeal(locationId, contactId, at) {
  if (!contactId) return { opportunityId: null, status: 'unassigned', rule: 'no_contact', confidence: null };
  const d = await resolveOppForContact(locationId, contactId, at ? new Date(at) : null);
  if (!d) return { opportunityId: null, status: 'unassigned', rule: 'no_contact', confidence: null };
  return {
    opportunityId: d.opportunityId || null,
    status: d.mappingStatus || 'unassigned',
    rule: d.rule || null,
    confidence: d.confidence ?? null
  };
}

// ─── all three ───────────────────────────────────────────────────────────

/**
 * Run every match for one call and return the column updates. Pure with
 * respect to the calls row — the worker writes the result.
 */
export async function matchCall(locationId, call, settings = {}) {
  const contact = await matchContact(locationId, call, settings);
  const user = await matchUser(locationId, call);
  const deal = await matchDeal(locationId, contact.contactId, call.started_at);

  const matched = [contact.contactId, user.userId, deal.opportunityId].filter(Boolean).length;
  const matchStatus = matched === 3 ? 'matched' : (matched === 0 ? 'unmatched' : 'partial');

  return {
    contact_id: contact.contactId,
    contact_match_method: contact.method,
    user_id: user.userId,
    user_match_method: user.method,
    opportunity_id: deal.opportunityId,
    deal_match_status: deal.status,
    deal_match_rule: deal.rule,
    deal_match_confidence: deal.confidence,
    match_status: matchStatus
  };
}
