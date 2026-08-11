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

// Session-over-session "improved" flags for possibly MANY exercises within
// one workout, in a bounded number of queries — not one round-trip per
// exercise. Mirrors the batched prior-session lookup GET /:id/sets already
// uses for trend_status (one query across all exerciseIds, grouped in JS)
// rather than re-querying per exercise the way an earlier version of this
// file did.
//
// `workout` must be the already-loaded workout row — {id, bw_kg,
// started_at} — every caller has this in scope already, so it's passed in
// instead of re-fetched.
//
// For each exercise, works out which of THIS workout's non-warmup sets (if
// any) beat the best set from that exercise's most recently FINISHED
// session before this workout — more effective load, or the same load with
// more reps. Only the chronologically first qualifying set per exercise is
// flagged: once a session has shown it beats last time, a later set
// repeating the same numbers isn't new information.
//
// Returns Map<exerciseId, Map<setId, {type:'weight', priorWeight, priorUnit} | {type:'reps', priorReps}>>.
function computeImprovedFlagsBatch(profileId, workout, exerciseIds) {
  const ids = [...new Set(exerciseIds)];
  const result = new Map(ids.map((id) => [id, new Map()]));
  if (!ids.length) return result;

  const exercises = db.prepare(
    `SELECT id, is_bodyweight, is_assisted FROM exercises WHERE id IN (${ids.map(() => '?').join(',')})`
  ).all(...ids);
  const exById = new Map(exercises.map((e) => [e.id, e]));

  // workouts.bw_kg is only snapshotted at finish time — NULL for the entire
  // duration of the still-open workout this function exists to help with.
  // Without a fallback, a bodyweight/assisted exercise would compare raw
  // added weight (today, workout open) against a full bodyweight-inclusive
  // load (prior session, already finished) — never comparable, so the flag
  // could never fire until after the workout ends. Falls back to the same
  // latest-bodyweight lookup the finish handler itself uses; resolved at
  // most once per batch call (not once per exercise/prior-workout), since
  // it's a profile-wide fact, not an exercise-specific one.
  let bwFallback, bwFallbackLoaded = false;
  const resolveBw = (bwKg) => {
    if (bwKg != null) return bwKg;
    if (!bwFallbackLoaded) {
      const latest = db.prepare(
        `SELECT weight, weight_unit FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC LIMIT 1`
      ).get(profileId);
      bwFallback = latest ? toKg(latest.weight, latest.weight_unit) : null;
      bwFallbackLoaded = true;
    }
    return bwFallback;
  };

  // One query for every candidate prior set across ALL exercises, ordered by
  // recency — same shape as GET /:id/sets's priorRows. Grouped below to keep
  // only each exercise's single most recent PRIOR (finished, strictly
  // earlier) workout's sets.
  const priorRows = db.prepare(
    `SELECT s.exercise_id, s.weight, s.weight_unit, s.reps, w.id AS workout_id, w.bw_kg
       FROM sets s
       JOIN workouts w ON w.id = s.workout_id
      WHERE s.profile_id = ? AND s.is_warmup = 0 AND w.finished_at IS NOT NULL
        AND (w.started_at < ? OR (w.started_at = ? AND w.id < ?))
        AND s.exercise_id IN (${ids.map(() => '?').join(',')})
      ORDER BY w.started_at DESC, w.id DESC`
  ).all(profileId, workout.started_at, workout.started_at, workout.id, ...ids);

  // exercise_id -> best (highest effective-kg) set from its most recent
  // prior workout. priorRows is globally ordered by recency, so the FIRST
  // workout_id encountered per exercise IS that exercise's most recent
  // prior session; rows from any other (older) workout_id are ignored.
  const bestPriorByExercise = new Map();
  for (const row of priorRows) {
    let entry = bestPriorByExercise.get(row.exercise_id);
    if (!entry) {
      entry = { workoutId: row.workout_id, bestSet: null, bestKg: -Infinity };
      bestPriorByExercise.set(row.exercise_id, entry);
    }
    if (entry.workoutId !== row.workout_id) continue;
    const ex = exById.get(row.exercise_id);
    if (!ex) continue;
    const kg = effLoadKg(row.weight, row.weight_unit, ex, resolveBw(row.bw_kg));
    if (kg > entry.bestKg) { entry.bestKg = kg; entry.bestSet = row; }
  }

  const thisSets = db.prepare(
    `SELECT id, exercise_id, weight, weight_unit, reps FROM sets
      WHERE workout_id = ? AND is_warmup = 0 AND exercise_id IN (${ids.map(() => '?').join(',')})
      ORDER BY set_number ASC, id ASC`
  ).all(workout.id, ...ids);

  const thisBwKg = resolveBw(workout.bw_kg);
  // set_number/id ordering is preserved WITHIN each exercise_id even though
  // the query interleaves across exercises (sets from different exercises
  // aren't sorted relative to each other by exercise) — flaggedExercises
  // tracks which exercises already found their first qualifier so later
  // sets for that same exercise are skipped regardless of interleaving.
  const flaggedExercises = new Set();
  for (const s of thisSets) {
    if (flaggedExercises.has(s.exercise_id)) continue;
    const ex = exById.get(s.exercise_id);
    const prior = bestPriorByExercise.get(s.exercise_id);
    if (!ex || !prior || !prior.bestSet) continue;
    const kg = effLoadKg(s.weight, s.weight_unit, ex, thisBwKg);
    let flag = null;
    if (kg > prior.bestKg + KG_EPS) {
      flag = { type: 'weight', priorWeight: prior.bestSet.weight, priorUnit: prior.bestSet.weight_unit };
    } else if (Math.abs(kg - prior.bestKg) <= KG_EPS && s.reps > prior.bestSet.reps) {
      flag = { type: 'reps', priorReps: prior.bestSet.reps };
    }
    if (flag) {
      result.get(s.exercise_id).set(s.id, flag);
      flaggedExercises.add(s.exercise_id);
    }
  }
  return result;
}

// Single-exercise convenience wrapper — POST /api/sets only ever needs one
// exercise's flag, for the set it just logged.
function computeImprovedFlags(profileId, workout, exerciseId) {
  return computeImprovedFlagsBatch(profileId, workout, [exerciseId]).get(exerciseId) || new Map();
}

// Durable is_new_pr lookup: personal_records is already the durable store
// (checkAndUpdatePR in routes/sets.js keeps it current), this just reads it
// back keyed by set_id.
function personalRecordSetIds(profileId, exerciseIds) {
  if (!exerciseIds.length) return new Set();
  const rows = db.prepare(
    `SELECT set_id FROM personal_records
      WHERE profile_id = ? AND exercise_id IN (${exerciseIds.map(() => '?').join(',')}) AND set_id IS NOT NULL`
  ).all(profileId, ...exerciseIds);
  return new Set(rows.map((r) => r.set_id));
}

module.exports = { computeImprovedFlagsBatch, computeImprovedFlags, personalRecordSetIds };
