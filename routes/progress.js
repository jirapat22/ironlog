const express = require('express');
const { db, REGION_TO_GROUP, effectiveVolumeLoadKgSql } = require('../db');

const router = express.Router();

// Shared local-time modifier builder: clamps to a real timezone range and
// formats for SQLite's datetime(x, mod) — used everywhere "this week"/"today"
// needs to mean the user's local calendar day, not UTC's. Pass the negated
// offset to convert a local-frame value back to UTC (e.g. after snapping to a
// local Monday) rather than re-deriving the clamp/format logic per call site.
function tzModFromOffset(offsetMin) {
  const clamped = Math.max(-840, Math.min(840, Math.trunc(offsetMin)));
  return `${clamped >= 0 ? '+' : ''}${clamped} minutes`;
}

router.get('/progress/:exerciseId', (req, res) => {
  const exerciseId = Number(req.params.exerciseId);
  const exercise = db
    .prepare('SELECT id, name, muscle_group, is_bodyweight, is_assisted FROM exercises WHERE id = ?')
    .get(exerciseId);

  // Warmups excluded — they aren't working sets and would skew the e1RM trend,
  // same as /strength-history (which feeds the overload chart this drills into).
  const rows = db
    .prepare(
      `SELECT s.id, s.weight, s.weight_unit, s.reps, s.rpe, s.logged_at,
              w.started_at, w.id as workout_id
       FROM sets s
       JOIN workouts w ON w.id = s.workout_id
       WHERE s.exercise_id = ? AND s.profile_id = ? AND s.is_warmup = 0
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
  // Bucket by the user's LOCAL week (?tzOffset, like /calendar), not UTC — a
  // UTC-only %W bucket put anyone east of UTC into "last week" for hours after
  // their Monday actually began, disagreeing with the muscle-coverage strip.
  const tz = Number(req.query.tzOffset);
  const mod = tzModFromOffset(Number.isFinite(tz) ? tz : 0);
  // Bind the window as a parameter rather than interpolating into the SQL.
  // NOTE: SQLite's datetime() has NO 'weeks' modifier — datetime('now','-8 weeks')
  // returns NULL, so `logged_at >= NULL` silently excluded EVERY row and the
  // chart came up empty. Convert to days (weeks * 7), which IS supported.
  const dateClause = hasWindow ? `AND s.logged_at >= datetime('now', ?)` : '';
  const params = [mod, req.profileId, ...(hasWindow ? [`-${weeks * 7} days`] : [])];
  const rows = db
    .prepare(
      `SELECT
         strftime('%Y-%W', s.logged_at, ?) as week,
         e.muscle_group,
         SUM(CASE WHEN s.is_warmup = 0 THEN ${effectiveVolumeLoadKgSql('s', 'e', 'w')} * s.reps ELSE 0 END) as volume,
         SUM(CASE WHEN s.is_warmup = 0 THEN 1 ELSE 0 END) as sets
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       JOIN workouts w ON w.id = s.workout_id
       WHERE s.profile_id = ?
       ${dateClause}
       GROUP BY week, e.muscle_group
       ORDER BY week ASC`
    )
    .all(...params);
  res.json(rows);
});

// Fair mid-week comparison for the volume trend badge: this week SO FAR vs last
// week THROUGH THE SAME POINT (its Monday → the same weekday/time a week ago),
// instead of a full last week that always makes a partial current week look
// down. Week start is snapped in the user's LOCAL time (?tzOffset) then
// converted back to UTC for direct comparison against logged_at (stored UTC) —
// shift to local, find the most recent Monday, shift back. "Same point a week
// ago" is a fixed 7-day duration, so it needs no timezone conversion at all.
router.get('/volume/week-compare', (req, res) => {
  const tz = Number(req.query.tzOffset);
  const offsetMin = Number.isFinite(tz) ? tz : 0;
  const mod = tzModFromOffset(offsetMin);
  const revMod = tzModFromOffset(-offsetMin);
  const load = effectiveVolumeLoadKgSql('s', 'e', 'w');
  const weekStart = "datetime('now', ?, 'weekday 0', '-6 days', 'start of day', ?)";
  const lastWeekStart = `datetime(${weekStart}, '-7 days')`;
  const samePoint = "datetime('now','-7 days')";
  const row = db.prepare(
    `SELECT
       COALESCE(SUM(CASE WHEN s.logged_at >= ${weekStart} THEN ${load} * s.reps END), 0) AS this_so_far,
       COALESCE(SUM(CASE WHEN s.logged_at >= ${lastWeekStart} AND s.logged_at < ${samePoint} THEN ${load} * s.reps END), 0) AS last_to_date
     FROM sets s
     JOIN exercises e ON e.id = s.exercise_id
     JOIN workouts  w ON w.id = s.workout_id
     WHERE s.profile_id = ? AND s.is_warmup = 0 AND s.logged_at >= ${lastWeekStart}`
  ).get(mod, revMod, mod, revMod, req.profileId, mod, revMod);
  res.json({ this_so_far: Math.round(row.this_so_far), last_to_date: Math.round(row.last_to_date) });
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
  const mod = tzModFromOffset(offsetMin);
  // `count` (gym attendance — streak/best/totals) and `activity_count` (cardio,
  // shown only as a secondary per-day marker) are counted separately in one
  // pass so a cardio-only day still gets a row (activity_count>0, count=0)
  // without ever adding to the gym-attendance number itself.
  const rows = db
    .prepare(
      `SELECT
         date(started_at, ?) as date,
         COUNT(CASE WHEN kind IS NULL OR kind != 'activity' THEN 1 END) as count,
         COUNT(CASE WHEN kind = 'activity' THEN 1 END) as activity_count
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

// This week's coverage per muscle group: how many separate sessions
// (workouts) hit each group so far, Monday-start in the user's local time
// (?tzOffset like /calendar). Any working set counts; active workouts count
// immediately so today's session ticks the strip while you train. Drives the
// 2×/week goal strip on the Programs tab.
//
// Credits BOTH the exercise's primary muscle_group AND, via secondary_muscles
// (sub-muscle region strings, mapped to their parent group through
// REGION_TO_GROUP), any other group it also works — e.g. Deadlift is
// primary=back, but its secondary tags (glutes, hamstrings) map to legs, so a
// deadlift session also ticks legs. Only regions in secondary_major (the
// prime-mover-level hits — see SECONDARY_MAJOR_BY_NAME in db.js) actually
// credit a group; a region tagged but NOT in secondary_major (e.g.
// Hyperextension's glutes/hamstrings, or a chest press's triceps) is still
// shown as an "also works" tag but doesn't earn a coverage tick — those hits
// are real but sub-threshold vs. a dedicated session. secondary_major NULL
// (not yet classified — a legacy/custom exercise) falls back to crediting
// every tagged region, same as before this split existed. secondary_muscles
// is JSON, so this is done in JS rather than pure SQL; DISTINCT collapses
// multiple sets of the same exercise in one workout to a single row before
// crediting.
// `workout_id` narrows this to a single workout's own sets (e.g. "which
// muscle groups has THIS session already hit" live during a workout)
// instead of the weekly window — same crediting rule either way, so the
// live in-workout strip and the 2x/week goal never disagree about what
// counts.
router.get('/muscle-coverage', (req, res) => {
  const workoutId = req.query.workout_id ? Number(req.query.workout_id) : null;
  const tz = Number(req.query.tzOffset);
  const mod = tzModFromOffset(Number.isFinite(tz) ? tz : 0);
  const rows = workoutId
    ? db.prepare(
        `SELECT DISTINCT s.workout_id, e.muscle_group, e.secondary_muscles, e.secondary_major
         FROM sets s
         JOIN exercises e ON e.id = s.exercise_id
         WHERE s.profile_id = ? AND s.is_warmup = 0 AND s.workout_id = ?`
      ).all(req.profileId, workoutId)
    : db.prepare(
        `SELECT DISTINCT s.workout_id, e.muscle_group, e.secondary_muscles, e.secondary_major
         FROM sets s
         JOIN exercises e ON e.id = s.exercise_id
         WHERE s.profile_id = ?
           AND s.is_warmup = 0
           AND datetime(s.logged_at, ?) >= datetime(datetime('now', ?), 'weekday 0', '-6 days', 'start of day')`
      ).all(req.profileId, mod, mod);

  const sessionsByGroup = new Map(); // muscle_group -> Set(workout_id)
  const credit = (group, workoutId) => {
    if (!group) return;
    if (!sessionsByGroup.has(group)) sessionsByGroup.set(group, new Set());
    sessionsByGroup.get(group).add(workoutId);
  };
  for (const row of rows) {
    credit(row.muscle_group, row.workout_id);
    if (!row.secondary_muscles) continue;
    let regions = [];
    try { regions = JSON.parse(row.secondary_muscles); } catch { regions = []; }
    let creditable;
    if (row.secondary_major == null) {
      creditable = new Set(regions); // unclassified: fall back to full credit
    } else {
      let major = [];
      try { major = JSON.parse(row.secondary_major); } catch { major = []; }
      creditable = new Set(Array.isArray(major) ? major : []);
    }
    for (const region of regions) {
      if (!creditable.has(region)) continue;
      const g = REGION_TO_GROUP[region];
      if (g && g !== row.muscle_group) credit(g, row.workout_id);
    }
  }
  res.json([...sessionsByGroup.entries()].map(([muscle_group, set]) => ({ muscle_group, sessions: set.size })));
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
              THEN ${effectiveVolumeLoadKgSql('s', 'e', 'w')} * s.reps
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

  // Non-strength activities (HYROX/cardio/etc.) refresh recency for the muscle
  // groups they were tagged with — recency only, no volume — so "what needs
  // attention" knows your legs are fresh after a class. Keyed at the whole
  // group (group|group), which feeds the group's recency in the UI.
  const actRows = db.prepare(
    `SELECT muscle_tags, started_at FROM workouts
     WHERE profile_id = ? AND kind = 'activity' AND finished_at IS NOT NULL AND muscle_tags IS NOT NULL`
  ).all(req.profileId);
  for (const a of actRows) {
    let groups;
    try { groups = JSON.parse(a.muscle_tags); } catch { groups = []; }
    if (!Array.isArray(groups)) continue;
    for (const group of groups) {
      const key = `${group}|${group}`;
      let r = byKey.get(key);
      if (!r) {
        r = { muscle_group: group, sub_muscle: group, last_trained_at: null, total_workouts: 0, volume_kg: 0 };
        byKey.set(key, r);
        rows.push(r);
      }
      if (!r.last_trained_at || a.started_at > r.last_trained_at) r.last_trained_at = a.started_at;
    }
  }

  res.json(rows);
});

// Per-set e1RM history grouped by exercise, for the progressive-overload
// charts. Excludes warmup sets — they aren't working sets and would muddy
// the strength trend.
router.get('/strength-history', (req, res) => {
  const rows = db.prepare(`
    SELECT e.id as exercise_id, e.name as exercise_name, e.muscle_group, e.sub_muscle,
           e.is_bodyweight, e.is_assisted,
           s.weight, s.weight_unit, s.reps, s.logged_at
    FROM sets s
    JOIN exercises e ON e.id = s.exercise_id
    WHERE s.profile_id = ? AND s.is_warmup = 0
    ORDER BY e.muscle_group, e.name, s.logged_at ASC
  `).all(req.profileId);

  const byExercise = new Map();
  for (const r of rows) {
    if (!byExercise.has(r.exercise_id)) {
      byExercise.set(r.exercise_id, {
        exercise_id: r.exercise_id,
        exercise_name: r.exercise_name,
        muscle_group: r.muscle_group,
        sub_muscle: r.sub_muscle || null,
        is_bodyweight: !!r.is_bodyweight,
        is_assisted: !!r.is_assisted,
        sets: []
      });
    }
    byExercise.get(r.exercise_id).sets.push({ weight: r.weight, weight_unit: r.weight_unit, reps: r.reps, logged_at: r.logged_at });
  }
  res.json([...byExercise.values()]);
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
