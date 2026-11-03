// citationSource.js — human attribution for a cited message.
//
// Dependency-free so it can be unit-tested without config or a database, in the
// same spirit as validate.js.
//
// Everything here is resolved from the context the model actually read, never
// from the model's own output. A label the model wrote could name the wrong
// person on a genuinely verified quote — worse than no label, because the quote
// checks out and the attribution is what the rep would repeat back to a client.

// Human attribution for one cited message.
//
// Resolved from ctx (people + messages), never from the model — a label the
// model wrote could name the wrong person on a real quote, which is worse than
// no label at all. Returns empty fields rather than guesses when the message
// isn't found.
const CITE_CHANNEL_LABEL = {
  EMAIL: 'Email', SMS: 'SMS', WHATSAPP: 'WhatsApp', IMESSAGE: 'iMessage',
  CALL: 'Call', VOICEMAIL: 'Voicemail', WEBCHAT: 'Webchat', NOTE: 'Note',
  FACEBOOK: 'Facebook', INSTAGRAM: 'Instagram', FORM: 'Form'
};

export function sourceOf(ctx, messageId) {
  const m = (ctx.messages || []).find((x) => x.message_id === messageId);
  if (!m) {
    // Notes and tasks are citable too (rule 7). Without these a claim quoting
    // one rendered a bare quote with no attribution — the "Based on" line was
    // empty and it looked like the citation had failed.
    const note = (ctx.notes || []).find((n) => n.note_id === messageId);
    if (note) {
      const sentAt = note.created_at ? formatCiteDate(note.created_at) : null;
      return {
        sourceLabel: ['Note', note.author, sentAt ? `written ${sentAt}` : null]
          .filter(Boolean).join(' · ') || 'Note',
        channelLabel: 'Note',
        senderName: note.author || null,
        sentAt
      };
    }
    const task = (ctx.tasks || []).find((t) => t.task_id === messageId);
    if (task) {
      const sentAt = task.created_at ? formatCiteDate(task.created_at) : null;
      return {
        sourceLabel: [
          'Task',
          task.assignee,
          task.status === 'completed' ? 'completed' : null,
          sentAt ? `added ${sentAt}` : null
        ].filter(Boolean).join(' · ') || 'Task',
        channelLabel: 'Task',
        senderName: task.assignee || null,
        sentAt
      };
    }
    return { sourceLabel: null, channelLabel: null, senderName: null };
  }

  const channelLabel =
    CITE_CHANNEL_LABEL[String(m.channel || '').toUpperCase()] || m.channel || null;

  // Outbound carries the rep's name directly; inbound only has a contact id,
  // so resolve it against the deal's people.
  let senderName = m.sender_name || null;
  if (!senderName) {
    if (m.sender === 'us') {
      // GHL's own payload sometimes omits which rep sent an outbound
      // message (confirmed: not an ingestion gap, unrecoverable) — "Us" is
      // technically true but reads as false certainty in a citation a rep
      // is meant to trust. Same fix as the deal timeline (routes/deals.js).
      senderName = 'Team member';
    } else {
      const p = (ctx.people || []).find((x) => x.contact_id === m.sender);
      senderName = p
        ? ([p.first_name, p.last_name].filter(Boolean).join(' ') || null)
        : null;
    }
  }

  const sentAt = m.sent_at ? formatCiteDate(m.sent_at) : null;
  const sourceLabel = [
    channelLabel,
    senderName,
    sentAt ? `sent ${sentAt}` : null
  ].filter(Boolean).join(' · ') || null;

  return { sourceLabel, channelLabel, senderName, sentAt };
}

// "9 Aug 2026" — the format the citation line uses.
function formatCiteDate(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return null;
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  return `${d.getUTCDate()} ${M[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
}
