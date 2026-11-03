import crypto from 'node:crypto';
import { withTenant } from '../../db.js';
import { logger } from '../../utils/logger.js';
import { fieldsWithValues } from '../opportunityFields.js';
import { applyThreadBudget, THREAD_TOKEN_BUDGET } from './threadBudget.js';
import { getBusinessContext } from './businessContext.js';

// The shared context builder — spec §1. Every call is built from this.
//
// Sections A–E are model input. F (the coverage stamp) is computed here and
// rendered by the UI, never asked of the model: a stamp the model could write
// is a stamp it could hallucinate.
//
// Message selection is the substance. Only messages that are BOTH filed to
// this deal (message_opportunity_map.mapping_status mapped/manually_resolved,
// not superseded) AND readable go to the model. Untranscribed calls are
// excluded from the payload but NAMED in unread_reasons — spec rule 6, and
// the reason a rep trusts the output: they can see what wasn't read.

// Bump when the prompt or the shape of the assembled context changes, so
// cached runs from an older builder don't get served.
// 3: "not in this thread" answers now redirect instead of dead-ending — they
//    name what the thread does cover, or point at Insights AI when the question
//    was really about the wider account. Cached v2 answers still carry the old
//    flat "that information isn't present here", so they must not be served.
// 4: the redirect stops at the name. v3 tacked on "which searches every deal",
//    explaining a tab the rep is already looking at.
// 5: the answer call no longer speaks for the write path. v4 answers can carry
//    "there is nothing in this deal's record that lets me send a message" with
//    the detector's real offer stacked underneath — a refusal above an offer.
// 6: an unnamed channel is asked about, not guessed. v5 fell through to
//    "prefer SMS if a phone number is present" — on a WhatsApp-only deal.
// 7: the contact block states which channels a contact can RECEIVE on. v6
//    listed only "email" and "phone", so the model inferred "SMS or Email" and
//    dropped WhatsApp, which rides the same number.
// 8: messages carry their conversation_provider_id, so a proposed reply can
//    continue the thread's own sender instead of the location default.
// 9: the detector is told which SENDERS a channel has, not just which
//    channel the thread used — so a rep on a deal with no messages is asked
//    which of three SMS senders, instead of silently getting the default.
// 10: the AI asks by SENDER NAME, not by API channel type — "WhatsApp QR or
//     SMS Android?" rather than "SMS, WhatsApp or Email?", which is a
//     question a rep cannot answer when all their senders are type SMS.
// v11 (2026-10-12): sender policy changed — the model now asks which sender
// (native or custom, numbered) instead of picking one; every cached
// "draft a message" answer predates that and would keep answering the old way.
export const CONTEXT_VERSION = 12;

/**
 * Build the full context for one deal.
 * @returns {{ deal, people, messages, notes, config, coverage, cacheKeyParts }}
 */
/**
 * @param {string}   locationId
 * @param {string}   opportunityId
 * @param {object}   [opts]
 * @param {string[]} [opts.channels]  Restrict to these channels for THIS call
 *                                    only (e.g. ['sms']). Transient question
 *                                    scope — distinct from ai_exclusions,
 *                                    which is a standing decision. Empty/absent
 *                                    means every channel.
 */
