const express = require('express');
const path = require('path');
const { init } = require('./db');
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

app.use('/api/exercises', exercisesRouter);
app.use('/api/programs', programsRouter);
app.use('/api/workouts', workoutsRouter);
app.use('/api/sets', setsRouter);
app.use('/api/bodyweight', bodyweightRouter);
app.use('/api/push', pushRouter);
app.use('/api/settings', settingsRouter);
app.use('/api/export', exportRouter);
app.use('/api/import', importRouter);
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
