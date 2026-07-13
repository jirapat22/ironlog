'use strict';

/**
 * Exercise-calorie module — MET-based, exercise-only.
 *
 * FORMULA
 * -------
 *   kcal = MET × bodyWeightKg × durationHours
 *
 * 1 MET is defined as the energy cost of sitting quietly, which is ≈ 1 kcal
 * per kg of body weight per hour (a close approximation of resting metabolic
 * rate). A MET of N means "N times resting output," so multiplying by body
 * weight and duration in hours gives kcal directly. (Some references write
 * kcal/min = MET × 3.5 × kg / 200 — that's the same value: 3.5/200 × 60 =
 * 1.05 ≈ 1, just derived from VO2 in ml O2/kg/min instead of the kcal/kg/hr
 * shortcut used here.)
 *
 * SCOPE
 * -----
 * This module computes exercise calories ONLY. It never estimates BMR, TDEE,
 * or "maintenance" — see buildMaintenanceEstimatorInput() at the bottom for
 * the explicit, minimal hand-off to whatever does.
 */

// ---------------------------------------------------------------------------
// Plausibility bounds — wide enough to cover real training and cardio, tight
// enough to catch obvious data-entry errors (a MET of 60, a 14-hour "walk").
// ---------------------------------------------------------------------------
const MIN_PLAUSIBLE_MET = 1;    // resting
const MAX_PLAUSIBLE_MET = 20;   // elite-effort ceiling (e.g. sub-3:00 marathon pace)
const MIN_DURATION_MIN = 1;
const MAX_DURATION_MIN = 600;   // 10 hours
const MAX_PLAUSIBLE_KCAL_PER_ENTRY = 1500; // one entry; catches unit/typo errors, not real ultra efforts

/**
 * @typedef {'workout'|'walk'} ExerciseKind
 *
 * @typedef {Object} ExerciseEntry
 * @property {string} date            Local calendar day this entry counts toward, 'YYYY-MM-DD'.
 * @property {ExerciseKind} kind       'workout' (lifting/training session) or 'walk' — kept as
 *                                     separate, explicit values rather than inferred from activityType,
 *                                     per the "walking stays separate in the data model" requirement.
 * @property {string} activityType     Free-form label ('strength', 'run', 'cycle', 'walk', 'hyrox', ...)
 *                                     used only for the totals-by-type breakdown.
 * @property {number} met              Metabolic Equivalent of Task for this entry.
 * @property {number} durationMinutes  Duration of the entry, in minutes.
 * @property {number} bodyWeightKg     Body-weight snapshot at the time of the entry, in kg.
 */

/**
 * Calorie burn for ONE entry via the MET formula, plus any plausibility
 * warnings for that entry.
 * @param {ExerciseEntry} entry
 * @returns {{ kcal: number, warnings: string[] }}
 */
function caloriesForEntry(entry) {
  const { date, met, durationMinutes, bodyWeightKg } = entry;

  if (!(met > 0) || !(durationMinutes > 0) || !(bodyWeightKg > 0)) {
    return {
      kcal: 0,
      warnings: [`${date}: missing or non-positive met/durationMinutes/bodyWeightKg — treated as 0 kcal`]
    };
  }

  const warnings = [];
  if (met < MIN_PLAUSIBLE_MET || met > MAX_PLAUSIBLE_MET) {
    warnings.push(`${date}: MET ${met} is outside the plausible range [${MIN_PLAUSIBLE_MET}, ${MAX_PLAUSIBLE_MET}]`);
  }
  if (durationMinutes < MIN_DURATION_MIN || durationMinutes > MAX_DURATION_MIN) {
    warnings.push(`${date}: duration ${durationMinutes}min is outside the plausible range [${MIN_DURATION_MIN}, ${MAX_DURATION_MIN}]`);
  }

  const kcal = met * bodyWeightKg * (durationMinutes / 60);

  if (kcal > MAX_PLAUSIBLE_KCAL_PER_ENTRY) {
    warnings.push(`${date}: computed ${Math.round(kcal)} kcal exceeds the plausible per-entry ceiling (${MAX_PLAUSIBLE_KCAL_PER_ENTRY}) — check met/duration/bodyWeightKg for a data-entry error`);
  }

  return { kcal: Math.round(kcal), warnings };
}

