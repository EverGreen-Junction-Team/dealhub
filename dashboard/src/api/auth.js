import apiClient from './client'

export const authAPI = {
  verify: ({ locationId, companyId, userId }) =>
    apiClient.post('/auth/verify', { locationId, companyId, userId }),
  refresh: () => apiClient.post('/auth/refresh'),
  getSession: () => apiClient.get('/auth/session'),
}
