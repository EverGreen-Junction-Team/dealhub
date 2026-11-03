// Provider catalogue sync: parsing and pruning.
//
// The account in the report showed SIX providers across two types in a single
// response; the app stored five at most and often fewer. Three bugs stacked:
// only SMS/Email were requested, the table rejected other types, and the
// parser read one key out of a response that carried several.
//
// Pruning is the dangerous half. It soft-deletes anything not seen, so a
// parser change that widens what "seen" means can silently delete live rows.
// These tests pin both halves against the real payload shape.

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

const isNativeId = (id) => [/^twilio_provider$/, /^mailgun_provider$/, /^smtp_provider_/]
  .some((re) => re.test(id || ''));

// Mirrors fetchChannels' parsing.
function parse(channel, channelType) {
  const defaults = channel.defaults || {};
  const buckets = Object.entries(channel)
    .filter(([, v]) => Array.isArray(v))
    .flatMap(([key, arr]) => arr.map((item) => ({ key, item })));
  const seen = new Set();
  const providers = [];
  for (const { key, item } of buckets) {
    const cp = item?.conversationProvider;
    if (!cp || !cp._id) continue;
    if (seen.has(cp._id)) continue;
    seen.add(cp._id);
    const type = cp.type || key || channelType;
    providers.push({
      id: cp._id, name: cp.name || null, type,
      isDefault: cp.default === true || defaults[type] === cp._id,
      isNative: isNativeId(cp._id)
    });
  }
  return providers;
}

const wrap = (cp) => ({ conversationProvider: cp });

// The exact six from the screenshot.
const live = {
  SMS: [
    wrap({ _id: '6a22bfc4fcbd457e97784fbb', name: 'WhatsApp QR',  type: 'SMS' }),
    wrap({ _id: '6a116a692c652618ee90299c', name: 'iMessage',     type: 'SMS' }),
    wrap({ _id: '6a22cb89b8c221e8c3197bb4', name: 'SMS Android',  type: 'SMS' }),
  ],
  Call: [
    wrap({ _id: '6a95259c8038972f34214890', name: 'Android Voice',  type: 'Call' }),
    wrap({ _id: '6a956e74eac74878d52b39b3', name: 'iMessage Voice', type: 'Call' }),
    wrap({ _id: '6a951f48808db75acb4e6e38', name: 'WhatsApp Voice', type: 'Call' }),
  ],
  defaults: {},
};

const parsed = parse(live, 'SMS');
t('all six providers are parsed from one response', parsed.length === 6);
t('Call providers are not dropped when SMS was requested',
  parsed.filter((p) => p.type === 'Call').length === 3);
t('each provider keeps its OWN type, not the requested one',
  parsed.find((p) => p.name === 'Android Voice')?.type === 'Call');
t('SMS providers still parse correctly',
  parsed.filter((p) => p.type === 'SMS').length === 3);
t('no provider is stored twice',
  new Set(parsed.map((p) => p.id)).size === parsed.length);

// A provider listed under two keys must not duplicate onto the same PK.
const dup = parse({
  SMS: [wrap({ _id: 'x1', name: 'Shared', type: 'SMS' })],
  WhatsApp: [wrap({ _id: 'x1', name: 'Shared', type: 'SMS' })],
  defaults: {},
}, 'SMS');
t('a provider appearing under two keys is stored once', dup.length === 1);

// A provider with no declared type falls back to the key it came under.
const untyped = parse({ Email: [wrap({ _id: 'e1', name: 'Mailgun' })], defaults: {} }, 'Email');
t('an untyped provider inherits the key it arrived under', untyped[0].type === 'Email');

// defaults are keyed by the provider's type, not the requested channel.
const withDefault = parse({
  SMS: [wrap({ _id: 's1', name: 'Twilio', type: 'SMS' })],
  defaults: { SMS: 's1' },
}, 'SMS');
t('the default flag is resolved against the provider type', withDefault[0].isDefault === true);

t('native ids are recognised', isNativeId('twilio_provider') && isNativeId('smtp_provider_9'));
t('a Mongo ObjectId is not native', !isNativeId('6a22bfc4fcbd457e97784fbb'));

