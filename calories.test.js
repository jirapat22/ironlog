'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const { activityCalories } = require('./calories');

// Duration-based estimate: MET(type) × RPE multiplier × bodyweight × hours.
test('run, 45 min, RPE 8, 80kg ≈ 552 kcal', () => {
  // 10 (run) × 0.92 (rpe8) × 80 × 0.75h = 552
  assert.strictEqual(activityCalories('run', 45, 8, 80), 552);
});

test('null when bodyweight is unknown (cannot estimate)', () => {
  assert.strictEqual(activityCalories('run', 45, 8, null), null);
});

test('zero/negative duration burns nothing', () => {
  assert.strictEqual(activityCalories('hyrox', 0, 8, 80), 0);
  assert.strictEqual(activityCalories('hyrox', -5, 8, 80), 0);
});

test('unknown type falls back to a moderate MET', () => {
  // 6 (other) × 0.92 × 80 × 0.5h = 220.8 → 221
  assert.strictEqual(activityCalories('underwater-basket-weaving', 30, 8, 80), 221);
});

test('missing RPE is treated as moderate (≈8)', () => {
  assert.strictEqual(activityCalories('run', 45, null, 80), 552);
});

test('capped so a freak entry cannot blow up the day', () => {
  assert.ok(activityCalories('run', 100000, 10, 120) <= 1500);
});

// Pace-based estimate (ACSM): distance + duration -> real speed -> MET, no RPE.
test('run with distance uses pace, not the fixed MET/RPE fallback', () => {
  // 10km in 60min = 10 km/h -> speed 166.7 m/min -> VO2 = 0.2*166.7+3.5 = 36.83
  // -> MET 10.52 -> 10.52 * 80kg * 1h = 841.6 -> 842
  const fast = activityCalories('run', 60, 8, 80, 10, 'km');
  assert.strictEqual(fast, 842);
  // A slower 5km in the same 60min should burn noticeably less — the fixed
  // MET/RPE model couldn't tell these two apart at all (both "run", RPE 8).
  const slow = activityCalories('run', 60, 8, 80, 5, 'km');
  assert.ok(slow < fast, `slower pace (${slow}) should burn less than faster pace (${fast})`);
});

test('run distance in miles converts before computing pace', () => {
  const km = activityCalories('run', 60, 8, 80, 10, 'km');
  const mi = activityCalories('run', 60, 8, 80, 10 / 1.60934, 'mi');
  assert.strictEqual(mi, km);
});

test('walk uses the (lower) walking coefficient, not the running one', () => {
  const walk5km = activityCalories('walk', 60, 8, 80, 5, 'km');
  const run5km = activityCalories('run', 60, 8, 80, 5, 'km');
  assert.ok(walk5km < run5km, 'walking the same distance should cost less than running it');
});

test('an implausible pace (bad data entry) falls back to the fixed-MET model', () => {
  // 500km in 10 minutes is not a real run — falls back, matching no-distance behavior.
  const bogus = activityCalories('run', 10, 8, 80, 500, 'km');
  const noDistance = activityCalories('run', 10, 8, 80, null, null);
  assert.strictEqual(bogus, noDistance);
});

test('a non-pace activity type ignores distance and uses the fixed model', () => {
  const withDistance = activityCalories('cycle', 60, 8, 80, 20, 'km');
  const withoutDistance = activityCalories('cycle', 60, 8, 80, null, null);
  assert.strictEqual(withDistance, withoutDistance);
});