export async function buildDealContext(locationId, opportunityId, opts = {}) {
  const channelScope = Array.isArray(opts.channels) && opts.channels.length
    ? new Set(opts.channels.map((c) => String(c).toLowerCase()))
    : null;

  const data = await withTenant(locationId, async (client) => {
    // ── A. Deal facts ─────────────────────────────────────────────────
    const dealQ = await client.query(
      `SELECT o.opportunity_id, o.name, o.contact_id,
              o.pipeline_name, o.current_stage_name, o.status,
              o.monetary_value, o.currency,
              o.forecast_close_date, o.lead_source_opportunity,
              -- Forecast facts, resolved. vw_forecast_base applies the same
              -- probability rule the portfolio skills use — reimplementing it
              -- here would let Deal AI and Insights AI quote different odds
              -- for the same deal.
              fb.effective_probability, fb.probability_source,
              fb.weighted_value, fb.stage_win_probability,
              fb.uses_deal_probability, fb.overdue_close_date,
              -- Close-date slip, from the change log. Same reasoning as
              -- days_quiet below: the model COULD be handed raw history rows
              -- and asked to count pushes, but then it is inference rather
              -- than a fact, and it would not match what the portfolio
              -- at-risk skill reports for the same deal.
              (SELECT count(*) FROM opportunity_field_history h
                WHERE h.location_id = o.location_id
                  AND h.opportunity_id = o.opportunity_id
                  AND h.field_key = 'forecast_close_date'
                  AND NULLIF(h.old_value #>> '{}', '')::date IS NOT NULL
                  AND NULLIF(h.new_value #>> '{}', '')::date
                      > NULLIF(h.old_value #>> '{}', '')::date
              ) AS times_pushed,
              (SELECT min(NULLIF(h.old_value #>> '{}', '')::date)
                 FROM opportunity_field_history h
                WHERE h.location_id = o.location_id
                  AND h.opportunity_id = o.opportunity_id
                  AND h.field_key = 'forecast_close_date'
              ) AS original_close_date,
              o.product_system, o.product_type, o.client_type,
              o.created_at_ghl, o.opportunity_source,
              o.assigned_to, o.assigned_to_name,
              u.name AS owner_name,
              (SELECT sh.entered_at FROM stage_history sh
                WHERE sh.location_id = o.location_id
                  AND sh.opportunity_id = o.opportunity_id
                  AND sh.current_stage = true
                ORDER BY sh.entered_at DESC LIMIT 1) AS stage_entered_at,
              -- Same query search_deals's quietDays filter uses (registry.js)
              -- — kept identical on purpose, so "how many days since the
              -- customer last replied" can never disagree between Deal AI
              -- and Insights AI. Fed to the model as a computed fact rather
              -- than left for it to reconstruct from raw message timestamps
              -- (see threadBlock's own comment on quiet_days below).
              (SELECT max(m.message_timestamp)
                 FROM messages m
                 JOIN message_opportunity_map mom
                   ON mom.location_id = m.location_id
                  AND mom.message_id = m.message_id
                  AND mom.superseded_at IS NULL
                WHERE mom.opportunity_id = o.opportunity_id
                  AND m.message_direction = 'inbound'
                  AND m.deleted_at IS NULL) AS last_inbound_at
         FROM opportunities o
         LEFT JOIN vw_forecast_base fb
           ON fb.opportunity_id = o.opportunity_id
          AND fb.location_id    = o.location_id
         LEFT JOIN users u
           ON u.location_id = o.location_id AND u.user_id = o.assigned_to
        WHERE o.location_id = $1 AND o.opportunity_id = $2
          AND o.is_deleted = false AND o.deleted_at IS NULL`,
      [locationId, opportunityId]
    );
    if (!dealQ.rowCount) return null;
    const deal = dealQ.rows[0];

    // Other open deals for the same customer — spec A. Matters because a
    // commitment may belong to the sibling deal, not this one.
    const siblingsQ = await client.query(
      `SELECT opportunity_id, name, current_stage_name, monetary_value, currency
         FROM opportunities
        WHERE location_id = $1 AND contact_id = $2
          AND opportunity_id <> $3
          AND status = 'open'
          AND is_deleted = false AND deleted_at IS NULL AND is_ghost = false`,
      [locationId, deal.contact_id, opportunityId]
    );

    // ── B. People ─────────────────────────────────────────────────────
    const peopleQ = await client.query(
      `SELECT c.contact_id, c.first_name, c.last_name, c.company_name,
              c.email, c.phone, c.contact_type, c.timezone,
              -- Promoted columns as of migration 052. The dnd_* generated
              -- columns already encode GHL's active-means-blocked polarity,
              -- so no caller can get the inversion wrong.
              c.dnd, c.dnd_email, c.dnd_sms, c.dnd_call, c.dnd_whatsapp,
              c.dnd_inbound,
              oc.is_primary
         FROM opportunity_contacts oc
         JOIN contacts c
           ON c.location_id = oc.location_id AND c.contact_id = oc.contact_id
        WHERE oc.location_id = $1 AND oc.opportunity_id = $2
          AND oc.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
        ORDER BY oc.is_primary DESC NULLS LAST, c.first_name ASC`,
      [locationId, opportunityId]
    );
    let people = peopleQ.rows;
    if (!people.length && deal.contact_id) {
      const fb = await client.query(
        `SELECT contact_id, first_name, last_name, company_name, email, phone,
                contact_type, timezone,
                dnd, dnd_email, dnd_sms, dnd_call, dnd_whatsapp, dnd_inbound,
                true AS is_primary
           FROM contacts WHERE location_id = $1 AND contact_id = $2`,
        [locationId, deal.contact_id]
      );
      people = fb.rows;
    }

    // ── C. Messages ───────────────────────────────────────────────────
    // Everything attributed to this deal, oldest → newest (chronology is
    // meaning: "I'll send it Thursday" then "make that next week" only reads
    // correctly in order). Readability is computed per row so unreadable
    // messages can be counted for the stamp without being sent.
    const msgQ = await client.query(
      `SELECT m.message_id, m.message_channel, m.message_direction,
              m.message_body, m.message_timestamp, m.contact_id,
              m.is_call, m.call_duration_seconds, m.from_backfill,
              m.sender_name, m.raw_message,
              -- Which sender carried it. A location can run native WhatsApp
              -- alongside a "WhatsApp QR" provider, and a reply from the wrong
              -- one reaches the customer as a new conversation from a number
              -- they do not recognise. Used to prefill the card's sender.
              m.conversation_provider_id,
              ct.fetch_status AS transcript_status,
              ct.transcript_text,
              mom.mapping_status,
              -- Rep-excluded messages are fetched, not filtered out: they're
              -- counted and named in the coverage stamp so the rep can see
              -- what the answer did NOT read (spec rule 6).
              (x.subject_id IS NOT NULL) AS ai_excluded,
              -- Resolve the excluder to a name. excluded_by holds whatever the
              -- session had, which is usually a raw user id — rendering
              -- "4 excluded by h07KvFvGuKUVRExims8y" in the coverage stamp is
              -- unreadable, so join users and fall back to the id only when
              -- there's genuinely no name.
              COALESCE(xu.name, x.excluded_by) AS excluded_by
         FROM messages m
         JOIN message_opportunity_map mom
           ON mom.location_id = m.location_id
          AND mom.message_id  = m.message_id
          AND mom.superseded_at IS NULL
          AND mom.mapping_status IN ('mapped', 'manually_resolved')
         LEFT JOIN call_transcriptions ct
           ON ct.location_id = m.location_id AND ct.message_id = m.message_id
         LEFT JOIN ai_exclusions x
           ON x.location_id    = m.location_id
          AND x.subject_type   = 'message'
          AND x.subject_id     = m.message_id
          AND x.opportunity_id = mom.opportunity_id
         LEFT JOIN users xu
           ON xu.location_id = x.location_id
          AND xu.user_id     = x.excluded_by
        WHERE m.location_id = $1
          AND mom.opportunity_id = $2
          AND m.deleted_at IS NULL
        ORDER BY m.message_timestamp ASC`,
      [locationId, opportunityId]
    );

    // ── D. Deal-scoped notes ──────────────────────────────────────────
    // First-class evidence, same weight as a message (spec §1D).
    const notesQ = await client.query(
      `SELECT n.note_id, n.body, n.author_name, n.imported_at, n.created_at_ghl,
              (x.subject_id IS NOT NULL) AS ai_excluded
         FROM notes n
         LEFT JOIN ai_exclusions x
           ON x.location_id    = n.location_id
          AND x.opportunity_id = $2
          AND x.subject_type   = 'note'
          AND x.subject_id     = n.note_id
        WHERE n.location_id = $1 AND n.opportunity_id = $2
          AND n.status = 'active'
        ORDER BY COALESCE(n.created_at_ghl, n.imported_at) ASC`,
      [locationId, opportunityId]
    );

    // ── D2. Deal-scoped tasks ─────────────────────────────────────────
    //
    // New in this pass. A task is what the team COMMITTED to do, which is
    // exactly the sort of thing "what did we promise?" turns on — and it was
    // invisible to the model. Same exclusion treatment as notes and messages.
    //
    // Titles and bodies only: a task's due date and status go in as structured
    // fields on the block, not as prose the model has to parse.
    const tasksQ = await client.query(
      `SELECT t.task_id, t.title, t.body, t.status, t.due_at,
              t.assigned_to_name, t.created_at_ghl, t.imported_at,
              (x.subject_id IS NOT NULL) AS ai_excluded
         FROM tasks t
         LEFT JOIN ai_exclusions x
           ON x.location_id    = t.location_id
          AND x.opportunity_id = $2
          AND x.subject_type   = 'task'
          AND x.subject_id     = t.task_id
        WHERE t.location_id = $1 AND t.opportunity_id = $2
          AND t.deleted_at IS NULL
        ORDER BY COALESCE(t.created_at_ghl, t.imported_at) ASC`,
      [locationId, opportunityId]
    );

    // ── E. Control centre config ──────────────────────────────────────
    const [meddicQ] = await Promise.all([
      // Qualification headings, as configured in GHL. The prompt names these
      // rather than textbook MEDDIC — see prompts.js.
      client.query(
        `SELECT field_key, display_name, is_active, placeholder
           FROM ghl_custom_field_definitions
          WHERE location_id = $1
            AND object_type = 'opportunity'
            AND field_key ~ '^opportunity[.]meddic_[0-9]+$'
          ORDER BY (regexp_replace(field_key, '^.*_', ''))::int ASC`,
        [locationId]
      )
    ]);

    return {
      deal,
      siblings: siblingsQ.rows,
      people,
      rawMessages: msgQ.rows,
      notes: notesQ.rows,
      tasks: tasksQ.rows,
      meddicFields: meddicQ.rows
    };
  });

  if (!data) return null;

  // Read after the tenant block: businessContext manages its own cache and
  // transaction, and a cache hit means no query at all. The custom-field
  // catalogue likewise opens its own tenant scope — every field on the
  // opportunity with its current value, so "what's the buyer type" is a
  // fact and "set it to homeowner" knows the field exists and what it
  // accepts (opportunityFields.js).
  const [bizCtx, fields] = await Promise.all([
    getBusinessContext(locationId),
    fieldsWithValues(locationId, opportunityId)
  ]);

  // ── Readability split ───────────────────────────────────────────────
  // A call is readable only with a transcript. Everything else is readable if
  // it has a body. Unreadable rows are counted and named, never silently
  // dropped (spec rule 6).
  const readable = [];
  const unreadable = [];
  const excluded = [];
  const outOfScope = [];
  for (const m of data.rawMessages) {
    const isCall = m.is_call || /CALL|VOICEMAIL/i.test(m.message_channel || '');
    const transcript = m.transcript_status === 'ok' ? m.transcript_text : null;
    const body = isCall ? transcript : m.message_body;
    const hasBody = !!(body && String(body).trim());

    // A rep's exclusion wins over readability: if they've excluded it, it
    // doesn't go to the model whether or not we could read it.
    if (m.ai_excluded) {
      excluded.push({ row: m, isCall });
      continue;
    }
    // Channel scope is a per-question narrowing, so a message outside it is
    // counted as out-of-scope rather than excluded — the stamp says "5 outside
    // the SMS filter", not "5 excluded by Ollie". Different facts.
    if (channelScope && !channelScope.has(normaliseChannel(m.message_channel, isCall))) {
      outOfScope.push({ row: m, isCall });
      continue;
    }
    if (hasBody) {
      readable.push({ row: m, body: String(body).trim(), isCall });
    } else {
      unreadable.push({ row: m, isCall });
    }
  }

  const messages = readable.map(({ row, body, isCall }) => ({
    message_id: row.message_id,
    channel: normaliseChannel(row.message_channel, isCall),
    conversation_provider_id: row.conversation_provider_id || null,
    direction: row.message_direction === 'inbound' ? 'in' : 'out',
    sender: row.message_direction === 'inbound' ? row.contact_id : 'us',
    sender_name: row.message_direction === 'inbound' ? null : row.sender_name,
    sent_at: row.message_timestamp,
    age_days: daysSince(row.message_timestamp),
    body_text: body,
    is_call: isCall,
    call_duration_min: row.call_duration_seconds
      ? Math.round(row.call_duration_seconds / 60)
      : null,
    flags: {
      imported: !!row.from_backfill,
      manually_filed: row.mapping_status === 'manually_resolved'
    }
  }));

  // ── E2. Thread budget ───────────────────────────────────────────────
  //
  // The thread is the only unbounded part of the context: a two-year account
  // can carry a thousand messages, and transcribed calls are ~6k chars each.
  // Left uncapped that is 600k+ tokens per question — slow, expensive, and
  // eventually past the window.
  //
  // Keep the NEWEST messages: recency is what a "what's happening on this
  // deal" question needs, and rule 4 already says the latest version wins.
  //
  // Whatever is dropped is REPORTED, in unreadReasons, the same way an
  // untranscribed call is. Silently truncating a thread would produce a
  // confident answer built on half the evidence with nothing on screen saying
  // so — the one failure mode a rep could not catch.
  const { kept: budgetedMessages, dropped: droppedForBudget } =
    applyThreadBudget(messages, opts.threadTokenBudget ?? THREAD_TOKEN_BUDGET);

  // Notes and tasks the rep has deselected. Filtered out of the payload but
  // named in the coverage stamp, exactly like an excluded message.
  // A channel scope narrows notes and tasks as well as messages. It only
  // filtered messages before, so asking "SMS only" still sent every note and
  // the answer read more than the chips promised.
  const notesInScope = !channelScope || channelScope.has('note');
  const tasksInScope = !channelScope || channelScope.has('task');

  const includedNotes = notesInScope
    ? data.notes.filter((n) => !n.ai_excluded)
    : [];
  const excludedNotes = notesInScope
    ? data.notes.length - includedNotes.length
    : 0;
  const includedTasks = tasksInScope
    ? data.tasks.filter((t) => !t.ai_excluded)
    : [];
  const excludedTasks = tasksInScope
    ? data.tasks.length - includedTasks.length
    : 0;

  // Out-of-scope items are reported separately from deselected ones: one is a
  // per-question choice, the other a standing decision.
  const notesOutOfScope = notesInScope ? 0 : data.notes.length;
  const tasksOutOfScope = tasksInScope ? 0 : data.tasks.length;

  // ── F. Coverage stamp — computed, never from the model ──────────────
  const unreadReasons = [];
  if (excludedNotes > 0) {
    unreadReasons.push(`${excludedNotes} note${excludedNotes === 1 ? '' : 's'} deselected`);
  }
  if (excludedTasks > 0) {
    unreadReasons.push(`${excludedTasks} task${excludedTasks === 1 ? '' : 's'} deselected`);
  }
  if (notesOutOfScope > 0) {
    unreadReasons.push(`${notesOutOfScope} note${notesOutOfScope === 1 ? '' : 's'} outside the filter`);
  }
  if (tasksOutOfScope > 0) {
    unreadReasons.push(`${tasksOutOfScope} task${tasksOutOfScope === 1 ? '' : 's'} outside the filter`);
  }
  if (droppedForBudget > 0) {
    unreadReasons.push(
      `${droppedForBudget} older message${droppedForBudget === 1 ? '' : 's'} beyond the size limit`
    );
  }
  const untranscribedCalls = unreadable.filter((u) => u.isCall).length;
  const emptyBodies = unreadable.length - untranscribedCalls;
  if (untranscribedCalls > 0) {
    unreadReasons.push(
      `${untranscribedCalls} call${untranscribedCalls === 1 ? '' : 's'} not transcribed`
    );
  }
  if (emptyBodies > 0) {
    unreadReasons.push(
      `${emptyBodies} message${emptyBodies === 1 ? '' : 's'} with no readable text`
    );
  }
  if (outOfScope.length > 0) {
    const names = [...channelScope].map((c) => c.toUpperCase()).join('/');
    unreadReasons.push(
      `${outOfScope.length} outside the ${names} filter`
    );
  }
  if (excluded.length > 0) {
    // Attribute it when we know who: "2 excluded by Ollie" is the spec's own
    // wording, and it tells the reader whose judgement shaped the answer.
    const by = [...new Set(excluded.map((e) => e.row.excluded_by).filter(Boolean))];
    unreadReasons.push(
      `${excluded.length} excluded${by.length === 1 ? ` by ${by[0]}` : ''}`
    );
  }

  const coverage = {
    readAt: new Date().toISOString(),
    messagesTotal: data.rawMessages.length,
    messagesRead: budgetedMessages.length,
    unreadReasons,
    channelsRead: [...new Set(budgetedMessages.map((m) => m.channel))].sort(),
    oldestRead: messages[0]?.sent_at || null,
    newestRead: budgetedMessages[budgetedMessages.length - 1]?.sent_at || null
  };

  // The context file's version IS the config version now: replacing the file
  // is the only thing that changes the prompt's stable prefix, so it's what
  // has to invalidate cached answers.
  const configVersion = bizCtx?.version ?? 0;

  return {
    deal: shapeDeal(data.deal, data.siblings, fields),
    people: data.people.map(shapePerson),
    messages: budgetedMessages,
    // Excluded notes and tasks are FILTERED OUT here and counted in the
    // coverage stamp — same treatment as an excluded message. Rule 6 depends on
    // the model being told what it cannot see rather than silently missing it.
    notes: includedNotes.map((n) => ({
      note_id: n.note_id,
      body: n.body,
      author: n.author_name,
      created_at: n.created_at_ghl || n.imported_at
    })),
    tasks: includedTasks.map((t) => ({
      task_id: t.task_id,
      title: t.title,
      body: t.body,
      status: t.status,
      due_at: t.due_at,
      assignee: t.assigned_to_name,
      created_at: t.created_at_ghl || t.imported_at
    })),
    config: {
      // Control panel v1 — the whole business-context file, verbatim. Served
      // from the in-process cache after the first read, so a burst of
      // questions doesn't re-fetch the same text.
      businessContext: bizCtx?.content || null,
      meddicFields: data.meddicFields.map((f) => ({
        fieldKey: f.field_key,
        name: f.display_name,
        active: f.is_active,
        // GHL's own placeholder text — what the heading means.
        description: f.placeholder
      }))
    },
    coverage,
    // Cache identity: the exact message set + config + builder version.
    cacheKeyParts: {
      messageIds: budgetedMessages.map((m) => m.message_id),
      // Notes and tasks are part of what the answer was built from, so
      // deselecting one has to invalidate the cached answer. Without these a
      // rep could exclude a note and get the identical cached response back.
      noteIds: includedNotes.map((n) => n.note_id),
      taskIds: includedTasks.map((t) => t.task_id),
      configVersion,
      contextVersion: CONTEXT_VERSION
    },
    channelScope: channelScope ? [...channelScope].sort() : null
  };
}

