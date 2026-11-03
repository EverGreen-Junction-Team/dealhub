import pg from 'pg';
import { config } from './config.js';
import { logger } from './utils/logger.js';

// Single shared pool for the whole process. Each per-tenant operation
// checks out a connection, sets the `app.location_id` session variable so
// Row-Level Security policies activate, runs its queries, then returns it.
//
// Migrations and admin scripts use a fresh pg.Client (no pool) so they
// don't interfere with this pool's RLS contract.
export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 20,
  idleTimeoutMillis: 30_000,
  connectionTimeoutMillis: 10_000
});

pool.on('error', (err) => {
  // Errors that bubble up from idle clients in the pool. Log so we see
  // them, but don't crash — pg will replace the client on next checkout.
  logger.error({ err }, 'pg pool: idle client error');
});

// Confirms we can reach Postgres + emits a one-time "connected" log line so
// boot output is reassuring.
export async function pingDb() {
  const { rows } = await pool.query('SELECT current_database() AS db, current_user AS role, now() AS now');
  logger.info(rows[0], 'Postgres connected');
}

// Run a callback with a connection that has `app.location_id` set for the
// duration of the transaction. ALWAYS use this for per-tenant writes — it's
// the only thing standing between a forgotten WHERE clause and a cross-
// tenant data leak.
//
// Usage:
//   await withTenant(locationId, async (client) => {
//     await client.query('INSERT INTO contacts ...');
//     await client.query('INSERT INTO opportunities ...');
//   });
export async function withTenant(locationId, fn) {
  if (!locationId) throw new Error('withTenant: locationId is required');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    // set_config with is_local=true scopes the variable to this transaction.
    // Using set_config (not SET LOCAL) so the literal value is parameterized,
    // not concatenated — protects against accidental SQL injection if
    // locationId ever ends up coming from somewhere we didn't expect.
    await client.query('SELECT set_config($1, $2, true)', ['app.location_id', locationId]);
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    try { await client.query('ROLLBACK'); } catch (_) {}
    throw err;
  } finally {
    client.release();
  }
}

// For app-internal tables (installs, processed_events, pending_opportunities)
// that don't have RLS. Skips the BEGIN/set_config/COMMIT dance.
export function rawQuery(text, params) {
  return pool.query(text, params);
}
