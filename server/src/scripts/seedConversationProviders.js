#!/usr/bin/env node
//
// seedConversationProviders.js — replace a location's conversation-provider
// catalogue with a known-good list, by hand.
//
// WHY THIS EXISTS. The providers a location really has live behind
// GET /conversations/providers/search, which a marketplace app cannot call:
// every request answers 401 "The token is not authorized for this scope", and
// the route is absent from GHL's public scope map, so there is no scope to
// request. The endpoint we CAN call, /locations/{id}/conversationChannels/
// {type}, returns a narrower list — for the location below it omitted
// "SMS Android" entirely and all three Call-type senders.
//
// So the catalogue is seeded from a payload copied out of the GHL UI. This is
// a stopgap, not a design: it is accurate the day it is run and goes stale the
// moment someone adds a provider in GHL.
//
// WHAT IT DOES, for ONE location:
//   1. DELETEs every conversation_providers row for that location.
//   2. INSERTs exactly the providers listed in the payload file.
//   3. Stamps them last_seen_via='manual' so the daily sync's prune skips
//      them — see syncConversationProviders' softDeleteMissing. Without that
//      the next sync would soft-delete the four rows its endpoint cannot see.
//
// Step 1 is a HARD delete and takes the native rows with it (twilio_provider
// included). That is what was asked for: the table should hold exactly the
// payload. The cost is that a historical message whose conversation_provider_id
// pointed at a deleted row now resolves to no name — the timeline falls back to
// the channel label, which is the same thing it showed before this table
// existed. Nothing 500s.
//
// Usage:
//   node src/scripts/seedConversationProviders.js <location_id> <payload.json>
//   node src/scripts/seedConversationProviders.js <location_id> <payload.json> --dry-run
//
// The payload is the JSON array from GHL's own response:
//   [{ "_id": "...", "name": "...", "type": "SMS", "alias": "", "icon": "..." }]

import { readFileSync } from 'node:fs';
import { withTenant } from '../db.js';
import { logger } from '../utils/logger.js';

// Mirrors conversationProvidersSync's own test. A hand-seeded row must
// classify identically to a synced one or is_native disagrees between them.
const NATIVE_ID_PATTERNS = [/^twilio_provider$/, /^mailgun_provider$/, /^smtp_provider_/];
const isNativeId = (id) => NATIVE_ID_PATTERNS.some((re) => re.test(id || ''));

// Migration 080's CHECK. Validated here rather than letting Postgres raise it,
// so a typo in the payload names the offending provider instead of surfacing
// as a constraint violation with no context.
const ALLOWED_TYPES = new Set([
  'SMS', 'RCS', 'Email', 'WhatsApp', 'IG', 'FB',
  'TIKTOK', 'Live_Chat', 'Call', 'Unknown'
]);

function parsePayload(path) {
  let raw;
  try {
    raw = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(`Could not read ${path}: ${err.message}`);
  }
  // Accept either the bare array or the endpoint's own envelope, so a payload
  // pasted straight from the network tab works without editing.
  const arr = Array.isArray(raw) ? raw : raw?.conversationProviders;
  if (!Array.isArray(arr)) {
    throw new Error('Payload must be a JSON array, or { conversationProviders: [...] }');
  }
  if (!arr.length) {
    // Refused rather than obeyed: this would wipe the location and leave it
    // empty, which is almost certainly a mistake with an empty file.
    throw new Error('Payload is empty — refusing to wipe the catalogue with nothing to put back');
  }

  const seen = new Set();
  return arr.map((cp, i) => {
    const id = String(cp?._id || cp?.id || '').trim();
    if (!id) throw new Error(`Entry ${i} has no _id`);
    if (seen.has(id)) throw new Error(`Entry ${i} repeats _id ${id}`);
    seen.add(id);

    const type = String(cp?.type || '').trim();
    if (!ALLOWED_TYPES.has(type)) {
      throw new Error(
        `Entry ${i} (${cp?.name || id}) has type "${type}", which migration 080 does not allow. ` +
        `Allowed: ${[...ALLOWED_TYPES].join(', ')}`
      );
    }

    return {
      id,
      name: String(cp?.name || '').trim() || null,
      type,
      isNative: isNativeId(id),
      // The whole entry is kept: alias, icon and showChannel are GHL's own
      // fields and cost nothing to store, and raw_provider is what any future
      // reconciliation would diff against.
      raw: cp
    };
  });
}

async function main() {
  const [locationId, payloadPath] = process.argv.slice(2);
  const dryRun = process.argv.includes('--dry-run');

  if (!locationId || !payloadPath) {
    console.error('Usage: node src/scripts/seedConversationProviders.js <location_id> <payload.json> [--dry-run]');
    process.exit(1);
  }

  const providers = parsePayload(payloadPath);

  await withTenant(locationId, async (client) => {
    const { rows: before } = await client.query(
      `SELECT provider_id, name, type, is_native, is_default, is_deleted
         FROM conversation_providers
        WHERE location_id = $1
        ORDER BY type, name`,
      [locationId]
    );

    console.log(`\nBEFORE — ${before.length} row(s) for ${locationId}`);
    for (const r of before) {
      console.log(
        `  ${r.provider_id.padEnd(26)} ${String(r.name ?? 'NULL').padEnd(20)} ` +
        `${String(r.type).padEnd(6)} native=${r.is_native} default=${r.is_default} deleted=${r.is_deleted}`
      );
    }

    console.log(`\nWILL INSERT — ${providers.length} row(s)`);
    for (const p of providers) {
      console.log(`  ${p.id.padEnd(26)} ${String(p.name).padEnd(20)} ${p.type.padEnd(6)} native=${p.isNative}`);
    }

    const gone = before.filter((b) => !providers.some((p) => p.id === b.provider_id));
    if (gone.length) {
      console.log(`\nWILL DELETE — ${gone.length} row(s) not in the payload`);
      for (const r of gone) {
        const note = r.is_native ? '  (NATIVE — messages attributed to it lose their sender name)' : '';
        console.log(`  ${r.provider_id.padEnd(26)} ${String(r.name ?? 'NULL').padEnd(20)}${note}`);
      }
    }

    if (dryRun) {
      console.log('\n--dry-run: nothing written.\n');
      return;
    }

    // One transaction: a half-applied catalogue is worse than either state.
    // withTenant already holds a client; BEGIN/COMMIT here keeps the delete and
    // the inserts atomic so the table is never observed empty.
    await client.query('BEGIN');
    try {
      const { rowCount: deleted } = await client.query(
        `DELETE FROM conversation_providers WHERE location_id = $1`,
        [locationId]
      );

      for (const p of providers) {
        await client.query(
          `INSERT INTO conversation_providers
             (location_id, provider_id, name, type,
              is_default, is_native, is_deleted, deleted_at,
              first_seen_at, last_synced_at, last_seen_via, raw_provider)
           VALUES ($1, $2, $3, $4, false, $5, false, NULL, now(), now(), 'manual', $6)`,
          [locationId, p.id, p.name, p.type, p.isNative, JSON.stringify(p.raw)]
        );
      }

      await client.query('COMMIT');
      console.log(`\nDone — deleted ${deleted}, inserted ${providers.length}.`);
      console.log("Rows are stamped last_seen_via='manual' so the daily sync will not prune them.\n");
      logger.info(
        { locationId, deleted, inserted: providers.length },
        'seedConversationProviders: catalogue replaced'
      );
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    }
  });
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(`\nFailed: ${err.message}\n`);
    logger.error({ err }, 'seedConversationProviders: fatal');
    process.exit(1);
  });
