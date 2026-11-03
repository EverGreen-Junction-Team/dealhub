import Anthropic, {
  APIConnectionTimeoutError,
  APIConnectionError,
  RateLimitError,
  APIError
} from '@anthropic-ai/sdk';
import { config } from '../../config.js';
import { logger } from '../../utils/logger.js';

// Thin wrapper over the Anthropic SDK. Everything AI-facing goes through
// `callClaude` so retries, timeouts, token accounting, and failure
// classification live in one place — the six calls in the spec differ only by
// prompt and schema.
//
// Structured output: we use `messages.parse()` with a JSON schema rather than
// parsing prose. Validation happens at the API layer, so the model retries on
// its own when it produces something off-schema, and we get a typed object
// back instead of hand-rolling a JSON extractor.

let client = null;

// Lazily constructed so the server still boots without a key — the AI routes
// 503 individually rather than taking the whole app down. Same principle as
// pingDb() not blocking /health.
export function getClient() {
  if (client) return client;
  const apiKey = config.ai?.apiKey;
  if (!apiKey) {
    const err = new Error('ANTHROPIC_API_KEY is not configured');
    err.code = 'AI_NOT_CONFIGURED';
    throw err;
  }
  client = new Anthropic({
    apiKey,
    // The SDK retries 408/409/429/5xx by default. Two is enough: the calls
    // are user-facing and a third retry pushes past any reasonable wait.
    maxRetries: 2,
    timeout: 120_000
  });
  return client;
}

export function isConfigured() {
  return !!config.ai?.apiKey;
}

// Sonnet 5 per the client's v5 request. Ask-this-deal is a grounded read over
// a short thread against a strict schema, which Sonnet handles well. Override
// with ANTHROPIC_MODEL if a future call needs more capability.
export const MODEL = config.ai?.model || 'claude-sonnet-5';

// Running token total for this process. Resets on restart — ai_runs is the
// durable record. This exists so a runaway loop is obvious in the log stream
// without a database query.
//
// Tokens only, deliberately. Cost depends on current per-model rates, which
// the API doesn't return and we shouldn't hardcode: a stale rate produces a
// confident wrong number, which is worse than no number. Anthropic's console
// is the authority on spend.
const sessionTotals = { calls: 0, inputTokens: 0, outputTokens: 0 };

export function tokenTotals() {
  return { ...sessionTotals };
}

// Failure classification maps onto ai_runs.status, so the UI can render a
// real state per the spec's "failure states" requirement rather than
// spinning forever.
export function classifyError(err) {
  if (err?.code === 'AI_NOT_CONFIGURED') return 'api_error';
  // Order matters: APIConnectionTimeoutError extends APIConnectionError, and
  // RateLimitError extends APIError, so check the specific classes first.
  if (err instanceof APIConnectionTimeoutError) return 'timeout';
  if (err instanceof APIConnectionError) return 'api_error';
  if (err instanceof RateLimitError) return 'rate_limited';
  // An exhausted credit balance arrives as a plain 400 invalid_request_error,
  // indistinguishable from a malformed prompt by status alone — so it has to
  // be matched on the message. Called out separately because it is the one
  // failure here that retrying can never fix: every attempt returns the same
  // 400 until somebody tops the account up. Classifying it as api_error made
  // isRetryable() say "try again", which is advice that cannot work.
  if (isCreditExhausted(err)) return 'no_credit';
  if (err instanceof APIError) return 'api_error';
  return 'api_error';
}

// Anthropic returns this as a 400 with a human-readable message rather than a
// dedicated code, so the message is the only signal available.
function isCreditExhausted(err) {
  if (err?.status !== 400) return false;
  const text = String(err?.message || '');
  return /credit balance is too low/i.test(text);
}

// Anthropic's output safety filter. Arrives as a 400 invalid_request_error
// whose message is the only signal — same shape as an exhausted balance,
// and like it NOT a connection problem, so it must not be reported as "the
// AI service could not be reached". The filter runs on what the model was
// about to WRITE, so it is non-deterministic: a second attempt with the same
// input usually passes, which is why the tool loop retries once before
// giving up. Kept out of classifyError on purpose — ai_runs.status has a
// CHECK over a fixed list and this never reaches a stored run.
export function isContentFiltered(err) {
  if (err?.status !== 400) return false;
  return /content filtering policy/i.test(String(err?.message || ''));
}

// Is another attempt likely to succeed? Surfaced so the route can tell the
// user "try again" vs "this won't work until something changes".
export function isRetryable(status) {
  // no_credit is deliberately absent: it is the one state where retrying is
  // guaranteed to fail, and telling a rep to try again wastes their time.
  return status === 'timeout' || status === 'rate_limited' || status === 'api_error';
}

