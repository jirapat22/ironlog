const express = require('express');
const { db } = require('../db');
const { recomputePrsForExercise } = require('../pr');
const { caloriesFromSets } = require('../calories');
const { assertInvariant } = require('../lib/bugReports');

const router = express.Router();

router.post('/', (req, res) => {
  const { program_day_id } = req.body || {};
  if (program_day_id) {
    const day = db.prepare(
      `SELECT pd.id FROM program_days pd JOIN programs p ON p.id = pd.program_id
       WHERE pd.id = ? AND p.profile_id = ?`
    ).get(program_day_id, req.profileId);
    if (!day) return res.status(404).json({ error: 'program day not found' });
  }
  const info = db
    .prepare('INSERT INTO workouts (program_day_id, profile_id) VALUES (?, ?)')
    .run(program_day_id || null, req.profileId);
  const row = db.prepare('SELECT * FROM workouts WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

router.get('/history', (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.id, w.started_at, w.finished_at, w.notes, w.feel_rating, w.calories_burned,
              pd.day_label,
              p.name as program_name,
              COUNT(s.id) as total_sets,
              COALESCE(SUM(CASE WHEN s.is_warmup = 0 THEN
                CASE
                  WHEN ex.is_bodyweight = 1 AND ex.is_assisted = 1 AND w.bw_kg IS NOT NULL
                    THEN CASE WHEN w.bw_kg - (CASE WHEN s.weight_unit='lbs' THEN s.weight*0.45359237 ELSE s.weight END) < 0
                              THEN 0
                              ELSE (w.bw_kg - (CASE WHEN s.weight_unit='lbs' THEN s.weight*0.45359237 ELSE s.weight END)) * s.reps END
                  WHEN ex.is_bodyweight = 1 AND w.bw_kg IS NOT NULL
                    THEN (w.bw_kg + (CASE WHEN s.weight_unit='lbs' THEN s.weight*0.45359237 ELSE s.weight END)) * s.reps
                  ELSE (CASE WHEN s.weight_unit='lbs' THEN s.weight*0.45359237 ELSE s.weight END) * s.reps
                END
              ELSE 0 END), 0) as total_volume,
              (SELECT GROUP_CONCAT(g, ',') FROM (
                 SELECT DISTINCT e.muscle_group as g
                 FROM sets s2
                 JOIN exercises e ON e.id = s2.exercise_id
                 WHERE s2.workout_id = w.id
              )) as muscle_groups
       FROM workouts w
       LEFT JOIN program_days pd ON pd.id = w.program_day_id
       LEFT JOIN programs p ON p.id = pd.program_id
       LEFT JOIN sets s ON s.workout_id = w.id
       LEFT JOIN exercises ex ON ex.id = s.exercise_id
       WHERE w.profile_id = ? AND w.finished_at IS NOT NULL
       GROUP BY w.id
       ORDER BY w.started_at DESC`
    )
    .all(req.profileId);
  res.json(rows);
});

// Last N finished workouts for a program day (with sets + exercise info) — for trend display
router.get('/recent/:programDayId', (req, res) => {
  const pdid = Number(req.params.programDayId);
  const n = Math.min(10, Math.max(1, Number(req.query.n) || 3));
  const workouts = db.prepare(
    `SELECT * FROM workouts
     WHERE program_day_id = ? AND profile_id = ? AND finished_at IS NOT NULL
     ORDER BY finished_at DESC LIMIT ?`
  ).all(pdid, req.profileId, n);
  for (const w of workouts) {
    w.sets = db.prepare(
      `SELECT s.*, e.is_bodyweight, e.is_assisted, e.equipment
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.workout_id = ?
       ORDER BY s.set_number`
    ).all(w.id);
  }
  res.json(workouts);
});

router.get('/last/:programDayId', (req, res) => {
  const pdid = Number(req.params.programDayId);
  const workout = db
    .prepare(
      `SELECT * FROM workouts
       WHERE program_day_id = ? AND profile_id = ? AND finished_at IS NOT NULL
       ORDER BY finished_at DESC
       LIMIT 1`
    )
    .get(pdid, req.profileId);

  if (!workout) return res.json(null);

  const sets = db
    .prepare(
      `SELECT s.*, e.name as exercise_name, e.muscle_group, e.is_bodyweight, e.is_assisted, e.equipment, s.is_warmup
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.workout_id = ?
       ORDER BY s.exercise_id, s.set_number`
    )
    .all(workout.id);

  workout.sets = sets;
  res.json(workout);
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'workout not found' });

  const fields = ['notes', 'started_at', 'finished_at', 'feel_rating'];
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
  db.prepare(`UPDATE workouts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const owned = db.prepare('SELECT id FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!owned) return res.status(404).json({ error: 'workout not found' });
  // Gather affected exercises BEFORE the cascade deletes their sets
  const exercises = db
    .prepare('SELECT DISTINCT exercise_id FROM sets WHERE workout_id = ?')
    .all(id);
  db.prepare('DELETE FROM workouts WHERE id = ?').run(id);
  for (const { exercise_id } of exercises) recomputePrsForExercise(req.profileId, exercise_id);
  res.json({ deleted: true });
});

router.patch('/:id/finish', (req, res) => {
  const id = Number(req.params.id);
  const w = db.prepare('SELECT started_at FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!w) return res.status(404).json({ error: 'workout not found' });

  // Cap finish time at last activity + 10 minutes. Covers normal post-set
  // rest and packing up; if the user forgot to tap finish for hours, we
  // don't inflate the duration in history.
  const lastSet = db
    .prepare(`SELECT MAX(logged_at) as t FROM sets WHERE workout_id = ?`)
    .get(id);
  const lastActivity = lastSet?.t || w.started_at;
  const lastMs = new Date(lastActivity.replace(' ', 'T') + 'Z').getTime();
  const capMs = lastMs + 10 * 60 * 1000;
  const finishMs = Math.min(Date.now(), capMs);
  const startedMs = new Date(w.started_at.replace(' ', 'T') + 'Z').getTime();
  assertInvariant(finishMs >= startedMs, 'workout finished_at before started_at', {
    profileId: req.profileId, workoutId: id, startedMs, finishMs
  });
  const finishedAt = new Date(finishMs).toISOString().slice(0, 19).replace('T', ' ');

  const latestBw = db.prepare(
    `SELECT weight, weight_unit FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC LIMIT 1`
  ).get(req.profileId);
  const bwKg = latestBw
    ? (latestBw.weight_unit === 'lbs' ? latestBw.weight * 0.45359237 : latestBw.weight)
    : null;

  // Estimate calories from the sets actually logged (per-exercise MET ×
  // bodyweight × active movement time), not from total session duration.
  const setRows = db
    .prepare('SELECT s.reps, s.is_warmup, e.met FROM sets s JOIN exercises e ON e.id = s.exercise_id WHERE s.workout_id = ?')
    .all(id);
  const caloriesBurned = caloriesFromSets(setRows, bwKg);
  // null is legitimate — it means no bodyweight has been logged yet, so the
  // model can't estimate. Only a non-null, non-finite, or negative value is a bug.
  assertInvariant(caloriesBurned == null || (Number.isFinite(caloriesBurned) && caloriesBurned >= 0),
    'calories_burned is not a finite number >= 0', {
      profileId: req.profileId, workoutId: id, caloriesBurned, setCount: setRows.length
    });

  db.prepare('UPDATE workouts SET finished_at = ?, bw_kg = ?, calories_burned = ? WHERE id = ?')
    .run(finishedAt, bwKg, caloriesBurned, id);
  const row = db.prepare('SELECT * FROM workouts WHERE id = ?').get(id);
  res.json(row);
});

// Per-exercise last performance, independent of any program day. Powers
// prefill + progression hints for quick workouts and mid-workout-added
// exercises, which have no program-day "last" session to draw from. Batched so
// one request covers a whole workout's exercise list.
router.post('/last-by-exercise', (req, res) => {
  const ids = Array.isArray(req.body?.exercise_ids)
    ? [...new Set(req.body.exercise_ids.map(Number).filter(Number.isFinite))]
    : [];
  const out = {};
  const findLast = db.prepare(
    `SELECT w.id FROM workouts w
       JOIN sets s ON s.workout_id = w.id AND s.exercise_id = ? AND s.profile_id = ?
      WHERE w.profile_id = ? AND w.finished_at IS NOT NULL
      ORDER BY w.finished_at DESC LIMIT 1`
  );
  const getSets = db.prepare(
    `SELECT s.*, e.name as exercise_name, e.muscle_group, e.is_bodyweight, e.is_assisted, e.equipment
       FROM sets s JOIN exercises e ON e.id = s.exercise_id
      WHERE s.workout_id = ? AND s.exercise_id = ?
      ORDER BY s.set_number`
  );
  for (const exId of ids) {
    const w = findLast.get(exId, req.profileId, req.profileId);
    out[exId] = w ? getSets.all(w.id, exId) : [];
  }
  res.json(out);
});

router.get('/:id/sets', (req, res) => {
  const id = Number(req.params.id);
  const owned = db.prepare('SELECT id FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!owned) return res.status(404).json({ error: 'workout not found' });
  const rows = db
    .prepare(
      `SELECT s.*, e.name as exercise_name, e.muscle_group, e.is_bodyweight, e.is_assisted, e.equipment, s.is_warmup
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.workout_id = ?
       ORDER BY s.logged_at`
    )
    .all(id);
  res.json(rows);
});

// Remove a single exercise from a workout: delete this profile's sets for that
// exercise in the workout, then refresh its PR cache. Shared by the "remove
// exercise" action in the active workout and in history.
router.delete('/:id/exercises/:exerciseId', (req, res) => {
  const id = Number(req.params.id);
  const exerciseId = Number(req.params.exerciseId);
  const owned = db.prepare('SELECT id FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!owned) return res.status(404).json({ error: 'workout not found' });
  const r = db
    .prepare('DELETE FROM sets WHERE workout_id = ? AND exercise_id = ? AND profile_id = ?')
    .run(id, exerciseId, req.profileId);
  recomputePrsForExercise(req.profileId, exerciseId);

  // If this emptied a FINISHED workout, drop it so History doesn't keep a
  // sets-less ghost entry. Never delete an in-progress workout — the user may
  // still be mid-session and about to add exercises back.
  let workoutDeleted = false;
  const remaining = db.prepare('SELECT COUNT(*) AS n FROM sets WHERE workout_id = ?').get(id).n;
  if (remaining === 0) {
    const w = db.prepare('SELECT finished_at FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
    if (w && w.finished_at) {
      db.prepare('DELETE FROM workouts WHERE id = ?').run(id);
      workoutDeleted = true;
    }
  }
  res.json({ removed: true, sets_removed: Number(r.changes), workout_deleted: workoutDeleted });
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const row = db.prepare('SELECT * FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!row) return res.status(404).json({ error: 'workout not found' });

  // Include exercise metadata so the client can rebuild mid-workout added exercise cards
  const sets = db.prepare(
    `SELECT s.*, e.name as exercise_name, e.muscle_group, e.is_bodyweight, e.is_assisted, e.equipment
     FROM sets s
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.workout_id = ?
     ORDER BY s.logged_at`
  ).all(id);
  row.sets = sets;
  res.json(row);
});

module.exports = router;
