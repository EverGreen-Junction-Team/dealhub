// ghlTagWrite.js — add and remove tags on a contact.
//
// WHY THIS EXISTS SEPARATELY FROM contactPatch.js
//
// contactPatch throws if you pass `tags`, and that guard stays. The reason:
// PUT /contacts/{id} REPLACES the whole tag array, so sending ['vip'] silently
// deletes every other tag on the contact. Our UI shows tags from both the
// contact and its opportunity, so a partial list is easy to assemble by
// accident and impossible to recover afterwards.
//
// These two endpoints are ADDITIVE instead:
//   POST   /contacts/{id}/tags   → appends; returns { tags, tagsAdded }
//   DELETE /contacts/{id}/tags   → removes only what's present
//
// Neither can destroy a tag it wasn't told about, which is what makes tag
// editing safe to expose at all.
//
// FLOW — the contacts pattern, not the tasks one.
//
// Tags DO have a webhook: ContactTagUpdate fires with the full new list, and
// tagHistoryWriter.reconcileTags diffs it against tag_history (opening and
// closing rows) and refreshes the mirrored contacts.tags array. That machinery
// is the only thing that maintains tag_history correctly, so this service does
// NOT write Postgres — writing the array directly here would leave tag_history
// silently wrong, and history is the whole point of that table.
//
// The response's `tags` is returned to the caller so the UI can settle
// immediately while the webhook reconciles a moment later.
//
// Validation and normalisation live in tagPatch.js, which is dependency-free.

import { ghlRequest } from './ghlClient.js';
import { rejectionMessage, logRejection } from './ghlRejection.js';
import { logger } from '../utils/logger.js';
import { buildTagList, TagWriteError, normaliseTag } from './tagPatch.js';

// Re-exported so routes have a single import site for the whole tag path.
export { buildTagList, TagWriteError, normaliseTag };

function translateGhlError(err, { contactId, verb }) {
  const status = err.response?.status;
  const body = err.response?.data;

  if (status === 401 || status === 403) {
    return new TagWriteError(
      'This app cannot change tags yet — the contacts.write permission is missing. Reauthorise the app.',
      { status: 403 }
    );
  }
  if (status === 404) {
    return new TagWriteError('That contact no longer exists', { status: 404 });
  }
  if (status === 422 || status === 400) {
    const detail = body?.message || body?.error
      || (Array.isArray(body?.errors) ? body.errors.join('; ') : null);
    // GHL's own text is LOGGED, never shown — services/ghlRejection.js
    // explains why: it names a field for a validation error, but a raw
    // record id for a missing one, and the whole sales team sees these.
    logRejection('ghlTagWrite', { status, detail, body });
    const rej = rejectionMessage('tag', detail);
    return new TagWriteError(rej.message, { status: rej.status, detail });
  }
  logger.error({ err, status, contactId, body }, `ghlTagWrite: ${verb} failed`);
  return new TagWriteError(`Could not ${verb} the tags — try again`, { status: 502 });
}

/**
 * POST /contacts/{contactId}/tags
 *
 * Additive: only tags the contact doesn't already have are appended, and any
 * that don't exist in the location are created in its catalogue.
 *
 * @returns {{ tags: string[], tagsAdded: string[] }} — `tags` is the full list
 *   after the call, `tagsAdded` only what was actually new (empty if they were
 *   all already there, which is a no-op, not a failure).
 */
export async function addGhlContactTags(install, contactId, input) {
  if (!contactId) throw new TagWriteError('Which contact?', { status: 400 });
  const tags = buildTagList(input, { verb: 'add' });

  try {
    const { data } = await ghlRequest(install, {
      method: 'POST',
      url: `/contacts/${encodeURIComponent(contactId)}/tags`,
      data: { tags }
    });
    const added = data?.tagsAdded || [];
    logger.info(
      { contactId, requested: tags, added },
      'ghlTagWrite: tags added'
    );
    return { tags: data?.tags || [], tagsAdded: added };
  } catch (err) {
    throw translateGhlError(err, { contactId, verb: 'add' });
  }
}

/**
 * DELETE /contacts/{contactId}/tags
 *
 * Only removes tags actually on the contact. Sending one it doesn't have is a
 * no-op rather than an error.
 */
export async function removeGhlContactTags(install, contactId, input) {
  if (!contactId) throw new TagWriteError('Which contact?', { status: 400 });
  const tags = buildTagList(input, { verb: 'remove' });

  try {
    // DELETE with a body. axios needs `data` on a delete config — it's legal
    // HTTP and what GHL documents, but easy to lose to a client that strips it.
    const { data } = await ghlRequest(install, {
      method: 'DELETE',
      url: `/contacts/${encodeURIComponent(contactId)}/tags`,
      data: { tags }
    });
    const removed = data?.tagsRemoved || [];
    logger.info(
      { contactId, requested: tags, removed },
      'ghlTagWrite: tags removed'
    );
    return { tags: data?.tags || [], tagsRemoved: removed };
  } catch (err) {
    throw translateGhlError(err, { contactId, verb: 'remove' });
  }
}
