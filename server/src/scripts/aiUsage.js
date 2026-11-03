// aiUsage.js — token usage report from ai_runs.
//
// Where the tokens are going, by call type and location. Reads the durable
// audit table, so it survives restarts and covers every location unless you
// narrow it.
//
// Tokens, not cost: per-model rates aren't returned by the API and change over
// time, so any figure computed here would be a guess presented as fact.
// Anthropic's console is the authority on spend.
//
// Usage:
//   npm run ai:usage
//   npm run ai:usage -- --days 7
//   npm run ai:usage -- --location fJNuIdxGgchGpJ9OoBbk
//   npm run ai:usage -- --failures        show the failing runs, newest first

import 'dotenv/config';
import { pool, rawQuery } from '../db.js';

function parseArgs(argv) {
  const out = { days: 30, location: null, failures: false };
  for (let i = 2; i < argv.length; i++) {
    if (argv[i] === '--days' && argv[i + 1]) out.days = Number(argv[++i]);
    else if (argv[i] === '--location' && argv[i + 1]) out.location = argv[++i];
    else if (argv[i] === '--failures') out.failures = true;
  }
  return out;
}

const n = (v) => Number(v || 0).toLocaleString('en-GB');

async function main() {
  const { days, location, failures } = parseArgs(process.argv);

  // rawQuery (not withTenant) on purpose: this is an operator report that may
  // span every location, and it reads only aggregate token counts — no
  // message content crosses a tenant boundary.
  const where = location
    ? `WHERE created_at > now() - ($1 || ' days')::interval AND location_id = $2`
    : `WHERE created_at > now() - ($1 || ' days')::interval`;
  const params = location ? [String(days), location] : [String(days)];

  const { rows } = await rawQuery(
    `SELECT location_id, call_type, model,
            COUNT(*)::int                               AS calls,
            COUNT(*) FILTER (WHERE status <> 'ok')::int  AS failed,
            COALESCE(SUM(input_tokens),0)::bigint        AS input_tokens,
            COALESCE(SUM(output_tokens),0)::bigint       AS output_tokens,
            COALESCE(SUM(cache_read_tokens),0)::bigint   AS cache_read,
            COALESCE(SUM(cache_write_tokens),0)::bigint  AS cache_write,
            ROUND(AVG(latency_ms))::int                  AS avg_ms,
            MAX(created_at)                              AS last_run
       FROM ai_runs
       ${where}
      GROUP BY location_id, call_type, model
      ORDER BY calls DESC`,
    params
  );

  if (rows.length === 0) {
    console.log(`No AI runs in the last ${days} days${location ? ` for ${location}` : ''}.`);
    await pool.end();
    return;
  }

  console.log(`\nAI usage — last ${days} days${location ? ` · ${location}` : ' · all locations'}`);
  console.log('─'.repeat(92));
  console.log(
    'call'.padEnd(16) + 'runs'.padStart(6) + 'fail'.padStart(6) +
    'input'.padStart(12) + 'output'.padStart(11) +
    'cacheRead'.padStart(12) + 'cacheWrite'.padStart(12) + 'avg ms'.padStart(9)
  );
  console.log('─'.repeat(92));

  let tCalls = 0, tFail = 0, tIn = 0, tOut = 0, tCached = 0, tWrite = 0;

  for (const r of rows) {
    const inTok = Number(r.input_tokens);
    const outTok = Number(r.output_tokens);
    const cr = Number(r.cache_read);
    const cw = Number(r.cache_write);

    tCalls += r.calls; tFail += r.failed;
    tIn += inTok; tOut += outTok; tCached += cr; tWrite += cw;

    console.log(
      String(r.call_type).padEnd(16) +
      String(r.calls).padStart(6) +
      String(r.failed || '').padStart(6) +
      n(inTok).padStart(12) +
      n(outTok).padStart(11) +
      n(cr).padStart(12) +
      n(cw).padStart(12) +
      String(r.avg_ms ?? '—').padStart(9)
    );
  }

  console.log('─'.repeat(92));
  console.log(
    'TOTAL'.padEnd(16) +
    String(tCalls).padStart(6) +
    String(tFail || '').padStart(6) +
    n(tIn).padStart(12) +
    n(tOut).padStart(11) +
    n(tCached).padStart(12) +
    n(tWrite).padStart(12)
  );

  // Cache hit rate is the number worth watching. Low and stable means prompt
  // ordering has broken — something volatile is sitting above the cache
  // breakpoint, so every call re-pays for the same prompt prefix.
  // The three input counters are additive, so total input is their sum — a
  // hit rate measured against input_tokens alone would read far too high.
  const totalIn = tIn + tCached + tWrite;
  if (totalIn > 0) {
    const hit = Math.round((tCached / totalIn) * 100);
    console.log(
      `\nCache: ${hit}% of ${n(totalIn)} input tokens served from cache` +
      (hit < 20 && tCalls > 5
        ? '  ⚠ low — check nothing volatile sits above the cache breakpoint'
        : '')
    );
  }
  if (tCalls > 0) {
    console.log(
      `Average per call: ${n(Math.round(totalIn / tCalls))} in, ` +
      `${n(Math.round(tOut / tCalls))} out`
    );
  }
  if (tFail > 0) {
    console.log(`\n${tFail} failed run${tFail === 1 ? '' : 's'} — re-run with --failures to see them.`);
  }

  if (failures) {
    const f = await rawQuery(
      `SELECT created_at, call_type, status, error, opportunity_id
         FROM ai_runs
        ${where} AND status <> 'ok'
        ORDER BY created_at DESC
        LIMIT 20`,
      params
    );
    console.log(`\nRecent failures (${f.rows.length}):`);
    for (const r of f.rows) {
      console.log(
        `  ${new Date(r.created_at).toISOString().slice(0, 19)}  ${r.status.padEnd(13)}` +
        `${(r.call_type || '').padEnd(16)}${(r.error || '').slice(0, 90)}`
      );
    }
  }

  console.log();
  await pool.end();
}

main().catch(async (err) => {
  console.error(err);
  try { await pool.end(); } catch (_) {}
  process.exit(1);
});
