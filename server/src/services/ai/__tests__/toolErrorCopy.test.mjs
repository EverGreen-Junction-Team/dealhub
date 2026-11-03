// What a failed tool says to the MODEL.
//
// runTool used to return `${name} failed: ${err.message}`, so a Postgres check
// violation reached the model verbatim. The model relayed it faithfully and a
// rep was told, in a sales tool, about a "database constraint issue" and to
// contact whoever administers the integration.
//
// Two things must hold: our schema must never appear in text bound for a chat,
// and the model must be told whether retrying could help — otherwise it invents
// workarounds for faults no rewording can fix.
//
// The functions live inside registry.js (not exported — they are an
// implementation detail of runTool), so the classifier is mirrored here and a
// separate assertion pins the copy in the real source.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const registrySrc = readFileSync(
  join(here, '..', 'tools', 'registry.js'), 'utf8'
);

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

function errorKind(err) {
  const code = err?.code;
  if (typeof code === 'string' && code.startsWith('23')) return 'schema';
  if (code === '42P01' || code === '42703') return 'schema';
  if (code === '57014') return 'timeout';
  if (err?.status === 403 || err?.status === 401) return 'permission';
  if (err?.status >= 400 && err?.status < 500) return 'input';
  return 'unknown';
}

// The exact error from the report.
const checkViolation = Object.assign(
  new Error('new row for relation "ai_actions" violates check constraint "ai_actions_action_type_check"'),
  { code: '23514' }
);

t('a check violation classifies as schema', errorKind(checkViolation) === 'schema');
t('a not-null violation classifies as schema',
  errorKind(Object.assign(new Error('null value'), { code: '23502' })) === 'schema');
t('a foreign-key violation classifies as schema',
  errorKind(Object.assign(new Error('fk'), { code: '23503' })) === 'schema');
t('a missing column classifies as schema',
  errorKind(Object.assign(new Error('no column'), { code: '42703' })) === 'schema');
t('a cancelled statement classifies as timeout',
  errorKind(Object.assign(new Error('cancelled'), { code: '57014' })) === 'timeout');
t('a 403 classifies as permission',
  errorKind(Object.assign(new Error('forbidden'), { status: 403 })) === 'permission');
t('a 400 classifies as input',
  errorKind(Object.assign(new Error('bad'), { status: 400 })) === 'input');
t('an unknown error classifies as unknown', errorKind(new Error('boom')) === 'unknown');
t('a 500 is unknown, not input',
  errorKind(Object.assign(new Error('server'), { status: 500 })) === 'unknown');

// The copy itself, asserted against the real source.
const schemaCopy = registrySrc.match(/case 'schema':[\s\S]*?return ([\s\S]*?);\n/)?.[1] || '';
t('schema copy does not name a table', !/ai_actions|relation "/.test(schemaCopy));
t('schema copy does not say "constraint"', !/constraint/i.test(schemaCopy));
t('schema copy does not say "database"', !/database/i.test(schemaCopy));
t('schema copy tells the model not to retry', /[Dd]o not retry/.test(schemaCopy));
t('schema copy tells the model not to reword', /different wording/.test(schemaCopy));
t('schema copy offers the rep a real next step', /directly in the CRM/.test(schemaCopy));

const permCopy = registrySrc.match(/case 'permission':[\s\S]*?return ([\s\S]*?);\n/)?.[1] || '';
t('permission copy says retrying will not help', /will not help/.test(permCopy));

// Only the input case should echo the underlying message — it is the one kind
// the model can actually act on.
const inputCopy = registrySrc.match(/case 'input':[\s\S]*?return ([\s\S]*?);\n/)?.[1] || '';
t('input copy passes the real detail through', /err\.message/.test(inputCopy));
t('schema copy does NOT pass err.message through', !/err\.message/.test(schemaCopy));

// The raw fault must still reach engineers.
t('the raw error is logged', /logger\[/.test(registrySrc) && /'ai tool failed'/.test(registrySrc));
t('runTool no longer interpolates err.message into the model-facing error',
  !/return \{ error: `\$\{name\} failed: \$\{err\.message\}` \}/.test(registrySrc));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL: ${f}`); process.exit(1); }
