const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const exercises = db.prepare('SELECT * FROM exercises ORDER BY muscle_group, name').all();

  const programs = db.prepare('SELECT * FROM programs WHERE profile_id = ? ORDER BY id').all(req.profileId);
  const days = db.prepare('SELECT * FROM program_days ORDER BY program_id, day_order').all();
  const dayExercises = db.prepare(
    'SELECT * FROM program_day_exercises ORDER BY program_day_id, order_index'
  ).all();
  for (const p of programs) {
    p.days = days
      .filter((d) => d.program_id === p.id)
      .map((d) => ({
        ...d,
        exercises: dayExercises.filter((e) => e.program_day_id === d.id)
      }));
  }

  const workouts = db
    .prepare('SELECT * FROM workouts WHERE profile_id = ? ORDER BY started_at DESC')
    .all(req.profileId);
  const sets = db.prepare('SELECT * FROM sets WHERE profile_id = ? ORDER BY workout_id, set_number').all(req.profileId);
  const setsByWorkout = {};
  for (const s of sets) {
    (setsByWorkout[s.workout_id] ||= []).push(s);
  }
  for (const w of workouts) {
    w.sets = setsByWorkout[w.id] || [];
  }

  const bodyweights = db
    .prepare('SELECT * FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC')
    .all(req.profileId);

  const personalRecords = db
    .prepare(
      `SELECT pr.*, e.name as exercise_name, e.muscle_group
       FROM personal_records pr
       JOIN exercises e ON e.id = pr.exercise_id
       WHERE pr.profile_id = ?
       ORDER BY e.name, pr.reps`
    )
    .all(req.profileId);

  const settings = db.prepare('SELECT key, value FROM app_settings WHERE profile_id = ?').all(req.profileId);

  const payload = {
    exported_at: new Date().toISOString(),
    version: 1,
    exercises,
    programs,
    workouts,
    bodyweights,
    personal_records: personalRecords,
    settings: Object.fromEntries(settings.map((r) => [r.key, r.value]))
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ironlog-backup-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json(payload);
});

module.exports = router;
