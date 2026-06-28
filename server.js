const express = require('express');
const path = require('path');
const zlib = require('zlib');
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
const bugReportRouter = require('./routes/bugReport');
const { requireProfile, optionalProfile } = require('./auth');
const { recordBugReport } = require('./lib/bugReports');
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
// Railway terminates TLS at a single proxy hop in front of us. Trust exactly
// that one hop so req.ip is the real client address (used by the login
// rate-limiter) instead of the proxy's. Using 1 rather than `true` means a
// client can't spoof X-Forwarded-For to dodge the limit — Express only trusts
// the entry our own proxy appended.
app.set('trust proxy', 1);

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

// Hand-rolled gzip compression. The service worker re-fetches the entire app
// shell over the network on every cold launch (network-first, see sw.js), so
// compressing it is worth more here than in a typical app. No `compression`
// package — this is small enough to own directly and skip the dependency.
// Brotli was benchmarked and rejected: quality 11 (the ratio worth having)
// costs ~180ms synchronously per request on the largest asset, which is too
// slow without an added caching layer.
const COMPRESSIBLE_TYPE = /^(text\/|application\/javascript|application\/json|application\/manifest\+json|image\/svg\+xml)/;
app.use((req, res, next) => {
  if (req.headers.range || !(req.headers['accept-encoding'] || '').includes('gzip')) return next();

  const originalWrite = res.write.bind(res);
  const originalEnd = res.end.bind(res);
  const chunks = [];

  res.write = (chunk, ...args) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, args[0] && typeof args[0] === 'string' ? args[0] : 'utf8'));
    const cb = args[args.length - 1];
    if (typeof cb === 'function') cb();
    return true;
  };

  res.end = (chunk, ...args) => {
    if (chunk) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk, args[0] && typeof args[0] === 'string' ? args[0] : 'utf8'));
    const body = Buffer.concat(chunks);
    const contentType = res.getHeader('Content-Type') || '';

    if (res.getHeader('Content-Encoding') || !COMPRESSIBLE_TYPE.test(contentType) || body.length < 1024) {
      res.write = originalWrite;
      res.end = originalEnd;
      return originalEnd(body);
    }

    const compressed = zlib.gzipSync(body);
    res.setHeader('Content-Encoding', 'gzip');
    res.setHeader('Content-Length', compressed.length);
    res.write = originalWrite;
    res.end = originalEnd;
    return originalEnd(compressed);
  };

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

// Bug reports — must work even pre-login (lock-screen errors), so mounted
// before the session gate. optionalProfile attaches profile_id if a valid
// session exists, but never rejects.
app.use('/api/bug-report', optionalProfile, bugReportRouter);

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
  if (!err.status || err.status >= 500) {
    // Route through the shared pipeline so a flapping 500 is deduped (5-min
    // window) instead of inserting a row + Orbit POST on every request.
    recordBugReport({
      profileId: req.profileId || null,
      source: 'backend',
      message: err.message || 'unknown error',
      stack: err.stack || null,
      context: { method: req.method, path: req.originalUrl, kind: 'unhandled' }
    });
  }
  if (res.headersSent) return next(err);
  res.status(err.status || 500).json({
    error: process.env.NODE_ENV === 'production' ? 'internal server error' : err.message
  });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`IronLog running on port ${PORT}`);
});
