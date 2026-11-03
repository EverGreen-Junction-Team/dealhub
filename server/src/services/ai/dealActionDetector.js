// dealActionDetector.js — "does this question also want a write?", for
// Deal Hub's per-deal Co-Pilot.
//
// askDeal.js is a single, schema-validated, CACHED call whose whole job is
// producing a citation-verified answer — see its own header: "Read-only, so
// this is the first call shipped: no write path, no proposals to confirm."
// That design is deliberately untouched here. This is a SEPARATE, small
// second call, run only after askDeal already answered, using the exact
// same PROPOSE_TOOLS (and, for attach_contact, search_contacts) the
// portfolio tab's tool loop uses — so a proposal from either surface is
// identical in shape and goes through the identical confirm route.
//
// Bounded to a couple of rounds, not the full 6-round runToolLoop: this
// call never answers a question or reads the thread. The deal's own
// contacts are told to the model directly (see contactsBlock below), so
// "send them a message" / "attach this contact" resolve to a real id with
// NO search_contacts round trip in the common case — that tool only fires
// when the rep names someone who isn't already on the deal.

import { getClient, MODEL } from './claudeClient.js';
import { withTenant } from '../../db.js';
import { runTool, toolCatalogue, PROPOSE_TOOLS, DEAL_HUB_NO_SEND_TOOLS } from './tools/registry.js';
import { logger } from '../../utils/logger.js';
import { senderChannel } from '../../utils/channels.js';
import { mailboxForUser } from '../userWriter.js';

const MAX_ROUNDS = 3;

// Every propose_* tool EXCEPT sending a message: on the Deal Hub, messages
// go out from the timeline composer, never from Co-Pilot (see
// DEAL_HUB_NO_SEND_TOOLS). The detector only ever runs for a deal.
const ALLOWED_TOOL_NAMES = new Set([
  'search_contacts', 'search_tasks', 'search_notes',
  ...PROPOSE_TOOLS.map((t) => t.name).filter((n) => !DEAL_HUB_NO_SEND_TOOLS.has(n))
]);

