// GHL blocks task relation WRITES on the OAuth channel entirely.
//
// Confirmed at source level (their tasks.service.ts), not guessed from an
// error string:
//
//   const isOAuthChannel = request.channel === Channel.OAUTH
//   if (isOAuthChannel && 'relations' in body) {
//     throw new BadRequestException('Relations cannot be modified via OAuth channel')
//   }
//
// The check is in the TASK SERVICE, so every route into it is closed:
// POST /associations/relations (it calls tasksService.update internally),
// /associations/relations/bulk, PUT /locations/:id/tasks/:id with relations,
// and create-with-relations. No scope, version or retry changes this.
//
// Left untranslated the 400 reached the client as a 500 `internal_error`,
// which reads as a bug in this app and sends whoever is debugging it looking
// for one that does not exist.

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.invalid/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough-for-config';

const { translateOAuthChannelBlock, AssociationError } =
  await import('../associationConstants.js');

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

const ghl = (status, message) => ({
  response: { status, data: { message, error: 'Bad Request', statusCode: status } }
});

// ── The exact production error ───────────────────────────────────────
const real = ghl(400, 'Relations cannot be modified via OAuth channel');
const out = translateOAuthChannelBlock(real, 'The deal on a task');

t('it is translated, not passed through', out !== real);
t('into an AssociationError the routes already handle', out instanceof AssociationError);
t('reason is machine-readable', out.reason === 'oauth_channel_blocked');

t('status is 409, and NOT any 5xx',
  // Any 5xx makes pino-http attach a synthetic stack and log the line as a
  // request failure — not configurable, it keys off statusCode >= 500. A
  // deliberate refusal would then read as a crash, which is the confusion
  // this translation exists to remove. 409 is what the app already returns
  // for "the request is fine, the state will not permit it".
  out.status === 409 && out.status < 500);

t('the message names what could not change', /deal on a task/i.test(out.message));

t('and does NOT suggest a fix that does not exist',
  // No scope, reconnect or retry resolves this — saying otherwise sends the
  // reader after a configuration problem that is not there.
  !/try again|reconnect|re-?auth|permission|scope/i.test(out.message));

// ── Everything else must pass through untouched ──────────────────────
//
// This runs on the deal↔contact path too, which is NOT blocked (a real Mongo
// relation, no tasksService). Over-matching would break a working feature.
for (const [label, err] of [
  ['a different 400', ghl(400, 'Invalid recordId')],
  ['the association cap', ghl(400, 'Maximum of 25 associations allowed')],
  ['a 401 scope error', ghl(401, 'The token is not authorized for this scope.')],
  ['a 404', ghl(404, 'Not found')],
  ['a 500 from GHL', ghl(500, 'Internal server error')],
  ['a network error with no response', new Error('socket hang up')],
  ['null', null],
]) {
  t(`${label} is returned unchanged`, translateOAuthChannelBlock(err, 'x') === err);
}

t('a 400 mentioning OAuth in another context is not swallowed',
  // Matching on "OAuth" alone would catch unrelated errors.
  translateOAuthChannelBlock(ghl(400, 'OAuth token malformed'), 'x').status === undefined
  || !(translateOAuthChannelBlock(ghl(400, 'OAuth token malformed'), 'x') instanceof AssociationError));

// ── The finding must stay recorded next to the code ──────────────────
const { readFileSync } = await import('node:fs');
const { fileURLToPath } = await import('node:url');
const { dirname, join } = await import('node:path');
const here = dirname(fileURLToPath(import.meta.url));
const assoc = readFileSync(join(here, '../ghlAssociations.js'), 'utf8');

t('ghlAssociations records that task relations are unwritable over OAuth',
  /TASK RELATIONS ARE NOT WRITABLE OVER OAUTH/.test(assoc));

t('it names the read path that DOES work',
  /GET \/locations\/:locationId\/tasks\/:taskId/.test(assoc));

t('it keeps notes separate from tasks',
  // Notes have a purpose-built endpoint that is NOT subject to this check —
  // they fail only for want of notes.write, which is fixable. Collapsing the
  // two would lose that.
  /NOTES ARE DIFFERENT/.test(assoc));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
