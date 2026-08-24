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
    .run(`${name} (test)`, 'chest', opts.isBodyweight ? 1 : 0, opts.isAssisted ? 1 : 0, 'barbell', opts.weightMode || 'combined');
  return Number(info.lastInsertRowid);
}

function makeWorkout(profileId) {
  const info = db.prepare('INSERT INTO workouts (profile_id) VALUES (?)').run(profileId);
  return Number(info.lastInsertRowid);
}

function logSet(profileId, workoutId, exerciseId, { weight, reps, isWarmup = false, loggedAt, loadMultiplier = null }) {
  const info = db.prepare(
    `INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, is_warmup, logged_at, load_multiplier)
     VALUES (?, ?, ?, 1, ?, 'kg', ?, ?, ?, ?)`
  ).run(profileId, workoutId, exerciseId, weight, reps, isWarmup ? 1 : 0, loggedAt || '2026-01-01 00:00:00', loadMultiplier);
  return Number(info.lastInsertRowid);
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

// ---------------------------------------------------------------------------
// Mixed load_multiplier history — an exercise logged under BOTH weight modes.
// This is not an exotic state: choosing "Just going forward" on a weight-mode
// flip (the cancel option on the first confirm step) produces it every time.
//
// recomputePrsForExercise (pr.js) and checkAndUpdatePR (routes/sets.js) are
// two independent implementations of "which set holds the record", and they
// must agree. Tests that only drive recompute do NOT guard that agreement —
// pr.js is unchanged by the fix, so such a test passes against the broken
// code too. Every test below that claims to guard checkAndUpdatePR calls it.
// ---------------------------------------------------------------------------
const { checkAndUpdatePR } = require('./routes/sets');

// Guards pr.js's per-row COALESCE ranking (d8c3332), not checkAndUpdatePR.
test('recompute ranks by EFFECTIVE load, not the raw number', () => {
  const profileId = makeProfile('F1');
  const exerciseId = makeExercise('Single-Arm Row', { weightMode: 'per_arm' });
  const workoutId = makeWorkout(profileId);
  logSet(profileId, workoutId, exerciseId, { weight: 40, reps: 8, loadMultiplier: 1 });
  const winner = logSet(profileId, workoutId, exerciseId, { weight: 21, reps: 8, loadMultiplier: 2 });

  recomputePrsForExercise(profileId, exerciseId);

  const prs = prsFor(profileId, exerciseId);
  assert.strictEqual(prs.length, 1);
  assert.strictEqual(prs[0].weight, 21);
  assert.strictEqual(prs[0].set_id, winner);
});

test('checkAndUpdatePR and recompute agree on the holder', () => {
  const profileId = makeProfile('F2');
  const exerciseId = makeExercise('Cable Curl', { weightMode: 'per_arm' });
  const workoutId = makeWorkout(profileId);

  const first = logSet(profileId, workoutId, exerciseId, { weight: 40, reps: 8, loadMultiplier: 1 });
  checkAndUpdatePR(profileId, exerciseId, 40, 'kg', 8, first, 1);
  assert.strictEqual(prsFor(profileId, exerciseId)[0].weight, 40);

  // 21 x2 = 42 effective, beating the 40kg combined-era set on real load.
  // Pre-fix this compared 42 against 40*2=80 and refused, then a recompute
  // ranked 42 > 40 and silently moved the record — the regression.
  const second = logSet(profileId, workoutId, exerciseId, { weight: 21, reps: 8, loadMultiplier: 2 });
  checkAndUpdatePR(profileId, exerciseId, 21, 'kg', 8, second, 2);
  const afterLogging = prsFor(profileId, exerciseId);
  assert.strictEqual(afterLogging[0].set_id, second, 'the heavier effective lift takes the record');

  recomputePrsForExercise(profileId, exerciseId);
  assert.deepStrictEqual(
    prsFor(profileId, exerciseId).map((r) => [r.weight, r.reps, r.set_id]),
    afterLogging.map((r) => [r.weight, r.reps, r.set_id]),
    'recomputePrsForExercise disagreed with checkAndUpdatePR'
  );
});

test('checkAndUpdatePR reads the RECORD holder\'s multiplier, not the incoming set\'s', () => {
  const profileId = makeProfile('F3');
  const exerciseId = makeExercise('Lateral Raise', { weightMode: 'per_arm' });
  const workoutId = makeWorkout(profileId);

  // Record is held by a per-arm set: 25 x2 = 50kg effective.
  const holder = logSet(profileId, workoutId, exerciseId, { weight: 25, reps: 8, loadMultiplier: 2 });
  checkAndUpdatePR(profileId, exerciseId, 25, 'kg', 8, holder, 2);
  assert.strictEqual(prsFor(profileId, exerciseId)[0].set_id, holder);

  // Now a combined-era set of 30kg = 30kg effective. Strictly weaker.
  // Pre-fix scaled the EXISTING record by the INCOMING set's multiplier
  // (25 * 1 = 25), so 30 > 25 handed it the record. It must not.
  const weaker = logSet(profileId, workoutId, exerciseId, { weight: 30, reps: 8, loadMultiplier: 1 });
  checkAndUpdatePR(profileId, exerciseId, 30, 'kg', 8, weaker, 1);
  assert.strictEqual(prsFor(profileId, exerciseId)[0].set_id, holder, 'a weaker effective lift stole the record');

  recomputePrsForExercise(profileId, exerciseId);
  assert.strictEqual(prsFor(profileId, exerciseId)[0].set_id, holder);
});

test('uniform multipliers behave exactly as before (per-arm cancels out)', () => {
  const profileId = makeProfile('F4');
  const exerciseId = makeExercise('DB Press', { weightMode: 'per_arm' });
  const workoutId = makeWorkout(profileId);
  const weak = logSet(profileId, workoutId, exerciseId, { weight: 30, reps: 5, loadMultiplier: 2 });
  checkAndUpdatePR(profileId, exerciseId, 30, 'kg', 5, weak, 2);
  const best = logSet(profileId, workoutId, exerciseId, { weight: 35, reps: 5, loadMultiplier: 2 });
  checkAndUpdatePR(profileId, exerciseId, 35, 'kg', 5, best, 2);

  assert.strictEqual(prsFor(profileId, exerciseId)[0].set_id, best);
  recomputePrsForExercise(profileId, exerciseId);
  const prs = prsFor(profileId, exerciseId);
  assert.strictEqual(prs[0].weight, 35);
  assert.strictEqual(prs[0].set_id, best);
});

// ---------------------------------------------------------------------------
// is_new_pr (the in-workout banner) vs the records table.
// ---------------------------------------------------------------------------

test('a bodyweight DELOAD is not a PR (zero added weight is the lightest variant)', () => {
  const profileId = makeProfile('G1');
  const exerciseId = makeExercise('Weighted Pull-Up', { isBodyweight: true });
  const workoutId = makeWorkout(profileId);

  const weighted = logSet(profileId, workoutId, exerciseId, { weight: 20, reps: 12, loadMultiplier: 1 });
  assert.strictEqual(checkAndUpdatePR(profileId, exerciseId, 20, 'kg', 12, weighted, 1), true);

  // Same reps with NO belt is strictly easier. The isZeroLoad branch used to
  // fire for any bodyweight exercise and compare only against records at
  // weight = 0, so this returned "New PR!" while History's trophy (keyed on
  // set_id) correctly stayed on the 20kg set.
  const bare = logSet(profileId, workoutId, exerciseId, { weight: 0, reps: 12, loadMultiplier: 1 });
  assert.strictEqual(checkAndUpdatePR(profileId, exerciseId, 0, 'kg', 12, bare, 1), false, 'deload reported as a PR');
  assert.strictEqual(prsFor(profileId, exerciseId)[0].set_id, weighted);
});

test('an ASSISTED exercise still treats zero assistance as the hardest variant', () => {
  const profileId = makeProfile('G2');
  const exerciseId = makeExercise('Assisted Dip', { isBodyweight: true, isAssisted: true });
  const workoutId = makeWorkout(profileId);

  const helped = logSet(profileId, workoutId, exerciseId, { weight: 30, reps: 8, loadMultiplier: 1 });
  checkAndUpdatePR(profileId, exerciseId, 30, 'kg', 8, helped, 1);

  // 0 assistance = unassisted = the hardest. Must still count.
  const unassisted = logSet(profileId, workoutId, exerciseId, { weight: 0, reps: 8, loadMultiplier: 1 });
  assert.strictEqual(checkAndUpdatePR(profileId, exerciseId, 0, 'kg', 8, unassisted, 1), true);
  assert.strictEqual(prsFor(profileId, exerciseId)[0].set_id, unassisted);
});
