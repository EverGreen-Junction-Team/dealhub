// Currency display for deal values.
//
// SHARED because three components need it: the deal-hub headline figure and
// the two deal panels' value inputs. All three previously hardcoded '£', so a
// USD opportunity displayed "£1,250" — a wrong number, not a cosmetic slip.
// `currency` is a real column on opportunities, defaulted to GBP by the
// server but set per deal.

// The symbol for a currency code, derived rather than kept in a lookup table.
//
// Intl knows every code, including ones no table would list, and it returns
// the code itself for anything it does not recognise ("XYZ 5") — which is
// honest output rather than a wrong symbol or a blank.
//
// Falls back to GBP to match the server, which defaults the column.
export function currencySymbol(code) {
  // Trimmed as well as upper-cased: an untrimmed code fell through the catch
  // below and was rendered verbatim, so "  usd  " printed as "  USD  " with
  // its padding intact right beside the figure.
  const cur = String(code || 'GBP').trim().toUpperCase() || 'GBP'
  try {
    // currencyDisplay: 'narrowSymbol' matters here.
    //
    // The default in en-GB DISAMBIGUATES foreign currencies: USD formats as
    // "US$1,250" and JPY as "JP¥1,250". Correct for a document that mixes
    // currencies, wrong for a single deal's headline figure — the reader
    // already knows which deal they are looking at, and "US$" reads as noise.
    // narrowSymbol gives "$" and "¥".
    //
    // Format a known number, then strip the digits and separators: what
    // remains is the symbol.
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: cur,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 0
    })
      .format(0)
      .replace(/[\d\s.,]/g, '')
      || cur
  } catch {
    // An invalid code throws rather than degrading. Show the code — a rep
    // seeing "XYZ 123" learns something; a blank teaches nothing.
    //
    // But never anything containing a DIGIT: prefixed to the figure it would
    // read as part of the number, which is worse than showing no symbol.
    return /\d/.test(cur) ? '' : cur
  }
}

// The figure as a reader should see it: symbol, thousands separators, no
// pence. Mirrors the server's own Intl call in routes/deals.js so a value
// formatted here and one formatted there cannot disagree.
//
// Callers should prefer the server's `deal.value` when it is present; this is
// for the cases where only the raw number is to hand.
export function formatMoney(amount, code) {
  if (amount == null || amount === '') return null
  const n = Number(amount)
  if (!Number.isFinite(n)) return null
  const cur = String(code || 'GBP').trim().toUpperCase() || 'GBP'
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency', currency: cur,
      currencyDisplay: 'narrowSymbol',
      maximumFractionDigits: 0
    }).format(n)
  } catch {
    // An unknown code still has to render the NUMBER — the separators are
    // most of the value of formatting it.
    const sym = currencySymbol(cur)
    return `${sym}${sym ? '' : ''}${n.toLocaleString('en-GB', { maximumFractionDigits: 0 })}`
  }
}
