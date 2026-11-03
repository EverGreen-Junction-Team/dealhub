import { randomUUID } from 'node:crypto';
import { callClaude, MODEL, classifyError, isContentFiltered } from './claudeClient.js';
import { buildDealContext, cacheKeyFor, logContextSize } from './contextBuilder.js';
import { systemBlocks, threadBlock, PROMPT_VERSIONS } from './prompts.js';
import { memoriesForPrompt } from './memoryStore.js';
import { makeValidator, normaliseCitationShape } from './validate.js';
import { sourceOf } from './citationSource.js';
import { findCachedRun, recordRun, clearRunCacheKey } from './runLog.js';
import { detectDealAction } from './dealActionDetector.js';
import { runToolLoop } from './tools/toolLoop.js';
import { TOOL_SYSTEM_PROMPT, DEAL_TOOL_PROMPT } from './tools/prompt.js';
import { COMPOSER_POINTER } from './tools/registry.js';
import { evidenceFromToolCalls } from './toolEvidence.js';
import { linkActionsToRun, resolveAction } from './actionStore.js';
import { getSignature } from '../signatureStore.js';
import crypto from 'node:crypto';
import { logger } from '../../utils/logger.js';
import { withTenant } from '../../db.js';

// Call 2 — Ask this deal (spec §3).
//
// Read-only, so this is the first call shipped: no write path, no proposals to
// confirm, and it exercises the whole context-builder + citation-validation
// pipeline that Calls 1 and 3 depend on. The Prompts tiles in the UI use this
// same call with pre-written questions — not a different mechanism.

const ANSWER_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['answer_text', 'citations', 'confidence'],
  properties: {
    answer_text: {
      type: 'string',
      description:
        'The answer, in plain prose. Every factual sentence must be backed by a citation. If the thread does not answer the question, say so plainly — that is a valid answer.'
    },
    citations: {
      type: 'array',
      description:
        'One entry per message you relied on. quote_text must be copied verbatim from the cited message.',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['message_id', 'quote_text'],
        properties: {
          message_id: { type: 'string' },
          quote_text: { type: 'string' }
        }
      }
    },
    confidence: {
      type: 'string',
      enum: ['high', 'medium', 'low'],
      description:
        'high = the thread states this directly; medium = reasonable reading of the thread; low = thin evidence. Use low rather than inventing certainty.'
    },
    answered: {
      type: 'boolean',
      description: 'false when the thread does not contain the answer.'
    }
  }
};

// "Working on that." used to be what the answer call said for an instruction-
// shaped question, back when a SECOND step did the drafting and this sentence
// was only ever a placeholder to be swapped for that step's real one.
//
// Since the port to the tool loop the model drafts in the same pass — it has
// propose_send_message and the other propose_* tools — so INSTRUCTION no
// longer asks for this sentence at all. It survived the port, though, and the
// result was a rep asking "draft a message" and getting back the literal
// words "Working on that." with no draft: the step it was deferring to had
// been removed, so nothing ever replaced it.
//
// The pattern is KEPT as a safety net. A model that still emits the sentence
// (it is in older history, and history is replayed into the prompt) must not
// have it shown — if the detector produced a real note, that note replaces
// it, exactly as before.
const PLACEHOLDER = /^\s*working on that\.?\s*$/i;

// What a failed detector run yields: nothing proposed, nothing to say. The
// answer is still served — detection is a second chance, never the answer.
const NO_DETECTION = Object.freeze({ proposedActions: Object.freeze([]), note: null });

