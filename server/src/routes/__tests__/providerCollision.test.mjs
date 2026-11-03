// Collision detection decides whether the composer interrupts a rep with a
// picker. Getting it wrong in either direction is bad: a false positive nags
// on every send, a false negative silently routes through the wrong sender.
//
// The grouping logic is inlined here rather than imported because it lives
// inside the route handler. Kept in lockstep with routes/providers.js.

let pass = 0; const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

const COMPOSABLE = new Set(['SMS', 'Email', 'WhatsApp']);
const norm = (s) => String(s || '').trim().toLowerCase().replace(/\s+/g, ' ');

function group(channel, providers) {
  const list = COMPOSABLE.has(channel)
    ? [{ id: null, name: `${channel} (native)`, isNative: true, isDeleted: false }, ...providers]
    : providers;
  const counts = {};
  for (const p of list) {
    const key = p.id === null ? norm(channel) : norm(p.name);
    counts[key] = (counts[key] || 0) + 1;
  }
  for (const p of list) {
    const key = p.id === null ? norm(channel) : norm(p.name);
    p.ambiguous = counts[key] > 1;
  }
  return {
    providers: list,
    hasChoice: list.filter((p) => !p.isDeleted).length > 1,
    hasCollision: list.some((p) => p.ambiguous)
  };
}

// The exact shape from the live account screenshot.
const sms = group('SMS', [
  { id: '6a22bfc4fcbd457e97784fbb', name: 'WhatsApp QR', isDeleted: false },
  { id: '6a116a692c652618ee90299c', name: 'iMessage',    isDeleted: false },
  { id: '6a22cb89b8c221e8c3197bb4', name: 'SMS Android', isDeleted: false }
]);
t('real account: native + 3 custom SMS providers = 4 options',
  sms.providers.length === 4);
t('real account: distinct names produce no collision', sms.hasCollision === false);
t('real account: still a choice worth offering', sms.hasChoice === true);

// The case that motivated all of this.
const wa = group('WhatsApp', [{ id: 'p1', name: 'WhatsApp', isDeleted: false }]);
t('a provider named exactly like its channel collides with native',
  wa.hasCollision === true);
t('both colliding entries are flagged, not just one',
  wa.providers.filter((p) => p.ambiguous).length === 2);

// Reps read names, not byte strings.
t('collision is case-insensitive',
  group('WhatsApp', [{ id: 'p1', name: 'whatsapp', isDeleted: false }]).hasCollision === true);
t('collision ignores surrounding whitespace',
  group('SMS', [{ id: 'p1', name: '  SMS  ', isDeleted: false }]).hasCollision === true);
// The \s+ collapse is about accidental double-spacing, not about ignoring
// spaces entirely: "WhatsApp  QR" and "WhatsApp QR" are one name to a reader,
// while "S M S" and "SMS" are two different names and must stay distinct.
t('collision treats a double-spaced name as the same name',
  group('SMS', [{ id: 'p1', name: 'WhatsApp  QR' }, { id: 'p2', name: 'WhatsApp QR' }]).hasCollision === true);
t('collision keeps visually distinct spacing apart',
  group('SMS', [{ id: 'p1', name: 'S M S' }]).hasCollision === false);

// Two custom providers can collide with each other, with native uninvolved.
const twin = group('Email', [
  { id: 'a', name: 'Mailgun', isDeleted: false },
  { id: 'b', name: 'Mailgun', isDeleted: false }
]);
t('two identically-named custom providers collide', twin.hasCollision === true);
t('native is not dragged into an unrelated collision',
  twin.providers.find((p) => p.id === null).ambiguous === false);

// No custom providers at all — the common case, and it must stay silent.
const bare = group('SMS', []);
t('a channel with only native offers exactly one option', bare.providers.length === 1);
t('a channel with only native needs no picker', bare.hasChoice === false);
t('a channel with only native has no collision', bare.hasCollision === false);

// A soft-deleted provider is kept for historical timeline rows but must not
// make the composer look like it has a live choice.
const withDead = group('SMS', [{ id: 'x', name: 'Old Twilio', isDeleted: true }]);
t('a soft-deleted provider does not create a false choice',
  withDead.hasChoice === false);

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) { for (const f of failures) console.log(`  FAIL: ${f}`); process.exit(1); }
