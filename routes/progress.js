const express = require('express');
const { db, REGION_TO_GROUP } = require('../db');

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
       WHERE s.exercise_id = ? AND s.profile_id = ?
       ORDER BY s.logged_at ASC`
    )
    .all(exerciseId, req.profileId);

  const prs = db
    .prepare('SELECT weight, weight_unit, reps, achieved_at FROM personal_records WHERE exercise_id = ? AND profile_id = ?')
    .all(exerciseId, req.profileId);

  res.json({ sets: rows, prs, exercise });
});

router.get('/volume/weekly', (req, res) => {
  const weeks = Number.parseInt(req.query.weeks, 10);
  const hasWindow = Number.isFinite(weeks) && weeks > 0;
  // Bind the window as a parameter rather than interpolating into the SQL.
  const dateClause = hasWindow ? `AND s.logged_at >= datetime('now', ?)` : '';
  const params = hasWindow ? [req.profileId, `-${weeks} weeks`] : [req.profileId];
  const rows = db
    .prepare(
      `SELECT
         strftime('%Y-%W', s.logged_at) as week,
         e.muscle_group,
         SUM(CASE WHEN s.is_warmup = 0 THEN (CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) * s.reps ELSE 0 END) as volume
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       WHERE s.profile_id = ?
       ${dateClause}
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
    const row = db.prepare("SELECT value FROM app_settings WHERE profile_id = ? AND key = 'nudge_tz_offset_minutes'").get(req.profileId);
    const west = Number(row?.value);
    offsetMin = Number.isFinite(west) ? -west : 0;
  }
  offsetMin = Math.max(-840, Math.min(840, Math.trunc(offsetMin)));
  const mod = `${offsetMin >= 0 ? '+' : ''}${offsetMin} minutes`;
  const rows = db
    .prepare(
      `SELECT date(started_at, ?) as date, COUNT(*) as count
       FROM workouts
       WHERE profile_id = ?
         AND finished_at IS NOT NULL
         AND started_at >= datetime('now', '-6 months')
       GROUP BY date(started_at, ?)
       ORDER BY date ASC`
    )
    .all(mod, req.profileId, mod);
  res.json(rows);
});

router.get('/muscle-frequency', (req, res) => {
  // Coarse, per muscle group (kept for back-compat with older clients).
  const rows = db.prepare(
    `SELECT e.muscle_group,
            MAX(w.started_at) AS last_trained_at,
            COUNT(DISTINCT w.id) AS total_workouts
     FROM sets s
     JOIN workouts  w ON w.id = s.workout_id AND w.finished_at IS NOT NULL
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.profile_id = ?
     GROUP BY e.muscle_group
     ORDER BY last_trained_at DESC`
  ).all(req.profileId);
  res.json(rows);
});

// Finer breakdown by sub-muscle (upper/mid/lower pec, front/side/rear delt,
// lats vs upper back, etc.). Only counts working sets toward volume. Drives the
// sub-muscle frequency view and the "train next" recommendation.
router.get('/sub-muscle-frequency', (req, res) => {
  // Primary attribution: volume + recency from each exercise's own sub_muscle.
  const rows = db.prepare(
    `SELECT e.muscle_group,
            COALESCE(e.sub_muscle, e.muscle_group) AS sub_muscle,
            MAX(w.started_at) AS last_trained_at,
            COUNT(DISTINCT w.id) AS total_workouts,
            COALESCE(SUM(CASE WHEN s.is_warmup = 0
              THEN (CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) * s.reps
              ELSE 0 END), 0) AS volume_kg
     FROM sets s
     JOIN workouts  w ON w.id = s.workout_id AND w.finished_at IS NOT NULL
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.profile_id = ?
     GROUP BY e.muscle_group, COALESCE(e.sub_muscle, e.muscle_group)
     ORDER BY e.muscle_group, last_trained_at DESC`
  ).all(req.profileId);

  // Secondary attribution: a compound's secondary regions only refresh recency
  // (no volume). Aggregate the latest training date per secondary region, then
  // fold it into the primary rows (creating a row for any region that has only
  // ever been hit indirectly so it stops showing "Never").
  const byKey = new Map();
  for (const r of rows) byKey.set(`${r.muscle_group}|${r.sub_muscle}`, r);

  const secRaw = db.prepare(
    `SELECT e.secondary_muscles AS secs, MAX(w.started_at) AS last_at
     FROM sets s
     JOIN workouts  w ON w.id = s.workout_id AND w.finished_at IS NOT NULL
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.profile_id = ? AND s.is_warmup = 0 AND e.secondary_muscles IS NOT NULL
     GROUP BY e.secondary_muscles`
  ).all(req.profileId);

  const secLast = new Map(); // region -> latest started_at (UTC string, lexically comparable)
  for (const row of secRaw) {
    let regions;
    try { regions = JSON.parse(row.secs); } catch { regions = []; }
    if (!Array.isArray(regions)) continue;
    for (const region of regions) {
      const prev = secLast.get(region);
      if (!prev || row.last_at > prev) secLast.set(region, row.last_at);
    }
  }

  for (const [region, lastAt] of secLast) {
    const group = REGION_TO_GROUP[region];
    if (!group) continue;
    const key = `${group}|${region}`;
    let r = byKey.get(key);
    if (!r) {
      r = { muscle_group: group, sub_muscle: region, last_trained_at: null, total_workouts: 0, volume_kg: 0 };
      byKey.set(key, r);
      rows.push(r);
    }
    if (!r.last_trained_at || lastAt > r.last_trained_at) r.last_trained_at = lastAt;
  }

  res.json(rows);
});

router.get('/prs', (req, res) => {
  const rows = db
    .prepare(
      `SELECT pr.id, pr.weight, pr.weight_unit, pr.reps, pr.achieved_at,
              e.id as exercise_id, e.name as exercise_name, e.muscle_group
       FROM personal_records pr
       JOIN exercises e ON e.id = pr.exercise_id
       WHERE pr.profile_id = ?
       ORDER BY e.muscle_group, e.name, pr.reps ASC`
    )
    .all(req.profileId);

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
