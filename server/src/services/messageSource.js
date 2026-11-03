// messageSource.js — who/what actually sent an outbound message.
//
// GHL's own backend (resolveMessageSource, shared by the user) classifies an
// outbound send far more richly than we did: WORKFLOW, CAMPAIGN,
// BULK_ACTIONS, AI, API, MOBILE, APP — using workflowId/campaignId/
// bulkReqId/source/isAutoReply/isAiAutoReply plus request-level signals
// (req.channel, req.source) we have no visibility into (those only exist
// inside GHL's own request context; they are never serialized onto the
// webhook/REST payload we receive — see the investigation this file
// resolves). Everything else outbound with no userId used to collapse into
// a single 'unknown' bucket, which the UI then showed as the bare, dishonest
// "Us".
//
// This mirrors as much of GHL's real logic as our actual ingested fields
// allow:
//   - workflowId / campaignId starting 'workflow_'  → automation (workflow)
//   - campaignId                                    → automation (campaign)
//   - bulkReqId                                     → automation (bulk send)
//   - isAutoReply / isAiAutoReply.value              → automation (AI reply)
//   - userId                                         → user
//   - conversationProviderId, nothing else matched   → provider (resolved to
//                                                        a real name via
//                                                        conversation_providers)
//   - otherwise                                      → unknown
//
// campaignId / bulkReqId / isAutoReply / isAiAutoReply are extracted
// defensively: nothing in this codebase has confirmed GHL sends them on our
// webhook/REST payloads today (no DB access from this environment to check
// a live raw_message sample), but the full event is already captured in
// raw_message regardless — reading these fields costs nothing if they're
// absent, and starts working the moment GHL does send them.
export function deriveSenderType(fields, direction) {
  if (direction === 'inbound') return 'contact';
  if (direction !== 'outbound') return 'unknown';

  if (
    fields.workflowId ||
    (typeof fields.campaignId === 'string' && fields.campaignId.startsWith('workflow_')) ||
    fields.source === 'workflow'
  ) {
    return 'automation_workflow';
  }
  if (fields.campaignId || fields.source === 'campaign') return 'automation_campaign';
  if (fields.bulkReqId || fields.source === 'bulk') return 'automation_bulk';
  if (fields.isAutoReply || fields.isAiAutoReply?.value) return 'automation_ai';
  if (fields.userId) return 'user';
  if (fields.conversationProviderId) return 'provider';
  return 'unknown';
}

// The rail's actual display label for a sender_type that isn't 'user' or
// 'contact' — i.e. every automated/unattributed outbound case. `providerName`
// comes from a join against conversation_providers (see routes/deals.js and
// routes/contacts.js); everything else is a fixed, honest label rather than
// the generic "Us" this replaces.
export function labelForSenderType(senderType, providerName) {
  switch (senderType) {
    case 'automation_workflow': return 'Workflow';
    case 'automation_campaign': return 'Campaign';
    case 'automation_bulk':     return 'Bulk send';
    case 'automation_ai':       return 'AI auto-reply';
    case 'provider':            return providerName || 'Integration';
    default:                    return 'Team member';
  }
}
