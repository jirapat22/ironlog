const express = require('express');
const { db } = require('../db');
const { recomputePrsForExercise } = require('../pr');

const router = express.Router();

function toKg(weight, unit) {
  return unit === 'lbs' ? weight * 0.45359237 : weight;
}

function checkAndUpdatePR(exerciseId, weight, unit, reps) {
  const newKg = toKg(weight, unit);
  const existing = db
    .prepare('SELECT * FROM personal_records WHERE exercise_id = ? AND reps = ?')
    .get(exerciseId, reps);

  let isNewPR = false;
  if (!existing) {
    db.prepare(
      `INSERT INTO personal_records (exercise_id, weight, weight_unit, reps, achieved_at)
       VALUES (?, ?, ?, ?, datetime('now'))`
    ).run(exerciseId, weight, unit, reps);
    isNewPR = true;
  } else {
    const existingKg = toKg(existing.weight, existing.weight_unit);
    if (newKg > existingKg) {
      db.prepare(
        `UPDATE personal_records
         SET weight = ?, weight_unit = ?, achieved_at = datetime('now')
         WHERE id = ?`
      ).run(weight, unit, existing.id);
      isNewPR = true;
    }
  }
  return isNewPR;
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
    notes = null
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
      `INSERT INTO sets (workout_id, exercise_id, set_number, weight, weight_unit, reps, rpe, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(workout_id, exercise_id, set_number, weight, weight_unit, reps, rpe, notes);

  const isNewPR = checkAndUpdatePR(exercise_id, weight, weight_unit, reps);
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...row, is_new_pr: isNewPR });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM sets WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'set not found' });

  const fields = ['weight', 'weight_unit', 'reps', 'rpe', 'notes', 'set_number'];
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
