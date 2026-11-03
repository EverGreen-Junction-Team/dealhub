// groundingCheck.js — a coarse, after-the-fact check that the portfolio
// Co-Pilot's free-text answer didn't state a deal-specific number for a deal
// no tool call this turn actually returned.
//
// WHY THIS EXISTS. askDeal.js enforces citation-level grounding in code
// (validate.js — every claim's quote must be a literal substring of a real
// message, or it's dropped before the rep sees it). askPortfolio.js has no
// equivalent: its answer is free markdown text, and "never invent" (rule 1
// in tools/prompt.js) is a PROMPT instruction, not a guarantee. A real
// production case: the model stated a specific deal by name with a specific
// £2.58M value and pipeline, several turns after actually reading anything
// about it — no tool call that turn, nothing in the conversation's own
// tool-call history, returned a deal by that name. Two turns later, asked a
// follow-up about that same deal, its own fresh lookups came back empty and
// it correctly flagged the contradiction — but the wrong answer had already
// been shown, rated, and acted on for two turns before that.
//
// WHY COARSE, NOT A FULL VALIDATOR. Free prose has no discrete claims to
// check the way a single quote field does — there is no schema. This checks
// the ONE failure shape that actually happened and is cheap to detect
// reliably: a £ figure sitting next to a deal name that no tool result this
// turn (or earlier in the conversation) ever produced. It does not try to
// verify every sentence, and it never edits or drops text — free text can't
// be safely truncated mid-claim the way a rejected citation can. It only
// flags, so a rep sees the same warning the model itself gave two turns too
// late, on turn one instead.

// £, $ or a bare number with thousands separators AND either a decimal or 3+
// digit groups, so "3 deals" or "in 2026" don't trip this — a monetary
// figure has a currency mark or is written like one (1,234 / 1,234.56).
const MONEY_RE = /(?:[£$€]\s?[\d,]+(?:\.\d+)?|\b\d{1,3}(?:,\d{3})+(?:\.\d+)?\b)/g;

/**
 * @param {string} answerText
 * @param {Array<{id, name}>} knownDeals   Every deal any tool call this turn
 *   (or carried forward from earlier in the conversation) actually returned
 *   — the same set askPortfolio.js already builds for dealsRead/dealsTable,
 *   passed in rather than re-derived so this can't drift from what the rep
 *   sees as "Read".
 * @returns {string[]} warnings — empty when nothing looks unbacked.
 */
