'use strict';

// GET /api/io/coach — read-only training data for I.O.'s coach in Discord.
// Drives the real io router over HTTP against an in-memory DB: the key gate,
// the profile pinning, and the shape the coach reads.

process.env.DB_PATH = ':memory:';
process.env.IO_API_KEY = 'test-io-key-0123456789';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { db, init } = require('./db');
const accounts = require('./accounts');

let server, base, pat, other;

const get = (path, key = 'test-io-key-0123456789') =>
  fetch(`${base}${path}`, { headers: key ? { 'x-io-key': key } : {} })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));

before(async () => {
  init();
  pat = accounts.createProfile({ name: 'Pat', passcode: '1111', accent_color: '#e8643c' }).profile.id;
  other = accounts.createProfile({ name: 'Other', passcode: '2222', accent_color: '#3c8ae8' }).profile.id;
  process.env.IO_PROFILE_ID = String(pat);
  const bench = Number(db.prepare("INSERT INTO exercises (name, muscle_group) VALUES ('Coach Bench', 'chest')").run().lastInsertRowid);
  for (const [pid, started, weight] of [[pat, '2026-10-27 06:00:00', 100], [other, '2026-10-27 06:00:00', 140]]) {
    const w = Number(db.prepare(
      "INSERT INTO workouts (profile_id, started_at, finished_at, kind) VALUES (?, ?, datetime(?, '+1 hour'), 'strength')"
    ).run(pid, started, started).lastInsertRowid);
    db.prepare(`INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, reps, is_warmup, logged_at)
                VALUES (?, ?, ?, 1, ?, 5, 0, ?)`).run(pid, w, bench, weight, started);
  }
  db.prepare("INSERT INTO bodyweights (profile_id, weight, logged_at) VALUES (?, 80.4, '2026-10-26 18:00:00')").run(pat);
  db.prepare("INSERT INTO bodyweights (profile_id, weight, logged_at) VALUES (?, 95, '2026-10-26 18:00:00')").run(other);

  const app = express();
  app.use('/api/io', require('./routes/io'));
  await new Promise((r) => { server = app.listen(0, r); });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server?.close());

test('no key or a wrong key gets nothing', async () => {
  assert.strictEqual((await get('/api/io/coach', null)).status, 401);
  assert.strictEqual((await get('/api/io/coach', 'nope')).status, 401);
});

test('coach data is the pinned profile only: weeks, body weights, profile', async () => {
  const { status, body } = await get('/api/io/coach?weeks=2&to=2026-10-29T11:00:00Z');
  assert.strictEqual(status, 200);
  assert.strictEqual(body.weeks.length, 2);
  const text = JSON.stringify(body.weeks);
  assert.ok(text.includes('Coach Bench') && text.includes('100') && !text.includes('140'), 'only Pat\'s lifts');
  assert.deepStrictEqual(body.bodyweights.map((b) => b.weight), [80.4]);
  assert.ok('profile' in body);
});

test('bad input is refused, and the week count is capped', async () => {
  assert.strictEqual((await get('/api/io/coach?to=someday')).status, 400);
  assert.strictEqual((await get('/api/io/coach?weeks=500&to=2026-10-29T11:00:00Z')).body.weeks.length, 12);
});
