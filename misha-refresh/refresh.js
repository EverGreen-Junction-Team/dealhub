// Dependencies first, with a sentence rather than a module-loader stack
// trace. This folder sits inside the PipelinePulse repo next to server/, and
// has its OWN node_modules — a clone where the server is already installed
// still has nothing here, so `npm start` before `npm install` is the easiest
// first-run mistake to make and the least obvious one to read.
function requireDep(name) {
  try {
    return require(name);
  } catch (err) {
    // Only when THIS name is the one missing. An installed package that
    // fails on its own inner require also throws MODULE_NOT_FOUND, and
    // blaming the install would send someone to run `npm install` on a
    // problem npm install does not fix.
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(`'${name}'`)) {
      console.error(
        `\nCannot find ${name} — dependencies are not installed in this folder.\n` +
        `misha-refresh has its own node_modules, separate from server/. Run:\n\n` +
        `    cd pipelinePulse/misha-refresh && npm install\n`
      );
      process.exit(1);
    }
    throw err;
  }
}

requireDep('dotenv').config();
const Anthropic = requireDep('@anthropic-ai/sdk');
const { Pool } = requireDep('pg');
// misha's prompts, required at startup so a missing one fails HERE with a
// sentence rather than as a module-loader stack trace 200 lines later. They
// are not in this repo on purpose — see the README: the existing 7,366 rows
// were extracted with that exact wording, and a reworded prompt would
// produce differently-shaped labels that no longer match the theme maps.
function requireMishaFile(path, exportName) {
  let mod;
  try {
    mod = require(path);
  } catch (err) {
    if (err.code === 'MODULE_NOT_FOUND' && err.message.includes(path.replace('./', ''))) {
      console.error(
        `\nMissing ${path} — this file comes from misha's original project and is not in this repo.\n` +
        `See README "Before it can run": extraction_prompt.js, requirements_prompt.js and\n` +
        `scripts/question_theme_clusters.mjs all have to be dropped in before this will start.\n`
      );
      process.exit(1);
    }
    throw err;
  }
  if (!mod[exportName]) {
    console.error(`\n${path} loaded but does not export ${exportName}.\n`);
    process.exit(1);
  }
  return mod[exportName];
}

// question_theme_clusters.mjs cannot be checked the same way: it is an ES
// module, so it is loaded with a dynamic import() in step 4 — AFTER every
// Claude call has already been paid for. A missing file would therefore
// surface only at the very end of a full run, having spent the money and
// then failed. Checked on disk here instead, so the run stops before it
// starts rather than after the expensive part.
const CLUSTERS_PATH = require('path').join(__dirname, 'scripts', 'question_theme_clusters.mjs');
if (!require('fs').existsSync(CLUSTERS_PATH)) {
  console.error(
    `\nMissing scripts/question_theme_clusters.mjs — this file comes from misha's original\n` +
    `project and is not in this repo. It is an ES module exporting classify(label).\n\n` +
    `It is only used in the final step, but it is checked now: without it a full run would\n` +
    `make every Claude call, then fail at the end with nothing to show for the spend.\n`
  );
  process.exit(1);
}

const EXTRACTION_SYSTEM_PROMPT = requireMishaFile('./extraction_prompt', 'EXTRACTION_SYSTEM_PROMPT');
const REQUIREMENTS_SYSTEM_PROMPT = requireMishaFile('./requirements_prompt', 'REQUIREMENTS_SYSTEM_PROMPT');

