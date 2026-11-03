import { withTenant } from '../../db.js';
import { logger } from '../../utils/logger.js';

// Persistence for ai_runs / ai_feedback (migration 050).
//
// Logging is not optional and not best-effort-silent: it's the audit trail
// that answers "why did it say that", the cache, and the eval set. But a
// logging failure must never fail the user's request — so writes log loudly
// and swallow.

/**
 * Look for a cached successful run with the same inputs.
 * Returns the stored validated_output, or null.
 */
export async function findCachedRun(locationId, { callType, cacheKey, maxAgeMinutes = null }) {
  if (!cacheKey) return null;
  try {
    return await withTenant(locationId, async (client) => {
      const ageClause = maxAgeMinutes
        ? `AND created_at > now() - ($4 || ' minutes')::interval`
        : '';
      const params = [locationId, callType, cacheKey];
      if (maxAgeMinutes) params.push(String(maxAgeMinutes));
      const r = await client.query(
        `SELECT id, validated_output, messages_total, messages_read,
                unread_reasons, created_at, model
           FROM ai_runs
          WHERE location_id = $1
            AND call_type   = $2
            AND cache_key   = $3
            AND status      = 'ok'
            -- Never replay a run that proposed a write. Belt to askDeal's
            -- braces (which withholds the key on such runs): this also
            -- covers rows written before that rule existed, and a run whose
            -- proposals were linked after its cache_key was set.
            AND NOT EXISTS (
              SELECT 1 FROM ai_actions a
               WHERE a.location_id = ai_runs.location_id AND a.run_id = ai_runs.id
            )
            ${ageClause}
          ORDER BY created_at DESC
          LIMIT 1`,
        params
      );
      return r.rows[0] || null;
    });
  } catch (err) {
    logger.warn({ err, callType }, 'ai: cache lookup failed (continuing uncached)');
    return null;
  }
}

/**
 * Persist one run. Returns the run id, or null if the write failed.
 */
// Withdraw a run from the cache after the fact. The live ask path records
// the run BEFORE the action detector finishes, so a proposal the detector
// adds is only known once the row already carries a cache_key. A run that
// proposed a write must not be replayed — see askDeal's note on why.
export async function clearRunCacheKey(locationId, runId) {
  if (!runId) return;
  return withTenant(locationId, async (client) => {
    await client.query(
      `UPDATE ai_runs SET cache_key = NULL WHERE location_id = $1 AND id = $2`,
      [locationId, runId]
    );
  });
}

export async function recordRun(locationId, run) {
  try {
    return await withTenant(locationId, async (client) => {
      const r = await client.query(
        `INSERT INTO ai_runs (
           location_id, call_type, opportunity_id,
           input_message_ids, cache_key, config_version, question,
           model, prompt_version,
           raw_output, validated_output, rejected_items,
           messages_total, messages_read, unread_reasons,
           status, error,
           input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
           latency_ms, triggered_by,
           conversation_id
         ) VALUES (
           $1, $2, $3,
           $4, $5, $6, $7,
           $8, $9,
           $10::jsonb, $11::jsonb, $12::jsonb,
           $13, $14, $15,
           $16, $17,
           $18, $19, $20, $21,
           $22, $23,
           $24
         )
         RETURNING id`,
        [
          locationId,
          run.callType,
          run.opportunityId || null,
          run.inputMessageIds || [],
          run.cacheKey || null,
          run.configVersion ?? 0,
          run.question || null,
          run.model,
          run.promptVersion,
          JSON.stringify(run.rawOutput ?? null),
          JSON.stringify(run.validatedOutput ?? null),
          JSON.stringify(run.rejectedItems ?? []),
          run.coverage?.messagesTotal ?? null,
          run.coverage?.messagesRead ?? null,
          run.coverage?.unreadReasons ?? [],
          run.status,
          run.error || null,
          run.usage?.inputTokens ?? null,
          run.usage?.outputTokens ?? null,
          run.usage?.cacheReadTokens ?? null,
          run.usage?.cacheWriteTokens ?? null,
          run.latencyMs ?? null,
          run.triggeredBy || null,
          run.conversationId || null
        ]
      );
      return r.rows[0].id;
    });
  } catch (err) {
    // Loud: a silent logging failure means losing the audit trail without
    // knowing. But don't throw — the user's answer is already computed.
    logger.error({ err, callType: run.callType }, 'ai: FAILED to record run');
    return null;
  }
}

