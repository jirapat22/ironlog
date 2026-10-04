'use strict';

// Round-trip tests for GET /api/export and POST /api/import — the first tests
// in this repo that drive an HTTP endpoint rather than a pure function.
//
// Design borrowed from Plated's test/backup.test.mjs, which earned each case
// the hard way. The two load-bearing ideas:
//
//  1. `meaning()` — reduce an export to what it SAYS, with every id stripped
//     out and every reference resolved to a name. The import deliberately
//     remaps every id, so comparing ids compares the wrong thing. Two exports
//     that agree on `meaning` restored the same data whatever row numbers they
//     landed on. Without this a round-trip test can't assert equality at all,
//     and the usual fallback (compare per-table counts) passes happily while
//     the contents are wrong.
//
//  2. For a test whose whole job is "X must never happen", break the code so X
//     happens and confirm the test notices. Plated shipped an isolation test
//     asserting `day.sessions.length >= 2`, which passed even with the
//     profile scoping removed from their delete — it reported safety it did
//     not have.
//
// Every guard test here was verified that way rather than by reading it. Each
// mutation was applied alone, the named test run, the file restored:
//
//   routes/import.js  drop `profile_id = ?` from the bodyweight upsert lookup
//                       -> "a restore does not reach into another profile"      CAUGHT
//   routes/export.js  remove `notes` from the payload
//                       -> "the export carries every table ..."                 CAUGHT
//   routes/import.js  `if (!checked.ok)` -> `if (false)` (skip bounds)
//                       -> "a restore skips the sets ..."                        CAUGHT
//   routes/import.js  `if (!(privateInBackup && ownedByOther))` -> `if (true)`
//                       -> "a restored private exercise ..."                     CAUGHT
//   routes/import.js  `findBwDay.get(...)` -> `null` (blind insert)
//                       -> "restoring the same backup twice ..."                 CAUGHT
//
// Re-run these before trusting any of it after a refactor. A guard test that
// has stopped biting is worse than no test, because it still reports green.

process.env.DB_PATH = ':memory:';

const { test, before } = require('node:test');
const assert = require('node:assert');
const express = require('express');
const http = require('node:http');

const { db, init } = require('./db');
const accounts = require('./accounts');
const { PER_PROFILE_TABLES } = require('./accounts');

// ---------------------------------------------------------------------------
// Harness: the real routers, with the session gate replaced by a header so a
// test doesn't have to hold a cookie jar. Everything downstream of the gate
// only ever reads req.profileId / req.profile, which is exactly what the real
// requireProfile sets.
// ---------------------------------------------------------------------------
let server;
let base;

function buildApp() {
  const app = express();
  app.use(express.json({ limit: '50mb' }));
  app.use((req, res, next) => {
    const id = Number(req.headers['x-test-profile']);
    if (Number.isFinite(id) && id > 0) {
      req.profileId = id;
      req.profile = db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) || { id };
    }
    next();
  });
  app.use('/api/export', require('./routes/export'));
  app.use('/api/import', require('./routes/import'));
  app.use('/api/sets', require('./routes/sets'));
  app.use('/api/bodyweight', require('./routes/bodyweight'));
  app.use('/api/notes', require('./routes/notes'));
  return app;
}

async function as(profileId, method, path, body) {
  const res = await fetch(`${base}${path}`, {
    method,
    headers: { 'Content-Type': 'application/json', 'x-test-profile': String(profileId) },
    body: body === undefined ? undefined : JSON.stringify(body)
  });
  let json = null;
  try { json = await res.json(); } catch { /* empty body */ }
  return { status: res.status, body: json };
}

