import { withTenant, rawQuery } from '../db.js';
import { cleanMessageBody } from './dataCleaner.js';
import { fetchContactMessagesViaExport } from './messageEnrichment.js';
import {
  getOpportunityFull,
  getContactFull,
  getPipelineLookup,
  getUserName,
  getCustomFieldNameMaps
} from './ghlEnrichment.js';
import { customFieldsFrom, jsonbParam } from './customFieldResolve.js';
import { refreshAssociationsForOpportunity } from './associationRefresher.js';
import { fanoutToDeal } from './tagFanout.js';
import { recordFieldChanges } from './opportunityFieldHistory.js';
import { logger } from '../utils/logger.js';

// Writes the 4 canonical tables (contacts, opportunities, stage_history,
// messages) per STAGE_HISTORY_WEBHOOK_PLAN Section 5.
//
// Every write happens inside a single `withTenant(locationId, ...)` so that
// the RLS session variable is set and our `(location_id, ...)` FK chain is
// honoured across all four tables.

const MEDDIC_KEYS = [
  'meddic_1','meddic_2','meddic_3','meddic_4','meddic_5',
  'meddic_6','meddic_7','meddic_8','meddic_9','meddic_10','meddic_11'
];

// Helpers to pull the values the plan wants promoted, regardless of how
// GHL nests them. GHL's webhook payloads put the opportunity fields at the
// TOP LEVEL (not under an `opportunity` key), but the REST API and a few
// older webhook variants do nest. Try both shapes for resilience.
function pickContact(event) {
  // Two shapes:
  //   - bare webhook   → only `contactId` at top level (no nested contact)
  //   - enriched event → event.contact = full contact w/ customFieldsResolved
  const c = event.contact || {};
  // Same array-discarding bug as pickOpportunity below — see the comment there.
  const cf = customFieldsFrom(c, event._cfMap?.contactCfMap);
  return {
    contactId: c.id || event.contactId,
    customFields: cf,
    promoted: {
      gclid: cf.google_click_id || cf.gclid || null,
      gbraid: cf.gbraid || null,
      wbraid: cf.wbraid || null,
      gad_source: cf.gad_source || null,
      utm_source: cf.utm_source || null,
      utm_medium: cf.utm_medium || null,
      utm_campaign: cf.utm_campaign || null,
      utm_content: cf.utm_content || null,
      utm_term: cf.utm_term || null,
      // Coerced, NOT passed through: these are CHECKBOX fields and GHL sends
      // the ticked labels as an array. See asConsentBoolean.
      marketing_consent: asConsentBoolean(
        cf.marketing_consent_crittall ?? cf.marketing_consent ?? null
      )
    }
  };
}

// A CHECKBOX custom field, read as a yes/no.
//
// GHL sends a checkbox as an ARRAY OF THE TICKED LABELS, not a boolean:
//
//   ["I agree to receive occasional marketing communications (e.g. offers
//     and updates) from Bespoke Glazing Design."]
//
// `contacts.marketing_consent` is BOOLEAN, and this value was passed through
// untouched — so node-postgres serialised the array as a Postgres array
// literal and the insert died with
//
//   22P02 invalid input syntax for type boolean: "{"I agree to receive…"}"
//
// The whole opportunity write is in one transaction, so EVERY OpportunityUpdate
// for a consenting contact was rolled back: the opportunity never reached our
// database, which is why a deal visible in GHL was missing from the app and
// from search. The webhook still answered 200, and GHL does not redeliver.
//
// TICKED IS TRUE. A checkbox with any option selected means the person
// agreed; an empty array means they did not. `null` stays null — absent is
// not the same as declined, and the column is nullable so that distinction
// survives.
function asConsentBoolean(v) {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v === 'boolean') return v;
  // An empty array is an explicit "not ticked".
  if (Array.isArray(v)) return v.filter((x) => x != null && String(x).trim() !== '').length > 0;
  if (typeof v === 'number') return v !== 0;
  const t = String(v).trim().toLowerCase();
  if (t === '') return null;
  // GHL has also sent these spellings for a genuine boolean field.
  if (['false', 'no', 'off', '0', 'null', 'undefined'].includes(t)) return false;
  return true;
}

// Normalise a checkbox-style custom-field value into a JSON array. GHL may
// return it as: an array of strings (canonical), a single string, a comma-
// separated string, or null. Never returns null when input has content —
// downstream JSONB column expects array or null.
function asCheckboxArray(v) {
  if (v == null) return null;
  if (Array.isArray(v)) return v;
  if (typeof v === 'string') {
    // Comma-separated fallback — some legacy GHL payloads send checkbox
    // selections as "A, B, C" rather than an array.
    if (v.includes(',')) return v.split(',').map((s) => s.trim()).filter(Boolean);
    return [v];
  }
  return [v];
}

