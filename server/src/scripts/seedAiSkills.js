#!/usr/bin/env node
//
// seedAiSkills.js — register the analytics skills in one or more sub-accounts,
// from the definitions in data/skills/.
//
// WHY THIS EXISTS. A skill row is per sub-account (ai_skills is UNIQUE
// (location_id, name)), and the Control panel registers them one at a time.
// With 32 skills and several accounts that is hundreds of form submissions,
// each one a chance to mistype a view name or paste the wrong description.
// The definitions already exist as files, reviewed alongside the migrations
// that create their views, so this registers them from the same source.
//
// WHAT IT DOES, per location:
//   1. Reads data/skills/registry.json for the list of skills.
//   2. Loads each skill's definition file.
//   3. Skips any skill this location already has, by name.
//   4. Creates the rest via createSkill(), which runs the SAME validation the
//      Control panel does — the view must exist, carry security_invoker, have
//      a location_id column, and every param must name a real column.
//
// IDEMPOTENT. Run it twice and the second run creates nothing. That is the
// point: it is safe to re-run after adding a skill, and it will register only
// what is new.
//
// --update-existing REWRITES skills that already exist, from the files.
//
// A skill's description is what the MODEL reads to decide whether to use it,
// and it lives in the ai_skills row — so improving the wording in a file
// changes nothing until the row is rewritten. That bit immediately: two
// descriptions were fixed after an eval showed the model picking a
// neighbouring skill, the files were deployed, and the eval would still have
// failed, because `created 0 skipped 43` means exactly that nothing was
// rewritten.
//
// Off by default. A seed run that silently overwrote hand-edits made in the
// Control panel would be a bad surprise, so rewriting is something you ask
// for.
//
// WHY createSkill() RATHER THAN A DIRECT INSERT. An INSERT would be shorter
// and would skip validateSkillView(), which is the one thing standing between
// a typo and a skill that returns another client's data. A view missing
// security_invoker runs as its owner and ignores row-level security (042
// exists because that was missed once). This script must not be the way that
// check gets bypassed.
//
// Usage:
//   node src/scripts/seedAiSkills.js <location_id> [<location_id> ...]
//   node src/scripts/seedAiSkills.js <loc_a> <loc_b> --dry-run
//   node src/scripts/seedAiSkills.js <loc_a> --only rep_stage_conversion,note_adoption
//   node src/scripts/seedAiSkills.js <loc_a> <loc_b> --update-existing
//
// --dry-run reports what would be created and changes nothing. Run it first.

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSkill, updateSkill, listSkills } from '../services/ai/skillStore.js';
import { withTenant } from '../db.js';
import { SkillValidationError } from '../services/ai/skillValidator.js';
import { logger } from '../utils/logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SKILLS_DIR = path.resolve(__dirname, '../../data/skills');
const REGISTRY = path.join(SKILLS_DIR, 'registry.json');

function loadDefinitions(only) {
  const registry = JSON.parse(readFileSync(REGISTRY, 'utf8'));
  const wanted = only ? new Set(only.split(',').map((s) => s.trim()).filter(Boolean)) : null;

  const defs = [];
  for (const row of registry.skills) {
    if (wanted && !wanted.has(row.skill)) continue;
    // registry.json stores the path relative to the server root.
    const file = path.resolve(__dirname, '../..', row.file);
    const def = JSON.parse(readFileSync(file, 'utf8'));

    // The registry and the definition file each name the skill and its view.
    // If they disagree, one of them was edited without the other and there is
    // no safe way to guess which is right.
    if (def.name !== row.skill) {
      throw new Error(
        `registry.json says "${row.skill}" but ${row.file} defines "${def.name}". `
        + 'Fix one of them before seeding.'
      );
    }
    if (def.viewName !== row.view) {
      throw new Error(
        `registry.json maps "${row.skill}" to view "${row.view}" but ${row.file} `
        + `says "${def.viewName}". Fix one of them before seeding.`
      );
    }
    defs.push({ ...def, title: row.title, requires: row.requires || null });
  }

  if (wanted) {
    const found = new Set(defs.map((d) => d.name));
    const missing = [...wanted].filter((n) => !found.has(n));
    if (missing.length) {
      throw new Error(`--only named skills not in registry.json: ${missing.join(', ')}`);
    }
  }
  return defs;
}

