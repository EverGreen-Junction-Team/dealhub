// A display name for a contact, guaranteed non-empty.
//
// WHY THIS EXISTS. Three routes built the label as:
//
//     [first_name, last_name].filter(Boolean).join(' ') || null
//
// and the dashboard renders it straight into a chip. A GHL contact with no
// first or last name — which is normal for one created from an inbound
// message, a form, or a CSV import — produced null, so the chip rendered with
// no text: an empty pill, or nothing at all. Most rows in the task queue
// showed no contact despite having one linked.
//
// The deal timeline already solved this for message senders (routes/deals.js)
// by falling through every identifier it holds. This is that chain, extracted
// so tasks, notes and messages cannot disagree about what a contact is called.
//
// ORDER MATTERS, and it is not arbitrary:
//   name     — what a person would say out loud
//   company  — a B2B contact is often only ever known by their firm
//   email    — unique and recognisable; a rep can act on it
//   phone    — last of the real identifiers
//   fallback — 'Unknown contact', which at least says the link EXISTS
//
// Never returns the contact id. An id in a chip reads as a rendering bug and
// tells a rep nothing — which is exactly how one task ended up displaying
// "Kf2bBEEvu8aJZ4Mo0Ikj" as its title.

/**
 * @param {object} row A query row carrying any of first_name, last_name,
 *   company_name, email, phone (snake_case, as selected from `contacts`).
 * @returns {string} Always a non-empty string.
 */
export function contactLabel(row) {
  // NOT `row = {}` in the signature: a default parameter applies only to
  // `undefined`, so an explicit null still reached the property reads and
  // threw. A left join with no matching contact hands back nulls.
  const r = row && typeof row === 'object' ? row : {};
  // Strings and numbers only. Postgres can hand back a number for a phone
  // column, so those are coerced — but an object or array must be treated as
  // absent, not stringified: `String({})` is "[object Object]", which would
  // render as a contact's name.
  const clean = (v) => {
    if (typeof v === 'string') return v.trim();
    if (typeof v === 'number' && Number.isFinite(v)) return String(v);
    if (typeof v === 'bigint') return String(v);
    return '';
  };

  const name = [clean(r.first_name), clean(r.last_name)].filter(Boolean).join(' ');
  if (name) return name;

  const company = clean(r.company_name);
  if (company) return company;

  const email = clean(r.email);
  if (email) return email;

  const phone = clean(r.phone);
  if (phone) return phone;

  // Deliberately not the id: see the note above.
  return 'Unknown contact';
}
