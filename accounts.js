'use strict';

const crypto = require('crypto');
const { db, tx, seedDefaultPrograms } = require('./db');

// The Plated API key that the live single-user deployment is currently using.
// The FIRST profile created on a database that still holds legacy single-user
// data inherits this key so the existing Plated connection keeps working with
// no re-pasting. Trimmed so a stray newline in env/config can never break the
// match. See MIGRATION in the upgrade brief.
const LEGACY_API_KEY =
  '3031b3f765cd83bcad3f950ffa81192ccc7388f5d06c23fa305fbabe2fd6ca57'.trim();

// Sentinel profile_id for rows that predate the multi-user upgrade. The first
// profile created adopts every row still carrying this id.
const ORPHAN_PROFILE_ID = 0;

// Tables that hold per-profile data. Used for orphan adoption (migration) and
// for cascading deletes when a profile is removed. `programs` owns its
// program_days / program_day_exercises via ON DELETE CASCADE, so only the
// parent needs a profile_id.
const PER_PROFILE_TABLES = [
  'workouts',
  'sets',
  'bodyweights',
  'personal_records',
  'push_subscriptions',
  'notes',
  'app_settings',
  'programs'
];

const SESSION_MAX_AGE_DAYS = 30;

// ---------------------------------------------------------------------------
// Passcode hashing — scrypt + per-profile random salt. The raw 4-digit code is
// never stored. Verification is constant-time.
// ---------------------------------------------------------------------------
function hashPasscode(passcode, salt = crypto.randomBytes(16)) {
  const hash = crypto.scryptSync(String(passcode), salt, 64);
  return { hash: hash.toString('hex'), salt: salt.toString('hex') };
}

