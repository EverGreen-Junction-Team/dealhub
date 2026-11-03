// Ask-AI tool registry — what the model may fetch, and how.
//
// WHY THIS EXISTS. The portfolio Co-Pilot's first design hardcoded its SQL:
// portfolioContext.js decided in advance which columns the model would ever
// see. That capped it at the questions we anticipated — anything about tags, a
// business roll-up, or who changed a deal's value was unanswerable no matter
// that the data sat right there in Postgres.
//
// This is the pattern GHL's Ask AI uses (ai-backend/apps/ghl-mcp): tools are
// DATA, not code. Each carries a name, a description and a JSON schema; the
// model reads the catalogue, picks one, and returns arguments. Adding a
// capability is adding an entry here, not threading a column through a context
// builder.
//
// Two deliberate departures from theirs:
//
//   * Theirs stores tools in Firestore and executes them as HTTP calls into
//     internal services. Ours run as direct SQL under withTenant, because our
//     "internal service" is this same process — an HTTP hop to ourselves buys
//     a network round trip and a second auth path to get wrong.
//
//   * Every LOOKUP tool here is READ-ONLY — see LOOKUP_TOOLS below, which
//     toolRegistry.test.mjs scans for write verbs. The model may look at
//     anything in the sub-account and change nothing through them.
//
//     PROPOSE tools (PROPOSE_TOOLS) are the one deliberate exception, and
//     they still change NOTHING in GHL. Each inserts a 'pending' row into
//     ai_actions (migration 077) describing a write the model wants to
//     make — create a contact, attach one to a deal, change an owner or
//     status — and returns its id. The actual GHL call only happens when a
//     REP confirms that specific row by id, via routes/ai.js's confirm
//     endpoint, which re-validates it server-side and calls the same
//     ghlContactWrite.js/ghlOpportunityWrite.js/ghlAssociations.js
//     functions every non-AI write in this app already goes through. A
//     propose tool INSERTing a row is exactly as safe as a rep clicking
//     "New contact" and typing nothing yet — the row exists, nothing has
//     happened.
//
// RLS still applies: withTenant sets app.location_id per call, so no tool can
// reach another sub-account's rows however the model phrases it.

import { withTenant, rawQuery } from '../../../db.js';
import { fetchLocationName } from '../../locationInfo.js';
import { proposeAction } from '../actionStore.js';
import { logger } from '../../../utils/logger.js';
import { senderChannel } from '../../../utils/channels.js';
import { mailboxForUser, mailboxByAddress } from '../../userWriter.js';
import { emailAddr, emailAddrList } from '../../../utils/email.js';
import {
  listOpportunityFieldDefs, resolveOpportunityField, coerceFieldValue,
  currentFieldValues, valueOf, displayValue
} from '../../opportunityFields.js';

// Hard ceiling per tool call. "List every contact" would otherwise put 2,000
// rows in the prompt, blow the budget and answer worse than 50 rows plus an
// explicit "there are more".
const MAX_ROWS = 50;

// A contact's display name in SQL, mirroring utils/contactLabel.js exactly.
//
// WHY. These tools built the name as first || ' ' || last, so a GHL contact
// with no name parts — normal for one created from an inbound message, a form
// or a CSV import — came back as an empty string. The model then reported a
// deal's contact as blank even though a contact was plainly attached, which
// is what a rep sees as "why is this empty, bindu is right there".
//
// Same failure the rest of the app already fixed for tasks, notes and
// messages (see the history in utils/contactLabel.js). The order is that
// file's, and must stay in step with it:
//   name -> company -> email -> phone -> 'Unknown contact'
//
// NULLIF(trim(...), '') on each rung so a column containing only whitespace
// falls through rather than winning as a "name" made of spaces.
// How many OTHER people are on a deal, beyond its primary contact.
//
// opportunities.contact_id is the primary and is NOT NULL, so every deal has
// one — but a deal can carry more through opportunity_contacts (the
// architect, the QS, a second decision-maker). The deals table showed only
// the primary, so a deal with three people on it read as a deal with one.
//
// A COUNT rather than a list: the table's contact cell is ~160px with
// ellipsis, so extra names would be truncated into uselessness. "bindu +2"
// says there are more and is honest about not naming them; the model can
// call get_deal_contacts when a rep asks who they are.
//
// is_primary = false excludes the primary's own relation row, which GHL also
// writes — counting it would report every single-contact deal as having one
// extra person.
const otherContactsSql = (o) => `
  (SELECT count(*)::int
     FROM opportunity_contacts oc
    WHERE oc.location_id    = ${o}.location_id
      AND oc.opportunity_id = ${o}.opportunity_id
      AND oc.is_primary     = false
      AND oc.contact_id    <> ${o}.contact_id)`;

const contactLabelSql = (t) => `
  COALESCE(
    NULLIF(trim(COALESCE(${t}.first_name,'') || ' ' || COALESCE(${t}.last_name,'')), ''),
    NULLIF(trim(${t}.company_name), ''),
    NULLIF(trim(${t}.email), ''),
    NULLIF(trim(${t}.phone), ''),
    'Unknown contact'
  )`;


/**
 * The catalogue the model sees.
 *
 * `description` is the load-bearing field — it is ALL the model has when
 * choosing. Each says what the tool answers and, where it matters, what it
 * does NOT: the most expensive failure is a confident answer built from the
 * wrong source.
 */
export const LOOKUP_TOOLS = [
  {
    name: 'search_deals',
    description:
      'Find deals (opportunities) by stage, status, owner, tag, value, when ' +
      'they were created, or how long they have stalled or gone quiet. ' +
      'Returns deal FACTS only — no message content. Use for "which deals ' +
      'are in X stage", "what is the pipeline worth", "which deals has ' +
      'Chris got", "what has stalled". At most 50 rows, most recently ' +
      'updated first — for a pure count question like "how many deals were ' +
      'created last week", pass countOnly:true instead of reading this list, ' +
      'since the true total can exceed the 50-row cap.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'],
          description: 'Defaults to open when omitted.' },
        stage: { type: 'string', description: 'Stage name, matched loosely.' },
        owner: { type: 'string', description: 'Owner name, matched loosely.' },
        tag: { type: 'string', description: 'A tag on the deal.' },
        minValue: { type: 'number' },
        maxValue: { type: 'number' },
        stalledDays: { type: 'number',
          description: 'Only deals in their current stage this many days or more.' },
        quietDays: { type: 'number',
          description: 'Only deals with no INBOUND customer message for this many days. '
            + 'Our own outbound chasing does not count as contact.' },
        createdAfter: { type: 'string',
          description: 'ISO date/datetime (e.g. 2026-09-14). Only deals created on or after this.' },
        createdBefore: { type: 'string',
          description: 'ISO date/datetime. Only deals created before this.' },
        updatedAfter: { type: 'string',
          description: 'ISO date/datetime. Only deals last updated on or after this — '
            + 'any field edit, stage move, or sync touch counts, not just messages.' },
        updatedBefore: { type: 'string',
          description: 'ISO date/datetime. Only deals last updated before this.' },
        countOnly: { type: 'boolean',
          description: 'Return an EXACT total count instead of rows — no 50-row cap. '
            + 'Use this whenever the question is "how many", not "which/what/list".' }
      }
    },
    run: searchDeals
  },

  {
    name: 'get_deal_messages',
    description:
      'Read ONE deal\'s message thread — emails, SMS, WhatsApp, call ' +
      'transcripts. Use when the answer depends on what was actually said, ' +
      'and quote from it. Oldest first, so chronology reads correctly.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dealId'],
      properties: {
        dealId: { type: 'string' },
        limit: { type: 'number', description: 'Default 40, max 50.' }
      }
    },
    run: getDealMessages
  },

  {
    name: 'search_contacts',
    description:
      'Find contacts by name, email, phone, tag, owner, type, or when they ' +
      'were created. Use for "who is tagged VIP", "which contacts have no ' +
      'owner". Returns contact facts, not their messages. At most 50 rows, ' +
      'most recently updated first — for a pure count question like "how ' +
      'many contacts were created/updated last week", pass countOnly:true ' +
      'instead of reading this list, since the true total can exceed the ' +
      '50-row cap.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Matches name, email, phone or business.' },
        tag: { type: 'string' },
        owner: { type: 'string', description: 'Owner name, matched loosely.' },
        unassigned: { type: 'boolean', description: 'Only contacts with no owner.' },
        contactType: { type: 'string', enum: ['lead', 'customer'] },
        createdAfter: { type: 'string',
          description: 'ISO date/datetime (e.g. 2026-09-14). Only contacts created on or after this.' },
        createdBefore: { type: 'string',
          description: 'ISO date/datetime. Only contacts created before this.' },
        updatedAfter: { type: 'string',
          description: 'ISO date/datetime. Only contacts last updated on or after this.' },
        updatedBefore: { type: 'string',
          description: 'ISO date/datetime. Only contacts last updated before this.' },
        countOnly: { type: 'boolean',
          description: 'Return an EXACT total count instead of rows — no 50-row cap. '
            + 'Use this whenever the question is "how many", not "which/what/list".' }
      }
    },
    run: searchContacts
  },

  {
    name: 'get_deal_history',
    description:
      'What CHANGED on a deal and when — value edits, stage moves, owner ' +
      'reassignment, qualification filled in later. Use for "was this ' +
      'discounted", "who moved it", "when did it change hands". This is an ' +
      'audit trail, not a conversation: for what was SAID use get_deal_messages.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dealId'],
      properties: {
        dealId: { type: 'string' },
        field: { type: 'string',
          description: 'Optional: one field only, e.g. monetary_value or status.' }
      }
    },
    run: getDealHistory
  },

  {
    name: 'get_pipeline_summary',
    description:
      'Open deal counts and total value grouped by stage, for one pipeline or ' +
      'all. Stages come back in pipeline ORDER, so "how far along" is ' +
      'answerable. Use for "break the pipeline down", "where are deals piling up".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        pipeline: { type: 'string', description: 'Pipeline name; omit for all.' }
      }
    },
    run: getPipelineSummary
  },

  {
    name: 'get_deal_tasks_and_notes',
    description:
      'Open tasks and notes on one deal. A task is a commitment the team made ' +
      '— an open one is outstanding, a completed one is done. Notes are what ' +
      'the team recorded about the deal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dealId'],
      properties: { dealId: { type: 'string' } }
    },
    run: getDealTasksAndNotes
  },

  {
    name: 'get_account_info',
    description:
      'The name of the sub-account (business/company) this Co-Pilot is running ' +
      'in — the one piece of identity none of the deal/contact/pipeline tools ' +
      'carry, since they all answer WITHIN an account rather than ABOUT it. ' +
      'Use for "what account is this", "which sub-account", "what business am ' +
      'I looking at".',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: getAccountInfo
  },

  {
    name: 'get_deal_detail',
    description:
      'Everything known about ONE deal in a single call — value, stage, ' +
      'owner, the primary contact plus every OTHER contact on it (architect, ' +
      'QS, homeowner — a deal can have more than one person), ' +
      'product/client-type custom fields, tags, days ' +
      'in stage, and lost/won/abandoned reason if closed. Does NOT return ' +
      'what a rep typed into the qualification headings — read the ' +
      'conversation for that. Use when a question ' +
      'is about one specific deal and needs the full picture rather than one ' +
      'fact — "who is involved on the customer\'s side for X", "what\'s the ' +
      'full picture on Y", "why did we lose Z".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dealId'],
      properties: { dealId: { type: 'string' } }
    },
    run: getDealDetail
  },

  {
    name: 'get_contact_detail',
    description:
      'Everything known about ONE contact — name, email, phone, business, ' +
      'owner, tags, type (lead/customer), do-not-disturb status per channel ' +
      '(email/SMS/call/WhatsApp — a contact can be reachable on some channels ' +
      'and blocked on others), and every deal they are linked to (as primary ' +
      'OR as an additional contact on someone else\'s deal). Use for "tell me ' +
      'about contact X", "can we still message them", "what deals is this ' +
      'person on".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contactId'],
      properties: { contactId: { type: 'string' } }
    },
    run: getContactDetail
  },

  {
    name: 'get_deal_contacts',
    description:
      'Every person attached to ONE deal, not just the primary contact — a ' +
      'deal can have several (an architect, a quantity surveyor and the ' +
      'homeowner all on the same job), each flagged primary or not. Use for ' +
      '"who is involved on the customer\'s side for this deal", "who else is ' +
      'on this deal besides the main contact".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dealId'],
      properties: { dealId: { type: 'string' } }
    },
    run: getDealContacts
  },

  {
    name: 'search_businesses',
    description:
      'Find businesses (companies) by name or when they were created, or ' +
      'list them with their deal and contact counts and total open pipeline ' +
      'value. Use for "how many businesses do we have", "what\'s our biggest ' +
      'account by value", "tell me about business X", "how many businesses ' +
      'were added last month". Synced once daily, not by webhook — treat as ' +
      'accurate as of the last overnight sync, not live.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        query: { type: 'string', description: 'Matches business name.' },
        createdAfter: { type: 'string',
          description: 'ISO date/datetime (e.g. 2026-09-14). Only businesses created on or after this.' },
        createdBefore: { type: 'string',
          description: 'ISO date/datetime. Only businesses created before this.' },
        countOnly: { type: 'boolean',
          description: 'Return an EXACT total count instead of rows — no 50-row cap. '
            + 'Use this whenever the question is "how many", not "which/what/list".' }
      }
    },
    run: searchBusinesses
  },

  {
    name: 'search_tasks',
    description:
      'Find tasks across the WHOLE account (not one deal) by status, owner, ' +
      'or due date. Use for "what\'s overdue", "what has Priya got open", ' +
      '"what\'s due this week". For one specific deal\'s tasks use ' +
      'get_deal_tasks_and_notes instead — this is for a cross-deal view.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['open', 'completed'],
          description: 'Defaults to open when omitted.' },
        owner: { type: 'string', description: 'Owner name, matched loosely.' },
        dueBefore: { type: 'string', description: 'ISO date. Only tasks due on or before this — use for "overdue" with today\'s date.' },
        dueAfter: { type: 'string', description: 'ISO date. Only tasks due on or after this.' },
        countOnly: { type: 'boolean',
          description: 'Return an EXACT total count instead of rows — no 50-row cap. '
            + 'Use this for "how many open tasks are there" and similar count questions.' }
      }
    },
    run: searchTasks
  },

  {
    name: 'search_notes',
    description:
      'Find notes across the WHOLE account (not one deal) by author, pinned ' +
      'status, or how recent. Use for "what has the team noted recently", ' +
      '"any pinned notes I should know about". For one specific deal\'s notes ' +
      'use get_deal_tasks_and_notes instead — this is for a cross-deal view.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        author: { type: 'string', description: 'Author name, matched loosely.' },
        pinnedOnly: { type: 'boolean' },
        createdAfter: { type: 'string', description: 'ISO date/datetime.' },
        countOnly: { type: 'boolean',
          description: 'Return an EXACT total count instead of rows — no 50-row cap. '
            + 'Use this whenever the question is "how many", not "which/what/list".' }
      }
    },
    run: searchNotes
  },

  {
    name: 'search_messages',
    description:
      'Find messages across the WHOLE account (not one deal) by channel, ' +
      'direction, or how recent — the account-wide equivalent of ' +
      'get_deal_messages. Use for "any WhatsApp messages this week", "who ' +
      'sent us something today". Returns message facts (channel, direction, ' +
      'sender, timestamp) and a short excerpt, not the full body — use ' +
      'get_deal_messages on the specific deal for the complete text to ' +
      'quote from. For a count question like "how many inbound emails this ' +
      'month", pass countOnly:true instead of reading this list, since the ' +
      'true total can exceed the 50-row cap.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: { type: 'string',
          enum: ['EMAIL', 'SMS', 'CALL', 'VOICEMAIL', 'WEBCHAT', 'WHATSAPP', 'IMESSAGE', 'FACEBOOK', 'INSTAGRAM', 'FORM', 'ACTIVITY', 'CUSTOM'] },
        direction: { type: 'string', enum: ['inbound', 'outbound'] },
        since: { type: 'string', description: 'ISO date/datetime. Only messages at or after this.' },
        countOnly: { type: 'boolean',
          description: 'Return an EXACT total count instead of rows — no 50-row cap.' }
      }
    },
    run: searchMessages
  },

  {
    name: 'get_lost_won_breakdown',
    description:
      'Closed deals (won, lost, or abandoned) in a time window, with their ' +
      'reasons where recorded and total value. Use for "why are we losing ' +
      'deals", "what did we win last month", "biggest reason for lost deals", ' +
      '"how much did we close last week". Distinct from get_pipeline_summary, ' +
      'which is OPEN deals only.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        status: { type: 'string', enum: ['won', 'lost', 'abandoned'],
          description: 'Omit for all three.' },
        since: { type: 'string', description: 'ISO date/datetime. Only deals closed at or after this.' }
      }
    },
    run: getLostWonBreakdown
  },

  {
    name: 'get_rep_performance',
    description:
      'Per-owner rollup across every rep with at least one deal — open deal ' +
      'count and value, won count and value, lost count, in a time window. ' +
      'Use for "who\'s closing the most", "how is the team doing this month", ' +
      '"leaderboard". For one rep\'s own detail, filter search_deals by owner ' +
      'instead.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        since: { type: 'string', description: 'ISO date/datetime. Only counts deals updated/closed at or after this.' }
      }
    },
    run: getRepPerformance
  },

  {
    name: 'list_tags',
    description:
      'The tag catalogue for this account — every tag name that exists, and ' +
      'how many contacts and deals currently carry it. Use for "what tags do ' +
      'we have", "how many contacts are tagged VIP", "is there a tag for ...".',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: listTags
  },

  {
    name: 'get_qualification_gaps',
    description:
      'Which OPEN deals are missing qualification info (the meddic_1..10 ' +
      'headings — metrics, economic buyer, decision criteria, and so on) — ' +
      'and how many of the 10 each one has filled in. Use for "which deals ' +
      'need qualifying", "what\'s missing on the pipeline", "how well ' +
      'qualified are we".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        minMissing: { type: 'number',
          description: 'Only deals missing at least this many headings. Defaults to 1 (any gap).' }
      }
    },
    run: getQualificationGaps
  },

  {
    name: 'get_custom_field_options',
    description:
      'The allowed values for a custom picklist field (e.g. product_type, ' +
      'product_system, client_type, first_contact_method) — what options ' +
      'exist in this CRM and whether the field allows one answer or several. ' +
      'Use before answering "what product types do we sell" or "what are the ' +
      'possible client types" so the answer matches this account\'s own setup, ' +
      'not a guess.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['fieldKey'],
      properties: {
        fieldKey: { type: 'string',
          description: 'e.g. "opportunity.product_type" — get_deal_detail\'s output shows the field keys in use.' }
      }
    },
    run: getCustomFieldOptions
  },

  {
    name: 'get_deal_metrics',
    description:
      'Rich analytics for ONE deal: speed-to-lead (minutes from the ' +
      'customer\'s first message to our first reply, and to our first HUMAN ' +
      'reply), total pipeline age, message/inbound/outbound counts, whether ' +
      'the "three whys" (why they want it, why buy, why blocked) are filled ' +
      'in and whether that\'s still current for the deal\'s CURRENT stage, ' +
      'attribution coverage (% of this contact\'s messages actually linked to ' +
      'this deal), and open/overdue task counts. Use for "how fast did we ' +
      'reply to this lead", "is this deal\'s qualification stale", "how much ' +
      'of this contact\'s conversation is actually filed to this deal".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['dealId'],
      properties: { dealId: { type: 'string' } }
    },
    run: getDealMetrics
  },

  {
    name: 'get_sync_health',
    description:
      'When each background sync job last succeeded or failed, and whether ' +
      'any are overdue — the honest answer to "how up to date is this data". ' +
      'Stage/deal changes arrive live by webhook and are NOT covered by this ' +
      '(they are near-real-time regardless of these jobs); this is for the ' +
      'daily-cron-only data — tags, custom fields, pipelines, businesses. Use ' +
      'for "is this data current", "when did the sync last run", "why does ' +
      'this look stale".',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: getSyncHealth
  },

  {
    name: 'get_tag_history',
    description:
      'When a specific tag was applied to (and removed from, if it was) a ' +
      'contact or deal — the full timeline, not just whether it currently has ' +
      'it. Use for "when was this contact tagged VIP", "has this tag ever ' +
      'been removed from this deal", "how long has this tag been on there".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['entityType', 'entityId'],
      properties: {
        entityType: { type: 'string', enum: ['contact', 'deal'] },
        entityId: { type: 'string' },
        tag: { type: 'string', description: 'Optional: one tag name only, otherwise every tag ever applied.' }
      }
    },
    run: getTagHistory
  },

  {
    name: 'search_dnd_contacts',
    description:
      'Contacts who are do-not-disturb blocked on one or more channels — use ' +
      'BEFORE proposing to message someone, or for "who can\'t we contact", ' +
      '"how many contacts are opted out of SMS", "is this contact reachable ' +
      'at all". A contact can be blocked on some channels and reachable on ' +
      'others; this tells you which.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        channel: { type: 'string', enum: ['email', 'sms', 'call', 'whatsapp'],
          description: 'Omit to find contacts blocked on ANY channel.' },
        countOnly: { type: 'boolean',
          description: 'Return an EXACT total count instead of rows — no 50-row cap. '
            + 'Use this for "how many contacts are opted out of SMS" and similar count questions.' }
      }
    },
    run: searchDndContacts
  },

  {
    name: 'get_channel_breakdown',
    description:
      'Message volume by channel (email/SMS/call/WhatsApp/webchat/etc.) and ' +
      'direction, across the whole account in a time window — which channels ' +
      'are actually used and how much. Use for "what channels do our ' +
      'customers use", "how many calls this month vs emails", "is WhatsApp ' +
      'actually used here".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        since: { type: 'string', description: 'ISO date/datetime. Defaults to all time.' }
      }
    },
    run: getChannelBreakdown
  },

  {
    name: 'list_saved_views',
    description:
      'The saved filter views reps have created for the Deals or Contacts ' +
      'lists (e.g. "My open deals", "Stalled over 30 days") — what filters ' +
      'each one applies and whether it\'s shared with the team. Use for "what ' +
      'saved views exist", "is there a view for X already" before assuming ' +
      'one needs describing from scratch.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        scope: { type: 'string', enum: ['deals', 'contacts'], description: 'Defaults to deals.' }
      }
    },
    run: listSavedViews
  },

  {
    name: 'get_conversation_providers',
    description:
      'The senders available on this account, per channel — each channel\'s ' +
      'NATIVE sender plus any marketplace ones such as "WhatsApp QR", ' +
      '"SMS Android" or "iMessage", with each one\'s id and which is the ' +
      'default. A native sender has no id: send the channel type alone. CALL THIS BEFORE ASKING A REP WHICH CHANNEL TO ' +
      'USE: a channel can have several senders, and the answer decides ' +
      'whether there is a choice to offer at all. Use for "what number do ' +
      'we text from", "what channels are set up", and before any ' +
      'propose_send_message where the sender is not already known.',
    inputSchema: { type: 'object', additionalProperties: false, properties: {} },
    run: getConversationProviders
  }
];

