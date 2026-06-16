/**
 * GET /api/orbit — read-only cross-profile overview for the Orbit dashboard.
 *
 * Open by default (single-admin use). If ORBIT_API_KEY is set, the request must
 * present it via `X-API-Key` or `Authorization: Bearer <key>`. Never exposes
 * passcodes or per-profile API keys.
 *
 * Mirrors Plated's response envelope conventions so Orbit can treat both the
 * same. This is additive — the existing /api/orbit-summary endpoint is untouched.
 */

'use strict';

const express = require('express');
const { db } = require('../db');

const router = express.Router();

// Fallback kcal/min for workouts with no stored calories (matches plated.js).
const KCAL_PER_MIN = 4;

// Optional API-key gate. When ORBIT_API_KEY is unset the feed is open.
router.use((req, res, next) => {
  const expected = (process.env.ORBIT_API_KEY || '').trim();
  if (!expected) return next();
  const provided = (
    req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    ''
  ).trim();
  if (provided && provided === expected) return next();
  return res.status(401).json({ success: false, error: 'invalid or missing API key' });
});

// Build a { date, trained, calories_burned, sessions:[...] } summary for one
// profile on one UTC calendar date.
function daySummary(profileId, date) {
  const rows = db
    .prepare(
      `SELECT
         COALESCE(pd.day_label, 'Workout') AS name,
         w.calories_burned,
         CASE
           WHEN w.finished_at IS NOT NULL
           THEN CAST(ROUND(
                  (julianday(w.finished_at) - julianday(w.started_at)) * 24 * 60
                ) AS INTEGER)
           ELSE NULL
         END AS duration_minutes
       FROM workouts w
       LEFT JOIN program_days pd ON pd.id = w.program_day_id
       WHERE w.profile_id = ?
         AND date(w.started_at) = ?
         AND w.finished_at IS NOT NULL`
    )
    .all(profileId, date);

  const sessions = rows.map((w) => {
    const burned =
      w.calories_burned != null
        ? w.calories_burned
        : w.duration_minutes != null
          ? Math.round(w.duration_minutes * KCAL_PER_MIN)
          : 0;
    return {
      name: w.name,
      duration_minutes: w.duration_minutes,
      calories_burned: burned
    };
  });

  const caloriesBurned = sessions.reduce((acc, s) => acc + (s.calories_burned || 0), 0);
  return { date, trained: sessions.length > 0, calories_burned: caloriesBurned, sessions };
}

function ymd(d) {
  return d.toISOString().slice(0, 10);
}

// Most recent activity for a profile: last login, last finished workout, or
// last bodyweight entry — whichever is newest. ISO string or null.
function lastActive(profileId) {
  const row = db
    .prepare(
      `SELECT MAX(t) AS t FROM (
         SELECT MAX(created_at)  AS t FROM sessions    WHERE profile_id = ?
         UNION ALL
         SELECT MAX(finished_at) AS t FROM workouts    WHERE profile_id = ? AND finished_at IS NOT NULL
         UNION ALL
         SELECT MAX(logged_at)   AS t FROM bodyweights WHERE profile_id = ?
       )`
    )
    .get(profileId, profileId, profileId);
  if (!row?.t) return null;
  return row.t.replace(' ', 'T') + 'Z';
}

router.get('/', (req, res) => {
  try {
    const today = ymd(new Date());
    const yesterday = ymd(new Date(Date.now() - 86400000));

    const profiles = db
      .prepare('SELECT id, name, accent_color, created_at FROM profiles ORDER BY id')
      .all();

    const users = profiles.map((p) => ({
      id: p.id,
      name: p.name,
      accent_color: p.accent_color,
      created_at: p.created_at ? p.created_at.replace(' ', 'T') + 'Z' : null,
      last_active: lastActive(p.id),
      today: daySummary(p.id, today),
      yesterday: daySummary(p.id, yesterday)
    }));

    // Open notes (ideas & bugs) — included so Orbit can track and resolve them.
    const notes = db
      .prepare('SELECT id, text, category, done, created_at FROM notes WHERE done = 0 ORDER BY created_at DESC')
      .all()
      .map((n) => ({ ...n, created_at: n.created_at ? n.created_at.replace(' ', 'T') + 'Z' : null }));

    res.json({
      app: 'ironlog',
      generated_at: new Date().toISOString(),
      user_count: users.length,
      users,
      open_notes: notes
    });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// DELETE /api/orbit/notes/:id — called by Orbit when it marks an item resolved.
// Auth reuses the same X-API-Key / ORBIT_API_KEY gate as the pull feed above.
router.delete('/notes/:id', (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isFinite(id)) return res.status(400).json({ error: 'invalid id' });
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'not found' });
  res.json({ deleted: true, id });
});

module.exports = router;
