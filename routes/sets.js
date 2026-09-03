const express = require('express');
const { db, effectiveVolumeLoadKgSql } = require('../db');
const { recomputePrsForExercise } = require('../pr');
const { computeImprovedFlags } = require('../lib/improved');
const { findSuspiciousSets } = require('../lib/mislog');

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

// loadMultiplier: this set's per-arm doubling factor (see load_multiplier in
// db.js). personal_records has no multiplier column of its own, so each record
// borrows the one from the SET that holds it (set_id), falling back to the
// exercise's current weight_mode for legacy rows with no set_id. That per-row
// resolution is what recomputePrsForExercise (pr.js) already does; applying
// the incoming set's factor uniformly to both sides instead made the two
// disagree, so a plain edit/delete elsewhere on the exercise could silently
// re-rank the PR — see the "just going forward" flow, which is exactly how an
// exercise ends up with mixed multipliers in the first place.
function checkAndUpdatePR(profileId, exerciseId, weight, unit, reps, setId, loadMultiplier = 1) {
  const newKg = toKg(weight, unit);
  const newEffectiveKg = newKg * loadMultiplier;

  const ex = db.prepare('SELECT is_bodyweight, is_assisted, weight_mode FROM exercises WHERE id = ?').get(exerciseId);
  // Fallback factor for a record whose set_id is NULL (pre-set_id rows).
  const fallbackMultiplier = ex?.weight_mode === 'per_arm' ? 2 : 1;
  // Assisted exercises log ASSISTANCE (more = easier) — the inverse of every
  // other exercise, where more = harder. Flip the sign before folding it into
  // the e1RM-style estimate so "beat previous best" means less assistance (or
  // more reps at the same assistance), not more raw kg.
  const sign = ex?.is_assisted ? -1 : 1;
  const newE1RM = sign * newEffectiveKg * (1 + reps / 30);
  // Fully-unassisted (0 assistance) IS the hardest variant, so comparing by
  // reps is right there. But for a WEIGHTED bodyweight exercise (pull-up plus
  // a belt) 0 added weight is the LIGHTEST variant — and this branch only
  // compares against records at weight = 0, so every rep count never done
  // bodyweight-only reported a "New PR!" for a strictly worse set. The banner
  // lied while History's trophy (keyed on set_id) correctly disagreed on the
  // same screen.
  const isZeroLoad = !!ex?.is_bodyweight && !!ex?.is_assisted && newKg === 0;

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
         (CASE WHEN pr.weight_unit = 'lbs' THEN pr.weight * 0.45359237 ELSE pr.weight END)
         * COALESCE(s.load_multiplier, ?)
         * (1.0 + pr.reps / 30.0) * ?
       ) as best
       FROM personal_records pr
       LEFT JOIN sets s ON s.id = pr.set_id
       WHERE pr.profile_id = ? AND pr.exercise_id = ?`
    ).get(fallbackMultiplier, sign, profileId, exerciseId);
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
    .prepare(
      `SELECT pr.*, COALESCE(s.load_multiplier, ?) as eff_multiplier
       FROM personal_records pr
       LEFT JOIN sets s ON s.id = pr.set_id
       WHERE pr.profile_id = ? AND pr.exercise_id = ? AND pr.reps = ?`
    )
    .get(fallbackMultiplier, profileId, exerciseId, reps);
  if (!existing) {
    db.prepare(
      // achieved_at comes from the SET, not the clock: a session logged for
      // yesterday would otherwise date its PRs today. Also makes this agree
      // with recomputePrsForExercise, which has always used logged_at — so a
      // later rebuild no longer silently moves every PR date.
      `INSERT INTO personal_records (profile_id, exercise_id, weight, weight_unit, reps, achieved_at, set_id)
       VALUES (?, ?, ?, ?, ?, COALESCE((SELECT logged_at FROM sets WHERE id = ?), datetime('now')), ?)`
    ).run(profileId, exerciseId, weight, unit, reps, setId ?? null, setId ?? null);
  } else {
    const existingEffectiveKg = toKg(existing.weight, existing.weight_unit) * existing.eff_multiplier;
    if (sign * newEffectiveKg > sign * existingEffectiveKg) {
      db.prepare(
        `UPDATE personal_records
         SET weight = ?, weight_unit = ?,
             achieved_at = COALESCE((SELECT logged_at FROM sets WHERE id = ?), datetime('now')),
             set_id = ?
         WHERE id = ?`
      ).run(weight, unit, setId ?? null, setId ?? null, existing.id);
    }
    // A tie (sign*newKg == sign*existingKg) deliberately leaves set_id
    // untouched — the ORIGINAL set stays the record holder, this one is
    // just a repeat, not a new PR.
  }

  return beatPreviousBest;
}

// Sanity ceilings — see the bound checks in POST / below.
const MAX_WEIGHT = { kg: 2000, lbs: 4400 };
const MAX_REPS = 1000;
const MAX_SET_NUMBER = 100;

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
  // Upper bounds. The floor checks above stop negatives, but nothing stopped a
  // fat-fingered 100000: it was accepted, took the exercise's PR forever, and
  // turned a session's volume into 800,480 kg. set_number is worse than wrong
  // data — the workout view sizes each exercise's row list off the highest
  // set_number it sees, so a single absurd one made the whole workout
  // unopenable ("Invalid string length" building ~1e6 rows of markup), with no
  // way back to it from the UI. Bounds are far past any real lift: 2000 kg /
  // 4400 lbs is roughly double the heaviest loaded machine.
  if (nWeight > MAX_WEIGHT[weight_unit]) {
    return res.status(400).json({ error: `weight must be ${MAX_WEIGHT[weight_unit]} ${weight_unit} or less` });
  }
  if (nReps > MAX_REPS) return res.status(400).json({ error: `reps must be ${MAX_REPS} or fewer` });
  if (nSetNumber > MAX_SET_NUMBER) return res.status(400).json({ error: `set_number must be ${MAX_SET_NUMBER} or less` });
  if ((nRpe != null && (!Number.isFinite(nRpe) || nRpe < 0 || nRpe > 10)) ||
      (nRir != null && (!Number.isFinite(nRir) || nRir < 0 || nRir > 10))) {
    return res.status(400).json({ error: 'rpe and rir must be numbers between 0 and 10 when provided' });
  }

  // The set must attach to a workout owned by the current profile. bw_kg/
  // started_at are needed below by computeImprovedFlags — selected here so
  // it doesn't have to re-fetch a row this handler already has.
  const workout = db
    .prepare('SELECT id, bw_kg, started_at, is_backdated FROM workouts WHERE id = ? AND profile_id = ?')
    .get(workout_id, req.profileId);
  if (!workout) return res.status(404).json({ error: 'workout not found' });

  // logged_at drives every "which day did I train" question there is — weekly
  // volume buckets, muscle coverage, the overload chart's per-session points,
  // PR tie-breaks. Left at datetime('now'), a session logged for yesterday
  // would file all its sets under today and the backdating would be cosmetic.
  // Sets are spaced a minute apart from the session's start so ordering stays
  // deterministic and the finish heuristic (last set + 10 min) still derives
  // a believable duration instead of a two-day one.
  let loggedAt = null;
  if (workout.is_backdated) {
    const priorSets = db
      .prepare('SELECT COUNT(*) AS n FROM sets WHERE workout_id = ?')
      .get(workout_id).n;
    loggedAt = db
      .prepare("SELECT datetime(?, ?) AS t")
      .get(workout.started_at, `+${priorSets} minutes`).t;
  }

  // Validate that the exercise exists (prevents dangling foreign keys and
  // phantom PR records from attacker-supplied exercise IDs).
  const exercise = db.prepare('SELECT id, weight_mode FROM exercises WHERE id = ?').get(Number(exercise_id));
  if (!exercise) return res.status(404).json({ error: 'exercise not found' });

  // Snapshot the per-arm factor at log time — flipping the exercise's
  // weight_mode later must not rewrite this set's meaning.
  const loadMultiplier = exercise.weight_mode === 'per_arm' ? 2 : 1;

  const info = db
    .prepare(
      `INSERT INTO sets (profile_id, workout_id, exercise_id, set_number, weight, weight_unit, reps, reps_r, reps_l, rpe, rir, notes, is_warmup, load_multiplier, logged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, datetime('now')))`
    )
    .run(req.profileId, workout_id, exercise_id, nSetNumber, nWeight, weight_unit, nReps, sides.repsR, sides.repsL, nRpe, nRir, notes, is_warmup ? 1 : 0, loadMultiplier, loggedAt);

  // Skip PR check for warmup sets — they don't count toward personal bests
  const isNewPR = is_warmup ? false : checkAndUpdatePR(req.profileId, exercise_id, nWeight, weight_unit, nReps, info.lastInsertRowid, loadMultiplier);
  const row = db.prepare('SELECT * FROM sets WHERE id = ?').get(info.lastInsertRowid);
  // Durable (not client-computed): recomputed fresh on every read too, so it
  // survives a reload/backgrounding mid-workout instead of vanishing the
  // moment anything forces a re-fetch — see lib/improved.js.
  const improved = is_warmup ? null : computeImprovedFlags(req.profileId, workout, exercise_id).get(info.lastInsertRowid) || null;
  res.status(201).json({ ...row, is_new_pr: isNewPR, improved_from_last: improved });
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
      // Same ceilings POST applies — editing a set was a way straight past them.
      const unit = (req.body && req.body.weight_unit) || existing.weight_unit || 'kg';
      if (f === 'weight' && n > MAX_WEIGHT[unit]) {
        return res.status(400).json({ error: `weight must be ${MAX_WEIGHT[unit]} ${unit} or less` });
      }
      if (f === 'reps' && n > MAX_REPS) return res.status(400).json({ error: `reps must be ${MAX_REPS} or fewer` });
      if (f === 'set_number' && n > MAX_SET_NUMBER) {
        return res.status(400).json({ error: `set_number must be ${MAX_SET_NUMBER} or less` });
      }
      if ((f === 'rpe' || f === 'rir') && (n < 0 || n > 10)) {
        return res.status(400).json({ error: `${f} must be between 0 and 10` });
      }
    }
  }

  // reps_r/reps_l (if either is present) always drive `reps` — so `reps`
  // is handled separately below instead of via the generic loop, and any
  // `reps` also sent in the same request is ignored in favor of the
  // per-side breakdown (mirrors POST's behavior).
  const bodyHasSides = 'reps_r' in (req.body || {}) || 'reps_l' in (req.body || {});
  const fields = ['weight', 'weight_unit', ...(bodyHasSides ? [] : ['reps']), 'rpe', 'rir', 'notes', 'set_number', 'is_warmup', 'unit_reviewed', 'form_flag', 'weight_reviewed'];
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

// ---------------------------------------------------------------------------
// Sets whose weight is out of all proportion to your own history for that
// exercise — a missed decimal, an extra zero, a number typed into the wrong
// row. Worth its own endpoint because the progression suggestion is built
// from the heaviest set of your last session: one bad row silently becomes
// that exercise's best and every recommendation after it is nonsense.
//
// Compared on EFFECTIVE load (per-arm doubling, bodyweight plus added) so a
// lift is judged on what it actually moved. Assisted lifts carry their
// assistance figure separately — see lib/mislog.js for why that one is
// compared on the raw number instead.
// ---------------------------------------------------------------------------
router.get('/suspicious', (req, res) => {
  const rows = db.prepare(
    `SELECT s.id, s.exercise_id, s.workout_id, s.logged_at, s.weight, s.weight_unit,
            s.reps, s.weight_reviewed,
            e.name AS exercise_name, e.is_assisted, e.is_bodyweight,
            ${effectiveVolumeLoadKgSql('s', 'e', 'w')} AS load_kg,
            (CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) AS assist_kg
       FROM sets s
       JOIN exercises e ON e.id = s.exercise_id
       JOIN workouts w ON w.id = s.workout_id
      WHERE s.profile_id = ? AND s.is_warmup = 0
      ORDER BY s.logged_at`
  ).all(req.profileId);

  const byId = new Map(rows.map((r) => [r.id, r]));
  const flagged = findSuspiciousSets(rows.map((r) => ({
    id: r.id,
    exercise_id: r.exercise_id,
    workout_id: r.workout_id,
    logged_at: r.logged_at,
    weight: r.weight,
    weight_unit: r.weight_unit,
    reps: r.reps,
    weight_reviewed: r.weight_reviewed,
    is_assisted: !!r.is_assisted,
    loadKg: r.load_kg,
    assistKg: r.assist_kg
  })));

  res.json(flagged.map((f) => ({ ...f, exercise_name: byId.get(f.set_id)?.exercise_name || '' })));
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
// Exported for pr.test.js: this and recomputePrsForExercise (pr.js) are two
// independent implementations of "which set holds the record", and they have
// to agree — see the mixed-multiplier tests there.
module.exports.checkAndUpdatePR = checkAndUpdatePR;