// WHAT A LOCATION ACTUALLY HAS.
//
// Some skills only make sense with data the account may not hold. The paid
// ones read Google click ids and UTM campaigns: an account that runs no ads
// has none, so those skills return empty for every question — and an empty
// result is not harmless. It costs ~900 tokens of description on EVERY
// question, and it gives the model three extra near-neighbours to choose
// wrongly between when someone asks about lead sources.
//
// Checked against the data rather than a hardcoded list of which brands
// advertise: a list goes stale the first time someone turns ads on, and it
// goes stale silently.
const PROBES = {
  paid: `SELECT EXISTS (
           SELECT 1 FROM opportunities o
            WHERE o.location_id = $1
              AND o.deleted_at IS NULL
              AND (NULLIF(btrim(o.gclid), '') IS NOT NULL
                   OR EXISTS (
                     SELECT 1 FROM contacts c
                      WHERE c.location_id = o.location_id
                        AND c.contact_id  = o.contact_id
                        AND (NULLIF(btrim(c.gclid), '') IS NOT NULL
                             OR NULLIF(btrim(c.utm_campaign), '') IS NOT NULL)))
            LIMIT 1
         ) AS has_it`
};

async function capabilitiesOf(locationId) {
  const caps = new Set();
  for (const [name, sql] of Object.entries(PROBES)) {
    try {
      const has = await withTenant(locationId, async (client) => {
        const { rows } = await client.query(sql, [locationId]);
        return rows[0]?.has_it === true;
      });
      if (has) caps.add(name);
    } catch (err) {
      // A probe that cannot run must not silently withhold skills — the safe
      // failure is to OFFER the skill and let it return empty, not to decide
      // an account lacks data because a query errored.
      logger.warn({ locationId, probe: name, err }, 'seedAiSkills: probe failed — offering the skill anyway');
      caps.add(name);
    }
  }
  return caps;
}

async function seedLocation(locationId, defs, { dryRun, all = false, updateExisting = false }) {
  // One read per location rather than one per skill.
  const existing = await listSkills(locationId);
  const have = new Set(existing.map((s) => s.name));

  // Skills whose data this account does not have are not registered, unless
  // --all says otherwise. They would answer every question with an empty
  // result while costing description tokens on all of them.
  const caps = all ? null : await capabilitiesOf(locationId);
  const notApplicable = all ? [] : defs.filter((d) => d.requires && !caps.has(d.requires));
  const applicable = defs.filter((d) => all || !d.requires || caps.has(d.requires));

  const toCreate = applicable.filter((d) => !have.has(d.name));
  // Rewritten from the file, when asked. Only where something actually
  // DIFFERS — reporting "updated 43" when nothing changed would make a real
  // change invisible in the noise.
  const byName = new Map(existing.map((s) => [s.name, s]));
  // Key order is not a difference. params is JSONB, and Postgres stores an
  // object's keys in its own order — so a straight JSON.stringify comparison
  // reported every skill as changed (36 of 40 on the first run) and buried the
  // one that actually had.
  const stable = (v) => JSON.stringify(v, (_k, val) =>
    (val && typeof val === 'object' && !Array.isArray(val)
      ? Object.fromEntries(Object.keys(val).sort().map((k) => [k, val[k]]))
      : val));

  const toUpdate = updateExisting
    ? applicable.filter((d) => {
      const row = byName.get(d.name);
      if (!row) return false;
      return row.description !== d.description
        || row.viewName !== d.viewName
        || stable(row.params || []) !== stable(d.params || [])
        || (row.orderBy || null) !== (d.orderBy || null)
        || (row.rowLimit ?? 50) !== (d.rowLimit ?? 50);
    })
    : [];
  const updateNames = new Set(toUpdate.map((d) => d.name));
  const skipped = applicable.length - toCreate.length - toUpdate.length;

  const result = {
    locationId, created: 0, updated: 0, skipped, failed: 0, failures: [],
    notApplicable: notApplicable.map((d) => d.name)
  };

  for (const def of toUpdate) {
    const row = byName.get(def.name);
    if (dryRun) {
      logger.info({ locationId, skill: def.name }, 'would update');
      result.updated += 1;
      continue;
    }
    try {
      await updateSkill(locationId, row.id, def, 'seedAiSkills');
      logger.info({ locationId, skill: def.name }, 'updated');
      result.updated += 1;
    } catch (err) {
      result.failed += 1;
      result.failures.push({ skill: def.name, reason: err.message });
      logger.error({ locationId, skill: def.name, err }, 'skill update failed');
    }
  }

  for (const def of toCreate) {
    if (dryRun) {
      logger.info({ locationId, skill: def.name, view: def.viewName }, 'would create');
      result.created += 1;
      continue;
    }
    try {
      await createSkill(locationId, def, 'seedAiSkills');
      logger.info({ locationId, skill: def.name, view: def.viewName }, 'created');
      result.created += 1;
    } catch (err) {
      // A validation failure is worth naming loudly and carrying on: one bad
      // definition should not stop the other 31 from registering, and the
      // message says exactly which field is wrong.
      result.failed += 1;
      result.failures.push({ skill: def.name, reason: err.message });
      if (err instanceof SkillValidationError) {
        logger.error({ locationId, skill: def.name, field: err.field, err },
          'skill rejected by validation');
      } else {
        logger.error({ locationId, skill: def.name, err }, 'skill failed');
      }
    }
  }
  return result;
}

