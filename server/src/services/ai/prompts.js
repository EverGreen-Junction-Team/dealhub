// Prompt assembly. Kept separate from the calls so prompt text is versioned
// and diffable on its own — a prompt change is the most likely cause of an
// output change, and `git log prompts.js` should show it.
//
// CACHING SHAPE MATTERS. Caching is a prefix match, so blocks are ordered:
//   1. RULES         — frozen text, identical for every call and every deal
//   2. CONFIG        — per-location, changes only on a Control panel save
//   3. [cache mark]  — 1h TTL
//   4. DEAL + OLDER THREAD — per-deal but append-only, so also cacheable
//   5. [cache mark]  — 1h TTL
//   6. NEWEST MESSAGES — the last few, left fresh so new mail doesn't bust (4)
//   7. QUESTION      — per-request, last
//
// Two marks, not one. The thread is the largest part of the input on a busy
// deal (>90% of tokens at 400 messages) and it is append-only — yesterday's
// messages never change. Caching all but the newest few cuts a warm ask by
// 73-87%. Putting the question or a timestamp above either mark would
// invalidate the cache on every request.

// The eight hard rules from spec §2. Rules 1, 2, 3, 6, 7 are ALSO enforced in
// code — they appear here so the model cooperates, not because the prompt is
// the enforcement.
// Anthropic won't cache a prefix below this (Sonnet 5: 1024 tokens). Marking a
// shorter prefix bills a cache write that can never be served — strictly worse
// than not marking it. ~4 chars/token, so this is a character threshold.
const MIN_CACHEABLE_CHARS = 1024 * 4;

const RULES = `You are a sales-analysis assistant reading one deal's message thread for a UK glazing company. You work for the sales team, not the customer.

Absolute rules:

1. EVERY factual claim must cite a specific message. Return the message's id in quote_message_id and the exact words you are relying on in quote_text. quote_text must be copied VERBATIM from that message — character for character, no paraphrasing, no tidying, no ellipsis. A claim whose quote is not a literal substring of the cited message will be discarded before anyone sees it.

2. NEVER invent. If the thread does not establish something, return null for it. "Not found" is a correct and expected answer. Do not infer a price, date, specification, or intention that is not stated. Do not guess at what someone probably meant.

3. Quote the SHORTEST span that proves the claim — one sentence or clause, not a whole paragraph.

4. Chronology is meaning. Messages are given oldest first. When a statement is later revised or superseded, the most recent version wins: "I'll send it Thursday" followed by "make that next week" means next week.

5. Direction matters. Messages marked direction "out" are from the sales team (us). Messages marked "in" are from the customer or their representatives. Never attribute our statement to them or theirs to us.

6. You are shown only messages filed to this deal and readable. Some messages may be missing — untranscribed calls in particular. Do not speculate about content you cannot see, and do not treat absence of evidence as evidence.

7. Notes and tasks written by the sales team are first-class evidence, the same weight as a message, and are citable by their id. A task records what the team committed to do — treat an open one as an outstanding commitment and a completed one as done.

8. Answer only about THIS deal. The customer may have other open deals; a commitment made about a different deal does not belong to this one.

9. "Days since the customer last replied" is given to you above as a computed fact, not something to work out yourself from message dates — use that number directly for "has this gone quiet" / "why haven't they replied" questions rather than counting days in the thread by hand, which can drift from the real figure by a day or more depending on which message you count from.`;

/**
 * Stable system blocks: rules + the business-context file + qualification
 * headings, cache-marked.
 *
 * Everything here changes only when the client replaces the context file or
 * edits a GHL field, so it sits above the cache breakpoint and repeat
 * questions read it from Anthropic's prompt cache rather than re-paying for
 * those input tokens.
 */
