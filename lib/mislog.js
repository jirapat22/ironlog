'use strict';

// ---------------------------------------------------------------------------
// Mislogged-set detection.
//
// The progression suggestion is only ever as good as what was typed into it:
// a single fat-fingered 850kg becomes that exercise's best set, and every
// "increase weight" recommendation after it is nonsense. This finds sets whose
// LOAD is out of all proportion to your own history for that exercise, so they
// can be reviewed before they steer anything.
//
// Two rules, deliberately narrow — a false alarm on a genuine PR is worse than
// a missed typo, because it blocks a suggestion you were relying on:
//
//   1. Above best-ever — more than BEST_EVER_FACTOR times the heaviest you
//      have credibly done on that exercise. A real PR moves a few percent; a
//      typo moves multiples.
//   2. Decimal slip   — roughly 10x or 1/10 of your typical working load, the
//      classic missed decimal point or extra zero. Caught separately because
//      a 1/10 slip is BELOW best-ever and rule 1 would never see it.
//
// Comparison runs on EFFECTIVE load (per-arm doubling, bodyweight plus added)
// so a lift is judged on what it actually loaded rather than the raw number
// typed. Assisted lifts are the one exception and are compared on the
// assistance figure itself: effective load there is bodyweight MINUS
// assistance, so the very typo worth catching (30kg of help typed as 300)
// drives load to zero and hides in the one place the sensible metric stops
// looking. Their low side is never queried either — less assistance means you
// got stronger.
// ---------------------------------------------------------------------------

// More than half again your best ever. Chosen tight on purpose: 50% above an
// established best is not something you reach by accident.
const BEST_EVER_FACTOR = 1.5;

// How far from "typical" counts as a decimal slip. 8x rather than exactly 10x
// so a slip is still caught when the typical figure sits a little off the
// round number (e.g. usual 82.5kg, typed 850 -> 10.3x; usual 95, typed 850 ->
// 8.9x).
const SLIP_FACTOR = 8;

// Until there are this many earlier sessions for an exercise there is no
// meaningful "usual" to compare against, and early progress is genuinely fast
// (40kg to 60kg in a fortnight is real, not a typo). Stay quiet.
const MIN_PRIOR_SESSIONS = 3;

// When building the baseline, ignore sets that are themselves wildly above the
// median. Without this two mislogs cover for each other — each one becomes the
// other's "best ever" and neither is ever flagged.
const BASELINE_JUNK_FACTOR = 3;

