// Re-map every existing message to a deal, using the rule agreed 2026-09-08.
// See docs/MESSAGE-DEAL-LINKING-RULE.md.
//
// WHY THIS IS NOT THE LIVE RULE.
//
// The live rule asks "which of the contact's deals is Open?". Applied to old
// messages that answers almost nothing: most deals from months ago are now
// Won or Lost, so nearly every historic message would end up unlinked.
//
// So the backfill asks the same question AS AT THE MESSAGE DATE. A deal was
// open on that date when:
//
//   1. it was created on or before the message date, AND
//   2. it had not yet been Won / Lost / Abandoned — i.e. it is still open
//      now, OR its status changed AFTER the message date
//
// Then, exactly as the live rule: one match links, several link to the
// earliest-created, none leaves the message unlinked.
//
// Worked example — Karen's deal created 1 Mar, marked Won 20 Mar:
//   message 10 Mar → deal was open  → linked
//   message 25 Mar → already won    → unlinked
//   message 20 Feb → did not exist  → unlinked
//
// MANUAL MAPPINGS ARE NEVER TOUCHED. A row with mapping_status
// 'manually_resolved' is skipped outright — a sales manager's decision
// outranks this script.
//
// Run: node src/scripts/backfillMessageAttribution.js [--location=<id>] [--dry-run] [--limit=N]

import { rawQuery } from '../db.js';
import { logger } from '../utils/logger.js';

const args = process.argv.slice(2);
const onlyLocation = args.find((a) => a.startsWith('--location='))?.split('=')[1] || null;
const limitArg = args.find((a) => a.startsWith('--limit='))?.split('=')[1];
const LIMIT = limitArg ? Number(limitArg) : null;
const dryRun = args.includes('--dry-run');

const RULE_VERSION = 'v2';

// The point-in-time query. One statement per message rather than a single
// giant UPDATE: the volume is modest, and a per-row decision is auditable —
// a set-based rewrite that got the window wrong would be very hard to unpick.
const CANDIDATES_SQL = `
  SELECT m.message_id,
         m.contact_id,
         m.message_timestamp,
         mom.mapping_status AS current_status,
         mom.opportunity_id AS current_opp
    FROM messages m
    LEFT JOIN message_opportunity_map mom
           ON mom.location_id = m.location_id
          AND mom.message_id  = m.message_id
          AND mom.superseded_at IS NULL
   WHERE m.location_id = $1
     AND m.deleted_at IS NULL
     AND m.contact_id IS NOT NULL
     -- A human already decided this one.
     AND (mom.mapping_status IS NULL OR mom.mapping_status <> 'manually_resolved')
   ORDER BY m.message_timestamp ASC
   ${LIMIT ? 'LIMIT ' + Number(LIMIT) : ''}`;

// "Which deals were open when this message was sent?"
//
// created_at_ghl only — a deal without one is skipped entirely. imported_at
// is our sync date, not the deal's, and using it would misjudge exactly the
// historic messages this script exists to place.
//
// The status-change time is the EARLIEST of won/lost/abandoned — a deal that
// was won and later reopened and lost should stop counting at the first
// terminal event, not the last.
const OPEN_AT_SQL = `
  SELECT o.opportunity_id
    FROM opportunities o
   WHERE o.location_id = $1
     AND o.contact_id  = $2
     AND o.is_deleted = false
     AND o.deleted_at IS NULL
     -- created_at_ghl ONLY, and a deal without one CANNOT match.
     --
     -- imported_at is when our sync first saw the deal. For anything
     -- backfilled that is months after it was created, so using it here
     -- would say "this deal did not exist yet" for messages that predate
     -- the import but postdate the real creation — silently unlinking them.
     --
     -- A NULL created_at_ghl therefore excludes the deal rather than
     -- guessing. Excluding leaves the message on the contact for a human to
     -- file; guessing files it against a deal that may be wrong.
     AND o.created_at_ghl IS NOT NULL
     AND o.created_at_ghl <= $3
     AND (
           o.status = 'open'
           OR LEAST(
                COALESCE(o.won_at,       'infinity'::timestamptz),
                COALESCE(o.lost_at,      'infinity'::timestamptz),
                COALESCE(o.abandoned_at, 'infinity'::timestamptz)
              ) > $3
         )
   ORDER BY o.created_at_ghl ASC, o.opportunity_id ASC`;

