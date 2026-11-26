// The client's open questions, as the dashboard shows them.
//
// The ANSWERS live on the server, in server/src/services/opsDecisions.js, and
// reach the page through GET /api/ops/decisions — this file only says what
// each pending question means to someone using the app. When a question is
// answered there, its line here simply stops showing.
//
// See docs/operations-hub-plan.md §4.

export const QUESTION_TEXT = {
  Q1: 'Starting a project from a won deal — until decided, move or create the deal in the Operations pipeline in your CRM and it appears here.',
  Q2: 'Where job numbers and remedial references come from — until decided, type them on each job.',
  Q4: 'Where task links live — tasks are CRM tasks on the customer, linked to the job in Deal Hub.'
}

export function pendingLines(decisions) {
  return (decisions?.pending || []).map((q) => ({ q, text: QUESTION_TEXT[q] || q }))
}