// Incremental refresh for the misha schema (deal_extracts, requirements,
// replies, requirement_theme_map, question_theme_map).
//
// Runs on a SCHEDULE and exits — it is not a server. The work is bursty: it
// processes whatever arrived since the last watermark and has nothing to do
// in between. A long-lived process would sit idle, and add failure modes a
// scheduled run does not have (memory drift, a crash nobody notices, two
// instances racing). See README for the cron line.
//
// What this does NOT do: touch opportunities, messages, stage_history, or any
// other PipelinePulse table. It only reads from them and writes new rows into
// the misha schema.
//
// ── WHAT CHANGED FROM MISHA'S ORIGINAL ───────────────────────────────
//
// Four things, each of which stopped it running against production at all:
//
//   1. m.extraction_ready_body does not exist here. PipelinePulse's column
//      is message_body, documented "CLEANED" in migration 001 — the same
//      thing under a different name. Every query in the original referenced
//      the missing column, so every query failed. This is why the misha
//      insights showed data frozen at migration 127's snapshot.
//   2. CLIENT_IDS was a hardcoded array of three ids. Locations now come
//      from `installs`, so a new sub-account is picked up on the next run
//      instead of being silently excluded.
//   3. No spend ceiling. One Claude call per message, two for customer
//      messages. MAX_MESSAGES_PER_RUN bounds a single run.
//   4. misha.replies has a primary key but NO unique constraint, and the
//      reply builder guards with NOT EXISTS — which is not atomic. Two
//      overlapping runs could double-insert. An advisory lock makes runs
//      mutually exclusive.

// ANTHROPIC_WORKSPACE_ID is optional and only needed for an ORGANISATION-level
// key. A workspace-scoped key (what the PipelinePulse server uses) carries its
// workspace already and needs nothing here; an org-level key is rejected on
// every call with "not scoped to a workspace" until the header is supplied.
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
  ...(process.env.ANTHROPIC_WORKSPACE_ID
    ? { defaultHeaders: { 'anthropic-workspace-id': process.env.ANTHROPIC_WORKSPACE_ID } }
    : {})
});
// SSL on by default — production Postgres requires it. Hardcoding it meant
// the job could not run against a local database at all ("the server does
// not support SSL connections"), which made it untestable anywhere but
// production. PGSSL=disable turns it off.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
});

// The one connection that holds the advisory lock for the whole run. Module
// scope so every exit path can let it go — see where it is taken.
let lockClient = null;

// Ctrl-C, `kill`, a systemd stop. The process dies, but through a connection
// POOLER the backend holding the advisory lock does not die with it — it goes
// back into the pool still holding it, and every later run reports "another
// refresh is already running" with nothing running.
//
// Direct Postgres releases the lock when the TCP connection drops, which is
// why this is easy to miss in testing and only bites behind Supavisor or
// pgbouncer. Released explicitly here so an interrupted run leaves nothing
// behind.
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    console.log(`\nInterrupted (${signal}) — releasing the lock before exiting.`);
    try { await releaseLock(); } catch { /* best effort */ }
    try { await pool.end(); } catch { /* already closing */ }
    // 130 is the conventional "killed by SIGINT" status, so a scheduler sees
    // an interrupted run rather than a successful one.
    process.exit(signal === 'SIGINT' ? 130 : 143);
  });
}

async function releaseLock() {
  if (!lockClient) return;
  try {
    await lockClient.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY.toString()]);
  } catch { /* the backend is going away anyway, which releases it */ }
  try { lockClient.release(); } catch { /* already released */ }
  lockClient = null;
}

const DRY_RUN = process.env.DRY_RUN === '1';
const MAX_MESSAGES_PER_RUN = Number(process.env.MAX_MESSAGES_PER_RUN) || 500;

// One 64-bit key, arbitrary but fixed: two runs of THIS job must not overlap.
const LOCK_KEY = 8273461029384756n;

const VALID_REP_ASK_OUTCOMES = new Set(['done', 'not_done', 'unknown']);

// A missing or malformed setting is not a crash — it is something the
// operator has to go and fix, and a ten-line Node stack trace buries the one
// sentence that says what. Tagged here so the top-level handler can print it
// plainly while a REAL failure still gets its full stack.
function configError(message) {
  const err = new Error(message);
  err.isConfigError = true;
  return err;
}

function normalizeRepAskOutcome(value) {
  return VALID_REP_ASK_OUTCOMES.has(value) ? value : 'unknown';
}

function jsonbArrayToText(value) {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    return value.join(', ');
  }
  return String(value);
}

