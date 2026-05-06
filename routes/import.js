const express = require('express');
const { db, tx } = require('../db');
const { recomputePrsForExercise } = require('../pr');

const router = express.Router();

router.post('/', express.json({ limit: '20mb' }), (req, res) => {
  const data = req.body;
  if (!data || data.version !== 1) {
    return res.status(400).json({ error: 'Invalid backup file (expected version 1)' });
  }

  const { workouts = [], bodyweights = [] } = data;

  // Build exercise name→id map from current DB so we remap correctly even
  // if exercise IDs differ (e.g. fresh install vs the original).
  const exRows = db.prepare('SELECT id, name FROM exercises').all();
  const exByName = new Map(exRows.map((e) => [e.name.toLowerCase(), e.id]));

  let importedWorkouts = 0;
  let importedSets = 0;
  let importedBw = 0;
  const affectedExercises = new Set();

  tx(() => {
    // --- Workouts + sets ---
    const insWorkout = db.prepare(
      `INSERT OR IGNORE INTO workouts (id, program_day_id, started_at, finished_at, notes, feel_rating)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const insSet = db.prepare(
      `INSERT OR IGNORE INTO sets
         (id, workout_id, exercise_id, set_number, weight, weight_unit, reps, rpe, notes, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const w of workouts) {
      const r = insWorkout.run(
        w.id, w.program_day_id ?? null,
        w.started_at, w.finished_at ?? null,
        w.notes ?? null, w.feel_rating ?? null
      );
      if (r.changes) importedWorkouts++;

      for (const s of (w.sets || [])) {
        // Look up exercise by name from backup; fall back to stored id
        let exId = s.exercise_id;
        if (s.exercise_name) {
          exId = exByName.get(s.exercise_name.toLowerCase()) ?? exId;
        }
        const r2 = insSet.run(
          s.id, w.id, exId, s.set_number,
          s.weight, s.weight_unit, s.reps,
          s.rpe ?? null, s.notes ?? null,
          s.logged_at
        );
        if (r2.changes) {
          importedSets++;
          affectedExercises.add(exId);
        }
      }
    }

    // --- Body weights ---
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
    imported_workouts: importedWorkouts,
    imported_sets: importedSets,
    imported_bodyweights: importedBw,
    skipped: `Duplicate records skipped silently (safe to re-import).`
  });
});

module.exports = router;
