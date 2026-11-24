import apiClient from './client'

// How this dashboard is sized, for this sub-account and this person.
//
// Every call returns the same shape — { defaults, account, mine, effective }
// — so a save needs no second GET and the three layers never go out of step
// with each other in the UI.
export const preferencesAPI = {
  get: () => apiClient.get('/api/preferences'),

  // scope: 'user' — just me; 'account' — the default everyone here gets.
  save: (scope, prefs) => apiClient.put('/api/preferences', { scope, prefs }),

  // Remove that layer, so it inherits again. For 'user' that means following
  // the account default; for 'account' it means following the app's own.
  // Not the same as saving the inherited numbers: those would stop tracking
  // the layer above the moment it changed.
  clear: (scope) => apiClient.delete('/api/preferences', { params: { scope } })
}