// Drop a proposed send that has ALREADY GONE OUT.
//
// The sequence that produced this: a rep asked "send bindu 'how are you'",
// confirmed the card, came back later and asked the same thing. The sent
// message had not reached our messages table yet (a custom-provider send
// does not always webhook back promptly), so the thread looked unchanged,
// the cached answer replayed "Draft ready — confirm to send", and the
// detector minted a fresh pending send. To the rep: a card asking them to
// confirm something they had already sent.
//
// Matched on what actually left: the deal, the contact, the channel and the
// text, against sends CONFIRMED in the last two hours (edited_payload wins
// over proposed_payload — the rep may have reworded before confirming).
// The duplicate's pending row is marked rejected so nothing dangles, and
// the answer says when the original went. Bypassed when the rep plainly
// asked for another copy — "send it again", "resend", "one more time".
const RESEND_WORDS = /\b(again|re-?send|resend|one more|second time|another)\b/i;
async function suppressAlreadySent(locationId, opportunityId, question, actions) {
  const sends = (actions || []).filter((a) => a.actionType === 'send_message');
  if (!sends.length || !opportunityId || RESEND_WORDS.test(question || '')) {
    return { actions: actions || [], note: null };
  }
  let recent;
  try {
    recent = await withTenant(locationId, async (c) => {
      const { rows } = await c.query(
        `SELECT COALESCE(edited_payload, proposed_payload) AS payload, resolved_at
           FROM ai_actions
          WHERE location_id = $1 AND opportunity_id = $2
            AND action_type = 'send_message' AND status = 'confirmed'
            AND resolved_at > now() - interval '2 hours'
          ORDER BY resolved_at DESC`,
        [locationId, opportunityId]
      );
      return rows;
    });
  } catch (err) {
    logger.warn({ err, locationId, opportunityId }, 'ai: already-sent check failed (proposal kept)');
    return { actions: actions || [], note: null };
  }
  if (!recent.length) return { actions: actions || [], note: null };

  const norm = (v) => String(v || '').replace(/\s+/g, ' ').trim().toLowerCase();
  const keep = [];
  const notes = [];
  for (const a of actions) {
    if (a.actionType !== 'send_message') { keep.push(a); continue; }
    const p = a.proposed || {};
    const dup = recent.find((r) => {
      const q = r.payload || {};
      return norm(q.contactId) === norm(p.contactId)
        && norm(q.type) === norm(p.type)
        && norm(q.message || q.html) === norm(p.message || p.html);
    });
    if (!dup) { keep.push(a); continue; }
    const mins = Math.max(1, Math.round((Date.now() - new Date(dup.resolved_at).getTime()) / 60000));
    const when = mins < 60 ? `${mins} minute${mins === 1 ? '' : 's'} ago` : `${Math.round(mins / 60)} hour${mins < 90 ? '' : 's'} ago`;
    notes.push(`That message already went to ${p.contactName || 'this contact'} by ${p.type || 'message'} ${when} — nothing was sent again. Say "send it again" if you want a second copy.`);
    try {
      await resolveAction(locationId, a.actionId, { status: 'rejected', result: { reason: 'duplicate_of_recent_send' } });
    } catch (err) {
      logger.warn({ err, locationId, actionId: a.actionId }, 'ai: could not reject duplicate send proposal');
    }
  }
  return { actions: keep, note: notes.length ? notes.join(' ') : null };
}

function mergeAnswerAndNote(answerText, note) {
  if (!note) return answerText;
  return PLACEHOLDER.test(answerText || '') ? note : `${answerText}\n\n${note}`;
}

const INSTRUCTION = `Answer the question using ONLY the message thread and notes above.

- A request to DO something in the CRM — "create a task", "add a note", "mark it lost", "update the value" — IS your job. You have the propose_* tools for it: call propose_create_task, propose_create_note and the rest, and produce the draft itself. Do not describe what you would do and do not reply that you are working on it. Never say such a request cannot be done and never tell the rep to use the CRM directly.
- The ONE exception is messaging a customer. You cannot send, draft or propose an email, SMS, WhatsApp or reply from here. When the rep asks you to email, text, WhatsApp, message or reply to anyone, do not write the message and do not ask what it should say — your whole answer is exactly: "${COMPOSER_POINTER}"
- If the thread does not answer it, set answered=false and say so in one sentence — then add a second, short sentence pointing the rep somewhere useful. Do not fill the gap with plausible reasoning, and do not stop at "that isn't here": a dead end is a worse answer than a redirection.
  - If the question was about THIS deal but the thread is silent on it, name what the thread DOES cover that is closest — e.g. "Nothing here mentions pricing, but the last three messages are all about the survey date."
  - If the question was really about the wider account rather than this deal — totals across the system, other deals, overall contact or pipeline counts — say that this view only reads this deal's own conversation, then just say to ask Insights AI. Name it exactly: "Insights AI", and stop there — do not explain what Insights AI is or how it works. The rep already knows; it is a tab they can see.
  - Keep both sentences plain and short. No apology, no hedging.
- Every factual sentence in answer_text must be supported by a citation.
- Be brief and concrete. A sales manager is reading this between calls: lead with the answer, then the evidence.
- Refer to people by name, not by contact id.
- Dates: say "8 Aug" or "three weeks ago", never a raw timestamp.`;

/**
 * @param {object}  args
 * @param {string}  args.locationId
 * @param {string}  args.opportunityId
 * @param {string}  args.question
 * @param {Array}   [args.history]   prior [{role, content}] Q&A on this deal
 * @param {string}  [args.userId]
 */// Told to the model only when an image is attached.