/**
 * Write-PROPOSING tools. Each validates its arguments (same rule GHL itself
 * would apply — e.g. a contact needs a name, phone or email) and, if valid,
 * INSERTs a pending row into ai_actions and returns its id. Nothing here
 * calls GHL, imports ghlContactWrite.js, or touches any table other than
 * ai_actions — that separation is what toolRegistry.test.mjs's "every
 * PROPOSE tool only ever inserts into ai_actions" check verifies statically.
 *
 * If a required field is missing, `run` returns { needsInfo: [...] } instead
 * of throwing or inserting anything — the model reads that as "ask the rep
 * for these fields" and the conversation continues naturally, the same way
 * a rep filling in a form would hit a required-field error and keep typing.
 * This is the "ask for missing details conversationally" behavior without a
 * separate orchestration layer: the tool's own validation IS the prompt for
 * a follow-up turn.
 */
export const PROPOSE_TOOLS = [
  {
    name: 'propose_create_contact',
    description:
      'Propose creating a NEW contact. Does not create anything — inserts a ' +
      'pending proposal a rep must confirm. Needs at least a name, phone ' +
      'number or email; if the rep has not given you enough to be reachable, ' +
      'ask for one of those before calling this. Use for "add a contact for ' +
      '...", "create a contact called ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        opportunityId: { type: 'string',
          description: 'Optional: this deal, if the question was asked from one.' }
      }
    },
    run: proposeCreateContact
  },

  {
    name: 'propose_attach_contact',
    description:
      'Propose attaching an EXISTING contact to a deal. Does not attach ' +
      'anything — inserts a pending proposal a rep must confirm. Use ' +
      'search_contacts first to find the contact\'s id if you only have a ' +
      'name. Use for "attach this contact to the deal", "add ... to this deal".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId', 'contactId'],
      properties: {
        opportunityId: { type: 'string' },
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' }
      }
    },
    run: proposeAttachContact
  },

  {
    name: 'propose_remove_contact',
    description:
      'Propose detaching a contact from a deal (the inverse of ' +
      'propose_attach_contact). Does not remove anything — inserts a ' +
      'pending proposal a rep must confirm. Use for "remove this contact ' +
      'from the deal", "detach ... from this deal".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId', 'contactId'],
      properties: {
        opportunityId: { type: 'string' },
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' }
      }
    },
    run: proposeRemoveContact
  },

  {
    name: 'propose_create_deal',
    description:
      'Propose creating a NEW deal for an existing contact. Does not ' +
      'create anything — inserts a pending proposal a rep must confirm. ' +
      'Needs a contact, a name and a pipeline; use get_pipeline_summary ' +
      'first to see the pipeline (and stage) names available. Value and ' +
      'stage are optional — the pipeline\'s first stage is used if no stage ' +
      'is given. Use search_contacts first if you only have a name. Use ' +
      'for "create a deal for ...", "open a new opportunity for ... worth ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contactId', 'name', 'pipelineName'],
      properties: {
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' },
        name: { type: 'string', description: 'The deal\'s name/title.' },
        value: { type: 'number', description: 'Monetary value, if given.' },
        pipelineName: { type: 'string', description: 'Which pipeline to create it in.' },
        stageName: { type: 'string',
          description: 'Which stage to open it in — leave unset for the pipeline\'s first stage.' }
      }
    },
    run: proposeCreateDeal
  },

  {
    name: 'propose_update_deal',
    description:
      'Propose editing ANY field on a deal: its name, value, stage (name the ' +
      'stage, e.g. "Quote Sent" — not an id), pipeline, expected close date, ' +
      'and every CUSTOM field the account has defined on opportunities — ' +
      'product type, product system, client/buyer type, lead source ("how ' +
      'they found us"), first contact method, initial enquiry, postcode, and ' +
      'any other. Custom fields go in `fields` by their LABEL or key as the ' +
      'deal context lists them; the server resolves the label to the GHL ' +
      'field and checks picklist values, so pass what the rep said. Does ' +
      'not change anything — inserts a pending proposal a rep must confirm. ' +
      'Only include what is actually changing. NOT for status (use ' +
      'propose_change_status) or owner (use propose_change_owner). Use for ' +
      '"rename this deal to ...", "change the value to ...", "move this to ' +
      'the ... stage", "set the product type to bifolds", "buyer type is ' +
      'homeowner", "lead source is website", "update the enquiry to ...", ' +
      '"clear the postcode". Never tell a rep a deal field cannot be ' +
      'updated — propose it and let the server say if the field is unknown.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId'],
      properties: {
        opportunityId: { type: 'string' },
        dealName: { type: 'string',
          description: 'The deal\'s CURRENT name, for the confirmation card.' },
        name: { type: 'string', description: 'New name, if changing.' },
        value: { type: 'number', description: 'New monetary value, if changing.' },
        stageName: { type: 'string',
          description: 'New stage, by its display name, if changing. Within ' +
            'the deal\'s current pipeline unless pipelineName is also given.' },
        pipelineName: { type: 'string',
          description: 'Move the deal to a DIFFERENT pipeline, by name. Give ' +
            'stageName for the stage in that pipeline, or it lands in its first stage.' },
        closeDate: { type: 'string',
          description: 'New expected close date, YYYY-MM-DD, if changing.' },
        fields: {
          type: 'array',
          description: 'Custom field changes. One entry per field the rep ' +
            'wants changed, named by the label or key the deal context shows ' +
            '("Product Type", "client_type", "How they found us"). Value is ' +
            'what the rep said — a picklist choice, text, a number, a list ' +
            'for multi-select — or null / "clear" to empty the field.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['field', 'value'],
            properties: {
              field: { type: 'string', description: 'The field\'s label or key.' },
              value: {
                description: 'The new value, or null to clear.',
                anyOf: [
                  { type: 'string' },
                  { type: 'number' },
                  { type: 'array', items: { type: 'string' } },
                  { type: 'null' }
                ]
              }
            }
          }
        }
      }
    },
    run: proposeUpdateDeal
  },

  {
    name: 'propose_change_owner',
    description:
      'Propose reassigning a deal to a different owner. Does not change ' +
      'anything — inserts a pending proposal a rep must confirm. Use for ' +
      '"change the owner to ...", "reassign this deal to ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId', 'ownerUserId'],
      properties: {
        opportunityId: { type: 'string' },
        ownerUserId: { type: 'string', description: 'GHL user id of the new owner.' },
        ownerName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' }
      }
    },
    run: proposeChangeOwner
  },

  {
    name: 'propose_change_status',
    description:
      'Propose changing a deal\'s status (open / won / lost / abandoned). ' +
      'Does not change anything — inserts a pending proposal a rep must ' +
      'confirm. Moving to "lost" needs a reason — ask for one if the rep has ' +
      'not given it. Use for "mark this deal as won", "close this as lost ' +
      'because ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId', 'status'],
      properties: {
        opportunityId: { type: 'string' },
        status: { type: 'string', enum: ['open', 'won', 'lost', 'abandoned'] },
        lostReasonId: { type: 'string',
          description: 'Required when status is lost. Ask the rep for a reason first.' }
      }
    },
    run: proposeChangeStatus
  },

  {
    name: 'propose_send_message',
    description:
      'Propose sending an SMS, WhatsApp message or email to a contact. Does ' +
      'not send anything — inserts a pending proposal a rep must confirm, ' +
      'editable before it goes out. An email needs a subject and content; ' +
      'SMS and WhatsApp only need the message text. Use for "send an email ' +
      'to ... about ...", "text ... saying ...", "WhatsApp ... about ...", ' +
      '"reply to them with ...". When asked from a deal, pass that deal as ' +
      'opportunityId and message only someone linked to it — call ' +
      'get_deal_contacts first if you are not certain who is on the deal.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contactId', 'type'],
      properties: {
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' },
        type: { type: 'string', enum: ['SMS', 'Email', 'WhatsApp'] },
        subject: { type: 'string', description: 'Email only. For a reply, omit it ' +
          'or write "Re: <original subject>" — the server fills it from the ' +
          'original when omitted.' },
        replyToMessageId: { type: 'string',
          description: 'Email only. The id of the email in this deal\'s thread ' +
            'being REPLIED to — the <message id="…"> from the thread above. Pass ' +
            'it whenever the rep says "reply to", "respond to", or names an ' +
            'email by its subject ("reply to the quote email"): find that email ' +
            'in the thread and pass its id. The reply then lands in the same ' +
            'email conversation on the customer\'s side instead of starting a ' +
            'new one. Omit for a fresh email.' },
        emailReplyMode: { type: 'string', enum: ['reply', 'reply_all'],
          description: 'With replyToMessageId only. "reply_all" when the rep ' +
            'asks for everyone on the original to be included; otherwise omit.' },
        message: { type: 'string',
          description: 'SMS/WhatsApp body, or the email content when html is not given.' },
        html: { type: 'string', description: 'Email content, if richer than plain text.' },
        // Was MISSING while proposeSendMessage already read it — and the
        // schema is additionalProperties:false, so the model could not send it
        // even when it wanted to. Every proposal therefore filed against no
        // deal, and the deal-scoping check below could never fire.
        opportunityId: { type: 'string',
          description: 'The deal this was asked from, if any. Required to send ' +
            'to one of the deal\'s people: the recipient is checked against the ' +
            'deal, and a contact who is not on it is refused.' },
        conversationProviderId: { type: 'string',
          description: 'Which sender carries this message. A channel can have ' +
            'several — the native one, plus marketplace senders like "WhatsApp QR", ' +
            '"SMS Android" or "iMessage". REQUIRED whenever the sender is a named ' +
            'marketplace one — the one the rep chose, or ' +
            'the one the deal\'s existing thread already uses: pass that ' +
            'sender\'s conversationProviderId from get_conversation_providers. Saying ' +
            '"WhatsApp QR" in your reply while omitting the id here sends through ' +
            'the NATIVE channel — the card shows native, and the rep was told QR. ' +
            'Omit it only for the native sender. Keep `type` as the real channel ' +
            '(SMS, WhatsApp, Email) either way — the send path rewrites it for a ' +
            'custom sender.' },
        senderName: { type: 'string',
          description: 'The chosen sender\'s NAME as get_conversation_providers ' +
            'lists it — "WhatsApp QR", "SMS Android". Always pass it alongside ' +
            'conversationProviderId; if the id is missing the server resolves the ' +
            'name to it, so a dropped id does not silently become a native send.' },
        to: { type: 'array', items: { type: 'string' },
          description: 'Email only. FURTHER people addressed in To, as contact ' +
            'ids, besides contactId (who stays first). "Email everyone on the ' +
            'deal" / "send it to both of them" is the primary as contactId and ' +
            'every other person on the deal here. The rep can add or remove ' +
            'people on the card.' },
        cc: { type: 'array', items: { type: 'string' },
          description: 'Email only. People copied in — contact ids (from the ' +
            'deal\'s people or search_contacts) or plain email addresses. ' +
            '"Copy in Priya" / "cc the architect" is cc.' },
        bcc: { type: 'array', items: { type: 'string' },
          description: 'Email only. Blind copies — contact ids or email ' +
            'addresses — only when the rep says "bcc".' }
      }
    },
    run: proposeSendMessage
  },

  {
    name: 'propose_create_task',
    description:
      'Propose creating a NEW task for a contact. Does not create anything ' +
      '— inserts a pending proposal a rep must confirm. Needs a contact and ' +
      'a title; a due date is optional. Use for "create a task to ...", ' +
      '"remind me to ...", "follow up with ... about ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contactId', 'title'],
      properties: {
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' },
        title: { type: 'string' },
        body: { type: 'string' },
        dueDate: { type: 'string', description: 'ISO date/time, if the rep gave one.' },
        opportunityId: { type: 'string',
          description: 'Optional: this deal, if the question was asked from one — ' +
            'lets a rep confirm the task lands on the right deal instead of relying ' +
            'purely on the contact-based attribution guess.' }
      }
    },
    run: proposeCreateTask
  },

  {
    name: 'propose_complete_task',
    description:
      'Propose marking an existing task done (or reopening it). Does not ' +
      'change anything — inserts a pending proposal a rep must confirm. Use ' +
      'search_tasks or get_deal_tasks_and_notes first to find the taskId if ' +
      'you only have a description of the task. Use for "mark that task ' +
      'done", "complete the follow-up task", "reopen that task".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        taskTitle: { type: 'string',
          description: 'For the confirmation card, so a rep sees what task this is.' },
        completed: { type: 'boolean', description: 'true = mark done, false = reopen. Defaults to true.' }
      }
    },
    run: proposeCompleteTask
  },

  {
    name: 'propose_update_task',
    description:
      'Propose editing an existing task\'s title, details or due date. Does ' +
      'not change anything — inserts a pending proposal a rep must confirm. ' +
      'Use search_tasks or get_deal_tasks_and_notes first to find the taskId. ' +
      'Only include the fields that are actually changing. Use for "change ' +
      'that task\'s due date to ...", "update the task title to ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        taskTitle: { type: 'string',
          description: 'The task\'s CURRENT title, for the confirmation card — not the new one.' },
        title: { type: 'string', description: 'New title, if changing.' },
        body: { type: 'string', description: 'New details, if changing.' },
        dueDate: { type: 'string', description: 'New due date (ISO), if changing.' }
      }
    },
    run: proposeUpdateTask
  },

  {
    name: 'propose_delete_task',
    description:
      'Propose deleting a task. Does not delete anything — inserts a ' +
      'pending proposal a rep must confirm. Use search_tasks or ' +
      'get_deal_tasks_and_notes first to find the taskId. Use for "delete ' +
      'that task", "remove the follow-up task".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['taskId'],
      properties: {
        taskId: { type: 'string' },
        taskTitle: { type: 'string',
          description: 'For the confirmation card, so a rep sees what task this is.' }
      }
    },
    run: proposeDeleteTask
  },

  {
    name: 'propose_create_note',
    description:
      'Propose adding a NEW note to a contact. Does not create anything — ' +
      'inserts a pending proposal a rep must confirm. Use for "add a note ' +
      'saying ...", "note that ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contactId', 'body'],
      properties: {
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' },
        body: { type: 'string' },
        pinned: { type: 'boolean', description: 'Pin the note. A contact can have at most 2 pinned.' },
        opportunityId: { type: 'string',
          description: 'Optional: this deal, if the question was asked from one.' }
      }
    },
    run: proposeCreateNote
  },

  {
    name: 'propose_update_note',
    description:
      'Propose editing an existing note\'s text or pinned state. Does not ' +
      'change anything — inserts a pending proposal a rep must confirm. Use ' +
      'get_deal_tasks_and_notes or search_notes first to find the noteId. ' +
      'Use for "update that note to say ...", "pin that note", "unpin that note".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['noteId'],
      properties: {
        noteId: { type: 'string' },
        body: { type: 'string', description: 'New text, if changing.' },
        pinned: { type: 'boolean', description: 'New pinned state, if changing.' }
      }
    },
    run: proposeUpdateNote
  },

  {
    name: 'propose_delete_note',
    description:
      'Propose deleting a note. Does not delete anything — inserts a ' +
      'pending proposal a rep must confirm. Use get_deal_tasks_and_notes or ' +
      'search_notes first to find the noteId. Use for "delete that note", ' +
      '"remove the note about ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['noteId'],
      properties: {
        noteId: { type: 'string' }
      }
    },
    run: proposeDeleteNote
  },

  {
    name: 'propose_add_tags',
    description:
      'Propose adding one or more tags to a contact. Additive only — cannot ' +
      'remove any existing tag. Does not change anything — inserts a ' +
      'pending proposal a rep must confirm. Use for "tag them as ...", "add ' +
      'the ... tag".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contactId', 'tags'],
      properties: {
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to add.' }
      }
    },
    run: proposeAddTags
  },

  {
    name: 'propose_remove_tags',
    description:
      'Propose removing one or more tags from a contact. Only removes tags ' +
      'the contact already has. Does not change anything — inserts a ' +
      'pending proposal a rep must confirm. Use for "remove the ... tag", ' +
      '"untag them from ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contactId', 'tags'],
      properties: {
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' },
        tags: { type: 'array', items: { type: 'string' }, description: 'Tags to remove.' }
      }
    },
    run: proposeRemoveTags
  },

  {
    name: 'propose_update_contact',
    description:
      'Propose editing a contact\'s own details — name, email, phone, ' +
      'address, company, timezone or lead source. Does not change anything ' +
      '— inserts a pending proposal a rep must confirm, editable before it ' +
      'saves. Only include the fields that are actually changing. Not for ' +
      'tags (use propose_add_tags/propose_remove_tags) or deal ownership ' +
      '(use propose_change_owner). Use for "update their email to ...", ' +
      '"fix their phone number to ...", "change their address to ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['contactId'],
      properties: {
        contactId: { type: 'string' },
        contactName: { type: 'string',
          description: 'The contact\'s CURRENT name, for the confirmation card.' },
        firstName: { type: 'string' },
        lastName: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' },
        companyName: { type: 'string' }
      }
    },
    run: proposeUpdateContact
  },

  {
    name: 'propose_delete_deal',
    description:
      'Propose permanently deleting a deal. This cannot be undone — GHL has ' +
      'no restore for a deleted opportunity. Does not delete anything — ' +
      'inserts a pending proposal a rep must confirm. Use for "delete this ' +
      'deal", "remove this opportunity entirely" — NOT for "mark it lost" ' +
      'or "close it", which are propose_change_status instead.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId'],
      properties: {
        opportunityId: { type: 'string' },
        dealName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' }
      }
    },
    run: proposeDeleteDeal
  },

  {
    name: 'propose_create_business',
    description:
      'Propose creating a NEW business/company record. Does not create ' +
      'anything — inserts a pending proposal a rep must confirm. Needs at ' +
      'least a name. Use for "add a business called ...", "create a ' +
      'company record for ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['name'],
      properties: {
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        website: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' }
      }
    },
    run: proposeCreateBusiness
  },

  {
    name: 'propose_update_business',
    description:
      'Propose editing an existing business\'s details. Does not change ' +
      'anything — inserts a pending proposal a rep must confirm. Only ' +
      'include the fields that are actually changing. Use for "update that ' +
      'business\'s phone to ...", "change their website to ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['businessId'],
      properties: {
        businessId: { type: 'string' },
        businessName: { type: 'string',
          description: 'The business\'s CURRENT name, for the confirmation card.' },
        name: { type: 'string' },
        email: { type: 'string' },
        phone: { type: 'string' },
        website: { type: 'string' },
        address: { type: 'string' },
        city: { type: 'string' }
      }
    },
    run: proposeUpdateBusiness
  },

  {
    name: 'propose_delete_business',
    description:
      'Propose deleting a business/company record. Does not delete anything ' +
      '— inserts a pending proposal a rep must confirm. Use for "delete ' +
      'that business", "remove the company record for ...".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['businessId'],
      properties: {
        businessId: { type: 'string' },
        businessName: { type: 'string',
          description: 'For the confirmation card, so a rep sees a name, not an id.' }
      }
    },
    run: proposeDeleteBusiness
  },

  {
    name: 'propose_add_followers',
    description:
      'Propose adding one or more team members as followers on a deal. ' +
      'Additive only. Does not change anything — inserts a pending ' +
      'proposal a rep must confirm. Use for "add ... as a follower on this ' +
      'deal", "cc ... on this deal".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId', 'followerUserIds'],
      properties: {
        opportunityId: { type: 'string' },
        followerUserIds: { type: 'array', items: { type: 'string' },
          description: 'GHL user ids to add as followers.' },
        followerNames: { type: 'string',
          description: 'Names, comma-separated, for the confirmation card.' }
      }
    },
    run: proposeAddFollowers
  },

  {
    name: 'propose_remove_followers',
    description:
      'Propose removing one or more followers from a deal. Removes only ' +
      'the ids given, never everyone at once. Does not change anything — ' +
      'inserts a pending proposal a rep must confirm. Use for "remove ... ' +
      'as a follower", "take ... off this deal\'s followers".',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['opportunityId', 'followerUserIds'],
      properties: {
        opportunityId: { type: 'string' },
        followerUserIds: { type: 'array', items: { type: 'string' },
          description: 'GHL user ids to remove as followers.' },
        followerNames: { type: 'string',
          description: 'Names, comma-separated, for the confirmation card.' }
      }
    },
    run: proposeRemoveFollowers
  }
];

