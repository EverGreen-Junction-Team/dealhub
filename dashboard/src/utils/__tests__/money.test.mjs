// Currency display for deal values.
//
// WHY THIS IS TESTED. The deal-hub headline figure, the deal edit panel and
// the deal create panel all render a currency symbol beside a number, and all
// three hardcoded '£'. `currency` is a real column on opportunities — the
// server defaults it to GBP but GHL sets it per deal — so a USD opportunity
// displayed "£1,250": not a cosmetic slip, a WRONG NUMBER shown to a rep
// about to quote a customer.
//
// The contract has two halves, and the second is the one worth pinning:
//   1. a known code produces the symbol a reader expects
//   2. anything unexpected still produces something HONEST — never a wrong
//      symbol, never a digit that would read as part of the figure, never
//      empty when a code was given
import assert from 'node:assert/strict';
import { currencySymbol, formatMoney } from '../money.js';

let n = 0;
const t = (name, fn) => { fn(); n++; console.log('  ok  ' + name); };

console.log('currencySymbol');

t('the currencies this customer actually uses', () => {
  assert.equal(currencySymbol('GBP'), '£');
  assert.equal(currencySymbol('USD'), '$');
  assert.equal(currencySymbol('EUR'), '€');
});

t('narrowSymbol, so USD is "$" and not "US$"', () => {
  // en-GB's DEFAULT currencyDisplay disambiguates foreign currencies:
  // USD → "US$", JPY → "JP¥". Correct for a document mixing currencies,
  // wrong for one deal's headline figure. Caught by testing, not by reading.
  assert.equal(currencySymbol('USD'), '$', 'US$ is the default Intl output — narrowSymbol must be set');
  assert.equal(currencySymbol('JPY'), '¥', 'JP¥ is the default Intl output');
  assert.equal(currencySymbol('AUD'), '$');
});

t('a currency with no glyph falls back to its code', () => {
  // CHF and SEK have no single-character symbol. The code is the right answer.
  assert.equal(currencySymbol('CHF'), 'CHF');
  assert.equal(currencySymbol('SEK'), 'kr');
});

t('missing / null / empty defaults to GBP, matching the server', () => {
  for (const v of [null, undefined, '']) {
    assert.equal(currencySymbol(v), '£', String(v));
  }
});

t('lower case works — GHL is not consistent about casing', () => {
  assert.equal(currencySymbol('gbp'), '£');
  assert.equal(currencySymbol('usd'), '$');
});

t('an untrimmed code does not print its padding', () => {
  // "  usd  " fell through the catch and rendered verbatim as "  USD  ",
  // padding intact, right beside the figure.
  assert.equal(currencySymbol('  usd  '), '$');
});

t('an unknown code shows the code rather than a wrong symbol', () => {
  // A rep seeing "XYZ 123" learns something. A silent '£' would mislead.
  assert.equal(currencySymbol('XYZ'), 'XYZ');
  assert.equal(currencySymbol('ZZZZ'), 'ZZZZ');
});

t('NEVER a digit — it would read as part of the number', () => {
  // '1' as a code prefixed to 250 would render "1250".
  assert.equal(currencySymbol('1'), '');
  for (const v of ['1', '99', '0']) {
    assert.ok(!/\d/.test(currencySymbol(v)), `digit leaked for ${v}`);
  }
});

t('never leading or trailing whitespace', () => {
  for (const v of ['GBP', 'USD', 'CHF', 'XYZ', '  usd  ', null, '']) {
    const s = currencySymbol(v);
    assert.ok(!/^\s|\s$/.test(s), `whitespace in ${JSON.stringify(s)}`);
  }
});

t('never throws, whatever it is handed', () => {
  for (const v of [null, undefined, '', 0, 42, {}, [], true, NaN, '£', '!!']) {
    assert.doesNotThrow(() => currencySymbol(v), String(v));
  }
});

console.log('\nformatMoney');

t('formats with symbol and separators, no pence', () => {
  assert.equal(formatMoney(1250, 'GBP'), '£1,250');
  assert.equal(formatMoney(26000, 'GBP'), '£26,000');
  assert.equal(formatMoney(123, 'GBP'), '£123');
});

t('respects the deal currency', () => {
  assert.equal(formatMoney(1250, 'USD'), '$1,250');
  assert.equal(formatMoney(1250, 'EUR'), '€1,250');
});

t('pence are rounded away — a headline figure is not an invoice', () => {
  assert.equal(formatMoney(1250.4, 'GBP'), '£1,250');
  assert.equal(formatMoney('1250.99', 'GBP'), '£1,251');
});

t('zero formats rather than vanishing', () => {
  // An explicit £0 is meaningful — DealSection styles it as "not priced yet",
  // which needs the figure to exist.
  assert.equal(formatMoney(0, 'GBP'), '£0');
});

t('absent and non-numeric yield null, not "£NaN"', () => {
  for (const v of [null, undefined, '', 'abc', {}, NaN, Infinity]) {
    assert.equal(formatMoney(v, 'GBP'), null, JSON.stringify(v));
  }
});

t('a numeric string works — the API sends both shapes', () => {
  assert.equal(formatMoney('1250', 'GBP'), '£1,250');
});

t('an unknown code still renders the NUMBER with separators', () => {
  // The separators are most of the value of formatting. Losing the figure
  // because a code was odd would be the worst outcome.
  const out = formatMoney(1250, 'XYZ');
  assert.ok(out.includes('1,250'), `number lost: ${out}`);
});

t('matches the server for the common case', () => {
  // routes/deals.js formats deal.value with the same Intl options. If these
  // drift, the same deal shows two different figures in two places.
  const server = new Intl.NumberFormat('en-GB', {
    style: 'currency', currency: 'GBP', maximumFractionDigits: 0
  }).format(1250);
  // The server does not set narrowSymbol, which is identical for GBP.
  assert.equal(formatMoney(1250, 'GBP'), server);
});

console.log(`\n${n} passed`);