function pickOpportunity(event) {
  // Webhook = flat shape (opp fields at top level + `id` = opp id).
  // REST/older = nested shape under `event.opportunity`.
  // Fall through so either works.
  const o = event.opportunity || event;
  // customFields can be EITHER:
  //   - resolved object   { product_system: "Crittall", ... }     ← enriched path
  //   - raw GHL array     [{ id, fieldValue, ... }]                ← bare webhook
  //
  // The array used to be discarded (`Array.isArray(...) ? {} : ...`), which
  // made every promoted field `undefined` and left client_type,
  // product_system, product_type, first_contact_method and
  // lead_source_opportunity permanently NULL whenever enrichment could not
  // run — a 404, a timeout, or a rate limit on getOpportunityFull. The visible
  // symptom: a rep picks a value in the dashboard, the PUT to GHL succeeds,
  // and the chip still reads "Not set" after a reload.
  //
  // customFieldsFrom resolves the array against the location's id→key map,
  // which enrichEvent attaches as `_cfMap`.
  const cf = customFieldsFrom(o, event._cfMap?.opportunityCfMap);
  // undefined, not null, for a key GHL did not send — same reason as the
  // promoted block below. `?? null` here put meddic_1 in the audit's top-eight
  // duplicate-row list (800 rows across 31 deals).
  const meddic = Object.fromEntries(
    MEDDIC_KEYS
      .filter((k) => Object.prototype.hasOwnProperty.call(cf, k))
      .map((k) => [k, cf[k] ?? null])
  );
  // For the opp id we accept (in order): nested .id, event.opportunityId, top-level
  // event.id (the flat-webhook case). The receiver passes the dedup id separately
  // via webhookId, so using event.id for the opp id doesn't collide with dedup.
  const opportunityId = (event.opportunity?.id) || event.opportunityId || event.id;

  // ABSENT vs CLEARED — the distinction the whole promoted block below turns on.
  //
  // A bare webhook carries no custom fields at all: line above resolves `cf` to
  // {}, so every key is missing. Mapping a missing key with `|| null` said
  // "GHL cleared this field", which is a lie, and it had two costs:
  //
  //   • opportunity_field_history recorded a change to null on EVERY event.
  //     diffTrackedFields skips a field only when it is `undefined`; `|| null`
  //     produced null, so the guard never fired and valueEquals("0", null) was
  //     always false. The UPSERT then COALESCEd the null away, leaving the DB
  //     value unchanged — so the next event wrote the identical row again.
  //     Forever. That is the 35-rows-per-deal figure in the audit.
  //
  //   • Any consumer reading `promoted` could not tell "no value" from
  //     "not sent".
  //
  // absent() returns undefined when the key was not in the payload, and the
  // real value (including null) when it was. Fields the caller leaves undefined
  // are skipped by the history differ, which is exactly right.
  const has = (key) => Object.prototype.hasOwnProperty.call(cf, key);
  const absent = (key, value) => (has(key) ? value : undefined);

  // forecast_probability — read the NATIVE opportunity property first.
  //
  // This column held 836 non-null values with exactly ONE distinct value (0),
  // because only the CUSTOM field `cf.forecast_probability` was ever read, and
  // nobody populates that in GHL. Meanwhile GHL's own opportunity object
  // carries `forecastProbability` (0-100, documented on their create/update
  // DTO) and it was never looked at.
  //
  // Native first, custom field as fallback: a location that does drive the
  // custom field keeps working.
  //
  // Range-checked rather than trusted. A value outside 0-100 is not a
  // probability, and storing it would quietly corrupt any weighted-pipeline
  // figure computed from this column.
  //
  // hasOwnProperty, not `??`: a native null means the rep CLEARED the
  // probability and must be recorded as a change to null. `a ?? b` treats null
  // and undefined alike, so it collapsed a deliberate clear into "not sent".
  let forecastProbability;
  // PRESENT AND NON-NULL. hasOwnProperty alone treated GHL's
  // `forecastProbability: null` -- which it sends on every opportunity webhook
  // -- as a deliberate clear. That wrote null over the stored 0, the next
  // event saw 0 again, and the pair "0 -> null" was logged 7,598 times across
  // all seven webhook types.
  //
  // A null from GHL means "no probability sent", not "the rep cleared it", so
  // it falls through to the custom field below -- the only source that has
  // ever actually carried a value for this column.
  const nativeProb = o.forecastProbability ?? event.forecastProbability;
  const hasNativeProb = nativeProb != null;
  if (hasNativeProb || has('forecast_probability')) {
    const rawProb = hasNativeProb ? nativeProb : cf.forecast_probability;
    forecastProbability = null;
    if (rawProb != null && rawProb !== '') {
      const n = Number(rawProb);
      if (!Number.isNaN(n) && n >= 0 && n <= 100) forecastProbability = n;
    }
  }

  // forecast_expected_close_date — same story: GHL's native field is
  // `forecastExpectedCloseDate` (what our own write path sends), so read that
  // before falling back to the custom field.
  let forecastCloseDate;
  const hasNativeClose = Object.prototype.hasOwnProperty.call(o, 'forecastExpectedCloseDate')
    || Object.prototype.hasOwnProperty.call(event, 'forecastExpectedCloseDate');
  if (hasNativeClose || has('forecast_expected_close_date')) {
    const rawClose = hasNativeClose
      ? (o.forecastExpectedCloseDate ?? event.forecastExpectedCloseDate)
      : cf.forecast_expected_close_date;
    forecastCloseDate = null;
    if (rawClose) {
      const d = new Date(rawClose);
      if (!Number.isNaN(d.getTime())) forecastCloseDate = d.toISOString().slice(0, 10);
    }
  }

  return {
    opportunityId,
    contactId: o.contactId || event.contactId,
    name: o.name || null,
    pipelineId: o.pipelineId || event.pipelineId || null,
    pipelineName: o.pipelineName || null,
    currentStageId: o.pipelineStageId || o.stageId || event.pipelineStageId || null,
    currentStageName: o.stageName || o.pipelineStageName || null,
    status: o.status || null,
    monetaryValue: o.monetaryValue ?? event.monetaryValue ?? null,
    assignedTo: o.assignedTo || event.assignedTo || null,
    // Populated by enrichEvent() via getUserName when the assignedTo id can
    // be resolved. Webhooks alone don't carry the name.
    assignedToName: o.assignedToName || event.assignedToName || null,
    customFields: cf,
    // Kept for the raw record only — NOT a source of the deal's tags.
    //
    // GHL does not send opportunity tags (migration 048), so this is [] on
    // every event. It was once fed to reconcileTags as the deal's tag set,
    // which is why opportunity_tags stayed empty. A deal's tags are now
    // derived from its contacts; see tagFanout.js.
    tags: Array.isArray(o.tags) ? o.tags : (Array.isArray(event.tags) ? event.tags : []),
    // Full raw opp payload for future-proofing. Prefer the enriched REST
    // response (has createdAt/updatedAt/lostReasonId/etc.); fall back to
    // the flat webhook shape.
    rawOpportunity: event.opportunity || o,
    // GHL opp.source is different from contact.source and utm_source.
    opportunitySource: o.source ?? null,
    // GHL sends lostReason as text (via lost_reason custom field) OR
    // resolves via lostReasonId. Prefer the resolved name if enrichment
    // populated it; else the raw field.
    lostReason: o.lostReason || o.lost_reason || cf.lost_reason || null,
    // Workflow-copied from contact.google_click_id to opportunity.gclid.
    gclid: cf.gclid || null,
    // GHL location currency — future TODO to read from install config. Default GBP.
    currency: o.currency || 'GBP',
    // Every field here is `undefined` when GHL did not send it — see absent()
    // above. Do not reintroduce `|| null`: that is what caused the field-history
    // write loop.
    promoted: {
      ...meddic,
      client_type: absent('client_type', asCheckboxArray(cf.client_type)),
      product_system: absent('product_system', asCheckboxArray(cf.product_system)),
      product_type: absent('product_type', asCheckboxArray(cf.product_type)),
      postcode: absent('postcode', cf.postcode || null),
      // Two spellings; present under either one counts as sent.
      first_contact_method: (has('first_contact__method') || has('first_contact_method'))
        ? asCheckboxArray(cf.first_contact__method || cf.first_contact_method)
        : undefined,
      lead_source_opportunity: absent('lead_source_opportunity', cf.lead_source_opportunity || null),
      // THE INITIAL ENQUIRY — what the customer actually asked for.
      //
      // Written by the lead-source automations in GHL, and OVERWRITTEN there
      // on each new enquiry. The previous value is preserved in
      // all_initial_enquiry by appendEnquiryHistory() below, which runs
      // before the upsert so it can still see the old row.
      //
      // absent(), not `|| null`: a payload that does not carry the field at
      // all must leave the column alone. Coercing to null would read as "the
      // rep cleared it" and — worse — would look like a CHANGE, so the
      // history would gain an entry on every unrelated opportunity event.
      master_initial_enquiry: absent('master_initial_enquiry', cf.master_initial_enquiry || null),
      inquiry: absent('inquiry', cf.inquiry || null),
      // New in reviewed plan (CSV rows 34-38, 51):
      why_want: absent('why_want', cf.why_want || null),
      why_buy: absent('why_buy', cf.why_buy || null),
      why_blocker: absent('why_blocker', cf.why_blocker || null),
      forecast_close_date: forecastCloseDate,
      forecast_probability: forecastProbability,
      upload_from_enquiry: absent('upload_from_enquiry', cf.upload_from_enquiry || null)
    },
    // GHL webhooks use `dateAdded` for the opp creation time, REST uses `createdAt`.
    createdAtGhl: (o.createdAt || o.dateAdded || event.dateAdded)
      ? new Date(o.createdAt || o.dateAdded || event.dateAdded)
      : null,
    updatedAtGhl: (o.updatedAt || event.updatedAt)
      ? new Date(o.updatedAt || event.updatedAt)
      : null
  };
}

