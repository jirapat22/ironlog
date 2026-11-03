'use strict';

// Polar watch data (AccessLink API v3) → extra detail on Ironlog workouts, plus
// nightly sleep / recovery / cardio load for I.O.'s coach (routes/io.js).
//
// Pat wears a Polar watch. Once a profile taps "Connect Polar" in Settings, the
// server pulls that profile's Polar sessions every hour and keeps them in
// polar_sessions. A History card then shows the session that overlaps the
// workout: heart rate, time in each zone, training load. Calories from the
// watch are deliberately NOT shown: Pat finds them unreliable and Ironlog has
// its own estimate.
//
// Why keep a local copy instead of asking Polar when a card opens: Polar only
// serves the last 30 days, and only sessions uploaded after the profile
// connected. Anything older exists here or nowhere.
//
// The app's keys (POLAR_CLIENT_ID / POLAR_CLIENT_SECRET) live in the env file.
// Each profile's own access token lives in polar_links: it never leaves the
// server, isn't in the export, and is deleted with the profile.

const { db } = require('../db');

const AUTH_URL = 'https://flow.polar.com/oauth2/authorization';
const TOKEN_URL = 'https://polarremote.com/v2/oauth2/token';
const API = 'https://www.polaraccesslink.com/v3';
const REDIRECT_URI = process.env.POLAR_REDIRECT_URI || 'https://ironlog.jirapat.dev/polar/callback';
// A Polar session counts as "this workout" when it overlaps the workout's time,
// give or take this much (the watch often starts a few minutes before the first set is logged).
const MATCH_SLACK_MS = 15 * 60 * 1000;
// An open workout that was never finished would otherwise "last" for days and grab every session.
const MAX_WORKOUT_MS = 4 * 60 * 60 * 1000;

function configured() {
  return !!(process.env.POLAR_CLIENT_ID && process.env.POLAR_CLIENT_SECRET);
}

function authUrl(state) {
  const q = new URLSearchParams({
    response_type: 'code', client_id: process.env.POLAR_CLIENT_ID, redirect_uri: REDIRECT_URI,
    scope: 'accesslink.read_all', state
  });
  return `${AUTH_URL}?${q}`;
}

// ---------------------------------------------------------------------------
// Pure helpers (tested in polar.test.js)
// ---------------------------------------------------------------------------

// "PT1H2M3.5S" → 3724 seconds. Polar writes every duration this way (ISO 8601).
function parseDuration(iso) {
  const m = /^PT(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(String(iso || ''));
  if (!m) return null;
  return Math.round((Number(m[1] || 0) * 3600) + (Number(m[2] || 0) * 60) + Number(m[3] || 0));
}

// Same "YYYY-MM-DD HH:MM:SS" UTC text the workouts table uses, so the two compare as plain strings.
function sqliteUtc(ms) {
  return new Date(ms).toISOString().slice(0, 19).replace('T', ' ');
}

// SQLite's bare "YYYY-MM-DD HH:MM:SS" is UTC; real ISO strings keep their own zone.
function toMs(s) {
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(s) ? s : String(s).replace(' ', 'T') + 'Z').getTime();
}

// "STRENGTH_TRAINING" → "Strength training"
function sportLabel(s) {
  const t = String(s || '').toLowerCase().replace(/_/g, ' ').trim();
  return t ? t[0].toUpperCase() + t.slice(1) : 'Session';
}

// One Polar exercise (API JSON) → one polar_sessions row. Polar gives a LOCAL
// start time plus the UTC offset in minutes, so the offset is taken off to get UTC.
function toSession(ex) {
  const localMs = toMs(String(ex.start_time || '').slice(0, 19) + 'Z');
  if (!ex.id || Number.isNaN(localMs)) return null;
  const startMs = localMs - (Number(ex.start_time_utc_offset) || 0) * 60000;
  const zones = (ex.heart_rate_zones || [])
    .slice()
    .sort((a, b) => a.index - b.index)
    .map((z) => parseDuration(z['in-zone']) || 0);
  const num = (v) => (Number.isFinite(Number(v)) && v !== null && v !== '' ? Number(v) : null);
  return {
    polar_id: String(ex.id),
    started_at: sqliteUtc(startMs),
    duration_s: parseDuration(ex.duration),
    sport: sportLabel(ex.detailed_sport_info || ex.sport),
    avg_hr: num(ex.heart_rate?.average),
    max_hr: num(ex.heart_rate?.maximum),
    training_load: num(ex.training_load),
    distance_m: num(ex.distance),
    zones: zones.length ? JSON.stringify(zones) : null,
    device: ex.device ? String(ex.device).slice(0, 60) : null
  };
}

// ---- Daily data: sleep, Nightly Recharge, cardio load → polar_daily columns ----
// Each source fills its own columns of the same (profile, date) row. Durations
// are seconds, like everything else Polar sends.
const n = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Number(v));
const isDate = (d) => /^\d{4}-\d{2}-\d{2}$/.test(String(d || ''));

