'use strict';

// Polar watch sessions (lib/polar.js, routes/polar.js, the /polar/callback
// state). Polar itself is replaced by a fake `fetch`, against an in-memory DB:
// what's tested is turning Polar's JSON into rows, matching a session to the
// right workout, the one-time connect state, and the backup round trip.

process.env.DB_PATH = ':memory:';
process.env.POLAR_CLIENT_ID = 'test-client';
process.env.POLAR_CLIENT_SECRET = 'test-secret';

const { test, before, afterEach } = require('node:test');
const assert = require('node:assert');

const { db, init } = require('./db');
const accounts = require('./accounts');
const polar = require('./lib/polar');
const polarRouter = require('./routes/polar');
const { buildFullExport } = require('./routes/export');

let pat;
const realFetch = global.fetch;

// A Polar session as the API sends it: 17:30 local in NZ (UTC+13 = 780 min) = 04:30 UTC.
const EX = {
  id: 'ABC123', start_time: '2026-11-02T17:30:00', start_time_utc_offset: 780, duration: 'PT1H2M30S',
  heart_rate: { average: 128, maximum: 171 }, training_load: 54.2, sport: 'OTHER',
  detailed_sport_info: 'STRENGTH_TRAINING', calories: 612, device: 'Polar Pacer Pro',
  heart_rate_zones: [
    { index: 1, 'in-zone': 'PT10M' }, { index: 0, 'in-zone': 'PT20M' }, { index: 2, 'in-zone': 'PT5M30S' },
    { index: 3, 'in-zone': 'PT0S' }, { index: 4, 'in-zone': 'PT1M' }
  ]
};

before(() => {
  init();
  pat = accounts.createProfile({ name: 'Pat', passcode: '1111', accent_color: '#e8643c' }).profile.id;
});

afterEach(() => { global.fetch = realFetch; });

test('durations and sport names read the way Polar writes them', () => {
  assert.strictEqual(polar.parseDuration('PT1H2M30S'), 3750);
  assert.strictEqual(polar.parseDuration('PT45.6S'), 46);
  assert.strictEqual(polar.parseDuration('PT0S'), 0);
  assert.strictEqual(polar.parseDuration('soon'), null);
  assert.strictEqual(polar.sportLabel('STRENGTH_TRAINING'), 'Strength training');
  assert.strictEqual(polar.sportLabel(''), 'Session');
});

test('a Polar session becomes a UTC row, zones in order, no calories', () => {
  const r = polar.toSession(EX);
  assert.deepStrictEqual(r, {
    polar_id: 'ABC123', started_at: '2026-11-02 04:30:00', duration_s: 3750, sport: 'Strength training',
    avg_hr: 128, max_hr: 171, training_load: 54.2, distance_m: null,
    zones: JSON.stringify([1200, 600, 330, 0, 60]), device: 'Polar Pacer Pro'
  });
  assert.strictEqual(polar.toSession({ start_time: '2026-11-02T17:30:00' }), null);   // no id
});

test('matches the session that overlaps the workout most, with a little slack', () => {
  const s = (id, started_at, mins) => ({ polar_id: id, started_at, duration_s: mins * 60 });
  const gym = { started_at: '2026-11-02 04:40:00', finished_at: '2026-11-02 05:40:00' };
  const morningRun = s('run', '2026-11-01 18:00:00', 30);
  const watch = s('gym', '2026-11-02 04:30:00', 65);        // watch started 10 min before the first set
  assert.strictEqual(polar.matchFor(gym, [morningRun, watch]).polar_id, 'gym');
  assert.strictEqual(polar.matchFor(gym, [morningRun]), null);
  // An activity uses its own duration; a workout left open for days can't grab everything.
  const walk = { kind: 'activity', started_at: '2026-11-01 18:05:00', duration_min: 25 };
  assert.strictEqual(polar.matchFor(walk, [morningRun, watch]).polar_id, 'run');
  const forgotten = { started_at: '2026-10-30 04:00:00', finished_at: '2026-11-02 06:00:00' };
  assert.strictEqual(polar.matchFor(forgotten, [watch]), null);
});

