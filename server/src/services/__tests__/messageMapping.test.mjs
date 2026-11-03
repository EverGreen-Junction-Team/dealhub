// Three bugs from the message-attribution work, each of which failed silently.
// See docs/MESSAGE-DEAL-LINKING-RULE.md.
//
// 1. The timeline filtered `mapping_status = 'mapped'`, which EXCLUDES
//    'manually_resolved'. A manager moved a message and it disappeared from
//    both deals — the move worked, the message vanished.
//
// 2. The manual-move routes read `req.userId`. The auth middleware sets
//    `req.session` and `req.locationId`, never `req.userId`, so every move
//    was recorded as reviewed_by='unknown' and the audit trail was lost.
//    Nothing errored: the write succeeded with the wrong value.
//
// 3. Two imports were missing (htmlToText, MessageDealPill). `vite build`
//    passed both; only eslint's no-undef caught them.
//
// Asserted against the SOURCE — all three are about what the code says, not
// what a function returns, so no unit test of any single function sees them.

import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const server = (f) => readFileSync(join(here, '../..', f), 'utf8');

// The dashboard is a SEPARATE repository. Its checks are skipped when it is
// not checked out beside this one, rather than failing — a server-only clone
// is a legitimate setup and should not see a red suite for a missing sibling.
const DASH = join(here, '../../../../../pipelinePulse-dashboard/src');
const dashPresent = existsSync(DASH);
const dash = (f) => readFileSync(join(DASH, f), 'utf8');

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

// ── 1. Manual moves must stay visible ────────────────────────────────
const deals = server('routes/deals.js');

t('no query filters on mapped alone',
  // The exact string that hid every manual move.
  !deals.includes("mapping_status = 'mapped'"));

t('every mapping filter admits manually_resolved',
  (deals.match(/mom\.mapping_status IN \('mapped', 'manually_resolved'\)/g) || []).length === 3);

t('the timeline reports HOW a message was filed',
  // Without this the pill cannot distinguish a human decision from the
  // engine's, and they read identically.
  deals.includes('mappedManually: m.mapping_status === ') );

// ── 2. The reviewer must be recorded ─────────────────────────────────
for (const f of ['routes/deals.js', 'routes/contacts.js']) {
  const src = server(f);
  if (!src.includes('reviewedBy:')) continue;
  t(`${f} reads the reviewer from req.session`,
    /reviewedBy: req\.session\?\.userId/.test(src));
  t(`${f} does not read a bare req.userId`,
    // Comments explaining the bug are fine; an expression is not.
    !/reviewedBy: req\.userId/.test(src));
}

t('the auth middleware really does set session, not userId',
  // The assertion above is only meaningful if this stays true. If auth ever
  // starts setting req.userId, revisit rather than assume.
  server('routes/auth.js').includes('req.session = claims')
  && !server('routes/auth.js').includes('req.userId ='));

// ── 3. Imports the build would not catch ─────────────────────────────
if (!dashPresent) {
  console.log('  (dashboard repo not checked out — skipping its 3 import checks)');
} else {
  t('ContactDetail imports htmlToText',
    /import \{ htmlToText \}/.test(dash('pages/contacts/ContactDetail.jsx')));

  t('Timeline imports MessageDealPill',
    /import MessageDealPill from/.test(dash('pages/dealhub/Timeline.jsx')));

  t('every identifier used in the pill is imported',
    (() => {
      const src = dash('pages/dealhub/MessageDealPill.jsx');
      return /import \{ createPortal \}/.test(src)
        && /import \{ dealsAPI \}/.test(src)
        && /useEffect|useRef|useState/.test(src.split('\n')[0]);
    })());
}

// ── The rule itself ──────────────────────────────────────────────────
const engine = server('services/attributionEngine.js');

t('and no longer bails out when there are two',
  // `rows.length !== 1` was the line that made two open deals unresolvable.
  !/if \(rows\.length !== 1\) return null;[\s\S]{0,200}earliest_open_opp/.test(engine));

// ── Ordering uses the DEAL's date, not ours ─────────────────────────
//
// imported_at is when our sync first saw a deal. Measured on live data the
// gap to created_at_ghl reaches 84 days (averaging 4.7). Using it as a
// fallback let a recently-imported old deal look newest — wrong for "earliest
// open" — and in the backfill made a deal invisible to messages that predate
// the import but postdate its real creation.
t('the live rule orders by created_at_ghl alone',
  /ORDER BY created_at_ghl ASC NULLS LAST, opportunity_id ASC/.test(engine));

t('and never falls back to imported_at',
  !/COALESCE\(created_at_ghl, imported_at\)/.test(engine));

t('a dateless deal sorts last rather than first',
  // Postgres puts NULLs FIRST on DESC and LAST on ASC only when told; an
  // unqualified ASC here would be fine, but stating it stops a later edit
  // silently reversing it.
  /NULLS LAST/.test(engine));

const backfill = server('scripts/backfillMessageAttribution.js');

t('the backfill matches on created_at_ghl only',
  /AND o\.created_at_ghl IS NOT NULL\s*\n\s*AND o\.created_at_ghl <= \$3/.test(backfill));

t('and excludes a dateless deal rather than guessing its age',
  // Excluding leaves the message on the contact for a human; guessing files
  // it against a deal that may be wrong.
  /o\.created_at_ghl IS NOT NULL/.test(backfill));

t('the backfill never uses imported_at either',
  !/COALESCE\(o\.created_at_ghl, o\.imported_at\)/.test(backfill));

// ── Only rule 1 can link ─────────────────────────────────────────────
//
// stage_containment matched on a stage WINDOW and never checked status. A
// deal marked lost keeps left_at NULL — still "in" its last stage — so a
// message sent after the loss linked to it at 0.90 confidence. Found in live
// testing.
t('the rule chain is rule 1 then terminal, nothing else',
  /ruleSingleOpenOpp\(locationId, oppIds\)\) \|\|\s*\n\s*\(await terminalClassification/.test(engine));

t('stage_containment is gone, not merely unused',
  // Left in place it looks like a rule and invites re-wiring — which is the
  // bug it caused.
  !/ruleStageContainment/.test(engine));

t('so are the other two status-blind fallbacks',
  !/ruleOnlyActiveAtTime/.test(engine) && !/ruleSingleLifetimeOpp/.test(engine));

t('a manual mapping is never overwritten by a re-run',
  /hasManualMapping/.test(engine)
  && /if \(await hasManualMapping\(locationId, messageId\)\)/.test(engine));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
