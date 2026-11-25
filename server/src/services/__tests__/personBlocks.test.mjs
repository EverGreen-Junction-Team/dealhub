import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

// Person-level blocked time. GHL v3 docs, Get Blocked Slots: "calendarId
// finds blocks set on an event calendar only. Blocks set on a host
// (assignedUserId) are found by userId." The sweep asked by calendar only,
// so every person-level block — Google-synced "Busy" time included — was
// never fetched: blocked: 0 on every sweep, and a 09:00–11:30 block GHL
// showed for James Stevens never reached the board.

const src = readFileSync(new URL('../appointmentsSync.js', import.meta.url), 'utf8');

test('blocked slots are also fetched per PERSON', () => {
  assert.match(src, /fetchCalendarEvents\(\s*install, locationId, \{ userId \}, '\/calendars\/blocked-slots', window\s*\)/);
});

test('a block already seen through a calendar is not written twice', () => {
  assert.match(src, /if \(!id \|\| seenSet\.has\(id\)\) continue;/);
});

test('a failed person fetch is not evidence of absence', () => {
  assert.match(src, /if \(slots === null\) continue;\s*\n\s*coveredUsers\.push\(userId\);/);
});

test('person-level deletes are narrow: blocked rows, read people, read calendars', () => {
  const del = src.slice(src.indexOf('let userDeleted = 0;'), src.indexOf('if (!calendarIds.length) return userDeleted;'));
  assert.match(del, /AND event_kind = 'blocked'/);
  assert.match(del, /AND assigned_user_id = ANY\(\$3::text\[\]\)/);
  assert.match(del, /AND \(calendar_id IS NULL OR calendar_id = ANY\(\$6::text\[\]\)\)/);
  assert.match(del, /AND NOT \(appointment_id = ANY\(\$2::text\[\]\)\)/);
  // And it still sits behind the shared verdict at the top of reconcileDeletes.
  const fn = src.slice(src.indexOf('async function reconcileDeletes'), src.indexOf('let userDeleted = 0;'));
  assert.match(fn, /if \(!verdict\.reconcile\)/);
});

test('the calendar pass still accepts a plain calendar id', () => {
  assert.match(src, /const by = typeof scope === 'string' \? \{ calendarId: scope \} : scope;/);
});
