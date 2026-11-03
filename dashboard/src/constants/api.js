// API configuration. In dev, Vite proxies /api and /auth to the Express server
// (see vite.config.js), so a relative base just works. In production set
// VITE_API_BASE_URL to the deployed API origin.
export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || ''

// GHL Marketplace App ID for PipelinePulse. Used by useGHLContext for the
// postMessage handshake with the GHL parent frame.
// TODO: replace with the real PipelinePulse marketplace App ID.
export const GHL_APP_ID = import.meta.env.VITE_GHL_APP_ID || 'REPLACE_WITH_PIPELINEPULSE_APP_ID'
