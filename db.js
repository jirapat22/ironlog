const path = require('path');
const fs = require('fs');
const { DatabaseSync } = require('node:sqlite');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'ironlog.db');

const dir = path.dirname(DB_PATH);
if (!fs.existsSync(dir)) {
  fs.mkdirSync(dir, { recursive: true });
}

const db = new DatabaseSync(DB_PATH);
db.exec('PRAGMA journal_mode = WAL');
db.exec('PRAGMA foreign_keys = ON');

function tx(fn) {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      muscle_group TEXT NOT NULL,
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS program_days (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_id INTEGER NOT NULL,
      day_label TEXT NOT NULL,
      day_order INTEGER NOT NULL,
      FOREIGN KEY (program_id) REFERENCES programs(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS program_day_exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_day_id INTEGER NOT NULL,
      exercise_id INTEGER NOT NULL,
      target_sets INTEGER NOT NULL DEFAULT 3,
      target_reps INTEGER NOT NULL DEFAULT 10,
      order_index INTEGER NOT NULL DEFAULT 0,
      FOREIGN KEY (program_day_id) REFERENCES program_days(id) ON DELETE CASCADE,
      FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS workouts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      program_day_id INTEGER,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      finished_at TEXT,
      notes TEXT,
      FOREIGN KEY (program_day_id) REFERENCES program_days(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      workout_id INTEGER NOT NULL,
      exercise_id INTEGER NOT NULL,
      set_number INTEGER NOT NULL,
      weight REAL NOT NULL,
      weight_unit TEXT NOT NULL DEFAULT 'kg',
      reps INTEGER NOT NULL,
      rpe REAL,
      notes TEXT,
      logged_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (workout_id) REFERENCES workouts(id) ON DELETE CASCADE,
      FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS personal_records (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      exercise_id INTEGER NOT NULL,
      weight REAL NOT NULL,
      weight_unit TEXT NOT NULL DEFAULT 'kg',
      reps INTEGER NOT NULL,
      achieved_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE,
      UNIQUE(exercise_id, reps)
    );

    CREATE TABLE IF NOT EXISTS bodyweights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      weight REAL NOT NULL,
      weight_unit TEXT NOT NULL DEFAULT 'kg',
      logged_at TEXT NOT NULL DEFAULT (datetime('now')),
      notes TEXT
    );

    CREATE TABLE IF NOT EXISTS push_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      endpoint TEXT NOT NULL UNIQUE,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      user_agent TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sets_workout ON sets(workout_id);
    CREATE INDEX IF NOT EXISTS idx_sets_exercise ON sets(exercise_id);
    CREATE INDEX IF NOT EXISTS idx_workouts_program_day ON workouts(program_day_id);
    CREATE INDEX IF NOT EXISTS idx_program_day_exercises_day ON program_day_exercises(program_day_id);
    CREATE INDEX IF NOT EXISTS idx_bodyweights_logged ON bodyweights(logged_at DESC);
  `);

  seed();
}

const CANONICAL_EXERCISES = [
  // Chest
  ['Bench Press', 'chest', 'Barbell, flat bench'],
  ['Incline Bench Press', 'chest', 'Barbell, 30-45 degree bench'],
  ['Decline Bench Press', 'chest', 'Barbell, decline bench'],
  ['Incline Dumbbell Press', 'chest', 'Adjustable bench at 30-45 degrees'],
  ['Flat Dumbbell Press', 'chest', 'Dumbbells, flat bench'],
  ['Dumbbell Fly', 'chest', 'Flat or incline bench'],
  ['Cable Fly', 'chest', 'Mid-height cables'],
  ['Cable Crossover', 'chest', 'High to low'],
  ['Machine Chest Press', 'chest', 'Plate-loaded or selectorized'],
  ['Pec Deck', 'chest', 'Machine fly'],
  ['Chest Dip', 'chest', 'Leaning forward, bodyweight'],
  ['Push-Up', 'chest', 'Bodyweight'],

  // Back
  ['Deadlift', 'back', 'Conventional'],
  ['Sumo Deadlift', 'back', 'Wide stance'],
  ['Rack Pull', 'back', 'Deadlift from pins, knee height'],
  ['Pull-Up', 'back', 'Overhand, wide or shoulder-width'],
  ['Chin-Up', 'back', 'Underhand grip'],
  ['Lat Pulldown', 'back', 'Cable, neutral or wide'],
  ['Wide-Grip Lat Pulldown', 'back', 'Wide overhand grip'],
  ['Barbell Row', 'back', 'Bent over, overhand'],
  ['Pendlay Row', 'back', 'Dead-stop from floor'],
  ['One-Arm Dumbbell Row', 'back', 'Knee-on-bench'],
  ['T-Bar Row', 'back', 'Landmine or machine'],
  ['Seated Cable Row', 'back', 'Neutral grip'],
  ['Chest-Supported Row', 'back', 'Incline bench or machine'],
  ['Face Pull', 'back', 'Rope attachment, high cable'],
  ['Shrug', 'back', 'Barbell or dumbbell'],

  // Shoulders
  ['Overhead Press', 'shoulders', 'Standing barbell'],
  ['Seated Dumbbell Press', 'shoulders', 'Dumbbells, upright bench'],
  ['Arnold Press', 'shoulders', 'Rotating dumbbell press'],
  ['Machine Shoulder Press', 'shoulders', 'Plate-loaded or selectorized'],
  ['Lateral Raise', 'shoulders', 'Dumbbell'],
  ['Cable Lateral Raise', 'shoulders', 'Low cable, one arm'],
  ['Rear Delt Fly', 'shoulders', 'Bent-over dumbbell'],
  ['Reverse Pec Deck', 'shoulders', 'Machine rear delts'],
  ['Upright Row', 'shoulders', 'Barbell or cable'],

  // Arms — biceps
  ['Barbell Curl', 'arms', 'Straight or EZ bar'],
  ['Dumbbell Curl', 'arms', 'Alternating or simultaneous'],
  ['Hammer Curl', 'arms', 'Neutral grip dumbbell'],
  ['Preacher Curl', 'arms', 'EZ bar or machine'],
  ['Incline Dumbbell Curl', 'arms', 'Incline bench'],
  ['Cable Curl', 'arms', 'Low cable, bar or rope'],

  // Arms — triceps
  ['Tricep Pushdown', 'arms', 'Cable, straight bar'],
  ['Rope Pushdown', 'arms', 'Cable, rope attachment'],
  ['Overhead Tricep Extension', 'arms', 'Dumbbell or rope'],
  ['Skull Crusher', 'arms', 'EZ bar, lying'],
  ['Close-Grip Bench Press', 'arms', 'Shoulder-width grip'],
  ['Tricep Dip', 'arms', 'Parallel bars, upright'],

  // Legs
  ['Back Squat', 'legs', 'High or low bar'],
  ['Front Squat', 'legs', 'Clean grip'],
  ['Goblet Squat', 'legs', 'Dumbbell or kettlebell'],
  ['Romanian Deadlift', 'legs', 'Hamstring focus'],
  ['Stiff-Leg Deadlift', 'legs', 'Straight legs, hamstrings'],
  ['Leg Press', 'legs', 'Machine, 45 degree'],
  ['Hack Squat', 'legs', 'Machine'],
  ['Bulgarian Split Squat', 'legs', 'Rear foot elevated'],
  ['Walking Lunge', 'legs', 'Dumbbells or barbell'],
  ['Leg Extension', 'legs', 'Machine, quads'],
  ['Lying Leg Curl', 'legs', 'Machine, hamstrings'],
  ['Seated Leg Curl', 'legs', 'Machine, hamstrings'],
  ['Standing Calf Raise', 'legs', 'Machine or Smith'],
  ['Seated Calf Raise', 'legs', 'Machine'],
  ['Hip Thrust', 'legs', 'Barbell, bench-supported'],
  ['Glute Bridge', 'legs', 'Barbell or bodyweight'],

  // Core
  ['Hanging Leg Raise', 'core', 'From pull-up bar'],
  ['Cable Crunch', 'core', 'Kneeling, rope attachment'],
  ['Ab Wheel Rollout', 'core', 'From knees or toes'],
  ['Plank', 'core', 'Timed hold — log seconds in reps'],
  ['Russian Twist', 'core', 'Weighted, seated']
];

function seed() {
  // Additive: add any missing canonical exercises on every startup
  const insertExercise = db.prepare(
    'INSERT OR IGNORE INTO exercises (name, muscle_group, notes) VALUES (?, ?, ?)'
  );
  tx(() => {
    for (const row of CANONICAL_EXERCISES) insertExercise.run(...row);
  });

  seedPrograms();
}

const CANONICAL_PROGRAMS = [
  {
    name: 'Push / Pull / Legs',
    description: '3-day split focused on compound lifts and hypertrophy',
    days: [
      {
        label: 'Day A — Push',
        exercises: [
          ['Bench Press', 4, 6],
          ['Overhead Press', 3, 8],
          ['Incline Dumbbell Press', 3, 10],
          ['Lateral Raise', 4, 12],
          ['Tricep Pushdown', 3, 12]
        ]
      },
      {
        label: 'Day B — Pull',
        exercises: [
          ['Deadlift', 3, 5],
          ['Pull-Up', 4, 8],
          ['Barbell Row', 3, 8],
          ['Seated Cable Row', 3, 10],
          ['Barbell Curl', 3, 10]
        ]
      },
      {
        label: 'Day C — Legs',
        exercises: [
          ['Back Squat', 4, 6],
          ['Romanian Deadlift', 3, 8],
          ['Leg Press', 3, 10],
          ['Lying Leg Curl', 3, 12],
          ['Standing Calf Raise', 4, 15]
        ]
      }
    ]
  },
  {
    name: 'Upper / Lower',
    description: '4-day split — two upper, two lower',
    days: [
      {
        label: 'Upper A',
        exercises: [
          ['Bench Press', 4, 6],
          ['Barbell Row', 4, 6],
          ['Incline Dumbbell Press', 3, 10],
          ['Lat Pulldown', 3, 10],
          ['Lateral Raise', 3, 12],
          ['Barbell Curl', 3, 10]
        ]
      },
      {
        label: 'Lower A',
        exercises: [
          ['Back Squat', 4, 6],
          ['Romanian Deadlift', 3, 8],
          ['Leg Press', 3, 10],
          ['Lying Leg Curl', 3, 12],
          ['Standing Calf Raise', 4, 15]
        ]
      },
      {
        label: 'Upper B',
        exercises: [
          ['Overhead Press', 4, 6],
          ['Pull-Up', 4, 8],
          ['Flat Dumbbell Press', 3, 10],
          ['Seated Cable Row', 3, 10],
          ['Tricep Pushdown', 3, 12],
          ['Hammer Curl', 3, 10]
        ]
      },
      {
        label: 'Lower B',
        exercises: [
          ['Deadlift', 3, 5],
          ['Front Squat', 3, 8],
          ['Bulgarian Split Squat', 3, 10],
          ['Seated Leg Curl', 3, 12],
          ['Seated Calf Raise', 4, 15]
        ]
      }
    ]
  },
  {
    name: '5/3/1 (BBB)',
    description: '4-day strength template — main lift + Boring But Big volume work',
    days: [
      {
        label: 'OHP Day',
        exercises: [
          ['Overhead Press', 3, 5],
          ['Chin-Up', 5, 10],
          ['Tricep Pushdown', 3, 12]
        ]
      },
      {
        label: 'Deadlift Day',
        exercises: [
          ['Deadlift', 3, 5],
          ['Barbell Row', 5, 10],
          ['Hanging Leg Raise', 3, 12]
        ]
      },
      {
        label: 'Bench Day',
        exercises: [
          ['Bench Press', 3, 5],
          ['Pull-Up', 5, 10],
          ['Dumbbell Curl', 3, 12]
        ]
      },
      {
        label: 'Squat Day',
        exercises: [
          ['Back Squat', 3, 5],
          ['Romanian Deadlift', 5, 10],
          ['Standing Calf Raise', 3, 15]
        ]
      }
    ]
  },
  {
    name: 'Bro Split',
    description: '5-day split — one muscle group per day',
    days: [
      {
        label: 'Chest Day',
        exercises: [
          ['Bench Press', 4, 8],
          ['Incline Dumbbell Press', 3, 10],
          ['Cable Fly', 3, 12],
          ['Pec Deck', 3, 12],
          ['Push-Up', 3, 15]
        ]
      },
      {
        label: 'Back Day',
        exercises: [
          ['Deadlift', 3, 5],
          ['Pull-Up', 4, 8],
          ['Barbell Row', 3, 8],
          ['Lat Pulldown', 3, 10],
          ['Face Pull', 3, 15]
        ]
      },
      {
        label: 'Shoulder Day',
        exercises: [
          ['Overhead Press', 4, 8],
          ['Lateral Raise', 4, 12],
          ['Rear Delt Fly', 3, 12],
          ['Upright Row', 3, 10],
          ['Shrug', 3, 12]
        ]
      },
      {
        label: 'Arm Day',
        exercises: [
          ['Barbell Curl', 3, 10],
          ['Hammer Curl', 3, 10],
          ['Preacher Curl', 3, 12],
          ['Tricep Pushdown', 3, 12],
          ['Skull Crusher', 3, 10],
          ['Overhead Tricep Extension', 3, 12]
        ]
      },
      {
        label: 'Leg Day',
        exercises: [
          ['Back Squat', 4, 8],
          ['Romanian Deadlift', 3, 10],
          ['Leg Press', 3, 12],
          ['Lying Leg Curl', 3, 12],
          ['Standing Calf Raise', 4, 15]
        ]
      }
    ]
  },
  {
    name: 'Starting Strength',
    description: '3-day full-body for beginners — alternates A and B',
    days: [
      {
        label: 'Workout A',
        exercises: [
          ['Back Squat', 3, 5],
          ['Bench Press', 3, 5],
          ['Deadlift', 1, 5]
        ]
      },
      {
        label: 'Workout B',
        exercises: [
          ['Back Squat', 3, 5],
          ['Overhead Press', 3, 5],
          ['Deadlift', 1, 5]
        ]
      }
    ]
  }
];

function seedPrograms() {
  const findProgram = db.prepare('SELECT id FROM programs WHERE name = ?');
  const insertProgram = db.prepare('INSERT INTO programs (name, description) VALUES (?, ?)');
  const insertDay = db.prepare(
    'INSERT INTO program_days (program_id, day_label, day_order) VALUES (?, ?, ?)'
  );
  const insertDayEx = db.prepare(
    'INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index) VALUES (?, ?, ?, ?, ?)'
  );
  const findEx = db.prepare('SELECT id FROM exercises WHERE name = ?');

  tx(() => {
    for (const program of CANONICAL_PROGRAMS) {
      const existing = findProgram.get(program.name);
      if (existing) continue; // respect user customizations; never overwrite an existing program
      const programId = Number(
        insertProgram.run(program.name, program.description).lastInsertRowid
      );
      program.days.forEach((day, dayIdx) => {
        const dayId = Number(
          insertDay.run(programId, day.label, dayIdx + 1).lastInsertRowid
        );
        day.exercises.forEach(([name, sets, reps], i) => {
          const ex = findEx.get(name);
          if (ex) insertDayEx.run(dayId, ex.id, sets, reps, i);
        });
      });
    }
  });
}

module.exports = { db, init, tx };