// ---------------------------------------------------------------------------
// What a backup MEANS, ids stripped. References resolve to names, every array
// is sorted (insert order is not meaning), and nulls are spelled out rather
// than dropped — a null that silently becomes 0 has to fail, and 'null' in the
// string is what makes it fail. Optional sections are guarded with `|| []` so
// this still works on a file that predates a feature.
// ---------------------------------------------------------------------------
function meaning(x) {
  const exName = new Map((x.exercises || []).map((e) => [e.id, e.name]));
  const nameOf = (id) => exName.get(id) ?? `#unknown:${id}`;

  return {
    workouts: (x.workouts || [])
      .map((w) => `${w.started_at}|${w.finished_at ?? 'null'}|${w.kind ?? 'null'}|${w.notes ?? 'null'}|${w.bw_kg ?? 'null'}`)
      .sort(),
    sets: (x.workouts || [])
      .flatMap((w) => (w.sets || []).map(
        (s) => `${w.started_at}|${nameOf(s.exercise_id)}|${s.set_number}|${s.weight}|${s.weight_unit}|${s.reps}|${s.is_warmup ? 1 : 0}|${s.load_multiplier ?? 'null'}`
      ))
      .sort(),
    programs: (x.programs || []).map((p) => `${p.name}|${p.description ?? 'null'}`).sort(),
    // Two hops deep: program -> day -> exercise slot, with the exercise
    // resolved to its name. This is the equivalent of Plated's preset -> item
    // -> food chain, and the place a remap is most likely to go wrong.
    program_slots: (x.programs || [])
      .flatMap((p) => (p.days || []).flatMap((d) => (d.exercises || []).map(
        (e) => `${p.name}|${d.day_label}|${nameOf(e.exercise_id)}|${e.target_sets}|${e.target_reps}`
      )))
      .sort(),
    bodyweights: (x.bodyweights || [])
      .map((b) => `${b.logged_at}|${b.weight}|${b.weight_unit}|${b.source ?? 'null'}`)
      .sort(),
    notes: (x.notes || []).map((n) => `${n.text}|${n.category}|${n.done ? 1 : 0}`).sort(),
    settings: x.settings || {}
  };
}

// ---------------------------------------------------------------------------
// Fixture: one profile holding one of everything the export claims to carry,
// plus a second profile to own a private exercise for the merge test.
// ---------------------------------------------------------------------------
let alice;
let bob;
let aliceFirstExport;

function seedFixture(profileId, { label }) {
  const exId = db.prepare('SELECT id FROM exercises WHERE name = ?').get('Bench Press')?.id
    ?? Number(db.prepare("INSERT INTO exercises (name, muscle_group) VALUES ('Bench Press', 'chest')").run().lastInsertRowid);

  const programId = Number(db.prepare(
    'INSERT INTO programs (profile_id, name, description, sort_order) VALUES (?, ?, ?, 0)'
  ).run(profileId, `${label} Program`, 'fixture').lastInsertRowid);
  const dayId = Number(db.prepare(
    'INSERT INTO program_days (program_id, day_label, day_order) VALUES (?, ?, 0)'
  ).run(programId, 'Push').lastInsertRowid);
  db.prepare(
    'INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index) VALUES (?, ?, 3, 8, 0)'
  ).run(dayId, exId);

  const workoutId = Number(db.prepare(
    `INSERT INTO workouts (profile_id, program_day_id, started_at, finished_at, notes, bw_kg, kind)
     VALUES (?, ?, '2026-09-01 10:00:00', '2026-09-01 11:00:00', ?, 80.5, 'strength')`
  ).run(profileId, dayId, `${label} session`).lastInsertRowid);

  db.prepare(
    `INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, is_warmup, logged_at, load_multiplier)
     VALUES (?, ?, ?, 1, 100, 'kg', 5, 0, '2026-09-01 10:10:00', 1)`
  ).run(profileId, workoutId, exId);
  db.prepare(
    `INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, is_warmup, logged_at, load_multiplier)
     VALUES (?, ?, ?, 2, 40, 'kg', 10, 1, '2026-09-01 10:05:00', 1)`
  ).run(profileId, workoutId, exId);

  db.prepare(
    "INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, notes, source) VALUES (?, 80.5, 'kg', '2026-09-01 07:00:00', NULL, 'manual')"
  ).run(profileId);
  db.prepare(
    "INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, notes, source) VALUES (?, 80.1, 'kg', '2026-09-02 07:00:00', 'via Plated', 'plated')"
  ).run(profileId);

  db.prepare(
    "INSERT INTO notes (profile_id, text, category, done) VALUES (?, ?, 'idea', 0)"
  ).run(profileId, `${label} wants drop sets`);

  db.prepare(
    "INSERT INTO app_settings (profile_id, key, value) VALUES (?, 'profile_height_cm', '180')"
  ).run(profileId);

  return { exId, programId, dayId, workoutId };
}

