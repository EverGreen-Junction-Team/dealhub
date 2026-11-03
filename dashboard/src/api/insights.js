import apiClient from './client'

// Insights — one request per chart, not one for the page.
//
// 24 cards draw 26 charts across 27 pre-aggregated views. A single endpoint
// would run all of them on every load, so the slowest query would decide how
// long the page took and one failure would cost the lot. Per chart, a card
// fetches only when it is on screen and a broken insight is a broken card.
//
// The location is never sent: the server reads it from the session's JWT.
export const insightsAPI = {
  /** The chart keys this build can serve — a card whose key is absent is
   *  genuinely not wired up, as opposed to one whose query failed. */
  keys: () => apiClient.get('/api/insights/charts'),

  /** `sets` is one row array per view the chart reads, in the order its
   *  adapter expects. */
  chart: (key) => apiClient.get(`/api/insights/charts/${encodeURIComponent(key)}`)
}
