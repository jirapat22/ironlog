const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/progress/:exerciseId', (req, res) => {
  const exerciseId = Number(req.params.exerciseId);
  const exercise = db
    .prepare('SELECT id, name, muscle_group, is_bodyweight, is_assisted FROM exercises WHERE id = ?')
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
  const weeks = Number.parseInt(req.query.weeks, 10);
  const hasWindow = Number.isFinite(weeks) && weeks > 0;
  // Bind the window as a parameter rather than interpolating into the SQL.
  const whereClause = hasWindow ? `WHERE s.logged_at >= datetime('now', ?)` : '';
  const params = hasWindow ? [`-${weeks} weeks`] : [];
  const rows = db
    .prepare(
      `SELECT
         strftime('%Y-%W', s.logged_at) as week,
         e.muscle_group,
         SUM(CASE WHEN s.is_warmup = 0 THEN (CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) * s.reps ELSE 0 END) as volume
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       ${whereClause}
       GROUP BY week, e.muscle_group
       ORDER BY week ASC`
    )
    .all(...params);
  res.json(rows);
});

router.get('/calendar', (req, res) => {
  // started_at is stored in UTC. Group by the user's LOCAL date so morning
  // sessions in UTC+ timezones don't get pushed onto the previous day.
  // Prefer the client's live offset (?tzOffset = minutes EAST of UTC, DST-aware);
  // otherwise fall back to the saved nudge_tz_offset_minutes setting (which is
  // Date.getTimezoneOffset() = minutes WEST of UTC, so negate it). This keeps
  // grouping correct even for an older cached client that omits the param.
  const tz = Number(req.query.tzOffset);
  let offsetMin;
  if (Number.isFinite(tz)) {
    offsetMin = tz;
  } else {
    const row = db.prepare("SELECT value FROM app_settings WHERE key = 'nudge_tz_offset_minutes'").get();
    const west = Number(row?.value);
    offsetMin = Number.isFinite(west) ? -west : 0;
  }
  offsetMin = Math.max(-840, Math.min(840, Math.trunc(offsetMin)));
  const mod = `${offsetMin >= 0 ? '+' : ''}${offsetMin} minutes`;
  const rows = db
    .prepare(
      `SELECT date(started_at, ?) as date, COUNT(*) as count
       FROM workouts
       WHERE finished_at IS NOT NULL
         AND started_at >= datetime('now', '-6 months')
       GROUP BY date(started_at, ?)
       ORDER BY date ASC`
    )
    .all(mod, mod);
  res.json(rows);
});

router.get('/muscle-frequency', (req, res) => {
  const rows = db.prepare(
    `SELECT e.muscle_group,
            MAX(w.started_at) AS last_trained_at,
            COUNT(DISTINCT w.id) AS total_workouts
     FROM sets s
     JOIN workouts  w ON w.id = s.workout_id AND w.finished_at IS NOT NULL
     JOIN exercises e ON e.id = s.exercise_id
     GROUP BY e.muscle_group
     ORDER BY last_trained_at DESC`
  ).all();
  res.json(rows);
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