async function locations() {
  const { rows } = await rawQuery(
    `SELECT location_id FROM installs
      WHERE uninstalled_at IS NULL
        ${onlyLocation ? 'AND location_id = $1' : ''}
      ORDER BY location_id`,
    onlyLocation ? [onlyLocation] : []
  );
  return rows.map((r) => r.location_id);
}

async function applyMapping(locationId, messageId, oppId, matchCount) {
  await rawQuery(
    `UPDATE message_opportunity_map
        SET superseded_at = now()
      WHERE location_id = $1 AND message_id = $2 AND superseded_at IS NULL`,
    [locationId, messageId]
  );
  await rawQuery(
    `INSERT INTO message_opportunity_map
       (location_id, message_id, opportunity_id, mapping_status,
        rule, rule_version, confidence, reviewed_by, reviewed_at, review_note)
     VALUES ($1,$2,$3,$4,$5,$6,$7,'system',now(),$8)`,
    [
      locationId, messageId, oppId,
      oppId ? 'mapped' : 'unassigned',
      oppId ? 'open_at_message_date' : 'no_open_opp_at_message_date',
      RULE_VERSION,
      oppId ? 0.95 : null,
      `backfill: ${matchCount} deal(s) open at the message date`
    ]
  );
  // Mirror onto the message row, which is what most reads use.
  await rawQuery(
    `UPDATE messages SET opportunity_id = $3
      WHERE location_id = $1 AND message_id = $2`,
    [locationId, messageId, oppId]
  );
}

async function run() {
  const locs = await locations();
  if (!locs.length) {
    console.log('No active installs.');
    return;
  }

  const grand = { seen: 0, linked: 0, unlinked: 0, unchanged: 0, skippedManual: 0, changed: 0 };

  for (const locationId of locs) {
    const { rows } = await rawQuery(CANDIDATES_SQL, [locationId]);
    console.log(`\n${locationId}: ${rows.length} messages to consider`);

    const tally = { linked: 0, unlinked: 0, unchanged: 0, changed: 0, multi: 0 };

    for (const m of rows) {
      grand.seen += 1;
      const { rows: open } = await rawQuery(
        OPEN_AT_SQL, [locationId, m.contact_id, m.message_timestamp]
      );
      // Earliest-created wins — the query is already ordered.
      const chosen = open[0]?.opportunity_id || null;
      if (open.length > 1) tally.multi += 1;

      const same = (chosen || null) === (m.current_opp || null);
      if (same) { tally.unchanged += 1; grand.unchanged += 1; continue; }

      tally.changed += 1;
      grand.changed += 1;
      if (chosen) { tally.linked += 1; grand.linked += 1; }
      else { tally.unlinked += 1; grand.unlinked += 1; }

      if (!dryRun) {
        try {
          await applyMapping(locationId, m.message_id, chosen, open.length);
        } catch (err) {
          // Never abort the whole run for one message.
          logger.warn({ err, locationId, messageId: m.message_id }, 'backfill: could not remap');
        }
      }
    }

    console.log(
      `  changed ${tally.changed} (${tally.linked} newly linked, ${tally.unlinked} unlinked), `
      + `${tally.unchanged} already correct, ${tally.multi} had 2+ deals open at the time`
    );
  }

  console.log('\n──────────────────────────────────────────');
  console.log(`  considered      ${grand.seen}`);
  console.log(`  already correct ${grand.unchanged}`);
  console.log(`  changed         ${grand.changed}`);
  console.log(`    → linked      ${grand.linked}`);
  console.log(`    → unlinked    ${grand.unlinked}`);
  console.log(dryRun ? '\nDRY RUN — nothing was written.' : '\nApplied.');
  console.log('Manual mappings were excluded by the candidate query and are untouched.');
}

run()
  .then(() => process.exit(0))
  .catch((err) => { logger.error({ err }, 'backfillMessageAttribution failed'); process.exit(1); });
