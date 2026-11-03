import express from 'express';
import cors from 'cors';
import pinoHttp from 'pino-http';
import { config } from './config.js';
import { pingDb } from './db.js';
import { logger } from './utils/logger.js';
import { oauthRouter } from './routes/oauth.js';
import { webhooksRouter } from './routes/webhooks.js';
import { authRouter } from './routes/auth.js';
import { dealsRouter } from './routes/deals.js';
import { mediaRouter } from './routes/media.js';
import { contactsRouter } from './routes/contacts.js';
import { businessesRouter } from './routes/businesses.js';
import { tasksRouter } from './routes/tasks.js';
import { notesRouter } from './routes/notes.js';
import { savedViewsRouter } from './routes/savedViews.js';
import { providersRouter } from './routes/providers.js';
import { summaryRouter } from './routes/summary.js';
import { controlRouter } from './routes/control.js';
import { insightsRouter } from './routes/insights.js';
import { aiRouter } from './routes/ai.js';
import { callsRouter } from './routes/calls.js';
import { callWebhooksRouter } from './routes/callWebhooks.js';
import { startOrphanSweepCron } from './services/orphanSweep.js';
import { startPipelineSnapshotCron } from './services/pipelineSnapshot.js';
import { startConversationPointWorker } from './conversationPoint/worker.js';