/**
 * Human confirm / dismiss / edit on one proposed item.
 * Idempotent on (location, opp, item_type, item_key) so a re-run can't
 * duplicate an already-decided item.
 */
export async function recordFeedback(locationId, fb) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `INSERT INTO ai_feedback (
         location_id, run_id, opportunity_id, item_type, item_key,
         item_payload, action, reason, edited_payload, acted_by
       ) VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9::jsonb, $10)
       ON CONFLICT (location_id, opportunity_id, item_type, item_key)
       DO UPDATE SET
         action         = EXCLUDED.action,
         reason         = EXCLUDED.reason,
         edited_payload = EXCLUDED.edited_payload,
         acted_by       = EXCLUDED.acted_by,
         created_at     = now()
       RETURNING id, action`,
      [
        locationId,
        fb.runId,
        fb.opportunityId || null,
        fb.itemType,
        fb.itemKey,
        JSON.stringify(fb.itemPayload ?? null),
        fb.action,
        fb.reason || null,
        JSON.stringify(fb.editedPayload ?? null),
        fb.actedBy || null
      ]
    );
    return r.rows[0];
  });
}

/**
 * Record — or change — a thumbs up/down on one Co-Pilot answer.
 *
 * Separate from recordFeedback/ai_feedback: that table is confirm/dismiss/
 * edit on a PROPOSED item and has a uniqueness constraint shaped for that
 * (one row per item, not per run). A reaction is one row per RUN, which
 * ai_run_rating enforces with its own unique index on run_id.
 */
/**
 * Delete every run in one conversation — the sidebar's "Delete chat".
 *
 * Deletes ai_runs rows; ai_feedback and ai_run_rating both cascade on
 * run_id, so their rows go with it rather than being left as orphans.
 *
 * Scoped to the SAME location the conversation belongs to (withTenant sets
 * RLS on ai_runs), so a conversation id from another sub-account cannot be
 * deleted by guessing it — the delete simply matches zero rows.
 *
 * @returns {number} rows deleted, so the caller can tell "gone" from
 *   "never existed" without a second query.
 */
export async function deleteConversation(locationId, conversationId) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `DELETE FROM ai_runs WHERE location_id = $1 AND conversation_id = $2`,
      [locationId, conversationId]
    );
    return r.rowCount;
  });
}

/**
 * Rename a conversation in the Recents rail.
 *
 * There's no ai_conversations row to update — the rail title is derived at
 * query time from the FIRST run's question (see askHistory/portfolioHistory
 * below). custom_title is a per-run override column (migration 076); a
 * rename only needs to reach the first row of the conversation, since that's
 * the only one either history query ever reads a title from.
 *
 * @returns {number} rows updated — 0 means the conversation id doesn't
 *   belong to this location (or doesn't exist), matching deleteConversation's
 *   "gone vs never existed" convention.
 */
export async function renameConversation(locationId, conversationId, title) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `UPDATE ai_runs SET custom_title = $3
        WHERE id = (
          SELECT id FROM ai_runs
           WHERE location_id = $1 AND conversation_id = $2
           ORDER BY created_at ASC
           LIMIT 1
        )`,
      [locationId, conversationId, title]
    );
    return r.rowCount;
  });
}

