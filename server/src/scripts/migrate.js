// migrate.js — apply .sql files from /migrations in lexicographic order,
// tracking applied filenames in the schema_migrations table so we never
// re-run a migration that already succeeded.
//
// Design:
//   1. Ensure schema_migrations exists (creates it via 038 the first time,
//      but we CREATE IF NOT EXISTS inline as a safety net for order).
//   2. Read applied filenames.
//   3. For each .sql file in order, skip if in schema_migrations.
//      Otherwise: run inside a transaction that also INSERTs the filename
//      into schema_migrations. Commit atomically.
//   4. On failure: ROLLBACK — neither the migration effects nor the
//      tracker row persist. Next deploy retries the same file.
//
// This eliminates the "rename in migration N breaks re-run of migration M"
// class of failure we've hit repeatedly.
//
// Intentionally does NOT import ../config.js. Migrations only need
// DATABASE_URL — pulling in the full config would force GHL_CLIENT_ID /
// GHL_CLIENT_SECRET etc. to be set, which is the wrong precondition for a
// schema-only operation.

import 'dotenv/config';
import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

function log(level, msg, extra = {}) {
  const line = JSON.stringify({ ts: new Date().toISOString(), level, msg, ...extra });
  (level === 'error' ? console.error : console.log)(line);
}

async function ensureTrackerTable(client) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )
  `);
}

async function fetchApplied(client) {
  const { rows } = await client.query(`SELECT filename FROM schema_migrations`);
  return new Set(rows.map((r) => r.filename));
}

async function applyOne(client, file, sql) {
  await client.query('BEGIN');
  try {
    await client.query(sql);
    await client.query(
      `INSERT INTO schema_migrations (filename) VALUES ($1)
       ON CONFLICT (filename) DO NOTHING`,
      [file]
    );
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('Missing required env var: DATABASE_URL');
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  try {
    await ensureTrackerTable(client);
    const applied = await fetchApplied(client);

    const files = (await fs.readdir(MIGRATIONS_DIR))
      .filter((f) => f.endsWith('.sql'))
      .sort();
    if (files.length === 0) {
      log('warn', 'migrate: no .sql files found', { dir: MIGRATIONS_DIR });
      return;
    }

    let ran = 0;
    let skipped = 0;
    for (const file of files) {
      if (applied.has(file)) {
        skipped++;
        continue;
      }
      const sql = await fs.readFile(path.join(MIGRATIONS_DIR, file), 'utf8');
      log('info', 'migrate: applying', { file });
      await applyOne(client, file, sql);
      log('info', 'migrate: applied', { file });
      ran++;
    }
    log('info', 'migrate: all migrations processed', { ran, skipped, total: files.length });
  } finally {
    await client.end();
  }
}

main().catch((err) => {
  log('error', 'migrate: failed', { err, stack: err.stack });
  process.exit(1);
});