function fromSleep(x) {
  if (!isDate(x?.date)) return null;
  const parts = [x.light_sleep, x.deep_sleep, x.rem_sleep].map(n);
  return {
    date: x.date,
    sleep_s: parts.some((v) => v !== null) ? parts.reduce((a, b) => a + (b || 0), 0) : null,
    deep_s: n(x.deep_sleep), rem_s: n(x.rem_sleep),
    interruptions_s: n(x.total_interruption_duration), sleep_score: n(x.sleep_score)
  };
}

function fromRecharge(x) {
  if (!isDate(x?.date)) return null;
  return {
    date: x.date, recharge_status: n(x.nightly_recharge_status), ans_charge: n(x.ans_charge),
    rest_hr: n(x.heart_rate_avg), hrv_ms: n(x.heart_rate_variability_avg), breathing: n(x.breathing_rate_avg)
  };
}

function fromCardio(x) {
  if (!isDate(x?.date) || x.cardio_load_status === 'LOAD_STATUS_NOT_AVAILABLE') return null;
  return {
    date: x.date, cardio_load: n(x.cardio_load), strain: n(x.strain), tolerance: n(x.tolerance),
    load_ratio: n(x.cardio_load_ratio), load_status: x.cardio_load_status ? String(x.cardio_load_status).slice(0, 40) : null
  };
}

// The workout's time window: start to finish (or start + duration for an
// activity), capped, padded by MATCH_SLACK_MS each side.
function workoutWindow(w) {
  const start = toMs(w.started_at);
  let end = w.finished_at ? toMs(w.finished_at) : start + (w.duration_min || 60) * 60000;
  if (w.kind === 'activity' && w.duration_min) end = start + w.duration_min * 60000;
  end = Math.min(Math.max(end, start), start + MAX_WORKOUT_MS);
  return [start - MATCH_SLACK_MS, end + MATCH_SLACK_MS];
}

// The session that overlaps the workout the most, or null.
function matchFor(workout, sessions) {
  const [ws, we] = workoutWindow(workout);
  let best = null;
  let bestOverlap = 0;
  for (const s of sessions) {
    const ss = toMs(s.started_at);
    const se = ss + (s.duration_s || 0) * 1000;
    const overlap = Math.min(we, se) - Math.max(ws, ss);
    if (overlap > bestOverlap) { best = s; bestOverlap = overlap; }
  }
  return best;
}

// ---------------------------------------------------------------------------
// Database
// ---------------------------------------------------------------------------

function link(profileId) {
  return db.prepare('SELECT * FROM polar_links WHERE profile_id = ?').get(profileId) || null;
}

function saveSessions(profileId, rows) {
  // Upsert on (profile, Polar id): a session re-uploaded with fixes replaces the old copy.
  const up = db.prepare(
    `INSERT INTO polar_sessions (profile_id, polar_id, started_at, duration_s, sport, avg_hr, max_hr, training_load, distance_m, zones, device)
     VALUES (@profile_id, @polar_id, @started_at, @duration_s, @sport, @avg_hr, @max_hr, @training_load, @distance_m, @zones, @device)
     ON CONFLICT (profile_id, polar_id) DO UPDATE SET
       started_at = excluded.started_at, duration_s = excluded.duration_s, sport = excluded.sport,
       avg_hr = excluded.avg_hr, max_hr = excluded.max_hr, training_load = excluded.training_load,
       distance_m = excluded.distance_m, zones = excluded.zones, device = excluded.device`
  );
  let n = 0;
  for (const r of rows) {
    if (!r) continue;
    up.run({ profile_id: profileId, ...r });
    n++;
  }
  return n;
}

const DAILY_COLS = ['sleep_s', 'deep_s', 'rem_s', 'interruptions_s', 'sleep_score', 'recharge_status', 'ans_charge',
  'rest_hr', 'hrv_ms', 'breathing', 'cardio_load', 'strain', 'tolerance', 'load_ratio', 'load_status'];

// Merges partial day rows: a sleep row doesn't wipe that day's recharge numbers, and vice versa.
function saveDaily(profileId, rows) {
  let saved = 0;
  for (const r of rows) {
    if (!r || !isDate(r.date)) continue;
    const cols = DAILY_COLS.filter((c) => c in r);
    if (!cols.length) continue;
    db.prepare(
      `INSERT INTO polar_daily (profile_id, date, ${cols.join(', ')}) VALUES (?, ?, ${cols.map(() => '?').join(', ')})
       ON CONFLICT (profile_id, date) DO UPDATE SET ${cols.map((c) => `${c} = excluded.${c}`).join(', ')}`
    ).run(profileId, r.date, ...cols.map((c) => r[c]));
    saved++;
  }
  return saved;
}

// The Polar session for a workout row (what GET /api/workouts/:id attaches), or null.
function forWorkout(profileId, workout) {
  const start = toMs(workout.started_at);
  if (Number.isNaN(start)) return null;
  const near = db.prepare(
    `SELECT polar_id, started_at, duration_s, sport, avg_hr, max_hr, training_load, distance_m, zones
     FROM polar_sessions WHERE profile_id = ? AND started_at BETWEEN ? AND ?`
  ).all(profileId, sqliteUtc(start - 6 * 3600e3), sqliteUtc(start + 6 * 3600e3));
  const s = matchFor(workout, near);
  if (!s) return null;
  let zones = [];
  try { zones = JSON.parse(s.zones || '[]'); } catch { zones = []; }
  return { ...s, zones };
}

