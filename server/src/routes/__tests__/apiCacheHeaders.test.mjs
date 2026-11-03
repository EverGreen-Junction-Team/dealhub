// /api responses must never be served from a browser cache across sessions.
//
// WHAT HAPPENED. The contact picker showed another sub-account's contacts,
// and a freshly added contact never appeared. Both had the same cause, seen
// in a captured request:
//
//   GET /api/contacts?limit=20
//   if-none-match: W/"33c8-mmMsCa/CEi3QXoDXnNDamjdcmwQ"     → 304
//
// Express issues an ETag on JSON by default, and these URLs carry no
// location — /api/contacts?limit=20 is the same string for every
// sub-account; only the Authorization header differs. A browser caches on
// the URL, so a response stored in account A was replayed as a hit for
// account B. The server scoped every query correctly; the response just
// never came from the server.
//
// A first fix set only Cache-Control: no-store. A direct test showed Express
// STILL answering 304 — its conditional-GET check compares If-None-Match
// against the ETag it generates and ignores Cache-Control entirely, and
// browsers already holding cached entries keep sending If-None-Match. The
// fix that holds is to issue no ETag at all: `fresh` returns false the
// moment a response has no ETag, so nothing stale can ever match.
//
// Asserted against the SOURCE as well as behaviourally: the failure was a
// framework default that no test of a route handler would surface.

import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import express from 'express';
import http from 'node:http';

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..', '..', '..');
const index = readFileSync(join(root, 'src/index.js'), 'utf8');

let pass = 0;
const failures = [];
const t = (name, ok) => { if (ok) pass++; else failures.push(name); };

// ── Against the source ───────────────────────────────────────────────
t('ETag generation is disabled on the app', /app\.set\('etag', false\)/.test(index));
t('every /api response is marked no-store',
  /app\.use\('\/api', \(req, res, next\) => \{/.test(index)
  && /Cache-Control', 'no-store/.test(index));
t('Vary: Authorization is set for intermediaries', /res\.set\('Vary', 'Authorization'\)/.test(index));
t('the cache middleware is mounted BEFORE the first API router',
  index.indexOf("app.set('etag', false)") < index.indexOf("app.use('/api/deals'"));

// ── Behaviourally, with the same middleware shape ────────────────────
// The replay the captured curl performs: a stale If-None-Match from an
// old cached entry. With ETags issued it was a 304; it must be a full 200.
const app = express();
app.set('etag', false);
app.use('/api', (req, res, next) => {
  res.set('Cache-Control', 'no-store, no-cache, must-revalidate, private');
  res.set('Vary', 'Authorization');
  next();
});
app.get('/api/thing', (req, res) => res.json({ ok: true }));
const srv = app.listen(0);
const port = srv.address().port;
const get = (headers) => new Promise((resolve) => {
  http.get({ port, path: '/api/thing', headers }, (r) => {
    let body = ''; r.on('data', (c) => { body += c; });
    r.on('end', () => resolve({ status: r.statusCode, headers: r.headers, body }));
  });
});

const first = await get({});
t('no ETag is issued', first.headers.etag === undefined);
t('the response is no-store', /no-store/.test(first.headers['cache-control'] || ''));
t('Vary names Authorization', (first.headers.vary || '').includes('Authorization'));

const replay = await get({ 'if-none-match': 'W/"33c8-mmMsCa/CEi3QXoDXnNDamjdcmwQ"' });
t('a stale If-None-Match gets a full 200, not a 304', replay.status === 200);
t('and the body is actually delivered', replay.body.includes('"ok":true'));
srv.close();

// ── The thing the first fix got wrong ────────────────────────────────
// no-store on its own leaves Express's conditional-GET path intact. Pin
// that the ETag disable is what makes the replay a 200, so it is not
// "simplified away" later as redundant next to Cache-Control.
const naive = express();
naive.use('/api', (req, res, next) => { res.set('Cache-Control', 'no-store'); next(); });
naive.get('/api/thing', (req, res) => res.json({ ok: true }));
const nsrv = naive.listen(0);
const nport = nsrv.address().port;
const nfirst = await new Promise((resolve) => {
  http.get({ port: nport, path: '/api/thing' }, (r) => { r.resume(); r.on('end', () => resolve(r.headers.etag)); });
});
const nreplay = await new Promise((resolve) => {
  http.get({ port: nport, path: '/api/thing', headers: { 'if-none-match': nfirst } }, (r) => { r.resume(); r.on('end', () => resolve(r.statusCode)); });
});
nsrv.close();
t('no-store ALONE still yields a 304 — the ETag disable is load-bearing', nreplay === 304);

console.log(`\n${pass} passed, ${failures.length} failed`);
if (failures.length) console.log('FAILED:', failures);
process.exit(failures.length ? 1 : 0);
