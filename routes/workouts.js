const express = require('express');
const { db, tx, effectiveVolumeLoadKgSql } = require('../db');
const { recomputePrsForExercise } = require('../pr');
const { caloriesFromSets, activityCalories } = require('../calories');
const { assertInvariant } = require('../lib/bugReports');
const { REGION_TO_GROUP } = require('../db');
const { computeImprovedFlagsBatch, personalRecordSetIds } = require('../lib/improved');

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
  const countsAsWorkout = b.counts_as_workout ? 1 : 0;
  return { activityType, minutes, rpe, distance, distanceUnit, tags, notes, countsAsWorkout };
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
  const { activityType, minutes, rpe, distance, distanceUnit, tags, notes, countsAsWorkout } = parsed;

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
        activity_type, duration_min, rpe, distance, distance_unit, muscle_tags, counts_as_workout)
     VALUES (?, 'activity', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    req.profileId, now, now, kcal, bwKg, notes,
    activityType, Math.round(minutes), rpe, distance, distanceUnit, JSON.stringify(tags), countsAsWorkout
  );
  res.status(201).json(db.prepare('SELECT * FROM workouts WHERE id = ?').get(info.lastInsertRowid));
});

// Closes every unfinished (non-activity) workout for this profile using ITS
// OWN last logged set + 10 minutes — the same heuristic sweepStaleWorkouts()
// uses on boot — rather than leaving them open indefinitely. Starting a new
// workout previously just overwrote the client's local "active workout"
// pointer, silently orphaning whatever was still open: the old one sat
// unfinished until something eventually closed it (a manual Finish tap
// days later, or the next server restart's sweep), and either path stamps
// finished_at with whatever moment THAT happens to be — producing a
// "54h 8min" session that has nothing to do with actual training time.
// Doing it here, at the moment a new workout starts, keeps the closed-out
// duration meaningful regardless of when the user gets around to it.
// A session counts as backdated only once it's this far back. Twelve hours is
// comfortably past any same-day start yet well under the 24h that "yesterday"
// always means, so picking today's date can't flip the flag. It matters:
// is_backdated makes POST /api/sets stamp synthetic timestamps a minute
// apart, which is right for a session being reconstructed from memory and
// wrong for one being logged live (it would compress a real hour-long
// workout into a 12-minute one).
const BACKDATED_AFTER_MS = 12 * 60 * 60 * 1000;

// How far back a session may be dated. The picker offers today / yesterday /
// 2 days ago; this bound is deliberately looser because the client sends a UTC
// instant derived from ITS local calendar day — "2 days ago" at UTC+13 lands
// further back in UTC than the same choice at UTC-11. The 2-day product rule
// lives in the picker; this is the sanity bound behind it.
const MAX_BACKDATE_MS = 3 * 24 * 60 * 60 * 1000;

// Accepts 'YYYY-MM-DD HH:MM:SS' (or the same with a T), interpreted as UTC —
// the format every other timestamp in this schema uses. Returns
// { ok, value, error }; value is null when no date was supplied at all.
// PATCH /:id previously wrote req.body.started_at straight into the column
// with no checking, so a malformed string broke every downstream date parse.
function parseWorkoutDate(raw) {
  if (raw === undefined || raw === null || raw === '') return { ok: true, value: null };
  if (typeof raw !== 'string') return { ok: false, error: 'started_at must be a string' };
  const s = raw.trim().replace('T', ' ');
  if (!/^[0-9]{4}-[0-9]{2}-[0-9]{2} [0-9]{2}:[0-9]{2}:[0-9]{2}$/.test(s)) {
    return { ok: false, error: 'started_at must be YYYY-MM-DD HH:MM:SS' };
  }
  const ms = Date.parse(s.replace(' ', 'T') + 'Z');
  if (!Number.isFinite(ms)) return { ok: false, error: 'started_at is not a real date' };
  // Date.parse SILENTLY ROLLS OVER an impossible calendar date rather than
  // failing: '2026-02-30' comes back as 2 March, '2026-06-31' as 1 July. The
  // regex above can't see that. Round-tripping catches it, so a caller gets
  // told its date is wrong instead of quietly getting a different day.
  if (new Date(ms).toISOString().slice(0, 19).replace('T', ' ') !== s) {
    return { ok: false, error: 'started_at is not a real calendar date' };
  }
  const now = Date.now();
  // A minute of slack absorbs clock skew between phone and server.
  if (ms > now + 60000) return { ok: false, error: 'a workout cannot be dated in the future' };
  if (ms < now - MAX_BACKDATE_MS) return { ok: false, error: 'a workout can only be backdated up to 2 days' };
  return { ok: true, value: s, ms };
}

