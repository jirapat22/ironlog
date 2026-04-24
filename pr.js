const { db, tx } = require('./db');

// Rebuild the personal_records rows for a single exercise from the sets
// table. Called after any mutation that could invalidate the cached
// best-by-rep-count (set delete, set edit, workout delete).
function recomputePrsForExercise(exerciseId) {
  const repRows = db
    .prepare('SELECT DISTINCT reps FROM sets WHERE exercise_id = ?')
    .all(exerciseId);

  const best = db.prepare(`
    SELECT weight, weight_unit, logged_at
    FROM sets
    WHERE exercise_id = ? AND reps = ?
    ORDER BY (CASE WHEN weight_unit = 'lbs' THEN weight * 0.45359237 ELSE weight END) DESC,
             logged_at ASC
    LIMIT 1
  `);

  const del = db.prepare('DELETE FROM personal_records WHERE exercise_id = ?');
  const ins = db.prepare(`
    INSERT INTO personal_records (exercise_id, weight, weight_unit, reps, achieved_at)
    VALUES (?, ?, ?, ?, ?)
  `);

  tx(() => {
    del.run(exerciseId);
    for (const { reps } of repRows) {
      const b = best.get(exerciseId, reps);
      if (b) ins.run(exerciseId, b.weight, b.weight_unit, reps, b.logged_at);
    }
  });
}

module.exports = { recomputePrsForExercise };