before(async () => {
  init();
  alice = accounts.createProfile({ name: 'Alice', passcode: '1111', accent_color: '#e8643c' }).profile.id;
  bob = accounts.createProfile({ name: 'Bob', passcode: '2222', accent_color: '#3c8ae8' }).profile.id;

  server = http.createServer(buildApp());
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${server.address().port}`;

  seedFixture(alice, { label: 'Alice' });
  aliceFirstExport = (await as(alice, 'GET', '/api/export')).body;
});

test.after(() => server?.close());

// ---------------------------------------------------------------------------
// Case 1 — the class catcher. `export ⊇ delete` is the invariant: every table
// that deleting a profile removes must be in the backup, or export -> delete
// -> restore loses it silently.
//
// Derived from accounts.PER_PROFILE_TABLES, which is the list the delete step
// itself reads, rather than from a hand-maintained list of keys. A hand-kept
// list catches a key going MISSING; deriving it catches a new table never
// being added at all — which is how the standalone `notes` table came to be
// deleted on profile delete but absent from every backup.
// ---------------------------------------------------------------------------

// Table -> the export key that carries it. `sets` is nested inside each
// workout row rather than top-level, and the app_settings table is spelled
// `settings` in the payload.
const COVERED_BY = {
  workouts: 'workouts',
  sets: 'workouts',
  bodyweights: 'bodyweights',
  personal_records: 'personal_records',
  notes: 'notes',
  app_settings: 'settings',
  programs: 'programs'
};

// Deliberate omissions, each with its reason. The point of an exemption list
// over a silent default is that adding a table to PER_PROFILE_TABLES then
// FORCES a decision: export it, or write down here why not.
const EXPORT_EXEMPT = new Map([
  ['push_subscriptions', 'device-bound: a restored push endpoint is already dead, so exporting it would be worse than useless']
]);

test('the export carries every table that deleting a profile removes', () => {
  for (const table of PER_PROFILE_TABLES) {
    if (EXPORT_EXEMPT.has(table)) {
      assert.ok(EXPORT_EXEMPT.get(table).length > 20, `${table} is exempt but the reason is too thin to review`);
      continue;
    }
    const key = COVERED_BY[table];
    assert.ok(
      key,
      `${table} is deleted with a profile but nothing says which export key carries it. ` +
      `Add it to the export and map it here, or add it to EXPORT_EXEMPT with a reason.`
    );
    assert.ok(key in aliceFirstExport, `export is missing "${key}" (covers table ${table})`);
  }
});

test('the fixture data actually reaches the file, not just the keys', () => {
  const m = meaning(aliceFirstExport);
  assert.strictEqual(m.workouts.length, 1, 'the workout did not make the file');
  assert.strictEqual(m.sets.length, 2, `expected 1 working set + 1 warmup, got ${JSON.stringify(m.sets)}`);
  // Containment, not a count: creating a profile seeds it editable copies of
  // the default splits, so the fixture program is one among several.
  assert.ok(
    m.programs.some((s) => s.startsWith('Alice Program|')),
    'the fixture program did not make the file: ' + JSON.stringify(m.programs)
  );
  assert.ok(
    m.program_slots.includes('Alice Program|Push|Bench Press|3|8'),
    'the fixture program day exercise slot did not make the file: ' + JSON.stringify(m.program_slots)
  );
  assert.strictEqual(m.bodyweights.length, 2, 'a weigh-in did not make the file');
  assert.deepStrictEqual(m.notes, ['Alice wants drop sets|idea|0'], 'the notes list did not make the file');
  assert.strictEqual(m.settings.profile_height_cm, '180', 'settings did not make the file');
});

test('a weigh-in keeps its source through a round trip', () => {
  const m = meaning(aliceFirstExport);
  assert.ok(
    m.bodyweights.some((b) => b.endsWith('|plated')),
    `the Plated-sourced weigh-in lost its source: ${JSON.stringify(m.bodyweights)}`
  );
  assert.ok(
    m.bodyweights.some((b) => b.endsWith('|manual')),
    `the manual weigh-in lost its source: ${JSON.stringify(m.bodyweights)}`
  );
});

// ---------------------------------------------------------------------------
// Case 5 — a restore must not reach into another profile. This is the worst
// bug available in this route, and the one with no test anywhere until now.
//
// Verified by mutation (see the header): dropping `profile_id = ?` from the
// bodyweight upsert lookup in routes/import.js fails this test and no other.
// It is written as a full `meaning` comparison rather than a count because a
// count is what let the equivalent test pass on Plated's side while their
// scoping was broken.
// ---------------------------------------------------------------------------
test('a restore does not reach into another profile', async () => {
  const r = await as(bob, 'POST', '/api/import', aliceFirstExport);
  assert.strictEqual(r.status, 200, `Bob's import failed: ${JSON.stringify(r.body)}`);

  const aliceNow = (await as(alice, 'GET', '/api/export')).body;
  assert.deepStrictEqual(
    meaning(aliceNow),
    meaning(aliceFirstExport),
    "Bob's restore changed Alice's data"
  );
});