// ── The accepted channel enum ────────────────────────────────────────
// A run against four live locations 422'd every type except SMS and Email —
// including WhatsApp, which BOTH checked-in GHL definitions list as valid.
// Requesting a type the deployed API rejects costs a round trip per location
// per run and stores nothing, so the list must stay at what is measured.
import { readFileSync as _rf } from 'node:fs';
import { fileURLToPath as _furl } from 'node:url';
import { dirname as _dir, join as _join } from 'node:path';
const _here = _dir(_furl(import.meta.url));
const _syncSrc = _rf(_join(_here, '..', 'conversationProvidersSync.js'), 'utf8');
const _types = [..._syncSrc.match(/CHANNEL_TYPES = \[([\s\S]*?)\]/)[1]
  .matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]);

t('only measured-accepted channel types are requested',
  _types.length === 2 && _types.includes('SMS') && _types.includes('Email'));
t('no channel type is requested that the live API 422s',
  !['Call', 'RCS', 'TIKTOK', 'Live_Chat', 'WhatsApp', 'IG', 'FB'].some((x) => _types.includes(x)));

// ── The custom-provider search (NOT reachable) ───────────────────────
// /conversations/providers/search returns a richer list than
// conversationChannels — but a marketplace app cannot call it. Every location
// answered 401 "The token is not authorized for this scope", and the route is
// absent from GHL's public scope map, so there is no scope to request.
//
// The parser is kept and tested so that IF GHL exposes the route, wiring it
// back up is one line. The test below pins the call site as disabled, so this
// does not silently start 401-looping again.
function parseSearch(body, requestedType) {
  const arr = Array.isArray(body?.conversationProviders) ? body.conversationProviders : [];
  return arr.filter((cp) => cp && cp._id).map((cp) => ({
    id: cp._id, name: cp.name || null,
    type: cp.type || requestedType,
    isDefault: false, isNative: isNativeId(cp._id)
  }));
}

// The exact payload from the screenshot.
const searchBody = { conversationProviders: [
  { _id: '6a22bfc4fcbd457e97784fbb', name: 'WhatsApp QR',    type: 'SMS',  alias: '' },
  { _id: '6a116a692c652618ee90299c', name: 'iMessage',       type: 'SMS',  alias: '' },
  { _id: '6a22cb89b8c221e8c3197bb4', name: 'SMS Android',    type: 'SMS',  alias: '' },
  { _id: '6a95259c8038972f34214890', name: 'Android Voice',  type: 'Call' },
  { _id: '6a956e74eac74878d52b39b3', name: 'iMessage Voice', type: 'Call' },
  { _id: '6a951f48808db75acb4e6e38', name: 'WhatsApp Voice', type: 'Call' },
] };
const searched = parseSearch(searchBody, 'SMS');

t('the search returns all six providers', searched.length === 6);
t('Call-type providers arrive via the search, not the channels call',
  searched.filter((p) => p.type === 'Call').length === 3);
t('SMS Android — absent from our table before — is present',
  searched.some((p) => p.id === '6a22cb89b8c221e8c3197bb4'));
t('every searched provider has a real name (no NULL placeholders)',
  searched.every((p) => p.name));
t('searched providers are all custom, never native',
  searched.every((p) => !p.isNative));

// is_default is OR-ed on upsert. The search always reports false and runs
// SECOND, so a plain assignment would clear Twilio's default on every sync.
const orDefault = (existing, incoming) => existing || incoming;
t('a default set by the channels call survives the search overwriting it',
  orDefault(true, false) === true);
t('a provider that is not default anywhere stays false',
  orDefault(false, false) === false);
t('a newly-default provider can still become default',
  orDefault(false, true) === true);

