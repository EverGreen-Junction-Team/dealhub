// verifyMishaImport.js — read-only check that the misha schema (126-128) and
// the 12 voice-of-customer views (129-130) are present and correct.
//
// Run BEFORE migrating to see what is missing, and AFTER to confirm it landed:
//   node src/scripts/verifyMishaImport.js
//
// Exits 0 if everything expected is present, 1 otherwise, so it can gate a
// deploy step. Reads only — no DDL, no writes, no tenant data in the output
// beyond counts and location ids.
//
// Deliberately does NOT import ../config.js: that would demand GHL_CLIENT_ID
// and friends for what is a schema-only check.

import 'dotenv/config';
import pg from 'pg';

const EXPECTED_ROWS = {
  'misha.deal_extracts': 3926,
  'misha.replies': 1169,
  'misha.requirements': 1347,
  'misha.requirement_theme_map': 1328,
  'misha.question_theme_map': 596,
  'misha.questions': 50,
  'misha.phrases': 50,
  'misha.requirement_offer': 0,
};

const EXPECTED_VIEWS = [
  'vw_customer_question_themes', 'vw_customer_objection_themes',
  'vw_requirement_lost_value', 'vw_requirement_quotes',
  'vw_requirement_vs_baseline', 'vw_reply_stage_movement',
  'vw_reply_list', 'vw_close_reason_by_buyer_type',
  'vw_enquiry_text_coverage', 'vw_requirement_by_buyer_product',
  'vw_stated_budget_vs_quote', 'vw_stated_budget_coverage',
];

const EXPECTED_MIGRATIONS = [
  '126_misha_schema.sql', '127_misha_data.sql', '128_misha_constraints.sql',
  '129_vw_misha_voice_of_customer.sql', '130_vw_misha_requirements_and_price.sql',
];

