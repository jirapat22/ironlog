'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const {
  caloriesForEntry,
  aggregateExerciseCalories,
  buildMaintenanceEstimatorInput
} = require('./exerciseCalorieModule');

// ---------------------------------------------------------------------------
// Sample data: a week mixing workouts and walks, one bad entry, one implausible one.
// ---------------------------------------------------------------------------
const sampleEntries = [
  { date: '2026-07-06', kind: 'workout', activityType: 'strength', met: 6, durationMinutes: 60, bodyWeightKg: 80 },
  { date: '2026-07-07', kind: 'walk', activityType: 'walk', met: 3.5, durationMinutes: 45, bodyWeightKg: 80 },
  { date: '2026-07-07', kind: 'workout', activityType: 'strength', met: 5, durationMinutes: 50, bodyWeightKg: 80 },
  { date: '2026-07-09', kind: 'workout', activityType: 'run', met: 10, durationMinutes: 30, bodyWeightKg: 80 },
  { date: '2026-07-10', kind: 'walk', activityType: 'walk', met: 3.5, durationMinutes: 40, bodyWeightKg: 80 }
];

test('caloriesForEntry: MET x bodyweight x hours', () => {
  // 6 x 80 x 1h = 480
  assert.strictEqual(caloriesForEntry(sampleEntries[0]).kcal, 480);
  // 3.5 x 80 x 0.75h = 210
  assert.strictEqual(caloriesForEntry(sampleEntries[1]).kcal, 210);
});

test('caloriesForEntry: missing fields burn 0 kcal with a warning, not a throw', () => {
  const { kcal, warnings } = caloriesForEntry({ date: '2026-07-11', kind: 'walk', activityType: 'walk', met: 0, durationMinutes: 30, bodyWeightKg: 80 });
  assert.strictEqual(kcal, 0);
  assert.strictEqual(warnings.length, 1);
});

test('caloriesForEntry: implausible MET is flagged but still computed', () => {
  const { kcal, warnings } = caloriesForEntry({ date: '2026-07-11', kind: 'workout', activityType: 'other', met: 45, durationMinutes: 30, bodyWeightKg: 80 });
  assert.strictEqual(kcal, 1800); // 45 x 80 x 0.5h
  assert.ok(warnings.some((w) => w.includes('MET 45')));
});

test('caloriesForEntry: implausible duration is flagged', () => {
  const { warnings } = caloriesForEntry({ date: '2026-07-11', kind: 'walk', activityType: 'walk', met: 3.5, durationMinutes: 900, bodyWeightKg: 80 });
  assert.ok(warnings.some((w) => w.includes('duration 900min')));
});

test('caloriesForEntry: a plausible MET/duration but freak kcal total is flagged', () => {
  const { warnings } = caloriesForEntry({ date: '2026-07-11', kind: 'workout', activityType: 'run', met: 19, durationMinutes: 590, bodyWeightKg: 150 });
  assert.ok(warnings.some((w) => w.includes('exceeds the plausible per-entry ceiling')));
});

test('aggregateExerciseCalories: sums correctly per day, including multiple entries on one day', () => {
  const { exerciseCaloriesByDay } = aggregateExerciseCalories(sampleEntries);
  assert.strictEqual(exerciseCaloriesByDay['2026-07-06'], 480);
  // 07-07 has both a walk (210) and a workout (5*80*50/60 = 333.33 -> 333)
  assert.strictEqual(exerciseCaloriesByDay['2026-07-07'], 210 + 333);
  assert.strictEqual(exerciseCaloriesByDay['2026-07-09'], 400); // 10*80*0.5h
});

test('aggregateExerciseCalories: avg is over days WITH entries, not the calendar window', () => {
  const { avgExerciseCalories, exerciseCaloriesByDay } = aggregateExerciseCalories(sampleEntries);
  const days = Object.keys(exerciseCaloriesByDay);
  const total = days.reduce((s, d) => s + exerciseCaloriesByDay[d], 0);
  assert.strictEqual(avgExerciseCalories, Math.round(total / days.length));
});

test('aggregateExerciseCalories: totals by activity type keep walks separate from workouts', () => {
  const { totalsByActivityType } = aggregateExerciseCalories(sampleEntries);
  assert.ok('walk' in totalsByActivityType);
  assert.ok('strength' in totalsByActivityType);
  assert.ok('run' in totalsByActivityType);
  // walk total = 210 (07-07) + 140 (07-10, 3.5*80*40/60=186.67->187) — just check it's isolated from strength
  assert.notStrictEqual(totalsByActivityType.walk, totalsByActivityType.strength);
});

test('aggregateExerciseCalories: no tdeeSource -> no double-counting warning', () => {
  const { warnings } = aggregateExerciseCalories(sampleEntries);
  assert.ok(!warnings.some((w) => w.includes('double-count')));
});

test('aggregateExerciseCalories: sedentary TDEE source -> no double-counting warning', () => {
  const { warnings } = aggregateExerciseCalories(sampleEntries, { tdeeSource: { activityMultiplier: 1.2, label: 'sedentary' } });
  assert.ok(!warnings.some((w) => w.includes('double-count')));
});

test('aggregateExerciseCalories: "moderate" (or above) TDEE source -> double-counting warning', () => {
  const { warnings } = aggregateExerciseCalories(sampleEntries, { tdeeSource: { activityMultiplier: 1.55, label: 'moderate' } });
  const hit = warnings.find((w) => w.includes('double-count'));
  assert.ok(hit, 'expected a double-counting warning');
  assert.ok(hit.includes('1.55'));
  assert.ok(hit.includes('moderate'));
});

test('buildMaintenanceEstimatorInput: only exposes the three documented fields', () => {
  const result = buildMaintenanceEstimatorInput(sampleEntries, { tdeeSource: { activityMultiplier: 1.9, label: 'athlete' } });
  assert.deepStrictEqual(Object.keys(result).sort(), ['avgExerciseCalories', 'exerciseCaloriesByDay', 'warnings']);
  assert.ok(result.warnings.some((w) => w.includes('double-count')));
});
