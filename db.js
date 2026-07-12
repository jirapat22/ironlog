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

function tableExists(name) {
  return !!db
    .prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?")
    .get(name);
}

function columnExists(table, column) {
  if (!tableExists(table)) return false;
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((c) => c.name === column);
}

// Shared SQL fragment for one set's effective load in kg: converts lbs to kg,
// then applies the per-arm doubling — the logged number is what ONE side
// lifts (a dumbbell per hand, a single-arm cable pushdown) and both sides do
// the work. The factor comes from the set's own load_multiplier SNAPSHOT
// (taken at log time), so flipping an exercise's weight_mode never rewrites
// history; the exercise-level CASE is only the fallback for rows that predate
// the snapshot column. Multiply by reps for volume; callers exclude warmups.
// Takes the sets/exercises table aliases since they vary across queries.
function effectiveLoadKgSql(setsAlias = 's', exAlias = 'e') {
  return `(CASE WHEN ${setsAlias}.weight_unit = 'lbs' THEN ${setsAlias}.weight * 0.45359237 ELSE ${setsAlias}.weight END)
    * COALESCE(${setsAlias}.load_multiplier, CASE WHEN ${exAlias}.weight_mode = 'per_arm' THEN 2 ELSE 1 END)`;
}

// One set's effective VOLUME load in kg — the single source of truth every
// server volume query shares (history card totals, weekly volume, sub-muscle
// frequency), so those three can never disagree again. Extends
// effectiveLoadKgSql with the bodyweight cases the plain fragment can't do
// (it has no access to the workout's bodyweight snapshot):
//   • assisted bodyweight → the machine offsets bodyweight, so effective load
//     is bodyweight − assistance (clamped at 0);
//   • plain bodyweight     → bodyweight + any added weight;
//   • everything else      → the per-arm-aware weighted load.
// Needs the WORKOUT alias for bw_kg; the bodyweight arms fall through to the
// weighted branch when bw_kg is NULL (in-progress workout, no snapshot yet).
// Multiply by reps for volume; callers still exclude warmups themselves.
function effectiveVolumeLoadKgSql(setsAlias = 's', exAlias = 'e', workoutAlias = 'w') {
  const kg = `(CASE WHEN ${setsAlias}.weight_unit = 'lbs' THEN ${setsAlias}.weight * 0.45359237 ELSE ${setsAlias}.weight END)`;
  return `CASE
    WHEN ${exAlias}.is_bodyweight = 1 AND ${exAlias}.is_assisted = 1 AND ${workoutAlias}.bw_kg IS NOT NULL
      THEN MAX(0, ${workoutAlias}.bw_kg - ${kg})
    WHEN ${exAlias}.is_bodyweight = 1 AND ${workoutAlias}.bw_kg IS NOT NULL
      THEN ${workoutAlias}.bw_kg + ${kg}
    ELSE ${effectiveLoadKgSql(setsAlias, exAlias)}
  END`;
}

