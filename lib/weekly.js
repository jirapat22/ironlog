'use strict';

// Weekly training summary for the Obsidian vault export (see routes/orbit.js
// GET /weekly-export). The caller passes the week as two UTC instants — the
// GitHub Action works out Monday 00:00 → next Monday 00:00 in Pacific/Auckland
// — so this file never has to know anyone's timezone.
//
// Volume uses the same effectiveVolumeLoadKgSql as the app's own history and
// weekly-volume views, so the numbers in the vault match what the app shows.
// Warmups are excluded, like everywhere else volume is counted.

const { db, effectiveVolumeLoadKgSql } = require('../db');

// SQLite stores "YYYY-MM-DD HH:MM:SS" (UTC, no zone). Turn an ISO instant into
// that shape so plain string comparison against the columns is correct.
function toSqlUtc(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new Error(`invalid date: ${iso}`);
  return d.toISOString().slice(0, 19).replace('T', ' ');
}

const round1 = (n) => Math.round(n * 10) / 10;
const ms = (sqlUtc) => new Date(sqlUtc.replace(' ', 'T') + 'Z').getTime();

// Minutes trained. Same rule as the readable export (routes/export.js): a
// workout left open for hours before being finished reports up to its last
// set instead, so a forgotten session doesn't read as "54h".
const STALE_GAP_MS = 2 * 60 * 60 * 1000;
function sessionMinutes(w) {
  let end = ms(w.finished_at);
  if (w.last_set_at && end - ms(w.last_set_at) > STALE_GAP_MS) end = ms(w.last_set_at);
  return Math.max(0, Math.round((end - ms(w.started_at)) / 60000));
}

// Totals for strength work in [from, to): finished workouts, working sets.
function volume(profileId, from, to) {
  const row = db
    .prepare(
      `SELECT COUNT(*) AS sets,
              COALESCE(SUM(s.reps), 0) AS reps,
              COALESCE(SUM((${effectiveVolumeLoadKgSql('s', 'e', 'w')}) * s.reps), 0) AS kg
       FROM sets s
       JOIN workouts w ON w.id = s.workout_id
       JOIN exercises e ON e.id = s.exercise_id
       WHERE w.profile_id = ? AND w.finished_at IS NOT NULL
         AND w.started_at >= ? AND w.started_at < ?
         AND s.is_warmup = 0`
    )
    .get(profileId, from, to);
  return { sets: row.sets, reps: row.reps, kg: Math.round(row.kg) };
}

function avgBodyweight(profileId, from, to) {
  const rows = db
    .prepare(
      `SELECT logged_at,
              CASE WHEN weight_unit = 'lbs' THEN weight * 0.45359237 ELSE weight END AS kg
       FROM bodyweights
       WHERE profile_id = ? AND logged_at >= ? AND logged_at < ?
       ORDER BY logged_at`
    )
    .all(profileId, from, to);
  const avg = rows.length ? round1(rows.reduce((t, r) => t + r.kg, 0) / rows.length) : null;
  return { rows, avg };
}

/**
 * Build the weekly summary for one profile.
 * @param {number} profileId
 * @param {string} fromIso  start of the week (inclusive), ISO instant
 * @param {string} toIso    end of the week (exclusive), ISO instant
 */
function weeklySummary(profileId, fromIso, toIso) {
  const from = toSqlUtc(fromIso);
  const to = toSqlUtc(toIso);
  // The previous week is the same-length window right before this one.
  const span = new Date(toIso) - new Date(fromIso);
  const prevFrom = toSqlUtc(new Date(new Date(fromIso) - span).toISOString());

  // Every finished session this week, strength and activities alike.
  const workouts = db
    .prepare(
      `SELECT w.id, w.started_at, w.finished_at, w.kind,
              w.activity_label, w.activity_type, w.duration_min,
              COALESCE(pd.day_label, CASE WHEN w.kind = 'activity' THEN 'Activity' ELSE 'Workout' END) AS label,
              (SELECT COUNT(*) FROM sets s WHERE s.workout_id = w.id AND s.is_warmup = 0) AS sets,
              (SELECT MAX(s.logged_at) FROM sets s WHERE s.workout_id = w.id) AS last_set_at
       FROM workouts w
       LEFT JOIN program_days pd ON pd.id = w.program_day_id
       WHERE w.profile_id = ? AND w.finished_at IS NOT NULL
         AND w.started_at >= ? AND w.started_at < ?
       ORDER BY w.started_at`
    )
    .all(profileId, from, to)
    .map((w) => ({
      started_at: w.started_at.replace(' ', 'T') + 'Z',
      label: w.kind === 'activity' ? (w.activity_label || w.activity_type || 'Activity') : w.label,
      kind: w.kind || 'strength',
      minutes: w.duration_min ?? sessionMinutes(w),
      sets: w.sets
    }));

  // PRs set this week (personal_records keeps the best per exercise × reps).
  const prs = db
    .prepare(
      `SELECT e.name AS exercise, e.is_assisted, pr.weight, pr.weight_unit, pr.reps, pr.achieved_at
       FROM personal_records pr
       JOIN exercises e ON e.id = pr.exercise_id
       WHERE pr.profile_id = ? AND pr.achieved_at >= ? AND pr.achieved_at < ?
       ORDER BY e.name, pr.reps`
    )
    .all(profileId, from, to);

  // Top set per exercise this week: heaviest effective load, more reps breaks ties.
  const topLifts = db
    .prepare(
      `SELECT exercise, weight, weight_unit, reps FROM (
         SELECT e.name AS exercise, s.weight, s.weight_unit, s.reps,
                ROW_NUMBER() OVER (
                  PARTITION BY s.exercise_id
                  ORDER BY (${effectiveVolumeLoadKgSql('s', 'e', 'w')}) DESC, s.reps DESC
                ) AS rn
         FROM sets s
         JOIN workouts w ON w.id = s.workout_id
         JOIN exercises e ON e.id = s.exercise_id
         WHERE w.profile_id = ? AND w.finished_at IS NOT NULL
           AND w.started_at >= ? AND w.started_at < ?
           AND s.is_warmup = 0
       ) WHERE rn = 1 ORDER BY exercise`
    )
    .all(profileId, from, to);

  const thisWeek = volume(profileId, from, to);
  const lastWeek = volume(profileId, prevFrom, from);
  const bw = avgBodyweight(profileId, from, to);
  const bwPrev = avgBodyweight(profileId, prevFrom, from);

  return {
    from: fromIso,
    to: toIso,
    workouts,
    volume: { this_week: thisWeek, last_week: lastWeek, change_kg: thisWeek.kg - lastWeek.kg },
    prs,
    top_lifts: topLifts,
    bodyweight: {
      weigh_ins: bw.rows.map((r) => ({ logged_at: r.logged_at.replace(' ', 'T') + 'Z', kg: round1(r.kg) })),
      avg_kg: bw.avg,
      prev_avg_kg: bwPrev.avg,
      change_kg: bw.avg != null && bwPrev.avg != null ? round1(bw.avg - bwPrev.avg) : null
    }
  };
}

