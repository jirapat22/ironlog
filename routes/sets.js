const express = require('express');
const { db } = require('../db');
const { recomputePrsForExercise } = require('../pr');

const router = express.Router();

function toKg(weight, unit) {
  return unit === 'lbs' ? weight * 0.45359237 : weight;
}

function checkAndUpdatePR(exerciseId, weight, unit, reps) {
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
      `SELECT MAX(reps) as max FROM personal_records WHERE exercise_id = ? AND weight = 0`
    ).get(exerciseId);
    const prevMaxReps = row?.max || 0;
    beatPreviousBest = reps > prevMaxReps;
  } else {
    const row = db.prepare(
      `SELECT MAX(
         (CASE WHEN weight_unit = 'lbs' THEN weight * 0.45359237 ELSE weight END)
         * (1.0 + reps / 30.0)
       ) as best FROM personal_records WHERE exercise_id = ?`
    ).get(exerciseId);
    const prevBestE1RM = row?.best || 0;
    // 0.1% threshold to avoid float-noise PRs from tiny rounding
    beatPreviousBest = newE1RM > prevBestE1RM * 1.001;
  }

  // Always keep the per-rep-count cache up to date — used by the PR list and
  // by recomputePrsForExercise after edits/deletes.
  const existing = db
    .prepare('SELECT * FROM personal_records WHERE exercise_id = ? AND reps = ?')
    .get(exerciseId, reps);
  if (!existing) {
    db.prepare(
      `INSERT INTO personal_records (exercise_id, weight, weight_unit, reps, achieved_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(exerciseId, weight, unit, reps);
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

  const info = db
    .prepare(
      `INSERT INTO sets (workout_id, exercise_id, set_number, weight, weight_unit, reps, rpe, notes, is_warmup)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(workout_id, exercise_id, set_number, weight, weight_unit, reps, rpe, notes, is_warmup ? 1 : 0);

  // Skip PR check for warmup sets — they don't count toward personal bests
  const isNewPR = is_warmup ? false : checkAndUpdatePR(exercise_id, weight, weight_unit, reps);
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...row, is_new_pr: isNewPR });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM sets WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'set not found' });

  const fields = ['weight', 'weight_unit', 'reps', 'rpe', 'notes', 'set_number', 'is_warmup'];
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
  recomputePrsForExercise(row.exercise_id);
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT exercise_id FROM sets WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'set not found' });
  db.prepare('DELETE FROM sets WHERE id = ?').run(id);
  recomputePrsForExercise(existing.exercise_id);
  res.json({ deleted: true });
});

module.exports = router;