// Resolve the canonical event time. Priority is:
//   1. event.timestamp        — GHL's webhook envelope timestamp (most accurate)
//   2. event.dateAdded        — opportunity-level creation timestamp
//   3. event.eventTime        — older shape
//   4. wall-clock now()        — last-resort fallback; LOG LOUD so we can spot it
//
// Why this matters: this value becomes left_at / entered_at on stage_history
// rows and the upper bound of the message-fetch window. If we fall through
// to wall-clock on a webhook that's been retried hours late, in_stage_duration
// is processing-time-based, not event-time-based — durations skew.
function eventTimestamp(event) {
  const t = event.timestamp || event.dateAdded || event.eventTime;
  if (t) {
    const d = new Date(t);
    if (!Number.isNaN(d.getTime())) return d;
    logger.warn(
      { rawTimestamp: t, eventType: event.type || event.eventType },
      'eventTimestamp: GHL sent an unparseable timestamp — falling back to wall-clock now()'
    );
    return new Date();
  }
  logger.warn(
    { eventType: event.type || event.eventType, webhookId: event.webhookId },
    'eventTimestamp: webhook has no timestamp / dateAdded / eventTime — using wall-clock now() (durations may skew if this event was delayed)'
  );
  return new Date();
}

// ---------------------------------------------------- contact + opportunity

async function upsertContact(client, locationId, contact) {
  const p = contact.promoted;
  await client.query(
    `INSERT INTO contacts (location_id, contact_id, gclid, gbraid, wbraid, gad_source,
                           utm_source, utm_medium, utm_campaign, utm_content, utm_term,
                           marketing_consent, custom_fields, imported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13, now(), now())
     ON CONFLICT (location_id, contact_id) DO UPDATE SET
       gclid              = COALESCE(EXCLUDED.gclid, contacts.gclid),
       gbraid             = COALESCE(EXCLUDED.gbraid, contacts.gbraid),
       wbraid             = COALESCE(EXCLUDED.wbraid, contacts.wbraid),
       gad_source         = COALESCE(EXCLUDED.gad_source, contacts.gad_source),
       utm_source         = COALESCE(EXCLUDED.utm_source, contacts.utm_source),
       utm_medium         = COALESCE(EXCLUDED.utm_medium, contacts.utm_medium),
       utm_campaign       = COALESCE(EXCLUDED.utm_campaign, contacts.utm_campaign),
       utm_content        = COALESCE(EXCLUDED.utm_content, contacts.utm_content),
       utm_term           = COALESCE(EXCLUDED.utm_term, contacts.utm_term),
       marketing_consent  = COALESCE(EXCLUDED.marketing_consent, contacts.marketing_consent),
       custom_fields      = EXCLUDED.custom_fields,
       updated_at         = now()`,
    [
      locationId, contact.contactId,
      p.gclid, p.gbraid, p.wbraid, p.gad_source,
      p.utm_source, p.utm_medium, p.utm_campaign, p.utm_content, p.utm_term,
      p.marketing_consent, contact.customFields
    ]
  );
}

// Keep the enquiry that is about to be overwritten.
//
// The lead-source automation in GHL OVERWRITES master_initial_enquiry on each
// new enquiry, so without this the earlier text is gone the moment a second
// one lands — and that history is exactly what tells a rep the scope changed.
//
// Runs BEFORE the upsert, because it needs the row as it is NOW. Reads and
// writes inside the caller's transaction, so an append and the overwrite that
// follows it cannot land apart.
//
// Returns the new all_initial_enquiry array, or undefined to leave the column
// untouched — which is the common case, since most opportunity events do not
// carry this field at all.
async function enquiryHistoryFor(client, locationId, opportunityId, incoming) {
  // `undefined` means GHL did not send the field. Not a change, nothing to do.
  if (incoming === undefined) return undefined;

  const { rows } = await client.query(
    `SELECT master_initial_enquiry AS prev, all_initial_enquiry AS hist
       FROM opportunities
      WHERE location_id = $1 AND opportunity_id = $2`,
    [locationId, opportunityId]
  );
  // A deal we have not seen before: nothing to preserve.
  if (!rows.length) return undefined;

  const prev = rows[0].prev;
  const next = incoming;

  // Unchanged — including the case where both are empty. Appending here would
  // add a duplicate entry on every opportunity event the deal receives.
  if ((prev || '') === (next || '')) return undefined;
  // Nothing worth keeping: the deal had no enquiry before this one.
  if (!prev || !String(prev).trim()) return undefined;

  const hist = Array.isArray(rows[0].hist) ? rows[0].hist : [];
  // Already recorded. A re-sync can replay the same change, and the history
  // should not grow each time it does.
  if (hist.some((e) => e && e.text === prev)) return undefined;

  // seen_at is when WE saw it change, not when the customer wrote it — GHL
  // does not tell us the latter, and a date someone could act on must not be
  // invented.
  return [...hist, { text: prev, seen_at: new Date().toISOString() }];
}

