import 'dotenv/config';

const isProd = (process.env.NODE_ENV || 'development') === 'production';

// Hard-required: server can't boot without these.
function req(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required env var: ${name}`);
  return v;
}

// Soft-required: missing in production crashes; missing in dev returns ''
// so the server still boots — handy for local development without the full
// GHL stack wired up. Routes that depend on these throw at request time.
function softReq(name) {
  const v = process.env[name];
  if (!v && isProd) throw new Error(`Missing required env var: ${name}`);
  return v || '';
}

export const config = {
  port: Number(process.env.PORT || 4000),
  nodeEnv: process.env.NODE_ENV || 'development',
  logLevel: process.env.LOG_LEVEL || 'info',
  publicBaseUrl: process.env.PUBLIC_BASE_URL || `http://localhost:${process.env.PORT || 4000}`,

  databaseUrl: req('DATABASE_URL'),

  ghl: {
    clientId: softReq('GHL_CLIENT_ID'),
    clientSecret: softReq('GHL_CLIENT_SECRET'),
    redirectUri: softReq('GHL_REDIRECT_URI'),
    // The marketplace app's id (the one in webhook payloads as appId). Needed
    // to ask GHL which sub-accounts an AGENCY install covers.
    appId: process.env.GHL_APP_ID || '',
    oauthTokenUrl: 'https://services.leadconnectorhq.com/oauth/token',
    apiBaseUrl: 'https://services.leadconnectorhq.com',
    apiVersion: '2021-07-28',
    // Legacy RSA-SHA256 key for X-WH-Signature (deprecated by GHL 2026-09-01).
    webhookPublicKey: (process.env.GHL_WEBHOOK_PUBLIC_KEY || '').replace(/\\n/g, '\n'),
    // Ed25519 key for X-GHL-Signature (the replacement). PEM/SPKI, from the
    // GHL marketplace webhook docs. Preferred whenever an X-GHL-Signature is present.
    webhookEd25519PublicKey: (process.env.GHL_WEBHOOK_ED25519_PUBLIC_KEY || '').replace(/\\n/g, '\n')
  },

  // Daily orphan sweep schedule. Standard 5-field cron.
  orphanSweepCron: process.env.ORPHAN_SWEEP_CRON || '0 3 * * *',
  // 30 minutes after the sweep, so the snapshot reads a pipeline the daily
  // syncs have already brought up to date.
  pipelineSnapshotCron: process.env.PIPELINE_SNAPSHOT_CRON || '30 3 * * *',

  internalApiKey: process.env.INTERNAL_API_KEY || '',

  // Session JWT for the embedded dashboard's iframe auth handshake.
  // 30-day tokens; the dashboard axios client auto-reloads on TOKEN_EXPIRED
  // so nothing crashes when they expire, but the secret MUST be set in prod.
  session: {
    jwtSecret: softReq('SESSION_JWT_SECRET'),
    ttlSeconds: Number(process.env.SESSION_TTL_SECONDS || 60 * 60 * 24 * 30)
  },

  // Claude API for the Deal Hub AI layer. softReq (not required) so the app
  // boots without a key — the AI routes report unconfigured individually
  // rather than taking the whole server down.
  ai: {
    apiKey: softReq('ANTHROPIC_API_KEY'),
    model: process.env.ANTHROPIC_MODEL || 'claude-sonnet-5'
  },

  // Conversation Point — call recording + transcription (see
  // src/conversationPoint/README.md). Everything optional: without an
  // OpenAI key calls are still stored and matched, the transcribe step just
  // fails with a clear reason and retries once a key appears.
  conversationPoint: {
    enabled: (process.env.CP_ENABLED || 'true') !== 'false',
    openaiApiKey: process.env.OPENAI_API_KEY || '',
    // whisper-1 gives segment timestamps. A diarizing model can be swapped in
    // here later for speaker labels on mono recordings.
    transcribeModel: process.env.TRANSCRIBE_MODEL || 'whisper-1',
    transcribeLanguage: process.env.TRANSCRIBE_LANGUAGE || 'en',
    // Where our copy of each recording lives. 'local' = RECORDINGS_DIR on this
    // box; 'supabase' = Supabase Storage bucket (private, signed on read).
    storage: process.env.RECORDING_STORAGE || 'local',
    recordingsDir: process.env.RECORDINGS_DIR || 'data/recordings',
    supabase: {
      url: process.env.SUPABASE_URL || '',
      serviceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || '',
      bucket: process.env.SUPABASE_RECORDINGS_BUCKET || 'call-recordings'
    },
    workerIntervalMs: Number(process.env.CP_WORKER_INTERVAL_MS || 5000),
    workerBatch: Number(process.env.CP_WORKER_BATCH || 3),
    defaultCountry: process.env.CP_DEFAULT_COUNTRY || 'GB',
    // GHL conversation provider (type Call) registered for this marketplace
    // app. Without it the ghl_sync step is skipped, not failed.
    ghlCallProviderId: process.env.GHL_CALL_PROVIDER_ID || '',
    // Env-level fallback for a single-tenant Allo setup. Per-location rows in
    // call_providers win over these.
    allo: {
      apiKey: process.env.ALLO_API_KEY || '',
      webhookSecret: process.env.ALLO_WEBHOOK_SECRET || '',
      apiBaseUrl: process.env.ALLO_API_BASE_URL || 'https://api.withallo.com'
    }
  }
};
