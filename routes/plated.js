/**
 * /api/plated/* — Read-only integration endpoints for the Plated meal tracker.
 *
 * Plated calls these to sync the user's fitness profile and activity data so it
 * can set accurate calorie / macro targets without the user entering them twice.
 *
 * Endpoints
 * ---------
 *  GET /api/plated/profile
 *      Current bodyweight, TDEE, and daily macro/calorie goals derived from the
 *      user's IronLog profile settings (height, age, activity, goal, sex).
 *
 *  GET /api/plated/bodyweight?limit=30
 *      Recent bodyweight log entries normalised to kg so Plated can overlay
 *      body-composition trends on top of nutrition data.
 *
 *  GET /api/plated/workouts/calories?date=YYYY-MM-DD&tz=<minutes>
 *      Estimated calories burned from strength sessions on a given LOCAL date.
 *      Uses the explicit calories_burned column when set, otherwise estimates
 *      at 4 kcal/min (conservative for resistance training). `tz` is
 *      Date.getTimezoneOffset() minutes (e.g. NZ at UTC+12 sends -720);
 *      missing/invalid tz defaults to UTC.
 *
 *  GET /api/plated/workouts/recent?limit=7&tz=<minutes>
 *      Last N distinct LOCAL workout days — useful for Plated to bump the
 *      calorie target on training days automatically. Same `tz` convention.
 *
 * All responses: { success: true, data: {...} } | { success: false, error: "..." }
 * CORS is fully open (*) — Plated handles its own auth.
 * Set PLATED_ORIGIN env var to lock it down to a specific domain.
 */

'use strict';

const express = require('express');
const { db } = require('../db');
const { platedAuth } = require('../auth');
const { assertInvariant } = require('../lib/bugReports');

const router = express.Router();

// ---------------------------------------------------------------------------
// CORS — allow Plated (different Railway domain) to call these routes.
// Locked to PLATED_ORIGIN; we never emit a wildcard so a random site can't
// read the user's health data cross-origin. Same-origin server calls work
// regardless (no CORS header needed).
// ---------------------------------------------------------------------------
router.use((req, res, next) => {
  const origin = process.env.PLATED_ORIGIN;
  if (origin) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-API-Key');
  }
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// API-key gate (after CORS/OPTIONS so preflight is never blocked).
router.use(platedAuth);

// ---------------------------------------------------------------------------
// Helpers (mirror the TDEE logic from the frontend)
// ---------------------------------------------------------------------------
const ACTIVITY_MULTIPLIERS = {
  sedentary: 1.2,
  light:     1.375,
  moderate:  1.55,
  very:      1.725,
  athlete:   1.9
};

const GOAL_OFFSETS = { cut: -500, maintain: 0, bulk: 300 };

function getSetting(profileId, key) {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE profile_id = ? AND key = ?')
    .get(profileId, key);
  return row?.value ?? null;
}

function toKg(weight, unit) {
  return unit === 'lbs' ? weight * 0.45359237 : weight;
}

/** Mifflin–St Jeor BMR (kcal/day). */
function calcBmr(weightKg, heightCm, age, sex) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'female' ? base - 161 : base + 5;
}

/**
 * Compute daily macro targets for a given goal calorie total.
 *  Protein: 2.2 g/kg on cut (preserve muscle), 2.0 g/kg otherwise
 *  Fat:     25% of total calories
 *  Carbs:   remainder
 *  Fiber:   14 g per 1000 kcal (USDA proportional guideline)
 */
function computeMacros(goalKcal, weightKg, goal) {
  const proteinPerKg = goal === 'cut' ? 2.2 : 2.0;
  const proteinG     = Math.round(weightKg * proteinPerKg);
  const fatG         = Math.round((goalKcal * 0.25) / 9);
  const carbG        = Math.max(0, Math.round((goalKcal - proteinG * 4 - fatG * 9) / 4));
  const fiberG       = Math.round((goalKcal / 1000) * 14);
  return { proteinG, carbG, fatG, fiberG, proteinPerKg };
}

// Fallback kcal/min for the rare workout with no bodyweight snapshot to drive
// the per-exercise model. Finished workouts normally carry a precomputed
// calories_burned, so this is only a backstop.
const KCAL_PER_MIN = 4;

