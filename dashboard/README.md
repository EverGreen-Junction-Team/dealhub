# GHL Embedded App Starter

A minimal, production-tested starter for building apps that embed inside a
GoHighLevel sub-account as a Custom Page / menu link. It ships the hard part —
**authentication and sub-account context resolution** — already working, so
feature development starts from an authenticated session.

Derived from the PipelinePulse dashboard; the analytics layer has been removed
and the auth foundation kept intact.

## What's included

- **GHL iframe auth handshake** (`src/hooks/useGHLContext.js`) — the official
  `postMessage` flow: the embedded app requests user context from the GHL parent
  frame, which is decrypted server-side (the backend holds the shared secret).
  Resolves `locationId`, `companyId`, `userId`, `email`, `userName`, `role`.
- **Session layer** (`src/context/AuthContext.jsx`) — exchanges the GHL context
  for a backend session token, exposes it via `useAuth()`, applies the
  sub-account's currency, and handles retry/expiry.
- **API client** (`src/api/client.js`) — axios instance that attaches the
  session Bearer token and auto-reloads on token expiry.
- **App shell** (`App.jsx`, `Screens.jsx`, `Header.jsx`) — loading / error /
  not-authenticated gates and a header showing the signed-in user.
- **Connected screen** (`src/components/Dashboard.jsx`) — post-auth landing that
  displays the resolved sub-account context. Replace this with real features.

## How auth works

```
GHL parent frame                Embedded app                  Backend
      │                              │                            │
      │◀── postMessage ─────────────│  REQUEST_USER_DATA         │
      │─── REQUEST_USER_DATA_RESPONSE ─▶ (encrypted payload)      │
      │                              │── POST /auth/decrypt ─────▶│  decrypt (shared secret)
      │                              │◀───── user context ────────│
      │                              │── POST /auth/verify ──────▶│  mint session token
      │                              │◀───── sessionToken ────────│
      │                              │  store + render app        │
```

The app only works inside the GHL iframe (it needs the parent frame to answer
the handshake). Outside the iframe it surfaces a "not authenticated" screen.

## Develop

```bash
npm install
npm run dev      # Vite on :5173, proxies /api + /auth to the backend (:4000)
npm run build    # static build → dist/
```

### Environment

| Var | Purpose |
|-----|---------|
| `VITE_API_BASE_URL` | Backend API origin. Blank in dev (Vite proxies to :4000). |
| `VITE_GHL_APP_ID`   | Marketplace App ID for the postMessage handshake. |

Both can be blank for local dev. Set them for production / testing inside the
real GHL iframe.

## Deploy

Frontend is static (`dist/`) — deploy to Vercel / Cloudflare. Builds trigger
automatically on commit. The backend (auth decrypt + session) is a separate
Node service; point `VITE_API_BASE_URL` at it.

## Building on this

The session and sub-account context are available anywhere via:

```js
import { useAuth } from './context/AuthContext'
const { ghlContext, location, session } = useAuth()
```

Mount new screens from `Dashboard.jsx`. Everything below the auth gate already
has a verified session and knows which sub-account it's running in.