export function systemBlocks(ctx, { memories = [] } = {}) {
  const blocks = [{ type: 'text', text: RULES }];

  const cfg = ctx.config;
  const parts = [];

  // Control panel v1: one markdown file, whatever the business chose to write.
  // No schema, so it goes in verbatim — parsing it into sections would impose
  // a structure the business explicitly wasn't asked for, and would drop
  // anything that didn't fit.
  if (cfg.businessContext) {
    parts.push(
      `## Business context\nThis is what the business has told you about itself — products, lead times, how it operates, how to answer objections. Treat it as fact about the business. It is NOT evidence about this deal: never cite it as something the customer said.\n\n${cfg.businessContext}`
    );
  }

  // Qualification headings come from the location's own GHL custom fields
  // (opportunity.meddic_N), so the model uses James's names — "1. Project
  // Scope", "8. Decision Criteria" — not textbook MEDDIC. Descriptions are
  // optional: a heading with a name but no description is still worth naming,
  // because the model needs to know the heading exists to file evidence under
  // it.
  const headings = (cfg.meddicFields || [])
    .filter((f) => f.active !== false && f.name)
    .map((f) => {
      // GHL's placeholder is the description. A locally-saved override in
      // meddic_mapping still wins, so a location can refine wording without
      // editing the field in GoHighLevel.
      const desc = cfg.meddic?.[f.fieldKey] || f.description;
      return desc ? `- ${f.name}: ${desc}` : `- ${f.name}`;
    });
  if (headings.length) {
    parts.push(
      `## Qualification headings used in this business\nFile qualification evidence under these headings, using these exact names.\n${headings.join('\n')}`
    );
  }

  if (parts.length) {
    blocks.push({ type: 'text', text: parts.join('\n\n') });
  }

  // Cache everything above: rules are frozen, config changes only on save.
  //
  // 1h TTL rather than the 5-minute default. A rep works one deal for twenty
  // minutes or more, and the 5-minute window expires between questions —
  // re-billing the whole prefix. The 2x write premium pays back after two
  // reads, so this is cheaper for any real session.
  //
  // Only mark it when the prefix can actually be cached. Sonnet 5 won't cache
  // below 1024 tokens, and RULES alone is ~450 — so a location with no context
  // file would pay for a cache write that is never served. Marking nothing is
  // strictly cheaper there.
  const cacheableChars = blocks.reduce((n, b) => n + b.text.length, 0);
  if (cacheableChars >= MIN_CACHEABLE_CHARS) {
    blocks[blocks.length - 1].cache_control = { type: 'ephemeral', ttl: '1h' };
  }

  // Memories are per-USER, appended AFTER the cache marker above rather than
  // folded into that block. That block is shared across every rep at a
  // location (business context, qualification headings) — mixing in one
  // rep's personal memories would make the cached prefix diverge per rep,
  // so nobody's repeat questions would ever hit the location-shared cache.
  // Left uncached itself: at most 200 short entries, nowhere near the size
  // where caching would pay back its own write premium.
  const memText = memoriesBlock(memories);
  if (memText) blocks.push({ type: 'text', text: memText });

  // Today's date — per-request, below the cache mark like memories above:
  // it changes daily, and the model has no other way to resolve "last
  // week" or "this month" against the thread's own dates. Putting it in
  // the cached RULES block would either serve a stale date for up to the
  // cache's 1h TTL or force a cache bust every hour regardless of activity.
  blocks.push({
    type: 'text',
    text: `## Today's date\n${new Date().toISOString().slice(0, 10)} — resolve relative dates ("last week", "this month") against this.`
  });

  return blocks;
}

// Same memories text for both callers: askDeal.js via systemBlocks() above,
// and askPortfolio.js's tool loop, which has no ctx/config block to append
// to and builds its system prompt as a plain string instead.
export function memoriesBlock(memories) {
  if (!memories?.length) return null;
  return `## What this rep has told you to remember\nThe rep has asked you to keep these facts in mind for every future question, not just this one. Treat them as working context about the rep and how they want to be helped — never as evidence about this deal or its messages.\n\n${memories.map((m) => `- ${m}`).join('\n')}`;
}

/**
 * The deal + thread as a delimited transcript. Ids are on every entry so the
 * model can cite them, and this is the text quote validation runs against.
 */
