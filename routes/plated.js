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
 *      `tdee_includes_workouts` tells the caller whether `tdee_kcal` (and thus
 *      `calorie_goal`) already prices in a typical training week: true at
 *      activity levels moderate/very/athlete, false at sedentary/light. When
 *      true, adding `workouts/calories` on top double-counts training energy
 *      — only add it on top when this is false. `cut`/`bulk` offsets are the
 *      user's own `profile_cut_deficit`/`profile_bulk_surplus` settings
 *      (defaults 500/300 kcal), not fixed constants.
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

// What a caller can assume about the SHAPE of what comes back. Reported in
// every payload Plated actually fetches, not just on the index it never calls,
// because the deciding question is per-INSTANCE: IronLog is deployed more than
// once (Plated stores a URL and key per profile), so "has this contract" is a
// property of the server answering right now, not of the integration.
//
// A deployment older than this simply omits the field. undefined therefore
// means "assume the old shape", which is the safe direction — a caller that
// gates its legacy fallbacks on `contract_version >= 3` keeps them exactly
// where they are still needed and drops them everywhere else, with no fleet
// audit and no extra round trip.
//
//   1  original: profile, bodyweight, workouts/calories, workouts/recent
//   2  + GET /summary, POST /profile, calories_estimated/calories_source
//   3  + bodyweight rows are { date, logged_at, bodyweight_kg }; `date` is
//        ALWAYS a plain local YYYY-MM-DD and an instant always keeps its own
//        name; ?tzOffset= accepted alongside ?tz=
const CONTRACT_VERSION = 3;

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

// A user-set kcal offset. `|| fallback` can't be used here: a deliberate 0
// ("cut at maintenance") is falsy and would silently snap back to 500/300,
// which is what the profile sheet did when you saved a 0 and reopened it.
// Only a missing/unparseable value gets the default.
function readKcalOffset(raw, fallback) {
  // Missing must come FIRST. getSetting() returns null for an absent row and
  // Number(null) is 0 — which is finite, so a bare isFinite check handed back
  // a 0 kcal offset for every user who had never saved the Profile sheet,
  // silently telling Plated a cutting user should eat at maintenance. Only a
  // real stored value reaches the numeric path; '0' still means 0.
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Math.abs(Number(raw));
  return Number.isFinite(n) ? Math.min(n, 2000) : fallback;
}

// Floor for the daily target. The offsets became user-adjustable (0-2000)
// without one, so a small TDEE plus a large deficit produced a NEGATIVE goal
// — and with it negative fat grams and negative macro percentages, shipped
// to Plated as a real number. Floor only: never below 1200 kcal, and the
// floor itself is capped at TDEE so clamping a cut can't push the target
// ABOVE maintenance for a very small user. A bulk still exceeds TDEE, as it
// should — nothing here caps the upper end.
function floorGoalKcal(goalKcal, tdee) {
  // Math.max(0, ...) so a nonsensical TDEE can't make the floor itself
  // negative and pass a negative goal straight through.
  return Math.max(Math.max(0, Math.min(1200, tdee)), goalKcal);
}

// Every endpoint here answers {success, data} or {success:false, error} —
// one envelope, no exceptions, so a caller never has to guess whether a
// payload is wrapped.
function badRequest(message) {
  const err = new Error(message);
  err.status = 400;
  return err;
}

function plated(req, res, build) {
  try {
    res.json({ success: true, data: build(req) });
  } catch (err) {
    if (err?.status === 400) return res.status(400).json({ success: false, error: err.message });
    console.error(err);
    res.status(500).json({ success: false, error: 'internal server error' });
  }
}

function getSetting(profileId, key) {
  const row = db
    .prepare('SELECT value FROM app_settings WHERE profile_id = ? AND key = ?')
    .get(profileId, key);
  return row?.value ?? null;
}

