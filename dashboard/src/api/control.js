import apiClient from './client'
import { API_BASE_URL } from '../constants/api'

// Control panel — v5. One markdown file of business context, plus the
// read-only qualification headings.
export const controlAPI = {
  // Run one catalogue sync now, for THIS sub-account.
  //
  // Businesses, tags and custom field definitions arrive by no webhook —
  // GHL fires nothing when one is created, renamed or deleted — so without
  // this they appear only after the 3am reconciliation. `kind` is one of
  // 'businesses' | 'tags' | 'customFields'; the server allow-lists it.
  //
  // Its own timeout: these call GHL and page through a catalogue, which can
  // outrun the client's 60s default on a large account.
  // NO BODY ARGUMENT. Passing `null` here sent the literal string "null" as
  // the request body, and body-parser rejects that as invalid JSON before the
  // route is ever reached — a 500 from the error handler, not from the sync.
  // Omitting it is what every other bodyless POST in this file does.
  runSync: (kind) =>
    apiClient.post(`/api/control/sync/${encodeURIComponent(kind)}`, undefined, { timeout: 120_000 }),

  get: () => apiClient.get('/api/control'),
  saveBusinessContext: (content, filename) =>
    apiClient.put('/api/control/business-context', { content, filename }),

  // The signed-in rep's email sign-off. No user id is sent: the server always
  // uses the session's own, so one rep cannot read or overwrite another's.
  getSignature: () => apiClient.get('/api/control/signature'),
  saveSignature: (html) => apiClient.put('/api/control/signature', { html }),
  deleteSignature: () => apiClient.delete('/api/control/signature'),

  // AI skills — a saved database view the AI can query as a tool.
  //
  // No SQL crosses this boundary in either direction. A skill carries a view
  // NAME and which of its columns may be filtered on; the server builds the
  // query. See the server's skillValidator.js for why, and for the
  // security_invoker check that stops a view bypassing row-level security.
  listSkills: () => apiClient.get('/api/control/skills'),
  createSkill: (skill) => apiClient.post('/api/control/skills', skill),
  updateSkill: (id, patch) => apiClient.put(`/api/control/skills/${encodeURIComponent(id)}`, patch),
  deleteSkill: (id) => apiClient.delete(`/api/control/skills/${encodeURIComponent(id)}`),
  // The view's real columns, so the form offers them instead of asking
  // someone to remember a name — which is where typos come from.
  // Every view a skill may point at — the dropdown's options.
  listViews: () => apiClient.get('/api/control/skills/views'),
  describeView: (name) =>
    apiClient.get(`/api/control/skills/views/${encodeURIComponent(name)}`),

  // Download can't go through the axios client: it returns a file, and the
  // session token lives in localStorage rather than a cookie, so a plain
  // window.open would arrive unauthenticated. Fetch it with the header, then
  // hand the browser a blob.
  downloadBusinessContext: async () => {
    const token = sessionStorage.getItem('sessionToken')
    const res = await fetch(`${API_BASE_URL}/api/control/business-context/download`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    })
    if (!res.ok) throw new Error('Could not download the file')
    const blob = await res.blob()
    const name =
      (res.headers.get('content-disposition') || '').match(/filename="([^"]+)"/)?.[1]
      || 'business-context.md'
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = name
    document.body.appendChild(a)
    a.click()
    a.remove()
    // Revoke on the next tick — revoking synchronously can cancel the download
    // in some browsers before it starts.
    window.setTimeout(() => URL.revokeObjectURL(url), 0)
  }
}
