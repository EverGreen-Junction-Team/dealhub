// Channel presentation + normalisation for message rows.
//
// Extracted from routes/deals.js so the Businesses route renders conversations
// identically. These were duplicated once before and the copies drifted — the
// direction check compared against 'in'/'out' while the writer stores
// 'inbound'/'outbound', which silently broke the people filter and the In/Out
// labels. One definition, imported by both.

// TASK is clay — the Tasks tab's own header colour — so a task row carries
// a colour like every other kind. It was 'gray' here AND hard-coded 'gray' in
// routes/deals.js taskRows, which made tasks the one kind with no tint on the
// timeline; both now say clay, so the Deals and Businesses routes agree.
export const CHANNEL_ACCENT = {
  EMAIL: 'sky', WHATSAPP: 'pine', SMS: 'clay', IMESSAGE: 'plum',
  CALL: 'gray', VOICEMAIL: 'gray', NOTE: 'gold', TASK: 'clay',
  ACTIVITY: 'gray', SYSTEM: 'gray', WEBCHAT: 'teal', FORM: 'sky',
  FACEBOOK: 'sky', INSTAGRAM: 'plum', CUSTOM: 'gray',
  // A team-only note left on the conversation (GHL's internal comment).
  // Gold, like a note: it is one, just written in the inbox.
  INTERNAL: 'gold'
};
// The channel a REP would file a sender under — not always the type GHL
// stores it as.
//
// GHL registers marketplace messaging providers as SMS-type: "WhatsApp QR",
// "iMessage" and "SMS Android" all carry type 'SMS' (migration 080 records
// the live payload). Grouped by that type, WhatsApp QR sat under SMS and
// every WhatsApp list showed one sender (native) — so the AI said "nothing
// to choose", and the card's sender picker hid itself. A sender NAMED
// WhatsApp goes under WhatsApp. Messaging types only: a Call-type "WhatsApp
// Voice" matched the name and was offered as a message sender it cannot be.
//
// Three readers of conversation_providers used to each do this: the deal
// action detector, the get_conversation_providers tool and /api/providers.
// One of them was fixed and the other two were not, which is how the chat
// offered WhatsApp QR while the card beneath it could not. One function.
//
// Sending is unaffected: ghlMessageWrite turns any custom provider id into
// type 'Custom', whatever channel it was listed under.
export function senderChannel(row) {
  const type = row?.type;
  if (row?.is_native || row?.isNative) return type;
  if (type !== 'SMS' && type !== 'WhatsApp') return type;
  return /whats\s*app/i.test(row?.name || '') ? 'WhatsApp' : type;
}

export const CHANNEL_ICON = {
  EMAIL: 'mail', WHATSAPP: 'chat', SMS: 'sms', IMESSAGE: 'chat_bubble',
  CALL: 'call', VOICEMAIL: 'call', NOTE: 'sticky_note_2',
  TASK: 'check_circle', ACTIVITY: 'timeline', SYSTEM: 'settings',
  WEBCHAT: 'forum', FORM: 'description',
  FACEBOOK: 'facebook', INSTAGRAM: 'photo_camera', CUSTOM: 'chat',
  // The eye GHL puts on it: seen by the team, never by the customer.
  INTERNAL: 'visibility'
};

// Human label for the compact event-row renderer. The raw GHL type carries
// the specificity that the normalised channel (all TYPE_ACTIVITY_* → ACTIVITY)
// drops. We read it back from raw_message.messageType so the UI can show
// "Opportunity" / "Invoice" / "Appointment" instead of a generic "Activity".
//
// Body override: many GHL activity rows carry a human phrase in message_body
// like "Opportunity created" or "Task completed — Send Cortizo brochure";
// when it exists, prefer that. This function returns just the LABEL bit
// (prefix); the frontend combines it with the body line.
export function eventLabelFromRaw(rawType) {
  if (!rawType) return 'Event';
  const t = String(rawType).toUpperCase();
  if (t === 'TYPE_ACTIVITY_OPPORTUNITY') return 'Opportunity';
  if (t === 'TYPE_ACTIVITY_CONTACT')     return 'Contact';
  if (t === 'TYPE_ACTIVITY_INVOICE')     return 'Invoice';
  if (t === 'TYPE_ACTIVITY_APPOINTMENT') return 'Appointment';
  if (t === 'TYPE_ACTIVITY_PAYMENT')     return 'Payment';
  if (t.startsWith('TYPE_ACTIVITY_')) {
    // Fallback for future activity types — turn TYPE_ACTIVITY_FOO into "Foo"
    return t.slice('TYPE_ACTIVITY_'.length).toLowerCase()
      .replace(/^./, (c) => c.toUpperCase());
  }
  if (t === 'TASK')   return 'Task';
  if (t === 'SYSTEM') return 'System';
  return 'Event';
}

