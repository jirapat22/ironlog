const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.post('/', (req, res) => {
  const { program_day_id } = req.body || {};
  if (!program_day_id) return res.status(400).json({ error: 'program_day_id is required' });

  const day = db.prepare('SELECT id FROM program_days WHERE id = ?').get(program_day_id);
  if (!day) return res.status(404).json({ error: 'program day not found' });

  const info = db
    .prepare('INSERT INTO workouts (program_day_id) VALUES (?)')
    .run(program_day_id);
  const row = db.prepare('SELECT * FROM workouts WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

router.get('/history', (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.id, w.started_at, w.finished_at, w.notes,
              pd.day_label,
              p.name as program_name,
              COUNT(s.id) as total_sets,
              COALESCE(SUM(s.weight * s.reps), 0) as total_volume
       FROM workouts w
       LEFT JOIN program_days pd ON pd.id = w.program_day_id
       LEFT JOIN programs p ON p.id = pd.program_id
       LEFT JOIN sets s ON s.workout_id = w.id
       WHERE w.finished_at IS NOT NULL
       GROUP BY w.id
       ORDER BY w.started_at DESC`
    )
    .all();
  res.json(rows);
});

router.get('/last/:programDayId', (req, res) => {
  const pdid = Number(req.params.programDayId);
  const workout = db
    .prepare(
      `SELECT * FROM workouts
       WHERE program_day_id = ? AND finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 1`
    )
    .get(pdid);

  if (!workout) return res.json(null);

  const sets = db
    .prepare(
      `SELECT s.*, e.name as exercise_name, e.muscle_group
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.workout_id = ?
       ORDER BY s.exercise_id, s.set_number`
    )
    .all(workout.id);

  workout.sets = sets;
  res.json(workout);
});

router.patch('/:id/finish', (req, res) => {
  const id = Number(req.params.id);
  const result = db
    .prepare("UPDATE workouts SET finished_at = datetime('now') WHERE id = ?")
    .run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'workout not found' });
  const row = db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
  res.json(row);
});

router.get('/:id/sets', (req, res) => {
  const id = Number(req.params.id);
  const rows = db
    .prepare(
      `SELECT s.*, e.name as exercise_name, e.muscle_group
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.workout_id = ?
       ORDER BY s.logged_at`
    )
    .all(id);
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
  if (!row) return res.status(404).json({ error: 'workout not found' });

  const sets = db
    .prepare('SELECT * FROM sets WHERE workout_id = ? ORDER BY logged_at')
    .all(id);
  row.sets = sets;
  res.json(row);
});

module.exports = router;
