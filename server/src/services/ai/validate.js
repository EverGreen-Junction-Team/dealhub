// Citation validation — spec §2 rule 1, enforced in code.
//
// The prompt asks for a quote on every claim. This module is what makes that
// true: an item whose quote isn't a real substring of the message it cites is
// DROPPED, not displayed. That asymmetry is deliberate — per the spec's two
// failure modes, a missed commitment costs a deal but a fabricated one costs
// trust in the whole product, and reps forgive "not found yet" while they
// never forgive confident wrongness.
//
// Every rejection is returned with a reason and persisted to
// ai_runs.rejected_items. A rising rejection count is a prompt bug.

// Quote matching can't be exact-equality: models normalise whitespace,
// smart quotes, and non-breaking spaces when echoing text, and email bodies
// are full of all three. So we normalise both sides identically and then
// require a genuine substring. This forgives formatting, never content.
function normalise(s) {
  return String(s || '')
    // Curly quotes and dashes → ASCII.
    .replace(/[‘’‚‛′]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[–—−]/g, '-')
    // Non-breaking / zero-width space family → plain space.
    .replace(/[   ​﻿]/g, ' ')
    // Strip HTML tags: email bodies are stored as HTML (dataCleaner keeps it)
    // but the model is shown the text, so a quote won't contain the markup.
    .replace(/<[^>]+>/g, ' ')
    // Decode the entities that survive cleaning.
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    // Collapse all whitespace.
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase();
}

/**
 * Build a validator bound to one context's message + people set.
 * Returns { check, checkMany, rejected } — rejected accumulates as you go.
 *
 * @param {object} ctx
 * @param {object[]} [extraEvidence]
 *   Rows a TOOL fetched during the turn, as { id, text }. Without these the
 *   deal surface's tool loop could not be citation-validated at all: the
 *   context is built BEFORE the question is answered, so a message the model
 *   went and fetched is not in ctx, and every citation to it would be
 *   rejected as unquotable — punishing the model for doing the right thing.
 *   They are held to exactly the same standard as ctx rows; the only thing
 *   that changes is WHERE the quotable text came from.
 */
export function makeValidator(ctx, extraEvidence = []) {
  // Normalised body per message id, built once.
  const bodies = new Map();
  for (const m of ctx.messages) {
    bodies.set(m.message_id, normalise(m.body_text));
  }
  // Notes are first-class evidence, so they're citable too.
  for (const n of ctx.notes) {
    bodies.set(n.note_id, normalise(n.body));
  }
  // Tasks likewise (rule 7). Title AND body are quotable — the commitment is
  // usually in the title ("Send revised quote"), and without it a claim citing
  // a task would be dropped as unquotable even though the task says exactly
  // that.
  for (const t of ctx.tasks || []) {
    bodies.set(t.task_id, normalise([t.title, t.body].filter(Boolean).join('\n')));
  }
  // Tool-fetched rows, added after the ctx ones so a ctx body always wins on
  // a duplicate id — ctx is the audited copy.
  for (const e of extraEvidence) {
    if (!e?.id || bodies.has(e.id)) continue;
    bodies.set(e.id, normalise(e.text || ''));
  }

  const contactIds = new Set(ctx.people.map((p) => p.contact_id));

  const rejected = [];

  function reject(itemType, item, reason) {
    rejected.push({ itemType, item, reason });
    return null;
  }

  /**
   * Validate one cited item. Returns the item (possibly with ids nulled where
   * they were merely optional) or null if it must be dropped.
   *
   * @param itemType  label for the rejection log
   * @param item      must carry quote_message_id + quote_text
   * @param opts.requireQuote  false for items where a null value is a valid
   *                           "not found" answer (whys, qualification)
   * @param opts.contactFields contact-id fields to existence-check
   */
  function check(itemType, item, opts = {}) {
    const { requireQuote = true, contactFields = [] } = opts;
    if (!item || typeof item !== 'object') {
      return reject(itemType, item, 'not an object');
    }

    // A null value is a legitimate answer for whys/qualification (rule 8: no
    // invention). It carries no quote by definition, and that's correct.
    const hasValue = item.value !== undefined
      ? item.value !== null && String(item.value).trim() !== ''
      : true;
    if (!hasValue) {
      return { ...item, value: null, quote_message_id: null, quote_text: null };
    }

    const id = item.quote_message_id;
    const quote = item.quote_text;

    if (!id || !quote || !String(quote).trim()) {
      if (requireQuote) {
        return reject(itemType, item, 'missing quote_message_id or quote_text');
      }
      return { ...item, quote_message_id: null, quote_text: null };
    }

    if (!bodies.has(id)) {
      // The model cited a message that isn't in the set it was given. Almost
      // always an invented id.
      return reject(itemType, item, `quote_message_id "${id}" not in the message set`);
    }

    const haystack = bodies.get(id);
    const needle = normalise(quote);
    if (!needle) {
      return reject(itemType, item, 'quote_text is empty after normalisation');
    }
    if (!haystack.includes(needle)) {
      // The claim may be right and the quote paraphrased — doesn't matter.
      // An unverifiable quote is indistinguishable from a fabricated one, so
      // it doesn't ship.
      return reject(
        itemType,
        item,
        'quote_text is not a verbatim substring of the cited message'
      );
    }

    // Contact-id existence. A wrong id would render as the wrong person's
    // name, which is worse than no name.
    const out = { ...item };
    for (const f of contactFields) {
      if (out[f] && !contactIds.has(out[f])) {
        out[f] = null;
      }
    }
    return out;
  }

  function checkMany(itemType, items, opts) {
    if (!Array.isArray(items)) return [];
    return items.map((i) => check(itemType, i, opts)).filter(Boolean);
  }

  return { check, checkMany, rejected, citableIds: bodies };
}

/**
 * Ask-this-deal citations. Same substring rule, but a citation that fails is
 * stripped rather than dropping the whole answer — the prose may still be
 * sound, and the UI shows the answer with fewer jump links.
 */
export function validateCitations(ctx, citations) {
  const { check, rejected } = makeValidator(ctx);
  const kept = [];
  for (const c of citations || []) {
    const ok = check('citation', { ...c, value: c.quote_text }, { requireQuote: true });
    if (ok) kept.push({ message_id: c.message_id ?? ok.quote_message_id, quote_text: c.quote_text });
  }
  return { citations: kept, rejected };
}

/**
 * Ask-this-deal sends citations as { message_id, quote_text }; the shared
 * checker expects quote_message_id. Normalise before validating so both
 * shapes go through one code path.
 */
export function normaliseCitationShape(citations) {
  if (!Array.isArray(citations)) return [];
  return citations.map((c) => ({
    message_id: c.message_id ?? c.quote_message_id ?? null,
    quote_message_id: c.quote_message_id ?? c.message_id ?? null,
    quote_text: c.quote_text ?? c.text ?? null
  }));
}

// Exposed for tests and for the eval harness.
export const __normalise = normalise;