const SYSTEM_BASE = `You are checking whether a sales rep's question, asked from inside one specific deal, is ALSO asking for a CRM write action — not just information.

You have action tools for contacts (create/update), tags (add/remove), deals (create a new one; edit ANY field — name, value, stage, pipeline, close date, and every custom field listed below — via propose_update_deal; attach/remove a contact; change owner/status; delete; add/remove followers), tasks (create/complete/update/delete), notes (create/update/delete), and businesses (create/update/delete) — all named propose_*. Also search_contacts, search_tasks and search_notes, to resolve a name or description to a real id ONLY when it is not already given to you below.

Rules:
- MESSAGING A CUSTOMER IS NOT YOURS HERE. A request to email, text, SMS, WhatsApp, message or reply to anyone — on any channel — is sent by the rep from the timeline's message box, not from Co-Pilot. Call NOTHING for it and reply with the single word: none. (If the same question also asks for a CRM action — "email her and set a task" — do only the CRM action.)
- If the question is purely informational ("what's the status", "what did they say"), call NOTHING and reply with the single word: none
- If it asks for an action but is missing required details (e.g. "create a contact" with no name/phone/email at all, "mark this lost" with no reason, ), call the matching propose_ tool anyway — it will tell you what's missing, and you should relay that back in one short sentence asking for it. Do not silently do nothing.
- Call at most ONE propose_ tool. A single question proposes a single action.
- Never call a propose_ tool "just in case" — only when the rep's words actually ask for that action. Never propose a delete unless the rep's words unambiguously ask for a permanent removal — "mark it lost"/"close it" is propose_change_status, not propose_delete_deal.
- Resolve ids before proposing, never guess one. Use the contacts/tasks/notes listed below directly when the rep is clearly referring to one of them; otherwise call search_contacts/search_tasks/search_notes first.
- A contact the rep names who is NOT in the list below: still do what they asked, but LEAD WITH IT. Resolve them with search_contacts, propose the action against them, and START your reply with the mismatch before describing what you drafted — e.g. "Ajmeera isn't linked to this deal — I've still drafted the task." Not the other way round: a rep who skims the first line is exactly the person who needs this, and they may click Confirm before reading to the end. Never silently substitute the deal's primary contact for someone the rep named by name or email, and never refuse: the rep may genuinely want a task or note for someone outside the deal, and they are the one confirming it.
- Changing a deal FIELD — "set the product type to bifolds", "buyer type is homeowner", "lead source is website", "update the enquiry to ...", "clear the postcode", "move it to the Quotes pipeline", "close date is next Friday" — means propose_update_deal. Custom fields go in its "fields" list, named by the label shown in the deal-fields list below, with the value the rep said; the server matches picklist choices and tells you if one is not valid. Several fields in one sentence are ONE propose_update_deal call with several entries. Never answer that a field cannot be updated.
- "Create a task" / "remind me to ..." / "follow up about ..." means propose_create_task. It needs a contact and a title — use the deal's primary contact below unless the rep names someone else. Include this deal's id as opportunityId so the task is proposed against the right deal.
- "Mark that task done" / "complete/reopen/edit/delete that task" means propose_complete_task / propose_update_task / propose_delete_task. Use the taskId from the list below when the rep is clearly referring to one of them; otherwise call search_tasks first rather than guessing one.
- "Add/update/delete/pin/unpin that note" means propose_create_note / propose_update_note / propose_delete_note. Use the noteId from the list below when the rep is clearly referring to one of them; otherwise call search_notes first rather than guessing one.
- NEVER put an id in your reply — not a conversationProviderId, not a contact, task or note id. Ids are for tool arguments only. The rep reads names: "WhatsApp QR", "bindu". An id on screen reads as a bug, and the confirmation card already shows the sender by name.
- After acting (or deciding no action applies), reply with a short sentence. If you proposed an action, say what you're about to do in one clause (e.g. "I've drafted a new contact for you to confirm."). If nothing was actionable, reply with the single word: none`;

// The deal's own contacts, told to the model directly — this is what lets
// "send them a message" resolve to a real contactId with NO search_contacts
// round trip for the common case, and is also what search_contacts itself
// exists for: a name the rep mentions that ISN'T already on this list.
// Which channel this deal's conversation actually runs on.
//
// Without this the model had no basis for choosing one, so an unqualified
// "send a message" fell through to a blanket "prefer SMS if a phone number is
// present" — on a deal whose entire history is WhatsApp. The reply then
// announced "I can draft an SMS", which is both a guess and the wrong one.
//
// Most recent first: a thread that started on SMS and moved to WhatsApp should
// suggest WhatsApp.
// Ids never reach a rep's screen.
//
// The prompt says so, but a prompt is a request. The model is handed
// conversationProviderIds so it can pass one back as a tool argument, and the
// nearest thing to hand when writing a sentence about a sender is that same
// id — so "I'll send via 6a22bfc4fcbd457e97784fbb" is one slip away. An id on
// screen reads as a bug, and the card already names the sender.
//
// Only 24-char Mongo ObjectIds and UUIDs are removed: those are the id shapes
// in play, and both are far too specific to appear in real prose. Ordinary
// words, phone numbers and dates are untouched. Tidies the punctuation the
// removal leaves behind rather than printing "send via  ()".
const ID_SHAPES = /\b([0-9a-f]{24}|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\b/gi;

function stripIds(text) {
  if (!text) return text;
  if (!ID_SHAPES.test(text)) { ID_SHAPES.lastIndex = 0; return text; }
  ID_SHAPES.lastIndex = 0;
  const cleaned = text
    .replace(ID_SHAPES, '')
    .replace(/\(\s*[,;]?\s*\)/g, '')       // "()" left by a removed id
    .replace(/\s*,\s*(?=[,.)])/g, '')       // dangling commas
    .replace(/\s{2,}/g, ' ')
    .replace(/\s+([.,;:!?])/g, '$1')
    .trim();
  return cleaned || null;
}

