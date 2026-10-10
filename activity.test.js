'use strict';

// POST and PATCH /api/workouts/activity.
//
// This file exists because of a bug the rest of the suite could not see.
// Adding activity_label meant threading a new field through parseActivityBody
// and both writers; the POST was updated and the PATCH was not, so every edit
// of an activity returned a 500 — `activityLabel` was simply not in scope
// there. 88 tests stayed green, because none of them touched this route. It
// surfaced only by driving the real UI and watching the save fail.
//
// The lesson is the cheap one: a shared parser with two callers needs a test
// per caller, not per parser.

process.env.DB_PATH = ':memory:';

const { test, before } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

const { db, init } = require('./db');
const accounts = require('./accounts');

let server;
let base;
let pid;

async function call(method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-profile': String(pid) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

before(async () => {
  init();
  pid = accounts.createProfile({ name: 'Act', passcode: '1234', accent_color: '#e8643c' }).profile.id;
  // A bodyweight on file, or activityCalories returns null and the calorie
  // assertions below would pass for the wrong reason.
  db.prepare(
    "INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, source) VALUES (?, 80, 'kg', '2026-10-01 07:00:00', 'manual')"
  ).run(pid);

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => { req.profileId = pid; next(); });
  app.use('/api/workouts', require('./routes/workouts'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

test('a named sport stores its label alongside the type', async () => {
  const r = await call('POST', '/api/workouts/activity', {
    activity_type: 'sport', activity_label: 'Squash', duration_min: 45, rpe: 8
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.activity_type, 'sport', 'the type must stay a known value');
  assert.strictEqual(r.body.activity_label, 'Squash');
  // The type, not the label, drives the estimate — so a named sport is priced
  // as a sport rather than falling to the 6.0 "unknown" default.
  assert.ok(r.body.calories_burned > 0, 'a named sport got no calorie estimate');
});

// The regression this file was written for.
test('editing an activity keeps working, and can change its label', async () => {
  const made = await call('POST', '/api/workouts/activity', {
    activity_type: 'sport', activity_label: 'Squash', duration_min: 45, rpe: 8
  });
  assert.strictEqual(made.status, 201);

  const edited = await call('PATCH', `/api/workouts/${made.body.id}/activity`, {
    activity_type: 'sport', activity_label: 'Padel', duration_min: 50, rpe: 8
  });
  assert.strictEqual(edited.status, 200, `editing an activity 500d: ${JSON.stringify(edited.body)}`);
  assert.strictEqual(edited.body.activity_label, 'Padel');
  assert.strictEqual(edited.body.duration_min, 50);
});

test('clearing the label clears it, rather than storing an empty string', async () => {
  const made = await call('POST', '/api/workouts/activity', {
    activity_type: 'sport', activity_label: 'Squash', duration_min: 30
  });
  const cleared = await call('PATCH', `/api/workouts/${made.body.id}/activity`, {
    activity_type: 'sport', activity_label: '   ', duration_min: 30
  });
  assert.strictEqual(cleared.status, 200, JSON.stringify(cleared.body));
  assert.strictEqual(cleared.body.activity_label, null, 'a blank box should read as no label at all');
});

test('a type with no label behaves exactly as before', async () => {
  const r = await call('POST', '/api/workouts/activity', { activity_type: 'run', duration_min: 30, rpe: 8 });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.activity_label, null);
  assert.strictEqual(r.body.activity_type, 'run');
});

test('the label is bounded, like every other free-text field here', async () => {
  const r = await call('POST', '/api/workouts/activity', {
    activity_type: 'sport', activity_label: 'x'.repeat(200), duration_min: 30
  });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.ok(r.body.activity_label.length <= 40, `label stored at ${r.body.activity_label.length} chars`);
});
