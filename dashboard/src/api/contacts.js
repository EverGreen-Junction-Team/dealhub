import apiClient from './client'

export const contactsAPI = {
  // Every message for this contact, with the deal each is filed against.
  // unlinkedOnly narrows it to the ones that need a decision.
  messages: (id, { unlinkedOnly = false, limit } = {}) =>
    apiClient.get(`/api/contacts/${encodeURIComponent(id)}/messages`, {
      params: { unlinkedOnly: unlinkedOnly || undefined, limit }
    }),

  // Bulk-assign messages to a deal (null to unlink). Local only, and each is
  // recorded as a manual decision.
  setMessagesMapping: (id, messageIds, opportunityId) =>
    apiClient.put(`/api/contacts/${encodeURIComponent(id)}/messages/mapping`, {
      messageIds, opportunityId
    }),


  // Upload files to a FILE_UPLOAD custom field.
  //
  // multipart, so no JSON Content-Type — axios sets the boundary itself when
  // handed a FormData, and setting it manually omits that boundary and the
  // request is unparseable at the other end.
  uploadCustomFieldFiles: (id, fieldKey, files) => {
    const form = new FormData()
    for (const f of files) form.append('files', f)
    return apiClient.post(
      `/api/contacts/${encodeURIComponent(id)}/custom-fields/${encodeURIComponent(fieldKey)}/files`,
      form
    )
  },
  list: (params = {}) => apiClient.get('/api/contacts', { params }),
  // POST /api/contacts — creates in GHL and lands the row locally at once.
  create: (payload) => apiClient.post('/api/contacts', payload),
  // DELETE /api/contacts/:id — deletes in GHL, soft-deletes here.
  remove: (id) => apiClient.delete(`/api/contacts/${encodeURIComponent(id)}`),
  get: (id) => apiClient.get(`/api/contacts/${encodeURIComponent(id)}`),
  update: (id, patch) =>
    apiClient.patch(`/api/contacts/${encodeURIComponent(id)}`, patch),
  setDnd: (id, channel, blocked) =>
    apiClient.put(`/api/contacts/${encodeURIComponent(id)}/dnd`, { channel, blocked }),

  // Tags have their own endpoints because they must be ADDITIVE. The general
  // update above replaces the whole tag array, so it refuses `tags` outright —
  // a partial list would silently delete the rest.
  addTags: (id, tags) =>
    apiClient.post(`/api/contacts/${encodeURIComponent(id)}/tags`, { tags }),
  removeTags: (id, tags) =>
    apiClient.delete(`/api/contacts/${encodeURIComponent(id)}/tags`, { data: { tags } }),

  // Every tag defined in the location — for autocomplete, so a rep picks an
  // existing tag rather than creating a near-duplicate.
  tagCatalogue: () => apiClient.get('/api/contacts/tags/catalogue')
}