const GREEN = (s) => `\x1b[32m${s}\x1b[0m`;
const RED   = (s) => `\x1b[31m${s}\x1b[0m`;
const DIM   = (s) => `\x1b[2m${s}\x1b[0m`;
const ok = (c) => (c ? GREEN('PASS') : RED('FAIL'));

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing required env var: DATABASE_URL');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  let failures = 0;

  try {
    const { rows: [{ v }] } = await client.query('SELECT current_setting($1) AS v', ['server_version']);
    const major = parseInt(v, 10);
    console.log(`\nPostgres ${v}  ${major >= 15 ? GREEN('(15+, security_invoker supported)')
                                                : RED('(needs 15+ for security_invoker)')}`);
    if (major < 15) failures++;

    // 1. migrations recorded
    console.log('\n── migrations ' + '─'.repeat(50));
    // schema_migrations may not exist on a database that has never been
    // migrated — report that rather than crashing, so this script is usable
    // as a BEFORE check too.
    let applied = new Set();
    try {
      const { rows: mig } = await client.query(
        `SELECT filename FROM schema_migrations WHERE filename = ANY($1)`, [EXPECTED_MIGRATIONS]);
      applied = new Set(mig.map((r) => r.filename));
    } catch {
      console.log(`  ${DIM('schema_migrations does not exist — nothing has been migrated here')}`);
    }
    for (const f of EXPECTED_MIGRATIONS) {
      const has = applied.has(f);
      if (!has) failures++;
      console.log(`  ${ok(has)}  ${f}`);
    }

    // 2. schema exists
    console.log('\n── misha schema ' + '─'.repeat(48));
    const { rows: [{ exists: hasSchema }] } = await client.query(
      `SELECT EXISTS (SELECT 1 FROM pg_namespace WHERE nspname = 'misha') AS exists`);
    if (!hasSchema) failures++;
    console.log(`  ${ok(hasSchema)}  schema "misha" exists`);

    // 3. row counts
    if (hasSchema) {
      console.log('\n── row counts ' + '─'.repeat(50));
      for (const [table, expected] of Object.entries(EXPECTED_ROWS)) {
        let actual = null;
        try {
          const { rows: [r] } = await client.query(`SELECT count(*)::int AS n FROM ${table}`);
          actual = r.n;
        } catch { /* table missing — reported as FAIL below */ }
        const good = actual === expected;
        if (!good) failures++;
        const shown = actual === null ? 'missing' : actual;
        console.log(`  ${ok(good)}  ${table.padEnd(30)} ${String(shown).padStart(5)} ${DIM('expected ' + expected)}`);
      }
    }

    // 4. views + security_invoker + location_id
    console.log('\n── views (tenant safety) ' + '─'.repeat(39));
    const { rows: views } = await client.query(
      `SELECT c.relname,
              c.reloptions::text LIKE '%security_invoker=true%' AS sec_inv,
              EXISTS (SELECT 1 FROM information_schema.columns col
                       WHERE col.table_schema = 'public'
                         AND col.table_name = c.relname
                         AND col.column_name = 'location_id') AS has_loc
         FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
        WHERE n.nspname = 'public' AND c.relkind = 'v' AND c.relname = ANY($1)`,
      [EXPECTED_VIEWS]);
    const byName = new Map(views.map((r) => [r.relname, r]));
    for (const v of EXPECTED_VIEWS) {
      const row = byName.get(v);
      const good = !!row && row.sec_inv && row.has_loc;
      if (!good) failures++;
      const why = !row ? 'missing'
        : !row.sec_inv ? RED('NO security_invoker — would leak across sub-accounts')
        : !row.has_loc ? RED('no location_id column') : '';
      console.log(`  ${ok(good)}  ${v.padEnd(34)} ${why}`);
    }

    // 5. each view actually runs
    console.log('\n── views execute ' + '─'.repeat(47));
    for (const v of EXPECTED_VIEWS) {
      if (!byName.has(v)) continue;
      try {
        const { rows: [r] } = await client.query(`SELECT count(*)::int AS n FROM ${v}`);
        console.log(`  ${ok(true)}  ${v.padEnd(34)} ${String(r.n).padStart(6)} rows`);
      } catch (err) {
        failures++;
        console.log(`  ${ok(false)}  ${v.padEnd(34)} ${RED(err.message.split('\n')[0])}`);
      }
    }

    // 6. join health — the two that silently return a biased sample
    if (hasSchema) {
      console.log('\n── join health ' + '─'.repeat(49));
      const { rows: [j1] } = await client.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE q.id IS NULL)::int AS orphaned
          FROM misha.replies r
          LEFT JOIN misha.questions q ON q.id = r.customer_question_id
         WHERE r.customer_question_id IS NOT NULL`);
      console.log(`  ${DIM('replies -> questions')}      ${j1.orphaned}/${j1.total} orphaned ` +
        DIM('(expected ~95% — no FK, questions truncated upstream; never inner-join these)'));

      const { rows: [j2] } = await client.query(`
        SELECT count(*)::int AS total,
               count(*) FILTER (WHERE rq.id IS NULL)::int AS orphaned
          FROM misha.replies r
          LEFT JOIN misha.requirements rq ON rq.id = r.customer_requirement_id
         WHERE r.customer_requirement_id IS NOT NULL`);
      const j2ok = j2.orphaned === 0;
      if (!j2ok) failures++;
      console.log(`  ${ok(j2ok)}  replies -> requirements  ${j2.orphaned}/${j2.total} orphaned ` +
        DIM('(expected 0 — this one has a real FK)'));

      const { rows: [j3] } = await client.query(`
        SELECT count(*)::int AS unmapped FROM (
          SELECT DISTINCT r.location_id, r.requirement_label
            FROM misha.requirements r
            LEFT JOIN misha.requirement_theme_map tm
                   ON tm.location_id = r.location_id
                  AND tm.requirement_label = r.requirement_label
           WHERE tm.theme IS NULL) z`);
      console.log(`  ${DIM('requirement labels unmapped')} ${j3.unmapped} ` +
        DIM('(expected 3 — all Omnia, which has no theme vocabulary)'));
    }

    // 7. skills registered, per location
    console.log('\n── skills registered ' + '─'.repeat(43));
    let skills = [];
    try {
    ({ rows: skills } = await client.query(
      `SELECT location_id, count(*)::int AS n
         FROM ai_skills WHERE name = ANY($1) GROUP BY location_id ORDER BY 1`,
      [[
        'customer_question_themes','customer_objection_themes','requirement_lost_value',
        'requirement_quotes','requirement_vs_baseline','reply_stage_movement','reply_list',
        'close_reason_by_buyer_type','enquiry_text_coverage','requirement_by_buyer_product',
        'stated_budget_vs_quote','stated_budget_coverage',
      ]]));
    } catch {
      console.log(`  ${DIM('ai_skills table does not exist yet')}`);
    }
    if (!skills.length) {
      console.log(`  ${DIM('none yet — run seedAiSkills.js <location_id> after migrating')}`);
    } else {
      for (const s of skills) {
        const good = s.n === 12;
        console.log(`  ${ok(good)}  ${s.location_id}  ${s.n}/12 new skills`);
      }
    }

    console.log('\n' + '═'.repeat(64));
    console.log(failures === 0
      ? GREEN(`  ALL CHECKS PASSED`)
      : RED(`  ${failures} CHECK${failures === 1 ? '' : 'S'} FAILED`));
    console.log('═'.repeat(64) + '\n');
  } finally {
    await client.end();
  }
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('\nverify: failed —', err.message, '\n');
  process.exit(1);
});
