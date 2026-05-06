const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/progress/:exerciseId', (req, res) => {
  const exerciseId = Number(req.params.exerciseId);
  const exercise = db
    .prepare('SELECT id, name, muscle_group, is_bodyweight FROM exercises WHERE id = ?')
    .get(exerciseId);

  const rows = db
    .prepare(
      `SELECT s.id, s.weight, s.weight_unit, s.reps, s.rpe, s.logged_at,
              w.started_at, w.id as workout_id
       FROM sets s
       JOIN workouts w ON w.id = s.workout_id
       WHERE s.exercise_id = ?
       ORDER BY s.logged_at ASC`
    )
    .all(exerciseId);

  const prs = db
    .prepare('SELECT weight, weight_unit, reps, achieved_at FROM personal_records WHERE exercise_id = ?')
    .all(exerciseId);

  res.json({ sets: rows, prs, exercise });
});

router.get('/volume/weekly', (req, res) => {
  const weeks = Number(req.query.weeks);
  const whereClause =
    weeks > 0 ? `WHERE s.logged_at >= datetime('now', '-${weeks} weeks')` : '';
  const rows = db
    .prepare(
      `SELECT
         strftime('%Y-%W', s.logged_at) as week,
         e.muscle_group,
         SUM((CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) * s.reps) as volume
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       ${whereClause}
       GROUP BY week, e.muscle_group
       ORDER BY week ASC`
    )
    .all();
  res.json(rows);
});

router.get('/calendar', (req, res) => {
  const rows = db
    .prepare(
      `SELECT DISTINCT date(started_at) as date
       FROM workouts
       WHERE started_at >= datetime('now', '-6 months')
       ORDER BY date ASC`
    )
    .all();
  res.json(rows.map((r) => r.date));
});

router.get('/prs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT pr.id, pr.weight, pr.weight_unit, pr.reps, pr.achieved_at,
              e.id as exercise_id, e.name as exercise_name, e.muscle_group
       FROM personal_records pr
       JOIN exercises e ON e.id = pr.exercise_id
       ORDER BY e.muscle_group, e.name, pr.reps ASC`
    )
    .all();

  const grouped = {};
  for (const row of rows) {
    if (!grouped[row.exercise_name]) {
      grouped[row.exercise_name] = {
        exercise_id: row.exercise_id,
        exercise_name: row.exercise_name,
        muscle_group: row.muscle_group,
        records: []
      };
    }
    grouped[row.exercise_name].records.push({
      id: row.id,
      weight: row.weight,
      weight_unit: row.weight_unit,
      reps: row.reps,
      achieved_at: row.achieved_at
    });
  }

  res.json(Object.values(grouped));
});

module.exports = router;