// sha256 over what actually determines the answer. Message ids are sorted so
// an ordering change in the query plan can't miss a cache hit — order is
// preserved in the payload itself, which is what matters to the model.
export function cacheKeyFor({ callType, cacheKeyParts, question = null }) {
  const h = crypto.createHash('sha256');
  h.update(callType);
  h.update('|');
  h.update([...cacheKeyParts.messageIds].sort().join(','));
  h.update('|');
  // Notes and tasks the answer read. Optional so an older caller (or a call
  // type that has no notes) still hashes, rather than throwing on undefined.
  h.update([...(cacheKeyParts.noteIds || [])].sort().join(','));
  h.update('|');
  h.update([...(cacheKeyParts.taskIds || [])].sort().join(','));
  h.update('|');
  h.update(String(cacheKeyParts.configVersion));
  h.update('|');
  h.update(String(cacheKeyParts.contextVersion));
  if (question) {
    h.update('|');
    h.update(question.trim().toLowerCase());
  }
  return h.digest('hex');
}

// Exported for direct unit testing (see __tests__/contextBuilder.test.mjs) —
// pure, no DB access, unlike buildDealContext itself which needs a real
// connection under withTenant.
export function shapeDeal(d, siblings, fields = []) {
  return {
    deal_id: d.opportunity_id,
    title: d.name,
    stage: d.current_stage_name,
    stage_entered_at: d.stage_entered_at,
    days_in_stage: daysSince(d.stage_entered_at),
    status: d.status,
    value: d.monetary_value != null ? Number(d.monetary_value) : null,
    currency: d.currency || 'GBP',
    owner: d.owner_name || d.assigned_to_name || null,
    expected_close: d.forecast_close_date,
    // FORECAST, as the CRM actually computes it.
    //
    // win_probability is NOT always the number typed onto the deal: when the
    // pipeline is set to use stage probabilities, the deal's own figure is
    // ignored. probability_source says which rule applied, so the model can
    // explain a number the rep did not set rather than repeating it blankly.
    // 'none' means no probability exists anywhere — the deal contributes
    // nothing to expected revenue, which is a setup gap rather than a verdict
    // on the deal.
    win_probability: d.effective_probability != null
      ? Number(d.effective_probability) : null,
    probability_source: d.probability_source || null,
    weighted_value: d.weighted_value != null ? Number(d.weighted_value) : null,
    close_date_overdue: d.overdue_close_date === true ? true : undefined,
    // Only present when the date has actually moved — a deal that never
    // slipped should carry no slip fields at all, rather than a pair of
    // zeroes the model might mention for no reason.
    ...(Number(d.times_pushed) > 0 ? {
      close_date_pushed_times: Number(d.times_pushed),
      original_close_date: d.original_close_date,
      days_slipped: d.original_close_date && d.forecast_close_date
        ? Math.max(0, Math.round(
            (new Date(d.forecast_close_date) - new Date(d.original_close_date))
            / 86400000))
        : null
    } : {}),
    pipeline: d.pipeline_name,
    product: [flatten(d.product_system), flatten(d.product_type)]
      .filter(Boolean).join(' · ') || null,
    client_type: flatten(d.client_type),
    lead_source: d.lead_source_opportunity,
    // Every custom field on the opportunity, by label, with its current
    // value and (for picklists) the choices — see opportunityFields.js.
    fields: Array.isArray(fields) ? fields : [],
    source: d.opportunity_source,
    created_at: d.created_at_ghl,
    // "Has this deal gone quiet" used to be something the model had to
    // reconstruct itself from raw message timestamps in the thread — it
    // worked, but as inference rather than a fact. Computed here instead,
    // from the exact same query search_deals's quietDays filter uses
    // (registry.js), so Deal AI and Insights AI can never give a different
    // answer to "how long since they last replied" for the same deal.
    last_inbound_at: d.last_inbound_at,
    quiet_days: daysSince(d.last_inbound_at),
    other_open_deals: siblings.map((s) => ({
      deal_id: s.opportunity_id,
      title: s.name,
      stage: s.current_stage_name,
      value: s.monetary_value != null ? Number(s.monetary_value) : null
    }))
  };
}