// Same upsert routes/settings.js uses, so a value written here is
// indistinguishable from one the user typed into IronLog's own form.
function setSetting(profileId, key, value) {
  db.prepare(
    'INSERT INTO app_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value'
  ).run(profileId, key, value);
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
// Two opposite conventions exist in this codebase and copying a call site
// between them silently flips the sign — which is how a weigh-in lands a day
// early. Both are accepted here, under names that say which is which:
//
//   ?tzOffset=  minutes EAST of UTC, i.e. -getTimezoneOffset(). What every
//               /api/* endpoint takes. Preferred; send this.
//   ?tz=        raw getTimezoneOffset(). The original /api/plated/* spelling,
//               kept working because Plated ships it today.
//
// Returned in the RAW convention, which is what localDateModifier/localDateStr
// below consume. Named getTzOffsetMinutes, not ...East, for that reason.
function getTzOffsetMinutes(req) {
  const east = Number(req.query.tzOffset);
  if (Number.isFinite(east)) return Math.max(-840, Math.min(840, Math.trunc(-east)));
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
      version: CONTRACT_VERSION,
      contract_version: CONTRACT_VERSION,
      endpoints: [
        'GET /api/plated/summary',
        'GET /api/plated/profile',
        'POST /api/plated/profile',
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
// Age is derived, never stored, whenever a birth year is on file: Plated
// pushes birth_year precisely because a stored age silently goes wrong for up
// to twelve months. profile_age remains the fallback for anyone who typed an
// age into IronLog's own form before this existed.
function resolveAge(pid) {
  const birthYear = Number(getSetting(pid, 'profile_birth_year') || 0);
  if (birthYear >= 1900 && birthYear <= 2100) {
    return Math.max(0, new Date().getUTCFullYear() - birthYear);
  }
  return Number(getSetting(pid, 'profile_age') || 0);
}

// The body of GET /profile, lifted out so POST /profile can answer with the
// recomputed figures in the same round trip, and GET /summary can embed it.
function buildProfilePayload(pid) {
    const bwRow = db
      .prepare('SELECT weight, weight_unit FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC LIMIT 1')
      .get(pid);

    const heightCm   = Number(getSetting(pid, 'profile_height_cm') || 0);
    const age        = resolveAge(pid);
    const activityKey = getSetting(pid, 'profile_activity') || 'moderate';
    const sex        = getSetting(pid, 'strength_standard_gender') === 'female' ? 'female' : 'male';
    const goal       = ['cut', 'maintain', 'bulk'].includes(getSetting(pid, 'profile_goal'))
      ? getSetting(pid, 'profile_goal')
      : 'maintain';
    const cutDeficit  = readKcalOffset(getSetting(pid, 'profile_cut_deficit'), 500);
    const bulkSurplus = readKcalOffset(getSetting(pid, 'profile_bulk_surplus'), 300);
    const GOAL_OFFSETS = { cut: -cutDeficit, maintain: 0, bulk: bulkSurplus };

    // Mirrors the "eat back" logic in the app's own TDEE card (progress.js):
    // sedentary/light activity multipliers assume no regular training, so a
    // logged workout's calories are extra and should be added on top. At
    // moderate and above, the multiplier itself already prices in a typical
    // training week — adding workouts/calories on top there double-counts them.
    const tdeeIncludesWorkouts = activityKey !== 'sedentary' && activityKey !== 'light';

    const weightKg = bwRow ? +toKg(bwRow.weight, bwRow.weight_unit).toFixed(2) : null;

    const profileComplete = !!(weightKg && heightCm && age);

    let tdee       = null;
    let goalKcal   = null;
    let macros     = null;

    if (profileComplete) {
      // Rounded here to match renderTdeeSection in public/progress.js exactly.
      // Unrounded is marginally more accurate, but the app and Plated quoting
      // different numbers for the same profile is the worse failure.
      const bmr        = Math.round(calcBmr(weightKg, heightCm, age, sex));
      const multiplier = ACTIVITY_MULTIPLIERS[activityKey] || 1.55;
      tdee             = Math.round(bmr * multiplier);
      goalKcal         = floorGoalKcal(tdee + (GOAL_OFFSETS[goal] ?? 0), tdee);
      macros           = computeMacros(goalKcal, weightKg, goal);

      // Carbs are the balancing macro, derived to fill what's left after
      // protein + fat. When they hit the 0 floor (protein + fat alone already
      // exceed the goal — e.g. a heavy lifter on an aggressive cut), the totals
      // legitimately overshoot, so only assert the balance when carbs absorbed
      // the remainder.
      const macroKcal = macros.proteinG * 4 + macros.carbG * 4 + macros.fatG * 9;
      if (macros.carbG > 0) {
        assertInvariant(Math.abs(macroKcal - goalKcal) <= 50, 'macro grams do not add up to the calorie goal', {
          profileId: pid, goalKcal, macroKcal, macros
        });
      } else {
        // Carbs floored at 0, so the totals legitimately overshoot and the
        // balance check above cannot hold. Gating on carbG > 0 and asserting
        // nothing here left the branch where things actually go wrong with no
        // check at all. The overshoot is only legitimate when protein + fat
        // ALREADY meet or exceed the goal — that's what makes carbs zero. If
        // they don't, the carb calculation dropped calories on the floor.
        assertInvariant(macros.proteinG * 4 + macros.fatG * 9 >= goalKcal - 50,
          'carbs floored at 0 without protein+fat accounting for the goal', {
            profileId: pid, goalKcal, macroKcal, macros
          });
      }
    }

    return {
        contract_version: CONTRACT_VERSION,
        bodyweight_kg:    weightKg,
        tdee_kcal:        tdee,
        tdee_includes_workouts: tdeeIncludesWorkouts,
        goal,
        calorie_goal:     goalKcal,
        protein_g:        macros?.proteinG  ?? null,
        carbs_g:          macros?.carbG     ?? null,
        fat_g:            macros?.fatG      ?? null,
        fiber_g:          macros?.fiberG    ?? null,
        profile_complete: profileComplete,
        meta: {
          height_cm:    heightCm || null,
          // null, not 0, for "not set" — height_cm right above uses that
          // convention and a consumer shouldn't have to know that one field
          // says 0 and its neighbour says null for the same state.
          age:          age || null,
          sex,
          activity:     activityKey,
          birth_year:   Number(getSetting(pid, 'profile_birth_year') || 0) || null,
          protein_g_per_kg: macros?.proteinPerKg ?? null
        }
    };
}

router.get('/profile', (req, res) => {
  try {
    res.json({ success: true, data: buildProfilePayload(req.profileId) });
  } catch (err) {
    // badRequest() must stay a 400. 5432f8d moved the date check in here to a
    // throw without widening this catch, which silently downgraded a malformed
    // date from 400 to 500 — the caller could no longer tell its own bad input
    // from our failure.
    if (err?.status === 400) return res.status(400).json({ success: false, error: err.message });
    console.error(err); res.status(500).json({ success: false, error: 'internal server error' });
  }
});

/**
 * POST /api/plated/profile
 * Plated owns height, birth year and sex — it asks for them at sign-up, so
 * IronLog should not ask a second time. Every field optional; anything sent
 * is validated and stored, anything omitted is left alone. Idempotent.
 *
 * Answers with the SAME payload GET /profile returns, recomputed after the
 * write, so the caller can confirm the write landed without a second trip.
 *
 * Deliberately does NOT accept tdee_includes_workouts: that flag is derived
 * from activity_level at read time and stays IronLog's to compute, so there
 * is one source of truth for it even though Plated owns its input.
 */
router.post('/profile', (req, res) => {
  try {
    const pid = req.profileId;
    const body = req.body || {};
    const writes = [];

    const num = (v) => (v === null || v === '' || v === undefined ? null : Number(v));

    if ('height_cm' in body) {
      const v = num(body.height_cm);
      if (v !== null && (!Number.isFinite(v) || v < 100 || v > 250)) {
        return res.status(400).json({ success: false, error: 'height_cm must be between 100 and 250' });
      }
      writes.push(['profile_height_cm', v === null ? '' : String(v)]);
    }
    if ('birth_year' in body) {
      const v = num(body.birth_year);
      if (v !== null && (!Number.isInteger(v) || v < 1900 || v > new Date().getUTCFullYear())) {
        return res.status(400).json({ success: false, error: 'birth_year must be a year between 1900 and now' });
      }
      writes.push(['profile_birth_year', v === null ? '' : String(v)]);
    }
    if ('sex' in body) {
      const v = String(body.sex || '').toLowerCase();
      if (v && v !== 'male' && v !== 'female') {
        return res.status(400).json({ success: false, error: "sex must be 'male' or 'female'" });
      }
      // Stored under the key IronLog already reads for this; renaming it would
      // mean a migration for no gain.
      if (v) writes.push(['strength_standard_gender', v]);
    }
    if ('activity_level' in body) {
      const v = String(body.activity_level || '').toLowerCase();
      if (!ACTIVITY_MULTIPLIERS[v]) {
        return res.status(400).json({
          success: false,
          error: `activity_level must be one of: ${Object.keys(ACTIVITY_MULTIPLIERS).join(', ')}`
        });
      }
      writes.push(['profile_activity', v]);
    }

    if (!writes.length) {
      return res.status(400).json({ success: false, error: 'nothing to update' });
    }
    for (const [k, v] of writes) setSetting(pid, k, v);

    res.json({ success: true, data: buildProfilePayload(pid) });
  } catch (err) {
    // badRequest() must stay a 400. 5432f8d moved the date check in here to a
    // throw without widening this catch, which silently downgraded a malformed
    // date from 400 to 500 — the caller could no longer tell its own bad input
    // from our failure.
    if (err?.status === 400) return res.status(400).json({ success: false, error: err.message });
    console.error(err); res.status(500).json({ success: false, error: 'internal server error' });
  }
});

/**
 * GET /api/plated/bodyweight?limit=30
 * Returns recent bodyweight entries normalised to kg.
 */
function buildBodyweightPayload(req) {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 30));
    const tz = getTzOffsetMinutes(req);
    const mod = localDateModifier(tz);
    const rows = db
      .prepare(
        `SELECT logged_at, weight, weight_unit, date(logged_at, ?) AS local_day
           FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC LIMIT ?`
      )
      .all(mod, req.profileId, limit);

    // `date` used to be an ISO timestamp here, which breaks the rule the rest
    // of this API follows and forced the caller to sniff a string to find out
    // which kind it had received. `date` is now always the user's local
    // calendar day; the instant keeps its own name and its Z.
    return rows.map((r) => ({
      date:          r.local_day,
      logged_at:     r.logged_at.replace(' ', 'T') + 'Z',
      bodyweight_kg: +toKg(r.weight, r.weight_unit).toFixed(2)
    }));
}

router.get('/bodyweight', (req, res) => plated(req, res, buildBodyweightPayload));

/**
 * POST /api/plated/bodyweight
 * Lets Plated push a bodyweight entry into IronLog (two-way sync).
 * Body: { bodyweight_kg, date? } — date defaults to today (YYYY-MM-DD).
 * `weight_kg` / `weight` are still accepted as input aliases so Plated's
 * current writer keeps working; the RESPONSE only ever says bodyweight_kg.
 * Manual weigh-ins are never touched: we only collapse a *previous Plated push*
 * for the same day (so re-syncing the same day stays idempotent instead of
 * piling up). Any hand-entered logs for that day are kept alongside.
 */
router.post('/bodyweight', (req, res) => {
  try {
    const { bodyweight_kg, weight_kg, weight, weight_unit, date } = req.body || {};
    const incoming = bodyweight_kg != null ? bodyweight_kg : weight_kg;
    let kg = incoming != null ? Number(incoming)
      : weight != null ? toKg(Number(weight), weight_unit) : null;
    if (kg == null || !Number.isFinite(kg) || kg <= 0 || kg > 700) {
      throw badRequest('bodyweight_kg must be a positive number');
    }
    kg = +kg.toFixed(2);

    if (date && !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw badRequest('date must be YYYY-MM-DD');
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

    res.json({ success: true, data: { date: day, bodyweight_kg: kg, updated: !!existing } });
  } catch (err) {
    // badRequest() must stay a 400. 5432f8d moved the date check in here to a
    // throw without widening this catch, which silently downgraded a malformed
    // date from 400 to 500 — the caller could no longer tell its own bad input
    // from our failure.
    if (err?.status === 400) return res.status(400).json({ success: false, error: err.message });
    console.error(err); res.status(500).json({ success: false, error: 'internal server error' });
  }
});

/**
 * GET /api/plated/workouts/calories?date=YYYY-MM-DD&tz=<minutes>
 * Calories burned from strength sessions on a given LOCAL date (defaults to
 * today in the caller's timezone). `tz` is Date.getTimezoneOffset() minutes;
 * missing/invalid tz defaults to UTC.
 */
function buildCaloriesPayload(req) {
    const tz = getTzOffsetMinutes(req);
    const mod = localDateModifier(tz);
    const date = req.query.date || localDateStr(Date.now(), tz);
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
      throw badRequest('date must be YYYY-MM-DD');
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
        calories_burned:  burned,
        // Whether that number was MEASURED or guessed at 4 kcal/min. Plated
        // feeds this into an eat-back target, where at sedentary/light the
        // burn goes straight onto the plate — a 35-minute session guessed at
        // 140 kcal against a real ~440 is a 300 kcal push toward under-eating.
        // Without this flag a guess is indistinguishable from a measurement.
        calories_estimated: w.calories_burned == null,
        calories_source:  w.calories_burned != null ? 'measured' : 'estimated_duration'
      };
    });

    const totalBurned = sessions.reduce((acc, s) => acc + (s.calories_burned || 0), 0);

    return {
      date,
      calories_burned: totalBurned,
      sessions,
      note: 'calories_burned estimated at 4 kcal/min for sessions without explicit calorie data. Set workouts.calories_burned directly to override.'
    };
}

