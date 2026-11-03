// Clear a stale advisory lock, through the SAME route the job uses.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────
//
// refresh.js takes a session-level advisory lock so two runs cannot overlap.
// Behind a connection POOLER (Supabase's Supavisor, pgbouncer) the backend
// holding that lock does NOT die with the client: an abrupt kill — Ctrl-C, a
// reboot, a killed cron job — leaves the lock owned by a backend nobody is
// using. Every later run then reports "another refresh is already running"
// with nothing running.
//
// A SQL editor usually cannot fix this, because it reaches Postgres by a
// different route and lands on different backends — pg_locks there can show
// zero rows while the lock plainly still exists. So this runs through
// DATABASE_URL, exactly as the job does.
//
// Safe: it only ever terminates backends holding THIS job's key, and never
// its own connection.

require('dotenv').config();
const { Pool } = require('pg');

const KEY = '8273461029384756';
// How Postgres records that bigint key in pg_locks (verified, not derived).
const CLASSID = 1926315;
const OBJID = 1102590516;

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: process.env.PGSSL === 'disable' ? false : { rejectUnauthorized: false },
  max: 10,
});

const HOLDERS = `
  SELECT a.pid, a.state, a.application_name,
         -- As text: node-postgres hands an interval back as an object, which
         -- prints as [object Object] and tells the reader nothing.
         (now() - a.state_change)::text AS idle_for
    FROM pg_locks l
    JOIN pg_stat_activity a ON a.pid = l.pid
   WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2`;

(async () => {
  const who = await pool.query(HOLDERS, [CLASSID, OBJID]);
  console.log(`Holders visible from here: ${who.rowCount}`);
  for (const r of who.rows) {
    console.log(`  pid ${r.pid} | ${r.state} | ${r.application_name} | idle ${r.idle_for}`);
  }

  if (who.rowCount > 0) {
    const killed = await pool.query(
      `SELECT pg_terminate_backend(a.pid) AS ok, a.pid
         FROM pg_locks l
         JOIN pg_stat_activity a ON a.pid = l.pid
        WHERE l.locktype = 'advisory' AND l.classid = $1 AND l.objid = $2
          AND a.pid <> pg_backend_pid()`,
      [CLASSID, OBJID]
    );
    console.log(`Terminated ${killed.rowCount} backend(s).`);
  }

  // The real test, and the reason for the loop: through a pooler each
  // connect() may land on a different backend, so one failure proves nothing.
  for (let i = 1; i <= 25; i++) {
    const c = await pool.connect();
    const got = await c.query('SELECT pg_try_advisory_lock($1) AS ok', [KEY]);
    if (got.rows[0].ok) {
      await c.query('SELECT pg_advisory_unlock($1)', [KEY]);
      c.release();
      await pool.end();
      console.log(`\nLOCK IS CLEAR (after ${i} attempt${i > 1 ? 's' : ''}).`);
      console.log('Now run:  /usr/bin/node refresh.js');
      return;
    }
    c.release();
  }

  await pool.end();
  console.log('\nSTILL LOCKED after 25 attempts.');
  console.log('Check for a real run first:  ps aux | grep "[r]efresh.js"');
})().catch(async (err) => {
  console.error('unlock failed:', err.message);
  try { await pool.end(); } catch { /* closing anyway */ }
  process.exit(1);
});
