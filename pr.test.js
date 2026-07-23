'use strict';

// recomputePrsForExercise (pr.js) has zero existing coverage despite the
// tricky invariants documented in its own comments: warmups never count,
// assisted exercises invert "best" (less assistance wins, not more weight),
// and ties resolve to the OLDEST occurrence. A real in-memory SQLite DB is
// used rather than mocking — this logic is a handful of raw SQL queries, and
// a mock would just re-assert the mock instead of exercising the real thing.
process.env.DB_PATH = ':memory:';

const { test } = require('node:test');
const assert = require('node:assert');
const { db, init } = require('./db');
const { recomputePrsForExercise } = require('./pr');

init();

function makeProfile(name) {
  const info = db
    .prepare('INSERT INTO profiles (name, pass_hash, pass_salt, api_key) VALUES (?, ?, ?, ?)')
    .run(name, 'h', 's', `key-${name}-${Math.random()}`);
  return Number(info.lastInsertRowid);
}

// init() seeds a default exercise catalog (Bench Press, Squat, etc.), so a
// fixture must use a name that can't collide with it — the exercises table
// is UNIQUE on name.
function makeExercise(name, opts = {}) {
  const info = db
    .prepare(
      `INSERT INTO exercises (name, muscle_group, is_bodyweight, is_assisted, equipment, weight_mode)
       VALUES (?, ?, ?, ?, ?, ?)`
    )
    .run(`${name} (test)`, 'chest', opts.isBodyweight ? 1 : 0, opts.isAssisted ? 1 : 0, 'barbell', 'combined');
  return Number(info.lastInsertRowid);
}

function makeWorkout(profileId) {
  const info = db.prepare('INSERT INTO workouts (profile_id) VALUES (?)').run(profileId);
  return Number(info.lastInsertRowid);
}

function logSet(profileId, workoutId, exerciseId, { weight, reps, isWarmup = false, loggedAt }) {
  db.prepare(
    `INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, is_warmup, logged_at)
     VALUES (?, ?, ?, 1, ?, 'kg', ?, ?, ?)`
  ).run(profileId, workoutId, exerciseId, weight, reps, isWarmup ? 1 : 0, loggedAt || '2026-01-01 00:00:00');
}

function prsFor(profileId, exerciseId) {
  return db
    .prepare('SELECT weight, reps, set_id FROM personal_records WHERE profile_id = ? AND exercise_id = ? ORDER BY reps')
    .all(profileId, exerciseId);
}

test('picks the heaviest set per rep count, skipping warmups', () => {
  const profileId = makeProfile('A');
  const exerciseId = makeExercise('Bench Press');
  const workoutId = makeWorkout(profileId);
  logSet(profileId, workoutId, exerciseId, { weight: 40, reps: 5, isWarmup: true }); // must not win
  logSet(profileId, workoutId, exerciseId, { weight: 100, reps: 5 });
  logSet(profileId, workoutId, exerciseId, { weight: 90, reps: 5 });

  recomputePrsForExercise(profileId, exerciseId);

  const prs = prsFor(profileId, exerciseId);
  assert.strictEqual(prs.length, 1);
  assert.strictEqual(prs[0].weight, 100);
});

test('assisted exercise: LESS assistance is the better PR, not more weight', () => {
  const profileId = makeProfile('B');
  const exerciseId = makeExercise('Assisted Pull-up', { isAssisted: true });
  const workoutId = makeWorkout(profileId);
  logSet(profileId, workoutId, exerciseId, { weight: 30, reps: 8 }); // 30kg of assistance = easier
  logSet(profileId, workoutId, exerciseId, { weight: 10, reps: 8 }); // 10kg of assistance = harder, the real PR

  recomputePrsForExercise(profileId, exerciseId);

  const prs = prsFor(profileId, exerciseId);
  assert.strictEqual(prs.length, 1);
  // Less assistance (10kg) is the harder, better performance for an assisted exercise.
  assert.strictEqual(prs[0].weight, 10);
});

test('ties resolve to the OLDEST occurrence, not the most recent', () => {
  const profileId = makeProfile('C');
  const exerciseId = makeExercise('Overhead Press');
  const workoutId = makeWorkout(profileId);
  logSet(profileId, workoutId, exerciseId, { weight: 60, reps: 5, loggedAt: '2026-01-01 00:00:00' });
  const secondSetId = db.prepare('SELECT last_insert_rowid() as id').get().id;
  logSet(profileId, workoutId, exerciseId, { weight: 60, reps: 5, loggedAt: '2026-02-01 00:00:00' });

  recomputePrsForExercise(profileId, exerciseId);

  const prs = prsFor(profileId, exerciseId);
  assert.strictEqual(prs.length, 1);
  assert.strictEqual(prs[0].set_id, secondSetId, 'the first (oldest) set to hit this weight/reps should be the record holder');
});

test('a rep count with only a warmup set produces no PR row for it', () => {
  const profileId = makeProfile('D');
  const exerciseId = makeExercise('Squat');
  const workoutId = makeWorkout(profileId);
  logSet(profileId, workoutId, exerciseId, { weight: 100, reps: 3, isWarmup: true });

  recomputePrsForExercise(profileId, exerciseId);

  assert.strictEqual(prsFor(profileId, exerciseId).length, 0);
});

test('recompute is idempotent and profile-scoped (does not leak across profiles)', () => {
  const profileA = makeProfile('E1');
  const profileB = makeProfile('E2');
  const exerciseId = makeExercise('Deadlift');
  const workoutA = makeWorkout(profileA);
  logSet(profileA, workoutA, exerciseId, { weight: 150, reps: 3 });

  recomputePrsForExercise(profileA, exerciseId);
  recomputePrsForExercise(profileA, exerciseId); // running it twice must not duplicate rows

  assert.strictEqual(prsFor(profileA, exerciseId).length, 1);
  assert.strictEqual(prsFor(profileB, exerciseId).length, 0);
});
