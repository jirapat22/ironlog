const express = require('express');
const path = require('path');
const { init, db } = require('./db');
const push = require('./push');

const exercisesRouter = require('./routes/exercises');
const programsRouter = require('./routes/programs');
const workoutsRouter = require('./routes/workouts');
const setsRouter = require('./routes/sets');
const progressRouter = require('./routes/progress');
const bodyweightRouter = require('./routes/bodyweight');
const pushRouter = require('./routes/push');
const settingsRouter = require('./routes/settings');
const exportRouter = require('./routes/export');
const importRouter = require('./routes/import');
const platedRouter = require('./routes/plated');
const nudge = require('./nudge');

init();
console.log('DB ready');
try {
  push.init();
  console.log('Push ready');
} catch (err) {
  console.warn('Push init failed:', err.message);
}
nudge.start();
console.log('Nudge cron started');

const app = express();
// 50mb covers years of workout history in a single import. Server is
// single-tenant so payload-flood DoS isn't a real concern here.
app.use(express.json({ limit: '50mb' }));

app.get('/api/orbit-summary', (req, res) => {
  const workout = db.prepare(
    `SELECT id, finished_at FROM workouts WHERE finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`
  ).get();

  if (!workout) {
    return res.json({
      label: 'Last workout',
      stat: 'No workouts logged',
      status: 'paused',
      updatedAt: new Date().toISOString()
    });
  }

  const topSet = db.prepare(
    `SELECT s.weight, s.weight_unit, s.reps, e.name AS exercise_name
     FROM sets s
     JOIN exercises e ON e.id = s.exercise_id
     WHERE s.workout_id = ? AND s.is_warmup = 0 AND s.reps > 0
     ORDER BY (CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.453592 ELSE s.weight END) DESC
     LIMIT 1`
  ).get(workout.id);

  const finishedMs = new Date(workout.finished_at.replace(' ', 'T') + 'Z').getTime();
  const daysAgo = Math.floor((Date.now() - finishedMs) / 86400000);
  const agoStr = daysAgo === 0 ? 'today' : daysAgo === 1 ? 'yesterday' : `${daysAgo} days ago`;
  const setStr = topSet
    ? `${topSet.exercise_name} ${topSet.weight}${topSet.weight_unit}×${topSet.reps}`
    : 'no sets logged';

  res.json({
    label: 'Last workout',
    stat: `${agoStr} · ${setStr}`,
    status: daysAgo <= 3 ? 'active' : 'paused',
    updatedAt: new Date(workout.finished_at.replace(' ', 'T') + 'Z').toISOString()
  });
});

app.use('/api/exercises', exercisesRouter);
app.use('/api/programs', programsRouter);
app.use('/api/workouts', workoutsRouter);
app.use('/api/sets', setsRouter);
app.use('/api/bodyweight', bodyweightRouter);
app.use('/api/push', pushRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/export', exportRouter);
app.use('/api/import', importRouter);
app.use('/api/plated', platedRouter);
app.use('/api', progressRouter);

app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IronLog running on port ${PORT}`);
});