// Historical rows may still carry variants (before migration 048 backfill
// runs). Fall through defensively so a mid-deploy timeline doesn't 500.
export function normaliseChannel(raw) {
  if (!raw) return 'SYSTEM';
  const c = String(raw).toUpperCase();
  if (['EMAIL', 'TYPE_EMAIL'].includes(c)) return 'EMAIL';
  if (['SMS', 'TYPE_SMS', 'CUSTOM_SMS', 'TYPE_CUSTOM_SMS'].includes(c)) return 'SMS';
  if (['CALL', 'TYPE_CALL'].includes(c)) return 'CALL';
  if (['VOICEMAIL', 'TYPE_VOICEMAIL'].includes(c)) return 'VOICEMAIL';
  if (['WEBCHAT', 'TYPE_WEBCHAT', 'LIVE_CHAT', 'TYPE_LIVE_CHAT'].includes(c)) return 'WEBCHAT';
  if (['WHATSAPP', 'TYPE_WHATSAPP'].includes(c)) return 'WHATSAPP';
  if (['IMESSAGE', 'TYPE_IMESSAGE'].includes(c)) return 'IMESSAGE';
  if (['FB', 'TYPE_FACEBOOK', 'FACEBOOK', 'TYPE_FB'].includes(c)) return 'FACEBOOK';
  if (['IG', 'TYPE_INSTAGRAM', 'INSTAGRAM', 'TYPE_IG'].includes(c)) return 'INSTAGRAM';
  if (['FORM_SUBMISSION', 'TYPE_FORM_SUBMISSION'].includes(c)) return 'FORM';
  if (c.startsWith('TYPE_ACTIVITY_')) return 'ACTIVITY';
  if (c === 'ACTIVITY') return 'ACTIVITY';
  if (c === 'NOTE') return 'NOTE';
  if (c === 'TASK') return 'TASK';
  // Custom conversation providers — goghl.ai's WhatsApp, for instance. GHL
  // sends TYPE_CUSTOM_PROVIDER_SMS / _EMAIL for these, which used to fall all
  // the way through to SYSTEM: the messages were then treated as system events,
  // so they had no filter chip, never joined the CUSTOM bucket, and rendered as
  // grey activity lines instead of messages. The provider's own name is what
  // the UI shows (see channelLabelOf), so one bucket here is enough.
  if (c === 'CUSTOM' || c.startsWith('TYPE_CUSTOM_PROVIDER')) return 'CUSTOM';
  // GHL's internal comment (TYPE_INTERNAL_COMMENT, numeric 37). It fell
  // through to SYSTEM and drew as a grey "Event · <text>" line with a cog —
  // a team member's note on the conversation shown as if the system had
  // logged it. It is a message from a colleague, and renders as one.
  // GHL spells it "InternalComment" on the OutboundMessage webhook (no
  // underscore, stored upper-cased as INTERNALCOMMENT) and
  // TYPE_INTERNAL_COMMENT on its REST message rows. Letters only, so every
  // spelling lands here.
  if (c.replace(/[^A-Z]/g, '').includes('INTERNALCOMMENT') || c === 'INTERNAL') return 'INTERNAL';
  return 'SYSTEM';
}

// The type of a stored message, from whatever the payload carried. The
// message_channel column is what the writer derived at the time; a row
// written before a type was known to the writer may hold a raw string, or
// nothing, while raw_message still says what it was — as a messageType
// string or GHL's numeric type (37 = internal comment, 50 = form).
const NUMERIC_TYPE = {
  1: 'CALL', 2: 'SMS', 3: 'EMAIL', 5: 'WEBCHAT', 11: 'FACEBOOK', 18: 'INSTAGRAM',
  19: 'WHATSAPP', 25: 'TYPE_ACTIVITY_CONTACT', 26: 'TYPE_ACTIVITY_INVOICE',
  27: 'TYPE_ACTIVITY_PAYMENT', 28: 'TYPE_ACTIVITY_OPPORTUNITY', 29: 'WEBCHAT',
  31: 'TYPE_ACTIVITY_APPOINTMENT', 37: 'TYPE_INTERNAL_COMMENT', 50: 'FORM_SUBMISSION'
};
export function channelOfRow(row) {
  const raw = row?.raw_message;
  const fromRaw = raw?.messageType || raw?.messageTypeString
    || (typeof raw?.type === 'number' ? NUMERIC_TYPE[raw.type] : null);
  // The raw type wins when it names something more specific than what was
  // stored: a row stored as SYSTEM/null whose payload says internal comment.
  const stored = normaliseChannel(row?.message_channel);
  if (fromRaw) {
    const n = normaliseChannel(fromRaw);
    if (n !== 'SYSTEM') return n;
  }
  return stored;
}