t('the unreachable search endpoint is not called in the sync loop',
  !/await fetchCustomProviders\(/.test(_syncSrc));
t('the 401 finding is documented where the next person will look',
  /not authorized for this scope/i.test(_syncSrc) && /UrlScopeMap/.test(_syncSrc));

// ── Pruning ──────────────────────────────────────────────────────────
// Mirrors the WHERE of softDeleteMissing: prune rows whose type answered and
// whose id was not seen anywhere in the run.
function pruned(rows, syncedTypes, seenIds) {
  return rows.filter((r) => syncedTypes.includes(r.type) && !seenIds.includes(r.id));
}

const existing = [
  { id: 'a', type: 'SMS' }, { id: 'b', type: 'SMS' },
  { id: 'c', type: 'Call' }, { id: 'd', type: 'Email' },
];

t('a provider still present is not pruned',
  !pruned(existing, ['SMS'], ['a', 'b']).some((r) => r.id === 'a'));
t('a provider genuinely gone IS pruned',
  pruned(existing, ['SMS'], ['a']).some((r) => r.id === 'b'));
t('a channel that failed to answer is never pruned',
  pruned(existing, ['SMS'], ['a', 'b']).every((r) => r.type !== 'Email'));

// The regression the one-shot prune prevents: ids seen during the SMS round
// include Call ids, so a per-channel prune scoped to SMS would have wiped
// real SMS rows. With a single prune over all seen ids, nothing is lost.
t('cross-type ids in one response do not wipe same-type rows',
  pruned(existing, ['SMS', 'Call'], ['a', 'b', 'c']).length === 0);

// A channel that answers with nothing is a real emptiness and should prune.
t('a channel answering with an empty list prunes its rows',
  pruned(existing, ['Email'], []).some((r) => r.id === 'd'));

// ── Hand-seeded rows (scripts/seedConversationProviders.js) ──────────
// The seed exists because /conversations/providers/search is unreachable. Its
// rows are stamped 'manual' and must survive the daily sync — the sync's own
// endpoint cannot see four of them, so "not returned" must not mean "deleted".
const seedSrc = _rf(_join(_here, '..', '..', 'scripts', 'seedConversationProviders.js'), 'utf8');
const mig082 = _rf(_join(_here, '..', '..', '..', 'migrations',
  '082_conversation_providers_manual_source.sql'), 'utf8');

t("the seed stamps rows as 'manual'", /'manual'/.test(seedSrc));
t("migration 082 allows 'manual'", /last_seen_via IN \([^)]*'manual'/.test(mig082));
t('the prune skips manual rows',
  /last_seen_via IS DISTINCT FROM 'manual'/.test(_syncSrc));
t('an upsert cannot strip the manual flag',
  /last_seen_via = 'manual'\s*\n?\s*THEN 'manual'/.test(_syncSrc.replace(/\s+/g, ' '))
  || /THEN 'manual' ELSE EXCLUDED/.test(_syncSrc));

// The payload that will actually be loaded.
const seedPayload = JSON.parse(_rf(
  _join(_here, '..', '..', '..', 'data', 'providers-fJNuIdxGgchGpJ9OoBbk.json'), 'utf8'));
t('the payload holds all six providers', seedPayload.length === 6);
t('the payload carries three Call-type senders',
  seedPayload.filter((p) => p.type === 'Call').length === 3);
t('every payload entry has an id, a name and a type',
  seedPayload.every((p) => p._id && p.name && p.type));
t('payload ids are distinct',
  new Set(seedPayload.map((p) => p._id)).size === seedPayload.length);

// Every type in the payload must pass migration 080's CHECK, or the INSERT
// fails the same way create_task did against a stale constraint.
const allowed080 = new Set([...(_rf(_join(_here, '..', '..', '..', 'migrations',
  '080_conversation_providers_all_channels.sql'), 'utf8')
  .match(/ADD CONSTRAINT conversation_providers_type_check\s*CHECK \(type IN \(([\s\S]*?)\)\s*\)/)[1])
  .matchAll(/'([A-Za-z_]+)'/g)].map((m) => m[1]));
t('every payload type is storable under migration 080',
  seedPayload.every((p) => allowed080.has(p.type)));

// None of these are native — they are all custom marketplace providers.
t('no payload entry classifies as native',
  seedPayload.every((p) => !isNativeId(p._id)));

// An empty payload must be refused, not obeyed: it would wipe the location.
t('the seed refuses an empty payload', /refusing to wipe/.test(seedSrc));
t('the seed runs delete+insert in one transaction',
  /BEGIN/.test(seedSrc) && /ROLLBACK/.test(seedSrc));
t('the seed offers a dry run', /--dry-run/.test(seedSrc));

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL: ${f}`); process.exit(1); }