// How many of the NEWEST messages stay outside the cached prefix.
//
// The thread is append-only: yesterday's messages don't change, so all but the
// most recent can sit in a cached block. The tail is left uncached because a
// new message arriving would otherwise invalidate the whole prefix — keeping a
// margin means the cached part stays valid as the deal moves.
const UNCACHED_TAIL = 8;

export function threadBlock(ctx) {
  const d = ctx.deal;
  const facts = [
    // The id, not just the title. Propose-tools take an opportunityId, and
    // without it here the model had no way to name the deal it was already
    // looking at: every proposal filed against no deal, and propose_send_message
    // could not scope its recipient to this deal's people.
    d.deal_id ? `Deal id: ${d.deal_id}` : null,
    `Deal: ${d.title || '(unnamed)'}`,
    `Stage: ${d.stage || 'unknown'}${d.days_in_stage != null ? ` (${d.days_in_stage} days)` : ''}`,
    d.value != null ? `Value: ${d.currency} ${d.value}` : null,
    d.owner ? `Owner (our rep): ${d.owner}` : null,
    d.product ? `Product: ${d.product}` : null,
    d.lead_source ? `Lead source: ${d.lead_source}` : null,
    d.expected_close ? `Expected close: ${fmtDate(d.expected_close)}` : null,
    // Every custom field, by the label a rep would say, with its value and
    // the choices a picklist allows. Each is editable through
    // propose_update_deal's `fields` — the label here is what to pass.
    d.fields?.length
      ? `Deal fields (each editable via propose_update_deal fields, by this label):\n${
          d.fields.map((f) => {
            const opts = f.options?.length
              ? ` [choices: ${f.options.join(' | ')}${f.multiple ? '; several allowed' : ''}]`
              : '';
            return `- ${f.label}: ${f.value ?? '(not set)'}${opts}`;
          }).join('\n')}`
      : null,
    d.created_at ? `Deal opened: ${fmtDate(d.created_at)}` : null,
    // Computed, not left for the model to reconstruct from the thread's own
    // timestamps — same fact search_deals's quietDays filter answers for
    // the portfolio Co-Pilot, so the two can't disagree. Two distinct
    // "no answer" shapes: never replied at all (no last_inbound_at) vs.
    // last_inbound_at present but somehow not yet a number (shouldn't
    // happen given daysSince's own null-guard, kept only as a safe fallback).
    d.last_inbound_at
      ? `Days since the customer last replied: ${d.quiet_days}`
      : `The customer has never sent an inbound message on this deal.`
  ].filter(Boolean).join('\n');

  const others = d.other_open_deals?.length
    ? `\n\nThis customer also has other OPEN deals. Anything about these belongs to them, not to the deal above:\n${
        d.other_open_deals
          .map((o) => `- ${o.title} (${o.stage}${o.value != null ? `, ${d.currency} ${o.value}` : ''})`)
          .join('\n')
      }`
    : '';

  const people = ctx.people
    .map((p) => {
      const bits = [`${p.contact_id}: ${p.name}`];
      if (p.contact_type) bits.push(p.contact_type);
      if (p.business) bits.push(p.business);
      if (p.is_primary) bits.push('primary contact');
      const blocked = Object.entries(p.dnd || {})
        .filter(([k, v]) => v && k !== 'all')
        .map(([k]) => k);
      if (p.dnd?.all) bits.push('DO NOT CONTACT (all channels)');
      else if (blocked.length) bits.push(`do not contact by: ${blocked.join(', ')}`);
      return `- ${bits.join(' · ')}`;
    })
    .join('\n');

  const notes = ctx.notes.length
    ? `\n\n## Notes written by our team (citable evidence)\n${ctx.notes
        .map(
          (n) =>
            `<note id="${n.note_id}" author="${n.author || 'unknown'}" date="${fmtDate(n.created_at)}">\n${n.body}\n</note>`
        )
        .join('\n')}`
    : '';

  // Tasks. Status and due date are ATTRIBUTES rather than prose, so the model
  // doesn't have to parse "due 4 days ago" out of a sentence — and an overdue
  // commitment is legible without arithmetic.
  const tasks = ctx.tasks?.length
    ? `\n\n## Tasks our team recorded (citable evidence)\n${ctx.tasks
        .map((t) => {
          const attrs = [
            `id="${t.task_id}"`,
            `status="${t.status || 'open'}"`,
            t.assignee ? `assigned_to="${t.assignee}"` : null,
            t.due_at ? `due="${fmtDate(t.due_at)}"` : null,
            t.due_at && t.status === 'open' && new Date(t.due_at) < new Date()
              ? 'overdue="true"'
              : null
          ].filter(Boolean).join(' ');
          const body = [t.title, t.body].filter(Boolean).join('\n');
          return `<task ${attrs}>\n${body}\n</task>`;
        })
        .join('\n')}`
    : '';

  const renderMessage = (m) => {
    const who = m.direction === 'in'
      ? `customer (${nameOf(ctx, m.sender)})`
      : `us${m.sender_name ? ` (${m.sender_name})` : ''}`;
    const extra = m.is_call
      ? ` call_transcript="true"${m.call_duration_min ? ` duration_min="${m.call_duration_min}"` : ''}`
      : '';
    return `<message id="${m.message_id}" channel="${m.channel}" direction="${m.direction}" from="${who}" date="${fmtDate(m.sent_at)}" days_ago="${m.age_days}"${extra}>\n${m.body_text}\n</message>`;
  };

  // Coverage is stated so the model knows what it cannot see, and so rule 6
  // has something concrete to attach to.
  const coverage = ctx.coverage.unreadReasons.length
    ? `\n\nNOT SHOWN TO YOU: ${ctx.coverage.unreadReasons.join('; ')}. Do not speculate about their content.`
    : '';

  // Deal facts, people and notes lead. They change rarely relative to the
  // thread, so they belong in the cached half.
  const head = `## Deal\n${facts}${others}\n\n## People on this deal\n${people}${notes}${tasks}\n\n## Message thread (oldest first)`;

  if (ctx.messages.length === 0) {
    return [{ type: 'text', text: `${head}\n(no readable messages on this deal)${coverage}` }];
  }

  // Split point: everything except the newest UNCACHED_TAIL messages is stable.
  const splitAt = Math.max(0, ctx.messages.length - UNCACHED_TAIL);
  const olderText = ctx.messages.slice(0, splitAt).map(renderMessage).join('\n');
  const newerText = ctx.messages.slice(splitAt).map(renderMessage).join('\n');

  // Only split when the cacheable half clears the provider's minimum. Below it
  // the write is billed and never served, so a short thread goes in one block.
  const worthCaching = olderText.length >= MIN_CACHEABLE_CHARS;
  if (!worthCaching) {
    return [{
      type: 'text',
      text: `${head}\n${[olderText, newerText].filter(Boolean).join('\n')}${coverage}`
    }];
  }

  return [
    // Cached: deal facts + every message but the newest few.
    { type: 'text', text: `${head}\n${olderText}`, cache_control: { type: 'ephemeral', ttl: '1h' } },
    // Uncached: the newest messages and the coverage note. Coverage stays here
    // because unreadReasons can change without the older thread changing.
    { type: 'text', text: `${newerText}${coverage}` }
  ];
}

// Rough token estimate for logging and budget decisions. Deliberately a
// character heuristic rather than a count_tokens round trip — this runs on
// every request and an approximate number is enough to log against.
export function approxTokensOfBlocks(blocks) {
  return Math.round(
    blocks.reduce((n, b) => n + (b.text?.length || 0), 0) / 4
  );
}

function nameOf(ctx, contactId) {
  if (!contactId || contactId === 'us') return 'us';
  const p = ctx.people.find((x) => x.contact_id === contactId);
  return p ? p.name : 'unknown contact';
}

function fmtDate(ts) {
  if (!ts) return 'unknown date';
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return 'unknown date';
  return d.toISOString().slice(0, 10);
}

export const PROMPT_VERSIONS = {
  // v2: not-found answers redirect rather than dead-end. Recorded on each run
  // for evaluation; cache invalidation is CONTEXT_VERSION's job, not this.
  ask: 'ask.v9'
};