// ---------------------------------------------------------------------------
// Talking to Polar
// ---------------------------------------------------------------------------

async function polarFetch(url, opts = {}) {
  const res = await fetch(url, { ...opts, signal: AbortSignal.timeout(20_000) });
  if (!res.ok && res.status !== 409) {
    const err = new Error(`Polar said ${res.status}`);
    err.status = res.status;
    throw err;
  }
  return res;
}

// After Pat taps Allow on Polar's page: swap the one-time code for a token,
// register this profile as a user of our app (409 = already registered, fine),
// and remember the link.
async function connect(profileId, code) {
  const basic = Buffer.from(`${process.env.POLAR_CLIENT_ID}:${process.env.POLAR_CLIENT_SECRET}`).toString('base64');
  const tokenRes = await polarFetch(TOKEN_URL, {
    method: 'POST',
    headers: { Authorization: `Basic ${basic}`, 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI })
  });
  const token = await tokenRes.json();
  if (!token.access_token) throw new Error('Polar gave no access token');
  await polarFetch(`${API}/users`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token.access_token}`, 'Content-Type': 'application/json', Accept: 'application/json' },
    body: JSON.stringify({ 'member-id': `ironlog-${profileId}` })
  });
  db.prepare(
    `INSERT INTO polar_links (profile_id, polar_user_id, access_token, connected_at, last_error)
     VALUES (?, ?, ?, datetime('now'), NULL)
     ON CONFLICT (profile_id) DO UPDATE SET polar_user_id = excluded.polar_user_id,
       access_token = excluded.access_token, connected_at = excluded.connected_at, last_error = NULL`
  ).run(profileId, String(token.x_user_id ?? ''), token.access_token);
}

// Pulls the last 30 days of sessions for one profile. Returns how many were saved.
async function sync(profileId) {
  const l = link(profileId);
  if (!l) return 0;
  try {
    const res = await polarFetch(`${API}/exercises?zones=true`, {
      headers: { Authorization: `Bearer ${l.access_token}`, Accept: 'application/json' }
    });
    const list = res.status === 204 ? [] : await res.json();
    const saved = saveSessions(profileId, (Array.isArray(list) ? list : []).map(toSession));
    // Sleep, Nightly Recharge and cardio load. Not every watch records all three,
    // so one missing is skipped quietly instead of failing the whole sync.
    for (const [path, parse, key] of [['/users/sleep', fromSleep, 'nights'], ['/users/nightly-recharge', fromRecharge, 'recharges'],
                                      ['/users/cardio-load/period/days/28', fromCardio, null]]) {
      try {
        const r = await polarFetch(API + path, { headers: { Authorization: `Bearer ${l.access_token}`, Accept: 'application/json' } });
        const body = r.status === 204 ? [] : await r.json();
        const rows = Array.isArray(body) ? body : (body?.[key] || []);
        saveDaily(profileId, rows.map(parse));
      } catch (err) {
        if (err.status === 401) throw err;
        console.warn(`Polar ${path} skipped: ${err.message}`);
      }
    }
    db.prepare("UPDATE polar_links SET last_sync_at = datetime('now'), last_error = NULL WHERE profile_id = ?").run(profileId);
    return saved;
  } catch (err) {
    // 401/403: the access was removed on Polar's side (or consents withdrawn). Say so in Settings.
    const msg = err.status === 401 || err.status === 403 ? 'Polar access was removed. Connect again.' : err.message;
    db.prepare('UPDATE polar_links SET last_error = ? WHERE profile_id = ?').run(String(msg).slice(0, 200), profileId);
    throw err;
  }
}

// The hourly job: every connected profile. One failing never stops the others.
async function syncAll() {
  if (!configured()) return;
  for (const { profile_id } of db.prepare('SELECT profile_id FROM polar_links').all()) {
    try { await sync(profile_id); } catch (err) { console.warn(`Polar sync failed for profile ${profile_id}: ${err.message}`); }
  }
}

// "Disconnect": tell Polar to forget us (that also revokes the token), then drop the link.
// The sessions already pulled stay: they're the profile's workout history now.
async function disconnect(profileId) {
  const l = link(profileId);
  if (!l) return;
  if (l.polar_user_id) {
    try {
      await polarFetch(`${API}/users/${encodeURIComponent(l.polar_user_id)}`, {
        method: 'DELETE', headers: { Authorization: `Bearer ${l.access_token}` }
      });
    } catch (err) { console.warn(`Polar deregister failed: ${err.message}`); }
  }
  db.prepare('DELETE FROM polar_links WHERE profile_id = ?').run(profileId);
}

module.exports = {
  configured, authUrl, connect, sync, syncAll, disconnect, link, forWorkout, saveSessions, saveDaily, DAILY_COLS,
  parseDuration, toSession, fromSleep, fromRecharge, fromCardio, matchFor, sportLabel, REDIRECT_URI
};
