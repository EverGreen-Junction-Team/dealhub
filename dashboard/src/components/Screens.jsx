import React from 'react'

// Boot screen, shown while the GHL iframe handshake resolves.
//
// Was antd's default <Spin>: a generic blue spinner on the app's only
// full-screen moment, using none of the Deal Hub's tokens. This is the first
// thing a client sees, so it's worth being ours.
//
// Wrapped in [data-dealhub] so the design tokens resolve — App.jsx renders this
// OUTSIDE DealHubShell, which is where that attribute normally lives.
export function LoadingScreen({ message = 'Connecting to your sub-account…' }) {
  return (
    <div
      data-dealhub
      style={{
        height: '100%', minHeight: '100vh',
        display: 'flex', flexDirection: 'column',
        alignItems: 'center', justifyContent: 'center',
        gap: 'var(--space-5)',
        background: 'var(--surface-page)'
      }}
    >
      <style>{BOOT_CSS}</style>

      {/* A pipeline filling left to right — the product's own metaphor, rather
          than a spinner that could belong to anything. Four segments, each
          easing up in turn. */}
      <div
        aria-hidden
        style={{ display: 'flex', alignItems: 'flex-end', gap: 6, height: 34 }}
      >
        {[0, 1, 2, 3].map((i) => (
          <span
            key={i}
            className="pp-boot-bar"
            style={{
              width: 9,
              borderRadius: 'var(--radius-sm)',
              background: 'var(--brand-primary)',
              animationDelay: `${i * 0.14}s`
            }}
          />
        ))}
      </div>

      <div style={{ textAlign: 'center' }}>
        <p
          style={{
            margin: 0,
            fontSize: 'var(--text-xl)', fontWeight: 600,
            color: 'var(--text-heading)'
          }}
        >
          Dashboard
        </p>
        <p
          role="status"
          aria-live="polite"
          style={{
            margin: '5px 0 0',
            fontSize: 'var(--text-md)', color: 'var(--text-muted)'
          }}
        >
          {message}
        </p>
      </div>
    </div>
  )
}

const BOOT_CSS = `
@keyframes pp-boot-fill {
  0%, 100% { height: 10px; opacity: 0.35; }
  50%      { height: 34px; opacity: 1; }
}
.pp-boot-bar {
  height: 10px;
  animation: pp-boot-fill 1.15s cubic-bezier(0.4, 0, 0.2, 1) infinite;
}
/* A moving loader is exactly the kind of motion someone turns off. Hold the
   bars at a mid height so the shape still reads as a loader. */
@media (prefers-reduced-motion: reduce) {
  .pp-boot-bar { animation: none; height: 22px; opacity: 0.6; }
}
`

export function ErrorScreen({ error }) {
  // "Not connected" is a setup step, not a failure — it means the app isn't
  // installed on this sub-account yet. Amber and a different heading, because
  // telling someone something went wrong when nothing did sends them looking
  // for a bug.
  const notConnected = /not connected|install|NOT_CONNECTED/i.test(String(error))
  const accent = notConnected ? 'gold' : 'rose'

  return (
    <div
      data-dealhub
      style={{
        height: '100%', minHeight: '100vh',
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: 'var(--space-5)',
        background: 'var(--surface-page)'
      }}
    >
      <div
        style={{
          maxWidth: 460, width: '100%',
          padding: 'var(--space-6) var(--space-5)',
          border: '1px solid var(--border-default)',
          borderTop: `3px solid var(--accent-${accent})`,
          borderRadius: 'var(--radius-md)',
          background: '#fff',
          boxShadow: 'var(--shadow-card)',
          textAlign: 'center'
        }}
      >
        <span
          style={{
            display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
            width: 52, height: 52, marginBottom: 'var(--space-3)',
            borderRadius: 'var(--radius-pill)',
            background: `var(--tint-${accent})`,
            color: `var(--accent-${accent}-text)`
          }}
        >
          <span className="ms" style={{ fontSize: 26 }}>
            {notConnected ? 'extension' : 'error'}
          </span>
        </span>

        <h1
          style={{
            margin: 0,
            fontSize: 'var(--text-2xl)', fontWeight: 600,
            color: 'var(--text-heading)'
          }}
        >
          {notConnected ? 'App not connected' : 'Something went wrong'}
        </h1>

        <p
          style={{
            margin: 'var(--space-2) auto var(--space-5)', maxWidth: 380,
            fontSize: 'var(--text-md)', lineHeight: 'var(--leading-normal)',
            color: 'var(--text-muted)'
          }}
        >
          {notConnected
            ? 'Install PipelinePulse on this sub-account from the marketplace, then reload.'
            : String(error)}
        </p>

        <button
          onClick={() => window.location.reload()}
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 7,
            cursor: 'pointer',
            height: 40, padding: '0 20px',
            border: 'none', borderRadius: 'var(--radius-md)',
            background: 'var(--brand-primary)', color: '#fff',
            boxShadow: '0 2px 6px rgba(13, 91, 64, 0.32)',
            fontFamily: 'var(--font-sans)',
            fontSize: 'var(--text-lg)', fontWeight: 600
          }}
        >
          <span className="ms" style={{ fontSize: 18 }}>refresh</span>
          Reload
        </button>

        {/* The raw error still matters when someone reports the problem, but it
            isn't the headline on the not-connected path. */}
        {notConnected && (
          <p
            style={{
              margin: 'var(--space-4) 0 0',
              fontSize: 'var(--text-sm)', color: 'var(--text-faint)',
              overflowWrap: 'anywhere'
            }}
          >
            {String(error)}
          </p>
        )}
      </div>
    </div>
  )
}
