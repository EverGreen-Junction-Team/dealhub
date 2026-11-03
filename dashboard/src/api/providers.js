import apiClient from './client'

// The conversation-provider catalogue: which senders a message can go out
// through, per channel.
//
// A location can run GHL's native channel alongside a custom marketplace
// provider that shares its name — native WhatsApp next to a provider called
// "WhatsApp QR", or an "SMS Android" sitting under the SMS channel. Sending a
// bare `type` lets GHL pick whichever it considers default, so the rep needs
// to see the choice when one genuinely exists.
export const providersAPI = {
  // scope 'composable' (default) returns only channels this app can compose
  // for, each already including its native sender as the first option.
  // scope 'all' returns every channel in the catalogue, for the settings view.
  list: (params = {}) => apiClient.get('/api/providers', { params }),
}