function shapePerson(p) {
  const name = [p.first_name, p.last_name].filter(Boolean).join(' ')
    || p.email || p.phone || p.company_name || 'Contact';
  return {
    contact_id: p.contact_id,
    name,
    business: p.company_name,
    contact_type: p.contact_type,
    is_primary: !!p.is_primary,
    email: p.email,
    phone: p.phone,
    timezone: p.timezone,
    // DND is a hard gate on drafts (spec rule 7) — enforced in code where the
    // channel is chosen, but the model sees it so it doesn't propose a
    // blocked channel in the first place.
    dnd: dndOf(p)
  };
}

// GHL stores DND as a boolean plus a per-channel settings blob. Shape it into
// the flat form the spec describes.
// Straight read of the generated columns — the polarity rule lives in
// migration 052 so it's stated once for every consumer.
function dndOf(p) {
  return {
    all: p.dnd === true,
    email: p.dnd_email === true,
    text: p.dnd_sms === true,
    calls: p.dnd_call === true,
    whatsapp: p.dnd_whatsapp === true,
    inbound: p.dnd_inbound === true
  };
}

function normaliseChannel(raw, isCall) {
  if (isCall) return 'call';
  const c = String(raw || '').toUpperCase();
  if (c.includes('EMAIL')) return 'email';
  if (c.includes('WHATSAPP')) return 'whatsapp';
  if (c.includes('IMESSAGE')) return 'imessage';
  if (c.includes('SMS')) return 'sms';
  if (c.includes('NOTE')) return 'note';
  return c.toLowerCase() || 'unknown';
}