export function checkGrounding(answerText, knownDeals = []) {
  if (!answerText) return [];

  // .match() on a /g regex returns all matches and leaves lastIndex at 0,
  // but be explicit: every entry point to this function resets it, so no
  // caller can be affected by a previous call's leftover state.
  MONEY_RE.lastIndex = 0;
  const moneyMentions = answerText.match(MONEY_RE);
  if (!moneyMentions?.length) return [];

  // Normalised for COMPARISON only — the warning still prints what the model
  // actually wrote. Runs of whitespace collapse to one, because the model
  // re-renders a name into its prose and "Acme  Roofing" vs "Acme Roofing" is
  // a formatting difference, not a different deal. Flagging that would be a
  // warning about correct output, which is the failure mode this check can
  // least afford.
  const norm = (t) => (t || '').trim().toLowerCase().replace(/\s+/g, ' ');
  const knownNames = new Set(knownDeals.map((d) => norm(d.name)).filter(Boolean));

  // A deal name in **bold** markdown right before a £ figure on the same
  // line — the exact shape the model's own answers use for a deal fact
  // ("**Name** — stage, £X") whether from a real tool result or not. This
  // catches a bolded name with no matching tool result AND a money figure
  // nearby, which is the specific pattern that went wrong: a real-looking
  // fact with nothing behind it.
  //
  // MATCHES THE BOLDED NAME ONLY. The trailing [^\n]{0,60} this used to carry
  // was greedy, so on a line like
  //   "**Acme Roofing** at £8,398 and **Phantom Manor** at £2,580,000."
  // the FIRST match consumed the rest of the line — the second bolded name
  // included — and lastIndex resumed past it. Only one candidate per line was
  // ever examined, so an invented deal went unflagged whenever a real one
  // appeared before it on the same line. That is the shape a real answer
  // takes: two or three genuine deals and one the model made up.
  //
  // The 40-character window used for the money test is sliced out of
  // answerText below, so the regex never needed to consume it.
  const boldNameRe = /\*\*([^*]{2,80})\*\*/g;
  // Bold text the model uses for its own structure, not a claimed record —
  // "**Summary** — 3 deals, £45,200 combined" is a heading over an
  // aggregate, not a fact about one deal called "Summary". Checked as a
  // whole-string match against the bolded text, not a substring, so a real
  // deal that happens to CONTAIN one of these words (e.g. "Summary House
  // Renovation") still gets checked normally.
  const STRUCTURAL_LABELS = new Set([
    'summary', 'note', 'notes', 'total', 'totals', 'correction',
    'context', 'update', 'caveat', 'important', 'warning', 'overview'
  ]);
  // WHAT CAN BE A DEAL NAME AT ALL.
  //
  // The bold regex matches any **...**, and the model bolds plenty that is not
  // a deal: a stage ("**Quote Sent**"), a metric, a fragment of its own prose.
  // Two of those reached a rep as warnings — one reading
  //   "This answer names a deal ((147 days in that stage). -)"
  // which is not a name and not a sentence, and one naming "Quote Sent", a
  // pipeline stage, as an unbacked deal. A warning that is itself wrong is
  // worse than none: it teaches people to ignore the banner, which is the one
  // thing it cannot afford.
  //
  // So a candidate must LOOK like a name before it is worth checking.
  const looksLikeDealName = (t) => {
    // Must start with a letter or digit — "(147 days..." does not.
    if (!/^[\p{L}\p{N}]/u.test(t)) return false;
    // Mostly letters, digits, spaces and the punctuation real names carry.
    // A string that is largely brackets, dashes and full stops is prose the
    // model happened to bold.
    const wordish = (t.match(/[\p{L}\p{N}]/gu) || []).length;
    if (wordish / t.length < 0.6) return false;
    // A trailing sentence mark means a clause was captured, not a name.
    if (/[.;:!?]$/.test(t)) return false;
    // A bolded number ("**£4,200**") is a figure, not a name.
    if (/^[\p{N}£$€,.\s]+$/u.test(t)) return false;
    // So is a measurement — "**147 days**", "**3 weeks**". It starts with a
    // digit and carries a unit, which no deal name does. Checked separately
    // because the number-only test above does not see the trailing word.
    if (/^[\p{N}][\p{N},.\s]*\s*(days?|weeks?|months?|years?|hours?|mins?|minutes?|deals?|%)$/iu.test(t)) {
      return false;
    }
    // A name has to contain at least one letter.
    if (!/\p{L}/u.test(t)) return false;
    return true;
  };

  // Pipeline stages are bolded constantly and are never deal names. Taken from
  // the stage map the skills use, lower-cased.
  const STAGE_NAMES = new Set([
    'new lead', 'marketing qualified', 'initial contact made', 'sales qualified',
    'waiting on details', 'quote sent', 'negotiation', 'deposit & sales contract',
    'won', 'lost', 'abandoned', 'open'
  ]);

  const warnings = [];
  let m;
  while ((m = boldNameRe.exec(answerText))) {
    const claimedName = m[1].trim();
    if (STRUCTURAL_LABELS.has(norm(claimedName))) continue;
    if (STAGE_NAMES.has(norm(claimedName))) continue;
    if (!looksLikeDealName(claimedName)) continue;
    const tail = answerText.slice(m.index, m.index + m[0].length + 40);
    // RESET BEFORE, NOT AFTER.
    //
    // MONEY_RE is a /g regex, so .test() advances its lastIndex — and the
    // reset used to sit AFTER the `continue`, so it was skipped on every
    // candidate that had no money beside it. The next .test() then started
    // mid-string and returned false for a figure that was plainly there.
    //
    // The visible effect was a FALSE NEGATIVE, which is the quiet half of
    // this bug: an invented deal went unflagged whenever a correctly-backed
    // one appeared earlier in the same answer — exactly the shape a real
    // answer takes, two or three real deals and one the model made up.
    // Resetting first makes each candidate independent of the last.
    MONEY_RE.lastIndex = 0;
    if (!MONEY_RE.test(tail)) continue;
    if (!knownNames.has(norm(claimedName))) {
      warnings.push(claimedName);
    }
  }

  if (!warnings.length) return [];
  // Deduped, and capped — this is a warning banner, not a report.
  const unique = [...new Set(warnings)].slice(0, 5);
  return [
    `This answer names ${unique.length === 1 ? 'a deal' : `${unique.length} deals`} `
      + `(${unique.join(', ')}) with a figure that doesn't match anything this turn's `
      + `lookups actually returned — check it before acting on it.`
  ];
}
