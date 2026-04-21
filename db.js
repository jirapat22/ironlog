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

    CREATE INDEX IF NOT EXISTS idx_sets_workout ON sets(workout_id);
    CREATE INDEX IF NOT EXISTS idx_sets_exercise ON sets(exercise_id);
    CREATE INDEX IF NOT EXISTS idx_workouts_program_day ON workouts(program_day_id);
    CREATE INDEX IF NOT EXISTS idx_program_day_exercises_day ON program_day_exercises(program_day_id);
  `);

  seed();
}

function seed() {
  const exerciseCount = db.prepare('SELECT COUNT(*) as c FROM exercises').get().c;
  if (exerciseCount === 0) {
    const insertExercise = db.prepare(
      'INSERT INTO exercises (name, muscle_group, notes) VALUES (?, ?, ?)'
    );

    const exercises = [
      ['Bench Press', 'chest', 'Barbell, flat bench'],
      ['Incline Dumbbell Press', 'chest', 'Adjustable bench at 30-45 degrees'],
      ['Cable Fly', 'chest', 'High to low or mid-height'],
      ['Push-Up', 'chest', 'Bodyweight'],

      ['Deadlift', 'back', 'Conventional or sumo'],
      ['Pull-Up', 'back', 'Wide or neutral grip'],
      ['Barbell Row', 'back', 'Bent over, overhand grip'],
      ['Lat Pulldown', 'back', 'Cable machine'],
      ['Seated Cable Row', 'back', 'Neutral grip'],

      ['Overhead Press', 'shoulders', 'Standing barbell'],
      ['Lateral Raise', 'shoulders', 'Dumbbell or cable'],
      ['Rear Delt Fly', 'shoulders', 'Reverse pec deck or dumbbell'],

      ['Barbell Curl', 'arms', 'EZ bar optional'],
      ['Hammer Curl', 'arms', 'Dumbbell, neutral grip'],
      ['Tricep Pushdown', 'arms', 'Cable, straight or rope'],
      ['Skull Crusher', 'arms', 'EZ bar, lying'],

      ['Back Squat', 'legs', 'High or low bar'],
      ['Romanian Deadlift', 'legs', 'Hamstring focus'],
      ['Leg Press', 'legs', 'Machine'],
      ['Leg Curl', 'legs', 'Lying or seated'],
      ['Standing Calf Raise', 'legs', 'Machine or smith']
    ];

    tx(() => {
      for (const row of exercises) insertExercise.run(...row);
    });
  }

  const programCount = db.prepare('SELECT COUNT(*) as c FROM programs').get().c;
  if (programCount === 0) {
    const insertProgram = db.prepare('INSERT INTO programs (name, description) VALUES (?, ?)');
    const insertDay = db.prepare(
      'INSERT INTO program_days (program_id, day_label, day_order) VALUES (?, ?, ?)'
    );
    const insertDayEx = db.prepare(
      'INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index) VALUES (?, ?, ?, ?, ?)'
    );
    const findEx = db.prepare('SELECT id FROM exercises WHERE name = ?');

    const days = [
      {
        label: 'Day A — Push',
        order: 1,
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
        order: 2,
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
        order: 3,
        exercises: [
          ['Back Squat', 4, 6],
          ['Romanian Deadlift', 3, 8],
          ['Leg Press', 3, 10],
          ['Leg Curl', 3, 12],
          ['Standing Calf Raise', 4, 15]
        ]
      }
    ];

    tx(() => {
      const programId = Number(
        insertProgram.run(
          'Push / Pull / Legs',
          '3-day split focused on compound lifts and hypertrophy'
        ).lastInsertRowid
      );

      for (const day of days) {
        const dayId = Number(
          insertDay.run(programId, day.label, day.order).lastInsertRowid
        );
        day.exercises.forEach(([name, sets, reps], i) => {
          const ex = findEx.get(name);
          if (ex) insertDayEx.run(dayId, ex.id, sets, reps, i);
        });
      }
    });
  }
}

module.exports = { db, init, tx };