/**
 * One structured Claude call.
 *
 * @param {object}   opts
 * @param {Array}    opts.system      System blocks. Put stable content first
 *                                    and mark the last stable block with
 *                                    cache_control — caching is a prefix
 *                                    match, so anything volatile must come
 *                                    after it.
 * @param {Array}    opts.messages    Message array.
 * @param {object}   opts.schema      JSON schema for the response.
 * @param {string}   opts.schemaName  Label for logs only — the API's
 *                                    output_config.format takes no name.
 * @param {number}   [opts.maxTokens]
 * @param {string}   [opts.effort]    'low' | 'medium' | 'high' | 'xhigh' | 'max'
 *
 * @returns {{ output, usage, latencyMs, status, error }}
 */
export async function callClaude({
  system,
  messages,
  schema,
  schemaName,
  maxTokens = 8000,
  effort = 'high',
  // Extended thinking, on by default. Off for the mechanical calls — citation
  // extraction copies sentences it is handed; it does not need to reason,
  // and its thinking budget was pure latency on every question.
  thinking = true
}) {
  const startedAt = Date.now();
  try {
    const anthropic = getClient();
    const response = await anthropic.messages.parse({
      model: MODEL,
      max_tokens: maxTokens,
      system,
      messages,
      // Adaptive thinking: extraction over a long thread benefits from
      // reasoning about ordering and supersession before answering. Callers
      // doing lookup rather than reasoning pass thinking:false.
      ...(thinking ? { thinking: { type: 'adaptive' } } : {}),
      output_config: {
        effort,
        // JSONOutputFormat takes exactly `type` + `schema` — there is no
        // `name` field, and sending one is a 400 (`Extra inputs are not
        // permitted`). schemaName is ours, for logging only.
        format: {
          type: 'json_schema',
          schema
        }
      }
    });

    const latencyMs = Date.now() - startedAt;

    // A safety refusal returns 200 with stop_reason 'refusal' — check it
    // before reading content, or you read an empty array as an empty result.
    if (response.stop_reason === 'refusal') {
      logger.warn(
        { schemaName, category: response.stop_details?.category },
        'ai: request refused'
      );
      const usage = usageOf(response);
      logUsage({ schemaName, effort, status: 'refused', usage, latencyMs });
      return {
        output: null,
        usage,
        latencyMs,
        status: 'refused',
        error: response.stop_details?.explanation || 'Request was declined'
      };
    }

    // parsed_output is null when the model's JSON didn't validate. That's a
    // malformed result, not an empty one — the distinction matters for the
    // UI state and for spotting prompt bugs.
    if (!response.parsed_output) {
      logger.warn({ schemaName, stopReason: response.stop_reason }, 'ai: output failed schema validation');
      const usage = usageOf(response);
      logUsage({ schemaName, effort, status: 'malformed', usage, latencyMs });
      return {
        output: null,
        usage,
        latencyMs,
        status: 'malformed',
        error: 'Model output did not match the expected shape'
      };
    }

    const usage = usageOf(response);
    logUsage({ schemaName, effort, status: 'ok', usage, latencyMs });

    return {
      output: response.parsed_output,
      usage,
      latencyMs,
      status: 'ok',
      error: null
    };
  } catch (err) {
    const status = classifyError(err);
    // slimErr in utils/logger strips the 50KB axios-style error bodies.
    logger.error({ err, schemaName, status }, 'ai: call failed');
    return {
      output: null,
      usage: null,
      latencyMs: Date.now() - startedAt,
      status,
      error: err?.message || 'Model call failed'
    };
  }
}

// One line per call, at info level so it shows in normal pm2 logs.
//
// cacheRead is the number to watch: on a repeat question over the same thread
// it should be most of the input. If it stays 0 across identical asks,
// something volatile has crept above the cache breakpoint and every call is
// paying full price for the same prompt.
function logUsage({ schemaName, effort, status, usage, latencyMs }) {
  sessionTotals.calls += 1;
  sessionTotals.inputTokens += usage?.inputTokens || 0;
  sessionTotals.outputTokens += usage?.outputTokens || 0;

  logger.info(
    {
      call: schemaName,
      model: MODEL,
      effort,
      status,
      inputTokens: usage?.inputTokens ?? null,
      outputTokens: usage?.outputTokens ?? null,
      cacheReadTokens: usage?.cacheReadTokens ?? null,
      cacheWriteTokens: usage?.cacheWriteTokens ?? null,
      latencyMs,
      sinceRestart: {
        calls: sessionTotals.calls,
        inputTokens: sessionTotals.inputTokens,
        outputTokens: sessionTotals.outputTokens
      }
    },
    `ai tokens: ${schemaName} in=${usage?.inputTokens ?? '?'} out=${usage?.outputTokens ?? '?'}` +
      ` cacheRead=${usage?.cacheReadTokens ?? 0} cacheWrite=${usage?.cacheWriteTokens ?? 0}` +
      ` ${latencyMs}ms`
  );
}

function usageOf(response) {
  const u = response?.usage;
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? null,
    outputTokens: u.output_tokens ?? null,
    cacheReadTokens: u.cache_read_input_tokens ?? null,
    cacheWriteTokens: u.cache_creation_input_tokens ?? null
  };
}
