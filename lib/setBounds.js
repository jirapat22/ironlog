/**
 * The rules for what a set's numbers are allowed to be — in one leaf module,
 * with no database dependency, so every writer shares them.
 *
 * Why this exists as its own file: these bounds used to be module-local
 * constants inside routes/sets.js, enforced on POST and PATCH. The backup
 * restore in routes/import.js could not reach them — not "forgot to call
 * them", but structurally could not, since they were never exported. So every
 * bound the live route enforced was bypassable by hand-editing a backup file
 * and restoring it:
 *
 *   - a 1e9 kg set, which takes the exercise's PR forever and makes its volume
 *     chart unreadable;
 *   - a set_number of 1e9, which the workout view turns into a markup string
 *     of ~1e6 rows and the session becomes unopenable, with no route back to
 *     it from the UI;
 *   - text in a numeric column. SQLite is loosely typed and node:sqlite binds
 *     a JS string as TEXT, so a REAL NOT NULL column accepts '70abc' and
 *     stores it as text. Verified, not assumed:
 *       bind ["70abc","12xyz"] -> { w: '70abc', r: '12xyz', tw: 'text', tr: 'text' }
 *
 * Plated hit the same class of bug and landed on the same shape (their
 * src/utils/validate.js): three doors, one rulebook, three failure modes —
 * the form rejects with a message, the restore skips and counts, the sync
 * drops the field and reports it. The rules live here; how a caller REACTS to
 * a rejection stays the caller's business.
 */

'use strict';

// Far past any real lift: 2000 kg is roughly double the heaviest loaded
// machine. These are sanity ceilings for catching typos and hostile files,
// not an opinion about how strong anyone is.
const MAX_WEIGHT = { kg: 2000, lbs: 4400 };
const MAX_REPS = 1000;
const MAX_SET_NUMBER = 100;
const UNITS = ['kg', 'lbs'];

function isValidUnit(unit) {
  return UNITS.includes(unit);
}

/**
 * Coerce and bound-check one set's numbers.
 *
 * Returns { ok: true, values: { weight, reps, set_number, rpe, rir } } with
 * every value a real number (or null for the optional ones), or
 * { ok: false, error: '<message>' }. The messages are the ones the live route
 * already returned, so moving the checks in here changed no API response.
 *
 * `reps` is taken as given — resolving a per-side breakdown down to the weaker
 * side is the caller's job, because only the caller knows whether it has one.
 */
function validateSetNumerics({ weight, weight_unit = 'kg', reps, set_number, rpe = null, rir = null }) {
  if (!isValidUnit(weight_unit)) {
    return { ok: false, error: 'weight_unit must be kg or lbs' };
  }

  const nWeight = Number(weight);
  const nReps = Number(reps);
  const nSetNumber = Number(set_number);
  const nRpe = rpe == null ? null : Number(rpe);
  const nRir = rir == null ? null : Number(rir);

  // Number('') is 0 and Number(null) is 0, so a missing value would pass the
  // finite check and land as a real 0. Reject the empty cases up front.
  if (weight === '' || weight == null || reps === '' || reps == null || set_number === '' || set_number == null) {
    return { ok: false, error: 'weight, reps, and set_number must be numbers' };
  }
  if (![nWeight, nReps, nSetNumber].every(Number.isFinite)) {
    return { ok: false, error: 'weight, reps, and set_number must be numbers' };
  }

  // Negative/zero is meaningless here. The client blocks it, but the server is
  // the actual boundary — PR and volume maths have no floor of their own and
  // would sum a negative "set" into history forever. Weight may be 0 (added
  // nothing on a pull-up, zero assistance on a machine), reps may not.
  if (nWeight < 0) return { ok: false, error: 'weight cannot be negative' };
  if (!Number.isInteger(nReps) || nReps <= 0) {
    return { ok: false, error: 'reps must be a positive whole number' };
  }
  if (!Number.isInteger(nSetNumber) || nSetNumber <= 0) {
    return { ok: false, error: 'set_number must be a positive whole number' };
  }

  if (nWeight > MAX_WEIGHT[weight_unit]) {
    return { ok: false, error: `weight must be ${MAX_WEIGHT[weight_unit]} ${weight_unit} or less` };
  }
  if (nReps > MAX_REPS) return { ok: false, error: `reps must be ${MAX_REPS} or fewer` };
  if (nSetNumber > MAX_SET_NUMBER) {
    return { ok: false, error: `set_number must be ${MAX_SET_NUMBER} or less` };
  }

  if ((nRpe != null && (!Number.isFinite(nRpe) || nRpe < 0 || nRpe > 10)) ||
      (nRir != null && (!Number.isFinite(nRir) || nRir < 0 || nRir > 10))) {
    return { ok: false, error: 'rpe and rir must be numbers between 0 and 10 when provided' };
  }

  return {
    ok: true,
    values: {
      weight: nWeight,
      reps: nReps,
      set_number: nSetNumber,
      rpe: nRpe,
      rir: nRir
    }
  };
}

module.exports = { MAX_WEIGHT, MAX_REPS, MAX_SET_NUMBER, UNITS, isValidUnit, validateSetNumerics };