test('a restore onto a different profile moves the whole thing across', async () => {
  const bobNow = (await as(bob, 'GET', '/api/export')).body;
  const b = meaning(bobNow);
  const a = meaning(aliceFirstExport);

  // Bob had none of these before the restore, so they must match exactly.
  assert.deepStrictEqual(b.sets, a.sets, "Bob did not get Alice's sets");
  assert.deepStrictEqual(b.notes, a.notes, 'the notes list did not cross over');
  assert.deepStrictEqual(b.bodyweights, a.bodyweights, 'the weigh-ins did not cross over');

  // Programs are a CONTAINMENT check, not equality: creating a profile seeds
  // it its own editable copies of the default splits, so Bob already had
  // programs of his own and the restore adds Alice's on top. A first draft
  // asserted equality here and failed for a reason unrelated to the import.
  for (const slot of a.program_slots) {
    assert.ok(b.program_slots.includes(slot), 'the two-hop program slot remap lost ' + slot);
  }
});

// ---------------------------------------------------------------------------
// Bodyweights are the one table the import upserts rather than adds, because
// both live writers hold one row per profile per local day. A blind insert
// broke that from outside, and Plated then had two readings for one date with
// query order deciding which it kept.
// ---------------------------------------------------------------------------
test('restoring the same backup twice does not duplicate weigh-ins', async () => {
  const before = (await as(bob, 'GET', '/api/export')).body.bodyweights.length;
  await as(bob, 'POST', '/api/import', aliceFirstExport);
  const after = (await as(bob, 'GET', '/api/export')).body;

  assert.strictEqual(
    after.bodyweights.length, before,
    `a second restore minted duplicate weigh-ins: ${before} -> ${after.bodyweights.length}`
  );
  const days = after.bodyweights.map((b) => String(b.logged_at).slice(0, 10));
  assert.strictEqual(new Set(days).size, days.length, `two rows share a day: ${days.join(', ')}`);
});

// ---------------------------------------------------------------------------
// Rule 6 — the restore must re-run the rules the live route enforces. These
// bounds were module-local constants in routes/sets.js, so the import could
// not reach them and every one was bypassable through an edited backup file.
// ---------------------------------------------------------------------------
test('the live route rejects a set the bounds forbid', async () => {
  const w = db.prepare('SELECT id FROM workouts WHERE profile_id = ? LIMIT 1').get(alice).id;
  const ex = db.prepare('SELECT id FROM exercises LIMIT 1').get().id;

  const huge = await as(alice, 'POST', '/api/sets', {
    workout_id: w, exercise_id: ex, set_number: 1, weight: 1e9, reps: 5
  });
  assert.strictEqual(huge.status, 400, 'a 1e9 kg set was accepted by the live route');

  const texty = await as(alice, 'POST', '/api/sets', {
    workout_id: w, exercise_id: ex, set_number: 1, weight: '70abc', reps: 5
  });
  assert.strictEqual(texty.status, 400, 'text in the weight field was accepted by the live route');
});