/**
 * @typedef {Object} TdeeSource
 * @property {number} activityMultiplier  The multiplier a maintenance estimator applies to BMR
 *   (e.g. IronLog's routes/plated.js ACTIVITY_MULTIPLIERS: sedentary 1.2, light 1.375, moderate
 *   1.55, very 1.725, athlete 1.9). Only 'sedentary' (1.2) assumes no meaningful exercise —
 *   anything above it already bakes SOME exercise into the multiplier itself.
 * @property {string} [label]  Optional human-readable level name for the warning message.
 */

const SEDENTARY_MULTIPLIER_CEILING = 1.2;

/**
 * @param {ExerciseEntry[]} entries
 * @param {Object} [options]
 * @param {TdeeSource} [options.tdeeSource]  If provided, checked for double-counting risk (see below).
 * @returns {{
 *   exerciseCaloriesByDay: Record<string, number>,
 *   avgExerciseCalories: number,
 *   totalsByActivityType: Record<string, number>,
 *   warnings: string[]
 * }}
 */
function aggregateExerciseCalories(entries, options = {}) {
  const exerciseCaloriesByDay = {};
  const totalsByActivityType = {};
  const warnings = [];

  for (const entry of entries || []) {
    const { kcal, warnings: entryWarnings } = caloriesForEntry(entry);
    warnings.push(...entryWarnings);

    exerciseCaloriesByDay[entry.date] = (exerciseCaloriesByDay[entry.date] || 0) + kcal;

    const typeKey = entry.activityType || entry.kind;
    totalsByActivityType[typeKey] = (totalsByActivityType[typeKey] || 0) + kcal;
  }

  const days = Object.keys(exerciseCaloriesByDay);
  const totalKcal = days.reduce((sum, d) => sum + exerciseCaloriesByDay[d], 0);
  const avgExerciseCalories = days.length ? Math.round(totalKcal / days.length) : 0;

  // Double-counting protection: a TDEE derived from BMR × an activity
  // multiplier above "sedentary" already assumes some exercise is happening.
  // Adding this module's explicit exercise calories ON TOP of that TDEE
  // counts the same exercise energy twice — once implicitly (the
  // multiplier), once explicitly (this total).
  const src = options.tdeeSource;
  if (src && typeof src.activityMultiplier === 'number' && src.activityMultiplier > SEDENTARY_MULTIPLIER_CEILING) {
    warnings.push(
      `TDEE source uses an activity multiplier of ${src.activityMultiplier}` +
      (src.label ? ` ("${src.label}")` : '') +
      ` — above sedentary (${SEDENTARY_MULTIPLIER_CEILING}), meaning it already assumes some exercise. ` +
      `Adding these explicit exercise calories on top likely double-counts exercise energy. ` +
      `Either switch the TDEE source to a sedentary multiplier and add all exercise explicitly here, ` +
      `or drop this module's contribution and rely on the multiplier alone.`
    );
  }

  return { exerciseCaloriesByDay, avgExerciseCalories, totalsByActivityType, warnings };
}

/**
 * The minimal, explicit contract handed to a maintenance/TDEE estimator. This
 * module computes nothing about BMR/TDEE/maintenance itself — it only
 * produces this input. What the estimator does with it (add it to a
 * sedentary TDEE, ignore it because the TDEE source already assumes
 * exercise, etc.) is entirely the estimator's decision.
 * @typedef {Object} MaintenanceEstimatorInput
 * @property {Record<string, number>} exerciseCaloriesByDay
 * @property {number} avgExerciseCalories
 * @property {string[]} warnings
 */

/**
 * @param {ExerciseEntry[]} entries
 * @param {Object} [options]
 * @param {TdeeSource} [options.tdeeSource]
 * @returns {MaintenanceEstimatorInput}
 */
function buildMaintenanceEstimatorInput(entries, options = {}) {
  const { exerciseCaloriesByDay, avgExerciseCalories, warnings } = aggregateExerciseCalories(entries, options);
  return { exerciseCaloriesByDay, avgExerciseCalories, warnings };
}

module.exports = {
  caloriesForEntry,
  aggregateExerciseCalories,
  buildMaintenanceEstimatorInput
};