// Every deal id a tool call touched across the EARLIER runs in this
// conversation. For askPortfolio.js's "READ" chip: a follow-up the model
// answers straight from its own memory of the thread makes no new tool
// calls, so that run's own toolCalls is empty even though the answer is
// plainly still about the same deal(s) — the chip would otherwise vanish
// on every such follow-up. rawOutput->toolCalls is already persisted per
// run (see recordRun's callers), so this reads it back rather than
// re-deriving anything.
export async function priorDealIdsInConversation(locationId, conversationId) {
  if (!conversationId) return [];
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `SELECT raw_output -> 'toolCalls' AS tool_calls
         FROM ai_runs
        WHERE location_id = $1 AND conversation_id = $2 AND status = 'ok'
        ORDER BY created_at ASC`,
      [locationId, conversationId]
    );
    const ids = new Set();
    for (const row of r.rows) {
      for (const call of row.tool_calls || []) {
        const id = call?.input?.dealId;
        if (id) ids.add(id);
        // Deals surfaced as DATA from a list tool (search_deals), same as
        // askPortfolio.js's own live-request union below — a run persisted
        // after that field was added carries call.deals; older runs simply
        // won't have it, which is fine, since dealNamesFor filters out
        // anything that no longer resolves anyway.
        for (const d of call?.deals || []) {
          if (d?.id) ids.add(d.id);
        }
      }
    }
    return [...ids];
  });
}

export async function recordRunRating(locationId, {
  runId, rating, reasons = [], reason = null, ratedBy = null
}) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `INSERT INTO ai_run_rating (location_id, run_id, rating, reasons, reason, rated_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (run_id) DO UPDATE SET
         rating     = EXCLUDED.rating,
         reasons    = EXCLUDED.reasons,
         reason     = EXCLUDED.reason,
         rated_by   = EXCLUDED.rated_by,
         updated_at = now()
       RETURNING id, rating`,
      [locationId, runId, rating, reasons, reason, ratedBy]
    );
    return r.rows[0];
  });
}

/**
 * Ask-this-deal chat history for one deal, newest first.
 *
 * Reads ai_runs rather than a separate chat table: every question and its
 * validated answer is already persisted there for the audit trail, so a
 * second store would be duplicate state that could disagree with the audit.
 *
 * Only successful runs with an answer — a failed call isn't a chat turn, it's
 * an incident, and it stays in ai_runs for diagnosis without cluttering the
 * rep's history.
 */