function parseJson(text) {
  let t = text.trim();
  const fence = t.match(/```(?:json)?\s*\n([\s\S]*?)\n```/);
  if (fence) t = fence[1].trim();
  return JSON.parse(t);
}

function buildUserContent(row) {
  return JSON.stringify({
    speaker: row.speaker,
    message_text: row.cleaned_body,
    deal_context: {
      client_type: row.client_type,
      product_system: row.product_system,
      product_type: row.product_type,
      lead_source_opportunity: row.lead_source_opportunity,
      first_contact_method: row.first_contact_method,
      deal_status: row.deal_status,
      stage_at_message: row.stage_at_message,
    },
  });
}

// Every sub-account this app is installed on.
//
// Was a hardcoded array of three ids, so a fourth client's messages were
// never extracted and nobody would have seen an error — the job simply did
// less than it appeared to. ONLY_LOCATION_IDS overrides it for a targeted
// re-run of one client.
async function activeLocationIds() {
  const pinned = (process.env.ONLY_LOCATION_IDS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
  if (pinned.length) {
    console.log(`Locations: pinned to ${pinned.join(', ')} via ONLY_LOCATION_IDS`);
    return pinned;
  }
  const { rows } = await pool.query(
    `SELECT location_id FROM installs WHERE uninstalled_at IS NULL`
  );
  const ids = rows.map((r) => r.location_id);
  console.log(`Locations: ${ids.length} active install(s)`);
  return ids;
}

// Step 1: messages newer than the latest one misha has already processed.
//
// A watermark (max quoted_at in deal_extracts) rather than an exact
// message-id set: cheap on every run, at the cost of a small re-check
// window — safe, because every insert below is deduplicated.
async function fetchNewMessages(locationIds) {
  const watermark = await pool.query(
    `SELECT max(quoted_at) AS last_seen FROM misha.deal_extracts`
  );
  const lastSeen = watermark.rows[0].last_seen || '1970-01-01';
  console.log(`Watermark: processing messages after ${lastSeen}`);

  const { rows } = await pool.query(
    `
    SELECT DISTINCT ON (m.message_id)
      m.location_id, m.opportunity_id, m.message_id, m.message_direction,
      m.message_body AS cleaned_body, m.message_timestamp AS quoted_at,
      m.contact_id,
      o.client_type AS client_type_jsonb, o.product_system AS product_system_jsonb,
      o.product_type AS product_type_jsonb, o.first_contact_method AS first_contact_method_jsonb,
      o.lead_source_opportunity, o.status AS deal_status, o.current_stage_name AS furthest_stage,
      sh.stage_name AS stage_at_message,
      (
        SELECT count(DISTINCT contact_id) > 1 FROM opportunity_contacts oc
        WHERE oc.location_id = m.location_id AND oc.opportunity_id = m.opportunity_id
      ) AS deal_has_multiple_contacts
    FROM messages m
    JOIN opportunities o ON o.location_id = m.location_id AND o.opportunity_id = m.opportunity_id
    LEFT JOIN stage_history sh ON sh.location_id = m.location_id AND sh.opportunity_id = m.opportunity_id
      AND m.message_timestamp >= sh.entered_at AND (sh.left_at IS NULL OR m.message_timestamp < sh.left_at)
    WHERE m.deleted_at IS NULL
      AND m.opportunity_id IS NOT NULL
      AND m.message_body IS NOT NULL
      AND trim(m.message_body) <> ''
      AND trim(m.message_body) NOT IN (
        'Opportunity created', 'Opportunity updated', 'Opportunity status changed', 'Opportunity deleted'
      )
      AND m.location_id = ANY($1)
      AND m.message_timestamp > $2
    ORDER BY m.message_id, sh.entered_at DESC NULLS LAST
    LIMIT $3
    `,
    [locationIds, lastSeen, MAX_MESSAGES_PER_RUN]
  );

  return rows.map((r) => ({
    ...r,
    client_type: jsonbArrayToText(r.client_type_jsonb),
    product_system: jsonbArrayToText(r.product_system_jsonb),
    product_type: jsonbArrayToText(r.product_type_jsonb),
    first_contact_method: jsonbArrayToText(r.first_contact_method_jsonb),
    speaker: r.message_direction === 'inbound' ? 'customer' : 'rep',
  }));
}

// A CONFIGURATION failure is not a bad message — it is the same failure for
// every message, and retrying 499 more times changes nothing. The original
// per-message catch treated them alike, so one wrong API key produced 500
// identical 400s scrolling past, cost real time, and buried the one line that
// said what was actually wrong.
//
// 401/403 (bad key) and 400 "not scoped to a workspace" are settings, not data.
// Stop on the first one and say what to change.
function fatalConfigFailure(err) {
  const status = err?.status;
  const msg = String(err?.message || '');
  if (status === 401 || status === 403) return 'The ANTHROPIC_API_KEY is not valid.';
  if (status === 400 && /not scoped to a workspace/i.test(msg)) {
    return 'This ANTHROPIC_API_KEY is an organisation key, not a workspace key.\n' +
           'Either use a workspace-scoped key (the PipelinePulse server uses one),\n' +
           'or set ANTHROPIC_WORKSPACE_ID in .env to the workspace to bill.';
  }
  return null;
}

// Step 2: the same two extraction passes as the original full run, on just
// the new rows, through the synchronous Messages API — an incremental run is
// small enough not to need batch pricing.
async function extractFacts(rows) {
  let inserted = 0, empty = 0, errored = 0;
  for (const row of rows) {
    let msg;
    try {
      msg = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: EXTRACTION_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserContent(row) }],
      });
    } catch (err) {
      // One message failing must not end the run: the watermark has not
      // moved, so the next run retries it.
      const fatal = fatalConfigFailure(err);
      if (fatal) {
        console.error(`\n${fatal}\n`);
        console.error('Stopped before the first message. Nothing was written and no tokens were billed.');
        await releaseLock();
        await pool.end();
        process.exit(1);
      }
      console.error(`  facts: API call failed for ${row.message_id}: ${err.message}`);
      errored++;
      continue;
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    let parsed;
    try { parsed = parseJson(text); } catch { errored++; continue; }
    const facts = Array.isArray(parsed.facts) ? parsed.facts : [];
    if (facts.length === 0) { empty++; continue; }

    for (const fact of facts) {
      if (!fact.fact_type || !fact.label || !fact.quote) continue;
      await pool.query(
        `INSERT INTO misha.deal_extracts (
          location_id, opportunity_id, message_id, fact_type, speaker, label, quote, quoted_at,
          deal_status, client_type, product_system, product_type, lead_source_opportunity,
          first_contact_method, tags, furthest_stage, stage_at_message, stage_match_method,
          contact_id, deal_has_multiple_contacts, pii_stripped, rep_ask_outcome, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23)
        ON CONFLICT (location_id, message_id, fact_type, label) DO NOTHING`,
        [
          row.location_id, row.opportunity_id, row.message_id, fact.fact_type,
          fact.speaker || row.speaker, fact.label, fact.quote, row.quoted_at,
          row.deal_status, row.client_type, row.product_system, row.product_type,
          row.lead_source_opportunity, row.first_contact_method, ['blank'],
          row.furthest_stage, row.stage_at_message, 'stage_history_id',
          row.contact_id, row.deal_has_multiple_contacts, true,
          fact.fact_type === 'rep_ask' ? normalizeRepAskOutcome(fact.rep_ask_outcome) : null,
          'misha_refresh',
        ]
      );
      inserted++;
    }
  }
  console.log(`Facts: inserted=${inserted}, empty=${empty}, errored=${errored}`);
}