async function upsertOpportunity(client, locationId, opp, { markDeleted = false, detectedVia = null, ingestEventId = null } = {}) {
  const p = opp.promoted;

  // Read the enquiry about to be overwritten, BEFORE the upsert replaces it.
  // undefined = leave all_initial_enquiry exactly as it is.
  const enquiryHistory = await enquiryHistoryFor(
    client, locationId, opp.opportunityId, p.master_initial_enquiry
  );

  // Stage 2 · field-history detection — MUST run BEFORE the UPSERT so we
  // can compare the incoming payload against the current DB values. If
  // they differ on any of the 27 tracked fields, a new opportunity_field_history
  // row is written per changed field. Best-effort; failures never block the
  // main UPSERT.
  // The opp-level fields keep `?? null` at their source because the UPSERT
  // below needs a value to bind. But for CHANGE DETECTION a null that only
  // means "this event didn't carry it" must not count as a change — that is
  // what put monetary_value at the top of the audit's duplicate table (15,110
  // rows across 837 deals).
  //
  // A bare webhook has no opportunity payload, so treat a null from one as
  // "not sent". When the enriched REST response IS present, a null is real and
  // is recorded.
  // `opp` is what pickOpportunity already built from the event — the raw
  // payload is on opp.rawOpportunity. This referenced a bare `event`, which is
  // NOT a parameter of this function: every opportunity webhook threw
  // "event is not defined" and was recorded as failed.
  const oppPayload = opp.rawOpportunity || {};
  const sentOpp = (key, value) =>
    (Object.prototype.hasOwnProperty.call(oppPayload, key) || value != null)
      ? value
      : undefined;

  const incoming = {
    status: sentOpp('status', opp.status),
    monetary_value: sentOpp('monetaryValue', opp.monetaryValue),
    assigned_to: sentOpp('assignedTo', opp.assignedTo),
    lost_reason: sentOpp('lostReason', opp.lostReason),
    why_want: p.why_want,
    why_buy: p.why_buy,
    why_blocker: p.why_blocker,
    forecast_close_date: p.forecast_close_date,
    forecast_probability: p.forecast_probability,
    pipeline_id: sentOpp('pipelineId', opp.pipelineId),
    product_system: p.product_system,
    product_type: p.product_type,
    client_type: p.client_type,
    meddic_1: p.meddic_1, meddic_2: p.meddic_2, meddic_3: p.meddic_3,
    meddic_4: p.meddic_4, meddic_5: p.meddic_5, meddic_6: p.meddic_6,
    meddic_7: p.meddic_7, meddic_8: p.meddic_8, meddic_9: p.meddic_9, meddic_10: p.meddic_10,
    meddic_11: p.meddic_11,
    first_contact_method: p.first_contact_method,
    lead_source_opportunity: p.lead_source_opportunity,
    opportunity_source: sentOpp('source', opp.opportunitySource),
    postcode: p.postcode
  };
  recordFieldChanges({
    locationId,
    opportunityId: opp.opportunityId,
    incoming,
    detectedVia: detectedVia || 'opportunity_upsert',
    ingestEventId
  }).catch(() => {}); // Non-fatal — already logs internally.

  // Lifecycle timestamps: only stamp when status matches AND the column is
  // still NULL. That way an OpportunityUpdate that reasserts won status
  // doesn't overwrite the original won_at with a later time.
  const nowIso = new Date();
  const wonAtNew       = opp.status === 'won'       ? nowIso : null;
  const lostAtNew      = opp.status === 'lost'      ? nowIso : null;
  const abandonedAtNew = opp.status === 'abandoned' ? nowIso : null;
  const deletedAtNew   = markDeleted                ? nowIso : null;

  // NOTE: first_stage_id / first_stage_name are inserted only — they live in
  // the INSERT column list but are DELIBERATELY ABSENT from the ON CONFLICT
  // DO UPDATE SET clause. That preserves the original "where did this opp
  // start?" snapshot across every subsequent stage transition.
  await client.query(
    `INSERT INTO opportunities (location_id, opportunity_id, contact_id, name,
        pipeline_id, pipeline_name, current_stage_id, current_stage_name,
        first_stage_id, first_stage_name, status,
        monetary_value, currency, assigned_to, assigned_to_name,
        meddic_1, meddic_2, meddic_3, meddic_4, meddic_5,
        meddic_6, meddic_7, meddic_8, meddic_9, meddic_10, meddic_11,
        client_type, product_system, product_type, postcode,
        first_contact_method, lead_source_opportunity, inquiry,
        gclid, opportunity_source, lost_reason,
        why_want, why_buy, why_blocker,
        forecast_close_date, forecast_probability, upload_from_enquiry,
        custom_fields, raw_opportunity,
        is_deleted, deleted_at,
        won_at, lost_at, abandoned_at,
        created_at_ghl, updated_at_ghl,
        -- LAST in the list, so $52/$53 line up without renumbering the 51
        -- placeholders above. Position here is arbitrary to Postgres; the
        -- ORDER of columns and params is all that has to agree.
        master_initial_enquiry, all_initial_enquiry,
        imported_at, updated_at)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,
             $12,$13,$14,$15,
             $16,$17,$18,$19,$20,$21,$22,$23,$24,$25,
             $26,$27,$28,$29,$30,$31,$32,
             $33,$34,$35,
             $36,$37,$38,
             $39,$40,$41,
             $42,$43,
             $44,$45,
             $46,$47,$48,
             $49,$50,
             $51,
             $52, $53,
             now(), now())
     ON CONFLICT (location_id, opportunity_id) DO UPDATE SET
       contact_id              = EXCLUDED.contact_id,
       name                    = EXCLUDED.name,
       pipeline_id             = EXCLUDED.pipeline_id,
       pipeline_name           = COALESCE(EXCLUDED.pipeline_name, opportunities.pipeline_name),
       current_stage_id        = EXCLUDED.current_stage_id,
       current_stage_name      = COALESCE(EXCLUDED.current_stage_name, opportunities.current_stage_name),
       -- first_stage_id and first_stage_name are intentionally NOT set here
       -- (write once on first INSERT, never updated).
       status                  = EXCLUDED.status,
       monetary_value          = COALESCE(EXCLUDED.monetary_value, opportunities.monetary_value),
       currency                = COALESCE(EXCLUDED.currency, opportunities.currency),
       assigned_to             = EXCLUDED.assigned_to,
       assigned_to_name        = COALESCE(EXCLUDED.assigned_to_name, opportunities.assigned_to_name),
       meddic_1                = COALESCE(EXCLUDED.meddic_1, opportunities.meddic_1),
       meddic_2                = COALESCE(EXCLUDED.meddic_2, opportunities.meddic_2),
       meddic_3                = COALESCE(EXCLUDED.meddic_3, opportunities.meddic_3),
       meddic_4                = COALESCE(EXCLUDED.meddic_4, opportunities.meddic_4),
       meddic_5                = COALESCE(EXCLUDED.meddic_5, opportunities.meddic_5),
       meddic_6                = COALESCE(EXCLUDED.meddic_6, opportunities.meddic_6),
       meddic_7                = COALESCE(EXCLUDED.meddic_7, opportunities.meddic_7),
       meddic_8                = COALESCE(EXCLUDED.meddic_8, opportunities.meddic_8),
       meddic_9                = COALESCE(EXCLUDED.meddic_9, opportunities.meddic_9),
       meddic_10               = COALESCE(EXCLUDED.meddic_10, opportunities.meddic_10),
       meddic_11               = COALESCE(EXCLUDED.meddic_11, opportunities.meddic_11),
       client_type             = COALESCE(EXCLUDED.client_type, opportunities.client_type),
       product_system          = COALESCE(EXCLUDED.product_system, opportunities.product_system),
       product_type            = COALESCE(EXCLUDED.product_type, opportunities.product_type),
       postcode                = COALESCE(EXCLUDED.postcode, opportunities.postcode),
       first_contact_method    = COALESCE(EXCLUDED.first_contact_method, opportunities.first_contact_method),
       lead_source_opportunity = COALESCE(EXCLUDED.lead_source_opportunity, opportunities.lead_source_opportunity),
       inquiry                 = COALESCE(EXCLUDED.inquiry, opportunities.inquiry),
       gclid                   = COALESCE(EXCLUDED.gclid, opportunities.gclid),
       opportunity_source      = COALESCE(EXCLUDED.opportunity_source, opportunities.opportunity_source),
       lost_reason             = COALESCE(EXCLUDED.lost_reason, opportunities.lost_reason),
       why_want                = COALESCE(EXCLUDED.why_want, opportunities.why_want),
       why_buy                 = COALESCE(EXCLUDED.why_buy, opportunities.why_buy),
       why_blocker             = COALESCE(EXCLUDED.why_blocker, opportunities.why_blocker),
       forecast_close_date     = COALESCE(EXCLUDED.forecast_close_date, opportunities.forecast_close_date),
       forecast_probability    = COALESCE(EXCLUDED.forecast_probability, opportunities.forecast_probability),
       upload_from_enquiry     = COALESCE(EXCLUDED.upload_from_enquiry, opportunities.upload_from_enquiry),
       -- COALESCE, so an event that did not carry the field leaves the
       -- enquiry alone rather than nulling it.
       master_initial_enquiry  = COALESCE(EXCLUDED.master_initial_enquiry, opportunities.master_initial_enquiry),
       -- The history is only ever replaced by a value enquiryHistoryFor()
       -- computed from the CURRENT row, so a NULL means "no append this turn"
       -- and must keep what is already stored.
       --
       -- $53 directly rather than EXCLUDED. The two carry the same value now
       -- that the column is nullable (migration 137) and the INSERT binds the
       -- parameter unchanged — but naming the parameter keeps this clause
       -- correct if the column list is ever made to wrap it again. An EXCLUDED
       -- that had been COALESCEd to '[]' would never be NULL, and this
       -- COALESCE would then ERASE the stored history on every update instead
       -- of keeping it.
       all_initial_enquiry     = COALESCE($53, opportunities.all_initial_enquiry),
       custom_fields           = EXCLUDED.custom_fields,
       raw_opportunity         = COALESCE(EXCLUDED.raw_opportunity, opportunities.raw_opportunity),
       is_deleted              = EXCLUDED.is_deleted,
       -- Lifecycle timestamps: write-once (COALESCE(existing, new)) so the
       -- first observation of won/lost/abandoned wins. Later status
       -- reassertions don't overwrite the original moment.
       deleted_at              = COALESCE(opportunities.deleted_at, EXCLUDED.deleted_at),
       won_at                  = COALESCE(opportunities.won_at,       EXCLUDED.won_at),
       lost_at                 = COALESCE(opportunities.lost_at,      EXCLUDED.lost_at),
       abandoned_at            = COALESCE(opportunities.abandoned_at, EXCLUDED.abandoned_at),
       updated_at_ghl          = COALESCE(EXCLUDED.updated_at_ghl, opportunities.updated_at_ghl),
       updated_at              = now()`,
    [
      locationId, opp.opportunityId, opp.contactId, opp.name,
      opp.pipelineId, opp.pipelineName, opp.currentStageId, opp.currentStageName,
      opp.currentStageId, opp.currentStageName,                 // first_stage_id, first_stage_name (set once)
      opp.status,
      opp.monetaryValue, opp.currency, opp.assignedTo, opp.assignedToName,
      p.meddic_1, p.meddic_2, p.meddic_3, p.meddic_4, p.meddic_5,
      p.meddic_6, p.meddic_7, p.meddic_8, p.meddic_9, p.meddic_10,
      p.meddic_11,
      // jsonbParam on the four JSONB columns only. node-postgres turns a JS
      // array into a Postgres array literal ({"a","b"}) which JSONB rejects
      // with 22P02 — see the note on jsonbParam. postcode, inquiry and
      // lead_source_opportunity are TEXT and must NOT be wrapped.
      jsonbParam(p.client_type), jsonbParam(p.product_system),
      jsonbParam(p.product_type), p.postcode,
      jsonbParam(p.first_contact_method), p.lead_source_opportunity, p.inquiry,
      opp.gclid, opp.opportunitySource, opp.lostReason,
      p.why_want, p.why_buy, p.why_blocker,
      p.forecast_close_date, p.forecast_probability, p.upload_from_enquiry,
      // Both JSONB. Objects serialize correctly on their own, but binding them
      // through the same helper keeps every JSONB param in this statement
      // uniform — the raw-binding inconsistency is what hid the 22P02 above.
      jsonbParam(opp.customFields), jsonbParam(opp.rawOpportunity),
      markDeleted, deletedAtNew,
      wonAtNew, lostAtNew, abandonedAtNew,
      opp.createdAtGhl, opp.updatedAtGhl,
      // $52/$53 — LAST, matching the column list's own note. These two sat
      // here in the column list but were supplied in the MIDDLE of this array,
      // right after upload_from_enquiry, so every parameter from $43 on landed
      // one column to the left of where it belonged: custom_fields went to
      // is_deleted (a boolean), which failed with
      //   22P02 invalid input syntax for type boolean: "{"product_system":[…]}"
      // and the whole webhook transaction rolled back.
      //
      // It stayed hidden while these values were NULL — null binds to any type
      // — so it only surfaced once a deal actually carried custom fields.
      p.master_initial_enquiry,
      // jsonbParam: this is a JS array and the column is JSONB — binding it
      // raw gives Postgres an array literal it rejects with 22P02, which is
      // the same trap the four columns above carry a note about.
      //
      // NULL means "no append this turn", and the column is NULLABLE
      // (migration 137) precisely so that signal can reach the SQL: the
      // ON CONFLICT clause reads it as "keep what is stored".
      //
      // Binding '[]' here instead would be indistinguishable from a real empty
      // history and would WIPE the stored one on every update, since COALESCE
      // only skips NULL. 136 created the column NOT NULL DEFAULT '[]', which
      // looked like a safety net but is not one: a DEFAULT applies only when a
      // column is OMITTED, and this statement always names it — so every new
      // deal failed with 23502 until 137 dropped the constraint.
      enquiryHistory === undefined ? null : jsonbParam(enquiryHistory)
    ]
  );
}

