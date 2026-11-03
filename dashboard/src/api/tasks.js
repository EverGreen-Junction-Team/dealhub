import apiClient from './client'

const enc = encodeURIComponent

export const tasksAPI = {
  list: (params = {}) => apiClient.get('/api/tasks', { params }),

  // Writes go to GoHighLevel, not to our database — see the server's
  // ghlTaskWrite.js. Each returns the task GHL echoed back, so the caller can
  // apply what GHL actually stored rather than what it hoped it would.

  // A task needs a contact: GHL stores tasks against the contact, so a deal
  // alone isn't enough to create one.
  //
  // opportunityId / businessId are ASSOCIATIONS, applied by the server once the
  // task exists. A link failure returns `relationError` with the task still
  // created.
  create: ({ contactId, title, body, dueDate, assignedTo, opportunityId, businessId }) =>
    apiClient.post('/api/tasks', {
      contactId, title, body, dueDate, assignedTo, opportunityId, businessId
    }),

  // Send only what changed.
  update: (id, patch) => apiClient.patch(`/api/tasks/${enc(id)}`, patch),

  // Link or unlink the deal and the company a task belongs to.
  //
  // UNLIKE NOTES these are genuinely additive — GHL's caps are 10, not 1 — so
  // attaching a second deal ADDS it. Changing a task's deal therefore needs an
  // explicit removeRelations for the old one.
  setRelations: (id, { opportunityId, businessId, updateFutureTasks } = {}) =>
    apiClient.put(`/api/tasks/${enc(id)}/relations`, {
      opportunityId, businessId, updateFutureTasks
    }),
  removeRelations: (id, { opportunityId, businessId } = {}) =>
    apiClient.put(`/api/tasks/${enc(id)}/relations`, {
      opportunityId, businessId, remove: true
    }),

  // Its own endpoint rather than update({ completed }) — the narrowest request
  // for ticking a checkbox, so it can't disturb a title or due date.
  setCompleted: (id, completed) =>
    apiClient.put(`/api/tasks/${enc(id)}/completed`, { completed }),

  // Deal / company links, IN OUR DATABASE ONLY.
  //
  // GHL blocks task relation writes on the OAuth channel entirely, so there is
  // no upstream call to make — see the server route for the detail. Our copy
  // is authoritative until GHL sends a task payload that says otherwise.
  setLocalLinks: (id, { opportunityId, businessId } = {}) =>
    apiClient.put(`/api/tasks/${enc(id)}/local-links`, { opportunityId, businessId }),

  remove: (id) => apiClient.delete(`/api/tasks/${enc(id)}`)
}