function closeStaleWorkouts(profileId) {
  const stale = db.prepare(
    `SELECT w.id, MAX(s.logged_at) as last_set, COUNT(s.id) as n
     FROM workouts w LEFT JOIN sets s ON s.workout_id = w.id
     WHERE w.profile_id = ? AND w.finished_at IS NULL AND (w.kind IS NULL OR w.kind != 'activity')
     GROUP BY w.id`
  ).all(profileId);
  if (!stale.length) return;
  const close = db.prepare("UPDATE workouts SET finished_at = datetime(?, '+10 minutes') WHERE id = ?");
  const drop = db.prepare('DELETE FROM workouts WHERE id = ?');
  tx(() => {
    for (const w of stale) {
      if (w.n > 0) close.run(w.last_set, w.id);
      else drop.run(w.id);
    }
  });
}

router.post('/', (req, res) => {
  const { program_day_id, started_at } = req.body || {};
  const dated = parseWorkoutDate(started_at);
  if (!dated.ok) return res.status(400).json({ error: dated.error });
  if (program_day_id) {
    const day = db.prepare(
      `SELECT pd.id FROM program_days pd JOIN programs p ON p.id = pd.program_id
       WHERE pd.id = ? AND p.profile_id = ?`
    ).get(program_day_id, req.profileId);
    if (!day) return res.status(404).json({ error: 'program day not found' });
  }
  closeStaleWorkouts(req.profileId);
  // Supplying a date is not the same as backdating: picking "today" in the
  // past-session picker yields the current instant, and that session is being
  // logged live like any other. Flagging it would have given its sets
  // fabricated one-minute-apart timestamps.
  const isBackdated = dated.value && dated.ms < Date.now() - BACKDATED_AFTER_MS ? 1 : 0;
  const info = dated.value
    ? db
      .prepare("INSERT INTO workouts (program_day_id, profile_id, started_at, is_backdated, created_at) VALUES (?, ?, ?, ?, datetime('now'))")
      .run(program_day_id || null, req.profileId, dated.value, isBackdated)
    : db
      .prepare("INSERT INTO workouts (program_day_id, profile_id, created_at) VALUES (?, ?, datetime('now'))")
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
       -- Age off CREATION time, not the session's own date. A backdated
       -- session's started_at is days old by design, so it never matched
       -- here: clear localStorage mid-entry and the workout became
       -- unresumable (the app showed "No active workout" while the row sat
       -- unfinished). created_at is NULL on pre-migration rows, where
       -- started_at is the right answer anyway.
       AND COALESCE(created_at, started_at) >= datetime('now', '-16 hours')
     ORDER BY COALESCE(created_at, started_at) DESC LIMIT 1`
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
              -- So the list can mark which sessions carry notes. Without this
              -- a workout with notes looked identical to one without, and the
              -- only way to find them was opening every card in turn.
              (SELECT COUNT(*) FROM sets sn
                WHERE sn.workout_id = w.id AND TRIM(COALESCE(sn.notes, '')) <> '') as set_note_count,
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

// Batched version of GET /last/:programDayId — the Programs tab used to fire
// one request per program day (N+1: ~15-20 concurrent GETs for a typical
// handful of programs) just to show "last trained" + best-set hints. One
// round trip for the whole tab instead, mirroring the existing
// /last-by-exercise batching pattern below.
router.post('/last-by-day', (req, res) => {
  const ids = Array.isArray(req.body?.program_day_ids)
    ? [...new Set(req.body.program_day_ids.map(Number).filter(Number.isFinite))]
    : [];
  const out = {};
  const findLast = db.prepare(
    `SELECT * FROM workouts
     WHERE program_day_id = ? AND profile_id = ? AND finished_at IS NOT NULL
     ORDER BY finished_at DESC LIMIT 1`
  );
  const getSets = db.prepare(
    `SELECT s.*, e.name as exercise_name, e.muscle_group, e.is_bodyweight, e.is_assisted, e.equipment, s.is_warmup
     FROM sets s JOIN exercises e ON e.id = s.exercise_id
     WHERE s.workout_id = ?
     ORDER BY s.exercise_id, s.set_number`
  );
  for (const dayId of ids) {
    const w = findLast.get(dayId, req.profileId);
    if (w) w.sets = getSets.all(w.id);
    out[dayId] = w || null;
  }
  res.json(out);
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
  const { activityType, minutes, rpe, distance, distanceUnit, tags, notes, countsAsWorkout } = parsed;

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
       SET activity_type = ?, duration_min = ?, rpe = ?, distance = ?, distance_unit = ?, muscle_tags = ?, notes = ?, calories_burned = ?, bw_kg = ?, counts_as_workout = ?
     WHERE id = ?`
  ).run(activityType, Math.round(minutes), rpe, distance, distanceUnit, JSON.stringify(tags), notes, kcal, bwKg, countsAsWorkout, id);

  res.json(db.prepare('SELECT * FROM workouts WHERE id = ?').get(id));
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'workout not found' });

  // Moving a workout to another day is not just a label change: its sets carry
  // their own logged_at, and every "which day did I train" query reads THAT,
  // not the workout row. Shift the whole session by the same delta so the sets
  // travel with it — otherwise the card moves to yesterday while its volume,
  // coverage and chart points stay on the original day.
  let dateShiftSeconds = null;
  let newIsBackdated = null;
  if ('started_at' in (req.body || {}) && req.body.started_at !== existing.started_at) {
    const dated = parseWorkoutDate(req.body.started_at);
    if (!dated.ok) return res.status(400).json({ error: dated.error });
    if (dated.value) {
      const oldMs = Date.parse(existing.started_at.replace(' ', 'T') + 'Z');
      if (!Number.isFinite(oldMs)) return res.status(400).json({ error: 'existing started_at is unparseable' });
      dateShiftSeconds = Math.round((dated.ms - oldMs) / 1000);
      // Same threshold as create: moving a session back to today makes it a
      // live one again, so sets added afterwards get real timestamps. Keeps
      // sets ADDED later (History's add-set) landing on the session's day.
      newIsBackdated = dated.ms < Date.now() - BACKDATED_AFTER_MS ? 1 : 0;
    }
  }

  const fields = ['notes', 'started_at', 'finished_at', 'feel_rating'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (newIsBackdated !== null) {
    updates.push('is_backdated = ?');
    values.push(newIsBackdated);
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

  // Captured before the shift — after it, these are the exercises whose PR
  // tie-breaks may have changed.
  const affected = dateShiftSeconds
    ? db.prepare('SELECT DISTINCT exercise_id FROM sets WHERE workout_id = ?').all(id)
    : [];

  tx(() => {
    db.prepare(`UPDATE workouts SET ${updates.join(', ')} WHERE id = ?`).run(...values);
    if (dateShiftSeconds) {
      const mod = `${dateShiftSeconds >= 0 ? '+' : ''}${dateShiftSeconds} seconds`;
      db.prepare('UPDATE sets SET logged_at = datetime(logged_at, ?) WHERE workout_id = ?').run(mod, id);
      // Carry the end of the session along too, so a moved workout keeps its
      // duration instead of stretching to the day it was moved from. Skipped
      // when the caller is setting finished_at itself in the same request.
      if (!('finished_at' in (req.body || {})) && existing.finished_at) {
        db.prepare('UPDATE workouts SET finished_at = datetime(finished_at, ?) WHERE id = ?').run(mod, id);
      }
    }
  });

  // PR ties resolve to the OLDEST occurrence ("the set that first hit this
  // weight is the record holder"), so moving a session through time can hand
  // a record to a different set. Recompute after the shift commits —
  // recomputePrsForExercise wraps its own non-reentrant tx().
  for (const { exercise_id } of affected) recomputePrsForExercise(req.profileId, exercise_id);

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
  const w = db.prepare('SELECT started_at, is_backdated FROM workouts WHERE id = ? AND profile_id = ?').get(id, req.profileId);
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

  // A backdated session slots in BEHIND sets that were already logged, and PR
  // ties resolve to the oldest occurrence — so yesterday's set can be the
  // rightful holder of a record that today's set is currently credited with.
  // checkAndUpdatePR only ever compares an incoming set against the standing
  // record, so it can't see that; a rebuild can.
  if (w.is_backdated) {
    const exercises = db.prepare('SELECT DISTINCT exercise_id FROM sets WHERE workout_id = ?').all(id);
    for (const { exercise_id } of exercises) recomputePrsForExercise(req.profileId, exercise_id);
  }

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

  // Status tags per exercise present in this workout — same rules the live
  // workout hint uses (workout.js's classifyTrend), so History can flag a
  // stuck/dropping/climbing streak, or a brand-new exercise, without
  // scrolling back to compare by eye:
  //   first_time — no prior finished session for this exercise at all.
  //   decline    — this session's best (effective-load) set is below the
  //                immediately preceding session's.
  //   plateau    — same load as the immediately preceding session.
  //   up         — this session AND the preceding one were both increases
  //                over the one before (2 consecutive increases — a single
  //                bump doesn't count as a "going up" streak yet).
  // trend_points carries the actual prior weight(s)/date(s) so the client
  // can show specifics in a tap-for-detail popup without a second fetch.
  const exerciseIds = [...new Set(rows.filter((s) => !s.is_warmup).map((s) => s.exercise_id))];
  const trendStatus = {};
  const firstTime = {};
  const trendPoints = {};
  if (exerciseIds.length) {
    const thisBest = {}; // exercise_id -> { kg, weight, unit }
    for (const s of rows) {
      if (s.is_warmup) continue;
      const kg = effKg({ ...s, bw_kg: owned.bw_kg });
      if (!(s.exercise_id in thisBest) || kg > thisBest[s.exercise_id].kg) {
        thisBest[s.exercise_id] = { kg, weight: s.weight, unit: s.weight_unit };
      }
    }
    // started_at alone isn't a safe "strictly before" boundary: SQLite's
    // datetime('now') is whole-second resolution, so two workouts created
    // within the same second (a quick cancel-and-restart) get identical
    // started_at — a plain `<` would silently exclude a real, same-second
    // predecessor entirely instead of comparing against it. `w.id` (always
    // strictly increasing) breaks the tie.
    const priorRows = db.prepare(
      `SELECT s.exercise_id, s.weight, s.weight_unit, s.load_multiplier, e.is_bodyweight, e.is_assisted, e.weight_mode,
              w.id AS workout_id, w.bw_kg, w.started_at
       FROM sets s
       JOIN workouts w ON w.id = s.workout_id
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.profile_id = ? AND s.is_warmup = 0 AND w.finished_at IS NOT NULL
         AND (w.started_at < ? OR (w.started_at = ? AND w.id < ?))
         AND s.exercise_id IN (${exerciseIds.map(() => '?').join(',')})
       ORDER BY w.started_at DESC, w.id DESC`
    ).all(req.profileId, owned.started_at, owned.started_at, owned.id, ...exerciseIds);
    // exercise_id -> up to 2 most recent PRIOR sessions, most-recent-first,
    // each { workoutId, kg, weight, unit, date }. priorRows is already
    // globally ordered by recency, so the first two distinct workout_ids
    // encountered per exercise ARE its two most recent prior sessions.
    const sessions = {};
    for (const s of priorRows) {
      const list = sessions[s.exercise_id] || (sessions[s.exercise_id] = []);
      let entry = list.find((e) => e.workoutId === s.workout_id);
      if (!entry) {
        if (list.length >= 2) continue;
        entry = { workoutId: s.workout_id, kg: -Infinity, weight: null, unit: null, date: s.started_at };
        list.push(entry);
      }
      const kg = effKg(s);
      if (kg > entry.kg) { entry.kg = kg; entry.weight = s.weight; entry.unit = s.weight_unit; }
    }
    const EPS = 0.05;
    for (const exId of exerciseIds) {
      const cur = thisBest[exId];
      if (!cur) continue;
      const [prior1, prior2] = sessions[exId] || [];
      if (!prior1) { firstTime[exId] = true; continue; }
      trendPoints[exId] = [prior2, prior1].filter(Boolean).map((p) => ({ weight: p.weight, unit: p.unit, date: p.date }))
        .concat([{ weight: cur.weight, unit: cur.unit, date: owned.started_at }]);
      if (cur.kg < prior1.kg - EPS) trendStatus[exId] = 'decline';
      else if (Math.abs(cur.kg - prior1.kg) <= EPS) trendStatus[exId] = 'plateau';
      else if (cur.kg > prior1.kg + EPS && prior2 && prior1.kg > prior2.kg + EPS) trendStatus[exId] = 'up';
    }
  }

  // New-PR tag per SET (not per exercise) — a workout can have multiple sets
  // each holding the record for their OWN rep count (personal_records is
  // keyed by (exercise_id, reps), not just the single heaviest set). Matched
  // by set_id (which set actually holds the record), not by value — matching
  // by (weight, unit, reps) alone would flag every set that ever TIES a
  // record, not just the one that originally set it.
  const prSetIds = personalRecordSetIds(req.profileId, exerciseIds);
  // Session-over-session "improved" tag, same durable computation the live
  // workout view uses — see lib/improved.js. Batched (one call covering
  // every exercise in this workout) rather than one round-trip per exercise.
  const improvedByExercise = computeImprovedFlagsBatch(req.profileId, owned, exerciseIds);

  res.json(rows.map((s) => ({
    ...s,
    trend_status: trendStatus[s.exercise_id] || null,
    is_first_time: !!firstTime[s.exercise_id],
    trend_points: trendPoints[s.exercise_id] || null,
    is_pr: !s.is_warmup && prSetIds.has(s.id),
    improved_from_last: s.is_warmup ? null : (improvedByExercise.get(s.exercise_id)?.get(s.id) || null)
  })));
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
    `SELECT s.*, e.name as exercise_name, e.muscle_group, e.sub_muscle, e.is_bodyweight, e.is_assisted, e.equipment, e.weight_mode, e.rep_min, e.rep_max, e.bar_weight_kg
     FROM sets s
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.workout_id = ?
     ORDER BY s.logged_at`
  ).all(id);

  // is_new_pr / improved_from_last used to only exist on the object returned
  // by the POST that logged the set — ephemeral client-only state that
  // vanished the moment the page reloaded (backgrounding mid-workout is
  // routine on a phone). Recomputed durably here on every fetch instead —
  // but only while the workout is still open: a finished workout never
  // reaches the live workout view again (renderWorkout() redirects away the
  // moment it sees finished_at), and History reads these same fields from
  // GET /:id/sets instead, so computing them here for a finished workout is
  // pure waste (this same endpoint is also fetched, for its other fields,
  // by History's parallel workout-detail lookup).
  if (!row.finished_at) {
    const exIds = [...new Set(sets.filter((s) => !s.is_warmup).map((s) => s.exercise_id))];
    const prSetIds = personalRecordSetIds(req.profileId, exIds);
    const improvedByExercise = computeImprovedFlagsBatch(req.profileId, row, exIds);
    for (const s of sets) {
      s.is_new_pr = !s.is_warmup && prSetIds.has(s.id);
      s.improved_from_last = s.is_warmup ? null : (improvedByExercise.get(s.exercise_id)?.get(s.id) || null);
    }
  }
  row.sets = sets;
  res.json(row);
});

module.exports = router;