// NZ-format day for the note: "Mon 13/10"
function nzDay(iso) {
  return new Date(iso).toLocaleDateString('en-NZ', {
    timeZone: 'Pacific/Auckland', weekday: 'short', day: '2-digit', month: '2-digit'
  });
}

const signed = (n, unit = '') => (n > 0 ? `+${n}${unit}` : `${n}${unit}`);

// personal_records keeps one best per exercise × rep count, so a good week
// lists "Hip Thrust 145×9" and "145×10" as two PRs. The note shows one line
// per exercise: the best by Epley e1RM (w × (1 + reps/30), the app's 1RM).
// Assisted exercises invert — less assistance is the better set — so there
// the lowest weight wins, more reps breaking ties. The JSON summary keeps
// every row; this only shapes the readable note.
function bestPrPerExercise(prs) {
  const kg = (p) => (p.weight_unit === 'lbs' ? p.weight * 0.45359237 : p.weight);
  const score = (p) => (p.is_assisted ? -kg(p) * 1000 + p.reps : kg(p) * (1 + p.reps / 30));
  const best = new Map();
  for (const p of prs) {
    const cur = best.get(p.exercise);
    if (!cur) best.set(p.exercise, { ...p, count: 1 });
    else {
      cur.count++;
      if (score(p) > score(cur)) best.set(p.exercise, { ...p, count: cur.count });
    }
  }
  return [...best.values()];
}

/** Readable Obsidian note for the summary. */
function weeklyMarkdown(s, { weekLabel = '' } = {}) {
  const L = [];
  L.push(`# 🏋️ IronLog: week ${weekLabel}`.trim(), '');
  L.push(`**${s.workouts.length} sessions** · ${s.volume.this_week.sets} working sets · ${s.volume.this_week.kg.toLocaleString('en-NZ')} kg volume (${signed(s.volume.change_kg, ' kg')} vs last week)`, '');

  L.push('## Workouts', '');
  if (!s.workouts.length) L.push('- No sessions this week');
  for (const w of s.workouts) {
    L.push(`- ${nzDay(w.started_at)}: **${w.label}** (${w.minutes} min${w.kind === 'strength' ? `, ${w.sets} sets` : ''})`);
  }
  L.push('');

  L.push('## Volume', '');
  L.push('| | This week | Last week |', '|---|---|---|');
  L.push(`| Sets | ${s.volume.this_week.sets} | ${s.volume.last_week.sets} |`);
  L.push(`| Reps | ${s.volume.this_week.reps} | ${s.volume.last_week.reps} |`);
  L.push(`| Volume (kg) | ${s.volume.this_week.kg} | ${s.volume.last_week.kg} |`, '');

  L.push('## PRs 🏆', '');
  if (!s.prs.length) L.push('- No new PRs this week');
  for (const p of bestPrPerExercise(s.prs)) {
    const more = p.count > 1 ? ` _(${p.count} PRs this week)_` : '';
    L.push(`- **${p.exercise}**: ${p.weight} ${p.weight_unit} × ${p.reps}${more}`);
  }
  L.push('');

  L.push('## Top lifts', '');
  if (!s.top_lifts.length) L.push('- No strength sets this week');
  for (const t of s.top_lifts) L.push(`- ${t.exercise}: ${t.weight} ${t.weight_unit} × ${t.reps}`);
  L.push('');

  L.push('## Bodyweight', '');
  if (!s.bodyweight.weigh_ins.length) L.push('- No weigh-ins this week');
  else {
    const change = s.bodyweight.change_kg != null ? ` (${signed(s.bodyweight.change_kg, ' kg')} vs last week)` : '';
    L.push(`- Average **${s.bodyweight.avg_kg} kg**${change}`);
    L.push(`- Weigh-ins: ${s.bodyweight.weigh_ins.map((b) => `${nzDay(b.logged_at)} ${b.kg}`).join(' · ')}`);
  }
  L.push('');
  return L.join('\n');
}

module.exports = { weeklySummary, weeklyMarkdown, toSqlUtc };
