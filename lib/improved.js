'use strict';

const { db } = require('../db');

function toKg(weight, unit) {
  return unit === 'lbs' ? weight * 0.45359237 : weight;
}

function effLoadKg(weight, weightUnit, ex, bwKg) {
  const kg = toKg(weight, weightUnit);
  if (ex.is_assisted && bwKg) return Math.max(0, bwKg - kg);
  if (ex.is_bodyweight && bwKg) return kg + bwKg;
  return kg;
}

const KG_EPS = 0.01;

// For every non-warmup set of `exerciseId` within `workoutId`, works out which
// ones (if any) beat the best set from the exercise's most recently FINISHED
// session before this workout — more effective load, or the same load with
// more reps. Computed durably here (not client-side, and not just at log
// time) so it survives a reload/backgrounding mid-workout and reads
// consistently in History afterward — a client-only ephemeral flag was
// silently lost the moment anything forced a re-fetch of the workout.
//
// Only the chronologically first qualifying set is flagged: once a session
// has shown it beats last time, a later set repeating the same numbers isn't
// new information.
//
// Returns Map<set_id, {type:'weight', priorWeight, priorUnit} | {type:'reps', priorReps}>.
function computeImprovedFlags(profileId, exerciseId, workoutId) {
  const ex = db.prepare('SELECT is_bodyweight, is_assisted FROM exercises WHERE id = ?').get(exerciseId);
  const thisWorkout = db.prepare('SELECT id, bw_kg, started_at FROM workouts WHERE id = ?').get(workoutId);
  if (!ex || !thisWorkout) return new Map();

  const priorWorkout = db.prepare(
    `SELECT w.id, w.bw_kg FROM workouts w
       JOIN sets s ON s.workout_id = w.id AND s.exercise_id = ? AND s.is_warmup = 0
      WHERE w.profile_id = ? AND w.finished_at IS NOT NULL
        AND (w.started_at < ? OR (w.started_at = ? AND w.id < ?))
      ORDER BY w.started_at DESC, w.id DESC LIMIT 1`
  ).get(exerciseId, profileId, thisWorkout.started_at, thisWorkout.started_at, thisWorkout.id);
  if (!priorWorkout) return new Map();

  const priorSets = db.prepare(
    `SELECT weight, weight_unit, reps FROM sets WHERE workout_id = ? AND exercise_id = ? AND is_warmup = 0`
  ).all(priorWorkout.id, exerciseId);

  let bestPrior = null, bestPriorKg = -Infinity;
  for (const s of priorSets) {
    const kg = effLoadKg(s.weight, s.weight_unit, ex, priorWorkout.bw_kg);
    if (kg > bestPriorKg) { bestPriorKg = kg; bestPrior = s; }
  }
  if (!bestPrior) return new Map();

  const thisSets = db.prepare(
    `SELECT id, weight, weight_unit, reps FROM sets
      WHERE workout_id = ? AND exercise_id = ? AND is_warmup = 0
      ORDER BY set_number ASC, id ASC`
  ).all(workoutId, exerciseId);

  const flags = new Map();
  for (const s of thisSets) {
    const kg = effLoadKg(s.weight, s.weight_unit, ex, thisWorkout.bw_kg);
    let result = null;
    if (kg > bestPriorKg + KG_EPS) {
      result = { type: 'weight', priorWeight: bestPrior.weight, priorUnit: bestPrior.weight_unit };
    } else if (Math.abs(kg - bestPriorKg) <= KG_EPS && s.reps > bestPrior.reps) {
      result = { type: 'reps', priorReps: bestPrior.reps };
    }
    if (result) { flags.set(s.id, result); break; }
  }
  return flags;
}

// Same durable pattern as computeImprovedFlags, for is_new_pr: personal_records
// is already the durable store (checkAndUpdatePR in routes/sets.js keeps it
// current), this just reads it back keyed by set_id — mirrors the is_pr lookup
// routes/workouts.js's GET /:id/sets already does for History.
function personalRecordSetIds(profileId, exerciseIds) {
  if (!exerciseIds.length) return new Set();
  const rows = db.prepare(
    `SELECT set_id FROM personal_records
      WHERE profile_id = ? AND exercise_id IN (${exerciseIds.map(() => '?').join(',')}) AND set_id IS NOT NULL`
  ).all(profileId, ...exerciseIds);
  return new Set(rows.map((r) => r.set_id));
}

module.exports = { computeImprovedFlags, personalRecordSetIds };