function verifyPasscode(passcode, hashHex, saltHex) {
  let expected, actual;
  try {
    const salt = Buffer.from(saltHex, 'hex');
    expected = Buffer.from(hashHex, 'hex');
    actual = crypto.scryptSync(String(passcode), salt, expected.length);
  } catch {
    return false;
  }
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

function randomHex(bytes = 32) {
  return crypto.randomBytes(bytes).toString('hex');
}

function generateUniqueApiKey() {
  // Loop on the (astronomically unlikely) chance of a collision with the
  // unique api_key index.
  for (let i = 0; i < 5; i++) {
    const key = randomHex(32);
    const clash = db.prepare('SELECT 1 FROM profiles WHERE api_key = ?').get(key);
    if (!clash) return key;
  }
  throw new Error('could not generate a unique API key');
}

// ---------------------------------------------------------------------------
// Profile lookup
// ---------------------------------------------------------------------------
function isValidPasscode(code) {
  return /^\d{4}$/.test(String(code || ''));
}

/** Resolve a 4-digit passcode to its owning profile, or null. */
function findProfileByPasscode(passcode) {
  if (!isValidPasscode(passcode)) return null;
  const profiles = db.prepare('SELECT * FROM profiles').all();
  for (const p of profiles) {
    if (verifyPasscode(passcode, p.pass_hash, p.pass_salt)) return p;
  }
  return null;
}

/** Look up a profile by its API key (trimmed). Returns the row or null. */
function findProfileByApiKey(rawKey) {
  const key = String(rawKey || '').trim();
  if (!key) return null;
  return db.prepare('SELECT * FROM profiles WHERE api_key = ?').get(key) || null;
}

function getProfile(id) {
  return db.prepare('SELECT * FROM profiles WHERE id = ?').get(id) || null;
}

function countProfiles() {
  return db.prepare('SELECT COUNT(*) AS n FROM profiles').get().n;
}

// Public-safe view of a profile — never leaks the passcode hash/salt or api_key.
// The api_key is a machine-to-machine secret; retrieve it only via GET /api/auth/me/api-key.
function publicProfile(p) {
  if (!p) return null;
  return {
    id: p.id,
    name: p.name,
    accent_color: p.accent_color,
    created_at: p.created_at
  };
}

// ---------------------------------------------------------------------------
// Orphan (legacy single-user) data
// ---------------------------------------------------------------------------
function hasOrphanData() {
  // Any per-profile row still carrying the sentinel id means this DB was
  // created before the upgrade and holds real single-user history to adopt.
  for (const t of ['workouts', 'sets', 'bodyweights', 'app_settings']) {
    const row = db
      .prepare(`SELECT 1 FROM ${t} WHERE profile_id = ? LIMIT 1`)
      .get(ORPHAN_PROFILE_ID);
    if (row) return true;
  }
  return false;
}

function adoptOrphanData(profileId) {
  for (const t of PER_PROFILE_TABLES) {
    db.prepare(`UPDATE ${t} SET profile_id = ? WHERE profile_id = ?`).run(
      profileId,
      ORPHAN_PROFILE_ID
    );
  }
}

// ---------------------------------------------------------------------------
// Profile lifecycle
// ---------------------------------------------------------------------------
/**
 * Create a profile. The first profile on a database that still holds legacy
 * single-user data adopts that data and inherits the live Plated API key so the
 * existing integration keeps working untouched.
 *
 * @returns {{ profile: object } | { error: string, status: number }}
 */
function createProfile({ name, passcode, accent_color }) {
  const trimmedName = String(name || '').trim();
  if (!trimmedName) return { error: 'name is required', status: 400 };
  if (!isValidPasscode(passcode)) {
    return { error: 'passcode must be 4 digits', status: 400 };
  }
  if (findProfileByPasscode(passcode)) {
    // Keep passcodes unambiguous so login can resolve a code to one profile.
    return { error: 'that passcode is already in use', status: 409 };
  }

  const accent = /^#[0-9a-fA-F]{6}$/.test(accent_color || '') ? accent_color : '#e8643c';

  return tx(() => {
    const first = countProfiles() === 0;
    const adopt = first && hasOrphanData();
    const apiKey = adopt ? LEGACY_API_KEY : generateUniqueApiKey();

    const { hash, salt } = hashPasscode(passcode);
    const info = db
      .prepare(
        `INSERT INTO profiles (name, accent_color, pass_hash, pass_salt, api_key)
         VALUES (?, ?, ?, ?, ?)`
      )
      .run(trimmedName, accent, hash, salt, apiKey);
    const id = Number(info.lastInsertRowid);

    if (first) adoptOrphanData(id);
    // Give the profile its own copy of the default recommended templates —
    // unless it just adopted legacy single-user programs (then it already has
    // them). Keyed on "does this profile own any program yet" so adoption and
    // seeding can never double up.
    const hasPrograms = db.prepare('SELECT 1 FROM programs WHERE profile_id = ? LIMIT 1').get(id);
    if (!hasPrograms) seedDefaultPrograms(id);

    return { profile: getProfile(id) };
  });
}

function updateProfile(profileId, { name, accent_color }) {
  const updates = [];
  const values = [];
  if (name != null) {
    const t = String(name).trim();
    if (!t) return { error: 'name cannot be empty', status: 400 };
    updates.push('name = ?');
    values.push(t);
  }
  if (accent_color != null) {
    if (!/^#[0-9a-fA-F]{6}$/.test(accent_color)) {
      return { error: 'accent_color must be a hex colour', status: 400 };
    }
    updates.push('accent_color = ?');
    values.push(accent_color);
  }
  if (!updates.length) return { error: 'no fields to update', status: 400 };
  values.push(profileId);
  db.prepare(`UPDATE profiles SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  return { profile: getProfile(profileId) };
}

function setPasscode(profileId, passcode) {
  if (!isValidPasscode(passcode)) return { error: 'passcode must be 4 digits', status: 400 };
  const other = findProfileByPasscode(passcode);
  if (other && other.id !== profileId) {
    return { error: 'that passcode is already in use', status: 409 };
  }
  const { hash, salt } = hashPasscode(passcode);
  db.prepare('UPDATE profiles SET pass_hash = ?, pass_salt = ? WHERE id = ?').run(
    hash,
    salt,
    profileId
  );
  return { ok: true };
}

function regenerateApiKey(profileId) {
  const key = generateUniqueApiKey();
  db.prepare('UPDATE profiles SET api_key = ? WHERE id = ?').run(key, profileId);
  return key;
}

function deleteProfile(profileId) {
  tx(() => {
    // Delete child rows before parents to respect FK constraints.
    db.prepare('DELETE FROM sets WHERE profile_id = ?').run(profileId);
    for (const t of PER_PROFILE_TABLES) {
      if (t === 'sets') continue;
      db.prepare(`DELETE FROM ${t} WHERE profile_id = ?`).run(profileId);
    }
    db.prepare('DELETE FROM sessions WHERE profile_id = ?').run(profileId);
    db.prepare('DELETE FROM profiles WHERE id = ?').run(profileId);
  });
}

// ---------------------------------------------------------------------------
// Sessions — random token -> profile, 30-day lifetime.
// ---------------------------------------------------------------------------
function createSession(profileId) {
  const token = randomHex(32);
  db.prepare('INSERT INTO sessions (token, profile_id) VALUES (?, ?)').run(token, profileId);
  return token;
}

function getProfileBySession(token) {
  if (!token) return null;
  const row = db
    .prepare(
      `SELECT p.*
         FROM sessions s
         JOIN profiles p ON p.id = s.profile_id
        WHERE s.token = ?
          AND s.created_at > datetime('now', ?)`
    )
    .get(token, `-${SESSION_MAX_AGE_DAYS} days`);
  if (row) return row;
  // Expired or unknown — clean it up so the table doesn't grow unbounded.
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
  return null;
}

function deleteSession(token) {
  if (token) db.prepare('DELETE FROM sessions WHERE token = ?').run(token);
}

module.exports = {
  LEGACY_API_KEY,
  ORPHAN_PROFILE_ID,
  PER_PROFILE_TABLES,
  SESSION_MAX_AGE_DAYS,
  isValidPasscode,
  hashPasscode,
  verifyPasscode,
  findProfileByPasscode,
  findProfileByApiKey,
  getProfile,
  countProfiles,
  publicProfile,
  hasOrphanData,
  createProfile,
  updateProfile,
  setPasscode,
  regenerateApiKey,
  deleteProfile,
  createSession,
  getProfileBySession,
  deleteSession
};
