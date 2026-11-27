import apiClient from './client'

// Endpoints backing the Deal Hub view.
// Contract mirrors the shapes returned by server/src/routes/deals.js.
// How long to wait before re-reading a deal after a write. Nothing when the
// server says the write is already in our database; otherwise the old guess
// at GHL's webhook round trip.
export const WEBHOOK_WAIT_MS = 2500
export function settleDelay(res) {
  return res?.mirrored ? 0 : WEBHOOK_WAIT_MS
}

export const dealsAPI = {

  // Upload files to a FILE_UPLOAD custom field.
  //
  // multipart, so no JSON Content-Type — axios sets the boundary itself when
  // handed a FormData, and setting it manually omits that boundary and the
  // request is unparseable at the other end.
  uploadCustomFieldFiles: (id, fieldKey, files) => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    return apiClient.post(
      `/api/deals/${encodeURIComponent(id)}/custom-fields/${encodeURIComponent(fieldKey)}/files`,
      form
    )
  },
  // `params` may carry: status, q, limit, cursor, contactId, and — for the
  // board and table views — stageId, pipelineId, assignedTo.
  //
  // The board fetches one COLUMN at a time with stageId rather than pulling
  // every deal and grouping client-side: a pipeline can hold hundreds, and
  // rendering one screen should not mean holding all of them in memory.
  list: (params = {}) => apiClient.get('/api/deals', { params }),
  get: (id) => apiClient.get(`/api/deals/${encodeURIComponent(id)}`),
  // `params` (optional): { limit, before } for infinite scroll — the newest
  // `limit` rows, or the `limit` before a cursor. The response then carries
  // `hasMore` and `nextBefore`. No params = the whole timeline, as before.
  timeline: (id, params) =>
    apiClient.get(`/api/deals/${encodeURIComponent(id)}/timeline`, params ? { params } : undefined),
  // Send from the timeline composer. Goes to GHL; the message reaches the
  // timeline by webhook a moment later, filed on THIS deal (the server parks
  // the deal for that webhook). See POST /api/deals/:id/messages.
  //
  // { type: 'Email'|'SMS'|'WhatsApp', contactId, conversationProviderId?,
  //   message?, subject?, html?, emailCc?, emailBcc?, replyToMessageId? }
  sendMessage: (id, payload) =>
    apiClient.post(`/api/deals/${encodeURIComponent(id)}/messages`, payload),
  // The composer's paperclip: upload to GHL first, then send the returned
  // urls as `attachments`.
  //
  // The multipart header is REQUIRED here. apiClient defaults every request
  // to application/json, and axios 1.x answers FormData + a JSON content type
  // by serialising the form to a JSON string — the files are dropped and the
  // server receives no upload. Naming multipart keeps the FormData intact;
  // the browser then supplies the boundary itself.
  uploadMessageAttachments: (id, contactId, files) => {
    const form = new FormData()
    form.append('contactId', contactId)
    for (const f of files) form.append('files', f)
    return apiClient.post(`/api/deals/${encodeURIComponent(id)}/messages/attachments`, form, {
      headers: { 'Content-Type': 'multipart/form-data' }
    })
  },
  stages: (id) => apiClient.get(`/api/deals/${encodeURIComponent(id)}/stages`),
  reassignmentTargets: (id) =>
    apiClient.get(`/api/deals/${encodeURIComponent(id)}/reassignment-targets`),

  // Move one message to a different deal. LOCAL ONLY — the CRM has no concept
  // of which deal a message belongs to, so this changes our attribution and
  // nothing upstream. Recorded as a manual decision, which the attribution
  // engine never overwrites.
  //
  // opportunityId null unlinks the message from every deal.
  setMessageMapping: (dealId, messageId, opportunityId) =>
    apiClient.put(
      `/api/deals/${encodeURIComponent(dealId)}/messages/${encodeURIComponent(messageId)}/mapping`,
      { opportunityId }
    ),

  // Writes go to GoHighLevel — see the server's ghlOpportunityWrite.js. They
  // need the opportunities.write scope, separate from the readonly the sync
  // uses.
  //
  // WRITTEN THROUGH. After GHL accepts a change the server fetches GHL's copy
  // back and writes it to our database before answering — through the same
  // handler the webhook uses, so stage_history stays right (the server's
  // services/dealWriteThrough.js). The response then carries `mirrored: true`
  // and a refetch straight away shows the change. When it is false (GHL slow
  // to read back, say) the change still lands with the webhook, so callers
  // wait for that instead — settleDelay() below.

  // Send only what changed. STATUS IS NOT ACCEPTED here — use setStatus, the
  // only route that can record a lost reason.
  update: (id, patch) =>
    apiClient.patch(`/api/deals/${encodeURIComponent(id)}`, patch),

  // Its own endpoint because a lost reason can only be attached here; the
  // general update silently drops it.
  //
  // `reason` is the free text explaining the outcome. The server files it in
  // the field matching the status — won -> meddic_10, lost -> meddic_9,
  // abandoned -> meddic_11 — and REQUIRES it for all three; only a move back
  // to Open may omit it.
  //
  // Resolves to { ok, status, reasonSaved, reasonError }. The status and the
  // reason are two separate GHL calls, so `reasonError` with ok:true means the
  // deal DID change status but the reason did not save. Show that, rather
  // than treating it as a failed save.
  setStatus: (id, status, { lostReasonId, reason } = {}) =>
    apiClient.put(`/api/deals/${encodeURIComponent(id)}/status`, {
      status, lostReasonId, reason
    }),

  // The location's lost reasons, for the picker shown when marking a deal lost.
  lostReasons: () => apiClient.get('/api/deals/lost-reasons'),

  // Picklist choices for the opportunity custom fields shown as chips on the
  // deal card. Location-wide; fetch once per session.
  customFieldOptions: () => apiClient.get('/api/deals/custom-field-options'),

  // Every pipeline with its stages nested. One request rather than a stages
  // call per pipeline: the expanding row needs the target pipeline's stages the
  // moment a rep picks it, and a location has single-digit pipelines.
  // Location-wide; fetch once per session.
  pipelines: () => apiClient.get('/api/deals/pipelines'),

  // Active CRM users, for the Owner and Followers pickers. Both take a GHL user
  // id. Location-wide; fetch once per session.
  users: () => apiClient.get('/api/deals/users'),
  // The SIGNED-IN user, by id and with no type filter — `users` above is the
  // rep picker and excludes agency staff, which is often exactly who is
  // holding the session.
  me: () => apiClient.get('/api/deals/me'),

  create: (fields) => apiClient.post('/api/deals', fields),
  remove: (id) => apiClient.delete(`/api/deals/${encodeURIComponent(id)}`),

  // People on the deal. `relationId`, not contactId, on remove: an
  // opportunity↔contact relation is a real row with its own id, which is why
  // opportunity_contacts is keyed on it.
  addContact: (id, contactId) =>
    apiClient.post(`/api/deals/${encodeURIComponent(id)}/contacts`, { contactId }),
  // Change which contact the deal belongs to. A dedicated endpoint because
  // contactId is undocumented on GHL's opportunity PUT — see the route.
  setPrimaryContact: (id, contactId) =>
    apiClient.put(
      `/api/deals/${encodeURIComponent(id)}/primary-contact`, { contactId }
    ),
  removeContact: (id, relationId) =>
    apiClient.delete(
      `/api/deals/${encodeURIComponent(id)}/contacts/${encodeURIComponent(relationId)}`
    ),

  // Additive both ways, like contact tags.
  addFollowers: (id, followers) =>
    apiClient.post(`/api/deals/${encodeURIComponent(id)}/followers`, { followers }),
  removeFollowers: (id, followers) =>
    apiClient.delete(`/api/deals/${encodeURIComponent(id)}/followers`, { data: { followers } })
}

// Saved views — named filter sets for the board and table.
//
// `filters` is the same set of query parameters dealsAPI.list accepts, so
// applying a view means putting them back on the list request rather than
// translating between two shapes.
export const savedViewsAPI = {
  list: (scope = 'deals') => apiClient.get('/api/saved-views', { params: { scope } }),
  save: ({ name, filters, isShared = false, scope = 'deals' }) =>
    apiClient.post('/api/saved-views', { name, filters, isShared, scope }),
  remove: (id) => apiClient.delete(`/api/saved-views/${encodeURIComponent(id)}`)
}
