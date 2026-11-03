// phone.js — phone number normalisation for call matching.
//
// Providers send numbers in whatever shape their PBX produces: E.164
// (+447700900123), national (07700 900123), international-prefixed
// (0044…), with brackets and spaces, or a withheld marker. GHL stores
// whatever the rep typed. Matching has to survive all of that, so:
//
//   toE164(raw)     best-effort E.164, GB by default. null for withheld.
//   digitTail(raw)  last 10 digits — the comparison key used against the
//                   contacts/users expression indexes (migration 141).
//   isExtension()   short internal numbers that are not a phone number.

const ANONYMOUS = new Set([
  '', 'anonymous', 'private', 'withheld', 'unknown', 'restricted', 'unavailable', 'blocked', 'hidden'
]);

const COUNTRY_CODES = { GB: '44', IE: '353', US: '1', FR: '33', DE: '49', ES: '34', NL: '31' };

export function isWithheld(raw) {
  if (raw == null) return true;
  const s = String(raw).trim().toLowerCase();
  return ANONYMOUS.has(s) || /^[+0]*$/.test(s);
}

export function isExtension(raw) {
  if (raw == null) return false;
  const s = String(raw).trim();
  return /^\d{1,5}$/.test(s);
}

/**
 * Normalise to E.164. Returns null when the input is withheld, an
 * extension, or does not look like a phone number at all.
 */
export function toE164(raw, { defaultCountry = 'GB' } = {}) {
  if (isWithheld(raw)) return null;
  let s = String(raw).trim();
  if (/^(tel|sip):/i.test(s)) s = s.replace(/^(tel|sip):/i, '').split('@')[0];
  // "+44 (0) 7700 900123" → drop the bracketed trunk zero before stripping
  s = s.replace(/\(0\)/g, '');
  const hasPlus = s.startsWith('+');
  const digits = s.replace(/\D/g, '');
  if (!digits) return null;
  if (isExtension(digits)) return null;

  if (hasPlus) return digits.length >= 7 && digits.length <= 15 ? `+${digits}` : null;
  if (digits.startsWith('00')) {
    const rest = digits.slice(2);
    return rest.length >= 7 && rest.length <= 15 ? `+${rest}` : null;
  }
  const cc = COUNTRY_CODES[String(defaultCountry || 'GB').toUpperCase()] || '44';
  if (digits.startsWith('0')) {
    const national = digits.replace(/^0+/, '');
    return national.length >= 7 ? `+${cc}${national}` : null;
  }
  // Already starts with the country code but no plus (447700900123)
  if (digits.startsWith(cc) && digits.length >= cc.length + 9) return `+${digits}`;
  // Bare national without trunk prefix (7700900123) — common from PBX CDRs
  if (digits.length >= 9 && digits.length <= 11) return `+${cc}${digits}`;
  if (digits.length > 11 && digits.length <= 15) return `+${digits}`;
  return null;
}

/** Last 10 digits, the matching key. null when fewer than 7 digits. */
export function digitTail(raw) {
  if (raw == null) return null;
  const digits = String(raw).replace(/\D/g, '');
  if (digits.length < 7) return null;
  return digits.slice(-10);
}

/** Pretty national-ish display for UK numbers; falls back to E.164. */
export function formatForDisplay(e164) {
  if (!e164) return '';
  const m = /^\+44(\d{4})(\d{3})(\d{3})$/.exec(e164);
  if (m) return `0${m[1]} ${m[2]} ${m[3]}`;
  return e164;
}
