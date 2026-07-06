const express = require('express');
const { db } = require('../db');
const { recomputePrsForExercise } = require('../pr');

const router = express.Router();

function toKg(weight, unit) {
  return unit === 'lbs' ? weight * 0.45359237 : weight;
}

function checkAndUpdatePR(profileId, exerciseId, weight, unit, reps) {
  const newKg = toKg(weight, unit);
  const newE1RM = newKg * (1 + reps / 30);

  // What is the user's overall best for this exercise BEFORE we update?
  // - Non-bodyweight: best e1RM across all per-rep PR records
  // - Bodyweight at weight=0: best (highest) reps ever logged at 0 added weight
  const ex = db.prepare('SELECT is_bodyweight FROM exercises WHERE id = ?').get(exerciseId);
  const isBwUnloaded = !!ex?.is_bodyweight && newKg === 0;

  let beatPreviousBest = false;
  if (isBwUnloaded) {
    const row = db.prepare(
      `SELECT MAX(reps) as max FROM personal_records WHERE profile_id = ? AND exercise_id = ? AND weight = 0`
    ).get(profileId, exerciseId);
    const prevMaxReps = row?.max || 0;
    beatPreviousBest = reps > prevMaxReps;
  } else {
    const row = db.prepare(
      `SELECT MAX(
         (CASE WHEN weight_unit = 'lbs' THEN weight * 0.45359237 ELSE weight END)
         * (1.0 + reps / 30.0)
       ) as best FROM personal_records WHERE profile_id = ? AND exercise_id = ?`
    ).get(profileId, exerciseId);
    const prevBestE1RM = row?.best || 0;
    // 0.1% threshold to avoid float-noise PRs from tiny rounding
    beatPreviousBest = newE1RM > prevBestE1RM * 1.001;
  }

  // Always keep the per-rep-count cache up to date — used by the PR list and
  // by recomputePrsForExercise after edits/deletes.
  const existing = db
    .prepare('SELECT * FROM personal_records WHERE profile_id = ? AND exercise_id = ? AND reps = ?')
    .get(profileId, exerciseId, reps);
  if (!existing) {
    db.prepare(
      `INSERT INTO personal_records (profile_id, exercise_id, weight, weight_unit, reps, achieved_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(profileId, exerciseId, weight, unit, reps);
  } else {
    const existingKg = toKg(existing.weight, existing.weight_unit);
    if (newKg > existingKg) {
      db.prepare(
        `UPDATE personal_records
         SET weight = ?, weight_unit = ?, achieved_at = datetime('now')
         WHERE id = ?`
      ).run(weight, unit, existing.id);
    }
  }

  return beatPreviousBest;
}

router.post('/', (req, res) => {
  const {
    workout_id,
    exercise_id,
    set_number,
    weight,
    weight_unit = 'kg',
    reps,
    rpe = null,
    rir = null,
    notes = null,
    is_warmup = 0
  } = req.body || {};

  if (!workout_id || !exercise_id || set_number == null || weight == null || reps == null) {
    return res.status(400).json({
      error: 'workout_id, exercise_id, set_number, weight, and reps are required'
    });
  }
  if (!['kg', 'lbs'].includes(weight_unit)) {
    return res.status(400).json({ error: 'weight_unit must be kg or lbs' });
  }

  // Coerce + validate numerics so a stringy value can't silently corrupt
  // volume/PR math later (SQLite is loosely typed and would store it as-is).
  const nWeight = Number(weight);
  const nReps = Number(reps);
  const nSetNumber = Number(set_number);
  const nRpe = rpe == null ? null : Number(rpe);
  const nRir = rir == null ? null : Number(rir);
  if (![nWeight, nReps, nSetNumber].every(Number.isFinite)) {
    return res.status(400).json({ error: 'weight, reps, and set_number must be numbers' });
  }
  if ((nRpe != null && !Number.isFinite(nRpe)) || (nRir != null && !Number.isFinite(nRir))) {
    return res.status(400).json({ error: 'rpe and rir must be numbers when provided' });
  }

  // The set must attach to a workout owned by the current profile.
  const workout = db
    .prepare('SELECT id FROM workouts WHERE id = ? AND profile_id = ?')
    .get(workout_id, req.profileId);
  if (!workout) return res.status(404).json({ error: 'workout not found' });

  // Validate that the exercise exists (prevents dangling foreign keys and
  // phantom PR records from attacker-supplied exercise IDs).
  const exercise = db.prepare('SELECT id, weight_mode FROM exercises WHERE id = ?').get(Number(exercise_id));
  if (!exercise) return res.status(404).json({ error: 'exercise not found' });

  // Snapshot the per-arm factor at log time — flipping the exercise's
  // weight_mode later must not rewrite this set's meaning.
  const loadMultiplier = exercise.weight_mode === 'per_arm' ? 2 : 1;

  const info = db
    .prepare(
      `INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, rpe, rir, notes, is_warmup, load_multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.profileId, workout_id, exercise_id, nSetNumber, nWeight, weight_unit, nReps, nRpe, nRir, notes, is_warmup ? 1 : 0, loadMultiplier);

  // Skip PR check for warmup sets — they don't count toward personal bests
  const isNewPR = is_warmup ? false : checkAndUpdatePR(req.profileId, exercise_id, nWeight, weight_unit, nReps);
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...row, is_new_pr: isNewPR });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM sets WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'set not found' });

  if (req.body && 'weight_unit' in req.body && !['kg', 'lbs'].includes(req.body.weight_unit)) {
    return res.status(400).json({ error: 'weight_unit must be kg or lbs' });
  }
  // Numeric fields must parse to finite numbers when present (null allowed for
  // the optional rpe/rir).
  const numericFields = ['weight', 'reps', 'set_number', 'rpe', 'rir'];
  const nullableNumeric = new Set(['rpe', 'rir']);
  for (const f of numericFields) {
    if (req.body && f in req.body) {
      const v = req.body[f];
      if (nullableNumeric.has(f) && v == null) continue;
      if (!Number.isFinite(Number(v))) {
        return res.status(400).json({ error: `${f} must be a number` });
      }
    }
  }

  const fields = ['weight', 'weight_unit', 'reps', 'rpe', 'rir', 'notes', 'set_number', 'is_warmup'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });

  values.push(id);
  db.prepare(`UPDATE sets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(id);

  // A PATCH may lower weight or reps, so a fresh recompute is the only way
  // to keep PRs honest. Covers the rare case where the edited set used to
  // be the PR for some rep count.
  recomputePrsForExercise(req.profileId, row.exercise_id);
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT exercise_id FROM sets WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'set not found' });
  db.prepare('DELETE FROM sets WHERE id = ?').run(id);
  recomputePrsForExercise(req.profileId, existing.exercise_id);
  res.json({ deleted: true });
});

module.exports = router;