async function main() {
  const app = express();
  // Slim HTTP access log. Default pino-http dumps the entire request envelope
  // (every header, the raw signature, Cloudflare metadata, body bytes, etc.)
  // — that's 3-4 KB of noise per webhook with zero diagnostic value. We only
  // want: method, URL, status, latency. Anything richer (eventType, ids,
  // enrichment outcomes) is logged from the route/service code with proper
  // context, where the structured fields actually matter.
  app.use(pinoHttp({
    logger,
    serializers: {
      req: (req) => ({ method: req.method, url: req.url }),
      res: (res) => ({ statusCode: res.statusCode })
    },
    customSuccessMessage: (req, res, responseTime) =>
      `${req.method} ${req.url} ${res.statusCode} ${responseTime}ms`,
    customErrorMessage: (req, res, err) =>
      `${req.method} ${req.url} ${res.statusCode} ${err.message}`,
    // Drop /health from the access log entirely — pollutes the stream
    // with monitoring-probe noise (Cloudflare + uptime checks hit it often).
    autoLogging: {
      ignore: (req) => req.url === '/health'
    }
  }));

  app.get('/health', (_req, res) => res.json({ ok: true, ts: new Date().toISOString() }));

  // CORS — the dashboard runs on localhost:5173 in dev and on the Vercel
  // origin in prod. Everything else (webhooks, oauth callbacks) is server-
  // to-server so doesn't need CORS.
  const allowedOrigins = (process.env.DASHBOARD_ORIGINS || 'http://localhost:5173')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const dashboardCors = cors({
    origin: (origin, cb) => {
      // Allow same-origin / no-origin (curl, health checks).
      if (!origin) return cb(null, true);
      if (allowedOrigins.includes(origin)) return cb(null, true);
      return cb(new Error('CORS: origin not allowed'));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type']
  });

  // EVERY /api RESPONSE IS PER-SUB-ACCOUNT. NEVER LET A BROWSER REUSE ONE.
  //
  // Express sends an ETag on JSON by default, and these URLs carry no
  // location: /api/contacts?limit=20 is the same string for every
  // sub-account, and only the Authorization header tells them apart. A
  // browser caches on the URL, so a response stored while the rep was in
  // account A is replayed as a hit for account B — A's contacts, served from
  // the browser's own cache, without the server ever being asked. The data is
  // correctly scoped server-side; the response simply never comes from there.
  //
  // That is what produced "the contact dropdown is not respecting the
  // location", and the 304 that made a freshly added contact appear to
  // vanish: the conditional request matched a stale entry and the new row was
  // never delivered.
  //
  // ETAGS ARE DISABLED OUTRIGHT. A first attempt set only Cache-Control:
  // no-store, and a direct test showed Express STILL answering 304: its
  // conditional-GET check (res.send → req.fresh) compares If-None-Match
  // against the ETag it generates and pays no attention to Cache-Control.
  // Browsers already hold cached entries with ETags, so they keep sending
  // If-None-Match and keep getting 304s. With no ETag issued there is nothing
  // for a stale If-None-Match to ever match — `fresh` returns false the
  // moment the response has no ETag — so every request gets a full body.
  //
  // no-store stays, so browsers stop STORING these responses at all, and Vary
  // covers any proxy that caches on its own terms. The payloads are small and
  // this is an internal dashboard: correctness is worth more than a saved
  // round trip.
  app.set('etag', false);
  app.use('/api', (req, res, next) => {
    res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
    res.set('Vary', 'Authorization');
    next();
  });

  app.use('/auth', dashboardCors, express.json(), authRouter);
  app.use('/api/deals',    dashboardCors, express.json(), dealsRouter);
  // Private attachments, by signed link — no session (see routes/media.js).
  app.use('/api/media',    dashboardCors, mediaRouter);
  app.use('/api/contacts', dashboardCors, express.json(), contactsRouter);
  app.use('/api/businesses', dashboardCors, express.json(), businessesRouter);
  app.use('/api/tasks',    dashboardCors, express.json(), tasksRouter);
  app.use('/api/notes',    dashboardCors, express.json(), notesRouter);
  app.use('/api/saved-views', dashboardCors, express.json(), savedViewsRouter);
  app.use('/api/providers', dashboardCors, express.json(), providersRouter);
  app.use('/api/summary',  dashboardCors, express.json(), summaryRouter);
  // Pre-aggregated insight views, one request per chart — see routes/insights.js.
  app.use('/api/insights', dashboardCors, express.json(), insightsRouter);
  // Control centre accepts pasted emails and uploaded text as sample bodies,
  // which run well past express.json's 100kb default.
  app.use('/api/control',  dashboardCors, express.json({ limit: '2mb' }), controlRouter);
  // 7mb, sized so a 5MB IMAGE fits and nothing much larger does.
  //
  // The user-facing limit is 5MB per image. base64 inflates a file by 4/3, so
  // 5MB of pixels is ~6.7MB of JSON — hence 7mb here, not 5mb. Setting the body
  // limit to 5mb would make a "5MB image" impossible to send, and Express would
  // reject it with a 413 before the route could explain why.
  //
  // Deliberately NOT generous: at 24mb (an earlier draft) three 5MB images
  // would have been accepted, quietly moving 20MB per question.
  app.use('/api/ai',       dashboardCors, express.json({ limit: '7mb' }), aiRouter);
  // Conversation Point — calls, transcripts, provider config. See
  // src/conversationPoint/README.md.
  app.use('/api/calls',    dashboardCors, express.json(), callsRouter);

  app.use('/oauth', express.urlencoded({ extended: false }), express.json(), oauthRouter);

  // Phone-provider webhooks (Allo first). Raw body kept for HMAC checks.
  // Mounted BEFORE /webhooks so the GHL router never sees these paths.
  app.use(
    '/webhooks/calls',
    express.json({
      verify: (req, _res, buf) => { req.rawBody = buf; },
      limit: '2mb'
    }),
    callWebhooksRouter
  );

  // Webhooks need the raw body for RSA signature verification BEFORE JSON
  // parsing consumes it. The verify hook on express.json stashes it on req.
  app.use(
    '/webhooks',
    express.json({
      verify: (req, _res, buf) => { req.rawBody = buf; },
      limit: '1mb'
    }),
    webhooksRouter
  );
  app.use((err, _req, res, _next) => {
    // Payload too large. Express throws this from its own body parser, BEFORE
    // any route runs — so without this branch an oversized attachment surfaced
    // as a bare 500 "internal_error" and the rep had no idea an image was the
    // cause. The per-image and total checks in routes/ai.js catch the ordinary
    // cases with a specific message; this is the backstop.
    if (err?.type === 'entity.too.large' || err?.status === 413) {
      logger.warn({ limit: err.limit, length: err.length }, 'request body too large');
      return res.status(413).json({
        error: 'That attachment is too large. Images must be under 5 MB each, and 5 MB total per question.',
        code: 'PAYLOAD_TOO_LARGE'
      });
    }
    logger.error({ err }, 'unhandled error');
    res.status(500).json({ error: 'internal_error' });
  });

  app.listen(config.port, () => {
    logger.info(
      { port: config.port, publicBaseUrl: config.publicBaseUrl, env: config.nodeEnv },
      'pipelinepulse-server listening'
    );
    startOrphanSweepCron();
    // Own slot, after the daily syncs. A snapshot taken before they finish
    // records yesterday's pipeline under today's date, and nothing on the row
    // would say so.
    startPipelineSnapshotCron(config.pipelineSnapshotCron);
    // Conversation Point step queue (match → download → transcribe → ghl_sync).
    startConversationPointWorker();

    // Ping Postgres in the background — doesn't block boot. If it fails, log
    // a warning; /health stays responsive so liveness probes pass even when
    // the DB is temporarily unreachable. Routes that hit Postgres will fail
    // with a 5xx until the connection recovers; that's the right behaviour.
    pingDb().catch((err) => {
      logger.warn({ err }, 'pingDb: initial connection failed (will retry on first query)');
    });
  });
}

main().catch((err) => {
  logger.error({ err }, 'failed to start');
  process.exit(1);
});
