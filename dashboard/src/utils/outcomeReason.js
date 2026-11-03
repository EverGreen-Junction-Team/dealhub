// Status -> "why did this deal close?" — the dashboard half.
//
// The server owns the mapping to GHL fields (won -> meddic_10,
// lost -> meddic_9, abandoned -> meddic_11; see services/outcomeReason.js).
// Nothing here repeats those field names: the UI sends a status and a
// sentence, and the server decides where it lands. That keeps one definition
// of a mapping whose numbers do not follow its names.
//
// What lives here is only what the UI needs — which statuses close a deal,
// and how to ask for the reason in each case.

export const CLOSING_STATUSES = ['won', 'lost', 'abandoned']

// Labels are outcome-specific on purpose. "Reason" alone reads as a form
// field; "Why was this deal won?" reads as a question a manager answers.
export const REASON_LABEL = {
  won: 'Why was this deal won?',
  lost: 'Why was this deal lost?',
  abandoned: 'Why was this deal abandoned?'
}

export const REASON_PLACEHOLDER = {
  won: 'What made the difference — price, timing, relationship?',
  lost: "What did we lose on, and to whom?",
  abandoned: 'What happened — went quiet, project shelved, no budget?'
}

// Past-tense wording for the confirmation shown after the change lands.
export const STATUS_VERB = {
  won: 'won',
  lost: 'lost',
  abandoned: 'abandoned',
  open: 'reopened'
}
