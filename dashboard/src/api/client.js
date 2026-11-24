import axios from 'axios'
import { API_BASE_URL } from '../constants/api'
import { isLostSession } from './lostSession'

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

// ── Recovering a lost session ────────────────────────────────────────
//
// TWO WAYS THE TOKEN GOES, AND BOTH END THE SAME WAY FOR THE REP.
//
//   TOKEN_EXPIRED  we sent a token and the server says it has aged out.
//   NO_TOKEN       we sent no token at all, because sessionStorage has
//                  none — it was cleared, evicted, or never written.
//
// Only the first was handled, and the second is the nastier of the two.
// React keeps `session` in memory, so the app still believes it is signed
// in: every page renders, names resolve from data already fetched, and the
// only symptom is that each new request fails. The rep fills in a whole
// task and is told "Missing bearer token" — a protocol string, shown to a
// salesperson, naming nothing they can do.
//
// Partitioned storage in the GHL iframe makes this ordinary rather than
// exotic: a browser may evict it mid-session without reloading the frame.
//
// RELOADING IS THE FIX, and it has to be bounded. A reload re-runs the GHL
// handshake and mints a fresh token, which is exactly right when the token
// was simply lost — and an infinite loop when the handshake itself is the
// thing failing. So one reload per minute, remembered across the reload in
// the same storage the token lives in.
const RELOAD_GUARD_KEY = 'pp.authReloadAt'
const RELOAD_GUARD_MS = 60_000

function tryRecoverSession() {
  let last = null
  try {
    last = Number(sessionStorage.getItem(RELOAD_GUARD_KEY)) || 0
    // Written BEFORE the reload, so the next load can see it. If this
    // throws, sessionStorage is unavailable — and then reloading cannot
    // help anyway, because the fresh token would have nowhere to go.
    sessionStorage.setItem(RELOAD_GUARD_KEY, String(Date.now()))
    sessionStorage.removeItem('sessionToken')
  } catch {
    return false
  }
  if (Date.now() - last < RELOAD_GUARD_MS) return false
  window.location.reload()
  return true
}

apiClient.interceptors.response.use(
  (response) => response.data,
  (error) => {
    const status = error.response?.status
    const code = error.response?.data?.code
    const url = error.config?.url || ''

    const lostSession = isLostSession({ status, code, url })

    if (lostSession && tryRecoverSession()) return

    if (lostSession) {
      // Reloading did not fix it, or we are not allowed to try again yet.
      // Say what happened and what to do, in those words — the server's
      // own text here is written for a developer reading a log.
      const stuck = new Error(
        'Your session has ended. Reload the page to sign back in — nothing was saved.'
      )
      stuck.status = status
      stuck.code = code
      return Promise.reject(stuck)
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
