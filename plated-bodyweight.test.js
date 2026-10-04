'use strict';

// POST /api/plated/bodyweight — the write side of the bodyweight integration,
// and the one place three rules have to agree about who owns a day's weigh-in.
//
// Why this file exists at all: Plated reports that it never calls this
// endpoint. Bodyweight has only ever flowed IronLog -> Plated, via their GET.
// So the ownership rule shipped in fe8d5c1 currently has NO live caller, and
// an unexercised branch on a public documented endpoint is exactly the kind
// that rots unnoticed until the day something does call it. The endpoint stays
// (it is in the README as a capability, and the rule is right for whatever
// writes to it) — but it gets tested rather than assumed.
//
// Runs the real platedAuth gate with a real API key rather than stubbing it,
// since the key-to-profile resolution is part of what makes this endpoint
// safe to expose without a session.

process.env.DB_PATH = ':memory:';

const { test, before } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

const { db, init } = require('./db');
const accounts = require('./accounts');

let server;
let base;
let profileId;
let apiKey;

async function post(path, body, key = apiKey) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-API-Key': key },
    body: JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty */ }
  return { status: res.status, body: json };
}

function rowsFor(day) {
  return db
    .prepare("SELECT weight, source, notes FROM bodyweights WHERE profile_id = ? AND date(logged_at) = ? ORDER BY id")
    .all(profileId, day);
}

before(async () => {
  init();
  const made = accounts.createProfile({ name: 'Pat', passcode: '1234', accent_color: '#e8643c' });
  profileId = made.profile.id;
  apiKey = db.prepare('SELECT api_key FROM profiles WHERE id = ?').get(profileId).api_key;
  // The tz offset the handler reads to resolve a local day. 0 keeps the
  // fixture's dates and the stored timestamps in the same frame, so a failure
  // here is about ownership rather than about timezone arithmetic — that is
  // tested separately by the date-bucketing assertions in the route itself.
  db.prepare("INSERT INTO app_settings (profile_id, key, value) VALUES (?, 'nudge_tz_offset_minutes', '0')").run(profileId);

  const app = express();
  app.use(express.json());
  app.use('/api/plated', require('./routes/plated'));
  server = http.createServer(app);
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;
});

test.after(() => server?.close());

test('a push with no key is refused', async () => {
  const r = await post('/api/plated/bodyweight', { weight_kg: 80, date: '2026-09-10' }, 'not-a-key');
  assert.strictEqual(r.status, 401, 'an unknown API key was accepted');
  assert.strictEqual(r.body.success, false);
});

test('a first push inserts one row, marked as Plated-sourced', async () => {
  const r = await post('/api/plated/bodyweight', { weight_kg: 80.4, date: '2026-09-10' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.data.updated, false);

  const rows = rowsFor('2026-09-10');
  assert.strictEqual(rows.length, 1, `expected one row, got ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].source, 'plated', 'the row was not marked as Plated-sourced');
  assert.strictEqual(rows[0].weight, 80.4);
});

test('a second push for the same day corrects the row instead of adding one', async () => {
  const r = await post('/api/plated/bodyweight', { weight_kg: 80.9, date: '2026-09-10' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.data.updated, true, 'the push did not report correcting the existing row');

  const rows = rowsFor('2026-09-10');
  assert.strictEqual(rows.length, 1, `the day gained a second row: ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].weight, 80.9, 'the correction did not land');
});

// The branch with no live caller. Verified by mutation: removing the `manual`
// lookup and its early return in routes/plated.js makes this test fail — the
// day gains a second row, which is the invariant Plated asked us to hold.
test('a push leaves a day alone when the user weighed in by hand', async () => {
  db.prepare(
    "INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, notes, source) VALUES (?, 79.0, 'kg', '2026-09-11 07:00:00', 'morning', 'manual')"
  ).run(profileId);

  const r = await post('/api/plated/bodyweight', { weight_kg: 81.5, date: '2026-09-11' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.strictEqual(r.body.data.updated, false, 'the push claimed to have written something');
  assert.match(
    r.body.data.skipped || '',
    /manual weigh-in/,
    `the response did not explain why nothing was written: ${JSON.stringify(r.body.data)}`
  );

  const rows = rowsFor('2026-09-11');
  assert.strictEqual(rows.length, 1, `the day gained a second row: ${JSON.stringify(rows)}`);
  assert.strictEqual(rows[0].weight, 79.0, "the user's own weigh-in was overwritten");
  assert.strictEqual(rows[0].source, 'manual');
});

// The free-text hole this replaced: the old handler matched on
// `notes = 'via Plated'`, so a user who typed that phrase into their OWN note
// had the row treated as Plated's and silently overwritten. The note is now
// display text only.
test("a manual note reading 'via Plated' is not treated as Plated's row", async () => {
  db.prepare(
    "INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, notes, source) VALUES (?, 77.7, 'kg', '2026-09-12 07:00:00', 'via Plated', 'manual')"
  ).run(profileId);

  const r = await post('/api/plated/bodyweight', { weight_kg: 90.0, date: '2026-09-12' });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));

  const rows = rowsFor('2026-09-12');
  assert.strictEqual(rows.length, 1, `the day gained a second row: ${JSON.stringify(rows)}`);
  assert.strictEqual(
    rows[0].weight, 77.7,
    'a manual weigh-in whose NOTE says "via Plated" was overwritten — the hole the source column closed'
  );
});

test('a malformed push is a 400, not a 500, and writes nothing', async () => {
  for (const body of [{ weight_kg: 'heavy' }, { weight_kg: -5 }, { weight_kg: 80, date: '10-09-2026' }]) {
    const r = await post('/api/plated/bodyweight', body);
    assert.strictEqual(r.status, 400, `${JSON.stringify(body)} was not refused: ${JSON.stringify(r.body)}`);
    assert.strictEqual(r.body.success, false);
  }
  const all = db.prepare('SELECT COUNT(*) n FROM bodyweights WHERE profile_id = ?').get(profileId).n;
  assert.strictEqual(all, 3, `a malformed push wrote a row (${all} rows, expected 3)`);
});
