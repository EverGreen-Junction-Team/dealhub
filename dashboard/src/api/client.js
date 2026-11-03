import axios from 'axios'
import { API_BASE_URL } from '../constants/api'

// Axios instance with the session Bearer token attached automatically.
const apiClient = axios.create({
  baseURL: API_BASE_URL,
  headers: { 'Content-Type': 'application/json' },
  timeout: 60000,
})

apiClient.interceptors.request.use((config) => {
  // sessionStorage: per-TAB. The token used to come from localStorage,
  // which every tab of this origin shares — so with two sub-accounts open
  // side by side, the tab that authenticated last silently supplied its
  // token to every request from the other tab too. See AuthContext.
  const token = sessionStorage.getItem('sessionToken')
  if (token) config.headers.Authorization = `Bearer ${token}`
  return config
})

apiClient.interceptors.response.use(
  (response) => response.data,
  (error) => {
    // On a session-expired 401 (not during initial verify), reload to
    // re-acquire the GHL context and mint a fresh token.
    const status = error.response?.status
    const code = error.response?.data?.code
    const url = error.config?.url || ''
    if (status === 401 && code === 'TOKEN_EXPIRED' && !url.includes('/auth/verify')) {
      sessionStorage.removeItem('sessionToken')
      window.location.reload()
      return
    }
    // The server's own `error` field is written FOR a rep, so it is used as
    // given. Everything after it is a fallback for when the server said
    // nothing — a network drop, a proxy 502, a crash before the handler ran.
    //
    // `error.message` is NOT among the fallbacks any more. For an axios
    // failure it reads "Request failed with status code 500", which tells a
    // sales rep nothing and looks like a bug report. The real error is
    // already in the browser console and in the server logs.
    const message =
      error.response?.data?.error ||
      error.response?.data?.message ||
      (error.code === 'ECONNABORTED'
        ? 'That took too long — check your connection and try again.'
        // `!status` FIRST. A response that arrived with a status is not a
        // connection problem, whatever else went wrong with it — and telling
        // a rep to "check your connection" when the server answered sends
        // them looking in the wrong place entirely. Only a request that never
        // got an answer can blame the network.
        : !status
          ? "Couldn't reach the server — check your connection."
          : status >= 500
            ? 'Something went wrong at our end — nothing was saved. Try again in a moment.'
            : 'That did not work. Try again.')
    const enhanced = new Error(message)
    enhanced.status = status
    enhanced.code = code || error.code
    enhanced.data = error.response?.data
    return Promise.reject(enhanced)
  }
)

export default apiClient