function median(nums) {
  if (!nums.length) return 0;
  const sorted = [...nums].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

// The correction most likely intended. Only offered when it actually lands
// near your usual load — a guess that is still wrong is worse than no guess,
// because it is one tap away from being saved as fact.
function suggestCorrection(set, typicalLoad) {
  if (!(typicalLoad > 0) || !(set.compareKg > 0) || !(set.weight > 0)) return null;
  const scale = set.compareKg / set.weight; // compared value per unit of the typed number
  // Only magnitude slips. A unit swap is a coin flip at this distance — for a
  // real 140kg bench it happily proposed "you meant 140lbs" purely because
  // 63.5kg sat near the usual working weight, and that is one tap away from
  // overwriting a genuine lift. Units have their own dedicated checker
  // (unit-outliers), which decides on consistency rather than on magnitude.
  const candidates = [
    { weight: +(set.weight / 10).toFixed(2), why: 'decimal point' },
    { weight: +(set.weight * 10).toFixed(2), why: 'missing zero' }
  ];
  let best = null;
  for (const c of candidates) {
    if (!(c.weight > 0)) continue;
    const ratio = (c.weight * scale) / typicalLoad;
    // Within 40% of typical either way — close enough to be the number that
    // was meant, far enough out that a coincidence doesn't qualify.
    if (ratio < 0.6 || ratio > 1.4) continue;
    const distance = Math.abs(Math.log(ratio));
    if (!best || distance < best.distance) best = { ...c, distance };
  }
  return best ? { weight: best.weight, reason: best.why } : null;
}

/**
 * @param {Array} sets Non-warmup sets for one profile, each:
 *   { id, exercise_id, workout_id, logged_at, weight, weight_unit, reps,
 *     weight_reviewed, loadKg, is_assisted }  — loadKg is effective load in kg.
 * @returns {Array} one entry per suspicious set, heaviest offender first.
 */
function findSuspiciousSets(sets) {
  const byExercise = new Map();
  for (const s of sets) {
    // Assisted lifts are compared on the assistance number itself, not on
    // effective load. Effective load is bodyweight MINUS assistance, so the
    // very typo worth catching (30kg of assistance typed as 300) drives load
    // to zero and would be skipped as "unloaded" — the mistake hides in
    // exactly the place the sensible metric stops looking.
    const compareKg = s.is_assisted ? s.assistKg : s.loadKg;
    if (!(compareKg > 0)) continue; // nothing loaded, nothing to compare
    if (!byExercise.has(s.exercise_id)) byExercise.set(s.exercise_id, []);
    byExercise.get(s.exercise_id).push({ ...s, compareKg });
  }

  const flagged = [];
  for (const [exerciseId, exSets] of byExercise) {
    const ordered = [...exSets].sort((a, b) => String(a.logged_at).localeCompare(String(b.logged_at)));

    for (const candidate of ordered) {
      // A set you have already looked at and confirmed stays confirmed, and
      // counts toward your best ever from then on.
      if (candidate.weight_reviewed) continue;

      // "At least N previous sessions" means distinct earlier workouts, not
      // earlier sets — three sets in one session is still one data point.
      const priorSessions = new Set(
        ordered.filter((s) => String(s.logged_at) < String(candidate.logged_at)).map((s) => s.workout_id)
      );
      if (priorSessions.size < MIN_PRIOR_SESSIONS) continue;

      const others = ordered.filter((s) => s.id !== candidate.id);
      if (!others.length) continue;
      const typical = median(others.map((s) => s.compareKg));
      if (!(typical > 0)) continue;

      // Best ever, with obvious junk kept out so one mislog cannot license the
      // next one.
      const credible = others.filter((s) => s.compareKg <= typical * BASELINE_JUNK_FACTOR);
      const bestEver = credible.length ? Math.max(...credible.map((s) => s.compareKg)) : typical;

      const ratio = candidate.compareKg / typical;
      let reason = null;
      if (candidate.compareKg > bestEver * BEST_EVER_FACTOR) {
        reason = 'above_best';
      } else if (ratio >= SLIP_FACTOR) {
        reason = 'decimal_slip';
      } else if (ratio <= 1 / SLIP_FACTOR && !candidate.is_assisted) {
        // Only for ordinary lifts. On an assisted lift a small number means
        // LESS help, i.e. you got stronger — never something to query.
        reason = 'decimal_slip';
      }
      if (!reason) continue;

      flagged.push({
        set_id: candidate.id,
        exercise_id: exerciseId,
        workout_id: candidate.workout_id,
        logged_at: candidate.logged_at,
        weight: candidate.weight,
        weight_unit: candidate.weight_unit,
        reps: candidate.reps,
        is_assisted: !!candidate.is_assisted,
        // The figure actually compared: effective load normally, the
        // assistance itself on an assisted lift.
        compare_kg: +candidate.compareKg.toFixed(2),
        reason,
        typical_kg: +typical.toFixed(2),
        best_ever_kg: +bestEver.toFixed(2),
        suggestion: suggestCorrection(candidate, typical)
      });
    }
  }

  flagged.sort((a, b) => b.compare_kg - a.compare_kg);
  return flagged;
}

module.exports = {
  findSuspiciousSets,
  BEST_EVER_FACTOR,
  SLIP_FACTOR,
  MIN_PRIOR_SESSIONS
};
