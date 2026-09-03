'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { findSuspiciousSets } = require('./lib/mislog');

// Build a run of sessions for one exercise: one set per session, a week apart.
function history(loads, opts = {}) {
  const { exercise_id = 1, start = 1 } = opts;
  return loads.map((weight, i) => ({
    id: start + i,
    exercise_id,
    workout_id: 100 + i,
    logged_at: `2026-01-${String(i + 1).padStart(2, '0')} 10:00:00`,
    weight,
    weight_unit: 'kg',
    reps: 8,
    weight_reviewed: 0,
    loadKg: weight
  }));
}

const ids = (found) => found.map((f) => f.set_id).sort((a, b) => a - b);

// ---------------------------------------------------------------------------
// The cases that must NOT fire. A false alarm blocks a suggestion the user
// was relying on, so these matter more than the catches.
// ---------------------------------------------------------------------------

test('a steady progression is never flagged', () => {
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 87.5, 90]));
  assert.deepStrictEqual(found, []);
});

test('a genuine PR is not a typo', () => {
  // 90 -> 95 is a real jump, nowhere near 1.5x the best ever.
  const found = findSuspiciousSets(history([80, 82.5, 85, 87.5, 90, 95]));
  assert.deepStrictEqual(found, []);
});

test('a deload week is not flagged', () => {
  const found = findSuspiciousSets(history([80, 85, 90, 92.5, 60, 95]));
  assert.deepStrictEqual(found, []);
});

test('fast early progress is left alone while history is thin', () => {
  // 40 -> 100 over four sessions is huge, but there is no baseline to judge it
  // against until MIN_PRIOR_SESSIONS have passed.
  const found = findSuspiciousSets(history([40, 60, 80, 100]));
  assert.deepStrictEqual(found, []);
});

test('nothing is flagged before three prior sessions exist', () => {
  // 850 in session 3 has only two earlier sessions behind it.
  const found = findSuspiciousSets(history([80, 85, 850]));
  assert.deepStrictEqual(found, []);
});

test('the same typo IS caught once enough history exists', () => {
  const found = findSuspiciousSets(history([80, 85, 85, 850]));
  assert.deepStrictEqual(ids(found), [4]);
});

// ---------------------------------------------------------------------------
// The catches.
// ---------------------------------------------------------------------------

test('an extra zero is flagged as above best-ever', () => {
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 850]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].set_id, 5);
  assert.strictEqual(found[0].reason, 'above_best');
});

test('a missing decimal point is flagged even though it is BELOW best ever', () => {
  // 8.5 instead of 85: rule 1 can never see this, rule 2 must.
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 8.5]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].set_id, 5);
  assert.strictEqual(found[0].reason, 'decimal_slip');
});

test('two mislogs cannot cover for each other', () => {
  // Without junk-filtering the baseline, each 850 becomes the other's
  // "best ever" and neither is ever flagged.
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 850, 850]));
  assert.deepStrictEqual(ids(found), [5, 6]);
});

test('a reviewed set is never raised again, and becomes part of the baseline', () => {
  const sets = history([80, 82.5, 85, 85, 850]);
  sets[4].weight_reviewed = 1;
  const found = findSuspiciousSets(sets);
  assert.deepStrictEqual(found, []);
});

test('exercises are judged independently', () => {
  // 200kg is absurd for the first exercise and ordinary for the second.
  const sets = [
    ...history([60, 62.5, 65, 65, 200], { exercise_id: 1, start: 1 }),
    ...history([180, 185, 190, 190, 200], { exercise_id: 2, start: 20 })
  ];
  const found = findSuspiciousSets(sets);
  assert.deepStrictEqual(ids(found), [5]);
});

// ---------------------------------------------------------------------------
// Effective load — bodyweight and assisted lifts are compared on what they
// actually loaded, not the raw number typed.
// ---------------------------------------------------------------------------

// Assisted pull-up: higher assistance = EASIER, so effective load FALLS as the
// typed number rises. Comparing on effective load would drive an absurd 300kg
// of assistance to zero load and skip it as "unloaded" — the typo hiding in
// exactly the place the sensible metric stops looking. These are therefore
// compared on the assistance figure itself.
function assisted(assistValues, bw = 80) {
  return assistValues.map((assist, i) => ({
    id: i + 1,
    exercise_id: 7,
    workout_id: 200 + i,
    logged_at: `2026-02-${String(i + 1).padStart(2, '0')} 10:00:00`,
    weight: assist,
    weight_unit: 'kg',
    reps: 8,
    weight_reviewed: 0,
    is_assisted: true,
    assistKg: assist,
    loadKg: Math.max(0, bw - assist)
  }));
}

test('an absurd assistance figure is caught, not hidden by effective load', () => {
  const found = findSuspiciousSets(assisted([30, 28, 26, 25, 300]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].set_id, 5);
  assert.strictEqual(found[0].compare_kg, 300);
});

test('needing less assistance is progress, never a flag', () => {
  // Dropping from 30kg of help to 2kg is the whole point of the exercise. On a
  // normal lift that 15x drop would read as a decimal slip.
  const found = findSuspiciousSets(assisted([30, 28, 26, 25, 2]));
  assert.deepStrictEqual(found, []);
});

