'use strict';

// GET /api/orbit/weekly-export — the weekly vault backup the GitHub Action in
// jirapat22/orbit-vault pulls every Sunday night. Drives the real orbit router
// over HTTP with a real API key, against an in-memory DB.

process.env.DB_PATH = ':memory:';
process.env.ORBIT_API_KEY = 'test-orbit-key';

const { test, before, after } = require('node:test');
const assert = require('node:assert');
const express = require('express');

const { db, init } = require('./db');
const accounts = require('./accounts');

let server;
let base;
let pat;
let other;

// Week under test: Mon 13 Oct 2026 00:00 NZDT → Mon 20 Oct 00:00 NZDT, as UTC.
const FROM = '2026-10-12T11:00:00Z';
const TO = '2026-10-19T11:00:00Z';

function get(path, key = 'test-orbit-key') {
  return fetch(`${base}${path}`, { headers: key ? { 'X-API-Key': key } : {} })
    .then(async (r) => ({ status: r.status, body: await r.json().catch(() => null) }));
}

function exercise(name, extra = {}) {
  const found = db.prepare('SELECT id FROM exercises WHERE name = ?').get(name);
  if (found) return found.id;
  return Number(db.prepare('INSERT INTO exercises (name, muscle_group, is_bodyweight) VALUES (?, ?, ?)')
    .run(name, 'chest', extra.is_bodyweight ? 1 : 0).lastInsertRowid);
}

