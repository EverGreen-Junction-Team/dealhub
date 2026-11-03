import React, { createContext, useContext, useState, useEffect, useRef } from 'react'
import { useGHLContext } from '../hooks/useGHLContext'
import { authAPI } from '../api/auth'
import { setCurrency } from '../utils/format'

const AuthContext = createContext(null)

export const useAuth = () => {
  const ctx = useContext(AuthContext)
  if (!ctx) throw new Error('useAuth must be used within AuthProvider')
  return ctx
}

export const AuthProvider = ({ children }) => {
  const { context: ghlContext, loading: ghlLoading, error: ghlError } = useGHLContext()
  const [session, setSession] = useState(null)
  const [location, setLocation] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const attempts = useRef(0)
  const MAX = 3

  useEffect(() => {
    if (!ghlContext) return
    // RE-AUTHENTICATE ON A LOCATION CHANGE, not just once per page load.
    //
    // useGHLContext used to resolve the handshake exactly once and never
    // update again, so this effect's `!session` guard was enough — there was
    // only ever one ghlContext to react to. It now keeps listening, because
    // GHL's sidebar can switch sub-accounts without reloading this iframe,
    // and the parent frame posts the new location unprompted.
    //
    // Without this, every request after a switch — including the contact
    // picker's search — kept the PREVIOUS sub-account's JWT. The picker
    // showed the right rep's name and the wrong location's contacts, which
    // is why adding one to a deal 404'd: the contact existed, just not in
    // this account.
    const switchedLocation = session && ghlContext.locationId !== session.locationId
    if ((switchedLocation || !session) && attempts.current < MAX) {
      // A real switch gets its own fresh attempt budget — the cap exists to
      // stop a retry storm against one bad handshake, not to lock a rep out
      // of every account after their third switch today.
      if (switchedLocation) attempts.current = 0
      authenticate(ghlContext)
    } else if (attempts.current >= MAX && !session) {
      setLoading(false)
      setError((e) => e || 'Maximum authentication attempts reached. Please refresh.')
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ghlContext])

  const authenticate = async (ctx) => {
    attempts.current += 1
    try {
      setLoading(true)
      const res = await authAPI.verify({
        locationId: ctx.locationId,
        companyId: ctx.companyId,
        userId: ctx.userId,
      })
      // sessionStorage, NOT localStorage — see src/storage/session.js. A JWT
      // in localStorage is shared by every tab of this origin, so two
      // sub-accounts open side by side overwrote each other's token: whichever
      // tab authenticated LAST won for ALL of them, and tab A's next click
      // fetched tab B's data. sessionStorage is scoped to one tab.
      sessionStorage.setItem('sessionToken', res.sessionToken)
      // The authoritative sub-account for this session, written where
      // non-React code can read it. useTabState needs it to decide whether a
      // persisted snapshot belongs to the location now on screen; it used to
      // infer this by scanning for a `pp.position.*` key, which returns the
      // FIRST one found — so after visiting two sub-accounts it would answer
      // with whichever happened to be first, and one location's chat history
      // stayed on screen under another's name.
      sessionStorage.setItem('pp.activeLocation', res.location.id)
      setSession({ token: res.sessionToken, user: res.user, locationId: res.location.id })
      setLocation(res.location)
      // Apply the sub-account's currency to all money formatters.
      if (res.location?.currency) setCurrency(res.location.currency)
      setError(null)
      setLoading(false)
    } catch (err) {
      setError(err.message || 'Authentication failed')
      setLoading(false)
      attempts.current = MAX // stop retry storm
    }
  }

  const logout = () => {
    sessionStorage.removeItem('sessionToken')
    // Cleared with the session, so the next sign-in cannot be compared against
    // the previous one's sub-account and judged a match.
    sessionStorage.removeItem('pp.activeLocation')
    sessionStorage.removeItem('pp.tabstate')
    setSession(null)
    setLocation(null)
  }

  const value = {
    ghlContext,
    session,
    location,
    loading: ghlLoading || loading,
    error: ghlError || error,
    isAuthenticated: !!session,
    logout,
  }

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}
