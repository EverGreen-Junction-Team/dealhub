// threadBudget.js — how much of a deal's thread the AI is allowed to read.
//
// Dependency-free (no db, no config, no logger) so it can be unit-tested
// without an environment, in the same spirit as validate.js and
// citationSource.js. This function decides what evidence reaches the model, so
// it is the last place that should be hard to test.

// Default thread budget, in tokens. 150k leaves the business context, the
// rules, the chat history and a 4k answer comfortable room inside Sonnet 5's
// 1M window, while capping a runaway account at ~$0.45 a question rather than
// $1.84.
export const THREAD_TOKEN_BUDGET = 150_000;

// Keep the newest messages that fit the budget; report the rest.
//
// Walks newest-first so the most recent thread always survives, then restores
// chronological order — rule 4 ("chronology is meaning") depends on the model
// receiving them oldest-first.
//
// A single message larger than the whole budget (a very long transcript) is
// still kept: dropping everything and answering from nothing is worse than one
// oversized message, and the coverage stamp reports the rest.
export function applyThreadBudget(messages, budgetTokens) {
  if (!messages.length) return { kept: messages, dropped: 0 };

  const cost = (m) => Math.ceil(((m.body_text?.length || 0) + 200) / 4); // +200 ≈ the XML wrapper
  const kept = [];
  let used = 0;

  for (let i = messages.length - 1; i >= 0; i--) {
    const c = cost(messages[i]);
    if (used + c > budgetTokens && kept.length > 0) break;
    kept.push(messages[i]);
    used += c;
  }

  kept.reverse();
  return { kept, dropped: messages.length - kept.length };
}
