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