// id -> name for the providers this thread actually used. One query, only for
// the handful of ids present; a failure is non-fatal — the ids still work, the
// model just cannot name them.
// Every sender this location can send through, by channel.
//
// resolveProviderNames below only learns what the THREAD used, which is
// nothing on a deal with no messages — exactly when a rep is most likely to
// be starting a conversation. Without this the AI asks "SMS, WhatsApp or
// Email?" and never mentions that SMS has three senders behind it, so a rep
// picks a channel and gets whichever GHL considers default.
//
// Only channels this app can actually compose for. A Call-type provider is
// real and in the table, but there is no compose UI for it, so offering one
// would be a choice that cannot be acted on.
const COMPOSABLE_TYPES = ['SMS', 'Email', 'WhatsApp'];

async function locationProviders(locationId) {
  try {
    return await withTenant(locationId, async (c) => {
      const { rows } = await c.query(
        `SELECT provider_id, name, type, is_default, is_native
           FROM conversation_providers
          WHERE location_id = $1
            AND is_deleted = false
            AND type = ANY($2::text[])
            AND name IS NOT NULL
          ORDER BY type, is_default DESC, lower(name)`,
        [locationId, COMPOSABLE_TYPES]
      );
      return rows;
    });
  } catch (err) {
    logger.warn({ err, locationId }, 'dealActionDetector: could not list providers');
    return [];
  }
}

// The channel a REP would file a sender under, which is not always the type
// GHL stores it as.
//
// GHL registers marketplace providers as SMS-type: "WhatsApp QR", "iMessage"
// and "SMS Android" all carry type 'SMS' (migration 080 records the live
// payload). Bucketed by that type, WhatsApp QR landed under SMS and the
// WhatsApp line read "native only" — so a rep asking for WhatsApp was told
// there was nothing to choose, while the sender they meant sat one line up
// under a channel the prompt forbids substituting. Bucketing by NAME puts it
// where the rep will look.
//
// Sending still works: ghlMessageWrite turns any custom provider id into
// type 'Custom', so the channel named here is for the rep's benefit and
// never reaches GHL as the send type.
// One classifier for every reader of conversation_providers — see
// utils/channels.senderChannel for why.
const displayChannel = senderChannel;

// `mailbox` is the asking rep's connected Gmail/Outlook (users table, not
// conversation_providers). It is an Email sender in every sense a rep cares
// about — the mail leaves from their own address — so it is listed under
// Email as a named sender, with the synthetic id the send path understands.
// Without it the detector saw "Email: native only" and never asked, while
// the card then offered Gmail anyway: the rep got the choice on the card
// but never in the conversation, unlike WhatsApp QR.
function providersBlock(rows) {
  const byType = {};
  for (const r of rows) (byType[displayChannel(r)] ||= []).push(r);

  // EVERY composable channel gets a line, including ones with no custom
  // provider at all.
  //
  // This used to list only channels with more than one provider, which
  // dropped two whole categories: the NATIVE sender of every channel (not a
  // row in conversation_providers — it is what you get by sending `type`
  // alone), and any channel whose only sender is a single custom one. On an
  // account whose SMS has three custom senders and whose Email has a native
  // one, the AI offered three SMS senders and never mentioned email at all.
  //
  // Native first in each channel, because it is the default a bare send uses
  // and the safest answer when a rep does not care.
  const lines = COMPOSABLE_TYPES.map((type) => {
    const custom = byType[type] || [];
    const senders = [
      `${type} (native)`,
      ...custom.map((r) =>
        `${r.name}${r.is_default ? ' (default)' : ''} [conversationProviderId ${r.provider_id}]`)
    ];
    return `- ${type}: ${senders.join(', ')}`;
  });

  return 'Senders available on this location, by channel:\n'
    + lines.join('\n')
    + '\nEvery channel has a native sender (send the channel type with no '
    + 'conversationProviderId); the named ones after it are custom senders that '
    + 'need their id passed. Offer whatever the contact can actually receive on — '
    + 'a contact with no email cannot be emailed however many email senders exist. '
    + 'Name senders, never ids. If a channel has only its native sender, do not '
    + 'make the rep choose one — just say the channel. A custom sender is listed '
    + 'under the channel its name says — "WhatsApp QR" under WhatsApp — so propose '
    + 'it with that channel as `type` and its conversationProviderId; the send '
    + 'path handles the rest. A thread that already has messages makes its '
    + 'sender the FIRST numbered option, marked "(used in this thread)" — it '
    + 'does not skip the question.';
}

