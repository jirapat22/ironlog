const express = require('express');
const { db, tx, MUSCLE_GROUPS } = require('../db');
const { recomputePrsForExercise } = require('../pr');
const { validateSetNumerics } = require('../lib/setBounds');
const { cleanActivityFields } = require('../lib/activityFields');
const { parseSettingsBag, writeSettings } = require('./settings');
const { reportHandled } = require('../lib/bugReports');

const router = express.Router();
// Body parser size is set globally in server.js — no inline override needed.

router.post('/', (req, res) => {
  const data = req.body;
  if (!data || data.version !== 1) {
    return res.status(400).json({ error: 'Invalid backup file (expected version 1)' });
  }

  const { exercises = [], programs = [], workouts = [], bodyweights = [], notes = [], settings = {} } = data;
  const profileId = req.profileId;

  let importedExercises = 0;
  let importedPrograms = 0;
  let importedWorkouts = 0;
  let importedSets = 0;
  let importedBw = 0;
  let skippedBw = 0;
  let skippedProgramExercises = 0;
  let skippedSetsInvalid = 0;
  let importedNotes = 0;
  let adjustedActivities = 0;
  const renamedExercises = [];
  const affectedExercises = new Set();

  // Reject unknown muscle groups up front (before the transaction) rather
  // than silently defaulting them — a mislinked group quietly corrupts every
  // chart that aggregates by muscle group.
  // Settings were EXPORTED but never restored, so every backup silently lost
  // height, age, activity, goal, the calorie offsets and the unit preference —
  // the whole TDEE profile. Validated here, before the transaction, so a bad
  // file is rejected outright rather than half-applied.
  const settingsBag = parseSettingsBag(settings);
  if (!settingsBag.ok) {
    return res.status(400).json({ error: `Invalid backup file: ${settingsBag.error}` });
  }

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
    writeSettings(profileId, settingsBag.writes);
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
    // Ownership matters as much as the name here. exercises.name is globally
    // UNIQUE, and a row with created_by_profile_id set is PRIVATE to that
    // profile (routes/exercises.js:163 is the live ownership check). So
    // matching purely on name could resolve one profile's private exercise
    // onto another's:
    //
    //   Bob exports with his own custom "Landmine Press". Later Alice creates
    //   an exercise of the same name — allowed, Bob's row may be long gone, or
    //   the backup may come from a different install. Bob restores: the name
    //   matches ALICE's private row, and every one of Bob's sets attaches to
    //   it. Because personal records are recomputed per exercise after the
    //   commit, Alice's PRs are then calculated over both their sets, and she
    //   is handed a personal record she never lifted — in a cache that will
    //   recompute the same wrong answer on every rebuild.
    //
    // Plated hit this one table over (two batches named "Chilli" collapsing
    // into one food), and their observation carries: the merge is invisible at
    // restore time. Both rows still exist; the damage only shows when
    // something later resolves THROUGH the merged row.
    //
    // So: a private exercise in the backup becomes a private exercise owned by
    // the importing profile. If the name is taken by someone else's private
    // row we cannot insert (UNIQUE) and must not match, so it is restored
    // under a suffixed name — the sets keep their history and the user can
    // merge it deliberately with the tool that already exists for that.
    // Skipping instead would silently drop sets from a restore, which is the
    // worst outcome for a backup feature.
    const existingByNameLower = new Map(
      db.prepare('SELECT id, name, created_by_profile_id FROM exercises').all()
        .map((r) => [r.name.toLowerCase(), r])
    );
    const insExercise = db.prepare(
      `INSERT OR IGNORE INTO exercises (name, muscle_group, notes, is_bodyweight, is_assisted, equipment, weight_mode, created_by_profile_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Backup id -> the name actually used in THIS database, so the sets and
    // program-slot loops below resolve to the row we really created rather
    // than to whatever else happens to hold that name.
    const nameForBackupId = new Map();
    // Backup exercise ids we deliberately declined to match, because the name
    // belongs to another profile's private row. Nothing referencing these may
    // fall back to resolving by the file's own name — that fallback walks
    // straight into the row we just avoided, which is the merge this guards.
    const unsafeBackupIds = new Set();
    for (const e of exercises) {
      const rawName = String(e.name || '').trim();
      const nameLower = rawName.toLowerCase();
      if (!nameLower) continue;
      const privateInBackup = e.created_by_profile_id != null;
      const hit = existingByNameLower.get(nameLower);

      if (hit) {
        const ownedByOther = hit.created_by_profile_id != null && hit.created_by_profile_id !== profileId;
        if (!(privateInBackup && ownedByOther)) {
          // Safe to reuse: either a shared catalog row, or our own.
          nameForBackupId.set(e.id, hit.name);
          continue;
        }
        // Someone else's private row wears this name. Restore ours beside it.
        let candidate = `${rawName} (restored)`;
        let n = 2;
        while (existingByNameLower.has(candidate.toLowerCase())) {
          candidate = `${rawName} (restored ${n++})`;
        }
        const equipmentR = e.equipment || 'barbell';
        const rr = insExercise.run(
          candidate,
          e.muscle_group || 'chest',
          e.notes ?? null,
          (e.is_bodyweight || e.is_assisted) ? 1 : 0,
          e.is_assisted ? 1 : 0,
          equipmentR,
          e.weight_mode === 'per_arm' || e.weight_mode === 'combined'
            ? e.weight_mode
            : (equipmentR === 'dumbbell' ? 'per_arm' : 'combined'),
          profileId
        );
        if (rr.changes) {
          importedExercises++;
          renamedExercises.push({ from: rawName, to: candidate });
          existingByNameLower.set(candidate.toLowerCase(), {
            id: Number(rr.lastInsertRowid), name: candidate, created_by_profile_id: profileId
          });
          nameForBackupId.set(e.id, candidate);
        } else {
          // Should be unreachable — the candidate name was free. But an
          // ignored INSERT used to leave this id unmapped, and the loops below
          // would then resolve it by the file's raw name onto the other
          // profile's private row. Fail closed instead: the sets are skipped
          // and counted, which is visible, rather than silently mislinked.
          unsafeBackupIds.add(e.id);
        }
        continue;
      }

      nameForBackupId.set(e.id, rawName);
      const equipment = e.equipment || 'barbell';
      const r = insExercise.run(
        e.name,
        e.muscle_group || 'chest',
        e.notes ?? null,
        // An assisted exercise is always a bodyweight movement — the machine
        // offsets YOUR weight. Every in-app path guarantees that pairing;
        // this one took the two flags independently and could store
        // is_assisted without is_bodyweight, which no consumer expects.
        // effectiveLoadKg and db.js's volume SQL check both flags and would
        // treat such a row as plain weighted load, while pr.js and
        // checkAndUpdatePR check is_assisted alone and would invert its
        // ranking — the same row read two opposite ways.
        (e.is_bodyweight || e.is_assisted) ? 1 : 0,
        e.is_assisted ? 1 : 0,
        equipment,
        // Default weight_mode by equipment, matching the create API — the
        // exercises column defaults to 'per_arm', which would double the
        // volume of an imported non-dumbbell exercise (the reset migration
        // that fixes seeded rows is flag-gated and won't re-run for imports).
        e.weight_mode === 'per_arm' || e.weight_mode === 'combined'
          ? e.weight_mode
          : (equipment === 'dumbbell' ? 'per_arm' : 'combined'),
        // Preserve privacy. This argument was absent, so every restored
        // custom exercise was inserted with created_by_profile_id NULL —
        // silently promoting one person's private exercise into the shared
        // catalog, where it then showed up in everybody's picker and could
        // only be edited by the owner or the admin code.
        privateInBackup ? profileId : null
      );
      if (r.changes) {
        importedExercises++;
        existingByNameLower.set(nameLower, {
          id: Number(r.lastInsertRowid), name: rawName, created_by_profile_id: privateInBackup ? profileId : null
        });
      }
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
    // Superset pairing is by PDE id, which isn't preserved across an import
    // (fresh ids, same as days/workouts) — remap it in a second pass once
    // every backup id that got inserted has a new one. A partner that was
    // skipped (exercise couldn't be resolved) just leaves the pairing dropped,
    // same as if it were never there.
    const pdeIdRemap = new Map();
    const supersetPending = []; // [newPdeId, oldSupersetWithId]

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
          // Through nameForBackupId, not the backup's own name: a private
          // exercise may have been restored under a suffixed name because
          // another profile holds the original.
          const name = nameForBackupId.get(pde.exercise_id)?.toLowerCase()
            ?? (unsafeBackupIds.has(pde.exercise_id)
              ? null
              : backupExById.get(pde.exercise_id)?.name?.toLowerCase());
          const exId = name ? exByName.get(name) : null;
          if (!exId) { skippedProgramExercises++; continue; }
          const newPdeId = Number(
            insPde.run(newDayId, exId, pde.target_sets, pde.target_reps, pde.order_index, pde.rest_seconds ?? null).lastInsertRowid
          );
          pdeIdRemap.set(pde.id, newPdeId);
          if (pde.superset_with != null) supersetPending.push([newPdeId, pde.superset_with]);
        }
      }
    }
    const setSuperset = db.prepare('UPDATE program_day_exercises SET superset_with = ? WHERE id = ?');
    for (const [newPdeId, oldPartnerId] of supersetPending) {
      const newPartnerId = pdeIdRemap.get(oldPartnerId);
      if (newPartnerId != null) setSuperset.run(newPartnerId, newPdeId);
    }

    // --- 4. Workouts + sets. IDs are NOT preserved: a backup carries IDs from
    // a single global sequence, so reusing them could clobber another profile's
    // rows. We let SQLite assign fresh IDs and remap sets onto them.
    // is_backdated rides along for the same reason logged_at and
    // load_multiplier do: it decides where a set ADDED to this workout later
    // lands. Dropped on restore, adding a set from History to a recovered
    // past session would stamp it today instead of on the session's own day.
    const insWorkout = db.prepare(
      `INSERT INTO workouts (profile_id, program_day_id, started_at, finished_at, notes, feel_rating, bw_kg, calories_burned, is_backdated,
                             kind, activity_type, activity_label, duration_min, rpe, distance, distance_unit, muscle_tags, counts_as_workout)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // Resolve a concrete load_multiplier for every imported set. Storing NULL
    // left the row resolving through db.js's COALESCE fallback to the
    // exercise's CURRENT weight_mode — so a later per-arm flip silently
    // re-valued imported history (doubling its volume and handing it PRs it
    // never earned), which is exactly what the per-set snapshot exists to
    // prevent. backfillLoadMultiplier can't rescue these: it's flag-guarded
    // and already ran. A backup that predates the column has no snapshot to
    // honour, so the exercise's mode AT IMPORT TIME is the best available
    // answer — and unlike NULL it's frozen from then on.
    const modeByExercise = new Map();
    const exModeStmt = db.prepare('SELECT weight_mode FROM exercises WHERE id = ?');
    const multiplierFor = (exerciseId) => {
      if (!modeByExercise.has(exerciseId)) {
        modeByExercise.set(exerciseId, exModeStmt.get(exerciseId)?.weight_mode === 'per_arm' ? 2 : 1);
      }
      return modeByExercise.get(exerciseId);
    };
    const insSet = db.prepare(
      `INSERT INTO sets
         (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, reps_r, reps_l, rpe, rir, notes, is_warmup, logged_at, load_multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );

    for (const w of workouts) {
      const isActivity = w.kind === 'activity';
      const act = isActivity ? cleanActivityFields(w, MUSCLE_GROUPS) : null;
      if (act && act.adjusted) adjustedActivities++;
      const programDayId = w.program_day_id == null
        ? null
        : dayIdRemap.get(w.program_day_id)
          ?? (validProgramDays.has(w.program_day_id) ? w.program_day_id : null);
      const newWorkoutId = Number(
        insWorkout.run(
          profileId, programDayId,
          w.started_at, w.finished_at ?? null,
          w.notes ?? null, w.feel_rating ?? null,
          w.bw_kg ?? null, w.calories_burned ?? null,
          w.is_backdated ? 1 : 0,
          // Everything that makes a non-strength session what it is. None of
          // it was carried before, and `kind` defaults to 'strength' — so a
          // restored run, class or tennis match came back as an EMPTY
          // strength workout: no sets (activities have none), no type, no
          // duration. The row survived and meant nothing, which is worse
          // than losing it outright because nothing looks wrong.
          //
          // Cleaned through the SAME rules the live route enforces, from the
          // same module. The first version of this wrote the file's values
          // straight in, which handed a hand-edited backup a free pass on
          // every bound: a 1e9-minute session, an RPE of 400, an unbounded
          // label. Clamped rather than skipped — see lib/activityFields.js
          // for why an activity is treated differently from a set here.
          isActivity ? 'activity' : 'strength',
          isActivity ? act.activityType : null,
          isActivity ? act.activityLabel : null,
          isActivity ? act.minutes : null,
          isActivity ? act.rpe : null,
          isActivity ? act.distance : null,
          isActivity ? act.distanceUnit : null,
          isActivity ? JSON.stringify(act.tags) : null,
          isActivity ? act.countsAsWorkout : 0
        ).lastInsertRowid
      );
      importedWorkouts++;

      for (const s of (w.sets || [])) {
        // Resolve exercise by NAME first (most resilient), falling back to
        // the backup's exercise table by ID. If unresolved, skip so we never
        // insert a dangling FK.
        // Resolve through the backup's exercise id FIRST, via the name this
        // import actually used for it. s.exercise_name is only a fallback now:
        // preferring it re-introduced the merge this commit fixes, because the
        // name in the file is the name in the SOURCE database, which may
        // belong to another profile's private row here.
        let exId = null;
        const mappedName = nameForBackupId.get(s.exercise_id);
        if (mappedName) exId = exByName.get(mappedName.toLowerCase()) ?? null;
        const unsafe = unsafeBackupIds.has(s.exercise_id);
        if (!exId && !unsafe && backupExById.has(s.exercise_id)) {
          const name = backupExById.get(s.exercise_id).name?.toLowerCase();
          exId = name ? exByName.get(name) : null;
        }
        if (!exId && !unsafe && s.exercise_name) {
          exId = exByName.get(s.exercise_name.toLowerCase()) ?? null;
        }
        if (!exId) continue;

        // Same rules the live POST /api/sets enforces, from the same module.
        // These bounds were unreachable from here (module-local constants in
        // routes/sets.js), so a hand-edited backup could restore a 1e9 kg
        // set, a set_number that made the workout unopenable, or text into a
        // REAL column — SQLite stores '70abc' as text rather than rejecting
        // it. A restore SKIPS and counts rather than returning 400: one bad
        // row shouldn't cost the user the other 4,000.
        const checked = validateSetNumerics({
          weight: s.weight,
          weight_unit: s.weight_unit,
          reps: s.reps,
          set_number: s.set_number,
          rpe: s.rpe ?? null,
          rir: s.rir ?? null
        });
        if (!checked.ok) { skippedSetsInvalid++; continue; }
        const v = checked.values;

        insSet.run(
          profileId, newWorkoutId, exId, v.set_number,
          v.weight, s.weight_unit, v.reps, s.reps_r ?? null, s.reps_l ?? null,
          v.rpe, v.rir, s.notes ?? null,
          s.is_warmup ? 1 : 0,
          s.logged_at,
          s.load_multiplier ?? multiplierFor(exId)
        );
        importedSets++;
        affectedExercises.add(exId);
      }
    }

    // --- 5. Body weights. UPSERT on the local day, not a blind insert.
    //
    // This is the one table where the import does not simply add. Both live
    // writers hold "at most one row per profile per local day" (POST
    // /api/bodyweight dedupes against any row for the day; POST
    // /api/plated/bodyweight against its own), and a blind insert here broke
    // that invariant from the outside: restoring a backup minted a second row
    // for a day that already had one. Plated then had two readings for one
    // date and which one it kept depended on our query order, so the weight it
    // showed could change with nothing on screen to explain it.
    //
    // Honouring an invariant the rest of the app maintains is not the same as
    // switching the whole import to replace semantics — every other table here
    // still adds. It also makes restoring bodyweights idempotent, which is
    // what you want from a backup.
    //
    // `source` rides along so a restored Plated row stays Plated's and a
    // restored manual row stays the user's; a file predating the column reads
    // as 'manual', the safe direction (never auto-corrected, rather than
    // liable to be overwritten).
    const bwTzWest = Math.max(-840, Math.min(840, Math.trunc(
      Number(db.prepare("SELECT value FROM app_settings WHERE profile_id = ? AND key = 'nudge_tz_offset_minutes'")
        .get(profileId)?.value) || 0
    )));
    const bwMod = `${-bwTzWest} minutes`;
    const findBwDay = db.prepare(
      `SELECT id FROM bodyweights
        WHERE profile_id = ? AND date(logged_at, ?) = date(?, ?)
        ORDER BY id LIMIT 1`
    );
    const updBw = db.prepare(
      'UPDATE bodyweights SET weight = ?, weight_unit = ?, logged_at = ?, notes = ?, source = ? WHERE id = ?'
    );
    const insBw = db.prepare(
      `INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, notes, source)
       VALUES (?, ?, ?, ?, ?, ?)`
    );
    for (const b of bodyweights) {
      const w = Number(b.weight);
      // Same reason the sets above are checked: nothing stopped a backup
      // writing text or a negative into this column either.
      if (!Number.isFinite(w) || w <= 0 || !b.logged_at) { skippedBw++; continue; }
      const unit = b.weight_unit === 'lbs' ? 'lbs' : 'kg';
      const src = b.source === 'plated' ? 'plated' : 'manual';
      const hit = findBwDay.get(profileId, bwMod, b.logged_at, bwMod);
      if (hit) {
        updBw.run(w, unit, b.logged_at, b.notes ?? null, src, hit.id);
      } else {
        insBw.run(profileId, w, unit, b.logged_at, b.notes ?? null, src);
      }
      importedBw++;
    }

    // --- 6. The standalone notes/ideas list. Deleted with the profile but
    // never exported until now, so every backup silently lost it.
    const insNote = db.prepare(
      'INSERT INTO notes (profile_id, text, category, done, created_at) VALUES (?, ?, ?, ?, ?)'
    );
    for (const n of notes) {
      const text = typeof n?.text === 'string' ? n.text.trim() : '';
      if (!text) continue;
      insNote.run(
        profileId, text,
        typeof n.category === 'string' && n.category ? n.category : 'idea',
        n.done ? 1 : 0,
        n.created_at || new Date().toISOString().slice(0, 19).replace('T', ' ')
      );
      importedNotes++;
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
  // Two different reasons a set can be dropped, reported separately because
  // they mean different things to the user: "I couldn't find the exercise" is
  // a matching problem, "these numbers aren't valid" means the file is wrong
  // or edited. Lumping them lost that distinction.
  const skipped = {
    workouts: 0,
    sets: Math.max(0, totalSets - importedSets),
    sets_unmatched: Math.max(0, totalSets - importedSets - skippedSetsInvalid),
    sets_invalid: skippedSetsInvalid,
    bodyweights: skippedBw,
    program_exercises: skippedProgramExercises
  };
  const warnings = [];
  if (skipped.sets_unmatched > 0) warnings.push(`${skipped.sets_unmatched} set(s) were skipped because their exercise could not be matched.`);
  if (skipped.sets_invalid > 0) warnings.push(`${skipped.sets_invalid} set(s) were skipped because their weight, reps or set number was not a valid number.`);
  if (skipped.bodyweights > 0) warnings.push(`${skipped.bodyweights} body weight entr(ies) were skipped because the weight or date was not valid.`);
  if (adjustedActivities > 0) warnings.push(`${adjustedActivities} activity session(s) had a duration, effort or name outside the allowed range; the session was kept and the value brought into range.`);
  if (skipped.program_exercises > 0) warnings.push(`${skipped.program_exercises} program exercise slot(s) were skipped because their exercise could not be matched.`);
  for (const r of renamedExercises) {
    warnings.push(`"${r.from}" is another profile's private exercise here, so yours was restored as "${r.to}".`);
  }
  if (warnings.length) warnings.push('Import adds records — re-importing the same backup will create duplicates (body weights are the exception: one entry per day, so they are safe to restore twice).');

  res.json({
    imported_settings: settingsBag.writes.length,
    imported_exercises: importedExercises,
    imported_programs: importedPrograms,
    imported_workouts: importedWorkouts,
    imported_sets: importedSets,
    imported_bodyweights: importedBw,
    imported_notes: importedNotes,
    renamed_exercises: renamedExercises,
    skipped,
    warning: warnings.length ? warnings.join(' ') : null
  });
});

module.exports = router;