const ALL_TOOLS = [...LOOKUP_TOOLS, ...PROPOSE_TOOLS];

/** Model-facing catalogue. `run` is ours and never leaves the process. */
// Tools that only make sense ACROSS the account, never inside one deal.
//
// Deal AI answers about ONE deal — its messages, contacts, tasks and notes.
// Offering it search_deals or get_rep_performance invites exactly the answer
// a deal surface must not give: a claim about the account dressed up as a
// claim about this deal. The per-deal equivalents (get_deal_messages,
// get_deal_tasks_and_notes, get_deal_contacts) cover the same ground inside
// the boundary, and several of these tools say so in their own description
// already — "across the WHOLE account (not one deal)". This enforces what
// that sentence promises.
//
// propose_create_deal and the business writes are here for the same reason:
// creating a SECOND deal from inside one deal's chat is not a deal-scoped
// action, and a rep who meant to do that has the portfolio surface for it.
const ACCOUNT_ONLY_TOOLS = new Set([
  'search_deals', 'search_contacts', 'get_pipeline_summary', 'get_account_info',
  'search_businesses', 'search_tasks', 'search_notes', 'search_messages',
  'get_lost_won_breakdown', 'get_rep_performance', 'list_tags',
  'get_qualification_gaps', 'get_sync_health', 'get_tag_history',
  'search_dnd_contacts', 'get_channel_breakdown', 'list_saved_views',
  'propose_create_deal',
  'propose_create_business', 'propose_update_business', 'propose_delete_business'
]);

/**
 * The tools a surface may use.
 *
 * @param {'portfolio'|'deal'} surface
 */
// NO SENDING FROM THE DEAL HUB CO-PILOT. Messages to a customer — email, SMS,
// WhatsApp, replies — are sent from the composer at the foot of the deal's
// timeline, where the rep writes and sends them directly (POST
// /api/deals/:id/messages). Co-Pilot on a deal declines and points there.
// Insights AI (the portfolio surface) keeps propose_send_message.
export const DEAL_HUB_NO_SEND_TOOLS = new Set(['propose_send_message']);

// What Co-Pilot says instead, word for word — shared by the tool guard, the
// answer prompt and the action detector so the rep always reads the same
// thing. "Above": Co-Pilot sits below the timeline on the Deal Hub.
export const COMPOSER_POINTER =
  "I can't send messages from Co-Pilot. To send an email, SMS or WhatsApp, use the " +
  'message box at the bottom of the Timeline above — and to reply to an email, ' +
  'press Reply on that email in the Timeline.';

export function toolCatalogue(surface = 'portfolio') {
  const allowed = surface === 'deal'
    ? ALL_TOOLS.filter((t) => !ACCOUNT_ONLY_TOOLS.has(t.name) && !DEAL_HUB_NO_SEND_TOOLS.has(t.name))
    : ALL_TOOLS;
  return allowed.map(({ name, description, inputSchema }) => ({
    name, description, inputSchema
  }));
}

// Exported for the deal surface's own guard and for tests — the list is the
// security boundary, so it must be assertable rather than implied.
export { ACCOUNT_ONLY_TOOLS };

/**
 * Execute one tool call.
 *
 * Never throws at the model: a failure comes back as { error } so the turn can
 * say "that lookup failed" rather than collapsing the whole answer. A
 * hallucinated tool name is the model's mistake to recover from, not a 500.
 */
// Arguments that name a deal. On the deal surface every one of these is
// OVERWRITTEN with the deal in scope — never merely defaulted.
//
// Defaulting would leave the model able to pass a different id and read or
// write another deal from inside this one's chat. The surface filter above
// removes the cross-account tools; this closes the remaining hole, which is
// a deal-scoped tool pointed at the wrong deal. The two together are the
// boundary, and this is the half that cannot be reasoned around.
const DEAL_ID_ARGS = ['dealId', 'opportunityId'];

/**
 * Execute one tool call.
 *
 * @param {string} locationId
 * @param {string} name
 * @param {object} args
 * @param {{ surface?: string, dealId?: string|null }} [scope]
 *   On the deal surface, dealId is forced onto every deal-scoped argument.
 */