async function extractRequirements(customerRows) {
  let inserted = 0, empty = 0, errored = 0;
  for (const row of customerRows) {
    let msg;
    try {
      msg = await anthropic.messages.create({
        model: 'claude-sonnet-5',
        max_tokens: 1500,
        system: REQUIREMENTS_SYSTEM_PROMPT,
        messages: [{ role: 'user', content: buildUserContent(row) }],
      });
    } catch (err) {
      const fatal = fatalConfigFailure(err);
      if (fatal) {
        console.error(`\n${fatal}\n`);
        console.error('Stopped before the first message. Nothing was written and no tokens were billed.');
        await releaseLock();
        await pool.end();
        process.exit(1);
      }
      console.error(`  requirements: API call failed for ${row.message_id}: ${err.message}`);
      errored++;
      continue;
    }
    const text = msg.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    let parsed;
    try { parsed = parseJson(text); } catch { errored++; continue; }
    const reqs = Array.isArray(parsed.requirements) ? parsed.requirements : [];
    if (reqs.length === 0) { empty++; continue; }

    for (const req of reqs) {
      if (!req.requirement_label || !req.quote) continue;
      await pool.query(
        `INSERT INTO misha.requirements (
          location_id, opportunity_id, message_id, requirement_label, quote, quoted_at,
          is_objection, is_price_limit, price_limit_amount, deal_status, stage_at_time,
          client_type, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)
        ON CONFLICT (location_id, message_id, requirement_label) DO NOTHING`,
        [
          row.location_id, row.opportunity_id, row.message_id, req.requirement_label, req.quote,
          row.quoted_at, !!req.is_objection, !!req.is_price_limit,
          req.is_price_limit ? req.price_limit_amount ?? null : null,
          row.deal_status, row.stage_at_message, row.client_type, 'misha_refresh',
        ]
      );
      inserted++;
    }
  }
  console.log(`Requirements: inserted=${inserted}, empty=${empty}, errored=${errored}`);
}

