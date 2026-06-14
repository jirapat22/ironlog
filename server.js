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
const orbitRouter = require('./routes/orbit');
const notesRouter = require('./routes/notes');
const authRouter = require('./routes/auth');
const { requireProfile } = require('./auth');
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
// 50mb covers years of workout history in a single import. This is a small
// private multi-user app (a handful of trusted profiles), so payload-flood DoS
// isn't a real concern here.
app.use(express.json({ limit: '50mb' }));

// Security headers. CSP locks scripts to same-origin (Chart.js is vendored
// locally, no CDN). 'unsafe-inline' is needed only for style-src because the
// UI renders inline style="" attributes; no inline <script> is used.
app.use((req, res, next) => {
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data:",
      "connect-src 'self'",
      "manifest-src 'self'",
      "worker-src 'self'",
      "object-src 'none'",
      "base-uri 'self'",
      "frame-ancestors 'none'"
    ].join('; ')
  );
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});

// Unauthenticated: uptime probe.
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Auth endpoints (login / profile creation / status) must be reachable
// WITHOUT a session, so they are mounted before the requireProfile gate. The
// /me, /logout, /passcode routes guard themselves with requireProfile.
app.use('/api/auth', authRouter);

// Plated integration is machine-to-machine — mounted BEFORE the session gate
// so it can authenticate by per-profile API key instead of a browser session.
app.use('/api/plated', platedRouter);

// Orbit admin feed — read-only cross-profile dashboard. Has its own optional
// API-key gate (ORBIT_API_KEY), so it is mounted before the session gate too.
app.use('/api/orbit', orbitRouter);

// Everything below this line requires a valid per-profile session. The gate is
// scoped to /api so the static app shell + lock screen still load unauthenticated
// (the cookie-based login can't render otherwise). It sets req.profileId for all
// downstream API routes.
app.use('/api', requireProfile);

app.get('/api/orbit-summary', (req, res) => {
  const workout = db.prepare(
    `SELECT id, finished_at FROM workouts WHERE profile_id = ? AND finished_at IS NOT NULL ORDER BY finished_at DESC LIMIT 1`
  ).get(req.profileId);

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
app.use('/api/notes', notesRouter);
app.use('/api', progressRouter);

// Unknown API paths get a JSON 404 instead of falling through to the SPA
// catch-all (which would otherwise return index.html with a 200).
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'not found' });
});

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Global error handler — keeps API failures as JSON. Stack is hidden in
// production (NODE_ENV=production is set in the Dockerfile).
app.use((err, req, res, next) => {
  console.error(err);
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'internal server error' : err.message
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IronLog running on port ${PORT}`);
});