// ---------------------------------------------------------- stage_history

async function findOpenStageRow(client, locationId, opportunityId) {
  const { rows } = await client.query(
    `SELECT id, stage_id, entered_at
       FROM stage_history
      WHERE location_id=$1 AND opportunity_id=$2 AND current_stage=true
      LIMIT 1`,
    [locationId, opportunityId]
  );
  return rows[0] || null;
}

// closeReason classifier — turns a close event into a categorical label
// stored in stage_history.closed_reason. Priority:
//   markDeleted flag → 'deleted'
//   opp status is won/lost/abandoned → matches status (terminal close)
//   otherwise → 'stage_transition' (moved to next stage)
function closeReason({ markDeleted, oppStatus }) {
  if (markDeleted) return 'deleted';
  if (oppStatus === 'won' || oppStatus === 'lost' || oppStatus === 'abandoned') return oppStatus;
  return 'stage_transition';
}

async function closeStageRow(client, id, leftAt, { markDeleted = false, oppStatus = null } = {}) {
  const reason = closeReason({ markDeleted, oppStatus });
  const { rows } = await client.query(
    `UPDATE stage_history
        SET left_at = $2,
            current_stage = false,
            in_stage_duration_seconds = GREATEST(0, EXTRACT(EPOCH FROM ($2 - entered_at))::INTEGER),
            deleted = $3,
            closed_reason = COALESCE(closed_reason, $4)
      WHERE id = $1
      RETURNING id`,
    [id, leftAt, markDeleted, reason]
  );
  return rows[0]?.id || null;
}