// Step 3: rebuild replies from whatever is now in deal_extracts/requirements
// without a misha.replies row. Incremental by design (existence check before
// insert) — and the advisory lock in main() is what makes that check safe,
// since misha.replies has no unique constraint to fall back on.
const MIN_PLAUSIBLE_MOVE_DAYS = 15 / (24 * 60);

async function refreshReplies() {
  async function buildFromFactTable(sourceSql, refColumn, label) {
    const { rows } = await pool.query(`
      WITH source_facts AS (${sourceSql}),
      rep_replies AS (
        SELECT DISTINCT ON (f.id)
          f.id AS fact_id, f.location_id, f.opportunity_id, f.client_type, f.deal_status,
          m.message_id AS reply_message_id, m.message_body AS reply_text,
          m.message_timestamp AS reply_at
        FROM source_facts f
        JOIN messages m ON m.location_id = f.location_id AND m.opportunity_id = f.opportunity_id
          AND m.message_direction = 'outbound' AND m.deleted_at IS NULL
          AND m.message_timestamp > f.asked_at
          AND m.message_body IS NOT NULL AND trim(m.message_body) <> ''
          AND trim(m.message_body) NOT IN (
            'Opportunity created', 'Opportunity updated', 'Opportunity status changed', 'Opportunity deleted'
          )
        WHERE NOT EXISTS (
          SELECT 1 FROM misha.replies r WHERE r.location_id = f.location_id AND r.${refColumn} = f.id
        )
        ORDER BY f.id, m.message_timestamp ASC
      ),
      next_stage AS (
        SELECT DISTINCT ON (r.fact_id)
          r.fact_id, sh.stage_name, sh.entered_at,
          EXTRACT(EPOCH FROM (sh.entered_at - r.reply_at)) / 86400 AS days_to_move
        FROM rep_replies r
        JOIN stage_history sh ON sh.location_id = r.location_id AND sh.opportunity_id = r.opportunity_id
          AND sh.entered_at > r.reply_at
        ORDER BY r.fact_id, sh.entered_at ASC
      )
      SELECT r.fact_id, r.location_id, r.opportunity_id, r.client_type, r.deal_status,
        r.reply_message_id, r.reply_text, r.reply_at, ns.stage_name, ns.days_to_move
      FROM rep_replies r LEFT JOIN next_stage ns ON ns.fact_id = r.fact_id
    `);

    let inserted = 0;
    for (const row of rows) {
      const plausibleMove = row.days_to_move !== null && Number(row.days_to_move) >= MIN_PLAUSIBLE_MOVE_DAYS;
      await pool.query(
        `INSERT INTO misha.replies (
          location_id, opportunity_id, ${refColumn}, rep_reply, rep_reply_message_id,
          rep_reply_at, deal_moved_stage_after, stage_moved_to, days_to_move, client_type, created_by
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
        [
          row.location_id, row.opportunity_id, row.fact_id, row.reply_text, row.reply_message_id,
          row.reply_at, plausibleMove, plausibleMove ? row.stage_name : null,
          plausibleMove ? row.days_to_move : null, row.client_type, 'misha_refresh',
        ]
      );
      inserted++;
    }
    console.log(`${label}: inserted=${inserted} new replies`);
  }

  await buildFromFactTable(
    `SELECT de.id, de.location_id, de.opportunity_id, de.quoted_at AS asked_at, de.client_type, de.deal_status
     FROM misha.deal_extracts de WHERE de.fact_type = 'customer_question'`,
    'customer_question_id', 'customer_question'
  );
  await buildFromFactTable(
    `SELECT r.id, r.location_id, r.opportunity_id, r.quoted_at AS asked_at, r.client_type, r.deal_status
     FROM misha.requirements r`,
    'customer_requirement_id', 'customer_requirement'
  );
}

// Step 4: classify new question labels against the existing theme rules.
//
// Requirement labels have no rule-based classifier — the original mapping was
// built by hand — so new ones land as "needs review" rather than being
// guessed. See the README: that queue grows silently and someone has to
// work it, or the requirement-theme insights drift toward uncategorised.
async function refreshThemeMaps() {
  // question_theme_clusters.mjs is an ES module; this file is CommonJS, so it
  // must be loaded with a dynamic import rather than require().
  const { classify: classifyQuestionLabel } = await import('./scripts/question_theme_clusters.mjs');

  const newQuestions = await pool.query(`
    SELECT DISTINCT de.location_id, de.label
    FROM misha.deal_extracts de
    LEFT JOIN misha.question_theme_map tm
      ON tm.location_id = de.location_id AND tm.question_label = de.label
    WHERE de.fact_type = 'customer_question' AND tm.theme IS NULL
  `);
  for (const row of newQuestions.rows) {
    const theme = classifyQuestionLabel(row.label);
    await pool.query(
      `INSERT INTO misha.question_theme_map (location_id, question_label, theme, created_by)
       VALUES ($1, $2, $3, 'misha_refresh')
       ON CONFLICT (location_id, question_label) DO NOTHING`,
      [row.location_id, row.label, theme]
    );
  }
  console.log(`Question theme map: classified ${newQuestions.rows.length} new labels.`);

  const newRequirements = await pool.query(`
    SELECT DISTINCT r.location_id, r.requirement_label
    FROM misha.requirements r
    LEFT JOIN misha.requirement_theme_map tm
      ON tm.location_id = r.location_id AND tm.requirement_label = r.requirement_label
    WHERE tm.theme IS NULL
  `);
  for (const row of newRequirements.rows) {
    await pool.query(
      `INSERT INTO misha.requirement_theme_map (location_id, requirement_label, theme, created_by)
       VALUES ($1, $2, 'Other / uncategorized, needs review', 'misha_refresh')
       ON CONFLICT (location_id, requirement_label) DO NOTHING`,
      [row.location_id, row.requirement_label]
    );
  }
  console.log(`Requirement theme map: added ${newRequirements.rows.length} new labels as needs-review placeholders.`);

  // The size of the REVIEW BACKLOG, not just today's additions. Unattended,
  // this is the number that quietly decides how much of the requirement-theme
  // insight reads "uncategorised".
  const backlog = await pool.query(`
    SELECT count(*)::int AS n FROM misha.requirement_theme_map
     WHERE theme = 'Other / uncategorized, needs review'
  `);
  if (backlog.rows[0].n > 0) {
    console.log(
      `ACTION NEEDED: ${backlog.rows[0].n} requirement label(s) await a real theme. ` +
      `Review misha.requirement_theme_map where theme = 'Other / uncategorized, needs review'.`
    );
  }
}

async function main() {
  const startedAt = new Date().toISOString();

  if (!process.env.DATABASE_URL) throw configError('DATABASE_URL is not set — see .env.example');
  if (!DRY_RUN && !process.env.ANTHROPIC_API_KEY) {
    throw configError('ANTHROPIC_API_KEY is not set — see .env.example');
  }

  // ONE RUN AT A TIME. misha.replies has a primary key but no unique
  // constraint, and the reply builder guards with NOT EXISTS — two
  // overlapping runs would both see "no reply yet" and both insert. A
  // session-level advisory lock is the cheapest way to make that impossible;
  // it is released when this process exits, however it exits.
  // ON ONE PINNED CONNECTION, not pool.query().
  //
  // An advisory lock belongs to the SESSION that took it. pool.query() borrows
  // any idle connection and hands it straight back, so the lock stays on a
  // backend this run no longer holds — and through a pooler (Supabase's
  // Supavisor, pgbouncer) the next statement lands on a DIFFERENT backend
  // entirely. The run then sees its OWN orphaned lock and reports "another
  // refresh is already running", forever, with nothing actually running.
  //
  // Verified against a real Postgres: with pool.query() the second request
  // gets `false` from a lock the same process took moments earlier.
  //
  // Holding one dedicated client for the lifetime of the run makes the lock
  // mean what it says. It is released explicitly below, and by the backend
  // closing if this process dies.
  lockClient = await pool.connect();
  const lock = await lockClient.query(
    'SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY.toString()]
  );
  if (!lock.rows[0].ok) {
    console.log('Another refresh is already running — exiting without doing anything.');
    lockClient.release();
    await releaseLock();
    await pool.end();
    process.exit(0);
  }

  const locationIds = await activeLocationIds();
  if (locationIds.length === 0) {
    console.log('No active installs — nothing to do.');
    await releaseLock();
    await pool.end();
    process.exit(0);
  }

  const newRows = await fetchNewMessages(locationIds);
  console.log(`Found ${newRows.length} new message(s) since the last refresh.`);
  if (newRows.length === MAX_MESSAGES_PER_RUN) {
    console.log(
      `Hit the per-run cap of ${MAX_MESSAGES_PER_RUN}. The rest will be picked up ` +
      `on the next run — raise MAX_MESSAGES_PER_RUN to catch up faster.`
    );
  }

  if (newRows.length === 0) {
    console.log('Nothing new to process. Refresh complete.');
    await releaseLock();
    await pool.end();
    process.exit(0);
  }

  if (DRY_RUN) {
    const customers = newRows.filter((r) => r.speaker === 'customer').length;
    console.log(
      `DRY RUN — no writes, no Claude calls. Would make ~${newRows.length + customers} API call(s): ` +
      `${newRows.length} fact extraction(s) + ${customers} requirement extraction(s).`
    );
    await releaseLock();
    await pool.end();
    process.exit(0);
  }

  const customerRows = newRows.filter((r) => r.speaker === 'customer');
  await extractFacts(newRows);
  await extractRequirements(customerRows);
  await refreshReplies();
  await refreshThemeMaps();

  console.log(`Refresh complete. Started ${startedAt}, finished ${new Date().toISOString()}.`);
  await releaseLock();
  await pool.end();
  process.exit(0);
}

main().catch(async (err) => {
  if (err && err.isConfigError) {
    console.error(`\n${err.message}\n`);
  } else {
    console.error('FATAL:', err);
  }
  // Surface the failure to the scheduler: a non-zero exit is what makes a
  // cron wrapper or systemd timer report this run as failed rather than
  // silently succeeding.
  try { await releaseLock(); } catch { /* best effort */ }
  try { await pool.end(); } catch { /* already closing */ }
  process.exit(1);
});
