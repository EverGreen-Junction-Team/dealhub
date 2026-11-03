// The agentic loop: let the model choose what to read, then answer.
//
// This replaces the two-step "select deals, then read them" design. That
// version hardcoded ONE retrieval shape — facts, then threads — so a question
// it did not anticipate (tags, a value cut, stage order) had no path to an
// answer even though the data was there.
//
// Here the model is handed a catalogue and calls what it needs, in whatever
// order, up to a cap. GHL's Ask AI works this way (ai-backend/apps/ghl-mcp);
// the difference is that our tools run as SQL in-process rather than HTTP
// calls to other services.
//
// WHY A CAP. Each round trip is a model call. Without a ceiling a vague
// question ("tell me about the pipeline") can walk the whole database one tool
// at a time. Six is enough for "find the stalled deals, read the top three,
// check what changed" and cheap enough to be worth it.

import { getClient, MODEL, isContentFiltered } from '../claudeClient.js';
import { toolCatalogue, runTool } from './registry.js';
import { skillToolsFor, isSkillTool, runSkillTool } from './skillTools.js';
import { logger } from '../../../utils/logger.js';

const MAX_ROUNDS = 6;

/**
 * Run a question to an answer, calling tools as the model asks for them.
 *
 * @returns {{answerText, toolCalls, proposedActions, rounds, usage}}
 */