function flatten(v) {
  if (v == null) return null;
  if (Array.isArray(v)) {
    const parts = v.filter((x) => x != null && x !== '').map(String);
    return parts.length ? parts.join(', ') : null;
  }
  const s = String(v).trim();
  return s || null;
}

function daysSince(ts) {
  if (!ts) return null;
  const then = new Date(ts).getTime();
  if (Number.isNaN(then)) return null;
  return Math.max(0, Math.floor((Date.now() - then) / 86400000));
}

export function logContextSize(ctx, label) {
  const chars = ctx.messages.reduce((n, m) => n + (m.body_text?.length || 0), 0);
  logger.info(
    {
      label,
      messages: ctx.messages.length,
      notes: ctx.notes.length,
      bodyChars: chars,
      approxTokens: Math.round(chars / 4),
      // The exact ids sent to the model. Logged because the request body
      // deliberately carries no message list — the set is derived server-side
      // — so this line (and ai_runs.input_message_ids) is how you verify what
      // was actually read, including that an exclusion took effect.
      sentMessageIds: ctx.messages.map((m) => m.message_id),
      // Why anything was left out. Mirrors the coverage stamp shown in the UI.
      excludedOrUnreadable: ctx.coverage.messagesTotal - ctx.coverage.messagesRead,
      unreadReasons: ctx.coverage.unreadReasons
    },
    'ai: context built'
  );
}
