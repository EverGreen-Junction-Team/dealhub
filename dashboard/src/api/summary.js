import apiClient from './client'

export const summaryAPI = {
  counts: () => apiClient.get('/api/summary/counts')
}