async function openStageRow(client, locationId, opp, enteredAt, triggeredBy, ingestEventId = null) {
  // Snapshot columns are point-in-time: whatever the opportunity looked like
  // AT the moment of stage entry. Later edits to the opp don't rewrite these.
  // client_type snapshot mirrors the JSONB array shape from opportunities.
  const p = opp.promoted;
  const { rows } = await client.query(
    `INSERT INTO stage_history (location_id, opportunity_id, contact_id,
        stage_id, stage_name, pipeline_id, pipeline_name,
        entered_at, current_stage,
        product_system, product_type, custom_fields_snapshot,
        assigned_to, assigned_to_name,
        monetary_value_snapshot, currency,
        status_snapshot, lead_source_snapshot, client_type_snapshot,
        triggered_by, ingest_event_id)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8, true,
             $9,$10,$11,
             $12,$13,
             $14,$15,
             $16,$17,$18,
             $19,$20)
     RETURNING id`,
    [
      locationId, opp.opportunityId, opp.contactId,
      opp.currentStageId, opp.currentStageName, opp.pipelineId, opp.pipelineName,
      enteredAt,
      // product_system, product_type and client_type_snapshot are all JSONB
      // (migration 028) and asCheckboxArray hands us arrays — bind through
      // jsonbParam or Postgres gets an array literal and rejects it.
      // lead_source_snapshot is TEXT.
      jsonbParam(p.product_system), jsonbParam(p.product_type), jsonbParam(opp.customFields),
      opp.assignedTo, opp.assignedToName,
      opp.monetaryValue, opp.currency,
      opp.status, p.lead_source_opportunity, jsonbParam(p.client_type),
      triggeredBy || null, ingestEventId
    ]
  );
  return rows[0].id;
}

// ----------------------------------------------------------------- messages

// The stage window starts a little BEFORE the stage row was opened.
//
// A form submission creates the conversation entry first and the deal a
// moment later: on one real case the "Form submitted" row was stamped
// 12:12:27.1 and the deal's first stage opened at 12:12:29.8. A window that
// starts exactly at entered_at excludes it by 2.7 seconds — on every later
// transition too, since each window starts at its own stage. Fifteen
// minutes covers automation that runs ahead of the deal, and costs nothing:
// persistMessages is INSERT … DO NOTHING, so a message already stored under
// an earlier stage keeps that attribution.
const LEAD_IN_MS = 15 * 60 * 1000;
const leadIn = (enteredAt) => new Date(new Date(enteredAt).getTime() - LEAD_IN_MS);

async function persistMessages(client, locationId, opp, stageHistoryId, messages) {
  if (!messages.length) return;
  for (const m of messages) {
    const cleaned = cleanMessageBody(m.body, m.channel);
    await client.query(
      `INSERT INTO messages (location_id, contact_id, opportunity_id, stage_history_id,
          message_id, conversation_id, message_timestamp,
          message_body, message_body_raw, message_direction, message_channel,
          message_status, is_call)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
       ON CONFLICT (location_id, message_id) WHERE message_id IS NOT NULL DO NOTHING`,
      [
        locationId, opp.contactId, opp.opportunityId, stageHistoryId,
        m.messageId, m.conversationId, m.timestamp,
        cleaned, m.body, m.direction, m.channel,
        m.status, m.isCall
      ]
    );
  }
}

// ---------------------------------------------------- enrichment

// Webhooks carry IDs + bare stage transition. Everything else (custom fields,
// monetary value, stage names, user names) requires hitting GHL's REST API.
// This function does that BEFORE the DB transaction so we don't hold a Postgres
// connection open while waiting on external network calls.
//
// Returns a NEW event object with:
//   event.opportunity = full GHL opportunity (with customFieldsResolved + assignedToName)
//   event.contact     = full GHL contact     (with customFieldsResolved)
// Sparse data in the original webhook is preserved alongside.
//
// Never throws — if a fetch fails the writer falls back to whatever the
// webhook payload had. A sparse row is better than no row.
async function enrichEvent(install, event, eventType) {
  const opportunityId = event.opportunity?.id || event.opportunityId || event.id;
  const contactId = event.opportunity?.contactId || event.contactId;
  const isDeleted = ['OpportunityDelete', 'opportunity.deleted', 'opportunity_deleted'].includes(eventType);

  // For deleted opps the GET /opportunities/{id} returns 404. Skip opp fetch
  // and accept the sparse webhook data (we still want to close out the stage
  // row + mark is_deleted).
  // cfMap joins this Promise.all rather than being awaited separately: it is
  // cached per location, so after the first event it costs nothing, and putting
  // it here means it never adds latency to the webhook path.
  //
  // Caught, not propagated. The map only IMPROVES a raw-array fallback; if
  // fetching the definitions fails we still want the rest of the event
  // written, so a failure degrades to {} rather than dropping the webhook.
  const [oppFull, contactFull, pipelineLookup, cfMap] = await Promise.all([
    isDeleted ? Promise.resolve(null) : getOpportunityFull(install, opportunityId),
    contactId ? getContactFull(install, contactId) : Promise.resolve(null),
    getPipelineLookup(install),
    getCustomFieldNameMaps(install).catch((err) => {
      logger.warn({ err, locationId: install.location_id },
        'stageHistoryWriter: custom-field map unavailable — a raw customFields array will resolve by id');
      return { contactCfMap: {}, opportunityCfMap: {} };
    })
  ]);

  // Resolve user name from assigned_to (if either source provides it).
  const assignedTo = oppFull?.assignedTo || event.assignedTo || null;
  const assignedToName = assignedTo ? await getUserName(install, assignedTo) : null;

  // Merge stage + pipeline name from the lookup. Stage id always comes from
  // the most authoritative source: enriched opp > webhook.
  const stageId = oppFull?.pipelineStageId || event.pipelineStageId || null;
  const stageMeta = stageId ? pipelineLookup.stageById[stageId] : null;

  const enrichedOpp = oppFull
    ? {
        ...oppFull,
        assignedToName: assignedToName || oppFull.assignedToName || null,
        pipelineName: oppFull.pipelineName || stageMeta?.pipelineName || null,
        stageName: oppFull.stageName || oppFull.pipelineStageName || stageMeta?.stageName || null
      }
    : null;

  return {
    ...event,
    opportunity: enrichedOpp || event.opportunity,
    contact: contactFull || event.contact,
    // The location's custom-field id→key maps, so the pick* functions can
    // resolve a RAW customFields array when enrichment fell back to the bare
    // webhook. Cached per location by getCustomFieldNameMaps, so this is a
    // map lookup after the first event.
    _cfMap: cfMap,
    // Bubble up so pickOpportunity finds them even without full enrichment.
    assignedToName,
    pipelineName: enrichedOpp?.pipelineName || stageMeta?.pipelineName || event.pipelineName,
    pipelineStageName: enrichedOpp?.stageName || stageMeta?.stageName || event.pipelineStageName
  };
}