test('going fully unassisted is not flagged', () => {
  const found = findSuspiciousSets(assisted([30, 28, 26, 25, 0]));
  assert.deepStrictEqual(found, []);
});

test('a per-arm doubling is not mistaken for a jump', () => {
  // Dumbbell press logged per-arm: 40kg typed, 80kg effective, every session.
  const sets = [40, 40, 42.5, 42.5, 45].map((w, i) => ({
    id: i + 1,
    exercise_id: 9,
    workout_id: 300 + i,
    logged_at: `2026-03-${String(i + 1).padStart(2, '0')} 10:00:00`,
    weight: w,
    weight_unit: 'kg',
    reps: 8,
    weight_reviewed: 0,
    loadKg: w * 2
  }));
  assert.deepStrictEqual(findSuspiciousSets(sets), []);
});

// ---------------------------------------------------------------------------
// Suggested correction.
// ---------------------------------------------------------------------------

test('an extra zero suggests dividing by ten', () => {
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 850]));
  assert.strictEqual(found[0].suggestion.weight, 85);
});

test('a missing decimal suggests multiplying by ten', () => {
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 8.5]));
  assert.strictEqual(found[0].suggestion.weight, 85);
});

test('no correction is offered when none lands near the usual load', () => {
  // 400 is well above best-ever but is not a clean 10x of ~85, so any guess
  // would still be wrong. Better to say nothing.
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 400]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].suggestion, null);
});

test('no unit-swap is ever guessed, however tempting the arithmetic', () => {
  // A real 140kg bench against an 85kg usual: 140lbs converts to 63.5kg, which
  // sits close enough to the usual weight to look like a fit. It is a coin
  // flip, and a wrong one-tap "correction" overwrites a genuine lift, so this
  // must be flagged for review with NO suggestion attached.
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 140]));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].suggestion, null);
});

test('flagged sets come back heaviest first', () => {
  const found = findSuspiciousSets(history([80, 82.5, 85, 85, 500, 900]));
  assert.deepStrictEqual(found.map((f) => f.compare_kg), [900, 500]);
});

// ---------------------------------------------------------------------------
// kg/lbs outliers. The bar here is the real report that prompted the rewrite:
// 43 flags, none of them mistakes, because the user had switched units.
// ---------------------------------------------------------------------------

const { findUnitOutliers } = require('./lib/mislog');

// One session per entry; "kg"/"lbs" is that whole session's unit.
function units(seq, { exercise_id = 1, setsPerSession = 1 } = {}) {
  const rows = [];
  let id = 1;
  seq.forEach((unit, i) => {
    for (let n = 0; n < setsPerSession; n++) {
      rows.push({
        id: id++,
        exercise_id,
        workout_id: 500 + i,
        logged_at: `2026-0${1 + Math.floor(i / 28)}-${String((i % 28) + 1).padStart(2, '0')} 10:00:00`,
        weight: 50,
        weight_unit: unit,
        reps: 10,
        unit_reviewed: 0
      });
    }
  });
  return rows;
}

test('a changeover between units is never reported', () => {
  // The actual complaint: months in lbs, then a switch to kg. Every lbs
  // session was previously flagged.
  const found = findUnitOutliers(units(['lbs','lbs','lbs','lbs','kg','kg','kg','kg','kg','kg','kg','kg']));
  assert.deepStrictEqual(found, []);
});

test('a sustained run in the other unit is a choice, not a slip', () => {
  // Cable Crunch: four lbs sessions in the middle of a kg history.
  const found = findUnitOutliers(units(['kg','kg','kg','lbs','lbs','lbs','lbs','kg','kg','kg','kg','kg']));
  assert.deepStrictEqual(found, []);
});

test('one stray session surrounded by the usual unit IS reported', () => {
  const found = findUnitOutliers(units(['kg','kg','kg','lbs','kg','kg','kg']));
  assert.strictEqual(found.length, 1);
  assert.strictEqual(found[0].weight_unit, 'lbs');
  assert.strictEqual(found[0].usual_unit, 'kg');
});

test('every set of a stray session is reported, but the session is one decision', () => {
  const found = findUnitOutliers(units(['kg','kg','kg','lbs','kg','kg','kg'], { setsPerSession: 3 }));
  assert.strictEqual(found.length, 3);
  assert.strictEqual(new Set(found.map((f) => f.workout_id)).size, 1);
});

test('a near-even split has no "usual" to be an outlier from', () => {
  const found = findUnitOutliers(units(['kg','lbs','kg','lbs','kg','lbs']));
  assert.deepStrictEqual(found, []);
});

test('an exercise with almost no history is left alone', () => {
  const found = findUnitOutliers(units(['kg','lbs']));
  assert.deepStrictEqual(found, []);
});

test('a reviewed set stays dismissed', () => {
  const rows = units(['kg','kg','kg','lbs','kg','kg','kg']);
  rows.find((r) => r.weight_unit === 'lbs').unit_reviewed = 1;
  assert.deepStrictEqual(findUnitOutliers(rows), []);
});

test('the row explains the exercise\'s unit story', () => {
  const found = findUnitOutliers(units(['kg','kg','kg','lbs','kg','kg','kg']));
  assert.strictEqual(found[0].unit_history, '6 sessions in kg, 1 in lbs');
});