//
// Without this the model would happily describe the image and cite nothing —
// validate.js would then drop the claim, and the rep would see an answer with
// a hole in it and no explanation. Better to state the boundary up front.
export const IMAGE_NOTE = `The user has attached one or more images to this question. Use them to understand WHAT IS BEING ASKED — they are context for the question, not evidence about the deal.

You must not make factual claims about the deal based on an image: rule 1 still applies, so every claim needs a verbatim quote from a message in the thread. If the image shows something the thread does not mention, say that the thread does not establish it.`;

export async function askDeal({
  locationId,
  opportunityId,
  question,
  history = [],
  // { messageId, subject } when the rep pressed Reply on an email in the
  // timeline. Appended to what the MODEL reads, never to the question as
  // typed — the rep sees "Reply to the email 'how are you'", the model also
  // gets the id, so the reply threads onto that exact email rather than any
  // email with that subject.
  replyTo = null,
  images = [],
  channels = null,
  conversationId = null,
  userId = null
}) {
  // A question with no conversation starts one. Generated HERE rather than in
  // the route so every path that reaches askDeal — including future callers —
  // lands in a conversation, and the client gets an id back to send with the
  // follow-up.
  const convId = conversationId || randomUUID();
  const modelQuestion = replyTo?.messageId
    ? `${question}\n\n(Reply context: the rep pressed Reply on the email with message id ${replyTo.messageId}`
      + `${replyTo.subject ? ` — subject "${replyTo.subject}"` : ''}. Reply to THAT email: pass its id as replyToMessageId.)`
    : question;
  // Per-phase wall time, logged once at the end — so "the AI is slow" can
  // be answered with which phase, not a guess.
  const phases = {}; let mark = Date.now();
  const lap = (name) => { phases[name] = Date.now() - mark; mark = Date.now(); };
  const ctx = await buildDealContext(locationId, opportunityId, { channels });
  lap('context');
  if (!ctx) {
    const err = new Error('Deal not found');
    err.status = 404;
    throw err;
  }
  logContextSize(ctx, 'ask');

  // Nothing readable → don't spend a call to be told there's nothing.
  //
  // But STILL check for a write action. "Send them a message" / "create a task"
  // does not need a thread to read — it needs a contact, which a deal has even
  // when nobody has messaged yet. This used to return proposedActions: [] flat,
  // so on a brand-new deal the AI answered "there is nothing to read" and
  // silently dropped the request, with no card and no explanation. A deal with
  // no conversation is exactly when a rep is most likely to be starting one.
  //
  // TASKS COUNT. This checked messages and notes only, so a deal whose evidence
  // is entirely tasks short-circuited to "there is nothing to read" without the
  // model ever being asked — on a deal plainly showing two tasks in the rail
  // beside the answer. Tasks are first-class citable evidence by rule 7 of the
  // system prompt, and promptBlock already renders them under "Tasks our team
  // recorded"; only this guard disagreed.
  if (ctx.messages.length === 0 && ctx.notes.length === 0 && (ctx.tasks?.length ?? 0) === 0) {
    let emptyActions = [];
    let emptyNote = null;
    try {
      const detected = await detectDealAction({
        locationId, opportunityId, question: modelQuestion,
        people: ctx.people, tasks: ctx.tasks, notes: ctx.notes, messages: ctx.messages,
        fields: ctx.deal?.fields || [], userId
      });
      const sup = await suppressAlreadySent(locationId, opportunityId, question, detected.proposedActions);
      emptyActions = sup.actions;
      emptyNote = [detected.note, sup.note].filter(Boolean).join(' ') || null;
    } catch (err) {
      logger.warn({ err, locationId, opportunityId },
        'ai: action detection failed on an empty thread (answer still served)');
    }

    const base = ctx.channelScope
      ? `No readable ${ctx.channelScope.map((c) => c.toUpperCase()).join(' or ')} messages on this deal — try widening the channel filter.`
      : 'There are no messages, notes or tasks on this deal yet, so there is nothing to read.';

    const emptyOutput = {
      // When an action WAS proposed, the detector's own sentence is the useful
      // half — "I've drafted the message" — and the "nothing to read" line is
      // noise in front of it. Lead with the action.
      // A draft answers the question; "nothing to read" does not add to it.
      answerText: emptyNote || base,
      citations: [],
      confidence: 'high',
      answered: false
    };

    // Recorded like any other turn, for the same reason as the cache path: the
    // sidebar is built from ai_runs, so returning runId: null produced a chat
    // that vanished on refresh. "Nothing to read yet" is still a real exchange
    // a rep may want to reopen — especially when it carried a proposal.
    let emptyRunId = null;
    try {
      emptyRunId = await recordRun(locationId, {
        callType: 'ask',
        opportunityId,
        conversationId: convId,
        inputMessageIds: [],
        cacheKey: null,
        configVersion: ctx.cacheKeyParts.configVersion,
        question,
        model: MODEL,
        promptVersion: PROMPT_VERSIONS.ask,
        rawOutput: null,
        validatedOutput: emptyOutput,
        status: 'ok',
        coverage: ctx.coverage
      });
      if (emptyActions.length && emptyRunId) {
        await linkActionsToRun(locationId, emptyActions.map((a) => a.actionId), emptyRunId);
      }
    } catch (err) {
      logger.warn({ err, locationId, opportunityId },
        'ai: failed to record a run for an empty thread (answer still served)');
    }

    return {
      ...emptyOutput,
      coverage: ctx.coverage,
      cached: false,
      runId: emptyRunId,
      conversationId: convId,
      proposedActions: emptyActions
    };
  }

  // Attached images are part of the question's identity. Without this, asking
  // the same words WITH an image would serve the cached image-free answer —
  // the attachment would appear to be ignored. Hashed rather than embedded so
  // the key stays short.
  const imageFingerprint = images.length
    ? `::images=${crypto.createHash('sha256')
        .update(images.map((i) => `${i.mediaType}:${i.data.length}`).join('|'))
        .digest('hex').slice(0, 16)}`
    : '';

  const cacheKey = cacheKeyFor({
    callType: 'ask',
    cacheKeyParts: ctx.cacheKeyParts,
    question: (ctx.channelScope
      ? `${question}::channels=${ctx.channelScope.join(',')}`
      : question) + imageFingerprint + (replyTo?.messageId ? `::replyTo=${replyTo.messageId}` : '')
  });

  // Only cache single-shot questions. A follow-up depends on the chat history,
  // which isn't in the key — serving a cached answer there would ignore the
  // conversation.
  if (history.length === 0) {
    const hit = await findCachedRun(locationId, { callType: 'ask', cacheKey });
    if (hit?.validated_output) {
      logger.info({ opportunityId, runId: hit.id }, 'ai: ask served from cache');

      // Same detector the live path runs — see the note on proposedActions
      // below. Failures are swallowed: a cached ANSWER is still a good answer,
      // and losing the proposal is better than losing the whole turn.
      let cachedActions = [];
      let cachedNote = null;
      try {
        const detected = await detectDealAction({
          locationId, opportunityId, question: modelQuestion,
          people: ctx.people, tasks: ctx.tasks, notes: ctx.notes, messages: ctx.messages,
        fields: ctx.deal?.fields || [], userId
        });
        const sup = await suppressAlreadySent(locationId, opportunityId, question, detected.proposedActions);
        cachedActions = sup.actions;
        cachedNote = [detected.note, sup.note].filter(Boolean).join(' ') || null;
      } catch (err) {
        logger.warn({ err, locationId, opportunityId },
          'ai: action detection failed on a cached answer (answer still served)');
      }

      const cachedOutput = { ...hit.validated_output };
      cachedOutput.answerText = mergeAnswerAndNote(cachedOutput.answerText, cachedNote);

      // Record a run for the cached answer too.
      //
      // Recents is built from ai_runs (see runLog.askHistory), so a path that
      // returns without recording produces a chat that is on screen but absent
      // from the sidebar — and gone entirely after a refresh. A rep asking a
      // question they had asked before got exactly that: an answer, then no
      // history entry, then nothing on reload.
      //
      // Deliberately NOT cacheKey: this row must never itself be served as a
      // cache hit, or one cached answer would seed another. It is a history
      // entry, not a cache entry. The model was not called, so there is no new
      // raw output to store — the validated answer is what a reopened chat
      // renders, and that is what is kept.
      let cachedRunId = hit.id;
      try {
        cachedRunId = await recordRun(locationId, {
          callType: 'ask',
          opportunityId,
          conversationId: convId,
          inputMessageIds: ctx.cacheKeyParts.messageIds,
          cacheKey: null,
          configVersion: ctx.cacheKeyParts.configVersion,
          question,
          model: MODEL,
          promptVersion: PROMPT_VERSIONS.ask,
          rawOutput: null,
          validatedOutput: cachedOutput,
          status: 'ok',
          // recordRun reads these from run.coverage, not from flat fields —
          // passing them flat would have written three NULLs and the reopened
          // chat would show "Read null of null messages".
          coverage: {
            messagesTotal: hit.messages_total ?? ctx.coverage.messagesTotal,
            messagesRead: hit.messages_read ?? ctx.coverage.messagesRead,
            unreadReasons: hit.unread_reasons ?? ctx.coverage.unreadReasons
          }
        }) || hit.id;
        if (cachedActions.length) {
          await linkActionsToRun(locationId, cachedActions.map((a) => a.actionId), cachedRunId);
        }
      } catch (err) {
        // A missing history row is worse than a wrong one, but neither is worth
        // losing the answer over.
        logger.warn({ err, locationId, opportunityId },
          'ai: failed to record a run for a cached answer (answer still served)');
      }

      return {
        ...cachedOutput,
        coverage: {
          ...ctx.coverage,
          readAt: hit.created_at,
          messagesTotal: hit.messages_total ?? ctx.coverage.messagesTotal,
          messagesRead: hit.messages_read ?? ctx.coverage.messagesRead,
          unreadReasons: hit.unread_reasons ?? ctx.coverage.unreadReasons
        },
        cached: true,
        runId: cachedRunId,
        // Action detection RUNS on a cache hit — only the answer text is reused.
        //
        // This used to return [] on the reasoning that a repeat question is
        // rarely a new write request. That was wrong, and it failed in the most
        // visible way possible: a rep asked "can you create a task for me?",
        // had asked it once before, and got the CACHED read-only answer — "there
        // is no record that a task titled ... was created". The AI appeared to
        // refuse a request it had happily proposed a moment earlier on the
        // portfolio tab, because the write path was never consulted at all.
        //
        // Detection is a separate, small call that does not read the thread, so
        // running it here costs one bounded round trip and keeps the expensive
        // part (the citation-verified answer) cached. A proposal is a fresh
        // ai_actions row every time, so nothing stale is resurfaced.
        proposedActions: cachedActions,
        // The cache only serves a FIRST question (history.length === 0), so
        // this is always the start of a conversation — but it still has to be
        // returned, or the follow-up would open a second one.
        conversationId: convId
      };
    }
  }

  // Message order is the cache-friendly order: stable thread first, then the
  // volatile history and question last.
  const messages = [
    // threadBlock returns content BLOCKS, not a string: the older, stable part
    // of the thread carries a cache breakpoint so it isn't re-billed on every
    // question. On a long deal the thread is >90% of input tokens, and it is
    // append-only — yesterday's messages never change.
    { role: 'user', content: threadBlock(ctx) },
    { role: 'assistant', content: 'Understood. I have read the thread. What would you like to know?' },
    ...history.slice(-6).map((h) => ({
      role: h.role === 'assistant' ? 'assistant' : 'user',
      content: String(h.content || '').slice(0, 4000)
    })),
    // The question, with any attached images ahead of the text.
    //
    // Images come FIRST because the model reads them as context for the words
    // that follow. They sit below every cache breakpoint, so an attachment
    // never invalidates the cached thread.
    {
      role: 'user',
      content: images.length
        ? [
            ...images.map((img) => ({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.data }
            })),
            { type: 'text', text: `${INSTRUCTION}\n\n${IMAGE_NOTE}\n\n## Question\n${modelQuestion}` }
          ]
        : `${INSTRUCTION}\n\n## Question\n${modelQuestion}`
    }
  ];

  const memories = await memoriesForPrompt(locationId, userId);

  // ── TOOLS, SCOPED TO THIS DEAL ──────────────────────────────────────
  //
  // This call used to be a single callClaude against a context assembled
  // before the question was read: one shot, no lookups. It answered "what
  // does the thread say" well and anything else with "Working on that."
  //
  // It now runs the same loop the portfolio surface uses, with two
  // differences that matter:
  //
  //   * surface: 'deal' — toolCatalogue drops the 21 account-wide tools, so
  //     29 remain: the six per-deal reads and the writes that act on one
  //     deal. search_deals, get_rep_performance and friends are not offered.
  //   * dealId — runTool FORCES this onto every deal-scoped argument, so a
  //     model that passes another deal's id reads this one anyway. The
  //     catalogue decides what is offered; that decides what can run.
  //
  // The pre-built context is still sent. It is what makes the first answer
  // fast and what the citation validator and sourceOf() read; tools add to
  // it rather than replace it.
  // THE DETECTOR RUNS ALONGSIDE THE ANSWER, not after it. It reads the
  // question and the deal context — never the answer — so it has no reason
  // to wait for the tool loop, and waiting cost a whole model round trip on
  // every question. Started here, collected below once the answer is
  // validated. A failure here must not fail the answer: it resolves to an
  // empty detection and logs, same as the empty-thread and cached paths.
  const detectPromise = detectDealAction({
    locationId, opportunityId, question: modelQuestion,
    people: ctx.people, tasks: ctx.tasks, notes: ctx.notes, messages: ctx.messages,
    fields: ctx.deal?.fields || [], userId
  }).catch((err) => {
    logger.warn({ err, locationId, opportunityId }, 'ai: action detection failed (answer still served)');
    return NO_DETECTION;
  });

  let toolResult;
  try {
    toolResult = await runToolLoop({
    locationId,
    userId,
    surface: 'deal',
    dealId: opportunityId,
    system: [
      ...systemBlocks(ctx, { memories }),
      { type: 'text', text: TOOL_SYSTEM_PROMPT },
      // Corrects the two instructions in TOOL_SYSTEM_PROMPT that do not hold
      // on a deal: its "whole pipeline" framing, and rule 13's
      // search_contacts — which the deal catalogue withholds. Without this a
      // model following rule 13 reaches for a tool that is not there.
      { type: 'text', text: DEAL_TOOL_PROMPT }
    ],
    messages
    });
  } catch (err) {
    // Classified like every other model failure, so the route answers with a
    // readable message and a code instead of a bare 500. Before this the
    // tool-loop path was the one caller that let a provider error through
    // raw — the rep saw "Request failed with status code 500" for a filter
    // refusal that has nothing to do with the server.
    logger.error({ err, locationId, opportunityId }, 'ai: deal tool loop failed');
    const aiStatus = isContentFiltered(err) ? 'content_filtered' : classifyError(err);
    const e = new Error(err.message || 'The model could not answer');
    e.status = aiStatus === 'timeout' ? 504 : aiStatus === 'content_filtered' ? 422 : 502;
    e.aiStatus = aiStatus;
    throw e;
  }

  // ── CITATIONS AFTER THE LOOP, NOT INSIDE IT ─────────────────────────
  //
  // runToolLoop returns PROSE. It cannot return the citation schema: a tool
  // turn ends whenever the model stops calling tools, and forcing a JSON
  // schema onto that would make every intermediate round try to satisfy it.
  //
  // So the answer is written first, then a second, small call extracts the
  // citations from it — against the same evidence the answer was built on,
  // with the same verbatim-quote rule the single-call version enforced. The
  // guarantee is unchanged; it moved one step later.
  lap('toolLoop');
  const toolEvidence = evidenceFromToolCalls(toolResult.toolCalls || []);
  const citeResult = toolResult.answerText
    ? await extractCitations(ctx, toolEvidence, toolResult.answerText)
    : { status: 'ok', output: null };
  lap('citations');

  const result = {
    status: toolResult.answerText ? 'ok' : (toolResult.status || 'error'),
    output: toolResult.answerText
      ? {
          answer_text: toolResult.answerText,
          citations: citeResult.output?.citations || [],
          // The loop has no confidence field. 'medium' rather than 'high':
          // claiming high confidence the model never expressed would be an
          // invention, and the grounding check is what flags a shaky answer.
          confidence: citeResult.output?.confidence || 'medium',
          answered: true
        }
      : null,
    error: toolResult.error || null,
    usage: toolResult.usage,
    latencyMs: toolResult.latencyMs
  };

  let validated = null;
  let rejected = [];

  if (result.status === 'ok' && result.output) {
    // Rows the model FETCHED this turn are citable too (toolEvidence, built
    // above). Without them a citation to a message the model went and looked
    // up would be rejected as unquotable — penalising it for doing the right
    // thing. The standard is unchanged: the quote must appear verbatim.
    const { citations, rejected: citeRejects } =
      validateAnswer(ctx, result.output, toolEvidence);
    rejected = citeRejects;
    validated = {
      answerText: result.output.answer_text,
      citations,
      confidence: result.output.confidence,
      answered: result.output.answered !== false
    };
  }

  const runId = await recordRun(locationId, {
    callType: 'ask',
    opportunityId,
    inputMessageIds: ctx.cacheKeyParts.messageIds,
    // A run that PROPOSED A WRITE is never cached. Replaying "Draft ready —
    // confirm to send" to a later identical question re-proposes a send the
    // rep may have already made; the detector's own proposals are handled
    // the same way below, once they are known.
    cacheKey: history.length === 0 && !(toolResult.proposedActions || []).length ? cacheKey : null,
    configVersion: ctx.cacheKeyParts.configVersion,
    question,
    model: MODEL,
    promptVersion: PROMPT_VERSIONS.ask,
    rawOutput: result.output,
    validatedOutput: validated,
    rejectedItems: rejected,
    coverage: ctx.coverage,
    status: result.status,
    error: result.error,
    usage: result.usage,
    latencyMs: result.latencyMs,
    conversationId: convId,
    triggeredBy: userId
  });

  if (result.status !== 'ok') {
    const err = new Error(result.error || 'The model could not answer');
    err.status = result.status === 'timeout' ? 504 : 502;
    err.aiStatus = result.status;
    err.runId = runId;
    throw err;
  }

  // A SEPARATE, small second call — never folded into the schema-validated
  // answer above. askDeal.js's own citation pipeline stays exactly as it
  // was; this only adds a proposal on top when the question also asked for
  // a CRM write. See dealActionDetector.js's header for why this is a
  // distinct call rather than a tool-loop migration. Skipped when nothing
  // was actually answered (validated is null) — there is no sound answer to
  // attach a proposal to, and a failed/empty turn is not the place to also
  // start guessing at a write action.
  // DRAFTS THE MODEL MADE ITSELF, VIA THE TOOLS.
  //
  // The loop's propose_* tools write an ai_actions row and return it (see
  // toolLoop.js). askPortfolio has always read these; this surface did not,
  // because when it was written the ONLY way a deal action could appear was
  // the detector below. After the port the model has propose_send_message on
  // its catalogue and calls it — so a draft it produced was stored, and then
  // dropped on the floor here, never reaching the rep as a card.
  let proposedActions = [...(toolResult.proposedActions || [])];

  if (validated) {
    const detected = await detectPromise;
    lap('detectorWait');
    // The detector is a SECOND chance, not a replacement: it catches the
    // instruction-shaped question the model answered in prose without
    // reaching for a tool. Concatenated rather than assigned — assigning
    // discarded whatever the loop had already drafted.
    //
    // Deduped by actionType so a question the model AND the detector both
    // acted on does not render two cards proposing the same thing; the
    // model's own draft wins, since it was written with the tool results in
    // hand.
    for (const a of detected.proposedActions) {
      if (!proposedActions.some((p) => p.actionType === a.actionType)) {
        proposedActions.push(a);
      }
    }
    if (detected.note) {
      // The detector's sentence REPLACES the answer when the answer was only a
      // placeholder for it.
      //
      // Two model calls see this turn: the answer call reads the thread, the
      // detector handles write requests. The answer call knows nothing about
      // the detector, so on "send them a message" it used to reason from the
      // thread alone and conclude it could not help — "there is nothing in this
      // deal's record that lets me send a message, use the CRM's messaging tool
      // directly" — and the detector's "I can draft an SMS, what should it say?"
      // was appended underneath it. A rep read a refusal followed by an offer.
      //
      // The answer call is no longer told to say "Working on that." — it
      // drafts via propose_send_message itself. The swap stays as a safety
      // net for a model that emits the sentence anyway (it is in older
      // history, which is replayed into the prompt). Anything else it
      // produced is a real answer and the note is appended as before.
      validated.answerText = mergeAnswerAndNote(validated.answerText, detected.note);
    }
    // The rep's signature on an emailed draft, exactly as askPortfolio does
    // it — appended to the PROPOSED PAYLOAD only, so the stored ai_actions row
    // keeps what the model wrote and a signature changed later does not
    // rewrite history. Skipped when the model already signed off; two
    // signatures is worse than none.
    if (detected.proposedActions.length) {
      try { await clearRunCacheKey(locationId, runId); }
      catch (err) { logger.warn({ err, locationId, runId }, 'ai: could not uncache a run that proposed a write'); }
    }
    {
      const sup = await suppressAlreadySent(locationId, opportunityId, question, proposedActions);
      proposedActions = sup.actions;
      if (sup.note) validated.answerText = mergeAnswerAndNote(validated.answerText, sup.note);
    }
    if (userId && proposedActions.length) {
      try {
        const sig = await getSignature(locationId, userId);
        if (sig?.html) {
          for (const a of proposedActions) {
            if (a.actionType !== 'send_message') continue;
            if (a.proposed?.type !== 'Email') continue;
            const body = a.proposed.html || a.proposed.message || '';
            if (body.includes(sig.html)) continue;
            a.proposed = { ...a.proposed, html: `${body}${sig.html}` };
          }
        }
      } catch (err) {
        // A missing signature must never cost a rep their draft.
        logger.warn({ err, locationId, userId }, 'ai: could not attach signature to deal draft');
      }
    }

    if (proposedActions.length) {
      try {
        await linkActionsToRun(locationId, proposedActions.map((a) => a.actionId), runId);
      } catch (err) {
        logger.warn({ err, locationId, runId }, 'ai: failed to link proposed actions to run');
      }
    }
  }

  phases.total = Object.values(phases).reduce((a, b) => a + b, 0);
  logger.info(
    { opportunityId, runId, rounds: toolResult.rounds, ...phases },
    'ai: ask timing (ms)'
  );

  return {
    ...validated,
    coverage: ctx.coverage,
    cached: false,
    runId,
    proposedActions,
    // The client sends this back on the follow-up, which is what keeps a
    // thread together instead of each question standing alone.
    conversationId: convId,
    channelScope: ctx.channelScope,
    // What the model actually read. The request body carries no message list
    // (the server derives it under RLS), so this is how the client — and you,
    // in the Network tab — can confirm the set, including that an excluded
    // message was left out.
    readMessageIds: ctx.cacheKeyParts.messageIds
  };
}