// ---------------------------------------------------------------------------
// Timezone helpers — workouts are stored with started_at in UTC, but Plated
// wants calories bucketed by the user's LOCAL calendar day (otherwise a
// morning session in NZ, UTC+12, files under the previous UTC day).
//
// `tz` follows JS's Date.getTimezoneOffset() convention: minutes UTC is AHEAD
// of local (NZ at UTC+12 sends tz = -720). So localMs = utcMs - tz * 60000.
// Missing/invalid tz defaults to 0 (UTC), matching the old behaviour.
// ---------------------------------------------------------------------------
function getTzOffsetMinutes(req) {
  const tz = Number(req.query.tz);
  if (!Number.isFinite(tz)) return 0;
  return Math.max(-840, Math.min(840, Math.trunc(tz)));
}

// SQLite `date(started_at, modifier)` modifier that converts a UTC timestamp
// to the user's local calendar date. shift = -tz minutes (NZ tz=-720 -> +720).
function localDateModifier(tzOffsetMin) {
  const shift = -tzOffsetMin;
  return `${shift >= 0 ? '+' : ''}${shift} minutes`;
}

// Format a UTC epoch as the local YYYY-MM-DD for the given tz offset.
function localDateStr(utcMs, tzOffsetMin) {
  const d = new Date(utcMs - tzOffsetMin * 60000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}

// ---------------------------------------------------------------------------
// Routes
// ---------------------------------------------------------------------------

/** GET /api/plated/ — connection test / discovery */
router.get('/', (req, res) => {
  res.json({
    success: true,
    data: {
      service: 'IronLog',
      version: 1,
      endpoints: [
        'GET /api/plated/profile',
        'GET /api/plated/bodyweight',
        'POST /api/plated/bodyweight',
        'GET /api/plated/workouts/calories',
        'GET /api/plated/workouts/recent'
      ]
    }
  });
});

/**
 * GET /api/plated/profile
 * Returns the full nutrition profile Plated needs at startup / refresh.
 */
router.get('/profile', (req, res) => {
  try {
    const pid = req.profileId;
    const bwRow = db
      .prepare('SELECT weight, weight_unit FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC LIMIT 1')
      .get(pid);

    const heightCm   = Number(getSetting(pid, 'profile_height_cm') || 0);
    const age        = Number(getSetting(pid, 'profile_age')        || 0);
    const activityKey = getSetting(pid, 'profile_activity') || 'moderate';
    const sex        = getSetting(pid, 'strength_standard_gender') === 'female' ? 'female' : 'male';
    const goal       = ['cut', 'maintain', 'bulk'].includes(getSetting(pid, 'profile_goal'))
      ? getSetting(pid, 'profile_goal')
      : 'maintain';

    const weightKg = bwRow ? +toKg(bwRow.weight, bwRow.weight_unit).toFixed(2) : null;

    const profileComplete = !!(weightKg && heightCm && age);

    let tdee       = null;
    let goalKcal   = null;
    let macros     = null;

    if (profileComplete) {
      const bmr        = calcBmr(weightKg, heightCm, age, sex);
      const multiplier = ACTIVITY_MULTIPLIERS[activityKey] || 1.55;
      tdee             = Math.round(bmr * multiplier);
      goalKcal         = tdee + (GOAL_OFFSETS[goal] ?? 0);
      macros           = computeMacros(goalKcal, weightKg, goal);

      const macroKcal = macros.proteinG * 4 + macros.carbG * 4 + macros.fatG * 9;
      assertInvariant(Math.abs(macroKcal - goalKcal) <= 50, 'macro grams do not add up to the calorie goal', {
        profileId: pid, goalKcal, macroKcal, macros
      });
    }

    res.json({
      success: true,
      data: {
        bodyweight_kg:    weightKg,
        tdee_kcal:        tdee,
        goal,
        calorie_goal:     goalKcal,
        protein_g:        macros?.proteinG  ?? null,
        carbs_g:          macros?.carbG     ?? null,
        fat_g:            macros?.fatG      ?? null,
        fiber_g:          macros?.fiberG    ?? null,
        profile_complete: profileComplete,
        meta: {
          height_cm:    heightCm || null,
          age,
          sex,
          activity:     activityKey,
          protein_g_per_kg: macros?.proteinPerKg ?? null
        }
      }
    });
  } catch (err) {
    console.error(err); res.status(500).json({ success: false, error: 'internal server error' });
  }
});

/**
 * GET /api/plated/bodyweight?limit=30
 * Returns recent bodyweight entries normalised to kg.
 */
router.get('/bodyweight', (req, res) => {
  try {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const rows = db
      .prepare(
        'SELECT logged_at, weight, weight_unit FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC LIMIT ?'
      )
      .all(req.profileId, limit);

    res.json({
      success: true,
      data: rows.map((r) => ({
        date:      r.logged_at.replace(' ', 'T') + 'Z',
        weight_kg: +toKg(r.weight, r.weight_unit).toFixed(2)
      }))
    });
  } catch (err) {
    console.error(err); res.status(500).json({ success: false, error: 'internal server error' });
  }
});

/**
 * POST /api/plated/bodyweight
 * Lets Plated push a bodyweight entry into IronLog (two-way sync).
 * Body: { weight_kg, date? } — date defaults to today (YYYY-MM-DD).
 * Manual weigh-ins are never touched: we only collapse a *previous Plated push*
 * for the same day (so re-syncing the same day stays idempotent instead of
 * piling up). Any hand-entered logs for that day are kept alongside.
 */
router.post('/bodyweight', (req, res) => {
  try {
    const { weight_kg, weight, weight_unit, date } = req.body || {};
    let kg = weight_kg != null ? Number(weight_kg)
      : weight != null ? toKg(Number(weight), weight_unit) : null;
    if (kg == null || !Number.isFinite(kg) || kg <= 0 || kg > 700) {
      return res.status(400).json({ success: false, error: 'weight_kg must be a positive number' });
    }
    kg = +kg.toFixed(2);

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
    }
    const day = date && /^\d{4}-\d{2}-\d{2}$/.test(date)
      ? date
      : new Date().toISOString().slice(0, 10);

    // Plated sends only a calendar date. Anchor it at the user's LOCAL noon
    // (expressed in UTC) so it displays on `day` in the app — otherwise a naive
    // "noon" reads as UTC and tips onto the next day in far-east zones
    // (e.g. UTC+12/+13 Auckland: noon-UTC shows as the following day).
    // The app persists Date.getTimezoneOffset() (minutes WEST of UTC) as
    // nudge_tz_offset_minutes on every load; UTC = local + west.
    let west = Number(getSetting(req.profileId, 'nudge_tz_offset_minutes')) || 0;
    west = Math.max(-840, Math.min(840, Math.trunc(west)));
    const [y, m, d] = day.split('-').map(Number);
    const loggedAt = new Date(Date.UTC(y, m - 1, d, 12, 0, 0) + west * 60000)
      .toISOString()
      .slice(0, 19)
      .replace('T', ' ');

    // Dedupe by the user's LOCAL date (logged_at shifted back by the offset),
    // and only against a prior Plated push — manual weigh-ins are always kept.
    const localMod = `${-west} minutes`;
    const existing = db
      .prepare("SELECT id FROM bodyweights WHERE profile_id = ? AND notes = 'via Plated' AND date(logged_at, ?) = ?")
      .get(req.profileId, localMod, day);

    if (existing) {
      db.prepare("UPDATE bodyweights SET weight = ?, weight_unit = 'kg', logged_at = ? WHERE id = ?")
        .run(kg, loggedAt, existing.id);
    } else {
      db.prepare("INSERT INTO bodyweights (profile_id, weight, weight_unit, logged_at, notes) VALUES (?, ?, 'kg', ?, 'via Plated')")
        .run(req.profileId, kg, loggedAt);
    }

    res.json({ success: true, data: { date: day, weight_kg: kg, updated: !!existing } });
  } catch (err) {
    console.error(err); res.status(500).json({ success: false, error: 'internal server error' });
  }
});

