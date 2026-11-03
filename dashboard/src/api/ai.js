import apiClient from './client'

// How long the browser waits for an ANSWER, as opposed to a record.
//
// apiClient's own 60s suits the rest of this file — those are ordinary reads
// and writes, and a minute is already generous for one. The two `ask` calls
// are not ordinary: each runs a tool loop of up to 6 sequential Claude calls
// (server: toolLoop.js MAX_ROUNDS, claudeClient.js timeout 120_000,
// maxRetries 2), so a long thread can legitimately pass a minute before the
// first byte comes back.
//
// At 60s the browser gave up on work the server had already finished and
// written — the rep saw "check your connection", retried, and got the answer
// the first attempt had produced. The network was never the problem.
//
// 180s covers the common slow case (3-4 rounds) without letting a genuinely
// stuck request hang indefinitely. It is deliberately NOT the server's own
// worst case: past three minutes a rep needs to be told something went wrong
// far more than they need to keep waiting.
const ASK_TIMEOUT_MS = 180_000

// Deal Hub AI. Contract mirrors pipelinePulse/server/src/routes/ai.js.
export const aiAPI = {
  // Skills a rep can @-mention in the Insights AI composer.
  //
  // Not /api/control/skills — that is the admin view and returns view names,
  // column mappings and operators. A rep picking from a menu needs a name and
  // a sentence, and nothing about the database belongs on a sales rep's
  // screen. Portfolio only: Deal AI cannot run a skill, so offering one there
  // would be a menu of things that do nothing.
  skills: () => apiClient.get('/api/ai/skills'),

  status: () => apiClient.get('/api/ai/status'),
  // `images` are a question aid, not evidence — the server states that boundary
  // to the model, and validate.js still requires a message quote for every
  // claim. Each is { mediaType, data } with data as bare base64.
  // `signal` — see askPortfolio's own note below; same client-side abandon,
  // now available on both Co-Pilot surfaces rather than just the portfolio
  // one.
  ask: (dealId, {
    question, history = [], channels = null, images = [], conversationId = null, replyTo = null, signal
  }) =>
    apiClient.post(`/api/ai/deals/${encodeURIComponent(dealId)}/ask`, {
      question,
      history,
      channels,
      images,
      conversationId,
      // { messageId, subject } when the question came from Reply on an email.
      replyTo
    }, { signal, timeout: ASK_TIMEOUT_MS }),
  // Portfolio — one question across every deal in the sub-account. Same
  // `images` contract as `ask` above.
  // `signal` lets the Co-Pilot's stop button abandon the request client-side
  // — the server keeps working (there's no cheap way to cancel an in-flight
  // Claude tool-call loop from here), but the rep gets their composer back
  // immediately instead of waiting out a question they no longer want
  // answered.
  askPortfolio: ({ question, history = [], images = [], conversationId = null, signal }) =>
    apiClient.post('/api/ai/portfolio/ask', { question, history, images, conversationId }, { signal, timeout: ASK_TIMEOUT_MS }),
  portfolioHistory: () => apiClient.get('/api/ai/portfolio/ask/history'),
  // `reasons` are chip ids from the negative-feedback modal (see
  // NEGATIVE_FEEDBACK_CHIPS in CopilotTab.jsx) — matching GHL's own
  // NegativeFeedbackModal.vue set, validated server-side against the same
  // list. `reason` is that modal's free-text "Share details" field.
  rateRun: (runId, { rating, reasons = [], reason }) =>
    apiClient.post(`/api/ai/runs/${encodeURIComponent(runId)}/rating`, { rating, reasons, reason }),
  deleteConversation: (conversationId) =>
    apiClient.delete(`/api/ai/conversations/${encodeURIComponent(conversationId)}`),
  renameConversation: (conversationId, title) =>
    apiClient.patch(`/api/ai/conversations/${encodeURIComponent(conversationId)}`, { title }),
  runMessages: (runId) =>
    apiClient.get(`/api/ai/runs/${encodeURIComponent(runId)}/messages`),
  feedback: (runId, payload) =>
    apiClient.post(`/api/ai/runs/${encodeURIComponent(runId)}/feedback`, payload),
  askHistory: (dealId) =>
    apiClient.get(`/api/ai/deals/${encodeURIComponent(dealId)}/ask/history`),
  // Batch: the timeline ticks several boxes before asking, so changes are
  // flushed together instead of one request per click.
  setInclusions: (dealId, changes) =>
    apiClient.put(`/api/ai/deals/${encodeURIComponent(dealId)}/inclusions`, { changes }),
  setInclusion: (dealId, messageId, included, reason) =>
    apiClient.put(
      `/api/ai/deals/${encodeURIComponent(dealId)}/messages/${encodeURIComponent(messageId)}/inclusion`,
      { included, reason }
    ),
  // Co-Pilot "Personalization" — facts a rep has asked it to remember
  // across every future chat. Explicit save + bulk import only; see
  // server/migrations/075_ai_memories.sql for why there's no automatic
  // mid-chat extraction.
  listMemories: () => apiClient.get('/api/ai/memory'),
  createMemory: (content) => apiClient.post('/api/ai/memory', { content }),
  importMemories: (memories) => apiClient.post('/api/ai/memory/import', { memories }),
  deleteMemory: (memoryId) => apiClient.delete(`/api/ai/memory/${encodeURIComponent(memoryId)}`),
  deleteAllMemories: () => apiClient.delete('/api/ai/memory'),
  // Proposed CRM writes — create contact / attach contact / change owner /
  // change status. A propose tool only ever inserts a pending row server-
  // side (server/migrations/077_ai_actions.sql); these are the only calls
  // that turn one into a real GHL write. `edits` carries just the fields a
  // rep changed in the ActionCard, merged server-side over what the model
  // proposed.
  getAction: (actionId) => apiClient.get(`/api/ai/actions/${encodeURIComponent(actionId)}`),
  confirmAction: (actionId, edits) =>
    apiClient.post(`/api/ai/actions/${encodeURIComponent(actionId)}/confirm`, { edits }),
  rejectAction: (actionId) =>
    apiClient.post(`/api/ai/actions/${encodeURIComponent(actionId)}/reject`)
}
