const express = require('express');
const { db, effectiveVolumeLoadKgSql } = require('../db');
const { recomputePrsForExercise } = require('../pr');
const { caloriesFromSets, activityCalories } = require('../calories');
const { assertInvariant } = require('../lib/bugReports');
const { REGION_TO_GROUP } = require('../db');

const router = express.Router();

const MUSCLE_GROUPS = [...new Set(Object.values(REGION_TO_GROUP))];

// Shared validation for activity create/edit — keeps the two routes from
// drifting (duration cap, allowed distance units, etc.) out of sync.
function parseActivityBody(b) {
  const minutes = Number(b.duration_min);
  if (!Number.isFinite(minutes) || minutes <= 0 || minutes > 600) {
    return { error: 'duration_min must be 1–600 minutes' };
  }
  const activityType = String(b.activity_type || 'other').slice(0, 40);
  const rpe = b.rpe == null ? null : Math.max(6, Math.min(10, Number(b.rpe) || 8));
  const distance = Number.isFinite(Number(b.distance)) && Number(b.distance) > 0 ? Number(b.distance) : null;
  const distanceUnit = distance != null && ['km', 'mi', 'm'].includes(b.distance_unit) ? b.distance_unit : null;
  const tags = Array.isArray(b.muscle_tags)
    ? [...new Set(b.muscle_tags.filter((t) => MUSCLE_GROUPS.includes(t)))]
    : [];
  const notes = b.notes ? String(b.notes).slice(0, 500) : null;
  return { activityType, minutes, rpe, distance, distanceUnit, tags, notes };
}

function latestBwKg(profileId) {
  const latestBw = db.prepare(
    'SELECT weight, weight_unit FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC LIMIT 1'
  ).get(profileId);
  return latestBw ? (latestBw.weight_unit === 'lbs' ? latestBw.weight * 0.45359237 : latestBw.weight) : null;
}