export async function runTool(locationId, name, args = {}, scope = {}) {
  const tool = ALL_TOOLS.find((t) => t.name === name);
  if (!tool) return { error: `No such tool: ${name}` };

  let input = args || {};

  if (scope.surface === 'deal') {
    // Belt and braces with toolCatalogue('deal'): the catalogue decides what
    // is OFFERED, this decides what can RUN. A tool reaching here that the
    // catalogue would not have offered is a bug, and failing closed is the
    // only safe response to one.
    if (ACCOUNT_ONLY_TOOLS.has(name)) {
      return { error: `${name} is not available when asking about a single deal.` };
    }
    // Sending is the composer's job on a deal — see DEAL_HUB_NO_SEND_TOOLS.
    if (DEAL_HUB_NO_SEND_TOOLS.has(name)) {
      return { error: COMPOSER_POINTER };
    }
    if (scope.dealId) {
      const forced = {};
      for (const k of DEAL_ID_ARGS) {
        if (k in (tool.inputSchema?.properties || {})) forced[k] = scope.dealId;
      }
      input = { ...input, ...forced };
    }
  }

  try {
    // `scope` reaches the tool: get_conversation_providers needs the asking
    // user's id to list their own two-way-sync mailbox as a sender.
    return await tool.run(locationId, input, scope);
  } catch (err) {
    const kind = errorKind(err);
    // The model no longer sees err.message, so this is now the ONLY place the
    // real fault is recorded. A 'schema' kind is always our bug and is logged
    // at error; the rest are expected operational failures.
    logger[kind === 'schema' ? 'error' : 'warn'](
      { locationId, tool: name, args: input, kind, code: err?.code, err: err?.message },
      'ai tool failed'
    );
    return { error: toolErrorForModel(name, err), errorKind: kind };
  }
}

// What a failed tool tells the MODEL.
//
// This used to be `${name} failed: ${err.message}`, which handed Postgres's own
// words straight to the model — "new row for relation \"ai_actions\" violates
// check constraint \"ai_actions_action_type_check\"". The model did the
// sensible thing with that: called it a database constraint issue and told the
// rep to contact whoever administers the CRM. Accurate, useless to a sales rep,
// and it surfaced our schema in a customer-facing chat.
//
// Two audiences, two needs. The model needs to know whether retrying or
// rephrasing could possibly help; the rep needs a sentence that isn't about our
// database. So the model gets a plain-language cause plus an explicit verdict
// on retrying, and the raw error goes to the logs where an engineer will see it.
//
// Deliberately NOT sanitised into uselessness: "that action type isn't enabled
// on this account yet" lets the model say something true and specific. Telling
// it only "an error occurred" would make it guess, and a guessing model invents
// workarounds that do not exist.
function errorKind(err) {
  const code = err?.code;
  // Postgres class 23 — integrity constraint violation. A bug in our schema or
  // our data, never something the rep or the model phrased wrongly.
  if (typeof code === 'string' && code.startsWith('23')) return 'schema';
  if (code === '42P01' || code === '42703') return 'schema';   // missing table/column
  if (code === '57014') return 'timeout';                       // statement cancelled
  if (err?.status === 403 || err?.status === 401) return 'permission';
  if (err?.status >= 400 && err?.status < 500) return 'input';
  return 'unknown';
}

function toolErrorForModel(name, err) {
  switch (errorKind(err)) {
    case 'schema':
      // The create_task case. There is no rephrasing that fixes it, and the
      // model must not invent one.
      return `${name} could not be recorded: this action is not enabled on this account yet. `
           + 'This is a setup gap on our side, not a problem with the request. '
           + 'Do not retry it and do not try a different wording — say plainly that '
           + 'the action is unavailable and suggest doing it directly in the CRM.';
    case 'permission':
      return `${name} was refused: this app does not have permission for that in the CRM. `
           + 'Retrying will not help. Tell the rep the app needs reauthorising.';
    case 'timeout':
      return `${name} took too long and was cancelled. A narrower request (a shorter `
           + 'date range, fewer records) may succeed.';
    case 'input':
      // The one kind the model can genuinely fix, so it gets the real detail.
      return `${name} was rejected: ${err.message}`;
    default:
      return `${name} failed unexpectedly. Do not retry more than once; if it fails `
           + 'again, tell the rep the lookup is unavailable right now.';
  }
}

// ── implementations ──────────────────────────────────────────────────

async function searchDeals(locationId, a) {
  const where = ['o.location_id = $1', 'o.is_deleted = false',
                 'o.deleted_at IS NULL', 'o.is_ghost = false'];
  const params = [locationId];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('$n', `$${params.length}`));
  };

  add('o.status = $n', a.status || 'open');
  if (a.stage) add('o.current_stage_name ILIKE $n', `%${a.stage}%`);
  if (a.owner) add('o.assigned_to_name ILIKE $n', `%${a.owner}%`);
  if (a.tag) add('$n = ANY(o.tags)', a.tag);
  if (a.minValue != null) add('o.monetary_value >= $n', a.minValue);
  if (a.maxValue != null) add('o.monetary_value <= $n', a.maxValue);
  if (a.createdAfter) add('o.created_at_ghl >= $n', a.createdAfter);
  if (a.createdBefore) add('o.created_at_ghl < $n', a.createdBefore);
  if (a.updatedAfter) add('o.updated_at_ghl >= $n', a.updatedAfter);
  if (a.updatedBefore) add('o.updated_at_ghl < $n', a.updatedBefore);

  // Stalled and quiet are the two questions a manager actually asks, so they
  // are filters rather than arithmetic the model has to do over raw dates.
  if (a.stalledDays != null) {
    add(`(SELECT EXTRACT(DAY FROM now() - sh.entered_at)
            FROM stage_history sh
           WHERE sh.location_id = o.location_id
             AND sh.opportunity_id = o.opportunity_id
             AND sh.current_stage = true LIMIT 1) >= $n`, a.stalledDays);
  }
  if (a.quietDays != null) {
    // -infinity for "never replied": a contact who has NEVER sent anything is
    // the quietest case there is, and COALESCE to NULL would drop them.
    add(`COALESCE((SELECT max(m.message_timestamp)
                     FROM messages m
                     JOIN message_opportunity_map mom
                       ON mom.location_id = m.location_id
                      AND mom.message_id = m.message_id
                      AND mom.superseded_at IS NULL
                    WHERE mom.opportunity_id = o.opportunity_id
                      AND m.message_direction = 'inbound'
                      AND m.deleted_at IS NULL),
                  '-infinity'::timestamptz) < now() - ($n || ' days')::interval`,
        String(a.quietDays));
  }

  return withTenant(locationId, async (c) => {
    // countOnly: a plain COUNT(*) against the same WHERE, no LIMIT — the
    // exact answer to "how many", which the row-fetching path below cannot
    // give once the true total exceeds MAX_ROWS. Kept as a separate query
    // rather than always running both: a count is cheap on its own, but
    // pointless work if the caller only wanted a number.
    if (a.countOnly === true) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total FROM opportunities o WHERE ${where.join(' AND ')}`,
        params
      );
      return { totalCount: rows[0].total };
    }
    const { rows } = await c.query(
      `SELECT o.opportunity_id AS id, o.name, o.status,
              o.pipeline_name AS pipeline, o.current_stage_name AS stage,
              o.monetary_value AS value, o.assigned_to_name AS owner,
              o.tags,
              ${contactLabelSql('ct')} AS contact,
              ${otherContactsSql('o')} AS other_contacts,
              (SELECT EXTRACT(DAY FROM now() - sh.entered_at)::int
                 FROM stage_history sh
                WHERE sh.location_id = o.location_id
                  AND sh.opportunity_id = o.opportunity_id
                  AND sh.current_stage = true LIMIT 1) AS days_in_stage,
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
         LEFT JOIN contacts ct
           ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY o.updated_at_ghl DESC NULLS LAST
        LIMIT ${MAX_ROWS}`,
      params
    );
    return { deals: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function getDealMessages(locationId, a) {
  const limit = Math.min(Number(a.limit) || 40, MAX_ROWS);
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT m.message_id AS id, m.message_channel AS channel,
              m.message_direction AS direction, m.sender_name AS sender,
              m.subject, m.message_body AS body, m.message_timestamp AS at,
              ct.transcript_text AS transcript
         FROM messages m
         JOIN message_opportunity_map mom
           ON mom.location_id = m.location_id
          AND mom.message_id = m.message_id
          AND mom.superseded_at IS NULL
         LEFT JOIN call_transcriptions ct
           ON ct.location_id = m.location_id AND ct.message_id = m.message_id
        WHERE m.location_id = $1
          AND mom.opportunity_id = $2
          AND m.deleted_at IS NULL
        ORDER BY m.message_timestamp ASC
        LIMIT ${limit}`,
      [locationId, a.dealId]
    );
    // Oldest first: chronology is meaning, and a later statement supersedes an
    // earlier one. Reversing this silently inverts every "they changed their
    // mind" answer.
    return { messages: rows, count: rows.length };
  });
}

async function searchContacts(locationId, a) {
  const where = ['c.location_id = $1', 'c.deleted_at IS NULL'];
  const params = [locationId];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('$n', `$${params.length}`));
  };

  if (a.query) {
    params.push(`%${a.query}%`);
    const i = params.length;
    where.push(`(c.first_name ILIKE $${i} OR c.last_name ILIKE $${i}
                 OR c.email ILIKE $${i} OR c.phone ILIKE $${i}
                 OR c.company_name ILIKE $${i})`);
  }
  if (a.tag) add('$n = ANY(c.tags)', a.tag);
  if (a.owner) add('c.assigned_to_name ILIKE $n', `%${a.owner}%`);
  if (a.contactType) add('lower(c.contact_type) = lower($n)', a.contactType);
  if (a.unassigned === true) where.push('c.assigned_to IS NULL');
  if (a.createdAfter) add('c.created_at_ghl >= $n', a.createdAfter);
  if (a.createdBefore) add('c.created_at_ghl < $n', a.createdBefore);
  if (a.updatedAfter) add('c.updated_at_ghl >= $n', a.updatedAfter);
  if (a.updatedBefore) add('c.updated_at_ghl < $n', a.updatedBefore);

  return withTenant(locationId, async (c) => {
    // See searchDeals's identical branch for why this exists — an exact
    // "how many" answer needs a real COUNT(*), not a row fetch capped at
    // MAX_ROWS.
    if (a.countOnly === true) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total FROM contacts c WHERE ${where.join(' AND ')}`,
        params
      );
      return { totalCount: rows[0].total };
    }
    const { rows } = await c.query(
      `SELECT c.contact_id AS id,
              ${contactLabelSql('c')} AS name,
              c.email, c.phone, c.company_name AS business,
              -- Which channels this contact can actually be reached on.
              -- Returning raw email/phone left the model to infer it, and it
              -- inferred wrongly: a contact WITH an email was offered only
              -- SMS senders. SMS and WhatsApp both ride the phone; DND
              -- removes a channel here rather than being a separate caveat,
              -- so an offer can never include one the contact opted out of.
              -- COALESCE on every dnd flag: they are GENERATED columns and a
              -- contact synced before migration 052, or with no dnd payload,
              -- has NULL. NOT NULL is itself NULL, not true, so the CASE would
              -- fall through and silently drop a channel the contact can
              -- actually receive on — the same class of bug as the missing
              -- email here, arriving by a different route.
              array_remove(ARRAY[
                CASE WHEN c.phone IS NOT NULL
                      AND NOT COALESCE(c.dnd, false)
                      AND NOT COALESCE(c.dnd_sms, false)      THEN 'SMS' END,
                CASE WHEN c.phone IS NOT NULL
                      AND NOT COALESCE(c.dnd, false)
                      AND NOT COALESCE(c.dnd_whatsapp, false) THEN 'WhatsApp' END,
                CASE WHEN c.email IS NOT NULL
                      AND NOT COALESCE(c.dnd, false)
                      AND NOT COALESCE(c.dnd_email, false)    THEN 'Email' END
              ], NULL) AS can_receive,
              c.contact_type AS type, c.assigned_to_name AS owner, c.tags,
              (SELECT count(*)::int FROM opportunities o
                WHERE o.location_id = c.location_id
                  AND o.contact_id = c.contact_id
                  AND o.status = 'open' AND o.is_deleted = false
                  AND o.deleted_at IS NULL AND o.is_ghost = false) AS open_deals
         FROM contacts c
        WHERE ${where.join(' AND ')}
        ORDER BY c.updated_at_ghl DESC NULLS LAST
        LIMIT ${MAX_ROWS}`,
      params
    );
    return { contacts: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function getDealHistory(locationId, a) {
  const params = [locationId, a.dealId];
  let fieldClause = '';
  if (a.field) {
    params.push(a.field);
    fieldClause = `AND field_key = $${params.length}`;
  }
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT field_key, old_value, new_value, changed_at, detected_via
         FROM opportunity_field_history
        WHERE location_id = $1 AND opportunity_id = $2 ${fieldClause}
        ORDER BY changed_at DESC
        LIMIT ${MAX_ROWS}`,
      params
    );
    return { changes: rows, count: rows.length };
  });
}

async function getPipelineSummary(locationId, a) {
  const params = [locationId];
  let pipeClause = '';
  if (a.pipeline) {
    params.push(`%${a.pipeline}%`);
    pipeClause = `AND p.name ILIKE $${params.length}`;
  }
  return withTenant(locationId, async (c) => {
    // Joined to pipeline_stages for POSITION. Without it the model sees stage
    // names with no order and cannot tell that Quote Sent is further along
    // than New Lead — which underpins most "how far along" questions.
    const { rows } = await c.query(
      `SELECT p.name AS pipeline, ps.name AS stage, ps.position,
              count(o.opportunity_id)::int AS deals,
              COALESCE(sum(o.monetary_value), 0)::float AS value
         FROM pipeline_stages ps
         JOIN pipelines p
           ON p.location_id = ps.location_id AND p.pipeline_id = ps.pipeline_id
         LEFT JOIN opportunities o
           ON o.location_id = ps.location_id
          AND o.current_stage_id = ps.stage_id
          AND o.status = 'open' AND o.is_deleted = false
          AND o.deleted_at IS NULL AND o.is_ghost = false
        WHERE ps.location_id = $1 ${pipeClause}
        GROUP BY p.name, ps.name, ps.position
        ORDER BY p.name, ps.position`,
      params
    );
    return { stages: rows, count: rows.length };
  });
}

async function getDealTasksAndNotes(locationId, a) {
  return withTenant(locationId, async (c) => {
    // due_at, not due_date; author_name, not created_by_name. Both verified
    // against the live schema rather than assumed.
    const tasks = await c.query(
      `SELECT task_id AS id, title, body, due_at, completed_at,
              assigned_to_name AS owner
         FROM tasks
        WHERE location_id = $1 AND opportunity_id = $2 AND deleted_at IS NULL
        ORDER BY completed_at NULLS FIRST, due_at
        LIMIT ${MAX_ROWS}`,
      [locationId, a.dealId]
    );
    const notes = await c.query(
      `SELECT note_id AS id, title, body, created_at_ghl AS at,
              author_name AS author
         FROM notes
        WHERE location_id = $1 AND opportunity_id = $2 AND status = 'active'
        ORDER BY created_at_ghl DESC
        LIMIT ${MAX_ROWS}`,
      [locationId, a.dealId]
    );
    return { tasks: tasks.rows, notes: notes.rows };
  });
}

