const express = require('express');
const { db, tx } = require('../db');
const { recomputePrsForExercise } = require('../pr');

const router = express.Router();
// Body parser size is set globally in server.js — no inline override needed.

router.post('/', (req, res) => {
  const data = req.body;
  if (!data || data.version !== 1) {
    return res.status(400).json({ error: 'Invalid backup file (expected version 1)' });
  }

  const { exercises = [], workouts = [], bodyweights = [] } = data;

  let importedExercises = 0;
  let importedWorkouts = 0;
  let importedSets = 0;
  let importedBw = 0;
  const affectedExercises = new Set();

  // We need to look up the backup's exercise IDs so we can remap sets
  // correctly even when current DB IDs differ.
  const backupExById = new Map(exercises.map((e) => [e.id, e]));

  tx(() => {
    // --- 1. Insert any exercises from the backup that don't already exist
    // (matched by name, case-insensitive). Custom exercises in the backup
    // would otherwise leave their sets dangling on a fresh DB.
    const insExercise = db.prepare(
      `INSERT OR IGNORE INTO exercises (name, muscle_group, notes, is_bodyweight, is_assisted, equipment)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const e of exercises) {
      const r = insExercise.run(
        e.name,
        e.muscle_group || 'chest',
        e.notes ?? null,
        e.is_bodyweight ? 1 : 0,
        e.is_assisted ? 1 : 0,
        e.equipment || 'barbell'
      );
      if (r.changes) importedExercises++;
    }

    // --- 2. Build the name → current-id map AFTER any inserts above
    const currentExRows = db.prepare('SELECT id, name FROM exercises').all();
    const exByName = new Map(currentExRows.map((e) => [e.name.toLowerCase(), e.id]));

    // --- 3. Workouts + sets
    const insWorkout = db.prepare(
      `INSERT OR IGNORE INTO workouts (id, program_day_id, started_at, finished_at, notes, feel_rating, bw_kg, calories_burned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insSet = db.prepare(
      `INSERT OR IGNORE INTO sets
         (id, workout_id, exercise_id, set_number, weight, weight_unit, reps, rpe, rir, notes, is_warmup, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const w of workouts) {
      const r = insWorkout.run(
        w.id, w.program_day_id ?? null,
        w.started_at, w.finished_at ?? null,
        w.notes ?? null, w.feel_rating ?? null,
        w.bw_kg ?? null, w.calories_burned ?? null
      );
      if (r.changes) importedWorkouts++;

      for (const s of (w.sets || [])) {
        // Resolve exercise by NAME first (most resilient), falling back to
        // the backup's exercise table by ID, then the raw ID. If the final
        // ID doesn't exist, skip so we never insert a dangling FK.
        let exId = null;
        if (s.exercise_name) {
          exId = exByName.get(s.exercise_name.toLowerCase()) ?? null;
        }
        if (!exId && backupExById.has(s.exercise_id)) {
          const name = backupExById.get(s.exercise_id).name?.toLowerCase();
          exId = name ? exByName.get(name) : null;
        }
        if (!exId) continue;

        const r2 = insSet.run(
          s.id, w.id, exId, s.set_number,
          s.weight, s.weight_unit, s.reps,
          s.rpe ?? null, s.rir ?? null, s.notes ?? null,
          s.is_warmup ? 1 : 0,
          s.logged_at
        );
        if (r2.changes) {
          importedSets++;
          affectedExercises.add(exId);
        }
      }
    }

    // --- 4. Body weights
    const insBw = db.prepare(
      `INSERT OR IGNORE INTO bodyweights (id, weight, weight_unit, logged_at, notes)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const b of bodyweights) {
      const r = insBw.run(b.id, b.weight, b.weight_unit, b.logged_at, b.notes ?? null);
      if (r.changes) importedBw++;
    }
  });

  // Recompute PRs for every exercise touched by the import
  for (const exId of affectedExercises) {
    try { recomputePrsForExercise(exId); } catch { /* ignore */ }
  }

  res.json({
    imported_exercises: importedExercises,
    imported_workouts: importedWorkouts,
    imported_sets: importedSets,
    imported_bodyweights: importedBw,
    skipped: `Duplicate records skipped silently (safe to re-import).`
  });
});

module.exports = router;