/**
 * GET /api/plated/workouts/calories?date=YYYY-MM-DD&tz=<minutes>
 * Calories burned from strength sessions on a given LOCAL date (defaults to
 * today in the caller's timezone). `tz` is Date.getTimezoneOffset() minutes;
 * missing/invalid tz defaults to UTC.
 */
router.get('/workouts/calories', (req, res) => {
  try {
    const tz = getTzOffsetMinutes(req);
    const mod = localDateModifier(tz);
    const date = req.query.date || localDateStr(Date.now(), tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      return res.status(400).json({ success: false, error: 'date must be YYYY-MM-DD' });
    }

    const rows = db
      .prepare(
        `SELECT
           w.id,
           COALESCE(pd.day_label, 'Workout') AS name,
           w.started_at,
           w.finished_at,
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
           AND date(w.started_at, ?) = ?
           AND w.finished_at IS NOT NULL`
      )
      .all(req.profileId, mod, date);

    // Cross-check the SQL date() bucketing above against the JS tz-bucketing
    // helper used elsewhere — they implement the same rule independently, so
    // a drift between them (e.g. an edge-of-day boundary) is a real bug.
    for (const w of rows) {
      const startedMs = new Date(w.started_at.replace(' ', 'T') + 'Z').getTime();
      assertInvariant(localDateStr(startedMs, tz) === date, 'workout bucketed to wrong local day', {
        profileId: req.profileId, workoutId: w.id, requestedDate: date, startedAt: w.started_at, tz
      });
    }

    const sessions = rows.map((w) => {
      const burned =
        w.calories_burned != null
          ? w.calories_burned
          : w.duration_minutes != null
            ? Math.round(w.duration_minutes * KCAL_PER_MIN)
            : null;
      return {
        name:             w.name,
        duration_minutes: w.duration_minutes,
        calories_burned:  burned
      };
    });

    const totalBurned = sessions.reduce((acc, s) => acc + (s.calories_burned || 0), 0);

    res.json({
      success: true,
      data: {
        date,
        calories_burned: totalBurned,
        sessions,
        note: 'calories_burned estimated at 4 kcal/min for sessions without explicit calorie data. Set workouts.calories_burned directly to override.'
      }
    });
  } catch (err) {
    console.error(err); res.status(500).json({ success: false, error: 'internal server error' });
  }
});