async function getDealDetail(locationId, a) {
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT o.opportunity_id AS id, o.name, o.status, o.pipeline_name AS pipeline,
              o.current_stage_name AS stage, o.monetary_value AS value, o.currency,
              o.assigned_to_name AS owner, o.tags,
              ${contactLabelSql('ct')} AS primary_contact,
              ct.contact_id AS primary_contact_id,
              o.client_type, o.product_system, o.product_type, o.first_contact_method,
              o.lead_source_opportunity, o.opportunity_source,
              -- QUALIFICATION VALUES ARE DELIBERATELY NOT SELECTED.
              --
              -- meddic_1..10 are what a REP typed into the qualification
              -- headings. They used to come back here, so the model read a
              -- rep's own summary alongside the conversation and could not
              -- tell the two apart — it would answer "the budget is £40k"
              -- from a field someone typed months ago, cite it as fact, and
              -- be quoting the record back at the person who wrote it.
              --
              -- The model's job is to read the CONVERSATION. The headings
              -- themselves are still in the system prompt (prompts.js), so
              -- it knows what to file evidence under; it simply no longer
              -- sees the answers. A rep who wants the AI to consider
              -- something pastes it into a message or a note.
              --
              -- meddic_11 goes too: it is the abandoned-reason field, and
              -- lost_reason below already covers why a deal ended.
              --
              -- Coverage is unaffected: get_qualification_gaps COUNTS these
              -- columns without reading them, so "which deals are missing
              -- qualification" still works.
              o.lost_reason, o.won_at, o.lost_at, o.abandoned_at,
              o.forecast_close_date, o.forecast_probability,
              (SELECT EXTRACT(DAY FROM now() - sh.entered_at)::int
                 FROM stage_history sh
                WHERE sh.location_id = o.location_id
                  AND sh.opportunity_id = o.opportunity_id
                  AND sh.current_stage = true LIMIT 1) AS days_in_stage
         FROM opportunities o
         LEFT JOIN contacts ct
           ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
        WHERE o.location_id = $1 AND o.opportunity_id = $2
          AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false`,
      [locationId, a.dealId]
    );
    const deal = rows[0];
    if (!deal) return { error: 'No such deal, or it has been deleted' };

    // Every OTHER contact on this deal, same source get_deal_contacts uses —
    // a deal fact isn't complete without who else is involved.
    const others = await c.query(
      `SELECT oc.contact_id AS id, oc.is_primary,
              ${contactLabelSql('ct')} AS name,
              ct.email, ct.phone
         FROM opportunity_contacts oc
         JOIN contacts ct
           ON ct.location_id = oc.location_id AND ct.contact_id = oc.contact_id
        WHERE oc.location_id = $1 AND oc.opportunity_id = $2
        ORDER BY oc.is_primary DESC`,
      [locationId, a.dealId]
    );

    return { deal, people: others.rows };
  });
}

async function getContactDetail(locationId, a) {
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT c.contact_id AS id,
              ${contactLabelSql('c')} AS name,
              c.email, c.phone, c.company_name AS business, c.business_id,
              c.contact_type AS type, c.assigned_to_name AS owner, c.tags,
              c.client_type, c.product_type, c.channel,
              c.dnd_email, c.dnd_sms, c.dnd_call, c.dnd_whatsapp, c.dnd_inbound
         FROM contacts c
        WHERE c.location_id = $1 AND c.contact_id = $2 AND c.deleted_at IS NULL`,
      [locationId, a.contactId]
    );
    const contact = rows[0];
    if (!contact) return { error: 'No such contact, or it has been deleted' };

    // Every deal this contact is on — as the deal's own primary contact, OR
    // as an additional person via opportunity_contacts (the architect/QS
    // case). UNIONed rather than just opportunities.contact_id, or a
    // contact added as a secondary person on someone else's deal would look
    // like they have none.
    const deals = await c.query(
      `SELECT o.opportunity_id AS id, o.name, o.status, o.current_stage_name AS stage,
              o.monetary_value AS value, true AS is_primary
         FROM opportunities o
        WHERE o.location_id = $1 AND o.contact_id = $2
          AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false
        UNION
       SELECT o.opportunity_id AS id, o.name, o.status, o.current_stage_name AS stage,
              o.monetary_value AS value, false AS is_primary
         FROM opportunity_contacts oc
         JOIN opportunities o
           ON o.location_id = oc.location_id AND o.opportunity_id = oc.opportunity_id
        WHERE oc.location_id = $1 AND oc.contact_id = $2 AND oc.is_primary = false
          AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false
        LIMIT ${MAX_ROWS}`,
      [locationId, a.contactId]
    );

    return { contact, deals: deals.rows };
  });
}

async function getDealContacts(locationId, a) {
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT oc.contact_id AS id, oc.is_primary,
              ${contactLabelSql('ct')} AS name,
              ct.email, ct.phone, ct.contact_type AS type,
              ct.dnd_email, ct.dnd_sms, ct.dnd_call, ct.dnd_whatsapp
         FROM opportunity_contacts oc
         JOIN contacts ct
           ON ct.location_id = oc.location_id AND ct.contact_id = oc.contact_id
        WHERE oc.location_id = $1 AND oc.opportunity_id = $2
        ORDER BY oc.is_primary DESC`,
      [locationId, a.dealId]
    );
    if (!rows.length) {
      // opportunity_contacts can genuinely be empty for a deal whose only
      // contact is its own primary (never synced a RelationCreate because
      // GHL only fires that for ADDITIONAL people) — fall back to the
      // deal's own contact_id rather than reporting "nobody" on a deal that
      // plainly has its one obvious person.
      const fallback = await c.query(
        `SELECT o.contact_id AS id, true AS is_primary,
                ${contactLabelSql('ct')} AS name,
                ct.email, ct.phone, ct.contact_type AS type,
                ct.dnd_email, ct.dnd_sms, ct.dnd_call, ct.dnd_whatsapp
           FROM opportunities o
           JOIN contacts ct
             ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
          WHERE o.location_id = $1 AND o.opportunity_id = $2`,
        [locationId, a.dealId]
      );
      return { people: fallback.rows, count: fallback.rows.length };
    }
    return { people: rows, count: rows.length };
  });
}

async function searchBusinesses(locationId, a) {
  const where = ['b.location_id = $1', 'b.is_active = true'];
  const params = [locationId];
  if (a.query) {
    params.push(`%${a.query}%`);
    where.push(`b.name ILIKE $${params.length}`);
  }
  if (a.createdAfter) {
    params.push(a.createdAfter);
    where.push(`b.created_at_ghl >= $${params.length}`);
  }
  if (a.createdBefore) {
    params.push(a.createdBefore);
    where.push(`b.created_at_ghl < $${params.length}`);
  }
  return withTenant(locationId, async (c) => {
    if (a.countOnly === true) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total FROM businesses b WHERE ${where.join(' AND ')}`,
        params
      );
      return { totalCount: rows[0].total };
    }
    // Deal count/value from opportunities, contact count from contacts —
    // both joined by the plain (unenforced) business_id text column, since
    // businesses sync daily with no webhooks and cannot carry a real FK.
    const { rows } = await c.query(
      `SELECT b.business_id AS id, b.name, b.city, b.country,
              (SELECT count(*)::int FROM contacts ct
                WHERE ct.location_id = b.location_id AND ct.business_id = b.business_id
                  AND ct.deleted_at IS NULL) AS contacts,
              (SELECT count(*)::int FROM opportunities o
                 JOIN contacts ct ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
                WHERE ct.location_id = b.location_id AND ct.business_id = b.business_id
                  AND o.status = 'open' AND o.is_deleted = false
                  AND o.deleted_at IS NULL AND o.is_ghost = false) AS open_deals,
              (SELECT COALESCE(sum(o.monetary_value), 0)::float FROM opportunities o
                 JOIN contacts ct ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
                WHERE ct.location_id = b.location_id AND ct.business_id = b.business_id
                  AND o.status = 'open' AND o.is_deleted = false
                  AND o.deleted_at IS NULL AND o.is_ghost = false) AS open_value
         FROM businesses b
        WHERE ${where.join(' AND ')}
        ORDER BY b.name
        LIMIT ${MAX_ROWS}`,
      params
    );
    return { businesses: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function searchTasks(locationId, a) {
  const where = ['t.location_id = $1', 't.deleted_at IS NULL', "t.status != 'deleted'"];
  const params = [locationId];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('$n', `$${params.length}`));
  };

  add('t.status = $n', a.status || 'open');
  if (a.owner) add('t.assigned_to_name ILIKE $n', `%${a.owner}%`);
  if (a.dueBefore) add('t.due_at <= $n', a.dueBefore);
  if (a.dueAfter) add('t.due_at >= $n', a.dueAfter);

  return withTenant(locationId, async (c) => {
    if (a.countOnly === true) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total FROM tasks t WHERE ${where.join(' AND ')}`,
        params
      );
      return { totalCount: rows[0].total };
    }
    const { rows } = await c.query(
      `SELECT t.task_id AS id, t.title, t.due_at, t.completed_at,
              t.assigned_to_name AS owner, t.opportunity_id AS deal_id,
              o.name AS deal_name,
              ${contactLabelSql('ct')} AS contact
         FROM tasks t
         LEFT JOIN opportunities o
           ON o.location_id = t.location_id AND o.opportunity_id = t.opportunity_id
         LEFT JOIN contacts ct
           ON ct.location_id = t.location_id AND ct.contact_id = t.contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY t.due_at NULLS LAST
        LIMIT ${MAX_ROWS}`,
      params
    );
    return { tasks: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function searchNotes(locationId, a) {
  const where = ["n.location_id = $1", "n.status = 'active'", 'n.deleted_at IS NULL'];
  const params = [locationId];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('$n', `$${params.length}`));
  };

  if (a.author) add('n.author_name ILIKE $n', `%${a.author}%`);
  if (a.pinnedOnly === true) where.push('n.pinned = true');
  if (a.createdAfter) add('n.created_at_ghl >= $n', a.createdAfter);

  return withTenant(locationId, async (c) => {
    if (a.countOnly === true) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total FROM notes n WHERE ${where.join(' AND ')}`,
        params
      );
      return { totalCount: rows[0].total };
    }
    const { rows } = await c.query(
      `SELECT n.note_id AS id, n.title, n.body, n.pinned, n.created_at_ghl AS at,
              n.author_name AS author, n.opportunity_id AS deal_id,
              o.name AS deal_name
         FROM notes n
         LEFT JOIN opportunities o
           ON o.location_id = n.location_id AND o.opportunity_id = n.opportunity_id
        WHERE ${where.join(' AND ')}
        ORDER BY n.created_at_ghl DESC
        LIMIT ${MAX_ROWS}`,
      params
    );
    return { notes: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function searchMessages(locationId, a) {
  const where = ['m.location_id = $1', 'm.deleted_at IS NULL'];
  const params = [locationId];
  const add = (sql, value) => {
    params.push(value);
    where.push(sql.replace('$n', `$${params.length}`));
  };

  if (a.channel) add('m.message_channel = $n', a.channel);
  if (a.direction) add('m.message_direction = $n', a.direction);
  if (a.since) add('m.message_timestamp >= $n', a.since);

  return withTenant(locationId, async (c) => {
    if (a.countOnly === true) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total FROM messages m WHERE ${where.join(' AND ')}`,
        params
      );
      return { totalCount: rows[0].total };
    }
    const { rows } = await c.query(
      `SELECT m.message_id AS id, m.message_channel AS channel,
              m.message_direction AS direction, m.sender_name AS sender,
              m.message_timestamp AS at, m.opportunity_id AS deal_id,
              o.name AS deal_name,
              left(m.message_body, 200) AS excerpt
         FROM messages m
         LEFT JOIN opportunities o
           ON o.location_id = m.location_id AND o.opportunity_id = m.opportunity_id
        WHERE ${where.join(' AND ')}
        ORDER BY m.message_timestamp DESC
        LIMIT ${MAX_ROWS}`,
      params
    );
    return { messages: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function getLostWonBreakdown(locationId, a) {
  const where = ['o.location_id = $1', 'o.is_deleted = false', 'o.deleted_at IS NULL', 'o.is_ghost = false'];
  const params = [locationId];
  if (a.status) {
    params.push(a.status);
    where.push(`o.status = $${params.length}`);
  } else {
    where.push(`o.status IN ('won', 'lost', 'abandoned')`);
  }
  if (a.since) {
    params.push(a.since);
    const i = params.length;
    where.push(`(o.won_at >= $${i} OR o.lost_at >= $${i} OR o.abandoned_at >= $${i})`);
  }

  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      // Same reason as getQualificationGaps: these rows render in the shared
      // deals table, which shows a CONTACT column.
      `SELECT o.opportunity_id AS id, o.name, o.status, o.monetary_value AS value,
              o.assigned_to_name AS owner, o.pipeline_name AS pipeline,
              o.lost_reason,
              -- The stage a lost deal was in when it closed. Rendered in the
              -- shared deals table, which has a STAGE column — without it
              -- every row showed a dash.
              o.current_stage_name AS stage,
              ${contactLabelSql('ct')} AS contact,
              ${otherContactsSql('o')} AS other_contacts,
              COALESCE(o.won_at, o.lost_at, o.abandoned_at) AS closed_at
         FROM opportunities o
         LEFT JOIN contacts ct
           ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
        WHERE ${where.join(' AND ')}
        ORDER BY COALESCE(o.won_at, o.lost_at, o.abandoned_at) DESC
        LIMIT ${MAX_ROWS}`,
      params
    );
    const totalValue = rows.reduce((sum, r) => sum + (Number(r.value) || 0), 0);
    return { deals: rows, count: rows.length, totalValue, truncated: rows.length === MAX_ROWS };
  });
}

async function getRepPerformance(locationId, a) {
  const sinceClause = a.since ? 'AND o.updated_at_ghl >= $2' : '';
  const params = a.since ? [locationId, a.since] : [locationId];
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT o.assigned_to_name AS owner,
              count(*) FILTER (WHERE o.status = 'open')::int AS open_count,
              COALESCE(sum(o.monetary_value) FILTER (WHERE o.status = 'open'), 0)::float AS open_value,
              count(*) FILTER (WHERE o.status = 'won')::int AS won_count,
              COALESCE(sum(o.monetary_value) FILTER (WHERE o.status = 'won'), 0)::float AS won_value,
              count(*) FILTER (WHERE o.status = 'lost')::int AS lost_count
         FROM opportunities o
        WHERE o.location_id = $1 AND o.is_deleted = false AND o.deleted_at IS NULL
          AND o.is_ghost = false AND o.assigned_to_name IS NOT NULL
          ${sinceClause}
        GROUP BY o.assigned_to_name
        ORDER BY open_value DESC`,
      params
    );
    return { reps: rows, count: rows.length };
  });
}

async function listTags(locationId) {
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT tg.name, tg.namespace,
              (SELECT count(*)::int FROM contacts c
                WHERE c.location_id = tg.location_id AND tg.name = ANY(c.tags)
                  AND c.deleted_at IS NULL) AS contacts,
              (SELECT count(*)::int FROM opportunities o
                WHERE o.location_id = tg.location_id AND tg.name = ANY(o.tags)
                  AND o.is_deleted = false AND o.deleted_at IS NULL AND o.is_ghost = false) AS deals
         FROM tags tg
        WHERE tg.location_id = $1
        ORDER BY tg.name
        LIMIT ${MAX_ROWS}`,
      [locationId]
    );
    return { tags: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function getQualificationGaps(locationId, a) {
  const minMissing = Number(a.minMissing) > 0 ? Number(a.minMissing) : 1;
  return withTenant(locationId, async (c) => {
    // 10 headings (o.meddic_1..10) — o.meddic_11 is the abandoned-reason field,
    // not a qualification heading, so it's deliberately excluded here.
    const { rows } = await c.query(
      // `contact` is selected because the UI renders these rows in the same
      // deals table search_deals feeds (AnswerDealsTable). A tool that
      // returns `deals` without it leaves the CONTACT column showing a dash
      // on a deal that plainly has one — the row looks broken rather than
      // sparse.
      `SELECT o.opportunity_id AS id, o.name, o.assigned_to_name AS owner,
              o.current_stage_name AS stage,
              ${contactLabelSql('ct')} AS contact,
              ${otherContactsSql('o')} AS other_contacts,
              (10 - (
                (o.meddic_1  IS NOT NULL AND o.meddic_1  != '')::int +
                (o.meddic_2  IS NOT NULL AND o.meddic_2  != '')::int +
                (o.meddic_3  IS NOT NULL AND o.meddic_3  != '')::int +
                (o.meddic_4  IS NOT NULL AND o.meddic_4  != '')::int +
                (o.meddic_5  IS NOT NULL AND o.meddic_5  != '')::int +
                (o.meddic_6  IS NOT NULL AND o.meddic_6  != '')::int +
                (o.meddic_7  IS NOT NULL AND o.meddic_7  != '')::int +
                (o.meddic_8  IS NOT NULL AND o.meddic_8  != '')::int +
                (o.meddic_9  IS NOT NULL AND o.meddic_9  != '')::int +
                (o.meddic_10 IS NOT NULL AND o.meddic_10 != '')::int
              )) AS missing_count
         FROM opportunities o
         LEFT JOIN contacts ct
           ON ct.location_id = o.location_id AND ct.contact_id = o.contact_id
        WHERE o.location_id = $1 AND o.status = 'open' AND o.is_deleted = false
          AND o.deleted_at IS NULL AND o.is_ghost = false
        HAVING (10 - (
                (o.meddic_1  IS NOT NULL AND o.meddic_1  != '')::int +
                (o.meddic_2  IS NOT NULL AND o.meddic_2  != '')::int +
                (o.meddic_3  IS NOT NULL AND o.meddic_3  != '')::int +
                (o.meddic_4  IS NOT NULL AND o.meddic_4  != '')::int +
                (o.meddic_5  IS NOT NULL AND o.meddic_5  != '')::int +
                (o.meddic_6  IS NOT NULL AND o.meddic_6  != '')::int +
                (o.meddic_7  IS NOT NULL AND o.meddic_7  != '')::int +
                (o.meddic_8  IS NOT NULL AND o.meddic_8  != '')::int +
                (o.meddic_9  IS NOT NULL AND o.meddic_9  != '')::int +
                (o.meddic_10 IS NOT NULL AND o.meddic_10 != '')::int
              )) >= $2
        ORDER BY missing_count DESC
        LIMIT ${MAX_ROWS}`,
      [locationId, minMissing]
    );
    return { deals: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function getCustomFieldOptions(locationId, a) {
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT display_name, field_type, options
         FROM ghl_custom_field_definitions
        WHERE location_id = $1 AND field_key = $2 AND is_active = true`,
      [locationId, a.fieldKey]
    );
    const field = rows[0];
    if (!field) return { error: `No active custom field with key "${a.fieldKey}"` };
    // GHL's own type naming, per the field's real definition — the model
    // should never assume single vs multi, since the earlier bug this
    // existed to prevent was exactly that assumption going stale.
    const multiple = /CHECKBOX|MULTIPLE/i.test(field.field_type || '');
    return {
      displayName: field.display_name,
      fieldType: field.field_type,
      multiple,
      options: field.options?.values || field.options || null
    };
  });
}