// Log a non-strength session (HYROX class, run, cardio). Reuses the workouts
// table (kind='activity') so it counts toward consistency + calories with no
// extra plumbing. Logged after the fact: created already-finished, with
// started_at backdated by the duration so History shows the right length.
router.post('/activity', (req, res) => {
  const parsed = parseActivityBody(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { activityType, minutes, rpe, distance, distanceUnit, tags, notes } = parsed;

  const bwKg = latestBwKg(req.profileId);
  const kcal = activityCalories(activityType, minutes, rpe, bwKg, distance, distanceUnit);

  // Logged after the fact, so it happened "now" for consistency purposes.
  // started_at == finished_at (don't back-date by duration — that can push the
  // session onto the previous local day near midnight, misattributing the
  // streak). duration_min is the single source of truth for length.
  const now = new Date().toISOString().slice(0, 19).replace('T', ' ');

  const info = db.prepare(
    `INSERT INTO workouts
       (profile_id, kind, started_at, finished_at, calories_burned, bw_kg, notes,
        activity_type, duration_min, rpe, distance, distance_unit, muscle_tags)
     VALUES (?, 'activity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.profileId, now, now, kcal, bwKg, notes,
    activityType, Math.round(minutes), rpe, distance, distanceUnit, JSON.stringify(tags)
  );
  res.status(201).json(db.prepare('SELECT * FROM workouts WHERE id = ?').get(info.lastInsertRowid));
});

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

// The most recent unfinished strength workout, if any. Lets a client whose
// localStorage was evicted (iOS storage pressure) or a second device recover
// the in-progress workout — previously the active id lived only client-side,
// so an evicted draft made the session invisible and swaps silently reverted.
// Age-limited: without the 16h window this resurrected months-old abandoned
// workouts one after another (cancel one, the next zombie gets adopted) —
// the user saw a 1600-hour timer they "couldn't get rid of". Old strays are
// closed/deleted by sweepStaleWorkouts() on boot; this guard covers the ones
// abandoned since the last restart.
router.get('/active', (req, res) => {
  const row = db.prepare(
    `SELECT * FROM workouts
     WHERE profile_id = ? AND finished_at IS NULL AND (kind IS NULL OR kind != 'activity')
       AND started_at >= datetime('now', '-16 hours')
     ORDER BY started_at DESC LIMIT 1`
  ).get(req.profileId);
  res.json(row || null);
});

router.get('/history', (req, res) => {
  const rows = db
    .prepare(
      `SELECT w.id, w.started_at, w.finished_at, w.notes, w.feel_rating, w.calories_burned,
              w.kind, w.activity_type, w.duration_min, w.rpe, w.distance, w.distance_unit, w.muscle_tags,
              pd.day_label,
              p.name as program_name,
              COUNT(s.id) as total_sets,
              COALESCE(SUM(CASE WHEN s.is_warmup = 0
                THEN ${effectiveVolumeLoadKgSql('s', 'ex', 'w')} * s.reps
                ELSE 0 END), 0) as total_volume,
              (SELECT GROUP_CONCAT(g, ',') FROM (
                 SELECT DISTINCT e.muscle_group as g
                 FROM sets s2
                 JOIN exercises e ON e.id = s2.exercise_id
                 WHERE s2.workout_id = w.id
              )) as muscle_groups,
              (SELECT GROUP_CONCAT(gs, ',') FROM (
                 SELECT DISTINCT e.muscle_group || '|' || COALESCE(e.sub_muscle, '') as gs
                 FROM sets s2
                 JOIN exercises e ON e.id = s2.exercise_id
                 WHERE s2.workout_id = w.id
              )) as muscle_subs,
              -- Exercise names for the client-side "filter by exercise" box.
              -- Needs to be here so a COLLAPSED card can be filtered without
              -- first loading its body (which is where the per-exercise names
              -- otherwise only become known).
              (SELECT GROUP_CONCAT(nm, '|') FROM (
                 SELECT DISTINCT e.name as nm
                 FROM sets s2
                 JOIN exercises e ON e.id = s2.exercise_id
                 WHERE s2.workout_id = w.id
              )) as exercise_names
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

// Edit a logged activity in place (kind='activity' only) — same validation as
// POST /activity, plus a calorie recompute since duration/type/RPE all feed it.
router.patch('/:id/activity', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare(`SELECT * FROM workouts WHERE id = ? AND profile_id = ? AND kind = 'activity'`).get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'activity not found' });

  const parsed = parseActivityBody(req.body || {});
  if (parsed.error) return res.status(400).json({ error: parsed.error });
  const { activityType, minutes, rpe, distance, distanceUnit, tags, notes } = parsed;

  // Recompute calories from the (possibly-edited) duration/type/RPE. Reuse the
  // bodyweight already snapshotted at log time so editing an already-priced
  // entry doesn't silently reprice it if bodyweight has since changed — but
  // if none was known yet (bw_kg null), look it up now, so logging bodyweight
  // in response to the "no estimate" nudge and then fixing a typo here
  // actually produces an estimate instead of staying null forever.
  const bwKg = existing.bw_kg ?? latestBwKg(req.profileId);
  const kcal = activityCalories(activityType, minutes, rpe, bwKg, distance, distanceUnit);

  db.prepare(
    `UPDATE workouts
       SET activity_type = ?, duration_min = ?, rpe = ?, distance = ?, distance_unit = ?, muscle_tags = ?, notes = ?, calories_burned = ?, bw_kg = ?
     WHERE id = ?`
  ).run(activityType, Math.round(minutes), rpe, distance, distanceUnit, JSON.stringify(tags), notes, kcal, bwKg, id);

  res.json(db.prepare('SELECT * FROM workouts WHERE id = ?').get(id));
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
  // Server-side snapshot of the workout's exercise list (see db.js migration).
  // Must be null or a JSON array; capped so a runaway client can't bloat rows.
  if ('exercise_list' in (req.body || {})) {
    const v = req.body.exercise_list;
    if (v !== null) {
      if (typeof v !== 'string' || v.length > 20000) {
        return res.status(400).json({ error: 'exercise_list must be a JSON array string (max 20000 chars) or null' });
      }
      try {
        if (!Array.isArray(JSON.parse(v))) throw new Error('not an array');
      } catch {
        return res.status(400).json({ error: 'exercise_list must be valid JSON array' });
      }
    }
    updates.push('exercise_list = ?');
    values.push(v);
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

// Effective load in kg for one set, mirroring db.js's effectiveVolumeLoadKgSql
// (bodyweight/assisted offset by that set's own workout's bw_kg snapshot,
// per-arm doubling) — needed in JS here since trend comparison spans rows
// from DIFFERENT workouts, each with its own bw_kg, not one SQL CASE.
function effKg(s) {
  const kg = s.weight_unit === 'lbs' ? s.weight * 0.45359237 : s.weight;
  if (s.is_bodyweight && s.is_assisted && s.bw_kg != null) return Math.max(0, s.bw_kg - kg);
  if (s.is_bodyweight && s.bw_kg != null) return s.bw_kg + kg;
  return kg * (s.load_multiplier ?? (s.weight_mode === 'per_arm' ? 2 : 1));
}

router.get('/:id/sets', (req, res) => {
  const id = Number(req.params.id);
  const owned = db.prepare('SELECT id, started_at, bw_kg FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!owned) return res.status(404).json({ error: 'workout not found' });
  const rows = db
    .prepare(
      `SELECT s.*, e.name as exercise_name, e.muscle_group, e.sub_muscle, e.is_bodyweight, e.is_assisted, e.equipment, e.weight_mode, s.is_warmup
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.workout_id = ?
       ORDER BY s.logged_at`
    )
    .all(id);

  // Plateau/decline tag per exercise: this workout's best (effective-load)
  // set vs. the immediately-preceding finished session's best for the same
  // exercise — same 2-point rule as the live workout hint (workout.js's
  // classifyTrend), so History can flag a stuck/dropping streak without
  // scrolling back to compare by eye.
  const exerciseIds = [...new Set(rows.filter((s) => !s.is_warmup).map((s) => s.exercise_id))];
  const trendStatus = {};
  if (exerciseIds.length) {
    const thisBest = {};
    for (const s of rows) {
      if (s.is_warmup) continue;
      const kg = effKg({ ...s, bw_kg: owned.bw_kg });
      if (!(s.exercise_id in thisBest) || kg > thisBest[s.exercise_id]) thisBest[s.exercise_id] = kg;
    }
    const priorRows = db.prepare(
      `SELECT s.exercise_id, s.weight, s.weight_unit, s.load_multiplier, e.is_bodyweight, e.is_assisted, e.weight_mode,
              w.id AS workout_id, w.bw_kg
       FROM sets s
       JOIN workouts w ON w.id = s.workout_id
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.profile_id = ? AND s.is_warmup = 0 AND w.finished_at IS NOT NULL AND w.started_at < ?
         AND s.exercise_id IN (${exerciseIds.map(() => '?').join(',')})
       ORDER BY w.started_at DESC`
    ).all(req.profileId, owned.started_at, ...exerciseIds);
    const priorBest = {}; // exercise_id -> best kg of its most recent PRIOR workout
    const priorWorkoutId = {}; // exercise_id -> that workout's id, so later (older) rows for the same exercise are skipped
    for (const s of priorRows) {
      if (priorWorkoutId[s.exercise_id] && priorWorkoutId[s.exercise_id] !== s.workout_id) continue;
      priorWorkoutId[s.exercise_id] = s.workout_id;
      const kg = effKg(s);
      if (!(s.exercise_id in priorBest) || kg > priorBest[s.exercise_id]) priorBest[s.exercise_id] = kg;
    }
    const EPS = 0.05;
    for (const exId of exerciseIds) {
      const cur = thisBest[exId];
      const prior = priorBest[exId];
      if (cur == null || prior == null) continue;
      if (cur < prior - EPS) trendStatus[exId] = 'decline';
      else if (Math.abs(cur - prior) <= EPS) trendStatus[exId] = 'plateau';
    }
  }

  res.json(rows.map((s) => ({ ...s, trend_status: trendStatus[s.exercise_id] || null })));
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
    `SELECT s.*, e.name as exercise_name, e.muscle_group, e.sub_muscle, e.is_bodyweight, e.is_assisted, e.equipment, e.weight_mode, e.rep_min, e.rep_max
     FROM sets s
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.workout_id = ?
     ORDER BY s.logged_at`
  ).all(id);
  row.sets = sets;
  res.json(row);
});

module.exports = router;