router.get('/workouts/calories', (req, res) => plated(req, res, buildCaloriesPayload));

/**
 * GET /api/plated/workouts/recent?limit=7&tz=<minutes>
 * Recent distinct workout days (in the caller's LOCAL timezone) with session
 * counts and estimated calories burned. `tz` is Date.getTimezoneOffset()
 * minutes; missing/invalid tz defaults to UTC.
 */
function buildRecentPayload(req) {
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

    return rows.map((r) => ({
      date:            r.date,
      session_count:   r.session_count,
      calories_burned: r.calories_burned || 0
    }));
}

router.get('/workouts/recent', (req, res) => plated(req, res, buildRecentPayload));

/**
 * GET /api/plated/whoami
 * Confirms which profile owns the presented API key. Used to verify the
 * Plated <-> IronLog link. Never returns the key itself.
 */
/**
 * GET /api/plated/summary?date=YYYY-MM-DD&tz=<minutes>&limit=<n>
 *
 * Everything Plated's Today screen needs, in ONE call. It was making four
 * (profile, workouts/calories, workouts/recent, bodyweight) for a single
 * render; with the service now allowed to sleep on Railway, that is four
 * cold-start-prone round trips, four timeouts and four failure modes for one
 * view. This is one of each.
 *
 * Composed from the exact same builders the individual endpoints use, so the
 * two can never drift — the old endpoints stay for compatibility.
 */
router.get('/summary', (req, res) => plated(req, res, (r) => {
  const calories = buildCaloriesPayload(r);
  return {
    contract_version: CONTRACT_VERSION,
    profile:    buildProfilePayload(r.profileId),
    calories,
    recent:     buildRecentPayload(r),
    bodyweight: buildBodyweightPayload(r),
    // Echoed so the caller can confirm which local day this resolved to
    // rather than re-deriving it and hoping the two agree.
    resolved:   { date: calories.date, tz_offset_minutes: getTzOffsetMinutes(r) }
  };
}));

router.get('/whoami', (req, res) => {
  res.json({
    success: true,
    data: { profile_id: req.profile.id, name: req.profile.name }
  });
});

module.exports = router;