test('connect swaps the code, registers the user, then sync saves sessions', async () => {
  const calls = [];
  global.fetch = async (url, opts = {}) => {
    calls.push({ url: String(url), method: opts.method || 'GET', auth: opts.headers?.Authorization });
    if (String(url).includes('/oauth2/token')) return Response.json({ access_token: 'tok', x_user_id: 42 });
    if (String(url).endsWith('/v3/users')) return new Response(null, { status: 409 });   // already registered: fine
    if (String(url).includes('/v3/exercises')) return Response.json([EX, { nonsense: true }]);
    return new Response(null, { status: 500 });
  };
  await polar.connect(pat, 'one-time-code');
  assert.strictEqual(calls[0].auth, `Basic ${Buffer.from('test-client:test-secret').toString('base64')}`);
  assert.strictEqual(calls[1].auth, 'Bearer tok');
  assert.strictEqual(polar.link(pat).polar_user_id, '42');

  assert.strictEqual(await polar.sync(pat), 1);
  assert.strictEqual(await polar.sync(pat), 1);              // same session again: updated, not doubled
  assert.match(calls.at(-1).url, /\/v3\/exercises\?zones=true$/);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM polar_sessions WHERE profile_id = ?').get(pat).n, 1);
  assert.ok(polar.link(pat).last_sync_at);
});

test('a revoked token says "connect again" instead of failing quietly', async () => {
  global.fetch = async () => new Response(null, { status: 401 });
  await assert.rejects(polar.sync(pat));
  assert.match(polar.link(pat).last_error, /Connect again/);
});

test('a workout fetch carries its Polar session', () => {
  const w = { started_at: '2026-11-02 04:40:00', finished_at: '2026-11-02 05:40:00' };
  const p = polar.forWorkout(pat, w);
  assert.strictEqual(p.avg_hr, 128);
  assert.deepStrictEqual(p.zones, [1200, 600, 330, 0, 60]);
  assert.strictEqual(polar.forWorkout(pat, { started_at: '2026-10-01 04:40:00', finished_at: '2026-10-01 05:40:00' }), null);
});

test('connect state works once, for the profile that asked', async () => {
  const handler = polarRouter.stack.find((l) => l.route?.path === '/connect').route.stack[0].handle;
  let body;
  handler({ profileId: pat }, { json: (b) => { body = b; }, status: () => ({ json: () => {} }) });
  const state = new URL(body.url).searchParams.get('state');
  assert.match(body.url, /^https:\/\/flow\.polar\.com\/oauth2\/authorization\?/);
  assert.match(body.url, /redirect_uri=https%3A%2F%2Fironlog\.jirapat\.dev%2Fpolar%2Fcallback/);
  assert.strictEqual(polarRouter.takeState(state), pat);
  assert.strictEqual(polarRouter.takeState(state), null);    // used up
  assert.strictEqual(polarRouter.takeState('made-up'), null);
});

test('the backup carries the sessions but never the token', () => {
  const out = buildFullExport(pat);
  assert.strictEqual(out.polar_sessions.length, 1);
  assert.strictEqual(out.polar_sessions[0].polar_id, 'ABC123');
  assert.ok(!JSON.stringify(out).includes('"tok"'));
});

test('disconnect tells Polar and drops the link, keeping the sessions', async () => {
  const calls = [];
  global.fetch = async (url, opts) => { calls.push(`${opts.method} ${url}`); return new Response(null, { status: 204 }); };
  await polar.disconnect(pat);
  assert.deepStrictEqual(calls, ['DELETE https://www.polaraccesslink.com/v3/users/42']);
  assert.strictEqual(polar.link(pat), null);
  assert.strictEqual(db.prepare('SELECT COUNT(*) AS n FROM polar_sessions WHERE profile_id = ?').get(pat).n, 1);
});

test('restoring a backup brings the sessions back, once, and skips junk rows', async () => {
  const express = require('express');
  const app = express();
  app.use(express.json({ limit: '50mb' }));   // same as server.js: a backup carries the exercise library
  app.use((req, res, next) => { req.profileId = Number(req.headers['x-test-profile']); next(); });
  app.use('/api/import', require('./routes/import'));
  const server = app.listen(0);
  const url = `http://127.0.0.1:${server.address().port}/api/import`;
  const other = accounts.createProfile({ name: 'Restore', passcode: '3333', accent_color: '#3c8ae8' }).profile.id;
  const backup = buildFullExport(pat);
  backup.polar_sessions.push({ polar_id: 7, started_at: 'x' }, { sport: 'no id' });
  try {
    for (let i = 0; i < 2; i++) {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-test-profile': String(other) },
                                   body: JSON.stringify(backup) }).then((x) => x.json());
      assert.strictEqual(r.imported_polar_sessions, 1);
    }
  } finally { server.close(); }
  const rows = db.prepare('SELECT polar_id, avg_hr, zones FROM polar_sessions WHERE profile_id = ?').all(other);
  assert.deepStrictEqual(rows.map((r) => ({ ...r })), [{ polar_id: 'ABC123', avg_hr: 128, zones: JSON.stringify([1200, 600, 330, 0, 60]) }]);
});
