const express = require('express');
const { db } = require('../db');
const { recomputePrsForExercise } = require('../pr');

const router = express.Router();

function toKg(weight, unit) {
  return unit === 'lbs' ? weight * 0.45359237 : weight;
}

// Optional per-side rep breakdown (per-arm exercises). Returns {ok, repsR,
// repsL} — both null if neither was sent, or an error if only one was (a
// breakdown needs both sides to mean anything).
function parseRepsSides(reps_r, reps_l) {
  if (reps_r == null && reps_l == null) return { ok: true, repsR: null, repsL: null };
  if (reps_r == null || reps_l == null) return { ok: false };
  const r = Number(reps_r), l = Number(reps_l);
  if (!Number.isInteger(r) || r <= 0 || !Number.isInteger(l) || l <= 0) return { ok: false };
  return { ok: true, repsR: r, repsL: l };
}

function checkAndUpdatePR(profileId, exerciseId, weight, unit, reps) {
  const newKg = toKg(weight, unit);

  const ex = db.prepare('SELECT is_bodyweight, is_assisted FROM exercises WHERE id = ?').get(exerciseId);
  // Assisted exercises log ASSISTANCE (more = easier) — the inverse of every
  // other exercise, where more = harder. Flip the sign before folding it into
  // the e1RM-style estimate so "beat previous best" means less assistance (or
  // more reps at the same assistance), not more raw kg.
  const sign = ex?.is_assisted ? -1 : 1;
  const newE1RM = sign * newKg * (1 + reps / 30);
  // Zero load (unweighted bodyweight, or fully-unassisted) is the hardest
  // variant either way — compare by reps directly rather than through e1RM.
  const isZeroLoad = !!ex?.is_bodyweight && newKg === 0;

  let beatPreviousBest = false;
  if (isZeroLoad) {
    const row = db.prepare(
      `SELECT MAX(reps) as max FROM personal_records WHERE profile_id = ? AND exercise_id = ? AND weight = 0`
    ).get(profileId, exerciseId);
    const prevMaxReps = row?.max || 0;
    beatPreviousBest = reps > prevMaxReps;
  } else {
    const row = db.prepare(
      `SELECT MAX(
         (CASE WHEN weight_unit = 'lbs' THEN weight * 0.45359237 ELSE weight END)
         * (1.0 + reps / 30.0) * ?
       ) as best FROM personal_records WHERE profile_id = ? AND exercise_id = ?`
    ).get(sign, profileId, exerciseId);
    const prevBestE1RM = row?.best;
    if (prevBestE1RM == null) {
      // No prior record for this exercise at all — anything logged is a PR.
      beatPreviousBest = true;
    } else {
      // 0.1% threshold to avoid float-noise PRs from tiny rounding — an
      // absolute buffer (not a straight *1.001 multiply) so it tightens the
      // bar in the right direction for assisted's negative-signed values too.
      beatPreviousBest = newE1RM > prevBestE1RM + Math.abs(prevBestE1RM) * 0.001;
    }
  }

  // Always keep the per-rep-count cache up to date — used by the PR list and
  // by recomputePrsForExercise after edits/deletes. "Better at this rep count"
  // also flips for assisted: less assistance wins, not more.
  const existing = db
    .prepare('SELECT * FROM personal_records WHERE profile_id = ? AND exercise_id = ? AND reps = ?')
    .get(profileId, exerciseId, reps);
  if (!existing) {
    db.prepare(
      `INSERT INTO personal_records (profile_id, exercise_id, weight, weight_unit, reps, achieved_at)
       VALUES (?, ?, ?, ?, ?, datetime('now'))`
    ).run(profileId, exerciseId, weight, unit, reps);
  } else {
    const existingKg = toKg(existing.weight, existing.weight_unit);
    if (sign * newKg > sign * existingKg) {
      db.prepare(
        `UPDATE personal_records
         SET weight = ?, weight_unit = ?, achieved_at = datetime('now')
         WHERE id = ?`
      ).run(weight, unit, existing.id);
    }
  }

  return beatPreviousBest;
}