async function resolveProviderNames(locationId, messages) {
  const ids = [...new Set(
    (messages || []).map((m) => m?.conversation_provider_id).filter(Boolean)
  )];
  if (!ids.length) return {};
  try {
    return await withTenant(locationId, async (c) => {
      const { rows } = await c.query(
        `SELECT provider_id, name FROM conversation_providers
          WHERE location_id = $1 AND provider_id = ANY($2::text[])`,
        [locationId, ids]
      );
      return Object.fromEntries(rows.filter((r) => r.name).map((r) => [r.provider_id, r.name]));
    });
  } catch (err) {
    logger.warn({ err, locationId }, 'dealActionDetector: could not resolve provider names');
    return {};
  }
}

function channelBlock(messages, providerNames = {}) {
  const none = 'No messages on this deal yet, so no channel is established.';
  if (!messages?.length) return none;

  const seen = [];
  // The sender that most recently carried each channel. A location can run
  // native WhatsApp beside a "WhatsApp QR" provider, and replying from the
  // wrong one arrives as a new conversation from a number the customer does
  // not recognise — so the thread's own sender is the right default.
  const senderFor = {};
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    const c = String(m?.channel || '').toUpperCase();
    if (!c || c === 'NOTE' || c === 'TASK') continue;
    if (!seen.includes(c)) seen.push(c);
    if (!senderFor[c] && m.conversation_provider_id) {
      senderFor[c] = m.conversation_provider_id;
    }
  }
  if (!seen.length) return none;

  const lines = seen.map((c) => {
    const id = senderFor[c];
    if (!id) return `- ${c}`;
    const name = providerNames[id];
    return `- ${c} (last sent via ${name ? `${name}, ` : ''}conversationProviderId ${id})`;
  });

  return "Channels this deal's conversation already uses, most recent first:\n"
       + lines.join('\n')
       + '\nWhen you ask which sender to use, offer this one first, marked "(used in '
       + 'this thread)" — but it is an option in the numbered list, not a reason to '
       + 'skip the list. Once the rep has chosen a sender listed here with a '
       + 'conversationProviderId, pass that same id so the reply continues the existing '
       + 'conversation rather than starting a new one from a different sender.';
}

// Which channels a contact can be messaged on, after DND.
//
// SMS and WhatsApp both ride the phone number — that is exactly the inference
// the model got wrong when it saw only "phone" and offered "SMS or Email".
function channelsFor(p) {
  const out = [];
  const dnd = p.dnd || {};
  if (p.phone && !dnd.all && !dnd.text)     out.push('SMS');
  if (p.phone && !dnd.all && !dnd.whatsapp) out.push('WhatsApp');
  if (p.email && !dnd.all && !dnd.email)    out.push('Email');
  return out;
}