// ---------------------------------------------------- top-level dispatcher

export async function handleOpportunityEvent(install, eventType, event) {
  const locationId = install.location_id;
  const now = eventTimestamp(event);

  const isCreated = ['OpportunityCreate','opportunity.created','opportunity_created'].includes(eventType);
  const isStageUpdate = ['OpportunityStageUpdate','opportunity.stage_updated','opportunity_stage_updated'].includes(eventType);
  const isDeleted = ['OpportunityDelete','opportunity.deleted','opportunity_deleted'].includes(eventType);
  // Metadata-only events — status flips, monetary value changes, assignment
  // changes, generic updates. These should refresh the opportunities row
  // with the latest enrichment, but NOT create a new stage_history row
  // (the opp hasn't moved between stages).
  const isMetaUpdate = [
    'OpportunityUpdate','opportunity.updated','opportunity_updated',
    'OpportunityStatusUpdate','opportunity.status_updated','opportunity_status_updated',
    'OpportunityAssignedToUpdate','opportunity.assigned_to_updated','opportunity_assigned_to_updated',
    'OpportunityMonetaryValueUpdate','opportunity.monetary_value_updated','opportunity_monetary_value_updated'
  ].includes(eventType);

  if (!isCreated && !isStageUpdate && !isDeleted && !isMetaUpdate) {
    logger.debug({ eventType }, 'stageHistoryWriter: ignoring unrelated event');
    return;
  }

  // Enrich BEFORE the DB transaction so we don't tie up a pg connection
  // during external network calls. Sparse webhook data is preserved as
  // a fallback inside enrichEvent.
  const enriched = await enrichEvent(install, event, eventType);
  const contact = pickContact(enriched);
  const opp = pickOpportunity(enriched);

  if (!opp.opportunityId) {
    logger.warn({ event }, 'stageHistoryWriter: event missing opportunityId — dropping');
    return;
  }
  if (!contact.contactId) contact.contactId = opp.contactId;
  if (!contact.contactId) {
    logger.warn({ event }, 'stageHistoryWriter: event missing contactId — dropping');
    return;
  }

  logger.info(
    {
      locationId,
      eventType,
      opportunityId: opp.opportunityId,
      contactId: contact.contactId,
      enrichedOpp: !!enriched.opportunity && enriched.opportunity !== event.opportunity,
      enrichedContact: !!enriched.contact && enriched.contact !== event.contact,
      stageName: opp.currentStageName,
      monetaryValue: opp.monetaryValue,
      assignedToName: opp.assignedToName
    },
    'stageHistoryWriter: enrichment done — entering transaction'
  );

  // Thread the raw-event ID (GHL's per-delivery webhook ID) into openStageRow
  // as `ingest_event_id` — creates a direct link from every stage row back to
  // the ghl_raw archive row that produced it. Debugging becomes a single JOIN.
  const ingestEventId = event.webhookId || event.eventId || null;

  await withTenant(locationId, async (client) => {
    // Serialise per-opportunity to prevent the "two current_stage=true" race
    // (QA finding C2). pg_advisory_xact_lock takes a bigint — we hash the
    // (locationId + opportunityId) tuple. Lock scope is transaction-only;
    // released automatically on COMMIT/ROLLBACK. Other opportunities run in
    // parallel — this only serialises writers touching the SAME opp.
    await client.query(
      `SELECT pg_advisory_xact_lock(hashtextextended($1, 0))`,
      [`${locationId}:${opp.opportunityId}`]
    );

    await upsertContact(client, locationId, contact);
    await upsertOpportunity(client, locationId, opp, {
      markDeleted: isDeleted,
      detectedVia: eventType,
      ingestEventId
    });

    if (isDeleted) {
      const open = await findOpenStageRow(client, locationId, opp.opportunityId);
      if (open) await closeStageRow(client, open.id, now, { markDeleted: true, oppStatus: opp.status });
      return;
    }

    // Metadata-only events: opportunity status / monetary_value / assignedTo
    // / generic update. The opportunities row has already been refreshed via
    // upsertOpportunity above (with the latest enrichment). We DO NOT write
    // a new stage_history row because the opp didn't move between stages.
    //
    // We also skip the message refresh — these events fire on every minor
    // change (e.g. monetary_value tick) and would otherwise spam the export
    // endpoint with redundant fetches. Messages will refresh naturally on
    // the next stage transition.
    if (isMetaUpdate) {
      logger.debug(
        { eventType, opportunityId: opp.opportunityId, status: opp.status, monetaryValue: opp.monetaryValue },
        'stageHistoryWriter: metadata-only update — opportunities row refreshed, no stage_history change'
      );
      return;
    }

    // Created / Stage-Updated — there may or may not be a prior open row.
    const open = await findOpenStageRow(client, locationId, opp.opportunityId);
    const stageChanged = !open || open.stage_id !== opp.currentStageId;

    if (open && stageChanged) {
      // STAGE TRANSITION. Before closing the prior row, capture all messages
      // that occurred while the opp was in that stage. Window = [entered_at, now].
      // These messages belong to the OLD stage (the one that's about to close).
      //
      // This is the part of the plan that produces "one row per (message ×
      // stage)" — messages get linked to whichever stage_history row they
      // fell inside, via stage_history_id.
      const closingMessages = await fetchContactMessagesViaExport(
        install, contact.contactId, leadIn(open.entered_at), now
      );
      await persistMessages(client, locationId, opp, open.id, closingMessages);
      await closeStageRow(client, open.id, now, { oppStatus: opp.status });
    }

    let stageHistoryId;
    if (stageChanged) {
      // Open the new stage row. No message fetch needed — the window is
      // [now, now], empty by definition. The NEXT event (whether a same-
      // stage refresh or the next transition) will fill in messages for
      // this stage.
      stageHistoryId = await openStageRow(
        client, locationId, opp, now,
        isCreated ? 'opportunity_created' : 'opportunity_stage_updated',
        ingestEventId
      );
    } else {
      // Same stage — same row. Refresh messages in case new ones arrived
      // between events. Dedup via UNIQUE INDEX on (location_id, message_id)
      // prevents double-insert.
      stageHistoryId = open.id;
      const refreshed = await fetchContactMessagesViaExport(
        install, contact.contactId, leadIn(open.entered_at), now
      );
      await persistMessages(client, locationId, opp, stageHistoryId, refreshed);
    }
  });

  // AFTER the tenant transaction commits: refresh task↔opportunity and
  // note↔opportunity associations. This is the safety net that catches
  // links created via GHL UI between webhook events — we skip subscribing
  // to RelationCreate/RelationDelete because every opp event gives us a
  // natural moment to reconcile. Never blocks or throws; failures logged.
  if (!isDeleted) {
    // The PRIMARY contact belongs in opportunity_contacts too.
    //
    // That table is otherwise written only by RelationCreate webhooks, and
    // GHL does not send one for the primary — it arrives here, on the
    // opportunity payload, as `contactId`. Nothing copied it across, so 26%
    // of deals (237 of 917, measured) had no row for their own main contact.
    //
    // It matters because attributionEngine.contactOppIds uses this table
    // first and falls back to opportunities.contact_id only when a contact
    // has NO rows at all. A contact that gains one row as a follower on any
    // other deal loses the fallback — and with it, visibility of its own
    // primary deals.
    //
    // Best-effort: a failure here must not fail the opportunity write, which
    // has already committed.
    if (opp.contactId) {
      try {
        await rawQuery(
          `INSERT INTO opportunity_contacts
             (location_id, relation_id, opportunity_id, contact_id, is_primary,
              pipeline_id, association_id, last_seen_via, raw_relation)
           VALUES ($1, 'primary:' || $2 || ':' || $3, $2, $3, true,
                   $4, 'OPPORTUNITIES_CONTACTS_ASSOCIATION', 'webhook', NULL)
           ON CONFLICT (location_id, relation_id) DO UPDATE
             SET last_synced_at = now(), is_primary = true`,
          [install.location_id, opp.opportunityId, opp.contactId, opp.pipelineId || null]
        );

        // EXACTLY ONE PRIMARY PER DEAL.
        //
        // The insert above marks the new primary but used to leave the old
        // one flagged, so a deal whose primary had changed showed TWO people
        // badged PRIMARY — the route ORs is_primary with a match on
        // opportunities.contact_id, and the two disagreed.
        //
        // Demoting every other row here keeps the flag meaning what it says.
        // Scoped to this deal, and never touches the row just written.
        await rawQuery(
          `UPDATE opportunity_contacts
              SET is_primary = false
            WHERE location_id = $1
              AND opportunity_id = $2
              AND contact_id <> $3
              AND is_primary IS DISTINCT FROM false`,
          [install.location_id, opp.opportunityId, opp.contactId]
        );
      } catch (err) {
        logger.warn(
          { err, locationId: install.location_id, opportunityId: opp.opportunityId },
          'stageHistoryWriter: could not record the primary contact link'
        );
      }
    }

    await refreshAssociationsForOpportunity(install, opp.opportunityId);

    // A DEAL'S TAGS COME FROM ITS CONTACTS, NOT FROM THE EVENT.
    //
    // This used to call reconcileTags with entityType 'opportunity' and
    // opp.tags, on the belief that "every opp event that carries the full
    // opp payload includes the tags array". GHL sends no such field —
    // migration 048: "no tags[] field on the opportunity object, no webhook
    // for opportunity tags". So opp.tags was ALWAYS [], and the call was a
    // no-op against an empty set.
    //
    // It stopped being harmless the moment migration 134 put real rows
    // there. reconcileTags closes every open row for the entity that is not
    // in currentTags, and it does not scope that by detected_via — so an
    // empty array would have closed every tag the fanout had opened, on the
    // next opportunity event each deal received. The filter would work until
    // a deal was touched, then silently empty.
    //
    // The primary contact can also CHANGE on an opportunity update, which
    // changes the deal's tag set. Recomputing the union covers both.
    try {
      await fanoutToDeal(locationId, opp.opportunityId);
    } catch (err) {
      logger.warn({ err, locationId, opportunityId: opp.opportunityId }, 'stageHistoryWriter: tag fanout failed (non-fatal)');
    }
  }
}

