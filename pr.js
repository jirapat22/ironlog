const { db, tx } = require('./db');

// Rebuild the personal_records rows for a single exercise (scoped to one
// profile) from the sets table. Called after any mutation that could
// invalidate the cached best-by-rep-count (set delete, set edit, workout
// delete).
function recomputePrsForExercise(profileId, exerciseId) {
  // Warmups never count toward a PR (routes/sets.js skips them at insert
  // time) — this rebuild must exclude them too, or editing/deleting ANY set
  // for the exercise resurrects a warmup as a "best" for its rep count.
  const repRows = db
    .prepare('SELECT DISTINCT reps FROM sets WHERE profile_id = ? AND exercise_id = ? AND is_warmup = 0')
    .all(profileId, exerciseId);

  // Assisted exercises log ASSISTANCE (more = easier), so "best" is the
  // LOWEST weight at that rep count — the inverse of every other exercise.
  const ex = db.prepare('SELECT is_assisted FROM exercises WHERE id = ?').get(exerciseId);
  const dir = ex?.is_assisted ? 'ASC' : 'DESC';

  const best = db.prepare(`
    SELECT weight, weight_unit, logged_at
    FROM sets
    WHERE profile_id = ? AND exercise_id = ? AND reps = ? AND is_warmup = 0
    ORDER BY (CASE WHEN weight_unit = 'lbs' THEN weight * 0.45359237 ELSE weight END) ${dir},
             logged_at ASC
    LIMIT 1
  `);

  const del = db.prepare('DELETE FROM personal_records WHERE profile_id = ? AND exercise_id = ?');
  const ins = db.prepare(`
    INSERT INTO personal_records (profile_id, exercise_id, weight, weight_unit, reps, achieved_at)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  tx(() => {
    del.run(profileId, exerciseId);
    for (const { reps } of repRows) {
      const b = best.get(profileId, exerciseId, reps);
      if (b) ins.run(profileId, exerciseId, b.weight, b.weight_unit, reps, b.logged_at);
    }
  });
}

module.exports = { recomputePrsForExercise };
