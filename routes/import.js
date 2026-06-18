const express = require('express');
const { db, tx } = require('../db');
const { recomputePrsForExercise } = require('../pr');
const { reportHandled } = require('../lib/bugReports');

const router = express.Router();
// Body parser size is set globally in server.js — no inline override needed.

router.post('/', (req, res) => {
  const data = req.body;
  if (!data || data.version !== 1) {
    return res.status(400).json({ error: 'Invalid backup file (expected version 1)' });
  }

  const { exercises = [], workouts = [], bodyweights = [] } = data;
  const profileId = req.profileId;

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
    // (matched by name, case-insensitive). The exercise catalog is shared
    // across profiles, so this just tops up missing entries.
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

    // Program days referenced by a backup may not exist in this DB (programs
    // are shared, not exported per-profile). Keep only valid references so we
    // never insert a dangling FK.
    const validProgramDays = new Set(
      db.prepare(
        `SELECT pd.id FROM program_days pd JOIN programs p ON p.id = pd.program_id
         WHERE p.profile_id = ?`
      ).all(profileId).map((d) => d.id)
    );

    // --- 3. Workouts + sets. IDs are NOT preserved: a backup carries IDs from
    // a single global sequence, so reusing them could clobber another profile's
    // rows. We let SQLite assign fresh IDs and remap sets onto them.
    const insWorkout = db.prepare(
      `INSERT INTO workouts (profile_id, program_day_id, started_at, finished_at, notes, feel_rating, bw_kg, calories_burned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insSet = db.prepare(
      `INSERT INTO sets
         (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, rpe, rir, notes, is_warmup, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const w of workouts) {
      const programDayId =
        w.program_day_id != null && validProgramDays.has(w.program_day_id)
          ? w.program_day_id
          : null;
      const newWorkoutId = Number(
        insWorkout.run(
          profileId, programDayId,
          w.started_at, w.finished_at ?? null,
          w.notes ?? null, w.feel_rating ?? null,
          w.bw_kg ?? null, w.calories_burned ?? null
        ).lastInsertRowid
      );
      importedWorkouts++;

      for (const s of (w.sets || [])) {
        // Resolve exercise by NAME first (most resilient), falling back to
        // the backup's exercise table by ID. If unresolved, skip so we never
        // insert a dangling FK.
        let exId = null;
        if (s.exercise_name) {
          exId = exByName.get(s.exercise_name.toLowerCase()) ?? null;
        }
        if (!exId && backupExById.has(s.exercise_id)) {
          const name = backupExById.get(s.exercise_id).name?.toLowerCase();
          exId = name ? exByName.get(name) : null;
        }
        if (!exId) continue;

        insSet.run(
          profileId, newWorkoutId, exId, s.set_number,
          s.weight, s.weight_unit, s.reps,
          s.rpe ?? null, s.rir ?? null, s.notes ?? null,
          s.is_warmup ? 1 : 0,
          s.logged_at
        );
        importedSets++;
        affectedExercises.add(exId);
      }
    }

    // --- 4. Body weights (fresh IDs, scoped to this profile)
    const insBw = db.prepare(
      `INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, notes)
       VALUES (?, ?, ?, ?, ?)`
    );
    for (const b of bodyweights) {
      insBw.run(profileId, b.weight, b.weight_unit, b.logged_at, b.notes ?? null);
      importedBw++;
    }
  });

  // Recompute PRs for every exercise touched by the import
  for (const exId of affectedExercises) {
    try { recomputePrsForExercise(profileId, exId); }
    catch (err) { reportHandled(err, { profileId, route: 'POST /api/import', step: 'recompute_prs', exerciseId: exId }); }
  }

  // Every workout/bodyweight is inserted fresh under the current profile, so
  // the only thing that can be "skipped" is a set whose exercise couldn't be
  // resolved by name or backup ID. Surfaced so a partial import isn't silent.
  // NOTE: import always ADDS — re-importing the same backup duplicates rows.
  const totalSets = workouts.reduce((n, w) => n + (w.sets?.length || 0), 0);
  const skipped = {
    workouts: 0,
    sets: Math.max(0, totalSets - importedSets),
    bodyweights: 0
  };

  res.json({
    imported_exercises: importedExercises,
    imported_workouts: importedWorkouts,
    imported_sets: importedSets,
    imported_bodyweights: importedBw,
    skipped,
    warning: skipped.sets > 0
      ? `${skipped.sets} set(s) were skipped because their exercise could not be matched. Import adds records — re-importing the same backup will create duplicates.`
      : null
  });
});

module.exports = router;