async function main() {
  const argv = process.argv.slice(2);
  const dryRun = argv.includes('--dry-run');
  // Register everything regardless of whether the account has the data. For
  // an account about to start running ads, where the skill should exist
  // before the first click arrives.
  const all = argv.includes('--all');
  // Rewrite rows that already exist, from the files. See the header.
  const updateExisting = argv.includes('--update-existing');

  const onlyIdx = argv.indexOf('--only');
  const only = onlyIdx !== -1 ? argv[onlyIdx + 1] : null;
  if (onlyIdx !== -1 && !only) throw new Error('--only needs a comma-separated list of skill names');

  // Walk the args rather than filtering by index: a filter that only skips
  // `onlyIdx + 1` drops the wrong element as soon as --only appears before a
  // location, which silently seeded one account instead of two.
  const locations = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (a === '--only') { i += 1; continue; }   // skip the flag and its value
    if (a.startsWith('--')) continue;
    locations.push(a);
  }

  const dupes = locations.filter((l, i) => locations.indexOf(l) !== i);
  if (dupes.length) {
    throw new Error(`Location listed more than once: ${[...new Set(dupes)].join(', ')}`);
  }

  if (!locations.length) {
    console.error(
      'Usage: node src/scripts/seedAiSkills.js <location_id> [<location_id> ...] '
      + '[--only a,b] [--dry-run]'
    );
    process.exit(1);
  }

  const defs = loadDefinitions(only);
  logger.info({ skills: defs.length, locations: locations.length, dryRun }, 'seedAiSkills: start');

  const results = [];
  for (const locationId of locations) {
    results.push(await seedLocation(locationId, defs, { dryRun, all, updateExisting }));
  }

  console.log('');
  for (const r of results) {
    console.log(
      `${r.locationId}  created ${r.created}`
      + (r.updated ? `  updated ${r.updated}` : '')
      + `  skipped ${r.skipped}  failed ${r.failed}`
      + (r.notApplicable.length ? `  n/a ${r.notApplicable.length}` : '')
      + (dryRun ? '   (dry run — nothing written)' : '')
    );
    if (r.notApplicable.length) {
      console.log(`    no data for: ${r.notApplicable.join(', ')}`);
    }
    for (const f of r.failures) console.log(`    ${f.skill}: ${f.reason}`);
  }

  const failed = results.reduce((n, r) => n + r.failed, 0);
  // Non-zero exit on any failure, so a deploy step notices.
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  logger.error({ err }, 'seedAiSkills: fatal');
  console.error(err.message);
  process.exit(1);
});
