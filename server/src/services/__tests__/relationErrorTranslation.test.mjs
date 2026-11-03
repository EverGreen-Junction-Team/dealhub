// createRelation/deleteRelation/removeDealContact (ghlAssociations.js) only
// translated ONE specific GHL rejection — the OAuth-channel-block 400 (see
// oauthChannelBlock.test.mjs). translateOAuthChannelBlock's own docstring
// says as much: "Returns the original error untouched when it is anything
// else." Every OTHER kind of rejection — already linked, a missing scope, a
// 404, a genuine 5xx — fell straight through as the raw axios error, which
// is neither an AssociationError nor an OpportunityWriteError.
// routes/deals.js's sendDealError only translates those two types, so any
// other GHL rejection on "attach a contact to this deal" reached the client
// as a bare 500 internal_error with no field and no explanation — reported
// live: adding a second contact to a deal failed this way.
//
// translateRelationError is the general-purpose fallback that now runs
// whenever translateOAuthChannelBlock declines to translate something.

process.env.DATABASE_URL ||= 'postgres://stub/stub';
process.env.GHL_CLIENT_ID ||= 'stub';
process.env.GHL_CLIENT_SECRET ||= 'stub';
process.env.GHL_REDIRECT_URI ||= 'https://stub.invalid/cb';
process.env.SESSION_JWT_SECRET ||= 'stub-secret-value-long-enough-for-config';

const { translateRelationError, AssociationError } = await import('../ghlAssociations.js');

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

const ghl = (status, message) => ({
  response: { status, data: { message, error: 'Bad Request', statusCode: status } }
});

// ── The bug this fixes ───────────────────────────────────────────────
const alreadyLinked = ghl(400, 'Contact is already associated with this opportunity');
const out = translateRelationError(alreadyLinked, 'This contact');

t('it is translated, not passed through', out !== alreadyLinked);
t('into an AssociationError the routes already handle', out instanceof AssociationError);
t('never a 5xx status — that logs as a crash, not a refusal',
  out.status < 500);

// ── Status mapping ───────────────────────────────────────────────────
t('401 reads as a reauth problem, not a generic failure',
  translateRelationError(ghl(401, 'Unauthorized'), 'x').status === 403);
t('403 reads the same way as 401 here',
  translateRelationError(ghl(403, 'Forbidden'), 'x').status === 403);
t('404 says the record is gone, not "internal error"',
  translateRelationError(ghl(404, 'Not found'), 'x').status === 404);
t('a 400 with "already" in the message reads as a conflict (409), not a validation failure',
  translateRelationError(ghl(400, 'already associated'), 'x').status === 409);
t('a 422 with no "already" wording is a plain validation rejection',
  translateRelationError(ghl(422, 'Invalid recordId'), 'x').status === 422);
t('an unrecognised status still degrades to a safe AssociationError, never throws itself',
  translateRelationError(ghl(500, 'Something else'), 'x') instanceof AssociationError);
t('a network-level failure with no response at all is still handled, not re-thrown raw',
  translateRelationError(new Error('socket hang up'), 'x') instanceof AssociationError);

// ── The `what` argument reaches the message ─────────────────────────
t('the caller-supplied description is in the message somewhere',
  translateRelationError(ghl(404, 'x'), 'The deal on a task').message.includes('The deal on a task'));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