// Citations are validated but a failure doesn't kill the answer — the prose
// may still be sound, so we strip the unverifiable link and keep the text.
// ── CITATION EXTRACTION (deal surface, second pass) ──────────────────
//
// The tool loop writes prose; this turns that prose into citations. A small,
// cheap call with a tight schema, given only the evidence the turn actually
// used — the context's messages plus whatever tools fetched.
//
// WHY NOT ASK THE LOOP FOR CITATIONS DIRECTLY. A tool turn ends when the
// model stops calling tools, so a JSON schema would have to be satisfied on
// every intermediate round too. Separating them keeps each call doing one
// thing, and keeps this one cheap enough to always run.
//
// Anything it returns still goes through makeValidator afterwards. This call
// PROPOSES citations; validate.js decides which survive. A hallucinated quote
// is caught there exactly as it was before, so the weaker model used here
// cannot weaken the guarantee.
const CITATION_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['citations'],
  properties: {
    citations: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['message_id', 'quote_text'],
        properties: {
          message_id: { type: 'string' },
          quote_text: {
            type: 'string',
            description: 'Copied VERBATIM from that row. Not paraphrased, not trimmed.'
          }
        }
      }
    },
    confidence: { type: 'string', enum: ['high', 'medium', 'low'] }
  }
};

