// Every sync that records a run must actually be SCHEDULED.
//
// tasksSync was missing from the daily cron for months. Nothing failed and
// nothing logged: task webhooks kept the data current, so the only symptom was
// a reconciliation sweep that never ran. It surfaced when a client asked why
// the sync history looked thin — 5 runs, all manual, the last a week old,
// against 30 for every other job.
//
// This asserts the cron block and the set of sync services agree, so the next
// service added is either scheduled or DELIBERATELY excluded with a reason.

import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const servicesDir = join(here, '..');
const sweep = readFileSync(join(servicesDir, 'orphanSweep.js'), 'utf8');

// The cron callback only — not the whole file, or an import would count as
// "scheduled" and the original bug would still pass.
const cronStart = sweep.indexOf('cron.schedule(config.orphanSweepCron');
const cronBlock = sweep.slice(cronStart, sweep.indexOf('\n  });', cronStart));

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

t('the cron block was located', cronStart > -1 && cronBlock.length > 500);

// A line is only scheduled if it is an uncommented `await`.
const scheduled = new Set(
  cronBlock.split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .flatMap((l) => [...l.matchAll(/await\s+(\w+)\(/g)].map((m) => m[1]))
);

// Every service that logs a run is a sync that should be on a schedule.
const syncFiles = readdirSync(servicesDir)
  .filter((f) => f.endsWith('Sync.js'))
  .filter((f) => readFileSync(join(servicesDir, f), 'utf8').includes('recordSyncRun'));

t('found the sync services', syncFiles.length >= 8);

// name -> the all-installs entry point it exposes.
const ENTRY = {
  'tagsSync.js': 'syncTagsForAllInstalls',
  'customFieldsSync.js': 'syncCustomFieldsForAllInstalls',
  'pipelinesSync.js': 'syncPipelinesForAllInstalls',
  // Scheduled: users reach the DB by webhook (which does not carry `roles`,
  // so user_type depends on an enrichment fetch) and by a one-off backfill
  // script. Neither keeps a user who was already there current, and a row
  // with user_type NULL shows in the owner dropdown — which is where an
  // agency user quietly reappears.
  'usersSync.js': 'syncUsersForAllInstalls',
  'businessesSync.js': 'syncBusinessesForAllInstalls',
  'contactsSync.js': 'syncContactsForAllInstalls',
  'opportunitiesSync.js': 'syncOpportunitiesForAllInstalls',
  // DELIBERATELY UNSCHEDULED — removed at the client's request on
  // 2026-09-11. Messages arrive by webhook only; attribution is decided once,
  // when the message lands. Listed here so the exclusion is a recorded
  // decision rather than something that fell out of the cron unnoticed.
  //
  // The cost is real and documented in orphanSweep.js: this was the pass
  // that caught webhooks GHL never delivered.
  'messagesSync.js': null,
  'conversationProvidersSync.js': 'syncConversationProvidersAllInstalls',
  'tasksSync.js': 'syncAllTasks',
  // DELIBERATELY UNSCHEDULED — paused at the client's request on 2026-08-15.
  // Listed so the exclusion is a recorded decision, not an oversight.
  'callRecordingSync.js': null
};

for (const f of syncFiles) {
  if (!(f in ENTRY)) {
    failures.push(`${f} is a sync service this test does not know about — schedule it or record why not`);
    continue;
  }
  const entry = ENTRY[f];
  if (entry === null) {
    // Assert the specific entry point is absent, not just some other one —
    // the original check hardcoded callRecordingSync's, so a second opt-out
    // would have passed without being verified at all.
    const ENTRY_OF = {
      'callRecordingSync.js': 'syncCallMediaForAllInstalls',
      'messagesSync.js': 'syncMessagesForAllInstalls'
    };
    t(`${f} is deliberately unscheduled`, !scheduled.has(ENTRY_OF[f]));
    continue;
  }
  t(`${f} runs on the daily cron`, scheduled.has(entry));
}

// The one that regressed.
t('tasksSync specifically is scheduled', scheduled.has('syncAllTasks'));

t('tasksSync runs AFTER opportunitiesSync',
  // A task is attributed to a deal, so the deals must be current first.
  cronBlock.indexOf('syncAllTasks') > cronBlock.indexOf('syncOpportunitiesForAllInstalls'));

t('every scheduled call is wrapped in its own try/catch',
  // One failing sync must not abort the rest of the night's run.
  //
  // Counted against the AWAITS, not `scheduled.size`: that is a Set and had
  // already de-duplicated, so the comparison failed on correct code.
  (() => {
    const lines = cronBlock.split('\n').filter((l) => !l.trim().startsWith('//'));
    const awaits = lines.filter((l) => /await\s+\w+\(/.test(l));
    const wrapped = lines.filter((l) => /try \{ await\s+\w+\(/.test(l));
    return awaits.length > 0 && awaits.length === wrapped.length;
  })());

// The boot log is the only visible record of what runs; a stale one misleads.
const bootLog = sweep.slice(sweep.indexOf("'daily cron scheduled"));
t('the boot log mentions tasks', /\btasks\b/.test(bootLog.slice(0, 400)));
t('and still records which syncs are paused',
  // The boot log is the only visible record of what runs; a stale one sends
  // someone hunting for a sync that was switched off on purpose.
  /callRecordingSync \+ messagesSync paused/.test(bootLog.slice(0, 400)));

t('the boot log no longer claims messages sync',
  !/\+ messages sync/.test(bootLog.slice(0, 400)));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