export async function askHistory(locationId, opportunityId, limit = 25) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `WITH recent AS (
         SELECT conversation_id, max(created_at) AS last_at
           FROM ai_runs
          WHERE location_id    = $1
            AND opportunity_id = $2
            AND call_type      = 'ask'
            AND status         = 'ok'
            AND question IS NOT NULL
            AND validated_output IS NOT NULL
            AND conversation_id IS NOT NULL
          GROUP BY conversation_id
          ORDER BY last_at DESC
          LIMIT $3
       )
       SELECT r.id, r.question, r.validated_output, r.created_at,
              r.messages_total, r.messages_read, r.unread_reasons,
              r.input_message_ids, r.conversation_id, r.custom_title,
              recent.last_at
         FROM ai_runs r
         JOIN recent ON recent.conversation_id = r.conversation_id
        WHERE r.location_id    = $1
          AND r.opportunity_id = $2
          AND r.call_type      = 'ask'
          AND r.status         = 'ok'
          AND r.question IS NOT NULL
          AND r.validated_output IS NOT NULL
        ORDER BY recent.last_at DESC, r.created_at ASC`,
      [locationId, opportunityId, limit]
    );

    // THE ACTIONS EACH TURN PROPOSED, so a reopened chat shows what it did.
    //
    // History used to return the question and the answer text only. Reload a
    // thread and every ActionCard vanished — a task the rep had already
    // confirmed left no trace, and the answer's own "Create task" button came
    // back offering to create it a second time.
    //
    // Keyed on run_id, which linkActionsToRun already sets when the answer is
    // written, so this is a join rather than new bookkeeping.
    const runIds = r.rows.map((row) => row.id);
    const actionsByRun = new Map();
    if (runIds.length) {
      const a = await client.query(
        `SELECT id, run_id, action_type, proposed_payload, edited_payload, status
           FROM ai_actions
          WHERE location_id = $1 AND run_id = ANY($2::uuid[])
          ORDER BY created_at ASC`,
        [locationId, runIds]
      );
      for (const row of a.rows) {
        if (!actionsByRun.has(row.run_id)) actionsByRun.set(row.run_id, []);
        actionsByRun.get(row.run_id).push({
          actionId: row.id,
          actionType: row.action_type,
          // What the rep actually confirmed when they edited it — the card
          // should reopen showing what was SENT, not what was first proposed.
          proposed: row.edited_payload || row.proposed_payload,
          status: row.status
        });
      }
    }

    const turnOf = (row) => ({
      // runId, matching portfolioHistory()'s own turn shape below and the
      // live-answer response (askDeal.js's res.runId) — AskDeal.jsx's
      // reopen() used to remap `t.id` to `runId` by hand to work around
      // this mismatch; kept working either way, but this makes the two
      // history endpoints consistent with each other and with a live turn.
      id: row.id,
      runId: row.id,
      question: row.question,
      answerText: row.validated_output?.answerText || null,
      citations: row.validated_output?.citations || [],
      confidence: row.validated_output?.confidence || null,
      answered: row.validated_output?.answered !== false,
      askedAt: row.created_at,
      // The exact set this answer read — powers the "N messages considered"
      // count and the detail modal. Stored per run, so an old chat shows what
      // it actually read even if the thread has grown since.
      readMessageIds: row.input_message_ids || [],
      coverage: {
        messagesTotal: row.messages_total,
        messagesRead: row.messages_read,
        unreadReasons: row.unread_reasons || [],
        readAt: row.created_at
      },
      // Same key and shape as a live answer's response, so AskDeal renders a
      // reopened turn through exactly the same path as a fresh one.
      proposedActions: actionsByRun.get(row.id) || []
    });

    const byConv = new Map();
    for (const row of r.rows) {
      const key = row.conversation_id;
      if (!byConv.has(key)) {
        byConv.set(key, {
          conversationId: key,
          // The FIRST question titles the thread by default — it is what the
          // rep was asking about, and a follow-up like "and the other one?"
          // would be a meaningless label in the rail. custom_title (only
          // ever set on this same first row — see renameConversation) wins
          // when a rep has renamed the chat.
          title: row.custom_title || row.question,
          lastAt: row.last_at,
          turns: []
        });
      }
      byConv.get(key).turns.push(turnOf(row));
    }
    return [...byConv.values()].map((c) => ({ ...c, turnCount: c.turns.length }));
  });
}

/**
 * Past PORTFOLIO conversations — the ones with no deal.
 *
 * Same conversation grouping as askHistory. Split by `opportunity_id IS NULL`
 * rather than a new call_type: both are 'ask' runs and share the schema, and
 * the portfolio tab must not show a deal's chats (or the deal hub the
 * portfolio's).
 */