async function extractCitations(ctx, toolEvidence, answerText) {
  // Every row the answer could legitimately cite, in one list.
  const rows = [
    ...ctx.messages.map((m) => ({ id: m.message_id, text: m.body_text })),
    ...ctx.notes.map((n) => ({ id: n.note_id, text: n.body })),
    ...(ctx.tasks || []).map((t) => ({
      id: t.task_id, text: [t.title, t.body].filter(Boolean).join('\n')
    })),
    ...toolEvidence
  ].filter((r) => r.id && r.text);

  if (!rows.length) return { status: 'ok', output: null };

  const evidence = rows
    .map((r) => `[${r.id}]\n${String(r.text).slice(0, 2000)}`)
    .join('\n\n---\n\n');

  return callClaude({
    // Copying supporting sentences verbatim is lookup, not reasoning: no
    // thinking, low effort. This sits on the critical path of every answer
    // and was costing about as much wall time as the answer itself.
    thinking: false,
    effort: 'low',
    system: [{
      type: 'text',
      text: 'You attach citations to an answer that has already been written. '
        + 'For each factual claim in the answer, find the row that supports it '
        + 'and copy the supporting sentence VERBATIM as quote_text, with that '
        + "row's id as message_id. Do not paraphrase, do not invent a quote, "
        + 'and do not cite a row that does not contain the claim. Return an '
        + 'empty list rather than a weak citation — an answer with no '
        + 'citations is honest; a wrong one is not.'
    }],
    messages: [{
      role: 'user',
      content: `## Rows\n\n${evidence}\n\n## Answer\n\n${answerText}`
    }],
    schema: CITATION_SCHEMA,
    schemaName: 'deal_citations',
    maxTokens: 2000,
    // Low: this is lookup and copying, not reasoning. Spending more here
    // would slow every deal answer for no gain in quote accuracy.
    effort: 'low'
  });
}

// This differs from extraction (Call 1), where an unquotable claim is dropped
// entirely: there, the claim IS the output.
function validateAnswer(ctx, output, toolEvidence = []) {
  const { check, rejected } = makeValidator(ctx, toolEvidence);
  const shaped = normaliseCitationShape(output.citations);
  const kept = [];
  for (const c of shaped) {
    const ok = check('citation', {
      value: c.quote_text,
      quote_message_id: c.quote_message_id,
      quote_text: c.quote_text
    });
    if (ok?.quote_message_id) {
      kept.push({
        messageId: ok.quote_message_id,
        quoteText: c.quote_text,
        // Attribution for the UI's "Email · James Halloran · sent 9 Aug 2026"
        // line. Built from the same context the model read, so the label can
        // never describe a message the answer didn't actually cite.
        // sourceOf reads ctx, so a row the MODEL fetched mid-turn has no
        // attribution line — correct rather than invented. The citation still
        // stands; it just shows without the "Email · James · 9 Aug" label.
        ...sourceOf(ctx, ok.quote_message_id)
      });
    }
  }
  return { citations: kept, rejected };
}

