const express = require('express');
const { db, tx, MUSCLE_GROUPS } = require('../db');
const { recomputePrsForExercise } = require('../pr');
const { reportHandled } = require('../lib/bugReports');

const router = express.Router();
// Body parser size is set globally in server.js — no inline override needed.

router.post('/', (req, res) => {
  const data = req.body;
  if (!data || data.version !== 1) {
    return res.status(400).json({ error: 'Invalid backup file (expected version 1)' });
  }

  const { exercises = [], programs = [], workouts = [], bodyweights = [] } = data;
  const profileId = req.profileId;

  let importedExercises = 0;
  let importedPrograms = 0;
  let importedWorkouts = 0;
  let importedSets = 0;
  let importedBw = 0;
  let skippedProgramExercises = 0;
  const affectedExercises = new Set();

  // Reject unknown muscle groups up front (before the transaction) rather
  // than silently defaulting them — a mislinked group quietly corrupts every
  // chart that aggregates by muscle group.
  const badGroup = exercises.find((e) => e.muscle_group && !MUSCLE_GROUPS.includes(String(e.muscle_group).trim()));
  if (badGroup) {
    return res.status(400).json({
      error: `Exercise "${badGroup.name}" has unknown muscle_group "${badGroup.muscle_group}" — must be one of: ${MUSCLE_GROUPS.join(', ')}`
    });
  }

  // We need to look up the backup's exercise IDs so we can remap sets
  // correctly even when current DB IDs differ.
  const backupExById = new Map(exercises.map((e) => [e.id, e]));

  tx(() => {
    // --- 1. Insert any exercises from the backup that don't already exist
    // (matched by name, case-insensitive). The exercise catalog is shared
    // across profiles, so this just tops up missing entries.
    // exercises.name is UNIQUE with SQLite's default case-SENSITIVE collation,
    // but every other place in the app (search, add-exercise dedupe, the
    // name -> id map built right below) treats exercise names case-
    // insensitively. Pre-checking against a lowercased set (instead of
    // relying on INSERT OR IGNORE's exact-case uniqueness) stops a backup
    // whose casing merely drifted from the current catalog (e.g. re-importing
    // an older backup after a rename) from silently creating a second,
    // differently-cased row in the shared, cross-profile catalog.
    const existingNamesLower = new Set(
      db.prepare('SELECT name FROM exercises').all().map((r) => r.name.toLowerCase())
    );
    const insExercise = db.prepare(
      `INSERT OR IGNORE INTO exercises (name, muscle_group, notes, is_bodyweight, is_assisted, equipment, weight_mode)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    for (const e of exercises) {
      const nameLower = String(e.name || '').trim().toLowerCase();
      if (!nameLower || existingNamesLower.has(nameLower)) continue;
      const equipment = e.equipment || 'barbell';
      const r = insExercise.run(
        e.name,
        e.muscle_group || 'chest',
        e.notes ?? null,
        e.is_bodyweight ? 1 : 0,
        e.is_assisted ? 1 : 0,
        equipment,
        // Default weight_mode by equipment, matching the create API — the
        // exercises column defaults to 'per_arm', which would double the
        // volume of an imported non-dumbbell exercise (the reset migration
        // that fixes seeded rows is flag-gated and won't re-run for imports).
        e.weight_mode === 'per_arm' || e.weight_mode === 'combined'
          ? e.weight_mode
          : (equipment === 'dumbbell' ? 'per_arm' : 'combined')
      );
      if (r.changes) { importedExercises++; existingNamesLower.add(nameLower); }
    }

    // --- 2. Build the name → current-id map AFTER any inserts above
    const currentExRows = db.prepare('SELECT id, name FROM exercises').all();
    const exByName = new Map(currentExRows.map((e) => [e.name.toLowerCase(), e.id]));

    // Program days referenced by a backup may not exist in this DB (a workout
    // could reference a day from a program that isn't in THIS backup, e.g. an
    // older/partial export). Keep only valid references so we never insert a
    // dangling FK.
    const validProgramDays = new Set(
      db.prepare(
        `SELECT pd.id FROM program_days pd JOIN programs p ON p.id = pd.program_id
         WHERE p.profile_id = ?`
      ).all(profileId).map((d) => d.id)
    );

    // --- 3. Programs (+ days, + day exercises). Programs are per-profile, not
    // shared like exercises, so — matching workouts below — every import
    // ADDS fresh rows with fresh IDs rather than deduping by name. dayIdRemap
    // lets the workout loop below relink each workout to ITS OWN freshly
    // imported day, instead of only matching if the backup's day id happened
    // to already exist for this profile (which used to be the only path, and
    // in practice was never true for a real restore-from-scratch).
    const insProgram = db.prepare(
      `INSERT INTO programs (profile_id, name, description, sort_order) VALUES (?, ?, ?, ?)`
    );
    const insDay = db.prepare(
      `INSERT INTO program_days (program_id, day_label, day_order) VALUES (?, ?, ?)`
    );
    const insPde = db.prepare(
      `INSERT INTO program_day_exercises
         (program_day_id, exercise_id, target_sets, target_reps, order_index, rest_seconds)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    const dayIdRemap = new Map();

    for (const p of programs) {
      const newProgramId = Number(
        insProgram.run(profileId, p.name, p.description ?? null, p.sort_order ?? null).lastInsertRowid
      );
      importedPrograms++;

      for (const d of (p.days || [])) {
        const newDayId = Number(insDay.run(newProgramId, d.day_label, d.day_order).lastInsertRowid);
        dayIdRemap.set(d.id, newDayId);

        for (const pde of (d.exercises || [])) {
          // Resolve by the backup's own exercise table -> name -> current id,
          // same fallback chain the sets loop below uses.
          const name = backupExById.get(pde.exercise_id)?.name?.toLowerCase();
          const exId = name ? exByName.get(name) : null;
          if (!exId) { skippedProgramExercises++; continue; }
          insPde.run(newDayId, exId, pde.target_sets, pde.target_reps, pde.order_index, pde.rest_seconds ?? null);
        }
      }
    }

    // --- 4. Workouts + sets. IDs are NOT preserved: a backup carries IDs from
    // a single global sequence, so reusing them could clobber another profile's
    // rows. We let SQLite assign fresh IDs and remap sets onto them.
    const insWorkout = db.prepare(
      `INSERT INTO workouts (profile_id, program_day_id, started_at, finished_at, notes, feel_rating, bw_kg, calories_burned)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const insSet = db.prepare(
      `INSERT INTO sets
         (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, reps_r, reps_l, rpe, rir, notes, is_warmup, logged_at, load_multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const w of workouts) {
      const programDayId = w.program_day_id == null
        ? null
        : dayIdRemap.get(w.program_day_id)
          ?? (validProgramDays.has(w.program_day_id) ? w.program_day_id : null);
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
          s.weight, s.weight_unit, s.reps, s.reps_r ?? null, s.reps_l ?? null,
          s.rpe ?? null, s.rir ?? null, s.notes ?? null,
          s.is_warmup ? 1 : 0,
          s.logged_at,
          s.load_multiplier ?? null
        );
        importedSets++;
        affectedExercises.add(exId);
      }
    }

    // --- 5. Body weights (fresh IDs, scoped to this profile)
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

  // Every program/workout/bodyweight is inserted fresh under the current
  // profile, so the only things that can be "skipped" are a set or a program
  // day's exercise slot whose exercise couldn't be resolved by backup ID.
  // Surfaced so a partial import isn't silent.
  // NOTE: import always ADDS — re-importing the same backup duplicates rows.
  const totalSets = workouts.reduce((n, w) => n + (w.sets?.length || 0), 0);
  const skipped = {
    workouts: 0,
    sets: Math.max(0, totalSets - importedSets),
    bodyweights: 0,
    program_exercises: skippedProgramExercises
  };
  const warnings = [];
  if (skipped.sets > 0) warnings.push(`${skipped.sets} set(s) were skipped because their exercise could not be matched.`);
  if (skipped.program_exercises > 0) warnings.push(`${skipped.program_exercises} program exercise slot(s) were skipped because their exercise could not be matched.`);
  if (warnings.length) warnings.push('Import adds records — re-importing the same backup will create duplicates.');

  res.json({
    imported_exercises: importedExercises,
    imported_programs: importedPrograms,
    imported_workouts: importedWorkouts,
    imported_sets: importedSets,
    imported_bodyweights: importedBw,
    skipped,
    warning: warnings.length ? warnings.join(' ') : null
  });
});

module.exports = router;
