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

init();
console.log('DB ready');
try {
  push.init();
  console.log('Push ready');
} catch (err) {
  console.warn('Push init failed:', err.message);
}

const app = express();
app.use(express.json({ limit: '1mb' }));

app.use('/api/exercises', exercisesRouter);
app.use('/api/programs', programsRouter);
app.use('/api/workouts', workoutsRouter);
app.use('/api/sets', setsRouter);
app.use('/api/bodyweight', bodyweightRouter);
app.use('/api/push', pushRouter);
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
