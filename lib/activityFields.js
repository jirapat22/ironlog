/**
 * The rules for an activity session's fields, in one leaf module with no
 * database dependency, so every writer shares them.
 *
 * Same lesson as lib/setBounds.js, learned twice: these clamps lived inside
 * parseActivityBody in routes/workouts.js, which the backup restore cannot
 * reach. The moment the import started carrying activity columns it bypassed
 * all of them — a hand-edited backup could restore a session with a duration
 * of 1e9 minutes, an RPE of 400, or a 10 MB activity label, none of which the
 * live route would accept for a second.
 *
 * The two callers react differently on purpose, exactly as the set rules do:
 *
 *   - routes/workouts.js (POST/PATCH) REJECTS a bad duration with a 400. The
 *     user is right there and can fix the number.
 *   - routes/import.js CLAMPS instead, and counts how many it had to adjust.
 *     A set with nonsense numbers is skipped, because a bogus set poisons
 *     personal records and progression for that exercise forever. An activity
 *     is not like that: its identity is "I played squash on Tuesday", not its
 *     duration, and the calorie estimate is capped downstream regardless. So
 *     dropping the session loses more than keeping it with a sane number.
 */

'use strict';

const MAX_TEXT = 40;
const MIN_MINUTES = 1;
const MAX_MINUTES = 600;
const MIN_RPE = 6;
const MAX_RPE = 10;
const DISTANCE_UNITS = ['km', 'mi', 'm'];

// Trim, bound, and treat "nothing left" as absent rather than as an empty
// string — so a blank box and a never-filled box mean the same thing, and
// clearing a field on an edit genuinely clears it.
function boundedText(v, max = MAX_TEXT) {
  if (v == null) return null;
  const s = String(v).trim().slice(0, max);
  return s || null;
}

/**
 * Normalise one activity's fields.
 *
 * `allowedMuscleGroups` is passed in rather than imported, so this module
 * stays free of the database — requiring db.js here would open the SQLite
 * file as a side effect of loading a validator.
 *
 * Returns every value already safe to store, plus two flags the caller uses
 * to decide how loudly to complain:
 *   durationValid — false when the duration was missing or out of range
 *   adjusted      — true when ANY value had to be changed to be storable
 */
function cleanActivityFields(b = {}, allowedMuscleGroups = []) {
  const rawMinutes = Number(b.duration_min);
  const durationValid = Number.isFinite(rawMinutes) && rawMinutes >= MIN_MINUTES && rawMinutes <= MAX_MINUTES;
  const minutes = durationValid
    ? Math.round(rawMinutes)
    : Math.round(Math.min(MAX_MINUTES, Math.max(MIN_MINUTES, Number.isFinite(rawMinutes) ? rawMinutes : MIN_MINUTES)));

  const activityType = boundedText(b.activity_type) || 'other';
  const activityLabel = boundedText(b.activity_label);

  // rpe is optional: absent stays absent. A present-but-silly value is pulled
  // into range rather than dropped, which is what the live route already did.
  const rawRpe = b.rpe == null ? null : Number(b.rpe);
  const rpe = rawRpe == null ? null : Math.max(MIN_RPE, Math.min(MAX_RPE, Number.isFinite(rawRpe) ? rawRpe : 8));

  const rawDistance = Number(b.distance);
  const distance = Number.isFinite(rawDistance) && rawDistance > 0 ? rawDistance : null;
  const distanceUnit = distance != null && DISTANCE_UNITS.includes(b.distance_unit) ? b.distance_unit : null;

  // muscle_tags arrives as an array from the UI and as a JSON string from a
  // backup file. Both are filtered to known groups and de-duplicated, so a
  // restore cannot write a group that no chart knows how to colour.
  let rawTags = b.muscle_tags;
  if (typeof rawTags === 'string') {
    try { rawTags = JSON.parse(rawTags); } catch { rawTags = []; }
  }
  const tags = Array.isArray(rawTags)
    ? [...new Set(rawTags.filter((t) => allowedMuscleGroups.includes(t)))]
    : [];

  const notes = b.notes ? String(b.notes).slice(0, 500) : null;
  const countsAsWorkout = b.counts_as_workout ? 1 : 0;

  const adjusted = !durationValid
    || (b.activity_type != null && String(b.activity_type).trim().slice(0, MAX_TEXT) !== String(b.activity_type))
    || (b.activity_label != null && String(b.activity_label).trim().slice(0, MAX_TEXT) !== String(b.activity_label))
    || (rawRpe != null && rawRpe !== rpe);

  return {
    activityType, activityLabel, minutes, rpe, distance, distanceUnit,
    tags, notes, countsAsWorkout, durationValid, adjusted
  };
}

module.exports = {
  MAX_TEXT, MIN_MINUTES, MAX_MINUTES, MIN_RPE, MAX_RPE, DISTANCE_UNITS,
  boundedText, cleanActivityFields
};