test('a restore skips the sets the live route would have rejected, and says so', async () => {
  // A hand-edited backup: one good set, three the live route would refuse.
  const file = JSON.parse(JSON.stringify(aliceFirstExport));
  const w = file.workouts[0];
  const exId = w.sets[0].exercise_id;
  w.sets = [
    { exercise_id: exId, set_number: 1, weight: 100, weight_unit: 'kg', reps: 5, is_warmup: 0, logged_at: '2026-09-01 10:10:00', load_multiplier: 1 },
    { exercise_id: exId, set_number: 2, weight: 1e9, weight_unit: 'kg', reps: 5, is_warmup: 0, logged_at: '2026-09-01 10:11:00', load_multiplier: 1 },
    { exercise_id: exId, set_number: 3, weight: '70abc', weight_unit: 'kg', reps: 5, is_warmup: 0, logged_at: '2026-09-01 10:12:00', load_multiplier: 1 },
    { exercise_id: exId, set_number: 1e9, weight: 100, weight_unit: 'kg', reps: 5, is_warmup: 0, logged_at: '2026-09-01 10:13:00', load_multiplier: 1 }
  ];
  file.bodyweights = [];
  file.notes = [];

  const target = accounts.createProfile({ name: 'Carl', passcode: '3333', accent_color: '#8ae83c' }).profile.id;
  const r = await as(target, 'POST', '/api/import', file);

  assert.strictEqual(r.status, 200, `import failed outright: ${JSON.stringify(r.body)}`);
  assert.strictEqual(r.body.imported_sets, 1, 'the bad sets were not skipped');
  assert.strictEqual(r.body.skipped.sets_invalid, 3, `expected 3 invalid, got ${JSON.stringify(r.body.skipped)}`);
  assert.match(r.body.warning, /not a valid number/, 'the response did not say why sets were dropped');

  // And nothing absurd actually landed.
  const rows = db.prepare('SELECT weight, reps, set_number, typeof(weight) tw FROM sets WHERE profile_id = ?').all(target);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].tw, 'real', `a non-numeric weight was stored as ${rows[0].tw}`);
  assert.ok(rows[0].set_number <= 100, 'an out-of-range set_number was stored');
});

// ---------------------------------------------------------------------------
// Rule 5 — the private-row merge. Plated's note on this carried: the merge is
// invisible at restore time, because both rows still exist. The damage only
// appears when something later resolves THROUGH the merged row — for them,
// grams returning to the wrong pot; for us, personal records recomputed over
// two profiles' sets, handing someone a PR they never lifted.
// ---------------------------------------------------------------------------
test("a restored private exercise does not attach to another profile's", async () => {
  // Bob owns a private exercise. Alice's backup contains one of the same name,
  // also private — the real-world route to this is a backup from before Bob
  // created his, or from another install entirely.
  // A name the 131-exercise seed catalog does not already hold. The first
  // draft used "Landmine Press", which IS seeded — so the premise (this name
  // is private to Bob) was false and the insert hit the UNIQUE constraint.
  const PRIVATE_NAME = 'Zercher Carry (test)';
  assert.strictEqual(
    db.prepare('SELECT COUNT(*) n FROM exercises WHERE name = ?').get(PRIVATE_NAME).n, 0,
    'the fixture name is already in the catalog, so this test proves nothing'
  );
  const bobsId = Number(db.prepare(
    'INSERT INTO exercises (name, muscle_group, created_by_profile_id) VALUES (?, ?, ?)'
  ).run(PRIVATE_NAME, 'shoulders', bob).lastInsertRowid);

  const file = JSON.parse(JSON.stringify(aliceFirstExport));
  file.exercises = [{
    id: 90001, name: PRIVATE_NAME, muscle_group: 'shoulders',
    equipment: 'barbell', weight_mode: 'combined',
    is_bodyweight: 0, is_assisted: 0, created_by_profile_id: 4242
  }];
  file.programs = [];
  file.bodyweights = [];
  file.notes = [];
  file.workouts = [{
    started_at: '2026-09-05 10:00:00', finished_at: '2026-09-05 11:00:00',
    kind: 'strength', notes: null, bw_kg: 80, program_day_id: null,
    sets: [{
      exercise_id: 90001, set_number: 1, weight: 60, weight_unit: 'kg',
      reps: 8, is_warmup: 0, logged_at: '2026-09-05 10:10:00', load_multiplier: 1
    }]
  }];

  const dana = accounts.createProfile({ name: 'Dana', passcode: '4444', accent_color: '#e83c8a' }).profile.id;
  const r = await as(dana, 'POST', '/api/import', file);
  assert.strictEqual(r.status, 200, `import failed: ${JSON.stringify(r.body)}`);

  // The set must NOT have landed on Bob's exercise.
  const onBobs = db.prepare('SELECT COUNT(*) n FROM sets WHERE exercise_id = ?').get(bobsId).n;
  assert.strictEqual(onBobs, 0, "Dana's restored set attached to Bob's private exercise");

  // It must have landed somewhere, owned by Dana — a restore that silently
  // drops the set is the other way to fail this.
  const danaSets = db.prepare(
    `SELECT s.id, e.name, e.created_by_profile_id FROM sets s
     JOIN exercises e ON e.id = s.exercise_id WHERE s.profile_id = ?`
  ).all(dana);
  assert.strictEqual(danaSets.length, 1, `Dana's set went missing: ${JSON.stringify(danaSets)}`);
  assert.strictEqual(danaSets[0].created_by_profile_id, dana, 'the restored exercise is not owned by Dana');
  assert.ok(r.body.renamed_exercises.length === 1, 'the rename was not reported');

  // The PR amplifier: Bob must not be credited with a record off Dana's set.
  const bobPrs = db.prepare('SELECT COUNT(*) n FROM personal_records WHERE profile_id = ? AND exercise_id = ?')
    .get(bob, bobsId).n;
  assert.strictEqual(bobPrs, 0, 'Bob was handed a personal record he never lifted');
});

