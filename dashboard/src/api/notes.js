import apiClient from './client'

const enc = encodeURIComponent

export const notesAPI = {
  // The note's DEAL, in our database only — GHL's note relations endpoint
  // needs the notes.write scope this app does not hold. The COMPANY does not
  // come through here: businessId is a plain field on the note patch and
  // saves upstream normally.
  setLocalLinks: (id, { opportunityId } = {}) =>
    apiClient.put(`/api/notes/${encodeURIComponent(id)}/local-links`, { opportunityId }),

  list: (params = {}) => apiClient.get('/api/notes', { params }),

  // Writes go to GoHighLevel, not to our database — see the server's
  // ghlNoteWrite.js. Each returns the note GHL echoed back.

  // A note needs a contact: GHL stores notes against the contact, so a deal
  // alone isn't enough to create one.
  //
  // opportunityId / businessId are ASSOCIATIONS, applied by the server after
  // the note exists (the relations endpoint is keyed on the note id). A failure
  // to link comes back as `relationError` with the note still created — the
  // note is the thing that matters and the link is recoverable.
  // `userId` (optional): the GHL user to author it — the composer passes the
  // signed-in rep, so an internal comment says who wrote it, not "Unknown".
  create: ({ contactId, body, title, color, pinned, opportunityId, businessId, userId }) =>
    apiClient.post('/api/notes', {
      contactId, body, title, color, pinned, opportunityId, businessId, userId
    }),

  // Send only what changed.
  update: (id, patch) => apiClient.patch(`/api/notes/${enc(id)}`, patch),

  // Link or unlink the deal and the company a note belongs to.
  //
  // Its own endpoint, not part of update(): different GHL endpoint, and the
  // note patch rejects unknown fields.
  //
  // NOTE THE CAP OF ONE on the deal link — attaching a deal to a note that
  // already has a different one REPLACES it silently. That is intended (a note
  // is about one deal) but it is a removal the caller did not ask for.
  setRelations: (id, { opportunityId, businessId } = {}) =>
    apiClient.put(`/api/notes/${enc(id)}/relations`, { opportunityId, businessId }),
  removeRelations: (id, { opportunityId, businessId } = {}) =>
    apiClient.put(`/api/notes/${enc(id)}/relations`, {
      opportunityId, businessId, remove: true
    }),

  // GHL's restore endpoint is not available over OAuth, so this is final as far
  // as the app is concerned — our row keeps the text, soft-deleted.
  remove: (id) => apiClient.delete(`/api/notes/${enc(id)}`)
}