router.post('/', (req, res) => {
  const {
    workout_id,
    exercise_id,
    set_number,
    weight,
    weight_unit = 'kg',
    reps,
    reps_r = null,
    reps_l = null,
    rpe = null,
    rir = null,
    notes = null,
    is_warmup = 0
  } = req.body || {};

  if (!workout_id || !exercise_id || set_number == null || weight == null || reps == null) {
    return res.status(400).json({
      error: 'workout_id, exercise_id, set_number, weight, and reps are required'
    });
  }
  if (!['kg', 'lbs'].includes(weight_unit)) {
    return res.status(400).json({ error: 'weight_unit must be kg or lbs' });
  }

  const sides = parseRepsSides(reps_r, reps_l);
  if (!sides.ok) return res.status(400).json({ error: 'reps_r and reps_l must both be positive whole numbers, or both omitted' });

  // Coerce + validate numerics so a stringy value can't silently corrupt
  // volume/PR math later (SQLite is loosely typed and would store it as-is).
  const nWeight = Number(weight);
  // A per-side breakdown always wins over whatever `reps` was sent — the
  // weaker side is the number every downstream volume/PR/progression
  // calculation should key off, so the client can't send them out of sync.
  const nReps = sides.repsR != null ? Math.min(sides.repsR, sides.repsL) : Number(reps);
  const nSetNumber = Number(set_number);
  const nRpe = rpe == null ? null : Number(rpe);
  const nRir = rir == null ? null : Number(rir);
  if (![nWeight, nReps, nSetNumber].every(Number.isFinite)) {
    return res.status(400).json({ error: 'weight, reps, and set_number must be numbers' });
  }
  // Negative/zero values are meaningless here (the client already blocks them,
  // but the server is the actual boundary — PR/volume math has no floor of its
  // own and would happily sum a negative "set" into history forever).
  if (nWeight < 0) return res.status(400).json({ error: 'weight cannot be negative' });
  if (!Number.isInteger(nReps) || nReps <= 0) return res.status(400).json({ error: 'reps must be a positive whole number' });
  if (!Number.isInteger(nSetNumber) || nSetNumber <= 0) return res.status(400).json({ error: 'set_number must be a positive whole number' });
  if ((nRpe != null && !Number.isFinite(nRpe)) || (nRir != null && !Number.isFinite(nRir))) {
    return res.status(400).json({ error: 'rpe and rir must be numbers when provided' });
  }

  // The set must attach to a workout owned by the current profile.
  const workout = db
    .prepare('SELECT id FROM workouts WHERE id = ? AND profile_id = ?')
    .get(workout_id, req.profileId);
  if (!workout) return res.status(404).json({ error: 'workout not found' });

  // Validate that the exercise exists (prevents dangling foreign keys and
  // phantom PR records from attacker-supplied exercise IDs).
  const exercise = db.prepare('SELECT id, weight_mode FROM exercises WHERE id = ?').get(Number(exercise_id));
  if (!exercise) return res.status(404).json({ error: 'exercise not found' });

  // Snapshot the per-arm factor at log time — flipping the exercise's
  // weight_mode later must not rewrite this set's meaning.
  const loadMultiplier = exercise.weight_mode === 'per_arm' ? 2 : 1;

  const info = db
    .prepare(
      `INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, reps_r, reps_l, rpe, rir, notes, is_warmup, load_multiplier)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(req.profileId, workout_id, exercise_id, nSetNumber, nWeight, weight_unit, nReps, sides.repsR, sides.repsL, nRpe, nRir, notes, is_warmup ? 1 : 0, loadMultiplier);

  // Skip PR check for warmup sets — they don't count toward personal bests
  const isNewPR = is_warmup ? false : checkAndUpdatePR(req.profileId, exercise_id, nWeight, weight_unit, nReps);
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json({ ...row, is_new_pr: isNewPR });
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM sets WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'set not found' });

  if (req.body && 'weight_unit' in req.body && !['kg', 'lbs'].includes(req.body.weight_unit)) {
    return res.status(400).json({ error: 'weight_unit must be kg or lbs' });
  }
  // Numeric fields must parse to finite numbers when present (null allowed for
  // the optional rpe/rir).
  const numericFields = ['weight', 'reps', 'set_number', 'rpe', 'rir'];
  const nullableNumeric = new Set(['rpe', 'rir']);
  for (const f of numericFields) {
    if (req.body && f in req.body) {
      const v = req.body[f];
      if (nullableNumeric.has(f) && v == null) continue;
      const n = Number(v);
      if (!Number.isFinite(n)) {
        return res.status(400).json({ error: `${f} must be a number` });
      }
      if (f === 'weight' && n < 0) return res.status(400).json({ error: 'weight cannot be negative' });
      if ((f === 'reps' || f === 'set_number') && (!Number.isInteger(n) || n <= 0)) {
        return res.status(400).json({ error: `${f} must be a positive whole number` });
      }
    }
  }

  // reps_r/reps_l (if either is present) always drive `reps` — so `reps`
  // is handled separately below instead of via the generic loop, and any
  // `reps` also sent in the same request is ignored in favor of the
  // per-side breakdown (mirrors POST's behavior).
  const bodyHasSides = 'reps_r' in (req.body || {}) || 'reps_l' in (req.body || {});
  const fields = ['weight', 'weight_unit', ...(bodyHasSides ? [] : ['reps']), 'rpe', 'rir', 'notes', 'set_number', 'is_warmup', 'unit_reviewed', 'form_flag'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (bodyHasSides) {
    const rR = 'reps_r' in req.body ? req.body.reps_r : existing.reps_r;
    const rL = 'reps_l' in req.body ? req.body.reps_l : existing.reps_l;
    const sides = parseRepsSides(rR, rL);
    if (!sides.ok) return res.status(400).json({ error: 'reps_r and reps_l must both be positive whole numbers, or both cleared' });
    updates.push('reps_r = ?', 'reps_l = ?');
    values.push(sides.repsR, sides.repsL);
    if (sides.repsR != null) {
      updates.push('reps = ?');
      values.push(Math.min(sides.repsR, sides.repsL));
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });

  values.push(id);
  db.prepare(`UPDATE sets SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(id);

  // A PATCH may lower weight or reps, so a fresh recompute is the only way
  // to keep PRs honest. Covers the rare case where the edited set used to
  // be the PR for some rep count.
  recomputePrsForExercise(req.profileId, row.exercise_id);
  res.json(row);
});

// Sets whose weight_unit looks like a mistake: for each exercise, whichever
// unit you've logged less often is flagged IF the other unit has it beat 2:1
// or better (skips exercises you genuinely log in both, e.g. hotel-gym lbs
// plates). Fix candidates the normal way — tap the set in History to edit it.
// Confirmed-fine sets (unit_reviewed) are excluded so a real intentional
// lbs/kg switch doesn't get re-flagged on every check.
router.get('/unit-outliers', (req, res) => {
  const rows = db.prepare(
    `SELECT s.id, s.exercise_id, e.name AS exercise_name, s.weight, s.weight_unit, s.reps, s.logged_at
     FROM sets s JOIN exercises e ON e.id = s.exercise_id
     WHERE s.profile_id = ? AND s.is_warmup = 0 AND s.unit_reviewed = 0
     ORDER BY s.exercise_id, s.logged_at`
  ).all(req.profileId);

  const byExercise = new Map();
  for (const r of rows) {
    if (!byExercise.has(r.exercise_id)) byExercise.set(r.exercise_id, []);
    byExercise.get(r.exercise_id).push(r);
  }

  const outliers = [];
  for (const sets of byExercise.values()) {
    const kg = sets.filter((s) => s.weight_unit !== 'lbs');
    const lbs = sets.filter((s) => s.weight_unit === 'lbs');
    const [majority, minority] = kg.length >= lbs.length ? [kg, lbs] : [lbs, kg];
    if (minority.length && majority.length >= minority.length * 2) {
      for (const s of minority) {
        outliers.push({
          set_id: s.id, exercise_name: s.exercise_name, weight: s.weight,
          weight_unit: s.weight_unit, reps: s.reps, logged_at: s.logged_at,
          usual_unit: majority[0].weight_unit
        });
      }
    }
  }
  res.json(outliers);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT exercise_id FROM sets WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'set not found' });
  db.prepare('DELETE FROM sets WHERE id = ?').run(id);
  recomputePrsForExercise(req.profileId, existing.exercise_id);
  res.json({ deleted: true });
});

module.exports = router;