// Reads vw_opportunity_flat directly rather than re-deriving its metrics —
// that view already carries several deliberate, hard-won fixes (documented
// inline as "FIX #2"/"FIX #6" in migration 067 and its predecessors:
// speed-to-lead anchored on first INBOUND message not deal creation,
// whys_fresh checked against opportunity_field_history not updated_at,
// attribution coverage via message_opportunity_map not raw
// messages.opportunity_id). Re-implementing that logic here risks quietly
// disagreeing with the view the rest of the app and its analytics already
// trust.
async function getDealMetrics(locationId, a) {
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT opportunity_name, status, days_in_current_stage, total_pipeline_age_days,
              first_response_minutes, first_response_sender_type, first_human_response_minutes,
              message_count, inbound_count, outbound_count, has_call,
              whys_present, whys_fresh, mapping_coverage_pct, unmapped_message_count,
              has_live_task, overdue_task_count
         FROM vw_opportunity_flat
        WHERE location_id = $1 AND opportunity_id = $2`,
      [locationId, a.dealId]
    );
    const metrics = rows[0];
    if (!metrics) return { error: 'No such deal, or it has been deleted' };
    return { metrics };
  });
}

async function getSyncHealth(locationId) {
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT run_type, object_type, last_success_at, last_failure_at,
              overdue_by, total_runs, successful_runs, failed_runs, last_run_at
         FROM vw_sync_run_health
        WHERE location_id = $1
        ORDER BY run_type, object_type`,
      [locationId]
    );
    return { jobs: rows, count: rows.length };
  });
}

async function getTagHistory(locationId, a) {
  const entityType = a.entityType === 'deal' ? 'opportunity' : a.entityType;
  const where = ['th.location_id = $1', 'th.entity_type = $2', 'th.entity_id = $3'];
  const params = [locationId, entityType, a.entityId];
  if (a.tag) {
    params.push(a.tag);
    where.push(`th.tag_name ILIKE $${params.length}`);
  }
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT th.tag_name, th.applied_at, th.removed_at,
              (th.removed_at IS NULL) AS currently_active, th.detected_via
         FROM tag_history th
        WHERE ${where.join(' AND ')}
        ORDER BY th.applied_at DESC
        LIMIT ${MAX_ROWS}`,
      params
    );
    return { history: rows, count: rows.length };
  });
}

async function searchDndContacts(locationId, a) {
  const channelCol = { email: 'dnd_email', sms: 'dnd_sms', call: 'dnd_call', whatsapp: 'dnd_whatsapp' };
  const where = ['c.location_id = $1', 'c.deleted_at IS NULL'];
  if (a.channel && channelCol[a.channel]) {
    where.push(`c.${channelCol[a.channel]} = true`);
  } else {
    where.push('(c.dnd_email = true OR c.dnd_sms = true OR c.dnd_call = true OR c.dnd_whatsapp = true)');
  }
  return withTenant(locationId, async (c) => {
    if (a.countOnly === true) {
      const { rows } = await c.query(
        `SELECT count(*)::int AS total FROM contacts c WHERE ${where.join(' AND ')}`,
        [locationId]
      );
      return { totalCount: rows[0].total };
    }
    const { rows } = await c.query(
      `SELECT c.contact_id AS id,
              ${contactLabelSql('c')} AS name,
              c.dnd_email, c.dnd_sms, c.dnd_call, c.dnd_whatsapp
         FROM contacts c
        WHERE ${where.join(' AND ')}
        ORDER BY c.updated_at_ghl DESC NULLS LAST
        LIMIT ${MAX_ROWS}`,
      [locationId]
    );
    return { contacts: rows, count: rows.length, truncated: rows.length === MAX_ROWS };
  });
}

async function getChannelBreakdown(locationId, a) {
  const params = [locationId];
  let sinceClause = '';
  if (a.since) {
    params.push(a.since);
    sinceClause = `AND m.message_timestamp >= $${params.length}`;
  }
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT m.message_channel AS channel, m.message_direction AS direction,
              count(*)::int AS messages
         FROM messages m
        WHERE m.location_id = $1 AND m.deleted_at IS NULL ${sinceClause}
        GROUP BY m.message_channel, m.message_direction
        ORDER BY messages DESC`,
      params
    );
    return { breakdown: rows, count: rows.length };
  });
}

async function listSavedViews(locationId, a) {
  const scope = a.scope || 'deals';
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT name, filters, is_shared
         FROM saved_views
        WHERE location_id = $1 AND scope = $2
        ORDER BY position NULLS LAST, name
        LIMIT ${MAX_ROWS}`,
      [locationId, scope]
    );
    return { views: rows, count: rows.length };
  });
}

async function getConversationProviders(locationId, _input = {}, scope = {}) {
  return withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      // provider_id is returned because propose_send_message needs it: the
      // model picks a sender by NAME with the rep, then has to pass the id.
      // Without it the tool could only ever describe senders, never route to
      // one — which is what "which channel?" with no sender choice was.
      `SELECT provider_id, name, type, is_default, is_native
         FROM conversation_providers
        WHERE location_id = $1 AND is_deleted = false
        ORDER BY type, is_default DESC, name`,
      [locationId]
    );
    // The asking rep's connected mailbox (two-way sync) as an Email sender.
    // Same synthetic "emailfrom:<address>" id the providers route emits, so a
    // proposal carrying it sends via GHL's emailFrom rather than a provider.
    if (scope.userId) {
      // By user across the company — see userWriter.mailboxForUser.
      const box = await mailboxForUser(locationId, scope.userId);
      if (box) {
        rows.push({ provider_id: `emailfrom:${box.email}`, name: `${box.kind} (${box.email})`, type: 'Email', is_default: false, is_native: false });
      }
    }
    // Native senders are NOT rows in this table — a native send is the channel
    // type with no conversationProviderId. Returning only the custom rows made
    // the model offer three custom SMS senders and never mention that email or
    // plain SMS were options at all.
    const COMPOSABLE = ['SMS', 'Email', 'WhatsApp'];
    // Grouped by the channel a REP would file a sender under, not the type
    // GHL stores it as. GHL registers marketplace providers as SMS-type —
    // "WhatsApp QR", "iMessage" and "SMS Android" all carry type 'SMS' — so
    // grouped by type, WhatsApp QR sat under SMS and the WhatsApp channel
    // showed one sender (native). Rule 15 then read "exactly one option, do
    // not ask", and a rep asking for WhatsApp was never offered the sender
    // they meant. Same classification as dealActionDetector.displayChannel.
    // Sending is unaffected: ghlMessageWrite turns any custom provider id
    // into type 'Custom', whatever channel it was listed under here.
    // Only a MESSAGING provider moves channel. "WhatsApp Voice" is type
    // Call — it matched the name test and was offered as a WhatsApp sender,
    // which it cannot be; nothing here can compose a call.
    const byType = rows.reduce((acc, r) => { (acc[senderChannel(r)] ||= []).push(r); return acc; }, {});

    return {
      // One entry per channel: its native sender, then any custom ones.
      channels: COMPOSABLE.map((type) => ({
        channel: type,
        senders: [
          { name: `${type} (native)`, conversationProviderId: null, isNative: true },
          ...(byType[type] || []).map((r) => ({
            name: r.name,
            conversationProviderId: r.provider_id,
            isNative: r.is_native,
            isDefault: r.is_default
          }))
        ]
      })),
      // Kept for anything reading the flat list.
      providers: rows,
      count: rows.length,
      channelsWithAChoice: COMPOSABLE.filter((t) => (byType[t] || []).length > 0)
    };
  });
}

// Not a withTenant/SQL tool like every other one here — the account name
// lives in GHL, not Postgres, so this calls the GHL API (via the same
// cached fetchLocationName the auth handshake uses) rather than reading our
// own tables. installs holds OAuth tokens with no RLS policy (see
// scripts/create_analyst_role.sql for why that access is deliberately
// locked down elsewhere) — rawQuery here is scoped to this one row by
// location_id, same as every other direct installs read in this codebase.
async function getAccountInfo(locationId) {
  // SELECT * deliberately, not a trimmed column list: fetchLocationName ->
  // ghlRequest -> ensureFreshToken needs access_token, refresh_token and
  // token_expires_at off this row (and will refresh + write back
  // token_expires_at/access_token if the token is due), same as every real
  // GHL API call in this codebase makes against a full installs row.
  const { rows } = await rawQuery(
    `SELECT * FROM installs WHERE location_id = $1`,
    [locationId]
  );
  const install = rows[0];
  if (!install || install.uninstalled_at) {
    return { error: 'No active install found for this location' };
  }
  const name = await fetchLocationName(install);
  return { locationId, name: name || null };
}

// ── propose-tools — insert-only, never call GHL ──────────────────────

async function proposeCreateContact(locationId, a) {
  const addressable = a.firstName || a.lastName || a.email || a.phone;
  if (!addressable) {
    // Not an error result — this is the "ask the rep for more" signal the
    // model reads and turns into a natural follow-up question, same as a
    // required-field form validation would prompt a person to keep filling
    // it in.
    return { needsInfo: ['firstName or lastName, or a phone number, or an email address'] };
  }
  const payload = {
    firstName: a.firstName || null,
    lastName: a.lastName || null,
    email: a.email || null,
    phone: a.phone || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId || null,
    actionType: 'create_contact',
    payload
  });
  return { actionId: action.id, actionType: 'create_contact', proposed: payload };
}

async function proposeAttachContact(locationId, a) {
  if (!a.opportunityId || !a.contactId) {
    return { needsInfo: ['which deal', 'which contact'] };
  }
  const payload = {
    opportunityId: a.opportunityId,
    contactId: a.contactId,
    contactName: a.contactName || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId,
    actionType: 'attach_contact',
    payload
  });
  return { actionId: action.id, actionType: 'attach_contact', proposed: payload };
}

async function proposeRemoveContact(locationId, a) {
  if (!a.opportunityId || !a.contactId) {
    return { needsInfo: ['which deal', 'which contact'] };
  }
  const payload = {
    opportunityId: a.opportunityId,
    contactId: a.contactId,
    contactName: a.contactName || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId,
    actionType: 'remove_contact',
    payload
  });
  return { actionId: action.id, actionType: 'remove_contact', proposed: payload };
}

// Resolves a pipeline (and optionally a stage within it) by name to real
// GHL ids — the model has pipeline/stage NAMES from get_pipeline_summary,
// never the raw ids, so this is where "the Sales pipeline" becomes an
// actual pipelineId the create-opportunity endpoint requires.
async function resolvePipelineStage(locationId, pipelineName, stageName) {
  return withTenant(locationId, async (c) => {
    const { rows: pipes } = await c.query(
      `SELECT pipeline_id, name FROM pipelines
        WHERE location_id = $1 AND is_active = true AND name ILIKE $2`,
      [locationId, `%${pipelineName}%`]
    );
    if (pipes.length !== 1) return { error: pipes.length === 0 ? 'not_found' : 'ambiguous' };
    const pipelineId = pipes[0].pipeline_id;

    if (!stageName) {
      const { rows: first } = await c.query(
        `SELECT stage_id FROM pipeline_stages
          WHERE location_id = $1 AND pipeline_id = $2
          ORDER BY position ASC LIMIT 1`,
        [locationId, pipelineId]
      );
      return { pipelineId, pipelineStageId: first[0]?.stage_id || null };
    }
    const { rows: stages } = await c.query(
      `SELECT stage_id FROM pipeline_stages
        WHERE location_id = $1 AND pipeline_id = $2 AND name ILIKE $3`,
      [locationId, pipelineId, `%${stageName}%`]
    );
    if (stages.length !== 1) return { error: stages.length === 0 ? 'not_found' : 'ambiguous' };
    return { pipelineId, pipelineStageId: stages[0].stage_id };
  });
}

async function proposeCreateDeal(locationId, a) {
  if (!a.contactId || !String(a.name || '').trim() || !String(a.pipelineName || '').trim()) {
    return { needsInfo: ['which contact', 'the deal name', 'which pipeline'] };
  }
  const resolved = await resolvePipelineStage(locationId, a.pipelineName, a.stageName);
  if (resolved.error) {
    return { needsInfo: [
      resolved.error === 'ambiguous'
        ? `a more specific pipeline/stage name — "${a.pipelineName}"${a.stageName ? `/"${a.stageName}"` : ''} matched more than one`
        : `a valid pipeline/stage name — could not find "${a.pipelineName}"${a.stageName ? `/"${a.stageName}"` : ''}`
    ] };
  }
  const payload = {
    contactId: a.contactId,
    contactName: a.contactName || null,
    name: a.name,
    value: typeof a.value === 'number' ? a.value : null,
    pipelineId: resolved.pipelineId,
    pipelineStageId: resolved.pipelineStageId,
    pipelineName: a.pipelineName,
    stageName: a.stageName || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'create_deal',
    payload
  });
  return { actionId: action.id, actionType: 'create_deal', proposed: payload };
}

// A deal id the model passes is sometimes one the REP typed — pasted from a
// spreadsheet, where I/l/1 and O/0 are indistinguishable. GHL ids are case-
// and glyph-exact, so the write 404s ("That deal no longer exists") on a
// deal that is right there. Confirm the id against our own rows first, and
// when the exact id is missing, accept the one row that matches with the
// confusable glyphs allowed to vary.
async function resolveOpportunityId(locationId, opportunityId) {
  const id = String(opportunityId || '').trim();
  if (!id) return null;
  return withTenant(locationId, async (c) => {
    const exact = await c.query(
      `SELECT opportunity_id FROM opportunities
        WHERE location_id = $1 AND opportunity_id = $2 LIMIT 1`,
      [locationId, id]
    );
    if (exact.rowCount) return exact.rows[0].opportunity_id;
    if (!/^[A-Za-z0-9]{10,40}$/.test(id)) return null;
    const pattern = '^' + id.replace(/[Il1]/g, '[Il1]').replace(/[O0]/g, '[O0]') + '$';
    const fuzzy = await c.query(
      `SELECT opportunity_id FROM opportunities
        WHERE location_id = $1 AND opportunity_id ~ $2
          AND is_deleted = false AND deleted_at IS NULL
        LIMIT 2`,
      [locationId, pattern]
    );
    return fuzzy.rowCount === 1 ? fuzzy.rows[0].opportunity_id : null;
  });
}

async function proposeUpdateDeal(locationId, a) {
  if (!a.opportunityId) return { needsInfo: ['which deal'] };
  const realId = await resolveOpportunityId(locationId, a.opportunityId);
  if (!realId) {
    return { needsInfo: [
      `a deal that exists — no deal in this account has the id "${a.opportunityId}". ` +
      'Find it with search_deals by name and use the id that returns.'
    ] };
  }
  if (realId !== a.opportunityId) {
    logger.info({ locationId, typed: a.opportunityId, resolved: realId },
      'propose_update_deal: corrected a confusable deal id');
  }
  a = { ...a, opportunityId: realId };
  const wantsFields = Array.isArray(a.fields) && a.fields.length > 0;
  if (a.name === undefined && a.value === undefined && !a.stageName
      && !a.pipelineName && !a.closeDate && !wantsFields) {
    return { needsInfo: [
      'what to change — a name, value, stage, pipeline, close date, or a field and its new value'
    ] };
  }

  // Stage / pipeline. A stage alone is looked up in the deal's OWN pipeline;
  // with a pipelineName it is looked up in that one (and defaults to its
  // first stage), because a deal cannot sit in a stage of a pipeline it is
  // not in.
  let pipelineStageId = null;
  let pipelineId = null;
  let pipelineName = null;
  if (a.pipelineName) {
    const resolved = await resolvePipelineStage(locationId, a.pipelineName, a.stageName);
    if (resolved.error) {
      return { needsInfo: [
        resolved.error === 'ambiguous'
          ? `a more specific pipeline/stage name — "${a.pipelineName}"${a.stageName ? `/"${a.stageName}"` : ''} matched more than one`
          : `a valid pipeline/stage name — could not find "${a.pipelineName}"${a.stageName ? `/"${a.stageName}"` : ''}`
      ] };
    }
    pipelineId = resolved.pipelineId;
    pipelineStageId = resolved.pipelineStageId;
    pipelineName = a.pipelineName;
  } else if (a.stageName) {
    const { rows } = await withTenant(locationId, (c) => c.query(
      `SELECT ps.stage_id FROM pipeline_stages ps
         JOIN opportunities o
           ON o.location_id = ps.location_id AND o.pipeline_id = ps.pipeline_id
        WHERE ps.location_id = $1 AND o.opportunity_id = $2 AND ps.name ILIKE $3`,
      [locationId, a.opportunityId, `%${a.stageName}%`]
    ));
    if (rows.length !== 1) {
      return { needsInfo: [
        rows.length === 0
          ? `a valid stage name — could not find "${a.stageName}" in this deal's pipeline`
          : `a more specific stage name — "${a.stageName}" matched more than one stage`
      ] };
    }
    pipelineStageId = rows[0].stage_id;
  }

  // Close date, normalised so the card and GHL see the same YYYY-MM-DD.
  let closeDate = null;
  if (a.closeDate) {
    const d = new Date(a.closeDate);
    if (Number.isNaN(d.getTime())) {
      return { needsInfo: [`a valid close date — "${a.closeDate}" is not a date`] };
    }
    closeDate = d.toISOString().slice(0, 10);
  }

  // Custom fields: label → definition → validated value, with the current
  // value alongside so the card can show "was X".
  let customFields = null;
  if (wantsFields) {
    const [defs, blob] = await Promise.all([
      listOpportunityFieldDefs(locationId),
      currentFieldValues(locationId, a.opportunityId)
    ]);
    const missing = [];
    customFields = [];
    for (const f of a.fields) {
      const hit = resolveOpportunityField(defs, f?.field);
      if (hit.candidates) {
        missing.push(`which field you mean by "${f.field}" — it could be ${
          hit.candidates.map((d) => `"${d.label}"`).join(' or ')}`);
        continue;
      }
      if (!hit.def) {
        const known = defs.filter((d) => !/FILE_UPLOAD|SIGNATURE/.test(d.type)).map((d) => `"${d.label}"`);
        missing.push(`a field called "${f.field}" — this account's deal fields are ${known.join(', ')}`);
        continue;
      }
      const def = hit.def;
      if (/FILE_UPLOAD|SIGNATURE/.test(def.type)) {
        missing.push(`${def.label} is a file field and cannot be set from here`);
        continue;
      }
      const coerced = coerceFieldValue(def, f.value);
      if (coerced.error) { missing.push(coerced.error); continue; }
      customFields.push({
        id: def.id,
        key: def.shortKey,
        label: def.label,
        type: def.type,
        options: def.options.length ? def.options : null,
        multiple: def.multiple,
        value: coerced.value,
        previous: displayValue(valueOf(blob, def))
      });
    }
    if (missing.length) return { needsInfo: missing };
  }

  const payload = {
    opportunityId: a.opportunityId,
    dealName: a.dealName || null,
    name: a.name ?? null,
    value: typeof a.value === 'number' ? a.value : null,
    pipelineId,
    pipelineName,
    pipelineStageId,
    stageName: a.stageName || null,
    closeDate,
    customFields
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId,
    actionType: 'update_deal',
    payload
  });
  return { actionId: action.id, actionType: 'update_deal', proposed: payload };
}

