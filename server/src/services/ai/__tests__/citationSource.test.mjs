// Tests for citation attribution — services/ai/citationSource.js.
//
// Run: node src/services/ai/__tests__/citationSource.test.mjs
//
// Why this is tested: the quote itself is already guaranteed character-exact by
// validate.js. The attribution is the part that ISN'T verified by that check —
// a correct quote under the wrong name is the failure mode that survives every
// other guard, and it's the line a rep would repeat back to a client.
//
// So the rule is: resolve from context or return null. Never guess a name.

import { sourceOf } from '../citationSource.js';

let pass = 0;
const failures = [];
const t = (name, cond) => { cond ? pass++ : failures.push(name); };

const ctx = {
  people: [
    { contact_id: 'c1', first_name: 'Sarah', last_name: 'Whitmore' },
    { contact_id: 'c2', first_name: 'James', last_name: 'Halloran' },
    { contact_id: 'c3', first_name: 'Mononym', last_name: null }
  ],
  messages: [
    // inbound: no sender_name, must resolve via people
    { message_id: 'm1', channel: 'EMAIL', sender: 'c2', sender_name: null,
      sent_at: '2026-08-09T10:30:00Z' },
    // outbound: sender_name is authoritative
    { message_id: 'm2', channel: 'EMAIL', sender: 'us', sender_name: 'Ollie Bennett',
      sent_at: '2026-08-08T09:00:00Z' },
    // outbound with no stored name
    { message_id: 'm3', channel: 'SMS', sender: 'us', sender_name: null,
      sent_at: '2026-08-07T09:00:00Z' },
    // inbound from someone NOT in people — the dangerous case
    { message_id: 'm4', channel: 'WHATSAPP', sender: 'cX', sender_name: null,
      sent_at: '2026-08-06T09:00:00Z' },
    { message_id: 'm5', channel: 'EMAIL', sender: 'c3', sender_name: null,
      sent_at: '2026-08-05T09:00:00Z' },
    // a channel with no friendly label, and no timestamp
    { message_id: 'm6', channel: 'CUSTOM', sender: 'c1', sender_name: null, sent_at: null },
    { message_id: 'm7', channel: 'CALL', sender: 'c1', sender_name: null,
      sent_at: 'not-a-date' }
  ]
};

// ── The mockup's exact line ───────────────────────────────────────────
t('builds "Email · James Halloran · sent 9 Aug 2026"',
  sourceOf(ctx, 'm1').sourceLabel === 'Email · James Halloran · sent 9 Aug 2026');

t('resolves an inbound sender via people',
  sourceOf(ctx, 'm1').senderName === 'James Halloran');

t('prefers the stored sender_name on outbound',
  sourceOf(ctx, 'm2').senderName === 'Ollie Bennett');

t('falls back to "Team member" for an outbound with no stored name',
  sourceOf(ctx, 'm3').senderName === 'Team member');

// ── Never guess ───────────────────────────────────────────────────────
// A contact who isn't on the deal must come back nameless, not borrow the
// nearest name. This is the case that would misattribute a real quote.
t('an unknown inbound sender yields no name, not a wrong one',
  sourceOf(ctx, 'm4').senderName === null);

t('the label still carries channel and date when the name is unknown',
  sourceOf(ctx, 'm4').sourceLabel === 'WhatsApp · sent 6 Aug 2026');

t('a message not in context returns all-null rather than throwing',
  (() => {
    const r = sourceOf(ctx, 'nope');
    return r.sourceLabel === null && r.senderName === null && r.channelLabel === null;
  })());

t('empty context does not throw',
  sourceOf({}, 'm1').sourceLabel === null);

// ── Partial data ──────────────────────────────────────────────────────
t('a first name with no surname is used as-is',
  sourceOf(ctx, 'm5').senderName === 'Mononym');

t('an unmapped channel falls through to the raw value',
  sourceOf(ctx, 'm6').channelLabel === 'CUSTOM');

t('a missing timestamp drops the "sent" clause instead of printing null',
  sourceOf(ctx, 'm6').sourceLabel === 'CUSTOM · Sarah Whitmore');

t('an unparseable timestamp is dropped, not rendered as Invalid Date',
  !/Invalid/.test(sourceOf(ctx, 'm7').sourceLabel || ''));

// ── Channel labels ────────────────────────────────────────────────────
t('SMS stays uppercase (not "Sms")', sourceOf(ctx, 'm3').channelLabel === 'SMS');
t('WhatsApp keeps its internal capital', sourceOf(ctx, 'm4').channelLabel === 'WhatsApp');

console.log(`${pass} passed, ${failures.length} failed`);
if (failures.length) {
  for (const f of failures) console.log(`  FAIL: ${f}`);
  process.exit(1);
}