test('a restored custom exercise stays private, not promoted to the shared catalog', async () => {
  const file = JSON.parse(JSON.stringify(aliceFirstExport));
  file.exercises = [{
    id: 90002, name: 'Dana Special', muscle_group: 'back',
    equipment: 'cable', weight_mode: 'combined',
    is_bodyweight: 0, is_assisted: 0, created_by_profile_id: 777
  }];
  file.programs = [];
  file.workouts = [];
  file.bodyweights = [];
  file.notes = [];

  const erin = accounts.createProfile({ name: 'Erin', passcode: '5555', accent_color: '#3ce8c8' }).profile.id;
  const r = await as(erin, 'POST', '/api/import', file);
  assert.strictEqual(r.status, 200, `import failed: ${JSON.stringify(r.body)}`);

  const row = db.prepare('SELECT created_by_profile_id FROM exercises WHERE name = ?').get('Dana Special');
  assert.ok(row, 'the custom exercise was not restored at all');
  assert.strictEqual(
    row.created_by_profile_id, erin,
    'a private exercise was promoted into the shared catalog, where it shows in everyone\'s picker'
  );
});

// ---------------------------------------------------------------------------
// Rule 2 — absent is not empty. Does not currently apply to us, because the
// import only ADDS and so has no delete step to get wrong. Asserted anyway, so
// that if anyone ever switches this route to replace semantics, the thing that
// has to be got right per-section fails loudly here first instead of quietly
// deleting data the backup predates.
// ---------------------------------------------------------------------------
test('a backup taken before notes existed leaves the ones you have alone', async () => {
  const frank = accounts.createProfile({ name: 'Frank', passcode: '6666', accent_color: '#e8c83c' }).profile.id;
  await as(frank, 'POST', '/api/notes', { text: 'keep me', category: 'idea' });

  const old = JSON.parse(JSON.stringify(aliceFirstExport));
  delete old.notes;          // a file from before the feature
  old.workouts = [];
  old.programs = [];
  old.bodyweights = [];

  const r = await as(frank, 'POST', '/api/import', old);
  assert.strictEqual(r.status, 200, `import failed: ${JSON.stringify(r.body)}`);

  const kept = db.prepare('SELECT text FROM notes WHERE profile_id = ?').all(frank).map((n) => n.text);
  assert.deepStrictEqual(kept, ['keep me'], 'a file with no notes section removed the notes that were there');
});
