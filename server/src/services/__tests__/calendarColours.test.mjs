import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normaliseColour, colourMap } from '../calendarColours.js';

test('a colour is stored as lower-case #rrggbb', () => {
  assert.equal(normaliseColour('#D50000'), '#d50000');
  assert.equal(normaliseColour('d50000'), '#d50000');
  assert.equal(normaliseColour(' #abc '), '#aabbcc');
});

test('no colour means back to the default', () => {
  assert.equal(normaliseColour(null), null);
  assert.equal(normaliseColour(''), null);
  assert.equal(normaliseColour(undefined), null);
});

test('anything that is not a colour is refused', () => {
  for (const bad of ['red', '#12345', '#1234567', 'rgb(0,0,0)', 'var(--x)', 12, {}, '#ggg000']) {
    assert.equal(normaliseColour(bad), undefined, String(bad));
  }
});

test('rows become a calendar → colour map', () => {
  const m = colourMap([{ calendar_id: 'a', colour: '#111111' }, { calendar_id: 'b', colour: '#222222' }]);
  assert.equal(m.get('a'), '#111111');
  assert.equal(m.get('c'), undefined);
  assert.equal(colourMap(null).size, 0);
});