export async function portfolioHistory(locationId, limit = 25) {
  return withTenant(locationId, async (client) => {
    const r = await client.query(
      `WITH recent AS (
         SELECT conversation_id, max(created_at) AS last_at
           FROM ai_runs
          WHERE location_id     = $1
            AND opportunity_id IS NULL
            AND call_type       = 'ask'
            AND status          = 'ok'
            AND question IS NOT NULL
            AND validated_output IS NOT NULL
            AND conversation_id IS NOT NULL
          GROUP BY conversation_id
          ORDER BY last_at DESC
          LIMIT $2
       )
       SELECT r.id, r.question, r.validated_output, r.created_at,
              r.conversation_id, r.custom_title, recent.last_at,
              -- The writes this turn proposed, WITH their current status.
              --
              -- These were missing entirely from a reopened chat, and the
              -- effect was worse than a blank space: ActionCard tracks
              -- confirmed/rejected in local component state, so switching tab
              -- unmounted the card and switching back rebuilt it as an
              -- unsent draft. A rep who had already sent an email came back
              -- to what looked like an unsent one and could send it twice.
              --
              -- Status comes from the row rather than being inferred, so a
              -- card knows it is done without the component having to
              -- remember.
              COALESCE((
                SELECT json_agg(json_build_object(
                         'actionId',   a.id,
                         'actionType', a.action_type,
                         'proposed',   a.proposed_payload,
                         'status',     a.status,
                         'edited',     a.edited_payload
                       ) ORDER BY a.created_at)
                  FROM ai_actions a
                 WHERE a.location_id = r.location_id
                   AND a.run_id      = r.id
              ), '[]'::json) AS proposed_actions
         FROM ai_runs r
         JOIN recent ON recent.conversation_id = r.conversation_id
        WHERE r.location_id     = $1
          AND r.opportunity_id IS NULL
          AND r.call_type       = 'ask'
          AND r.status          = 'ok'
          AND r.question IS NOT NULL
          AND r.validated_output IS NOT NULL
        ORDER BY recent.last_at DESC, r.created_at ASC`,
      [locationId, limit]
    );

    const byConv = new Map();
    for (const row of r.rows) {
      const key = row.conversation_id;
      if (!byConv.has(key)) {
        byConv.set(key, {
          conversationId: key,
          // See askHistory's identical comment — custom_title overrides the
          // first question when the rep has renamed this chat.
          title: row.custom_title || row.question,
          lastAt: row.last_at,
          turns: []
        });
      }
      byConv.get(key).turns.push({
        // runId, not id — matching askPortfolio.js's live-answer response
        // shape (see CopilotTab.jsx's turn.runId). The frontend's reopen()
        // reads this key by that name; a mismatch here silently disabled
        // thumbs up/down on every reopened turn, since ReactionRow treats
        // a missing runId as "no run to rate".
        runId: row.id,
        question: row.question,
        answerText: row.validated_output?.answerText || null,
        citations: row.validated_output?.citations || [],
        confidence: row.validated_output?.confidence || null,
        answered: row.validated_output?.answered !== false,
        dealsRead: row.validated_output?.dealsRead || [],
        dealsTable: row.validated_output?.dealsTable || null,
        groundingWarning: row.validated_output?.groundingWarning || null,
        // Same key the live answer uses, so CopilotTab renders a reopened
        // turn through the identical path.
        proposedActions: row.proposed_actions || [],
        askedAt: row.created_at
      });
    }
    return [...byConv.values()].map((c) => ({ ...c, turnCount: c.turns.length }));
  });
}

/**
 * Already-decided items for a deal, so a re-run doesn't re-propose what a
 * human has confirmed or dismissed (spec: idempotency).
 */
export async function decidedItems(locationId, opportunityId) {
  try {
    return await withTenant(locationId, async (client) => {
      const r = await client.query(
        `SELECT item_type, item_key, action
           FROM ai_feedback
          WHERE location_id = $1 AND opportunity_id = $2`,
        [locationId, opportunityId]
      );
      return r.rows;
    });
  } catch (err) {
    logger.warn({ err, opportunityId }, 'ai: decidedItems lookup failed');
    return [];
  }
}

// Stable identity for an item across re-runs: its text plus the message it
// cites. Text alone would collide on "Send the quote" from two deals; the
// quote id alone would collide on two commitments in one message.
export function itemKeyFor(item) {
  const text = String(item.text ?? item.value ?? item.title ?? '')
    .trim().toLowerCase().replace(/\s+/g, ' ');
  const id = item.quote_message_id || item.source_message_id || '';
  return `${text}::${id}`;
}
