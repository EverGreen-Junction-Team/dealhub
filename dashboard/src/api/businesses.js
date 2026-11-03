import apiClient from './client'

// Businesses — the roll-up layer. A business sits above deals: one company,
// several contacts, several deals, and one conversation stream across all of
// them.
export const businessesAPI = {
  list: (params = {}) => apiClient.get('/api/businesses', { params }),
  get: (id) => apiClient.get(`/api/businesses/${encodeURIComponent(id)}`),
  // Paginated separately from get(): a business with two years of history has
  // thousands of messages and they must not all land in the detail response.
  conversations: (id, params = {}) =>
    apiClient.get(`/api/businesses/${encodeURIComponent(id)}/conversations`, { params }),

  // Writes go to GoHighLevel — see the server's ghlBusinessWrite.js. They need
  // the businesses.write scope, which is separate from the businesses.readonly
  // the daily sync uses.
  //
  // Unlike contacts, notes and tags, businesses have NO webhooks, so the server
  // applies the echoed response to our row itself. Without that a change would
  // be invisible here until the nightly sync.
  create: (fields) => apiClient.post('/api/businesses', fields),

  // Send only what changed. locationId is never sent — the server takes it from
  // the session, and GHL rejects it on an update anyway (a business cannot move
  // location).
  update: (id, patch) =>
    apiClient.patch(`/api/businesses/${encodeURIComponent(id)}`, patch),

  // Soft delete on both sides. Contacts pointing at it are NOT deleted — they
  // simply stop resolving to a business.
  remove: (id) => apiClient.delete(`/api/businesses/${encodeURIComponent(id)}`)
}
