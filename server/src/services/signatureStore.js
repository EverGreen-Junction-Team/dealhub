// signatureStore.js — a rep's email sign-off, one per user per sub-account.
//
// Sanitised on the way IN, not on the way out. A signature is written once and
// read on every draft, so cleaning it at write time costs nothing per read —
// and more importantly it means what is stored is what will be sent. Cleaning
// on read would leave the database holding markup nobody has inspected.

import { withTenant } from '../db.js';
import { sanitiseHtml, isHtmlEmpty } from '../utils/sanitiseHtml.js';

export class SignatureError extends Error {
  constructor(message, { status = 400 } = {}) {
    super(message);
    this.name = 'SignatureError';
    this.status = status;
  }
}

// Long enough for a name, title, company, phone and a link; short enough that
// nobody pastes an entire email thread in. Measured on the HTML, which is
// roughly double the visible text.
const MAX_HTML = 8000;

/** The signature for one user, or null. */
export async function getSignature(locationId, userId) {
  if (!userId) return null;
  return withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `SELECT html, updated_at FROM email_signatures
        WHERE location_id = $1 AND user_id = $2`,
      [locationId, userId]
    );
    return rows[0] ? { html: rows[0].html, updatedAt: rows[0].updated_at } : null;
  });
}

/**
 * Create or replace. Returns the stored (sanitised) HTML, so the caller can
 * show what was actually kept rather than what was submitted — a rep who
 * pastes from Outlook should see the table markup gone immediately, not
 * discover it when an email looks different.
 */
export async function saveSignature(locationId, userId, html, savedBy = null) {
  if (!userId) throw new SignatureError('No user to save a signature for', { status: 400 });
  if (typeof html !== 'string') throw new SignatureError('A signature must be text');

  const clean = sanitiseHtml(html);
  if (clean.length > MAX_HTML) {
    throw new SignatureError(
      `That signature is too long (${clean.length} characters of markup, limit ${MAX_HTML}). `
      + 'Pasting from Outlook often brings a lot of hidden formatting — try pasting as plain text and formatting it here.'
    );
  }
  // Empty is a DELETE, not a store of '<p></p>'. A rep clearing the box means
  // "stop adding a signature", and keeping an empty paragraph would append a
  // blank line to every email forever.
  if (isHtmlEmpty(clean)) return deleteSignature(locationId, userId).then(() => null);

  return withTenant(locationId, async (client) => {
    const { rows } = await client.query(
      `INSERT INTO email_signatures (location_id, user_id, html, updated_by)
            VALUES ($1, $2, $3, $4)
       ON CONFLICT (location_id, user_id) DO UPDATE
            SET html = EXCLUDED.html,
                updated_by = EXCLUDED.updated_by,
                updated_at = now()
         RETURNING html, updated_at`,
      [locationId, userId, clean, savedBy || userId]
    );
    return { html: rows[0].html, updatedAt: rows[0].updated_at };
  });
}

export async function deleteSignature(locationId, userId) {
  if (!userId) return false;
  return withTenant(locationId, async (client) => {
    const { rowCount } = await client.query(
      `DELETE FROM email_signatures WHERE location_id = $1 AND user_id = $2`,
      [locationId, userId]
    );
    return rowCount > 0;
  });
}