async function proposeChangeOwner(locationId, a) {
  if (!a.opportunityId || !a.ownerUserId) {
    return { needsInfo: ['which deal', 'which team member to assign it to'] };
  }
  const payload = {
    opportunityId: a.opportunityId,
    ownerUserId: a.ownerUserId,
    ownerName: a.ownerName || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId,
    actionType: 'change_owner',
    payload
  });
  return { actionId: action.id, actionType: 'change_owner', proposed: payload };
}

async function proposeChangeStatus(locationId, a) {
  if (!a.opportunityId || !a.status) {
    return { needsInfo: ['which deal', 'the new status'] };
  }
  // Mirrors setGhlOpportunityStatus's own contract (ghlOpportunityWrite.js):
  // LOST needs a reason, or GHL's status change silently carries none. Ask
  // rather than propose an incomplete action a rep would just have to fix.
  if (a.status === 'lost' && !a.lostReasonId) {
    return { needsInfo: ['a reason this deal is lost'] };
  }
  const payload = {
    opportunityId: a.opportunityId,
    status: a.status,
    lostReasonId: a.status === 'lost' ? a.lostReasonId : null
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId,
    actionType: 'change_status',
    payload
  });
  return { actionId: action.id, actionType: 'change_status', proposed: payload };
}

// Is this contact actually on this deal?
//
// Mirrors getDealContacts, fallback included: opportunity_contacts is empty for
// a deal whose only person is its own primary, because GHL fires RelationCreate
// only for ADDITIONAL contacts. Checking that table alone would reject the one
// obvious recipient on most deals.
async function contactIsOnDeal(client, locationId, opportunityId, contactId) {
  // Returns WHICH kind of contact this is, not just whether it is on the deal.
  // A deal has one primary (opportunities.contact_id) and any number of
  // additional people (opportunity_contacts) — and a rep confirming a message
  // to the architect rather than the customer should see that before they
  // click, since the two read identically on the card.
  //
  // UNION ALL + ORDER BY, not UNION: the primary also has a row in
  // opportunity_contacts, so both branches can match. Ordering primary first
  // and taking one row means "is this the primary?" wins over "is this on the
  // deal at all?".
  const { rows } = await client.query(
    `SELECT true AS is_primary
       FROM opportunities
      WHERE location_id = $1 AND opportunity_id = $2 AND contact_id = $3
      UNION ALL
     SELECT false AS is_primary
       FROM opportunity_contacts
      WHERE location_id = $1 AND opportunity_id = $2 AND contact_id = $3
      ORDER BY is_primary DESC
      LIMIT 1`,
    [locationId, opportunityId, contactId]
  );
  return rows.length
    ? { onDeal: true, isPrimary: rows[0].is_primary }
    : { onDeal: false, isPrimary: false };
}