function contactsBlock(people) {
  if (!people?.length) return 'This deal has no contacts linked yet.';
  return 'Contacts already on this deal:\n' + people.map((p) => {
    const bits = [
      `id ${p.contact_id}`,
      p.is_primary ? 'primary' : null,
      p.email ? `email ${p.email}` : null,
      p.phone ? `phone ${p.phone}` : null,
      // The channels this contact can actually RECEIVE on, stated outright.
      //
      // Listing only "email" and "phone" left the model to infer the channel
      // list, and it inferred SMS + Email — dropping WhatsApp, which rides the
      // same phone number. A rep on a WhatsApp-only deal was offered "SMS or
      // Email" and neither was what they wanted. DND removes a channel here
      // rather than being a separate caveat, so an offer never includes a
      // channel the contact has opted out of.
      channelsFor(p).length ? `can receive: ${channelsFor(p).join(', ')}` : 'no contactable channel',
      // dndOf (contextBuilder.js) shapes this as { all, email, text, calls,
      // whatsapp, inbound } — `text`, not `sms`. Matching that exactly here.
      (p.dnd?.all || p.dnd?.text) ? 'DND: sms blocked' : null,
      (p.dnd?.all || p.dnd?.email) ? 'DND: email blocked' : null,
      (p.dnd?.all || p.dnd?.whatsapp) ? 'DND: whatsapp blocked' : null
    ].filter(Boolean).join(', ');
    return `- ${p.name} (${bits})`;
  }).join('\n');
}

// This deal's own tasks, with their real ids — the same list askDeal.js's
// own context already shows the model (contextBuilder.js/prompts.js), just
// carried into this separate call too. Without this, "mark that task done"
// had no id to give propose_complete_task and could only ever fail or
// hallucinate one.
function tasksBlock(tasks) {
  if (!tasks?.length) return 'This deal has no tasks recorded.';
  return 'Tasks already on this deal:\n' + tasks.map((t) => {
    const bits = [`id ${t.task_id}`, t.status, t.due_at ? `due ${t.due_at}` : null]
      .filter(Boolean).join(', ');
    return `- ${t.title || '(untitled)'} (${bits})`;
  }).join('\n');
}

// The deal's custom fields with their current values and choices — what
// lets "buyer type is homeowner" become a propose_update_deal with the right
// label, and lets an invalid choice be caught before the card is drawn.
function fieldsBlock(fields) {
  if (!fields?.length) return 'This account has no custom deal fields defined.';
  return 'This deal\'s fields (pass the label to propose_update_deal `fields`):\n'
    + fields.map((f) => {
      const opts = f.options?.length
        ? ` [choices: ${f.options.join(' | ')}${f.multiple ? '; several allowed' : ''}]`
        : '';
      return `- ${f.label}: ${f.value ?? '(not set)'}${opts}`;
    }).join('\n');
}

// Same reasoning as tasksBlock — this deal's own notes, with real ids, so
// propose_update_note/propose_delete_note can resolve "that note" without a
// search_notes round trip in the common case.
function notesBlock(notes) {
  if (!notes?.length) return 'This deal has no notes recorded.';
  return 'Notes already on this deal:\n' + notes.map((n) => {
    const preview = String(n.body || '').slice(0, 60);
    return `- id ${n.note_id}: "${preview}${n.body?.length > 60 ? '…' : ''}"`;
  }).join('\n');
}

/**
 * @param {object} args
 * @param {string} args.locationId
 * @param {string} args.opportunityId  the deal this question was asked from
 * @param {string} args.question
 * @param {Array}  [args.people]  this deal's contacts (ctx.people from
 *   buildDealContext) — so propose_send_message / propose_attach_contact can
 *   resolve "the contact on this deal" without a search_contacts lookup.
 * @param {Array}  [args.tasks]  this deal's tasks (ctx.tasks from
 *   buildDealContext) — so propose_complete_task/update_task/delete_task can
 *   resolve "that task" to a real taskId without a search_tasks lookup.
 * @param {Array}  [args.notes]  this deal's notes (ctx.notes from
 *   buildDealContext) — so propose_update_note/delete_note can resolve
 *   "that note" to a real noteId without a search_notes lookup.
 * @returns {{ note: string|null, proposedActions: Array }}
 *   note is a short sentence to append to the answer (or null when nothing
 *   applied); proposedActions is [] when no write was proposed.
 */