function init() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      accent_color TEXT NOT NULL DEFAULT '#e8643c',
      pass_hash TEXT NOT NULL,
      pass_salt TEXT NOT NULL,
      api_key TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS sessions (
      token TEXT PRIMARY KEY,
      profile_id INTEGER NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (profile_id) REFERENCES profiles(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_profiles_api_key ON profiles(api_key);
    CREATE INDEX IF NOT EXISTS idx_sessions_profile ON sessions(profile_id);

    CREATE TABLE IF NOT EXISTS exercises (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      muscle_group TEXT NOT NULL,
      notes TEXT,
      is_bodyweight INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE IF NOT EXISTS programs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER NOT NULL DEFAULT 0,
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
      profile_id INTEGER NOT NULL DEFAULT 0,
      exercise_id INTEGER NOT NULL,
      weight REAL NOT NULL,
      weight_unit TEXT NOT NULL DEFAULT 'kg',
      reps INTEGER NOT NULL,
      achieved_at TEXT NOT NULL DEFAULT (datetime('now')),
      FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE,
      UNIQUE(profile_id, exercise_id, reps)
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

    CREATE TABLE IF NOT EXISTS app_settings (
      profile_id INTEGER NOT NULL DEFAULT 0,
      key TEXT NOT NULL,
      value TEXT,
      PRIMARY KEY (profile_id, key)
    );

    CREATE TABLE IF NOT EXISTS notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      category TEXT NOT NULL DEFAULT 'idea',
      done INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS bug_reports (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_id INTEGER,
      source TEXT NOT NULL,
      message TEXT NOT NULL,
      stack TEXT,
      context TEXT,
      orbit_sent INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_sets_workout ON sets(workout_id);
    CREATE INDEX IF NOT EXISTS idx_sets_exercise ON sets(exercise_id);
    CREATE INDEX IF NOT EXISTS idx_workouts_program_day ON workouts(program_day_id);
    CREATE INDEX IF NOT EXISTS idx_program_day_exercises_day ON program_day_exercises(program_day_id);
    CREATE INDEX IF NOT EXISTS idx_bodyweights_logged ON bodyweights(logged_at DESC);
  `);

  // De-dupe before adding the uniqueness constraint below — older DBs could
  // have the same exercise inserted into one program day twice (no guard
  // existed). Keep the lowest id (first added), drop the rest.
  db.exec(`
    DELETE FROM program_day_exercises
    WHERE id NOT IN (
      SELECT MIN(id) FROM program_day_exercises GROUP BY program_day_id, exercise_id
    )
  `);
  db.exec(
    'CREATE UNIQUE INDEX IF NOT EXISTS idx_program_day_exercises_unique ON program_day_exercises(program_day_id, exercise_id)'
  );

  // Non-destructive migration: add the column to older DBs that were created
  // before it existed. SQLite throws if the column is already there, so we
  // swallow the specific duplicate-column error.
  try {
    db.exec('ALTER TABLE exercises ADD COLUMN is_bodyweight INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  try {
    db.exec('ALTER TABLE workouts ADD COLUMN feel_rating INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  try {
    db.exec('ALTER TABLE workouts ADD COLUMN calories_burned INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  try {
    db.exec('ALTER TABLE exercises ADD COLUMN is_assisted INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  try {
    db.exec('ALTER TABLE sets ADD COLUMN is_warmup INTEGER NOT NULL DEFAULT 0');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  try {
    db.exec('ALTER TABLE workouts ADD COLUMN bw_kg REAL');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  try {
    db.exec('ALTER TABLE program_day_exercises ADD COLUMN rest_seconds INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  try {
    db.exec("ALTER TABLE exercises ADD COLUMN equipment TEXT NOT NULL DEFAULT 'barbell'");
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  try {
    db.exec('ALTER TABLE sets ADD COLUMN rir INTEGER');
  } catch (err) {
    if (!/duplicate column/i.test(err.message)) throw err;
  }

  migrateMultiUser();
  seed();
  recalcAllCalories();
  recalcActivityCalories();
}

// ---------------------------------------------------------------------------
// Multi-user migration. Adds profile_id to every per-user table and rebuilds
// the two tables whose primary/unique key must change. Existing single-user
// rows get profile_id = 0 (the orphan sentinel); the first profile created
// adopts them (see accounts.createProfile). Idempotent — safe on every boot.
// ---------------------------------------------------------------------------
function migrateMultiUser() {
  // 1. Simple ADD COLUMN tables. NOT NULL DEFAULT 0 tags legacy rows as orphans.
  //    `programs` is now per-profile too (each account owns its own templates);
  //    program_days / program_day_exercises stay keyed via their program.
  for (const table of ['workouts', 'sets', 'bodyweights', 'push_subscriptions', 'notes', 'programs']) {
    if (!columnExists(table, 'profile_id')) {
      db.exec(`ALTER TABLE ${table} ADD COLUMN profile_id INTEGER NOT NULL DEFAULT 0`);
    }
    db.exec(
      `CREATE INDEX IF NOT EXISTS idx_${table}_profile ON ${table}(profile_id)`
    );
  }

  // Per-exercise calorie + muscle-detail columns. met drives the calorie
  // estimate; sub_muscle drives finer analytics/recommendations.
  if (!columnExists('exercises', 'met')) {
    db.exec('ALTER TABLE exercises ADD COLUMN met REAL NOT NULL DEFAULT 5');
  }
  if (!columnExists('exercises', 'sub_muscle')) {
    db.exec('ALTER TABLE exercises ADD COLUMN sub_muscle TEXT');
  }
  // secondary_muscles: JSON array of regions a (compound) exercise *also* works.
  // Drives recency only ("last trained" / Train next), never volume.
  if (!columnExists('exercises', 'secondary_muscles')) {
    db.exec('ALTER TABLE exercises ADD COLUMN secondary_muscles TEXT');
  }
  // secondary_major: JSON array, subset of secondary_muscles — the regions
  // that get real mechanical loading (prime-mover level, not just a
  // stabilizer/incidental hit) and therefore count toward that region's
  // parent muscle_group in the 2x/week coverage goal. NULL = not yet
  // classified, meaning "fall back to crediting every secondary region"
  // (the original behavior, and the safe default for a user's own customs
  // that predate this column) — an explicit array (even []) always wins.
  if (!columnExists('exercises', 'secondary_major')) {
    db.exec('ALTER TABLE exercises ADD COLUMN secondary_major TEXT');
  }
  // weight_mode: only meaningful for equipment='dumbbell'. 'per_arm' (default)
  // means the logged weight is one dumbbell, so volume math doubles it;
  // 'combined' means the logged number is already the full load (e.g. a
  // single heavy DB held with both hands), so it isn't doubled.
  if (!columnExists('exercises', 'weight_mode')) {
    db.exec("ALTER TABLE exercises ADD COLUMN weight_mode TEXT NOT NULL DEFAULT 'per_arm'");
  }
  // step_override: optional custom +/- increment in kg, overriding the
  // equipment-class default in stepForExercise (e.g. a machine that jumps
  // 20kg per pin instead of the generic 2.5kg machine default).
  if (!columnExists('exercises', 'step_override')) {
    db.exec('ALTER TABLE exercises ADD COLUMN step_override REAL');
  }

  // rep_min/rep_max: optional per-exercise target rep range ("working range"),
  // set when creating/editing an exercise and shown as an "aim X–Y" hint on
  // the logging card. Distinct from a program slot's target_reps (one number,
  // per day) — this is the exercise's own preferred hypertrophy/strength zone.
  if (!columnExists('exercises', 'rep_min')) {
    db.exec('ALTER TABLE exercises ADD COLUMN rep_min INTEGER');
  }
  if (!columnExists('exercises', 'rep_max')) {
    db.exec('ALTER TABLE exercises ADD COLUMN rep_max INTEGER');
  }

  // instructions: step-by-step how-to text, enriched from the vendored
  // exercise library (see enrichInstructions below) or set at create time by
  // the "search to add" flow. Long-form — deliberately NOT in SELECT_COLS
  // (pickers don't need ~1KB per row); fetched on demand.
  if (!columnExists('exercises', 'instructions')) {
    db.exec('ALTER TABLE exercises ADD COLUMN instructions TEXT');
  }

  // sets.load_multiplier: the per-arm doubling factor SNAPSHOTTED at log time
  // (2 when the exercise was per_arm, else 1). The exercise-level weight_mode
  // alone rewrote history — marking an exercise per-arm retroactively doubled
  // every old set's volume. With the snapshot, flips only affect future sets.
  if (!columnExists('sets', 'load_multiplier')) {
    db.exec('ALTER TABLE sets ADD COLUMN load_multiplier INTEGER');
  }

  // sets.unit_reviewed: set once the user confirms a flagged kg/lbs "mix-up"
  // (GET /api/sets/unit-outliers) is actually correct — excludes it from
  // that check going forward instead of re-flagging it every time.
  if (!columnExists('sets', 'unit_reviewed')) {
    db.exec('ALTER TABLE sets ADD COLUMN unit_reviewed INTEGER NOT NULL DEFAULT 0');
  }

  // sets.form_flag: tapped on a logged set to mean "hit the reps but form
  // broke down" — the set still counts as done, but recommendForNext (see
  // public/workout.js) treats it like a miss so next session repeats the
  // weight instead of progressing it.
  if (!columnExists('sets', 'form_flag')) {
    db.exec('ALTER TABLE sets ADD COLUMN form_flag INTEGER NOT NULL DEFAULT 0');
  }

  // workouts.exercise_list: JSON snapshot of the in-progress workout's exercise
  // list (after swaps/adds/removes/reorders). Mid-workout edits used to live
  // only in a localStorage draft — iOS evicting PWA storage (or opening the
  // workout on another device) rebuilt the list from the program template, so
  // swapped exercises "switched back" and swapped-in ones went missing.
  if (!columnExists('workouts', 'exercise_list')) {
    db.exec('ALTER TABLE workouts ADD COLUMN exercise_list TEXT');
  }

  // bug_reports.type: 'bug_report' (default) or 'idea' — flows through to Orbit.
  if (!columnExists('bug_reports', 'type')) {
    db.exec("ALTER TABLE bug_reports ADD COLUMN type TEXT NOT NULL DEFAULT 'bug_report'");
  }

  // exercises.created_by_profile_id: tracks who added a custom exercise.
  // NULL = seeded/legacy (editable by any profile). Non-null = only that profile
  // can edit or delete it.
  if (!columnExists('exercises', 'created_by_profile_id')) {
    db.exec('ALTER TABLE exercises ADD COLUMN created_by_profile_id INTEGER');
  }

  // programs.sort_order: user-defined ordering of the program list. NULL falls
  // back to id (insertion order).
  if (!columnExists('programs', 'sort_order')) {
    db.exec('ALTER TABLE programs ADD COLUMN sort_order INTEGER');
  }

  // workouts.kind + activity fields: non-strength sessions (a HYROX class, a
  // run, cardio) reuse the workouts table so they count toward consistency and
  // the calorie pipeline for free. kind = 'strength' (default) | 'activity'.
  // An activity has no sets; its detail lives in these columns.
  for (const [col, type] of [
    ['kind', "TEXT NOT NULL DEFAULT 'strength'"],
    ['activity_type', 'TEXT'],
    ['duration_min', 'INTEGER'],
    ['rpe', 'INTEGER'],
    ['distance', 'REAL'],
    ['distance_unit', 'TEXT'],
    ['muscle_tags', 'TEXT'] // JSON array of muscle groups it refreshed
  ]) {
    if (!columnExists('workouts', col)) db.exec(`ALTER TABLE workouts ADD COLUMN ${col} ${type}`);
  }

  // 2. app_settings: primary key must become (profile_id, key). Rebuild.
  if (tableExists('app_settings') && !columnExists('app_settings', 'profile_id')) {
    tx(() => {
      db.exec(`
        CREATE TABLE app_settings_new (
          profile_id INTEGER NOT NULL DEFAULT 0,
          key TEXT NOT NULL,
          value TEXT,
          PRIMARY KEY (profile_id, key)
        );
        INSERT INTO app_settings_new (profile_id, key, value)
          SELECT 0, key, value FROM app_settings;
        DROP TABLE app_settings;
        ALTER TABLE app_settings_new RENAME TO app_settings;
      `);
    });
  }

  // 3. personal_records: unique key must become (profile_id, exercise_id, reps).
  if (tableExists('personal_records') && !columnExists('personal_records', 'profile_id')) {
    tx(() => {
      db.exec(`
        CREATE TABLE personal_records_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          profile_id INTEGER NOT NULL DEFAULT 0,
          exercise_id INTEGER NOT NULL,
          weight REAL NOT NULL,
          weight_unit TEXT NOT NULL DEFAULT 'kg',
          reps INTEGER NOT NULL,
          achieved_at TEXT NOT NULL DEFAULT (datetime('now')),
          FOREIGN KEY (exercise_id) REFERENCES exercises(id) ON DELETE CASCADE,
          UNIQUE(profile_id, exercise_id, reps)
        );
        INSERT INTO personal_records_new (id, profile_id, exercise_id, weight, weight_unit, reps, achieved_at)
          SELECT id, 0, exercise_id, weight, weight_unit, reps, achieved_at FROM personal_records;
        DROP TABLE personal_records;
        ALTER TABLE personal_records_new RENAME TO personal_records;
      `);
    });
  }
  db.exec('CREATE INDEX IF NOT EXISTS idx_personal_records_profile ON personal_records(profile_id)');

  // 4. Move global seed flags out of (now per-profile) app_settings into meta,
  //    so they aren't adopted by the first profile and never re-trigger.
  for (const flag of ['reps_to_8_v1', 'removed_programs_v1']) {
    const row = db
      .prepare('SELECT value FROM app_settings WHERE profile_id = 0 AND key = ?')
      .get(flag);
    if (row && !getMeta(flag)) setMeta(flag, row.value);
    if (row) db.prepare('DELETE FROM app_settings WHERE profile_id = 0 AND key = ?').run(flag);
  }
}

function getMeta(key) {
  return db.prepare('SELECT value FROM meta WHERE key = ?').get(key)?.value ?? null;
}

function setMeta(key, value) {
  db.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
  ).run(key, String(value));
}

// Bodyweight exercises: effective load = bodyweight + added_weight
const BODYWEIGHT_EXERCISES = [
  'Pull-Up', 'Chin-Up', 'Push-Up', 'Chest Dip', 'Tricep Dip',
  'Hanging Leg Raise', 'Toes to Bar',
  'Diamond Push-Up', 'Reverse Nordic Curl',
  // Core / abs — these are always bodyweight only
  'Crunch', 'Bicycle Crunch', 'Sit-Up', 'Plank', 'Side Plank',
  'Dead Bug', 'Mountain Climber', 'Leg Raise',
  'Hollow Body Hold', 'L-Sit'
];

// Assisted machine exercises: effective load = bodyweight − assistance_weight
// (more weight on the stack = less work). Also marked is_bodyweight.
const ASSISTED_EXERCISES = [
  'Assisted Pull-Up',
  'Assisted Chin-Up',
  'Assisted Dip'
];

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

  // Biceps
  ['Barbell Curl', 'biceps', 'Straight or EZ bar'],
  ['Dumbbell Curl', 'biceps', 'Alternating or simultaneous'],
  ['Hammer Curl', 'biceps', 'Neutral grip dumbbell'],
  ['Preacher Curl', 'biceps', 'EZ bar or machine'],
  ['Incline Dumbbell Curl', 'biceps', 'Incline bench'],
  ['Cable Curl', 'biceps', 'Low cable, bar or rope'],
  ['Concentration Curl', 'biceps', 'Seated, dumbbell'],
  ['Spider Curl', 'biceps', 'Lying chest-down on incline'],

  // Triceps
  ['Tricep Pushdown', 'triceps', 'Cable, straight bar'],
  ['Single-Arm Tricep Pushdown', 'triceps', 'One arm on the cable — enter the stack weight per arm'],
  ['Rope Pushdown', 'triceps', 'Cable, rope attachment'],
  ['Overhead Tricep Extension', 'triceps', 'Dumbbell or rope'],
  ['Skull Crusher', 'triceps', 'EZ bar, lying'],
  ['Close-Grip Bench Press', 'triceps', 'Shoulder-width grip'],
  ['Tricep Dip', 'triceps', 'Parallel bars, upright'],
  ['Tricep Kickback', 'triceps', 'Dumbbell, bent over'],
  ['Diamond Push-Up', 'triceps', 'Bodyweight, narrow hands'],
  // Assisted machine versions — logged as counter-weight (more = easier)
  ['Assisted Pull-Up', 'back', 'Machine counter-weight; enter assistance weight'],
  ['Assisted Chin-Up', 'biceps', 'Machine counter-weight; enter assistance weight'],
  ['Assisted Dip', 'chest', 'Machine counter-weight; enter assistance weight'],

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

  // Chest — cable and dumbbell variations
  ['Incline Cable Fly', 'chest', 'Low cable, angled upward — peak stretch at bottom'],
  ['Low-to-High Cable Fly', 'chest', 'Low cable to high, follows lower-pec fibre direction'],

  // Back — isolation and unilateral
  ['Straight-Arm Pulldown', 'back', 'Cable, arms straight — lat isolation without biceps'],
  ['Dumbbell Pullover', 'back', 'Dumbbell over bench, lat/serratus stretch'],
  ['Seal Row', 'back', 'Prone on elevated bench, strict form — no momentum'],
  ['Close-Grip Lat Pulldown', 'back', 'Neutral or V-bar attachment'],
  ['Machine Row', 'back', 'Chest-supported selectorized or plate-loaded'],
  ['Landmine Row', 'back', 'One arm, landmine anchored — high lat, low back sparing'],

  // Shoulders — angles and cables
  ['Landmine Press', 'shoulders', 'Arc from chest to overhead, shoulder-friendly angle'],
  ['Seated Cable Lateral Raise', 'shoulders', 'Low cable, seated — constant tension lateral head'],

  // Biceps — full-range and cable
  ['EZ Bar Curl', 'biceps', 'EZ bar, easier on wrists than straight bar'],
  ['Cable Hammer Curl', 'biceps', 'Rope attachment, neutral grip, constant tension'],
  ['Machine Curl', 'biceps', 'Preacher-style machine, removes body swing'],
  ['Bayesian Curl', 'biceps', 'Behind-the-body cable — peak stretch with resistance'],

  // Triceps — long-head emphasis
  ['Cable Overhead Tricep Extension', 'triceps', 'Rope, high cable — long-head stretch at full extension'],
  ['Machine Tricep Extension', 'triceps', 'Overhead or pushdown machine, constant tension'],

  // Legs — unilateral, posterior chain, machines
  ['Nordic Hamstring Curl', 'legs', 'Eccentric-focused, kneel with feet anchored'],
  ['Hip Abduction Machine', 'legs', 'Outer glute med — machine, controlled squeeze'],
  ['Hip Adduction Machine', 'legs', 'Inner thigh — machine, squeeze at finish'],
  ['Cable Pullthrough', 'legs', 'Hip hinge, rope between legs — glute/hamstring drive'],
  ['Step-Up', 'legs', 'Box or bench — dumbbell, knee-over-toe'],
  ['Reverse Lunge', 'legs', 'Knee-friendly lunge variation, barbell or dumbbells'],
  ['Single-Leg Press', 'legs', 'Unilateral leg press — fixes strength imbalances'],
  ['Glute Kickback', 'legs', 'Cable cuff or machine — pure glute isolation'],
  ['Sissy Squat', 'legs', 'Deep quad stretch, bodyweight or plate held to chest'],

  // Shoulders — health / rotator cuff
  ['Band Pull-Apart', 'shoulders', 'Band, scapular retraction and external rotation — prehab'],
  ['External Rotation', 'shoulders', 'Cable or band, rotator cuff strengthening'],
  ['Y-T-W Raise', 'shoulders', 'Prone or cable — scapular stability and rear delt'],

  // Back — lower back / posterior chain
  ['Hyperextension', 'back', '45-degree bench or GHD — lower back, glutes, hamstrings'],
  ['Reverse Hyperextension', 'back', 'Reverse hyper machine — glutes and spinal decompression'],
  ['Good Morning', 'back', 'Barbell on back, hip hinge — posterior chain and erectors'],

  // Forearms — flexors / extensors / grip
  ['Wrist Curl', 'forearms', 'Barbell or dumbbell, forearm flexors'],
  ['Reverse Curl', 'forearms', 'Overhand barbell — brachialis and forearm extensors'],
  ['Zottman Curl', 'biceps', 'Curl up with supination, lower with pronation — full arm development'],
  ['Farmer Carry', 'forearms', 'Heavy dumbbells or trap bar — grip, stability, full-body tension'],

  // Legs — power / functional / posterior chain
  ['Kettlebell Swing', 'legs', 'Hip hinge power, ballistic glute and hamstring drive'],
  ['Box Squat', 'legs', 'Sit to box, hip-dominant — teaches depth and position'],
  ['Pause Squat', 'legs', '2 s pause at bottom — strength through the hole'],
  ['Smith Machine Squat', 'legs', 'Fixed bar, foot positioning flexibility'],
  ['Reverse Nordic Curl', 'legs', 'Quad-focused eccentric — bodyweight or added weight'],
  ['Cable Kickback', 'legs', 'Cable cuff or machine — pure glute isolation'],
  ['Donkey Calf Raise', 'legs', 'Hip-flexed position, maximum soleus stretch'],

  // Core / Abs
  ['Hanging Leg Raise', 'core', 'From pull-up bar'],
  ['Cable Crunch', 'core', 'Kneeling, rope attachment'],
  ['Ab Wheel Rollout', 'core', 'From knees or toes'],
  ['Plank', 'core', 'Timed hold — log seconds in reps'],
  ['Side Plank', 'core', 'Timed hold each side'],
  ['Russian Twist', 'core', 'Weighted, seated'],
  ['Crunch', 'core', 'Floor, bodyweight'],
  ['Bicycle Crunch', 'core', 'Floor, alternating'],
  ['Sit-Up', 'core', 'Full range floor'],
  ['Dead Bug', 'core', 'Floor, opposite arm/leg'],
  ['Mountain Climber', 'core', 'Plank position, timed'],
  ['Leg Raise', 'core', 'Lying floor or bench'],
  ['Pallof Press', 'core', 'Anti-rotation cable press — obliques and core stability'],
  ['Hollow Body Hold', 'core', 'Supine tuck, arms overhead — log seconds as reps'],
  ['L-Sit', 'core', 'Parallel bars or floor, isometric — log seconds as reps'],
  ['Toes to Bar', 'core', 'From pull-up bar, strict — hip flexors and abs'],
  ['Cable Woodchop', 'core', 'Rotational cable, high-to-low or low-to-high — obliques']
];

// Maps old/legacy muscle_group values → current canonical name. Run on every
// boot so existing user databases pick up the split (arms → biceps/triceps).
const GROUP_MIGRATION_BY_NAME = {
  chest: ['Assisted Dip'],
  biceps: [
    'Barbell Curl', 'Dumbbell Curl', 'Hammer Curl', 'Preacher Curl',
    'Incline Dumbbell Curl', 'Cable Curl', 'Concentration Curl', 'Spider Curl'
  ],
  triceps: [
    'Tricep Pushdown', 'Rope Pushdown', 'Overhead Tricep Extension',
    'Skull Crusher', 'Close-Grip Bench Press', 'Tricep Dip',
    'Tricep Kickback', 'Diamond Push-Up'
  ]
};

function seed() {
  // Additive: add any missing canonical exercises on every startup
  const insertExercise = db.prepare(
    'INSERT OR IGNORE INTO exercises (name, muscle_group, notes) VALUES (?, ?, ?)'
  );
  // created_by_profile_id IS NULL on every migration below that matches by
  // exact name: a user's custom exercise reusing a deleted seed's name (the
  // name is globally unique, so this is the only way to collide) must never
  // get silently reclassified by these — only the shared/seeded row.
  const markBodyweight = db.prepare(
    'UPDATE exercises SET is_bodyweight = 1 WHERE name = ? AND is_bodyweight != 1 AND created_by_profile_id IS NULL'
  );
  const markAssisted = db.prepare(
    'UPDATE exercises SET is_bodyweight = 1, is_assisted = 1 WHERE name = ? AND is_assisted != 1 AND created_by_profile_id IS NULL'
  );
  const updateGroup = db.prepare(
    'UPDATE exercises SET muscle_group = ? WHERE name = ? AND muscle_group != ? AND created_by_profile_id IS NULL'
  );
  tx(() => {
    for (const row of CANONICAL_EXERCISES) insertExercise.run(...row);
    for (const name of BODYWEIGHT_EXERCISES) markBodyweight.run(name);
    for (const name of ASSISTED_EXERCISES) markAssisted.run(name);
    // Migrate legacy `arms` rows into biceps / triceps
    for (const [group, names] of Object.entries(GROUP_MIGRATION_BY_NAME)) {
      for (const name of names) updateGroup.run(group, name, group);
    }
  });

  // Set equipment on exercises still at the default 'barbell' value.
  // Order matters: more specific patterns first; bodyweight/assisted last to
  // override. created_by_profile_id IS NULL guards every clause — a custom
  // exercise reusing a deleted seed's name must not get silently reclassified.
  const equipmentMigrations = [
    `UPDATE exercises SET equipment = 'cable' WHERE equipment = 'barbell' AND created_by_profile_id IS NULL
     AND (name LIKE '%Cable%' OR name LIKE '%Pulldown%' OR name LIKE '%Pushdown%'
          OR name LIKE '%Pullthrough%' OR name LIKE '%Pallof%'
          OR name IN ('Face Pull','Seated Cable Row','Band Pull-Apart','Rope Pushdown',
                      'Seated Cable Lateral Raise','Bayesian Curl','Cable Hammer Curl'))`,
    `UPDATE exercises SET equipment = 'dumbbell' WHERE equipment = 'barbell' AND created_by_profile_id IS NULL
     AND (name LIKE '%Dumbbell%'
          OR name IN ('Lateral Raise','Rear Delt Fly','Arnold Press','Hammer Curl',
                      'Concentration Curl','Overhead Tricep Extension','Tricep Kickback',
                      'Goblet Squat','Farmer Carry','Zottman Curl','Shrug'))`,
    `UPDATE exercises SET equipment = 'machine' WHERE equipment = 'barbell' AND created_by_profile_id IS NULL
     AND (name LIKE '%Machine%' OR name LIKE '%Pec Deck%' OR name LIKE '%Leg Press%'
          OR name LIKE '%Leg Extension%' OR name LIKE '%Leg Curl%' OR name LIKE '%Hack Squat%'
          OR name LIKE '%Hip Abduction%' OR name LIKE '%Hip Adduction%'
          OR name LIKE '%Smith%' OR name IN ('Sissy Squat','Reverse Hyperextension'))`,
    `UPDATE exercises SET equipment = 'bodyweight'
     WHERE is_bodyweight = 1 AND (is_assisted IS NULL OR is_assisted = 0) AND created_by_profile_id IS NULL`,
    `UPDATE exercises SET equipment = 'machine' WHERE is_assisted = 1 AND created_by_profile_id IS NULL`
  ];
  for (const sql of equipmentMigrations) db.exec(sql);

  populateMuscleAndMet();
  populateSecondaryMuscles();
  fixTricepsSecondaryTag();
  populateSecondaryMajor();
  resetNonDumbbellWeightMode();
  markUnilateralSeeds();
  auditWeightModeCatalog();
  backfillLoadMultiplier();
  enrichInstructions();
  mergeLegCurlIntoSeated();
  sweepStaleWorkouts();
  cleanupRemovedPrograms();
  setDefaultRepTargets();
  setDefaultSetsTo2();
  // NOTE: programs are no longer seeded globally here — each profile gets its
  // own copy of the defaults via seedDefaultPrograms() at creation time.
}

// ---------------------------------------------------------------------------
// Sub-muscle + MET assignment. sub_muscle drives finer analytics /
// recommendations; met drives the calorie estimate. Both are filled in
// idempotently: sub_muscle is only set when still NULL, and met only when still
// at the column default (5) — so manual edits are never clobbered.
// ---------------------------------------------------------------------------
const SUB_MUSCLE_BY_NAME = {
  // Chest
  'Bench Press': 'mid chest', 'Incline Bench Press': 'upper chest', 'Decline Bench Press': 'lower chest',
  'Incline Dumbbell Press': 'upper chest', 'Flat Dumbbell Press': 'mid chest', 'Dumbbell Fly': 'mid chest',
  'Cable Fly': 'mid chest', 'Cable Crossover': 'lower chest', 'Machine Chest Press': 'mid chest',
  'Pec Deck': 'mid chest', 'Chest Dip': 'lower chest', 'Push-Up': 'mid chest',
  'Incline Cable Fly': 'upper chest', 'Low-to-High Cable Fly': 'upper chest', 'Assisted Dip': 'lower chest',
  // Back
  'Deadlift': 'lower back', 'Sumo Deadlift': 'lower back', 'Rack Pull': 'traps',
  'Pull-Up': 'lats', 'Chin-Up': 'lats', 'Lat Pulldown': 'lats', 'Wide-Grip Lat Pulldown': 'lats',
  'Barbell Row': 'upper back', 'Pendlay Row': 'upper back', 'One-Arm Dumbbell Row': 'lats',
  'T-Bar Row': 'upper back', 'Seated Cable Row': 'upper back', 'Chest-Supported Row': 'upper back',
  'Face Pull': 'upper back', 'Shrug': 'traps', 'Straight-Arm Pulldown': 'lats',
  'Dumbbell Pullover': 'lats', 'Seal Row': 'upper back', 'Close-Grip Lat Pulldown': 'lats',
  'Machine Row': 'upper back', 'Landmine Row': 'lats', 'Hyperextension': 'lower back',
  'Reverse Hyperextension': 'lower back', 'Good Morning': 'lower back',
  // Shoulders
  'Overhead Press': 'front delt', 'Seated Dumbbell Press': 'front delt', 'Arnold Press': 'front delt',
  'Machine Shoulder Press': 'front delt', 'Lateral Raise': 'side delt', 'Cable Lateral Raise': 'side delt',
  'Rear Delt Fly': 'rear delt', 'Reverse Pec Deck': 'rear delt', 'Upright Row': 'side delt',
  'Landmine Press': 'front delt', 'Seated Cable Lateral Raise': 'side delt', 'Band Pull-Apart': 'rear delt',
  'External Rotation': 'rear delt', 'Y-T-W Raise': 'rear delt',
  // Biceps
  'Barbell Curl': 'biceps', 'Dumbbell Curl': 'biceps', 'Hammer Curl': 'brachialis', 'Preacher Curl': 'short head',
  'Incline Dumbbell Curl': 'long head', 'Cable Curl': 'biceps', 'Concentration Curl': 'short head',
  'Spider Curl': 'short head', 'EZ Bar Curl': 'biceps', 'Cable Hammer Curl': 'brachialis',
  'Machine Curl': 'short head', 'Bayesian Curl': 'long head', 'Zottman Curl': 'brachialis',
  // Triceps — long (overhead/stretch) / lateral (pushdowns/pressing)
  'Tricep Pushdown': 'lateral head', 'Single-Arm Tricep Pushdown': 'lateral head', 'Rope Pushdown': 'lateral head', 'Overhead Tricep Extension': 'long head',
  'Skull Crusher': 'long head', 'Close-Grip Bench Press': 'lateral head', 'Tricep Dip': 'lateral head',
  'Tricep Kickback': 'lateral head', 'Diamond Push-Up': 'lateral head', 'Cable Overhead Tricep Extension': 'long head',
  'Machine Tricep Extension': 'lateral head', 'Assisted Chin-Up': 'biceps', 'Assisted Pull-Up': 'lats',
  // Legs
  'Back Squat': 'quads', 'Front Squat': 'quads', 'Goblet Squat': 'quads', 'Romanian Deadlift': 'hamstrings',
  'Stiff-Leg Deadlift': 'hamstrings', 'Leg Press': 'quads', 'Hack Squat': 'quads',
  'Bulgarian Split Squat': 'quads', 'Walking Lunge': 'quads', 'Leg Extension': 'quads',
  'Lying Leg Curl': 'hamstrings', 'Seated Leg Curl': 'hamstrings', 'Standing Calf Raise': 'calves',
  'Seated Calf Raise': 'calves', 'Hip Thrust': 'glutes', 'Glute Bridge': 'glutes',
  'Nordic Hamstring Curl': 'hamstrings', 'Hip Abduction Machine': 'abductors', 'Hip Adduction Machine': 'adductors',
  'Cable Pullthrough': 'glutes', 'Step-Up': 'quads', 'Reverse Lunge': 'glutes', 'Single-Leg Press': 'quads',
  'Glute Kickback': 'glutes', 'Sissy Squat': 'quads', 'Kettlebell Swing': 'glutes', 'Box Squat': 'quads',
  'Pause Squat': 'quads', 'Smith Machine Squat': 'quads', 'Reverse Nordic Curl': 'quads',
  'Cable Kickback': 'glutes', 'Donkey Calf Raise': 'calves',
  // Core
  'Hanging Leg Raise': 'abs', 'Cable Crunch': 'abs', 'Ab Wheel Rollout': 'abs', 'Plank': 'abs',
  'Side Plank': 'obliques', 'Russian Twist': 'obliques', 'Crunch': 'abs', 'Bicycle Crunch': 'obliques',
  'Sit-Up': 'abs', 'Dead Bug': 'abs', 'Mountain Climber': 'abs', 'Leg Raise': 'abs',
  'Pallof Press': 'obliques', 'Hollow Body Hold': 'abs', 'L-Sit': 'abs', 'Toes to Bar': 'abs',
  'Cable Woodchop': 'obliques',
  // Forearms (Farmer Carry left whole — grip is incidental, not its own region)
  'Wrist Curl': 'wrist flexors', 'Reverse Curl': 'wrist extensors'
};

// Big multi-joint lifts — highest energy cost. Classified by MOVEMENT
// PATTERN, not equipment — a machine that loads the same big compound
// pattern (leg press, machine chest/shoulder press, machine row, an assisted
// pull-up/dip/chin-up at any assistance level) costs about the same as its
// free-weight equivalent, so it belongs here too, not at the MET=5 default.
const MET_HEAVY = new Set([
  'Deadlift', 'Sumo Deadlift', 'Rack Pull', 'Back Squat', 'Front Squat', 'Box Squat', 'Pause Squat',
  'Smith Machine Squat', 'Bench Press', 'Incline Bench Press', 'Decline Bench Press',
  'Overhead Press', 'Barbell Row', 'Pendlay Row', 'T-Bar Row', 'Romanian Deadlift', 'Stiff-Leg Deadlift',
  'Good Morning', 'Hip Thrust', 'Pull-Up', 'Chin-Up', 'Kettlebell Swing', 'Farmer Carry',
  'Leg Press', 'Single-Leg Press', 'Hack Squat', 'Machine Chest Press', 'Machine Row', 'Machine Shoulder Press',
  'Assisted Pull-Up', 'Assisted Chin-Up', 'Assisted Dip'
]);

// Single-joint isolation — lowest energy cost. (Core is handled by group.)
const MET_ISO = new Set([
  'Lateral Raise', 'Cable Lateral Raise', 'Rear Delt Fly', 'Reverse Pec Deck', 'Seated Cable Lateral Raise',
  'Band Pull-Apart', 'External Rotation', 'Y-T-W Raise', 'Face Pull', 'Upright Row', 'Shrug',
  'Dumbbell Fly', 'Cable Fly', 'Cable Crossover', 'Pec Deck', 'Incline Cable Fly', 'Low-to-High Cable Fly',
  'Straight-Arm Pulldown', 'Dumbbell Pullover',
  'Barbell Curl', 'Dumbbell Curl', 'Hammer Curl', 'Preacher Curl', 'Incline Dumbbell Curl', 'Cable Curl',
  'Concentration Curl', 'Spider Curl', 'EZ Bar Curl', 'Cable Hammer Curl', 'Machine Curl', 'Bayesian Curl',
  'Zottman Curl', 'Reverse Curl', 'Wrist Curl',
  'Tricep Pushdown', 'Rope Pushdown', 'Overhead Tricep Extension', 'Skull Crusher', 'Tricep Kickback',
  'Cable Overhead Tricep Extension', 'Machine Tricep Extension',
  'Leg Extension', 'Lying Leg Curl', 'Seated Leg Curl', 'Standing Calf Raise', 'Seated Calf Raise',
  'Donkey Calf Raise', 'Hip Abduction Machine', 'Hip Adduction Machine', 'Glute Kickback', 'Cable Kickback',
  'Glute Bridge', 'Reverse Nordic Curl', 'Nordic Hamstring Curl', 'Sissy Squat', 'Reverse Hyperextension'
]);

function populateMuscleAndMet() {
  // created_by_profile_id IS NULL guards both: a custom exercise reusing a
  // deleted seed's name (globally-unique names make this the only way to
  // collide) must not get silently reclassified.
  const setSub = db.prepare('UPDATE exercises SET sub_muscle = ? WHERE name = ? AND sub_muscle IS NULL AND created_by_profile_id IS NULL');
  const setMet = db.prepare('UPDATE exercises SET met = ? WHERE name = ? AND met = 5 AND created_by_profile_id IS NULL');
  tx(() => {
    for (const [name, sub] of Object.entries(SUB_MUSCLE_BY_NAME)) setSub.run(sub, name);
    for (const name of MET_HEAVY) setMet.run(6.0, name);
    for (const name of MET_ISO) setMet.run(3.7, name);
    // Core work is low-load; set by group for anything still at the default.
    db.prepare("UPDATE exercises SET met = 3.3 WHERE muscle_group = 'core' AND met = 5 AND created_by_profile_id IS NULL").run();

    // One-time: split seeded biceps curls by head (existing DBs already had
    // these as the generic 'biceps'). Gated on Preacher still carrying the old
    // tag so it runs once and never clobbers a later user edit.
    // ponytail: single-exercise guard, fine for seed data.
    if (db.prepare("SELECT 1 FROM exercises WHERE name = 'Preacher Curl' AND sub_muscle = 'biceps'").get()) {
      const heads = {
        'Preacher Curl': 'short head', 'Concentration Curl': 'short head',
        'Spider Curl': 'short head', 'Machine Curl': 'short head',
        'Incline Dumbbell Curl': 'long head', 'Bayesian Curl': 'long head'
      };
      const reSub = db.prepare("UPDATE exercises SET sub_muscle = ? WHERE name = ? AND created_by_profile_id IS NULL");
      for (const [name, sub] of Object.entries(heads)) reSub.run(sub, name);
    }

    // Retire the 'arms' group → 'forearms' for existing DBs (idempotent: no-op
    // once nothing is left in 'arms').
    db.prepare("UPDATE exercises SET muscle_group = 'forearms' WHERE muscle_group = 'arms'").run();

    const reSub = db.prepare("UPDATE exercises SET sub_muscle = ? WHERE name = ? AND created_by_profile_id IS NULL");
    // Split seeded triceps by head (were the generic 'triceps'). Gated like biceps.
    if (db.prepare("SELECT 1 FROM exercises WHERE name = 'Tricep Pushdown' AND sub_muscle = 'triceps'").get()) {
      const tri = {
        'Tricep Pushdown': 'lateral head', 'Rope Pushdown': 'lateral head', 'Close-Grip Bench Press': 'lateral head',
        'Tricep Dip': 'lateral head', 'Tricep Kickback': 'lateral head', 'Diamond Push-Up': 'lateral head',
        'Machine Tricep Extension': 'lateral head', 'Overhead Tricep Extension': 'long head',
        'Cable Overhead Tricep Extension': 'long head', 'Skull Crusher': 'long head'
      };
      for (const [name, sub] of Object.entries(tri)) reSub.run(sub, name);
    }
    // Forearm sub-muscles (were the generic 'forearms'). Gated on Wrist Curl.
    if (db.prepare("SELECT 1 FROM exercises WHERE name = 'Wrist Curl' AND sub_muscle = 'forearms'").get()) {
      reSub.run('wrist flexors', 'Wrist Curl');
      reSub.run('wrist extensors', 'Reverse Curl');
    }
    // Drop sub-muscles since removed from the taxonomy (an earlier deploy may
    // have set them): Farmer Carry's 'grip' and the unused triceps 'medial head'.
    db.prepare("UPDATE exercises SET sub_muscle = NULL WHERE sub_muscle IN ('grip', 'medial head') AND created_by_profile_id IS NULL").run();
  });
}

// ---------------------------------------------------------------------------
// Canonical region -> muscle-group lookup. Region names are unique across the
// taxonomy, so a secondary tag only needs the region name; the group is derived.
// Mirrors SUB_MUSCLES in public/utils.js (frontend) — keep the two in sync.
// ---------------------------------------------------------------------------
const GROUP_SUB_MUSCLES = {
  chest: ['upper chest', 'mid chest', 'lower chest'],
  back: ['lats', 'upper back', 'lower back', 'traps'],
  shoulders: ['front delt', 'side delt', 'rear delt'],
  biceps: ['biceps', 'long head', 'short head', 'brachialis'],
  triceps: ['long head', 'lateral head'],
  forearms: ['wrist flexors', 'wrist extensors'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves', 'abductors', 'adductors'],
  core: ['abs', 'obliques']
};
const REGION_TO_GROUP = {};
for (const [g, subs] of Object.entries(GROUP_SUB_MUSCLES)) {
  for (const s of subs) REGION_TO_GROUP[s] = g;
}
// Canonical muscle groups — the only valid `exercises.muscle_group` values.
// The UI's group dropdown mirrors this list (SUB_MUSCLES in public/utils.js);
// exported so the API write paths can reject anything else, keeping charts,
// pickers, and the Muscle Detail view free of rogue groups.
const MUSCLE_GROUPS = Object.keys(GROUP_SUB_MUSCLES);

// Secondary muscles for the seeded compound lifts. Primary stays in
// SUB_MUSCLE_BY_NAME (it gets the volume); these only feed recency. Applied
// once (meta-flag guarded) so user edits are never clobbered.
const SECONDARY_BY_NAME = {
  // Chest presses -> front delt + triceps. 'lateral head' (not the invalid
  // bare 'triceps') — the triceps group's own taxonomy only has long/lateral
  // head, no generic catch-all (unlike biceps' 'biceps' bucket).
  'Bench Press': ['front delt', 'lateral head'], 'Incline Bench Press': ['front delt', 'lateral head'],
  'Decline Bench Press': ['front delt', 'lateral head'], 'Incline Dumbbell Press': ['front delt', 'lateral head'],
  'Flat Dumbbell Press': ['front delt', 'lateral head'], 'Machine Chest Press': ['front delt', 'lateral head'],
  'Chest Dip': ['front delt', 'lateral head'], 'Assisted Dip': ['front delt', 'lateral head'],
  'Push-Up': ['front delt', 'lateral head'], 'Close-Grip Bench Press': ['mid chest', 'front delt'],
  'Diamond Push-Up': ['mid chest', 'front delt'], 'Tricep Dip': ['lower chest', 'front delt'],
  // Back pulls
  'Deadlift': ['glutes', 'hamstrings', 'traps', 'upper back'],
  'Sumo Deadlift': ['glutes', 'hamstrings', 'quads', 'traps'],
  'Rack Pull': ['lower back', 'glutes', 'lats'],
  'Pull-Up': ['biceps', 'upper back', 'rear delt'], 'Chin-Up': ['biceps', 'upper back'],
  'Assisted Pull-Up': ['biceps', 'upper back'], 'Assisted Chin-Up': ['lats', 'upper back'],
  'Lat Pulldown': ['biceps', 'upper back'], 'Wide-Grip Lat Pulldown': ['biceps', 'upper back'],
  'Close-Grip Lat Pulldown': ['biceps', 'upper back'],
  'Barbell Row': ['lats', 'biceps', 'rear delt'], 'Pendlay Row': ['lats', 'biceps', 'rear delt'],
  'T-Bar Row': ['lats', 'biceps', 'rear delt'], 'Seated Cable Row': ['lats', 'biceps', 'rear delt'],
  'Chest-Supported Row': ['lats', 'biceps', 'rear delt'], 'One-Arm Dumbbell Row': ['upper back', 'biceps'],
  'Machine Row': ['lats', 'biceps'], 'Landmine Row': ['upper back', 'biceps'], 'Seal Row': ['lats', 'biceps'],
  'Good Morning': ['hamstrings', 'glutes'], 'Hyperextension': ['glutes', 'hamstrings'],
  'Face Pull': ['rear delt'],
  // Shoulder presses -> side delt + triceps
  'Overhead Press': ['side delt', 'lateral head'], 'Seated Dumbbell Press': ['side delt', 'lateral head'],
  'Arnold Press': ['side delt', 'lateral head'], 'Machine Shoulder Press': ['side delt', 'lateral head'],
  'Landmine Press': ['side delt', 'lateral head', 'upper chest'], 'Upright Row': ['traps', 'front delt'],
  'Y-T-W Raise': ['upper back'],
  // Legs
  'Back Squat': ['glutes', 'hamstrings', 'lower back'], 'Front Squat': ['glutes', 'upper back'],
  'Box Squat': ['glutes', 'hamstrings'], 'Pause Squat': ['glutes', 'hamstrings'],
  'Smith Machine Squat': ['glutes', 'hamstrings'], 'Goblet Squat': ['glutes'], 'Hack Squat': ['glutes'],
  'Leg Press': ['glutes', 'hamstrings'], 'Single-Leg Press': ['glutes', 'hamstrings'],
  'Romanian Deadlift': ['glutes', 'lower back'], 'Stiff-Leg Deadlift': ['glutes', 'lower back'],
  'Bulgarian Split Squat': ['glutes', 'hamstrings'], 'Walking Lunge': ['glutes', 'hamstrings'],
  'Reverse Lunge': ['quads', 'hamstrings'], 'Step-Up': ['glutes', 'hamstrings'],
  'Hip Thrust': ['hamstrings'], 'Cable Pullthrough': ['hamstrings'],
  'Kettlebell Swing': ['hamstrings', 'lower back'], 'Nordic Hamstring Curl': ['glutes'],
  // Core / carries
  'Hanging Leg Raise': ['obliques'], 'Toes to Bar': ['obliques'], 'Ab Wheel Rollout': ['obliques'],
  'Mountain Climber': ['obliques'], 'Farmer Carry': ['traps']
};

// Apply the seed secondaries once. Idempotent via meta flag + the IS NULL guard
// so re-deploys and later user edits are preserved.
function populateSecondaryMuscles() {
  const FLAG = 'seed_secondary_v1';
  if (getMeta(FLAG)) return;
  const upd = db.prepare(
    'UPDATE exercises SET secondary_muscles = ? WHERE name = ? AND secondary_muscles IS NULL'
  );
  tx(() => {
    for (const [name, regions] of Object.entries(SECONDARY_BY_NAME)) {
      const clean = regions.filter((r) => REGION_TO_GROUP[r]);
      if (clean.length) upd.run(JSON.stringify(clean), name);
    }
    setMeta(FLAG, '1');
  });
}

// One-time repair: seed_secondary_v1 (above) shipped SECONDARY_BY_NAME with a
// bare 'triceps' string, which isn't a valid sub-muscle region (the triceps
// group's taxonomy only has 'long head'/'lateral head', no generic bucket) —
// REGION_TO_GROUP[r] silently filtered it out of every chest/shoulder press's
// secondary_muscles. Already-deployed rows never got the tag at all, so this
// re-adds it (as 'lateral head') without disturbing any other tag a user may
// have added since. New installs get it right from SECONDARY_BY_NAME already.
function fixTricepsSecondaryTag() {
  const FLAG = 'fix_triceps_secondary_v1';
  if (getMeta(FLAG)) return;
  const affected = [
    'Bench Press', 'Incline Bench Press', 'Decline Bench Press', 'Incline Dumbbell Press',
    'Flat Dumbbell Press', 'Machine Chest Press', 'Chest Dip', 'Assisted Dip', 'Push-Up',
    'Overhead Press', 'Seated Dumbbell Press', 'Arnold Press', 'Machine Shoulder Press', 'Landmine Press'
  ];
  const rows = db.prepare(
    `SELECT id, secondary_muscles FROM exercises
     WHERE name IN (${affected.map(() => '?').join(',')}) AND created_by_profile_id IS NULL`
  ).all(...affected);
  const upd = db.prepare('UPDATE exercises SET secondary_muscles = ? WHERE id = ?');
  tx(() => {
    for (const row of rows) {
      let regions = [];
      try { regions = row.secondary_muscles ? JSON.parse(row.secondary_muscles) : []; } catch { regions = []; }
      if (!Array.isArray(regions)) regions = [];
      if (!regions.includes('lateral head')) regions.push('lateral head');
      upd.run(JSON.stringify(regions), row.id);
    }
    setMeta(FLAG, '1');
  });
}

// Which of SECONDARY_BY_NAME's regions get real mechanical loading (the
// exercise is genuinely a prime-mover-level hit on that region, not just a
// stabilizer or incidental assist) — these are the only secondary regions
// that count toward the parent muscle_group's 2x/week coverage credit
// (routes/progress.js /muscle-coverage). Anything in SECONDARY_BY_NAME but
// absent here still shows as an "also works" tag and still feeds recency —
// it just doesn't earn a coverage tick for that group.
//
// Rule of thumb applied: a heavy hip-hinge/loaded-carry crossing into a
// different group (deadlift's hamstrings/glutes, farmer carry's traps) is
// major. Everything else that crosses groups — arm assist on presses/pulls,
// deltoid/back stabilization, isometric bracing during squats/hinges — is
// sub-threshold vs. a dedicated session and stays minor (tag-only). Only
// cross-group regions matter here; same-group ones (e.g. a squat's glutes,
// already under `legs`) are a no-op for coverage either way.
const SECONDARY_MAJOR_BY_NAME = {
  'Deadlift': ['glutes', 'hamstrings'],
  'Sumo Deadlift': ['glutes', 'hamstrings', 'quads'],
  'Rack Pull': ['glutes'],
  'Good Morning': ['hamstrings', 'glutes'],
  'Farmer Carry': ['traps']
};

// Apply the major/minor secondary split once. Any seeded exercise with
// secondary_muscles but no entry above gets an explicit '[]' (not left NULL)
// so it's clear it was deliberately classified as tag-only, not merely
// unvisited — re-deploys and later user edits are preserved either way.
function populateSecondaryMajor() {
  const FLAG = 'seed_secondary_major_v1';
  if (getMeta(FLAG)) return;
  const setExplicit = db.prepare(
    'UPDATE exercises SET secondary_major = ? WHERE name = ? AND secondary_major IS NULL AND created_by_profile_id IS NULL'
  );
  tx(() => {
    for (const [name, regions] of Object.entries(SECONDARY_MAJOR_BY_NAME)) {
      const clean = regions.filter((r) => REGION_TO_GROUP[r]);
      setExplicit.run(JSON.stringify(clean), name);
    }
    db.prepare(
      `UPDATE exercises SET secondary_major = '[]'
       WHERE secondary_major IS NULL AND secondary_muscles IS NOT NULL AND created_by_profile_id IS NULL`
    ).run();
    setMeta(FLAG, '1');
  });
}

// Recompute calories_burned for every finished workout that has a bodyweight
// snapshot, using the per-exercise active-time model. One-time fixup so old
// sessions (estimated with the inflated MET-on-total-duration model) display
// realistic numbers. Guarded by a meta flag.
function recalcAllCalories() {
  const FLAG = 'recalc_calories_v2';
  if (getMeta(FLAG)) return;
  const { caloriesFromSets } = require('./calories');
  // kind guard is defensive, not currently load-bearing (this flag has
  // already fired in production so the function is dormant) — but activity
  // workouts have no sets, and caloriesFromSets([], bwKg) returns 0, so if
  // this ever re-runs (flag reset for troubleshooting, a future copy-paste of
  // the pattern) it must not zero out every activity's calorie estimate.
  const workouts = db
    .prepare("SELECT id, bw_kg FROM workouts WHERE finished_at IS NOT NULL AND bw_kg IS NOT NULL AND (kind IS NULL OR kind != 'activity')")
    .all();
  const setStmt = db.prepare(
    'SELECT s.reps, s.is_warmup, e.met FROM sets s JOIN exercises e ON e.id = s.exercise_id WHERE s.workout_id = ?'
  );
  const upd = db.prepare('UPDATE workouts SET calories_burned = ? WHERE id = ?');
  tx(() => {
    for (const w of workouts) {
      const cal = caloriesFromSets(setStmt.all(w.id), w.bw_kg);
      if (cal != null) upd.run(cal, w.id);
    }
    setMeta(FLAG, '1');
  });
}

// One-time: recompute calories_burned for existing activity-kind workouts
// that have a real distance logged, using the pace-based model (activityCalories
// with distance/distance_unit) instead of the fixed-MET/RPE guess they were
// originally saved under. Entries with no distance are left alone — recomputing
// them under the unchanged fixed-MET path would just reproduce the same number.
function recalcActivityCalories() {
  const FLAG = 'recalc_activity_calories_pace_v1';
  if (getMeta(FLAG)) return;
  const { activityCalories } = require('./calories');
  const rows = db
    .prepare(
      `SELECT id, activity_type, duration_min, rpe, bw_kg, distance, distance_unit
       FROM workouts
       WHERE kind = 'activity' AND finished_at IS NOT NULL AND bw_kg IS NOT NULL AND distance IS NOT NULL`
    )
    .all();
  const upd = db.prepare('UPDATE workouts SET calories_burned = ? WHERE id = ?');
  tx(() => {
    for (const w of rows) {
      const cal = activityCalories(w.activity_type, w.duration_min, w.rpe, w.bw_kg, w.distance, w.distance_unit);
      if (cal != null) upd.run(cal, w.id);
    }
    setMeta(FLAG, '1');
  });
}

// Fold the `loserId` exercise into `survivorId`: all logged sets, program-day
// slots, and any customization the survivor lacks move over, PRs are rebuilt
// from the merged sets, and the loser row is deleted. Shared by the one-time
// leg-curl migration and the in-app "Merge into…" action so both behave
// identically. Returns { merged, movedSets } (merged:false when the ids are
// missing/identical). Caller is responsible for authorization.
function mergeExercises(loserId, survivorId) {
  if (loserId === survivorId) return { merged: false };
  const loser = db.prepare('SELECT * FROM exercises WHERE id = ?').get(loserId);
  const survivor = db.prepare('SELECT * FROM exercises WHERE id = ?').get(survivorId);
  if (!loser || !survivor) return { merged: false };

  // recomputePrsForExercise wraps its own tx() (not reentrant), so it must run
  // AFTER this transaction commits, not inside it.
  let profilesToRecompute = [];
  let movedSets = 0;
  tx(() => {
    // Carry over customization the survivor doesn't already have — a blank
    // rep range/instructions/step/notes on the keeper shouldn't silently
    // discard something the user set on the exercise being removed.
    const fields = ['rep_min', 'rep_max', 'instructions', 'step_override', 'notes'];
    const fill = fields.filter((f) => survivor[f] == null && loser[f] != null);
    if (fill.length) {
      db.prepare(`UPDATE exercises SET ${fill.map((f) => `${f} = ?`).join(', ')} WHERE id = ?`)
        .run(...fill.map((f) => loser[f]), survivor.id);
    }

    movedSets = db.prepare('UPDATE sets SET exercise_id = ? WHERE exercise_id = ?').run(survivor.id, loser.id).changes;

    // A program day can't hold both (unique program_day_id+exercise_id) — drop
    // the loser slot where the day already has the survivor, otherwise repoint.
    const loserSlots = db.prepare('SELECT id, program_day_id FROM program_day_exercises WHERE exercise_id = ?').all(loser.id);
    for (const slot of loserSlots) {
      const clash = db.prepare('SELECT 1 FROM program_day_exercises WHERE program_day_id = ? AND exercise_id = ?').get(slot.program_day_id, survivor.id);
      if (clash) db.prepare('DELETE FROM program_day_exercises WHERE id = ?').run(slot.id);
      else db.prepare('UPDATE program_day_exercises SET exercise_id = ? WHERE id = ?').run(survivor.id, slot.id);
    }

    // Clear PRs for both — rebuilt fresh below rather than reconciling two
    // existing rows per rep count (personal_records is UNIQUE per
    // profile+exercise+reps, so a naive reassign could collide anyway).
    db.prepare('DELETE FROM personal_records WHERE exercise_id IN (?, ?)').run(loser.id, survivor.id);
    profilesToRecompute = db.prepare('SELECT DISTINCT profile_id FROM sets WHERE exercise_id = ?').all(survivor.id).map((r) => r.profile_id);

    db.prepare('DELETE FROM exercises WHERE id = ?').run(loser.id);
  });

  const { recomputePrsForExercise } = require('./pr'); // lazy: pr.js requires db.js at its top
  for (const profileId of profilesToRecompute) recomputePrsForExercise(profileId, survivor.id);
  return { merged: true, movedSets };
}

// Move a subset of one exercise's logged sets (those in `workoutIds`, scoped to
// `profileId`) onto `targetId`. Used to un-mix an exercise that was logged
// across different equipment/loading under one name — e.g. a "Wrist Curl" done
// barbell (total) one day and dumbbell (per-arm) another: move the barbell
// session onto a separate "Barbell Wrist Curl" so each tracks cleanly. The
// moved sets' load_multiplier is reset to the TARGET's weight_mode (per_arm=2
// else 1), since their old snapshot came from the source's single mode and is
// likely wrong for the target. PRs for both exercises are rebuilt.
function moveExerciseSessions(sourceId, targetId, workoutIds, profileId) {
  if (sourceId === targetId || !Array.isArray(workoutIds) || !workoutIds.length) return { moved: 0 };
  const target = db.prepare('SELECT id, weight_mode FROM exercises WHERE id = ?').get(targetId);
  const source = db.prepare('SELECT id FROM exercises WHERE id = ?').get(sourceId);
  if (!target || !source) return { moved: 0 };
  const mult = target.weight_mode === 'per_arm' ? 2 : 1;
  const ph = workoutIds.map(() => '?').join(',');

  let moved = 0;
  tx(() => {
    moved = db.prepare(
      `UPDATE sets SET exercise_id = ?, load_multiplier = ?
       WHERE exercise_id = ? AND profile_id = ? AND workout_id IN (${ph})`
    ).run(targetId, mult, sourceId, profileId, ...workoutIds).changes;
    db.prepare('DELETE FROM personal_records WHERE profile_id = ? AND exercise_id IN (?, ?)').run(profileId, sourceId, targetId);
  });

  const { recomputePrsForExercise } = require('./pr');
  recomputePrsForExercise(profileId, sourceId);
  recomputePrsForExercise(profileId, targetId);
  return { moved };
}

// One-time, user-requested: "Leg Curl" and "Seated Leg Curl" were logged as
// separate exercises but the user wants them treated as one. Seated Leg Curl
// survives. Now that there's an in-app merge, this is just the automatic path
// for the specific pair; no-op if either name is missing (already merged, or
// a fresh DB that never had a plain "Leg Curl").
function mergeLegCurlIntoSeated() {
  // v2: match on a trimmed, case-insensitive EXACT name so a stray space or
  // casing ("Leg Curl ", "leg curl") still merges — but "Lying Leg Curl" is a
  // distinct exercise and must NOT be swept in, so this stays an exact match,
  // not a LIKE. Flag bumped from v1 so it retries once for any DB where the
  // stricter v1 already no-op'd on a near-miss name.
  const FLAG = 'merge_leg_curl_into_seated_v2';
  if (getMeta(FLAG)) return;
  const byNorm = (n) => db.prepare("SELECT id FROM exercises WHERE TRIM(LOWER(name)) = ?").get(n);
  const loser = byNorm('leg curl');
  const survivor = byNorm('seated leg curl');
  if (loser && survivor) mergeExercises(loser.id, survivor.id);
  setMeta(FLAG, '1');
}

// One-time: backfill load_multiplier for sets logged before the snapshot
// existed, using the ORIGINAL volume rule (only dumbbell per-arm exercises
// ever doubled back then) — NOT the current weight_mode, which would re-double
// history for exercises later marked per-arm (the exact complaint: a custom
// single-arm pushdown's old sets suddenly counted 2x). Old sets keep the
// meaning they had when logged; only sets logged from now on snapshot the
// live mode.
function backfillLoadMultiplier() {
  const FLAG = 'load_multiplier_backfill_v1';
  if (getMeta(FLAG)) return;
  tx(() => {
    db.prepare(`
      UPDATE sets SET load_multiplier = (
        SELECT CASE WHEN e.equipment = 'dumbbell' AND e.weight_mode != 'combined' THEN 2 ELSE 1 END
        FROM exercises e WHERE e.id = sets.exercise_id
      )
      WHERE load_multiplier IS NULL
    `).run();
    setMeta(FLAG, '1');
  });
}

// Every-boot sweep: close out abandoned in-progress strength workouts. A
// workout left unfinished (phone died, user forgot, app reinstalled) used to
// linger forever; the /active recovery endpoint would then resurrect it with
// a multi-week timer. Anything with no activity for 24h gets finished at its
// last set + 10 minutes (same cap rule as a normal finish) so the training
// data lands in History with a sane duration — or deleted if nothing was
// ever logged. Runs on every boot; a no-op when there's nothing stale.
function sweepStaleWorkouts() {
  const stale = db.prepare(
    `SELECT w.id, w.started_at, MAX(s.logged_at) AS last_set, COUNT(s.id) AS n
     FROM workouts w LEFT JOIN sets s ON s.workout_id = w.id
     WHERE w.finished_at IS NULL AND (w.kind IS NULL OR w.kind != 'activity')
     GROUP BY w.id
     HAVING COALESCE(MAX(s.logged_at), w.started_at) < datetime('now', '-24 hours')`
  ).all();
  if (!stale.length) return;
  const close = db.prepare("UPDATE workouts SET finished_at = datetime(?, '+10 minutes') WHERE id = ?");
  const drop = db.prepare('DELETE FROM workouts WHERE id = ?');
  tx(() => {
    for (const w of stale) {
      if (w.n > 0) close.run(w.last_set, w.id);
      else drop.run(w.id);
    }
  });
  console.log(`stale workout sweep: closed ${stale.filter((w) => w.n > 0).length}, deleted ${stale.filter((w) => !w.n).length}`);
}

// One-time: weight_mode used to be dumbbell-only (the column defaulted every
// row to 'per_arm' but the volume SQL ignored it for other equipment). Now
// that effectiveLoadKgSql honors 'per_arm' on ANY equipment (single-arm cable
// pushdowns, single-leg press...), non-dumbbell rows must be reset to
// 'combined' or their historical volume would silently double. Flag-guarded so
// a user marking a cable exercise per-arm later isn't clobbered on reboot.
function resetNonDumbbellWeightMode() {
  const FLAG = 'weight_mode_equipment_agnostic_v1';
  if (getMeta(FLAG)) return;
  tx(() => {
    db.prepare("UPDATE exercises SET weight_mode = 'combined' WHERE equipment != 'dumbbell'").run();
    setMeta(FLAG, '1');
  });
}

// One-time: seeded exercises that are unilateral by name (the load belongs to
// one arm/side) get weight_mode='per_arm' even though they're not dumbbells.
// Runs AFTER resetNonDumbbellWeightMode (which would flatten them to
// 'combined' on a fresh DB) and is flag-guarded so later user edits stick.
const UNILATERAL_SEED_NAMES = ['Single-Arm Tricep Pushdown'];

function markUnilateralSeeds() {
  const FLAG = 'unilateral_seeds_v1';
  if (getMeta(FLAG)) return;
  const mark = db.prepare("UPDATE exercises SET weight_mode = 'per_arm' WHERE name = ?");
  tx(() => {
    for (const name of UNILATERAL_SEED_NAMES) mark.run(name);
    setMeta(FLAG, '1');
  });
}

// One-time full-catalog weight-mode audit (user-confirmed classification).
// Two corrections on top of the equipment defaults:
//  • two-hands-on-one-dumbbell moves were being doubled — they're 'combined';
//  • unilateral cable/machine moves (one side works the stack) weren't — per_arm.
// Overhead Tricep Extension deliberately ABSENT from the two-handed list: the
// user does it one arm at a time, so its dumbbell per_arm default is right.
// Custom exercises are covered by the name pattern below. Flag-guarded so a
// user flipping a badge afterwards is never clobbered on reboot.
const TWO_HANDED_SINGLE_IMPLEMENT = ['Goblet Squat', 'Dumbbell Pullover'];
const UNILATERAL_CATALOG = [
  'Single-Leg Press', 'Cable Lateral Raise', 'Seated Cable Lateral Raise',
  'Cable Kickback', 'Glute Kickback', 'Bayesian Curl', 'External Rotation'
];

function auditWeightModeCatalog() {
  const FLAG = 'weight_mode_catalog_audit_v1';
  if (getMeta(FLAG)) return;
  const setCombined = db.prepare("UPDATE exercises SET weight_mode = 'combined' WHERE name = ?");
  const setPerArm = db.prepare("UPDATE exercises SET weight_mode = 'per_arm' WHERE name = ?");
  tx(() => {
    for (const name of TWO_HANDED_SINGLE_IMPLEMENT) setCombined.run(name);
    for (const name of UNILATERAL_CATALOG) setPerArm.run(name);
    // Custom exercises whose names announce they're unilateral.
    db.prepare(`UPDATE exercises SET weight_mode = 'per_arm' WHERE
      lower(name) LIKE '%single%arm%' OR lower(name) LIKE '%single%leg%' OR
      lower(name) LIKE '%one%arm%' OR lower(name) LIKE '%one%leg%' OR
      lower(name) LIKE '%unilateral%'`).run();
    setMeta(FLAG, '1');
  });
}

// One-time: attach step-by-step instructions from the vendored exercise
// library to every exercise that matches by name (seeded AND custom). Only
// fills rows whose instructions are NULL — never overwrites — and is
// flag-guarded so it doesn't rescan on every boot. Unmatched names simply
// stay without instructions.
function enrichInstructions() {
  const FLAG = 'exercise_instructions_v1';
  if (getMeta(FLAG)) return;
  const { instructionsFor } = require('./lib/exerciseLibrary');
  const rows = db.prepare('SELECT id, name, equipment FROM exercises WHERE instructions IS NULL').all();
  const set = db.prepare('UPDATE exercises SET instructions = ? WHERE id = ?');
  let filled = 0;
  tx(() => {
    for (const r of rows) {
      const text = instructionsFor(r.name, r.equipment);
      if (text) { set.run(text.slice(0, 6000), r.id); filled++; }
    }
    setMeta(FLAG, '1');
  });
  if (filled) console.log(`exercise instructions: enriched ${filled}/${rows.length} from library`);
}

// One-time: set every program exercise's rep target to 8 to match the user's
// 6–8 progressive-overload focus. Guarded so it runs once and respects any
// later manual edits (and lets new programs use whatever reps you train).
function setDefaultRepTargets() {
  const FLAG = 'reps_to_8_v1';
  if (getMeta(FLAG)) return;
  tx(() => {
    db.prepare('UPDATE program_day_exercises SET target_reps = 8').run();
    setMeta(FLAG, '1');
  });
}

// One-time (user-requested): baseline every program-day slot to 2 sets — the
// user runs 2 working sets on most lifts and wanted them all reset at once,
// then bumps the few that need 3+ by hand. Reps are deliberately left alone
// (they vary per lift: 5/8/10/12). New slots also default to 2 sets now.
function setDefaultSetsTo2() {
  const FLAG = 'sets_to_2_v1';
  if (getMeta(FLAG)) return;
  tx(() => {
    db.prepare('UPDATE program_day_exercises SET target_sets = 2').run();
    setMeta(FLAG, '1');
  });
}

// One-time removal of seed programs the user asked to drop. Guarded by a flag
// so it runs once per DB and won't fight a program the user later recreates
// with the same name. Deleting a program cascades to its days/exercises;
// workouts keep their history (program_day_id is set to NULL on cascade).
const REMOVED_PROGRAM_NAMES = ['Bro Split', 'Starting Strength', 'Minimalist Hypertrophy'];

function cleanupRemovedPrograms() {
  const FLAG = 'removed_programs_v1';
  if (getMeta(FLAG)) return;
  const del = db.prepare('DELETE FROM programs WHERE name = ?');
  tx(() => {
    for (const name of REMOVED_PROGRAM_NAMES) del.run(name);
    setMeta(FLAG, '1');
  });
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
    name: 'Full Body 3×',
    description: '3-day full-body · hits every pattern each session · 2–3 sets · progressive overload',
    days: [
      {
        label: 'Session A',
        exercises: [
          ['Bench Press',         3, 8,  120],
          ['Barbell Row',         3, 8,  120],
          ['Back Squat',          3, 8,  150],
          ['Overhead Press',      2, 10, 90],
          ['Lateral Raise',       2, 12, 60]
        ]
      },
      {
        label: 'Session B',
        exercises: [
          ['Incline Dumbbell Press', 3, 10, 90],
          ['Pull-Up',               3, 8,  120],
          ['Romanian Deadlift',     3, 10, 120],
          ['Barbell Curl',          2, 10, 60],
          ['Rope Pushdown',         2, 12, 60]
        ]
      },
      {
        label: 'Session C',
        exercises: [
          ['Flat Dumbbell Press',  2, 10, 90],
          ['Seated Cable Row',     3, 10, 90],
          ['Bulgarian Split Squat',2, 10, 120],
          ['Hip Thrust',           2, 12, 90],
          ['Standing Calf Raise',  2, 15, 60]
        ]
      }
    ]
  },

  {
    name: 'Minimal Effective Dose',
    description: '2-day full-body · 2 sets per lift · compounds only · maximum results, minimum time',
    days: [
      {
        label: 'Session A',
        exercises: [
          ['Bench Press',       2, 8,  120],
          ['Barbell Row',       2, 8,  120],
          ['Back Squat',        2, 8,  150],
          ['Overhead Press',    2, 10, 90],
          ['Romanian Deadlift', 2, 10, 120]
        ]
      },
      {
        label: 'Session B',
        exercises: [
          ['Deadlift',              2, 5,  180],
          ['Pull-Up',               2, 8,  120],
          ['Hip Thrust',            2, 10, 120],
          ['Incline Dumbbell Press',2, 10, 90],
          ['Seated Cable Row',      2, 10, 90]
        ]
      }
    ]
  }
];

// Seed the default recommended programs into ONE profile's library. Called
// when a profile is created (unless it adopted legacy single-user programs).
// Skips any program the profile already has by name, so it's safe to re-run.
// Runs in the caller's transaction (accounts.createProfile already wraps the
// whole creation in one), so it does not open its own.
function seedDefaultPrograms(profileId) {
  const findProgram = db.prepare('SELECT id FROM programs WHERE profile_id = ? AND name = ?');
  const insertProgram = db.prepare('INSERT INTO programs (profile_id, name, description) VALUES (?, ?, ?)');
  const insertDay = db.prepare(
    'INSERT INTO program_days (program_id, day_label, day_order) VALUES (?, ?, ?)'
  );
  const insertDayEx = db.prepare(
    'INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index, rest_seconds) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const findEx = db.prepare('SELECT id FROM exercises WHERE name = ?');

  for (const program of CANONICAL_PROGRAMS) {
    if (findProgram.get(profileId, program.name)) continue;
    const programId = Number(
      insertProgram.run(profileId, program.name, program.description).lastInsertRowid
    );
    program.days.forEach((day, dayIdx) => {
      const dayId = Number(
        insertDay.run(programId, day.label, dayIdx + 1).lastInsertRowid
      );
      day.exercises.forEach(([name, sets, reps, rest = null], i) => {
        const ex = findEx.get(name);
        if (ex) insertDayEx.run(dayId, ex.id, sets, reps, i, rest);
      });
    });
  }
}

module.exports = {
  db, init, tx, getMeta, setMeta, tableExists, columnExists, seedDefaultPrograms, REGION_TO_GROUP,
  MUSCLE_GROUPS, effectiveLoadKgSql, effectiveVolumeLoadKgSql, mergeExercises, moveExerciseSessions
};
