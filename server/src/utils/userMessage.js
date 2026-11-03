// What a sales rep is allowed to read when something fails.
//
// Errors reaching the UI had been passing `err.message` straight through, and
// for an upstream failure that message is a diagnostic:
//
//   "GHL rejected /notes/p2Azy.../relations?locationId=kHcvavc8f... with 401
//    — the app is missing the scope for this endpoint"
//
// Every word of that is true and none of it helps someone trying to save a
// note. Worse, it puts an endpoint path and a location id on screen.
//
// The technical text still goes to the logs — the callers here log the whole
// error object — so nothing is lost for whoever has to fix it.

// Errors we WROTE, whose messages are already written for a rep. These are
// the validation classes: "Colour must be a hex value like #FFAA00" is
// exactly what should be shown.
const OURS = new Set([
  'NoteWriteError', 'TaskWriteError', 'ContactWriteError',
  'BusinessWriteError', 'OpportunityWriteError', 'TagWriteError',
  'AssociationError', 'UploadError'
]);

/**
 * A message safe to show a rep.
 *
 * @param {Error} err
 * @param {string} fallback  what to say when the error is not ours
 */
export function userMessage(err, fallback) {
  if (!err) return fallback;
  // Our own validation errors are already user-facing.
  if (OURS.has(err.name)) return err.message || fallback;
  // Anything else — an axios failure, a driver error, a TypeError — could say
  // anything at all, so it says nothing.
  return fallback;
}