export async function detectDealAction({
  locationId, opportunityId, question, people = [], tasks = [], notes = [], messages = [],
  fields = [], userId = null
}) {
  // Resolve the ids the thread used to names. An id alone tells the model
  // nothing, and a rep reading "last sent via 6a22bfc4..." learns nothing
  // either — the card shows the name.
  const [providerNames, provRows, mailbox] = await Promise.all([
    resolveProviderNames(locationId, messages),
    locationProviders(locationId),
    userId ? mailboxForUser(locationId, userId).catch(() => null) : Promise.resolve(null)
  ]);
  // The rep's mailbox joins the sender rows as an Email sender, in the same
  // shape as a provider row, so providersBlock lists it under Email with
  // the synthetic id the send path understands (see the note above it).
  if (mailbox?.email) {
    provRows.push({
      name: `${mailbox.kind} · ${mailbox.email}`,
      provider_id: `emailfrom:${mailbox.email}`,
      type: 'Email', is_default: false, is_native: false
    });
  }

  const system = [
    SYSTEM_BASE,
    contactsBlock(people),
    channelBlock(messages, providerNames),
    providersBlock(provRows),
    tasksBlock(tasks),
    notesBlock(notes),
    fieldsBlock(fields)
  ].filter(Boolean).join('\n\n');
  const anthropic = getClient();
  // The four propose tools plus search_contacts (needed to resolve a name
  // to an id before propose_attach_contact) — the full catalogue filtered
  // down to just what ALLOWED_TOOL_NAMES permits, rather than duplicating
  // any tool's schema here.
  const tools = toolCatalogue()
    .filter((t) => ALLOWED_TOOL_NAMES.has(t.name))
    .map((t) => ({ name: t.name, description: t.description, input_schema: t.inputSchema }));

  const convo = [{
    role: 'user',
    content: `This question was asked from deal ${opportunityId}: "${question}"`
  }];
  const proposedActions = [];
  let rounds = 0;

  try {
    while (rounds < MAX_ROUNDS) {
      rounds++;
      const res = await anthropic.messages.create({
        model: MODEL,
        max_tokens: 500,
        system,
        messages: convo,
        tools
        // No extended thinking. This decides "did the rep ask for a write,
        // and with what" from a sender list and a contact list it is handed
        // — tool selection, not open-ended reasoning — and it runs on every
        // question, so its thinking budget was paid every time.
      });

      convo.push({ role: 'assistant', content: res.content });
      const wanted = res.content.filter((b) => b.type === 'tool_use');

      if (wanted.length === 0) {
        const text = res.content
          .filter((b) => b.type === 'text')
          .map((b) => b.text)
          .join(' ')
          .trim();
        return {
          note: stripIds(text && text.toLowerCase() !== 'none' ? text : null),
          proposedActions
        };
      }

      const results = [];
      for (const call of wanted) {
        // opportunityId is always THIS deal — the detector never lets the
        // model invent a different one, since it was only ever given this
        // one deal's question to look at.
        const args = ALLOWED_TOOL_NAMES.has(call.name)
          ? { ...call.input, opportunityId: call.input.opportunityId || opportunityId }
          : null;
        const out = args
          ? await runTool(locationId, call.name, args)
          : { error: `Tool not permitted here: ${call.name}` };
        if (out?.actionId) proposedActions.push(out);
        results.push({ type: 'tool_result', tool_use_id: call.id, content: JSON.stringify(out) });
      }
      convo.push({ role: 'user', content: results });
    }
  } catch (err) {
    // Never let a detection failure break the answer that already
    // succeeded — askDeal.js's own citation-verified response is complete
    // and correct with or without this. Log and return "nothing found"
    // rather than surface a second error path on top of a working answer.
    logger.warn({ err, locationId, opportunityId }, 'ai: deal action detection failed');
    return { note: null, proposedActions: [] };
  }

  // Ran out of rounds without a final text reply — whatever was proposed
  // (if anything) still stands; there's just no closing sentence to add.
  return { note: null, proposedActions };
}
