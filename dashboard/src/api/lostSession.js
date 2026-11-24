// lostSession.js — is this failure a session we can recover by reloading?
//
// Its own module, with no imports, so the rule can be tested without a
// bundler: client.js pulls in axios and resolves extension-less paths the
// way Vite does, neither of which plain node will do.

// The three codes requireSession can answer with. All three mean the same
// thing to a rep — this request went out without a usable session — and all
// three are fixed the same way, by re-running the handshake.
const LOST_SESSION_CODES = new Set(['TOKEN_EXPIRED', 'NO_TOKEN', 'INVALID_TOKEN'])

/**
 * Is this failure a lost session we should try to recover from?
 *
 * Exported so the rule is pinned by a test. The /auth/verify exclusion is
 * the important half: verify IS the handshake, so reloading when IT fails
 * reloads into the same failure, for ever.
 */
export function isLostSession({ status, code, url = '' }) {
  return status === 401
    && LOST_SESSION_CODES.has(code)
    && !url.includes('/auth/verify')
}
