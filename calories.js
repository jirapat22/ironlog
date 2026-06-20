'use strict';

/**
 * Per-exercise, active-time calorie model for resistance training.
 *
 * The old model multiplied a flat MET by the WHOLE session duration (including
 * long idle rests), which over-counted badly — a 2.5 h session read ~1000 kcal.
 *
 * Instead we cost each LOGGED set over an "effective minute" window — the set
 * itself plus the elevated metabolism through the rest that follows — weighted
 * by that exercise's MET:
 *
 *   kcal = Σ  met(exercise) × bodyweight_kg × effectiveHours(set)
 *
 * effectiveMinutes scales gently with reps (a longer set keeps you working
 * longer), is independent of wall-clock session length (so a forgotten timer
 * can't inflate it), and warm-ups count at ~60%. The total is capped so a freak
 * data point can't blow up.
 *
 * Calibration: ~20 hard compound sets (MET 6, 80 kg) ≈ 320 kcal; a lighter
 * 15-set isolation day lands ~180 kcal — both realistic for the session length.
 */

// Effective minutes one set contributes (work + share of the rest after it).
function effectiveMinutesForSet(reps, isWarmup) {
  const r = Math.max(1, Math.min(40, Number(reps) || 8));
  const mins = 1.5 + r * 0.06; // 5 reps → 1.8, 8 → ~2.0, 15 → 2.4
  return isWarmup ? mins * 0.6 : mins;
}

/**
 * @param {{reps:number, is_warmup:number, met:number}[]} sets
 * @param {number|null} bwKg  bodyweight snapshot in kg
 * @returns {number|null}     estimated calories, or null if bodyweight unknown
 */
function caloriesFromSets(sets, bwKg) {
  if (!bwKg || !Number.isFinite(Number(bwKg))) return null;
  if (!sets || !sets.length) return 0;
  let kcal = 0;
  for (const s of sets) {
    const met = Number(s.met) || 5;
    const hours = effectiveMinutesForSet(s.reps, s.is_warmup) / 60;
    kcal += met * Number(bwKg) * hours;
  }
  // Sanity cap — even a marathon session shouldn't exceed this from lifting.
  return Math.round(Math.min(kcal, 1500));
}

module.exports = { caloriesFromSets };