/**
 * GET /api/plated/workouts/recent?limit=7&tz=<minutes>
 * Recent distinct workout days (in the caller's LOCAL timezone) with session
 * counts and estimated calories burned. `tz` is Date.getTimezoneOffset()
 * minutes; missing/invalid tz defaults to UTC.
 */
router.get('/workouts/recent', (req, res) => {
  try {
    const tz = getTzOffsetMinutes(req);
    const mod = localDateModifier(tz);
    const limit = Math.min(30, Math.max(1, Number(req.query.limit) || 7));

    const rows = db
      .prepare(
        `SELECT
           date(started_at, ?) AS date,
           COUNT(*)            AS session_count,
           SUM(
             COALESCE(
               calories_burned,
               CASE
                 WHEN finished_at IS NOT NULL
                 THEN CAST(ROUND(
                        (julianday(finished_at) - julianday(started_at)) * 24 * 60 * ?
                      ) AS INTEGER)
                 ELSE 0
               END
             )
           ) AS calories_burned
         FROM workouts
         WHERE profile_id = ?
           AND finished_at IS NOT NULL
         GROUP BY date(started_at, ?)
         ORDER BY date(started_at, ?) DESC
         LIMIT ?`
      )
      .all(mod, KCAL_PER_MIN, req.profileId, mod, mod, limit);

    res.json({
      success: true,
      data: rows.map((r) => ({
        date:            r.date,
        session_count:   r.session_count,
        calories_burned: r.calories_burned || 0
      }))
    });
  } catch (err) {
    console.error(err); res.status(500).json({ success: false, error: 'internal server error' });
  }
});

/**
 * GET /api/plated/whoami
 * Confirms which profile owns the presented API key. Used to verify the
 * Plated <-> IronLog link. Never returns the key itself.
 */
router.get('/whoami', (req, res) => {
  res.json({
    success: true,
    data: { profile_id: req.profile.id, name: req.profile.name }
  });
});

module.exports = router;