// The model names the sender far more reliably than it copies its id —
// "Drafted the WhatsApp QR message" arrived with conversationProviderId
// null, so the card offered native and the send would have gone native.
// Resolve the name to the id here, so the proposal carries what the rep
// was told. Native names ("WhatsApp (native)") resolve to nothing, which is
// correct: native is "no provider id".
async function resolveSenderName(locationId, name) {
  const n = String(name || '').replace(/\s*\(native\)\s*$/i, '').trim();
  if (!n || /^(sms|email|whatsapp)$/i.test(n)) return null;
  // A rep's connected mailbox is named "Gmail · address" in the sender list;
  // the address in it is the id the send path wants.
  const addr = (n.match(/[^\s<>()·,;"']+@[^\s<>()·,;"']+/) || [])[0];
  if (addr) {
    const box = await mailboxByAddress(locationId, addr).catch(() => null);
    if (box) return `emailfrom:${box.email}`;
  }
  try {
    return await withTenant(locationId, async (c) => {
      const { rows } = await c.query(
        `SELECT provider_id FROM conversation_providers
          WHERE location_id = $1 AND is_deleted = false AND is_native = false
            AND lower(name) = lower($2)
          LIMIT 1`,
        [locationId, n]
      );
      return rows[0]?.provider_id || null;
    });
  } catch { return null; }
}

async function proposeSendMessage(locationId, a, scope = {}) {
  if (!a.conversationProviderId && a.senderName) {
    const resolved = await resolveSenderName(locationId, a.senderName);
    if (resolved) a = { ...a, conversationProviderId: resolved };
  }
  if (!a.contactId || !a.type) {
    return { needsInfo: ['which contact', 'SMS, WhatsApp or Email'] };
  }

  // Asked from a deal, but writing to someone not on it? Allow it — and say so.
  //
  // This started as a hard refusal. That was wrong: a rep can legitimately want
  // to message someone outside the deal, they named the person explicitly, and
  // THEY are the one confirming the card. Refusing would block a real request
  // to prevent a hypothetical one.
  //
  // But it must not pass silently either. The model picks the contact id itself
  // from whatever it read during the turn, so a question asked on deal A could
  // address a contact it saw while searching deal B — and the card would look
  // entirely normal, because it shows a name the model supplied. The warning is
  // what makes that visible before a rep clicks Confirm on a message to a
  // customer.
  let offDealContact = false;
  let additionalContact = false;
  if (a.opportunityId) {
    const on = await withTenant(locationId, (c) =>
      contactIsOnDeal(c, locationId, a.opportunityId, a.contactId));
    offDealContact = !on.onDeal;
    // On the deal, but not its primary. Routine — a task or message for the
    // architect or the QS is normal work — just worth saying on the card,
    // since "pra" and "bindu" read identically and only one is who a rep
    // would assume.
    additionalContact = on.onDeal && !on.isPrimary;
  }
  if ((a.type === 'SMS' || a.type === 'WhatsApp') && !String(a.message || '').trim()) {
    return { needsInfo: ['the message text'] };
  }
  // A REPLY to an email already on the thread. The model names the message
  // (by id, from the context it reads); the thread id and the original
  // subject come from our own messages table, so the model cannot send a
  // reply into the wrong thread by mis-copying an id it never saw.
  let reply = null;
  if (a.type === 'Email' && a.replyToMessageId) {
    try {
      reply = await withTenant(locationId, async (c) => {
        const { rows } = await c.query(
          `SELECT message_id, thread_id, subject, contact_id,
                  message_direction, conversation_provider_id, raw_message
             FROM messages
            WHERE location_id = $1 AND message_id = $2 AND message_channel = 'EMAIL'
            LIMIT 1`,
          [locationId, String(a.replyToMessageId)]
        );
        return rows[0] || null;
      });
    } catch { reply = null; }
    if (!reply) return { needsInfo: ['which email to reply to — that id is not an email on this deal'] };

    // THE REPLY LEAVES FROM WHERE THE ORIGINAL WENT. No sender question for
    // a reply: our side of the original — its From if we sent it, its To if
    // the customer did — is the mailbox the thread is already on. A custom
    // provider the original used is reused; an address that is a rep's
    // connected Gmail becomes that Gmail; anything else is the native path.
    // The card's "Send via" is where the rep changes it.
    if (!a.conversationProviderId) {
      if (reply.conversation_provider_id) {
        a = { ...a, conversationProviderId: reply.conversation_provider_id };
      } else {
        const ours = reply.message_direction === 'inbound'
          ? emailAddr(reply.raw_message, 'to')
          : emailAddr(reply.raw_message, 'from');
        const first = String(ours || '').split(',')[0].trim();
        const box = first ? await mailboxByAddress(locationId, first) : null;
        if (box) a = { ...a, conversationProviderId: `emailfrom:${box.email}` };
      }
    }
  }
  // WHO ELSE IS ON THE EMAIL. Resolved here, by the server, from contact ids
  // and addresses: the card gets names and emails to draw as chips, the
  // send gets addresses. A reply-all is prefilled from the original's own
  // headers so the rep sees who it goes to before confirming.
  let recipients = null;
  let recipientOptions = [];
  let recipientNote = null;
  if (a.type === 'Email') {
    const built = await buildEmailRecipients(locationId, a, reply);
    if (built.needsInfo) return { needsInfo: built.needsInfo };
    recipients = built.recipients;
    recipientOptions = built.options;
    recipientNote = built.note;
  }
  const originalSubject = reply?.subject ? String(reply.subject).replace(/^\s*(re|fwd?):\s*/i, '') : null;
  if (a.type === 'Email') {
    // A reply with no subject is fine — it takes "Re: <original>" below. The
    // check used to run before the reply was resolved, so the model was told
    // "a subject line is needed" on every reply and kept asking the rep for
    // one the server was about to supply.
    if (!String(a.subject || '').trim() && !originalSubject) return { needsInfo: ['a subject line'] };
    if (!String(a.html || a.message || '').trim()) return { needsInfo: ['the email content'] };
  }
  const payload = {
    // For an email the To decides the conversation it files under — and a
    // reply's To is whoever wrote the original, which may not be the
    // contact the model named.
    contactId: recipients?.to?.[0]?.contactId || a.contactId,
    contactName: recipients?.to?.[0]?.name || a.contactName || null,
    type: a.type,
    subject: a.type === 'Email'
      ? (a.subject || (originalSubject ? `Re: ${originalSubject}` : null))
      : null,
    // Reply threading — see above. Carried on the proposal so the card can
    // say what is being replied to and the send can thread it.
    ...(reply ? {
      replyMessageId: reply.message_id,
      threadId: reply.thread_id || null,
      emailReplyMode: a.emailReplyMode === 'reply_all' ? 'reply_all' : 'reply',
      replyToSubject: reply.subject || null
    } : {}),
    message: a.message || null,
    html: a.type === 'Email' ? (a.html || null) : null,
    // Prefills the card's sender picker. Null means "the location's default",
    // which is what a bare send has always done.
    conversationProviderId: a.conversationProviderId || null,
    // Email only: { to: {contactId,name,email}, cc: [...], bcc: [...] } for
    // the card's recipient rows, and the deal's people (with emails) as the
    // first suggestions in its picker.
    ...(recipients ? {
      recipients,
      recipientOptions,
      // How several Tos go out — a copy each, or one email with the others
      // CC'd. See actionExecutor.sendMessageProposal. A reply belongs to
      // one thread, so it defaults to one email; anything else to copies.
      recipientMode: reply ? 'together' : 'separate',
      // Who the card's picker may offer. From a deal: that deal's people
      // only — the rep asked to message someone on this deal, and a
      // sub-account-wide list there is a way to email the wrong customer.
      // From Insights AI there is no deal in scope, so every contact.
      recipientScope: scope.surface === 'deal' || (!scope.surface && a.opportunityId) ? 'deal' : 'all'
    } : {}),
    // On the deal, but not its primary contact. Routine — messaging the
    // architect or the QS is normal work — but the card should say so, since
    // "To pra" and "To bindu" read identically and only one of them is who a
    // rep would assume.
    isAdditionalContact: additionalContact || undefined
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId || null,
    actionType: 'send_message',
    payload
  });
  return {
    actionId: action.id,
    actionType: 'send_message',
    proposed: payload,
    // Recipients the server could not address — a CC'd contact with no email
    // on file. Relayed so the rep knows who the email will NOT reach.
    ...(recipientNote ? { note: recipientNote } : {}),
    // Read by the model, which is told to relay it in one short clause.
    ...(offDealContact ? {
      warning: 'This contact is not linked to this deal. The message IS drafted. '
             + 'Open your reply with that fact before anything else — e.g. '
             + '"Note: Bindu isn\'t linked to this deal — I\'ve still drafted the '
             + 'message." Do not lead with what you drafted and mention the '
             + 'mismatch afterwards: a rep skimming the first line is the one who '
             + 'most needs to know, and by the time they reach the end of the '
             + 'sentence they may already be reaching for Confirm.'
    } : {})
  };
}

// Resolve the To / CC / BCC of an email proposal.
//
// Each cc/bcc entry is a contact id or an address. Ids become {contactId,
// name, email} from our contacts table; addresses stay as {email}. The To
// is the anchor contact (the conversation the email files under) and MUST
// have an email — without one GHL has nowhere to send it. A reply-all with
// no explicit copies is prefilled from the original message's headers,
// minus our own mailbox and the To.
async function buildEmailRecipients(locationId, a, reply) {
  const rawTo = Array.isArray(a.to) ? a.to : [];
  const rawCc = Array.isArray(a.cc) ? a.cc : [];
  const rawBcc = Array.isArray(a.bcc) ? a.bcc : [];
  const looksLikeId = (x) => typeof x === 'string' && !x.includes('@') && /^[A-Za-z0-9_-]{8,40}$/.test(x.trim());
  const ids = [a.contactId, reply?.contact_id, ...rawTo, ...rawCc, ...rawBcc].filter(looksLikeId).map((x) => x.trim());

  // Every address on the original, for a reply: who wrote it, who it went
  // to, who was copied. Resolved to contacts where one holds that address,
  // so the card can show a name rather than a bare address.
  const headerAddrs = reply ? [...new Set([
    ...emailAddrList(reply.raw_message, 'from'),
    ...emailAddrList(reply.raw_message, 'to'),
    ...emailAddrList(reply.raw_message, 'cc')
  ])] : [];

  const { byId, byEmail, options } = await withTenant(locationId, async (c) => {
    const { rows } = await c.query(
      `SELECT contact_id, first_name, last_name, company_name, email
         FROM contacts
        WHERE location_id = $1
          AND (contact_id = ANY($2::text[]) OR lower(email) = ANY($3::text[]))`,
      [locationId, [...new Set(ids)], headerAddrs]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.contact_id, shapeRecipient(r)]));
    const byEmail = {};
    for (const r of rows) {
      const e = String(r.email || '').trim().toLowerCase();
      if (e && !byEmail[e]) byEmail[e] = shapeRecipient(r);
    }

    // The deal's people with an email — what the card offers first.
    let options = [];
    if (a.opportunityId) {
      const { rows: people } = await c.query(
        `SELECT DISTINCT ON (c.contact_id)
                c.contact_id, c.first_name, c.last_name, c.company_name, c.email,
                (o.contact_id = c.contact_id) AS is_primary
           FROM opportunities o
           LEFT JOIN opportunity_contacts oc
             ON oc.location_id = o.location_id AND oc.opportunity_id = o.opportunity_id
            AND oc.association_id = 'OPPORTUNITIES_CONTACTS_ASSOCIATION'
           JOIN contacts c
             ON c.location_id = o.location_id
            AND c.contact_id IN (o.contact_id, oc.contact_id)
          WHERE o.location_id = $1 AND o.opportunity_id = $2
            AND c.email IS NOT NULL AND c.email <> ''
          ORDER BY c.contact_id`,
        [locationId, a.opportunityId]
      );
      options = people
        .map((r) => ({ ...shapeRecipient(r), isPrimary: !!r.is_primary }))
        .sort((x, y) => Number(y.isPrimary) - Number(x.isPrimary) || x.name.localeCompare(y.name));
    }
    return { byId, byEmail, options };
  });

  // A REPLY GOES BACK TO WHOEVER WROTE THE ORIGINAL. The model's contactId
  // is usually the deal's primary; when the email came from another person
  // on the deal, the reply's To is that person, and the proposal's anchor
  // moves with it.
  let anchorId = a.contactId;
  if (reply?.contact_id && reply.message_direction === 'inbound' && byId[reply.contact_id]?.email) {
    anchorId = reply.contact_id;
  }
  const first = byId[anchorId];
  if (!first) return { needsInfo: ['a contact that exists — that contact id was not found'] };
  if (!first.email) return { needsInfo: [`an email address for ${first.name} — they have none on file`] };

  const missing = [];
  const resolveList = (list) => list.map((x) => {
    const v = String(x || '').trim();
    if (!v) return null;
    if (v.includes('@')) return { email: v.toLowerCase() };
    const hit = byId[v];
    if (!hit) { missing.push(v); return null; }
    if (!hit.email) { missing.push(hit.name); return null; }
    return hit;
  }).filter(Boolean);

  // To is a LIST on the card — the anchor first, then anyone else the rep
  // addressed. On the wire GHL takes one To, so the executor sends the
  // first as To and the rest as CC (see actionExecutor); the card shows
  // what the rep meant, the wire carries what GHL allows.
  const to = [first, ...resolveList(rawTo).filter((r) => r.contactId && r.contactId !== first.contactId)];
  let cc = resolveList(rawCc);
  let bcc = resolveList(rawBcc);

  // A reply with nobody named keeps everyone who was on the original: the
  // other To addresses and the CCs become CC chips, minus our own mailbox
  // and minus the To. Shown on the card rather than applied silently, so
  // the rep can drop anyone before confirming. Our side is whichever
  // addresses are a rep's connected mailbox; if none matches (an address
  // sent from the native path), the direction says which end was ours.
  if (reply && !cc.length && !bcc.length) {
    const ours = new Set();
    for (const e of headerAddrs) {
      if (await mailboxByAddress(locationId, e)) ours.add(e);
    }
    if (!ours.size) {
      const side = reply.message_direction === 'inbound' ? 'to' : 'from';
      for (const e of emailAddrList(reply.raw_message, side)) ours.add(e);
    }
    const toEmails = new Set(to.map((r) => String(r.email).toLowerCase()));
    const others = headerAddrs.filter((e) => !ours.has(e) && !toEmails.has(e));
    cc = others.map((email) => byEmail[email] || { email });
  }

  // De-duplicate across rows; To wins over CC, CC over BCC.
  const seen = new Set();
  const uniq = (list) => list.filter((r) => {
    const k = String(r.email).toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  const toList = uniq(to);
  cc = uniq(cc);
  bcc = uniq(bcc);

  return {
    recipients: { to: toList, cc, bcc },
    options,
    note: missing.length
      ? `Not copied in — no email on file: ${[...new Set(missing)].join(', ')}.`
      : null
  };
}

function shapeRecipient(r) {
  const name = [r.first_name, r.last_name].filter(Boolean).join(' ').trim()
    || r.company_name || r.email || 'Contact';
  return { contactId: r.contact_id, name, email: r.email ? String(r.email).trim().toLowerCase() : null };
}

async function proposeCreateTask(locationId, a) {
  if (!a.contactId || !String(a.title || '').trim()) {
    return { needsInfo: ['which contact', 'the task title'] };
  }

  // Same off-deal warning as propose_send_message, for the same reason: the
  // model chooses the contact id from whatever it read during the turn, so a
  // task asked for on one deal can land on a contact seen elsewhere. A rep
  // reported exactly this — they gave a name and an email, and the card came
  // back addressed to a different person entirely.
  //
  // Allowed, never blocked: a task for someone outside the deal is a normal
  // thing to want, and the rep confirms it. But it must be said FIRST.
  let offDealContact = false;
  let additionalContact = false;
  if (a.opportunityId) {
    const on = await withTenant(locationId, (c) =>
      contactIsOnDeal(c, locationId, a.opportunityId, a.contactId));
    offDealContact = !on.onDeal;
    // On the deal, but not its primary. Routine — a task or message for the
    // architect or the QS is normal work — just worth saying on the card,
    // since "pra" and "bindu" read identically and only one is who a rep
    // would assume.
    additionalContact = on.onDeal && !on.isPrimary;
  }

  const payload = {
    contactId: a.contactId,
    contactName: a.contactName || null,
    title: a.title,
    body: a.body || null,
    dueDate: a.dueDate || null,
    opportunityId: a.opportunityId || null,
    // Same reason as the send card: a task filed against the architect
    // rather than the customer should say so before a rep confirms it.
    isAdditionalContact: additionalContact || undefined
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId || null,
    actionType: 'create_task',
    payload
  });
  return {
    actionId: action.id,
    actionType: 'create_task',
    proposed: payload,
    ...(offDealContact ? {
      warning: 'This contact is not linked to this deal. The task IS drafted. '
             + 'Open your reply with that fact before describing the task, so a '
             + 'rep skimming the first line sees it before they reach Confirm.'
    } : {})
  };
}

async function proposeCompleteTask(locationId, a) {
  if (!a.taskId) {
    return { needsInfo: ['which task'] };
  }
  const payload = {
    taskId: a.taskId,
    taskTitle: a.taskTitle || null,
    completed: a.completed !== false
  };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'complete_task',
    payload
  });
  return { actionId: action.id, actionType: 'complete_task', proposed: payload };
}

async function proposeUpdateTask(locationId, a) {
  if (!a.taskId) return { needsInfo: ['which task'] };
  if (!a.title && !a.body && !a.dueDate) {
    return { needsInfo: ['what to change — a new title, details or due date'] };
  }
  const payload = {
    taskId: a.taskId,
    taskTitle: a.taskTitle || null,
    title: a.title || null,
    body: a.body || null,
    dueDate: a.dueDate || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'update_task',
    payload
  });
  return { actionId: action.id, actionType: 'update_task', proposed: payload };
}

async function proposeDeleteTask(locationId, a) {
  if (!a.taskId) return { needsInfo: ['which task'] };
  const payload = { taskId: a.taskId, taskTitle: a.taskTitle || null };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'delete_task',
    payload
  });
  return { actionId: action.id, actionType: 'delete_task', proposed: payload };
}

async function proposeCreateNote(locationId, a) {
  if (!a.contactId || !String(a.body || '').trim()) {
    return { needsInfo: ['which contact', 'the note text'] };
  }
  const payload = {
    contactId: a.contactId,
    contactName: a.contactName || null,
    body: a.body,
    pinned: a.pinned === true,
    opportunityId: a.opportunityId || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId || null,
    actionType: 'create_note',
    payload
  });
  return { actionId: action.id, actionType: 'create_note', proposed: payload };
}

async function proposeUpdateNote(locationId, a) {
  if (!a.noteId) return { needsInfo: ['which note'] };
  if (a.body === undefined && a.pinned === undefined) {
    return { needsInfo: ['what to change — new text, or a pinned/unpinned state'] };
  }
  const payload = {
    noteId: a.noteId,
    body: a.body ?? null,
    pinned: a.pinned ?? null
  };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'update_note',
    payload
  });
  return { actionId: action.id, actionType: 'update_note', proposed: payload };
}

async function proposeDeleteNote(locationId, a) {
  if (!a.noteId) return { needsInfo: ['which note'] };
  const payload = { noteId: a.noteId };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'delete_note',
    payload
  });
  return { actionId: action.id, actionType: 'delete_note', proposed: payload };
}

async function proposeAddTags(locationId, a) {
  const tags = Array.isArray(a.tags) ? a.tags.filter((t) => String(t || '').trim()) : [];
  if (!a.contactId || !tags.length) return { needsInfo: ['which contact', 'which tag(s)'] };
  const payload = { contactId: a.contactId, contactName: a.contactName || null, tags };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'add_tags',
    payload
  });
  return { actionId: action.id, actionType: 'add_tags', proposed: payload };
}

async function proposeRemoveTags(locationId, a) {
  const tags = Array.isArray(a.tags) ? a.tags.filter((t) => String(t || '').trim()) : [];
  if (!a.contactId || !tags.length) return { needsInfo: ['which contact', 'which tag(s)'] };
  const payload = { contactId: a.contactId, contactName: a.contactName || null, tags };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'remove_tags',
    payload
  });
  return { actionId: action.id, actionType: 'remove_tags', proposed: payload };
}

async function proposeUpdateContact(locationId, a) {
  if (!a.contactId) return { needsInfo: ['which contact'] };
  const editable = ['firstName', 'lastName', 'email', 'phone', 'address', 'city', 'companyName'];
  const hasEdit = editable.some((k) => a[k] !== undefined);
  if (!hasEdit) return { needsInfo: ['what to change'] };
  const payload = { contactId: a.contactId, contactName: a.contactName || null };
  for (const k of editable) payload[k] = a[k] ?? null;
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'update_contact',
    payload
  });
  return { actionId: action.id, actionType: 'update_contact', proposed: payload };
}

async function proposeDeleteDeal(locationId, a) {
  if (!a.opportunityId) return { needsInfo: ['which deal'] };
  const payload = { opportunityId: a.opportunityId, dealName: a.dealName || null };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId,
    actionType: 'delete_deal',
    payload
  });
  return { actionId: action.id, actionType: 'delete_deal', proposed: payload };
}

async function proposeCreateBusiness(locationId, a) {
  if (!String(a.name || '').trim()) return { needsInfo: ['the business name'] };
  const payload = {
    name: a.name,
    email: a.email || null,
    phone: a.phone || null,
    website: a.website || null,
    address: a.address || null,
    city: a.city || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'create_business',
    payload
  });
  return { actionId: action.id, actionType: 'create_business', proposed: payload };
}

async function proposeUpdateBusiness(locationId, a) {
  if (!a.businessId) return { needsInfo: ['which business'] };
  const editable = ['name', 'email', 'phone', 'website', 'address', 'city'];
  const hasEdit = editable.some((k) => a[k] !== undefined);
  if (!hasEdit) return { needsInfo: ['what to change'] };
  const payload = { businessId: a.businessId, businessName: a.businessName || null };
  for (const k of editable) payload[k] = a[k] ?? null;
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'update_business',
    payload
  });
  return { actionId: action.id, actionType: 'update_business', proposed: payload };
}

async function proposeDeleteBusiness(locationId, a) {
  if (!a.businessId) return { needsInfo: ['which business'] };
  const payload = { businessId: a.businessId, businessName: a.businessName || null };
  const action = await proposeAction(locationId, {
    opportunityId: null,
    actionType: 'delete_business',
    payload
  });
  return { actionId: action.id, actionType: 'delete_business', proposed: payload };
}

async function proposeAddFollowers(locationId, a) {
  const ids = Array.isArray(a.followerUserIds) ? a.followerUserIds.filter(Boolean) : [];
  if (!a.opportunityId || !ids.length) return { needsInfo: ['which deal', 'which team member(s)'] };
  const payload = {
    opportunityId: a.opportunityId, followerUserIds: ids, followerNames: a.followerNames || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId,
    actionType: 'add_followers',
    payload
  });
  return { actionId: action.id, actionType: 'add_followers', proposed: payload };
}

async function proposeRemoveFollowers(locationId, a) {
  const ids = Array.isArray(a.followerUserIds) ? a.followerUserIds.filter(Boolean) : [];
  if (!a.opportunityId || !ids.length) return { needsInfo: ['which deal', 'which team member(s)'] };
  const payload = {
    opportunityId: a.opportunityId, followerUserIds: ids, followerNames: a.followerNames || null
  };
  const action = await proposeAction(locationId, {
    opportunityId: a.opportunityId,
    actionType: 'remove_followers',
    payload
  });
  return { actionId: action.id, actionType: 'remove_followers', proposed: payload };
}
