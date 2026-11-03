import pino from 'pino';
import { config } from '../config.js';

// Pino's default `err` serializer dumps EVERYTHING on an Error — for axios
// errors that means the full request config (including the Bearer token in
// Authorization headers), the full response object, sockets, agent state,
// circular `_redirectable` chains. ~50KB per error and a security leak.
//
// Our serializer extracts only the diagnostic bits we actually want:
//   - status / statusText (the HTTP code GHL returned)
//   - method + url (what we tried to call)
//   - message (GHL's error body message, or the JS error message)
//   - stack (top frames only, capped to 8 lines)
//
// NO headers ever — that's where Bearer tokens live.
function slimErr(err) {
  if (!err) return err;

  // A STRING, not an Error. 38 call sites pass `err: err.message`, which
  // reaches this serialiser as a bare string — it has no .name and no
  // .response, so the old code emitted {"type":"Error"} and nothing else.
  // That is literally what a halted sub-account logged: an empty error object
  // where GHL's reason should have been.
  //
  // Returning the string keeps those call sites useful without editing all
  // 38. They still lose the response body, so the fix at the call site is to
  // pass the ERROR rather than its message — but a message beats nothing.
  if (typeof err === 'string') return { type: 'Error', message: err };

  const base = {
    type: err.name || 'Error',
    message: err.message
  };
  // Axios shape: err.response + err.config
  if (err.isAxiosError || err.response || err.config) {
    base.status = err.response?.status;
    base.statusText = err.response?.statusText;
    base.method = err.config?.method?.toUpperCase();
    base.url = err.config?.url;
    // THE WHOLE RESPONSE BODY, not just data.message.
    //
    // This used to keep only `message`, which threw away everything that
    // actually explains a failure. A 401 on /notes/:id logged as
    //   {"err":{"type":"Error"}}
    // with no reason at all — and we spent a deploy assuming a missing scope
    // when GHL had almost certainly said something more specific.
    //
    // GHL is inconsistent about where it puts the reason: `message`, `msg`,
    // `error`, `error_description`, an `errors[]` array, or occasionally a
    // bare string body. Rather than guess which, keep the body.
    //
    // BOUNDED, because a body can be an entire HTML error page. 2000 chars is
    // enough for any JSON error GHL returns and small enough not to flood the
    // log; anything longer is truncated with a marker so it is obvious the
    // value was cut rather than empty.
    const body = err.response?.data;
    if (body !== undefined && body !== null) {
      if (typeof body === 'string') {
        base.ghlBody = body.length > 2000 ? body.slice(0, 2000) + '…[truncated]' : body;
      } else {
        try {
          const json = JSON.stringify(body);
          base.ghlBody = json.length > 2000 ? json.slice(0, 2000) + '…[truncated]' : json;
        } catch {
          // Circular or otherwise unserialisable — say so rather than dropping
          // it silently, which is the failure this whole block exists to fix.
          base.ghlBody = '[unserialisable response body]';
        }
      }
    }

    // The scopes GHL says the token carries. Returned on some auth failures
    // and the single most useful field for "is this a scope problem or a dead
    // token" — the question that cost a halted sub-account.
    const scope = err.response?.data?.scope || err.response?.headers?.['x-oauth-scopes'];
    if (scope) base.ghlScopes = scope;

    // Rate-limit headers, so a 429 says how long to wait rather than just
    // that it happened.
    const h = err.response?.headers || {};
    if (h['x-ratelimit-remaining'] !== undefined) {
      base.rateRemaining = h['x-ratelimit-remaining'];
    }
    if (h['retry-after'] !== undefined) base.retryAfter = h['retry-after'];
  }
  // NOT `else if` — an axios error can carry a code too (ECONNREFUSED,
  // ETIMEDOUT), and the old chain dropped it whenever a response existed.
  if (err.code) base.code = err.code;
  // Trim stack — first 8 lines is plenty
  if (err.stack) base.stack = err.stack.split('\n').slice(0, 8).join('\n');
  return base;
}

export const logger = pino({
  level: config.logLevel,
  base: { service: 'pipelinepulse-server' },
  serializers: {
    err: slimErr
  },
  // Belt-and-braces: even if a Bearer somehow slipped into a log call,
  // pino's redact masks it. Path is `*.authorization` (case-insensitive in
  // pino since v8) so it covers headers anywhere in the structure.
  redact: {
    paths: [
      'err.config.headers.Authorization',
      'err.config.headers.authorization',
      'err.request.headers.Authorization',
      'err.request._header',
      '*.headers.Authorization',
      '*.headers.authorization',
      // Top-level too: '*.headers.x' requires a wrapper level, so a log call
      // passing { headers } directly was NOT matched. Caught by the test in
      // utils/__tests__/redact.test.mjs.
      'headers.Authorization',
      'headers.authorization',
      // TOKEN FIELDS, not just headers.
      //
      // The paths above only ever covered headers, so a log call that passed a
      // token as a plain field — logger.warn({ tokens }) in the OAuth callback
      // did exactly this — wrote it in clear. These cover the field names our
      // token objects and the installs row actually use, at the top level and
      // one level down.
      'accessToken', 'refreshToken', 'access_token', 'refresh_token',
      '*.accessToken', '*.refreshToken', '*.access_token', '*.refresh_token',
      'tokens', 'install.access_token', 'install.refresh_token'
    ],
    censor: '[REDACTED]'
  },
  transport: config.nodeEnv === 'development'
    ? { target: 'pino-pretty', options: { colorize: true, translateTime: 'SYS:HH:MM:ss' } }
    : undefined
});
