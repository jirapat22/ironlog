const express = require('express');
const { db } = require('../db');

const router = express.Router();

const DEFAULTS = {
  nudge_enabled: '1',
  nudge_threshold_days: '3',
  nudge_quiet_start: '22', // 22:00 local
  nudge_quiet_end: '8', // 08:00 local
  nudge_tz_offset_minutes: '0', // minutes *west* of UTC per Date.getTimezoneOffset()
  strength_standard_gender: 'male', // 'male' | 'female'
  weekly_summary_enabled: '1',
  weekly_summary_day: '0', // 0=Sun, 1=Mon, ... 6=Sat
  weekly_summary_hour: '19' // 24h, in user's local TZ
};

function getAll() {
  const rows = db.prepare('SELECT key, value FROM app_settings').all();
  const out = { ...DEFAULTS };
  for (const r of rows) out[r.key] = r.value;
  return out;
}

router.get('/', (req, res) => {
  res.json(getAll());
});

router.put('/', (req, res) => {
  const body = req.body || {};
  const allowed = Object.keys(DEFAULTS).concat(['nudge_last_sent_at', 'weekly_summary_last_sent']);
  const stmt = db.prepare(
    'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  );
  for (const [k, v] of Object.entries(body)) {
    if (!allowed.includes(k)) continue;
    stmt.run(k, String(v));
  }
  res.json(getAll());
});

router.getSettings = getAll;
module.exports = router;