// Used by the orphan-sweep cron: synthesize a "still pending" stage row for
// opportunities that have been sitting since creation. We can't fetch
// messages for them (there's no stage window yet — they've not moved at
// all), so this is a stage_history insert only.
export async function emitOrphanRow(install, pendingRow) {
  const locationId = install.location_id;

  // Resolve the real stage + pipeline names from the cached pipeline lookup so
  // swept orphans don't all show up as "Unknown". The lookup is cached per
  // location (1h TTL) so this is essentially free across a sweep batch.
  // Fetched OUTSIDE the transaction — it's a network call, and we don't want
  // to hold a pg connection open while waiting on GHL.
  let stageName = null;
  let pipelineName = null;
  if (pendingRow.pipeline_stage_id) {
    try {
      const lookup = await getPipelineLookup(install);
      const meta = lookup.stageById[pendingRow.pipeline_stage_id];
      if (meta) {
        stageName = meta.stageName || null;
        pipelineName = meta.pipelineName || null;
      }
    } catch (_) { /* fall back to 'Unknown' below */ }
  }

  await withTenant(locationId, async (client) => {
    const { rows: existing } = await client.query(
      `SELECT id FROM stage_history
        WHERE location_id=$1 AND opportunity_id=$2 AND current_stage=true LIMIT 1`,
      [locationId, pendingRow.opportunity_id]
    );
    if (existing.length) return; // already tracked

    // ghost_opportunity = true: this row was synthesized by the sweep, not
    // observed via a real stage webhook. Lets analytics exclude synthetic
    // rows when measuring true stage transitions. Snapshot columns stay
    // NULL — we don't have the opp state at the "sighting" moment.
    await client.query(
      `INSERT INTO stage_history (location_id, opportunity_id, contact_id,
          stage_id, stage_name, pipeline_id, pipeline_name,
          entered_at, current_stage, ghost_opportunity, triggered_by, currency)
       VALUES ($1, $2, $3, $4, COALESCE($5,'Unknown'), $6, $7,
               $8, true, true, 'daily_sweep', 'GBP')`,
      [
        locationId, pendingRow.opportunity_id, pendingRow.contact_id,
        pendingRow.pipeline_stage_id, stageName, pendingRow.pipeline_id, pipelineName,
        pendingRow.created_at_ghl
      ]
    );
  });
  await rawQuery(
    `DELETE FROM pending_opportunities WHERE location_id=$1 AND opportunity_id=$2`,
    [install.location_id, pendingRow.opportunity_id]
  );
  logger.info(
    { locationId: install.location_id, opportunityId: pendingRow.opportunity_id },
    'stageHistoryWriter: orphan stage row emitted'
  );
}
