// askPortfolio.js — one question across the whole sub-account.
//
// The model is given a catalogue of read-only CRM tools and calls what it
// needs. This replaced a hardcoded two-step design (deal facts, then selected
// threads) which could only answer the questions that shape anticipated —
// anything about tags, pipeline order, or what changed on a deal had no path
// to an answer even though the data was in Postgres.
//
// See tools/registry.js for why tools are data rather than code.

import { randomUUID } from 'node:crypto';
import { runToolLoop } from './tools/toolLoop.js';
import { TOOL_SYSTEM_PROMPT } from './tools/prompt.js';
import { recordRun, priorDealIdsInConversation } from './runLog.js';
import { linkActionsToRun } from './actionStore.js';
import { getSignature } from '../signatureStore.js';
import { MODEL, classifyError, isContentFiltered } from './claudeClient.js';
import { logger } from '../../utils/logger.js';
import { IMAGE_NOTE } from './askDeal.js';
import { memoriesForPrompt } from './memoryStore.js';
import { memoriesBlock } from './prompts.js';
import { checkGrounding } from './groundingCheck.js';
import { withTenant } from '../../db.js';

const PROMPT_VERSION = 'portfolio-tools.v1';

/**
 * Ask a question spanning every deal in a sub-account.
 *
 * @param {object}  args
 * @param {string}  args.locationId
 * @param {string}  args.question
 * @param {Array}   [args.history]         prior turns, for follow-ups
 * @param {Array}   [args.images]          attached images — { mediaType, data },
 *                                         data as bare base64. A question aid,
 *                                         never evidence — see IMAGE_NOTE.
 * @param {string}  [args.conversationId]  null starts a new thread
 * @param {string}  [args.userId]
 */