function workout(profileId, started, finished, extra = {}) {
  return Number(db.prepare(
    `INSERT INTO workouts (profile_id, started_at, finished_at, bw_kg, kind, activity_label, duration_min)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(profileId, started, finished, extra.bw_kg ?? 80, extra.kind ?? 'strength',
    extra.activity_label ?? null, extra.duration_min ?? null).lastInsertRowid);
}

function set(profileId, workoutId, exerciseId, n, weight, reps, extra = {}) {
  db.prepare(
    `INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, is_warmup, logged_at, load_multiplier)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(profileId, workoutId, exerciseId, n, weight, extra.unit ?? 'kg', reps, extra.warmup ? 1 : 0,
    extra.logged_at ?? '2026-10-14 06:10:00', extra.mult ?? 1);
}

before(async () => {
  init();
  pat = accounts.createProfile({ name: 'Pat', passcode: '1111', accent_color: '#e8643c' }).profile.id;
  other = accounts.createProfile({ name: 'Other', passcode: '2222', accent_color: '#3c8ae8' }).profile.id;
  const bench = exercise('Bench Press');
  const curl = exercise('Test Curl');

  // This week (NZ): Tue session — 2 working sets + 1 warmup, and a per-arm curl in lbs.
  const w1 = workout(pat, '2026-10-14 06:00:00', '2026-10-14 07:00:00');
  set(pat, w1, bench, 1, 20, 10, { warmup: true });
  set(pat, w1, bench, 2, 100, 5);
  set(pat, w1, bench, 3, 90, 8);
  set(pat, w1, curl, 4, 22, 10, { unit: 'lbs', mult: 2 });
  // Thu: left open for 2 days — duration must stop at the last set, not read 48h.
  const w2 = workout(pat, '2026-10-16 06:00:00', '2026-10-18 06:00:00');
  set(pat, w2, bench, 1, 95, 5, { logged_at: '2026-10-16 06:40:00' });
  // An activity (no sets).
  workout(pat, '2026-10-17 20:00:00', '2026-10-17 21:00:00', { kind: 'activity', activity_label: 'Climbing', duration_min: 60 });
  // In-progress workout this week: not finished → not counted.
  const open = workout(pat, '2026-10-18 05:00:00', null);
  set(pat, open, bench, 1, 200, 1);

  // Last week: one session for the volume comparison.
  const w0 = workout(pat, '2026-10-07 06:00:00', '2026-10-07 07:00:00');
  set(pat, w0, bench, 1, 80, 10);

  // Just outside the window on the late side (Mon 20 Oct NZ) — must not count.
  const late = workout(pat, '2026-10-19 12:00:00', '2026-10-19 13:00:00');
  set(pat, late, bench, 1, 300, 1);

  // Someone else's workout in the same week — must never leak in.
  const wo = workout(other, '2026-10-14 06:00:00', '2026-10-14 07:00:00');
  set(other, wo, bench, 1, 500, 1);

  // PR this week + bodyweights this week and last week.
  db.prepare("INSERT INTO personal_records (profile_id, exercise_id, weight, weight_unit, reps, achieved_at) VALUES (?, ?, 100, 'kg', 5, '2026-10-14 06:20:00')").run(pat, bench);
  for (const [w, at] of [[80.0, '2026-10-13 19:00:00'], [79.6, '2026-10-16 19:00:00'], [81.0, '2026-10-08 19:00:00']]) {
    db.prepare("INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, source) VALUES (?, ?, 'kg', ?, 'manual')").run(pat, w, at);
  }

  const app = express();
  app.use('/api/orbit', require('./routes/orbit'));
  server = app.listen(0);
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

test('rejects a request without the Orbit API key', async () => {
  const r = await get(`/api/orbit/weekly-export?profile_id=${pat}&from=${FROM}&to=${TO}`, null);
  assert.strictEqual(r.status, 401);
});

test('validates profile and dates', async () => {
  assert.strictEqual((await get(`/api/orbit/weekly-export?from=${FROM}&to=${TO}`)).status, 400);
  assert.strictEqual((await get(`/api/orbit/weekly-export?profile_id=${pat}&from=${TO}&to=${FROM}`)).status, 400);
  assert.strictEqual((await get(`/api/orbit/weekly-export?profile_id=999&from=${FROM}&to=${TO}`)).status, 404);
});

test('summarises only this profile, this week, finished workouts', async () => {
  const { status, body } = await get(`/api/orbit/weekly-export?profile_id=${pat}&from=${FROM}&to=${TO}&week=2026-W42`);
  assert.strictEqual(status, 200);
  const s = body.summary;

  // 2 strength sessions + 1 activity; the open one and the late one are out.
  assert.deepStrictEqual(s.workouts.map((w) => w.kind), ['strength', 'strength', 'activity']);
  assert.strictEqual(s.workouts[2].label, 'Climbing');
  // Session left open for 2 days stops at its last set: 40 min, not 2880.
  assert.strictEqual(s.workouts[1].minutes, 40);

  // Warmup excluded; curl is 22 lbs per arm x2 = 19.96 kg x 10 reps.
  // Volume = 100*5 + 90*8 + 19.958*10 + 95*5 = 500 + 720 + 199.58 + 475 = 1894.58
  assert.strictEqual(s.volume.this_week.sets, 4);
  assert.strictEqual(s.volume.this_week.kg, 1895);
  assert.strictEqual(s.volume.last_week.kg, 800);
  assert.strictEqual(s.volume.change_kg, 1095);

  // Top bench is 100x5 — not the open workout's 200 or the other profile's 500.
  const bench = s.top_lifts.find((t) => t.exercise === 'Bench Press');
  assert.deepStrictEqual([bench.weight, bench.reps], [100, 5]);
  assert.strictEqual(s.prs.length, 1);

  assert.strictEqual(s.bodyweight.avg_kg, 79.8);
  assert.strictEqual(s.bodyweight.prev_avg_kg, 81);
  assert.strictEqual(s.bodyweight.change_kg, -1.2);
});

test('returns a readable note and the full backup payload', async () => {
  const { body } = await get(`/api/orbit/weekly-export?profile_id=${pat}&from=${FROM}&to=${TO}&week=2026-W42`);
  assert.match(body.markdown, /^# 🏋️ IronLog: week 2026-W42/);
  assert.match(body.markdown, /\*\*3 sessions\*\*/);
  assert.match(body.markdown, /Bench Press\*\*: 100 kg × 5/);
  // The full backup is the same shape as GET /api/export, scoped to this profile.
  assert.ok(Array.isArray(body.full.workouts) && Array.isArray(body.full.bodyweights));
  assert.ok(body.full.workouts.every((w) => w.profile_id === pat));
});
