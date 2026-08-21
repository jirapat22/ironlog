const express = require('express');
const { db } = require('../db');

const router = express.Router();

const DEFAULTS = {
  // Not nudge-feature-specific despite the name (that feature's gone) — this
  // is the general "what's the user's timezone offset" setting, also read by
  // /api/calendar and the Plated bodyweight sync for local-date bucketing.
  nudge_tz_offset_minutes: '0', // minutes *west* of UTC per Date.getTimezoneOffset()
  strength_standard_gender: 'male', // 'male' | 'female'
  // Profile data for TDEE / calorie calc (Mifflin–St Jeor)
  profile_height_cm: '',
  profile_age: '',
  profile_activity: 'moderate', // sedentary | light | moderate | very | athlete
  profile_goal: 'maintain', // cut | maintain | bulk
  profile_cut_deficit: '500', // kcal/day below TDEE while cutting
  profile_bulk_surplus: '300', // kcal/day above TDEE while bulking
  preferred_unit: 'kg', // 'kg' | 'lbs'
  show_weight_equiv: '1' // show the small kg<->lb equivalent on set rows
};

function getAll(profileId) {
  const rows = db.prepare('SELECT key, value FROM app_settings WHERE profile_id = ?').all(profileId);
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

router.get('/', (req, res) => {
  res.json(getAll(req.profileId));
});

// Settings that feed the calorie math directly: a bad value here doesn't fail
// loudly, it just produces a nonsense goal (and ships it to Plated). The
// client enforces the same 0-2000 range, but the client isn't the boundary.
const KCAL_OFFSET_KEYS = new Set(['profile_cut_deficit', 'profile_bulk_surplus']);

router.put('/', (req, res) => {
  const body = req.body || {};
  const allowed = Object.keys(DEFAULTS);
  const stmt = db.prepare(
    'INSERT INTO app_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.includes(k)) continue;
    if (KCAL_OFFSET_KEYS.has(k)) {
      const n = Number(v);
      if (!Number.isFinite(n) || n < 0 || n > 2000) {
        return res.status(400).json({ error: `${k} must be a number between 0 and 2000` });
      }
      stmt.run(req.profileId, k, String(Math.round(n)));
      continue;
    }
    stmt.run(req.profileId, k, String(v));
  }
  res.json(getAll(req.profileId));
});

module.exports = router;