export async function askPortfolio({
  locationId,
  question,
  history = [],
  images = [],
  conversationId = null,
  userId = null
}) {
  const convId = conversationId || randomUUID();
  const started = Date.now();

  // Prior turns as plain alternating messages, trimmed. A long thread would
  // otherwise crowd out the tool results the current answer depends on.
  const prior = (Array.isArray(history) ? history : [])
    .slice(-6)
    .filter((h) => h && typeof h.content === 'string')
    .map((h) => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: String(h.content).slice(0, 4000)
    }));

  // The question, with any attached images ahead of the text — same shape
  // askDeal.js uses for its own single-call ask. Images come first because
  // the model reads them as context for the words that follow.
  const questionContent = images?.length
    ? [
        ...images.map((img) => ({
          type: 'image',
          source: { type: 'base64', media_type: img.mediaType, data: img.data }
        })),
        { type: 'text', text: `${IMAGE_NOTE}\n\n${question}` }
      ]
    : question;

  // Appended, not folded into TOOL_SYSTEM_PROMPT: that constant is a plain
  // shared string with no per-user content today, and a rep's memories
  // must never leak into another rep's copy of it.
  const memories = await memoriesForPrompt(locationId, userId);
  const memText = memoriesBlock(memories);
  // Today's date, per-request — without this the model has no way to
  // resolve "last week"/"this month" and either guesses (a factual claim
  // with no tool behind it) or asks the rep to spell out a date range,
  // which is exactly the fact-it-should-just-know failure this line fixes.
  const todayLine = `## Today's date\n${new Date().toISOString().slice(0, 10)} — resolve relative dates ("last week", "this month") against this, don't ask the rep to restate them.`;
  const system = [TOOL_SYSTEM_PROMPT, todayLine, memText].filter(Boolean).join('\n\n');

  let result;
  try {
    result = await runToolLoop({
      locationId,
      system,
      messages: [...prior, { role: 'user', content: questionContent }],
      // Explicit rather than relying on the default: a skill can be scoped to
      // one surface, and which surface is asking decides what it is offered.
      surface: 'portfolio'
    });
  } catch (err) {
    logger.error({ err, locationId }, 'ai: portfolio tool loop failed');
    // Classified the same way the deal AI classifies its failures, rather
    // than flattening everything to 'error' — a rep seeing "the model could
    // not answer" for an exhausted credit balance has no way to know the
    // account needs topping up, and would keep retrying something that
    // cannot succeed.
    const aiStatus = isContentFiltered(err) ? 'content_filtered' : classifyError(err);
    const e = new Error(err.message || 'The model could not answer');
    e.status = aiStatus === 'timeout' ? 504 : aiStatus === 'content_filtered' ? 422 : 502;
    e.aiStatus = aiStatus;
    throw e;
  }

  // The deals the answer touched, so a manager can click through and check.
  // Derived from the tool calls rather than asked of the model: it can be
  // wrong about what it read, the call log cannot.
  //
  // Unioned with EARLIER runs in this conversation ONLY when this turn made
  // no tool calls of its own: a follow-up the model answers straight from
  // its own memory of the thread ("give me the top messages" right after
  // reading a deal) makes no new tool calls, so this run's own list would
  // otherwise be empty and the chip would vanish even though the answer is
  // plainly still about the same deal. But a turn that DID call tools has
  // already made its own fresh determination of what it's about — carrying
  // prior deals forward regardless of that used to drag an earlier, wholly
  // unrelated search_deals answer's deals into a turn that was really about
  // contacts.
  // The full row data behind a "list of deals" answer — the LAST
  // search_deals-shaped call this turn, since a follow-up tool call
  // usually narrows or replaces what the model is actually answering
  // about, not adds to it. Rendered by the frontend as a real table
  // instead of relying on the model to format a long list in prose,
  // which it does not do reliably even with an explicit instruction to
  // (bold-name-plus-run-on-sentence, no real markdown list markers, no
  // matter how the prompt asks for one). null when no list tool ran —
  // the frontend falls back to prose-only in that case.
  const dealsTableCall = [...result.toolCalls].reverse().find((c) => c.dealRows);
  const dealsTable = dealsTableCall?.dealRows || null;

  // The last skill result of the turn, for the frontend to chart. Last rather
  // than first for the same reason dealsTable is: the model often queries
  // broadly, then narrows, and the narrowed one is what the answer is about.
  const skillCall = [...result.toolCalls].reverse().find((c) => c.skillRows?.length);
  const skillResult = skillCall
    ? { name: skillCall.name.replace(/^skill_/, ''), source: skillCall.skillSource, rows: skillCall.skillRows }
    : null;
  // EVERY skill this turn ran, in call order, for the "what was read" line
  // under the answer. skillResult above is the LAST one only, because that is
  // the one worth charting; this is the provenance trail, which is a different
  // question — a manager asking "where did that number come from" is not
  // served by a chart of the final lookup when three ran.
  //
  // Deduped by name: the model often calls one skill several times with
  // different filters while narrowing, and listing it three times reads as
  // three sources rather than one consulted thoroughly. rows is the TOTAL
  // across those calls, so the count still reflects how much was read.
  const skillsUsed = [];
  for (const c of result.toolCalls) {
    if (!c.name?.startsWith('skill_')) continue;
    const name = c.name.replace(/^skill_/, '');
    const found = skillsUsed.find((s) => s.name === name);
    if (found) {
      found.rows += c.skillRows?.length || 0;
      found.calls += 1;
    } else {
      skillsUsed.push({
        name,
        source: c.skillSource || null,
        rows: c.skillRows?.length || 0,
        calls: 1,
      });
    }
  }

  const dealsTableIds = new Set((dealsTable || []).map((d) => d.id));

  // Prior-turn deal ids are only relevant when THIS turn made no tool calls
  // of its own — the "answered from memory of the thread" case the comment
  // below describes. If this turn called ANY tool, it made its own fresh
  // determination of what it's about; unioning in a previous, unrelated
  // turn's deals regardless (as this used to) meant a pure contacts
  // question ("how many contacts created last week", zero deal tool calls)
  // still dragged forward 66 deal chips from an earlier, unrelated
  // search_deals answer in the same conversation.
  const priorDealIds = result.toolCalls.length
    ? []
    : await priorDealIdsInConversation(locationId, convId);
  const dealIds = [...new Set([
    ...priorDealIds,
    ...result.toolCalls.map((c) => c.input?.dealId).filter(Boolean),
    // A deal surfaced as DATA from a list tool (search_deals) rather than
    // fetched by its own dealId — the model can quote its name in the
    // answer either way, so both paths need to produce a clickable chip.
    ...result.toolCalls.flatMap((c) => (c.deals || []).map((d) => d.id))
  ])]
    // Already covered by dealsTable, which the frontend renders instead of
    // the chip row whenever it's present (see CopilotTab.jsx) — no reason
    // to look these up a second time just to build a row nothing will
    // render. A big search_deals answer used to still run dealNamesFor's
    // WHERE opportunity_id = ANY($1) query across every one of those ids
    // (66, in the case that flagged this) purely to feed a UI that never
    // displays them: real DB work for a response field the frontend
    // discards on arrival.
    .filter((id) => !dealsTableIds.has(id));

  const dealNames = dealIds.length ? await dealNamesFor(locationId, dealIds) : new Map();
  // Drop ids that didn't resolve to a live deal, rather than rendering a
  // blank chip that opens into "Deal not found" — dealNamesFor already
  // excludes deleted/ghost rows, so an id missing here is one that no
  // longer names a real, open deal in this account.
  const dealsRead = dealIds
    .filter((id) => dealNames.has(id))
    .map((id) => ({ id, name: dealNames.get(id) }));

  // A coarse check that the answer didn't state a deal-specific £ figure
  // for a deal no tool call this turn (or earlier in the conversation)
  // actually returned — see groundingCheck.js's own header for the real
  // case this exists to catch. Not a full validator (free text has no
  // discrete claims to check the way askDeal.js's citations do); it only
  // flags, never edits or drops the model's own text.
  //
  // DEALS A SKILL NAMED. A skill returns `skillRows` — whatever its view
  // exposes — not the `deals`/`dealRows` shape the deal tools use. Several
  // views carry a deal_name column (migration 132 added it to three of them
  // precisely so the AI says "Acme Roofing" rather than 2lVBs41TxfmKK8U03fIn),
  // and a deal named out of one of those rows is as backed as any other.
  //
  // Without this they were invisible here: knownDeals came back EMPTY on a
  // skill-only turn, so every correctly-named deal beside a figure was
  // flagged "doesn't match anything this turn's lookups returned" — on an
  // answer whose numbers were right. A warning that fires on correct answers
  // is worse than no warning: it teaches people to ignore the banner.
  //
  // DEALS AN EARLIER LIST CALL RETURNED. dealsTable is deliberately only the
  // LAST call with dealRows (it is what gets charted), and dealIds then has
  // those ids filtered OUT of it and resolves the rest through dealNamesFor —
  // which excludes deleted, ghost and missing rows. So a deal a tool really
  // did return, from an earlier call or one since deleted, was absent from
  // both sets and read as unbacked.
  //
  // The tool already gave us the name. For grounding, "a tool returned this"
  // is the whole question, and that is answered by the tool result itself —
  // not by whether the row still resolves in the database now.
  const toolNamedDeals = result.toolCalls.flatMap((c) =>
    [...(c.deals || []), ...(c.dealRows || [])]
      .filter((d) => typeof d?.name === 'string' && d.name.trim())
      .map((d) => ({ id: d.id || null, name: d.name.trim() }))
  );

  const skillNamedDeals = [];
  for (const c of result.toolCalls) {
    for (const r of c.skillRows || []) {
      // Any column that names a deal. Views are not uniform — deal_name is
      // the convention, but `name` and `opportunity_name` both appear.
      const nm = r.deal_name || r.opportunity_name || r.name;
      if (typeof nm === 'string' && nm.trim()) {
        skillNamedDeals.push({ id: r.opportunity_id || null, name: nm.trim() });
      }
    }
  }

  const groundingWarnings = checkGrounding(
    result.answerText,
    [...dealsRead, ...(dealsTable || []), ...toolNamedDeals, ...skillNamedDeals]
  );

  const runId = await recordRun(locationId, {
    callType: 'ask',
    opportunityId: null,
    question,
    model: MODEL,
    promptVersion: PROMPT_VERSION,
    rawOutput: {
      answerText: result.answerText,
      toolCalls: result.toolCalls,
      rounds: result.rounds
    },
    validatedOutput: {
      answerText: result.answerText,
      citations: [],
      confidence: result.stopReason === 'max_rounds' ? 'low' : 'high',
      // Persisted so a reopened past conversation can still show the "READ"
      // chips — without this, portfolioHistory() has no way to reconstruct
      // them (they were only ever returned live, never saved) and every
      // reopened turn silently lost its deal references.
      dealsRead,
      // Same reasoning, for the table — a reopened list-of-deals answer
      // should still render as a table, not fall back to whatever prose
      // the model wrote around it.
      dealsTable,
      skillResult,
      // Persisted too, so reopening a conversation still shows what was read.
      skillsUsed,
      // Same reasoning again — a reopened answer that was flagged as
      // possibly unbacked should still show that warning, not quietly
      // read as settled just because it's no longer live.
      groundingWarning: groundingWarnings[0] || null
    },
    status: 'ok',
    usage: result.usage,
    latencyMs: Date.now() - started,
    conversationId: convId,
    triggeredBy: userId
  });

  // The run didn't exist yet while any propose tool in this turn inserted
  // its ai_actions row (see toolLoop.js) — link them now that it does. Not
  // load-bearing for confirming the action (see linkActionsToRun's own
  // comment), so a failure here isn't worth failing the whole answer over.
  // THE REP'S SIGNATURE, INTO THE DRAFT.
  //
  // Appended here rather than at send time, so it arrives in the editable
  // card: a rep sees exactly what will go out and can trim it for a one-line
  // reply. The cost of that choice is that it can be deleted by accident,
  // which is the trade the alternative (invisible, appended at send) makes in
  // the other direction.
  //
  // Only on Email, and only when the draft does not already end with it — the
  // model sometimes writes its own sign-off, and two is worse than none.
  // Appended to the PROPOSED PAYLOAD only; the stored ai_actions row keeps
  // what the model wrote, so a signature changing later does not rewrite
  // history.
  if (userId && result.proposedActions?.length) {
    try {
      const sig = await getSignature(locationId, userId);
      if (sig?.html) {
        for (const a of result.proposedActions) {
          if (a.actionType !== 'send_message') continue;
          if (a.proposed?.type !== 'Email') continue;
          const body = a.proposed.html || a.proposed.message || '';
          if (body.includes(sig.html)) continue;
          a.proposed = { ...a.proposed, html: `${body}${sig.html}` };
        }
      }
    } catch (err) {
      // A missing signature must never cost a rep their draft.
      logger.warn({ err, locationId, userId }, 'ai: could not attach signature to draft');
    }
  }

  const proposedActionIds = result.proposedActions.map((a) => a.actionId);
  if (proposedActionIds.length) {
    try {
      await linkActionsToRun(locationId, proposedActionIds, runId);
    } catch (err) {
      logger.warn({ err, locationId, runId }, 'ai: failed to link proposed actions to run');
    }
  }

  return {
    answerText: result.answerText,
    citations: [],
    // A run that exhausted its lookups answered from partial information, and
    // the UI should say so rather than presenting it as settled.
    confidence: result.stopReason === 'max_rounds' ? 'low' : 'high',
    answered: !!result.answerText,
    dealsRead,
    // Row data for the deals a list tool (search_deals) surfaced this turn,
    // for the frontend to render as a real table — see the comment where
    // this is built above. null when the answer isn't backed by a list.
    dealsTable,
    skillResult,
    // Every skill this turn ran, deduped, for the "what was read" line under
    // the answer. See where it is built above.
    skillsUsed,
    // What it actually looked at — the audit trail a rep can check the answer
    // against, and the closest thing a tool answer has to a citation.
    toolCalls: result.toolCalls,
    // Proposed writes this turn made — the frontend renders one ActionCard
    // per entry, each independently confirmable/cancellable. Carries the
    // full proposed payload already, so no extra round trip is needed to
    // render the card.
    proposedActions: result.proposedActions,
    scopeNote: result.stopReason === 'max_rounds'
      ? 'This answer ran out of lookups — it may be incomplete.'
      : null,
    // See groundingCheck.js — a deal-specific figure the model stated that
    // no lookup this turn (or earlier in the conversation) actually backs.
    // Shown as its own banner, not folded into scopeNote: the two fire for
    // different reasons (ran out of budget vs. possibly fabricated) and a
    // rep should read them differently.
    groundingWarning: groundingWarnings[0] || null,
    conversationId: convId,
    runId,
    cached: false
  };
}

// Name lookup for the "READ" chips — the tool call log only ever kept
// { name, input, rows } (see toolLoop.js), never the deal's own name from
// the tool's result, so it has to be re-fetched here rather than carried
// through from the tool run itself.
//
// Same is_deleted/is_ghost/deleted_at exclusion searchDeals itself uses.
// Without it, an id surfaced in an EARLIER turn (via priorDealIdsInConversation)
// whose deal has since been deleted/ghosted in GHL resolves to no row here —
// dealsRead then renders a chip with name: null (a blank, unlabelled pill)
// that opens straight into "Deal not found" on click. Filtering here, not
// just at dealsRead-build time, means the id is dropped before it ever
// becomes a chip at all.
async function dealNamesFor(locationId, dealIds) {
  if (!dealIds.length) return new Map();
  return withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT opportunity_id, name FROM opportunities
        WHERE location_id = $1 AND opportunity_id = ANY($2::text[])
          AND is_deleted = false AND deleted_at IS NULL AND is_ghost = false`,
      [locationId, dealIds]
    );
    return new Map(rows.map((r) => [r.opportunity_id, r.name]));
  });
}
