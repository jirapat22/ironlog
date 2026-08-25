const express = require('express');
const { db, tx } = require('../db');

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

// Numeric settings that feed the calorie math. A bad value here doesn't fail
// loudly, it just produces a nonsense goal (and ships it to Plated) — an
// unvalidated profile_age of 500 drove BMR negative and put a negative
// calorie_goal and negative fat grams on the Plated contract. The client
// enforces these same ranges, but the client isn't the boundary.
// allowEmpty marks the ones whose DEFAULT is '' (meaning "not set yet").
const NUMERIC_SETTINGS = {
  profile_cut_deficit:  { min: 0,   max: 2000 },
  profile_bulk_surplus: { min: 0,   max: 2000 },
  profile_age:          { min: 13,  max: 100, allowEmpty: true },
  profile_height_cm:    { min: 100, max: 250, allowEmpty: true }
};

// Strict: Number() alone accepted true->1, []->0, '0x10'->16 and null->0, so
// clearing a field read as a deliberate 0 rather than "unset". Only a real
// number or a plain decimal string gets through.
function parseNumericSetting(raw, { min, max, allowEmpty }) {
  if (raw === null || raw === undefined || (typeof raw === 'string' && raw.trim() === '')) {
    return allowEmpty ? { ok: true, value: '' } : { ok: false };
  }
  if (typeof raw !== 'number' && typeof raw !== 'string') return { ok: false };
  const s = String(raw).trim();
  if (!/^[0-9]+([.][0-9]+)?$/.test(s)) return { ok: false };
  const n = Number(s);
  if (!Number.isFinite(n) || n < min || n > max) return { ok: false };
  return { ok: true, value: String(Math.round(n)) };
}

// Validate a whole bag of settings before any of it is written. Split from the
// write so the backup importer can reject a bad file UP FRONT, outside its own
// transaction, instead of discovering it halfway through. Unknown keys are
// ignored, not an error — a backup from a newer build may carry keys this one
// doesn't know.
function parseSettingsBag(body) {
  const allowed = Object.keys(DEFAULTS);
  const writes = [];
  for (const [k, v] of Object.entries(body || {})) {
    if (!allowed.includes(k)) continue;
    const spec = NUMERIC_SETTINGS[k];
    if (spec) {
      const parsed = parseNumericSetting(v, spec);
      if (!parsed.ok) {
        return { ok: false, error: `${k} must be a number between ${spec.min} and ${spec.max}` };
      }
      writes.push([k, parsed.value]);
      continue;
    }
    writes.push([k, String(v)]);
  }
  return { ok: true, writes };
}

// Caller owns the transaction: db.js's tx() is not reentrant, and the importer
// already runs inside one.
function writeSettings(profileId, writes) {
  const stmt = db.prepare(
    'INSERT INTO app_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, value] of writes) stmt.run(profileId, k, value);
}

router.put('/', (req, res) => {
  // Validate EVERYTHING before writing ANYTHING. This used to 400 from inside
  // the write loop, so a rejected deficit still committed the goal and age
  // that came before it — and silently dropped the keys after it. The profile
  // sheet sends all five in one PUT, which made a half-applied profile the
  // normal outcome of one bad field.
  const parsed = parseSettingsBag(req.body || {});
  if (!parsed.ok) return res.status(400).json({ error: parsed.error });
  tx(() => writeSettings(req.profileId, parsed.writes));
  res.json(getAll(req.profileId));
});

module.exports = router;
// Shared with routes/import.js so a restored backup goes through exactly the
// same range checks a live PUT does — a backup file is untrusted input too.
module.exports.parseSettingsBag = parseSettingsBag;
module.exports.writeSettings = writeSettings;
