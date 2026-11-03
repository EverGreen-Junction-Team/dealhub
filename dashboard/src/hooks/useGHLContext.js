import { useEffect, useState, useRef } from 'react'
import { API_BASE_URL } from '../constants/api'

// Acquires the GHL user context inside the marketplace iframe via the official
// postMessage handshake, then decrypts it server-side (the backend holds the
// shared secret). Returns { locationId, companyId, userId, email, userName }.
//
// Ported from convoVault's proven implementation; trimmed to the Custom Pages
// (postMessage) path which is what PipelinePulse uses.
export function useGHLContext() {
  const [context, setContext] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  // Guards the INITIAL handshake only — the 5s timeout/retry below must not
  // fire a second time once the first response has landed. It does NOT stop
  // the listener itself: GHL's sidebar can switch sub-accounts without
  // reloading this iframe, and when it does, the parent frame posts another
  // REQUEST_USER_DATA_RESPONSE unprompted, carrying the NEW location.
  //
  // This used to return `if (resolvedRef.current) return` and never
  // re-subscribe, so that second message was never heard: `context` kept the
  // FIRST location for the rest of the session. Every request after a switch
  // — including a contact search — still carried the old sub-account's JWT,
  // because AuthContext never saw a reason to re-authenticate. A rep in
  // account B picked a contact that only ever existed in account A's list.
  const resolvedRef = useRef(false)

  useEffect(() => {
    let messageHandler
    let timeoutId

    const decryptUserData = async (encryptedData) => {
      const res = await fetch(`${API_BASE_URL}/auth/decrypt-user-data`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
        body: JSON.stringify({ encryptedData }),
      })
      if (!res.ok) throw new Error('Authentication failed')
      const data = await res.json()
      if (!data.success) throw new Error(data.error || 'Decryption failed')
      return data
    }

    // Shared by the FIRST response (via requestContext's promise, below) and
    // every later one (applied directly from the message handler, since
    // nothing is awaiting a promise for those).
    const applyContext = (userData) => {
      setContext({
        locationId: userData.activeLocation || userData.locationId,
        companyId: userData.companyId,
        userId: userData.userId,
        email: userData.email,
        userName: userData.userName,
        role: userData.role,
        type: userData.type || 'Location',
      })
      setLoading(false)
    }

    const requestContext = () =>
      new Promise((resolve, reject) => {
        messageHandler = ({ data }) => {
          if (data?.message !== 'REQUEST_USER_DATA_RESPONSE') return
          // The FIRST response resolves requestContext's own promise, which
          // applyContext is chained onto below. A LATER one — a sub-account
          // switch, with nothing awaiting it — is applied right here instead.
          if (!resolvedRef.current) {
            clearTimeout(timeoutId)
            resolvedRef.current = true
            decryptUserData(data.payload).then(resolve).catch(reject)
          } else {
            decryptUserData(data.payload).then(applyContext).catch(() => {
              // A failed re-decrypt on a LATER switch must not blank a
              // context that was working — the rep stays on the account
              // they were already in rather than losing the page.
            })
          }
        }
        window.addEventListener('message', messageHandler)

        if (window.parent !== window) {
          window.parent.postMessage({ message: 'REQUEST_USER_DATA' }, '*')
        } else {
          reject(new Error('NOT_IN_IFRAME'))
          return
        }
        timeoutId = setTimeout(() => {
          if (!resolvedRef.current) reject(new Error('CONTEXT_TIMEOUT'))
        }, 5000)
      })

    requestContext()
      .then(applyContext)
      .catch((err) => {
        setError(err.message || 'Context initialization failed')
        setLoading(false)
      })

    return () => {
      if (messageHandler) window.removeEventListener('message', messageHandler)
      clearTimeout(timeoutId)
    }
  }, [])

  return { context, loading, error }
}