export async function runToolLoop({
  locationId,
  system,
  messages,
  maxRounds = MAX_ROUNDS,
  onProgress = null,
  // Which surface is asking. Skills can be scoped to one, so a deal-shaped
  // skill is not offered to a portfolio question and vice versa.
  surface = 'portfolio',
  // The deal in scope, on the deal surface. Every deal-scoped tool argument
  // is FORCED to this (see runTool) so the model cannot read or write a
  // different deal from inside this one's chat.
  dealId = null,
  // The asking user — forwarded to tools that answer per-user questions
  // (get_conversation_providers lists their own two-way-sync mailbox).
  userId = null
}) {
  const anthropic = getClient();
  // Built-ins plus whatever skills this location has saved. Skills are appended
  // rather than merged in: the built-ins are the ones the prompt names and
  // depends on, and a location's own skills are additions to that, not
  // replacements for it.
  const skillTools = await skillToolsFor(locationId, surface);
  const tools = [...toolCatalogue(surface), ...skillTools].map((t) => ({
    name: t.name,
    description: t.description,
    input_schema: t.inputSchema
  }));

  const convo = [...messages];
  const toolCalls = [];
  // Every ai_actions row a PROPOSE tool inserted this turn (see
  // registry.js), as { actionId, actionType, proposed }. Collected here —
  // not left for the caller to dig out of toolCalls' results, since a
  // propose tool's return shape is otherwise just another opaque
  // tool_result blob — so the caller can render one ActionCard per entry
  // without a second round trip to fetch what was proposed, and so it can
  // backfill run_id onto each row once recordRun gives it one (the run
  // doesn't exist yet while the loop is still running).
  const proposedActions = [];
  let usage = { inputTokens: 0, outputTokens: 0 };
  let rounds = 0;

  while (rounds < maxRounds) {
    rounds++;
    const request = {
      model: MODEL,
      max_tokens: 4000,
      system,
      messages: convo,
      tools,
      thinking: { type: 'adaptive' }
    };
    let res;
    try {
      res = await anthropic.messages.create(request);
    } catch (err) {
      // The output filter is applied to what the model was about to write
      // and is not deterministic — the same request usually passes on a
      // second try. One retry; a second refusal is reported to the rep.
      if (!isContentFiltered(err)) throw err;
      logger.warn({ locationId, surface, round: rounds },
        'ai: output blocked by the content filter — retrying once');
      res = await anthropic.messages.create(request);
    }

    usage = {
      inputTokens: usage.inputTokens + (res.usage?.input_tokens || 0),
      outputTokens: usage.outputTokens + (res.usage?.output_tokens || 0)
    };

    // The assistant turn goes back verbatim — including thinking blocks, which
    // the API rejects the conversation without once tools are in play.
    convo.push({ role: 'assistant', content: res.content });

    const wanted = res.content.filter((b) => b.type === 'tool_use');
    if (wanted.length === 0) {
      const answerText = res.content
        .filter((b) => b.type === 'text')
        .map((b) => b.text)
        .join('\n')
        .trim();
      return { answerText, toolCalls, proposedActions, rounds, usage, stopReason: res.stop_reason };
    }

    // Run every tool the model asked for in this turn TOGETHER. The model
    // routinely asks for two or three at once — get_conversation_providers
    // and search_contacts before a send — and running them one after another
    // added each one's round trip to the answer. The earlier worry (a burst
    // on the pooled connection) does not bear out: a round is two or three
    // reads, not a burst, and the rep is waiting on all of them. Results are
    // collected in the model's own order, so the tool_result blocks below
    // still line up with their tool_use ids.
    const results = [];
    const outs = await Promise.all(wanted.map((call) => {
      if (onProgress) onProgress({ type: 'tool', name: call.name, input: call.input });
      return isSkillTool(call.name)
        ? runSkillTool(locationId, call.name, call.input, surface)
        : runTool(locationId, call.name, call.input, { surface, dealId, userId });
    }));
    for (const [i, call] of wanted.entries()) {
      const out = outs[i];
      toolCalls.push({
        name: call.name, input: call.input, rows: rowCount(out),
        deals: dealsInResult(out),
        // LINEAGE: the query a skill actually ran, kept in the run log so any
        // number can be traced back to the rows that produced it. Recorded
        // here rather than inside the skill, because only this loop knows
        // which copy goes to the model and which to the log — and it is
        // stripped from the model's copy below.
        query: out?.query || null,
        // Full row data, kept separately from `deals` above (which is only
        // {id, name} for the chip-building code in askPortfolio.js) — this
        // is what lets the FRONTEND render a real table for "list of
        // deals" answers instead of depending on the model to format one
        // in prose, which it does not reliably do even when told to.
        dealRows: Array.isArray(out?.deals) ? out.deals : null,
        // Skill results, same idea as dealRows but for a saved view. A skill
        // returns { rows, source } rather than { deals }, and its shape is
        // whatever its view exposes — so the frontend charts it generically
        // instead of assuming deal columns.
        skillRows: Array.isArray(out?.rows) ? out.rows : null,
        skillSource: out?.source || null
      });
      if (out?.actionId) proposedActions.push(out);
      results.push({
        type: 'tool_result',
        tool_use_id: call.id,
        // `query` is removed: it is for the provenance trail, not the model.
        // Sending SQL back would spend tokens on something it cannot use and
        // invite it to quote a query at a rep, which is noise in a sales
        // answer.
        content: JSON.stringify(out && out.query ? (({ query, ...rest }) => rest)(out) : out)
      });
    }
    convo.push({ role: 'user', content: results });
  }

  // Out of rounds. Ask once more WITHOUT tools so the model has to commit to
  // an answer from what it already has, rather than the turn ending with
  // nothing to show for six lookups.
  logger.warn({ locationId, rounds }, 'ai: tool loop hit its round cap');
  const final = await anthropic.messages.create({
    model: MODEL,
    max_tokens: 4000,
    system,
    messages: [
      ...convo,
      {
        role: 'user',
        content:
          'You have run out of lookups. Answer now from what you already have, '
          + 'and say plainly what you could not check.'
      }
    ],
    thinking: { type: 'adaptive' }
  });
  const answerText = final.content
    .filter((b) => b.type === 'text')
    .map((b) => b.text)
    .join('\n')
    .trim();
  return { answerText, toolCalls, proposedActions, rounds, usage, stopReason: 'max_rounds' };
}

// How many rows a tool returned, for the run log. Tools return different
// shapes, so this looks for whichever array came back rather than assuming.
function rowCount(out) {
  if (!out || out.error) return null;
  for (const k of ['deals', 'contacts', 'messages', 'changes', 'stages', 'tasks',
    'notes', 'businesses', 'reps', 'people', 'tags', 'history', 'jobs',
    'providers', 'views', 'breakdown']) {
    if (Array.isArray(out[k])) return out[k].length;
  }
  return null;
}

// The {id, name} pairs of any deals a LIST tool (search_deals, and anything
// else that returns a `deals` array) surfaced — so a deal the model only
// ever saw via a list, and simply named in its written answer, still gets a
// clickable chip. Without this, dealsRead in askPortfolio.js only ever
// caught deals fetched by a per-deal tool's own dealId argument
// (get_deal_messages etc.) — a deal returned as DATA from search_deals was
// invisible to it, even though the model quoted its name straight out of
// that result.
function dealsInResult(out) {
  if (!out || out.error || !Array.isArray(out.deals)) return null;
  return out.deals
    .filter((d) => d?.id)
    .map((d) => ({ id: d.id, name: d.name || null }));
}
