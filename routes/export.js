const express = require('express');
const { db } = require('../db');

const router = express.Router();

// Parses SQLite's bare "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker) alongside
// real ISO strings, matching public/utils.js's isoToMs convention.
function toMs(iso) {
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z').getTime();
}

function fmtDate(iso) {
  return new Date(toMs(iso)).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

function fmtDuration(startIso, endIso) {
  const mins = Math.max(0, Math.round((toMs(endIso || startIso) - toMs(startIso)) / 60000));
  if (mins < 60) return `${mins} min`;
  return `${Math.floor(mins / 60)}h ${mins % 60}min`;
}

function fmtSetWeight(weight, unit, isBodyweight, isAssisted) {
  if (isAssisted) return !weight ? 'BW' : `BW−${weight}${unit}`;
  if (isBodyweight) return !weight ? 'BW' : `BW+${weight}${unit}`;
  return `${weight}${unit}`;
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

// Groups a workout's sets by exercise, preserving first-appearance order
// (sets are logged exercise-by-exercise, so insertion order already groups
// them correctly even with interleaved exercise_ids).
function exerciseGroups(sets) {
  const order = [];
  const byExercise = new Map();
  for (const s of sets) {
    if (!byExercise.has(s.exercise_id)) { byExercise.set(s.exercise_id, []); order.push(s.exercise_id); }
    byExercise.get(s.exercise_id).push(s);
  }
  return order.map((exId) => byExercise.get(exId));
}

function setLine(s) {
  const wt = fmtSetWeight(s.weight, s.weight_unit, s.is_bodyweight, s.is_assisted);
  let str = `${wt} x ${s.reps}`;
  if (s.is_warmup) return `${str} (warmup)`;
  const extras = [];
  if (s.rpe != null) extras.push(`RPE ${s.rpe}`);
  if (s.rir != null) extras.push(`RIR ${s.rir}`);
  return extras.length ? `${str} (${extras.join(', ')})` : str;
}

function readableWorkouts(profileId) {
  const workouts = db.prepare(
    `SELECT w.*, pd.day_label
     FROM workouts w
     LEFT JOIN program_days pd ON pd.id = w.program_day_id
     WHERE w.profile_id = ?
     ORDER BY w.started_at ASC`
  ).all(profileId);

  const sets = db.prepare(
    `SELECT s.*, e.name AS exercise_name, e.is_bodyweight, e.is_assisted
     FROM sets s JOIN exercises e ON e.id = s.exercise_id
     WHERE s.profile_id = ?
     ORDER BY s.workout_id, s.id`
  ).all(profileId);

  const setsByWorkout = {};
  for (const s of sets) (setsByWorkout[s.workout_id] ||= []).push(s);
  for (const w of workouts) w.sets = setsByWorkout[w.id] || [];

  return workouts;
}

function renderText(workouts) {
  const lines = [
    'IRONLOG — TRAINING LOG',
    `Exported ${new Date().toISOString().slice(0, 10)}`,
    ''
  ];

  if (!workouts.length) {
    lines.push('(no workouts logged yet)');
    return lines.join('\n');
  }

  for (const w of workouts) {
    const title = [fmtDate(w.started_at), w.day_label].filter(Boolean).join(' — ');
    const header = `${title} (${w.finished_at ? fmtDuration(w.started_at, w.finished_at) : 'in progress'})`;
    lines.push('='.repeat(64), header, '='.repeat(64));

    if (w.kind === 'activity') {
      const parts = [];
      if (w.activity_type) parts.push(w.activity_type);
      if (w.duration_min) parts.push(`${w.duration_min} min`);
      if (w.distance) parts.push(`${w.distance} ${w.distance_unit || ''}`.trim());
      if (w.rpe) parts.push(`RPE ${w.rpe}`);
      if (parts.length) lines.push(parts.join(' · '));
    } else {
      for (const group of exerciseGroups(w.sets)) {
        lines.push(group[0].exercise_name);
        lines.push('  ' + group.map(setLine).join(', '));
      }
    }

    const footer = [];
    if (w.notes) footer.push(`Notes: ${w.notes}`);
    if (w.feel_rating) footer.push(`Feel: ${w.feel_rating}/10`);
    if (w.bw_kg) footer.push(`Bodyweight: ${w.bw_kg}kg`);
    if (w.calories_burned) footer.push(`Calories: ${w.calories_burned}`);
    if (footer.length) lines.push(footer.join('   '));

    lines.push('');
  }

  return lines.join('\n');
}

function renderHtml(workouts) {
  const sections = workouts.map((w) => {
    const title = [fmtDate(w.started_at), w.day_label].filter(Boolean).join(' — ');
    const dur = w.finished_at ? fmtDuration(w.started_at, w.finished_at) : 'in progress';

    let body;
    if (w.kind === 'activity') {
      const parts = [];
      if (w.activity_type) parts.push(escapeHtml(w.activity_type));
      if (w.duration_min) parts.push(`${w.duration_min} min`);
      if (w.distance) parts.push(escapeHtml(`${w.distance} ${w.distance_unit || ''}`.trim()));
      if (w.rpe) parts.push(`RPE ${w.rpe}`);
      body = `<p class="session__activity">${parts.join(' &middot; ')}</p>`;
    } else {
      body = exerciseGroups(w.sets).map((group) => `
        <div class="exercise">
          <div class="exercise__name">${escapeHtml(group[0].exercise_name)}</div>
          <div class="exercise__sets">${group.map((s) => escapeHtml(setLine(s))).join(', ')}</div>
        </div>`).join('');
    }

    const footer = [];
    if (w.notes) footer.push(`<em>${escapeHtml(w.notes)}</em>`);
    if (w.feel_rating) footer.push(`Feel ${w.feel_rating}/10`);
    if (w.bw_kg) footer.push(`BW ${w.bw_kg}kg`);
    if (w.calories_burned) footer.push(`${w.calories_burned} kcal`);

    return `
      <section class="session">
        <h2>${escapeHtml(title)} <span class="dur">(${dur})</span></h2>
        ${body}
        ${footer.length ? `<div class="session__footer">${footer.join(' &nbsp;&middot;&nbsp; ')}</div>` : ''}
      </section>`;
  }).join('\n');

  return `<!doctype html>
<html>
<head>
<meta charset="utf-8">
<title>IronLog Training Log</title>
<style>
  body { font-family: Georgia, 'Times New Roman', serif; color: #1a1a1a; background: #fff; max-width: 720px; margin: 0 auto; padding: 32px 24px 60px; line-height: 1.5; }
  h1 { font-family: Arial, sans-serif; font-size: 22px; margin: 0 0 2px; }
  .subtitle { color: #666; font-size: 13px; margin-bottom: 24px; font-family: Arial, sans-serif; }
  .print-hint { background: #fff4ec; border: 1px solid #e07a3c; color: #7a3d1a; padding: 10px 14px; border-radius: 6px; font-family: Arial, sans-serif; font-size: 13px; margin-bottom: 24px; }
  .session { padding: 14px 0; border-top: 1px solid #ddd; page-break-inside: avoid; }
  .session:first-of-type { border-top: none; }
  h2 { font-family: Arial, sans-serif; font-size: 15px; color: #b9502a; margin: 0 0 8px; }
  .dur { color: #888; font-weight: normal; font-size: 13px; }
  .exercise { margin-bottom: 6px; }
  .exercise__name { font-weight: bold; font-size: 13.5px; }
  .exercise__sets { font-size: 13.5px; color: #333; }
  .session__footer { margin-top: 6px; font-size: 12.5px; color: #555; font-family: Arial, sans-serif; }
  .session__activity { font-size: 13.5px; }
  @media print { .print-hint { display: none; } body { padding: 0 8px; } }
</style>
</head>
<body>
  <h1>IronLog &mdash; Training Log</h1>
  <div class="subtitle">Exported ${new Date().toISOString().slice(0, 10)}</div>
  <div class="print-hint">Tip: use your browser's Print (Ctrl/Cmd+P) and choose &ldquo;Save as PDF&rdquo; to share this.</div>
  ${sections || '<p>(no workouts logged yet)</p>'}
</body>
</html>`;
}

router.get('/readable', (req, res) => {
  const workouts = readableWorkouts(req.profileId);

  if (req.query.format === 'html') {
    res.setHeader('Content-Type', 'text/html');
    return res.send(renderHtml(workouts));
  }

  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ironlog-training-log-${new Date().toISOString().slice(0, 10)}.txt"`
  );
  res.send(renderText(workouts));
});

router.get('/', (req, res) => {
  const exercises = db.prepare('SELECT * FROM exercises ORDER BY muscle_group, name').all();

  const programs = db.prepare('SELECT * FROM programs WHERE profile_id = ? ORDER BY id').all(req.profileId);
  const days = db.prepare('SELECT * FROM program_days ORDER BY program_id, day_order').all();
  const dayExercises = db.prepare(
    'SELECT * FROM program_day_exercises ORDER BY program_day_id, order_index'
  ).all();
  for (const p of programs) {
    p.days = days
      .filter((d) => d.program_id === p.id)
      .map((d) => ({
        ...d,
        exercises: dayExercises.filter((e) => e.program_day_id === d.id)
      }));
  }

  const workouts = db
    .prepare('SELECT * FROM workouts WHERE profile_id = ? ORDER BY started_at DESC')
    .all(req.profileId);
  const sets = db.prepare('SELECT * FROM sets WHERE profile_id = ? ORDER BY workout_id, set_number').all(req.profileId);
  const setsByWorkout = {};
  for (const s of sets) {
    (setsByWorkout[s.workout_id] ||= []).push(s);
  }
  for (const w of workouts) {
    w.sets = setsByWorkout[w.id] || [];
  }

  const bodyweights = db
    .prepare('SELECT * FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC')
    .all(req.profileId);

  const personalRecords = db
    .prepare(
      `SELECT pr.*, e.name as exercise_name, e.muscle_group
       FROM personal_records pr
       JOIN exercises e ON e.id = pr.exercise_id
       WHERE pr.profile_id = ?
       ORDER BY e.name, pr.reps`
    )
    .all(req.profileId);

  const settings = db.prepare('SELECT key, value FROM app_settings WHERE profile_id = ?').all(req.profileId);

  const payload = {
    exported_at: new Date().toISOString(),
    version: 1,
    exercises,
    programs,
    workouts,
    bodyweights,
    personal_records: personalRecords,
    settings: Object.fromEntries(settings.map((r) => [r.key, r.value]))
  };

  res.setHeader('Content-Type', 'application/json');
  res.setHeader(
    'Content-Disposition',
    `attachment; filename="ironlog-backup-${new Date().toISOString().slice(0, 10)}.json"`
  );
  res.json(payload);
});

module.exports = router;
