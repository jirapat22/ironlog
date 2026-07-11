const express = require('express');
const { db, REGION_TO_GROUP, MUSCLE_GROUPS, tx, mergeExercises, moveExerciseSessions } = require('../db');

const router = express.Router();

const SELECT_COLS =
  'id, name, muscle_group, sub_muscle, secondary_muscles, secondary_major, notes, is_bodyweight, is_assisted, equipment, weight_mode, step_override, rep_min, rep_max';

// Optional target-rep bound: null/'' clears it; otherwise a whole number 1-100.
// Returns { ok, value } so callers can 400 on bad input instead of coercing.
function parseRepBound(raw) {
  if (raw === null || raw === '' || raw === undefined) return { ok: true, value: null };
  const n = Number(raw);
  if (!Number.isInteger(n) || n < 1 || n > 100) return { ok: false };
  return { ok: true, value: n };
}

// Parse the stored JSON secondary_muscles/secondary_major into arrays for the
// API response. secondary_major stays `null` (not `[]`) when unclassified —
// that distinction matters to the coverage math (routes/progress.js) and to
// the "also works" picker's default state.
function shapeExercise(row) {
  if (!row) return row;
  let secondary = [];
  if (row.secondary_muscles) {
    try { secondary = JSON.parse(row.secondary_muscles); } catch { secondary = []; }
  }
  let secondaryMajor = null;
  if (row.secondary_major != null) {
    try { secondaryMajor = JSON.parse(row.secondary_major); } catch { secondaryMajor = null; }
    if (!Array.isArray(secondaryMajor)) secondaryMajor = null;
  }
  return {
    ...row,
    secondary_muscles: Array.isArray(secondary) ? secondary : [],
    secondary_major: secondaryMajor
  };
}

// Validate/clean a secondary_muscles array: keep known regions, drop the
// primary and duplicates. Returns a plain array (caller decides how to store).
function cleanSecondaryList(input, primarySub) {
  if (!Array.isArray(input)) return [];
  return [...new Set(input.map((r) => String(r).trim()))]
    .filter((r) => REGION_TO_GROUP[r] && r !== primarySub);
}

// Validate/clean a secondary_major array against the (already-cleaned)
// secondary_muscles list — a region can only be "major" if it's also tagged.
// `input === undefined` (field omitted entirely) defaults to the FULL list,
// matching the historical "everything credits" behavior for callers that
// don't know about tiers yet; an explicit array (including []) always wins.
function cleanSecondaryMajorList(input, secondaryList) {
  if (input === undefined) return [...secondaryList];
  if (!Array.isArray(input)) return [];
  const allowed = new Set(secondaryList);
  return [...new Set(input.map((r) => String(r).trim()))].filter((r) => allowed.has(r));
}

router.get('/', (req, res) => {
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM exercises ORDER BY muscle_group, name`)
    .all();
  res.json(rows.map(shapeExercise));
});

// Search the vendored exercise library (the "search to add" flow in the
// new-exercise forms). Returns pre-mapped entries: name, muscle_group,
// sub_muscle, equipment, unilateral, instructions.
router.get('/library/search', (req, res) => {
  const q = String(req.query.q || '').trim();
  if (q.length < 2) return res.json([]);
  res.json(require('../lib/exerciseLibrary').search(q, 12));
});

// Single exercise incl. long-form fields (instructions) that the list
// endpoints deliberately omit. Registered after the static routes above.
router.get('/:id(\\d+)', (req, res) => {
  const row = db.prepare(`SELECT ${SELECT_COLS}, instructions FROM exercises WHERE id = ?`).get(Number(req.params.id));
  if (!row) return res.status(404).json({ error: 'exercise not found' });
  res.json(shapeExercise(row));
});

// Usage stats — how many finished workouts each exercise appears in + last used
router.get('/stats', (req, res) => {
  const rows = db.prepare(`
    SELECT
      e.id, e.name, e.muscle_group, e.sub_muscle, e.secondary_muscles, e.secondary_major,
      e.notes, e.equipment, e.is_bodyweight, e.is_assisted, e.weight_mode, e.step_override, e.rep_min, e.rep_max,
      COUNT(DISTINCT s.workout_id) AS workout_count,
      MAX(w.started_at)            AS last_used_at,
      (SELECT COUNT(*) FROM program_day_exercises pde WHERE pde.exercise_id = e.id) AS program_count
    FROM exercises e
    LEFT JOIN sets     s ON s.exercise_id = e.id AND s.profile_id = ?
    LEFT JOIN workouts w ON w.id = s.workout_id AND w.finished_at IS NOT NULL
    GROUP BY e.id
    ORDER BY e.muscle_group ASC, workout_count DESC, e.name ASC
  `).all(req.profileId);
  res.json(rows.map(shapeExercise));
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM exercises WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'exercise not found' });
  if (existing.created_by_profile_id != null && existing.created_by_profile_id !== req.profileId) {
    return res.status(403).json({ error: 'not your exercise' });
  }
  const fields = ['name', 'muscle_group', 'notes', 'equipment', 'sub_muscle'];
  const updates = [], values = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      let v = req.body[f];
      // Empty/blank sub_muscle means "whole muscle" — store NULL.
      if (f === 'sub_muscle') v = (v && String(v).trim()) ? String(v).trim() : null;
      if (f === 'muscle_group') {
        v = String(v || '').trim();
        if (!MUSCLE_GROUPS.includes(v)) {
          return res.status(400).json({ error: `muscle_group must be one of: ${MUSCLE_GROUPS.join(', ')}` });
        }
      }
      updates.push(`${f} = ?`); values.push(v);
    }
  }
  if ('weight_mode' in (req.body || {})) {
    const v = req.body.weight_mode === 'combined' ? 'combined' : 'per_arm';
    updates.push('weight_mode = ?'); values.push(v);
  } else if ('equipment' in (req.body || {})) {
    // Equipment changed with no explicit mode (e.g. the in-workout equipment
    // picker): reset to that equipment's natural default so a dumbbell→cable
    // change doesn't silently keep doubling. The edit form always sends
    // weight_mode explicitly, so deliberate unilateral choices survive it.
    updates.push('weight_mode = ?');
    values.push(req.body.equipment === 'dumbbell' ? 'per_arm' : 'combined');
  }
  if ('step_override' in (req.body || {})) {
    const raw = req.body.step_override;
    const v = (raw === null || raw === '') ? null : Number(raw);
    if (v != null && (!Number.isFinite(v) || v <= 0)) {
      return res.status(400).json({ error: 'step_override must be a positive number' });
    }
    updates.push('step_override = ?'); values.push(v);
  }
  // How-to text edits are admin-gated: the catalog is shared across profiles,
  // so casual edits shouldn't rewrite the how-to everyone sees. Code checked
  // server-side (ADMIN_CODE env, defaulting to the owner's chosen 2210).
  if ('instructions' in (req.body || {})) {
    const code = String(req.body.admin_code ?? '');
    if (code !== (process.env.ADMIN_CODE || '2210')) {
      return res.status(403).json({ error: 'admin code required to edit how-to text' });
    }
    const v = req.body.instructions;
    const text = (typeof v === 'string' && v.trim()) ? v.trim().slice(0, 6000) : null;
    updates.push('instructions = ?'); values.push(text);
  }
  if ('rep_min' in (req.body || {}) || 'rep_max' in (req.body || {})) {
    const min = parseRepBound('rep_min' in req.body ? req.body.rep_min : existing.rep_min);
    const max = parseRepBound('rep_max' in req.body ? req.body.rep_max : existing.rep_max);
    if (!min.ok || !max.ok) {
      return res.status(400).json({ error: 'rep range must be whole numbers between 1 and 100' });
    }
    if (min.value != null && max.value != null && min.value > max.value) {
      return res.status(400).json({ error: 'rep range: min cannot exceed max' });
    }
    updates.push('rep_min = ?'); values.push(min.value);
    updates.push('rep_max = ?'); values.push(max.value);
  }
  let secondaryList = null; // set below only if secondary_muscles is in the request
  if ('secondary_muscles' in (req.body || {})) {
    // Primary to exclude = the new sub_muscle if being set, else the existing one.
    const primary = 'sub_muscle' in req.body
      ? (req.body.sub_muscle && String(req.body.sub_muscle).trim()) || null
      : existing.sub_muscle;
    secondaryList = cleanSecondaryList(req.body.secondary_muscles, primary);
    updates.push('secondary_muscles = ?');
    values.push(secondaryList.length ? JSON.stringify(secondaryList) : null);
  }
  if ('secondary_major' in (req.body || {})) {
    const list = secondaryList !== null
      ? secondaryList
      : (existing.secondary_muscles ? (() => { try { return JSON.parse(existing.secondary_muscles); } catch { return []; } })() : []);
    updates.push('secondary_major = ?');
    values.push(JSON.stringify(cleanSecondaryMajorList(req.body.secondary_major, list)));
  } else if (secondaryList !== null && existing.secondary_major != null) {
    // secondary_muscles changed but secondary_major wasn't sent, and this
    // exercise already has explicit tiers — re-intersect so a region that
    // just got un-tagged also drops out of the major set. If secondary_major
    // was still NULL (never classified), leave it NULL rather than pinning
    // it to [] — that would silently kill the legacy full-credit fallback.
    let prevMajor = [];
    try { prevMajor = JSON.parse(existing.secondary_major); } catch { prevMajor = []; }
    updates.push('secondary_major = ?');
    values.push(JSON.stringify(cleanSecondaryMajorList(prevMajor, secondaryList)));
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  values.push(id);
  try {
    db.prepare(`UPDATE exercises SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'exercise name already exists' });
    throw err;
  }
  res.json(shapeExercise(db.prepare(`SELECT ${SELECT_COLS} FROM exercises WHERE id = ?`).get(id)));
});

// Merge this exercise (:id, the one being removed) INTO target_id (the keeper).
// Reassigns all of :id's logged sets, program slots and any customization the
// keeper lacks, rebuilds PRs, and deletes :id. Used to fold accidental
// duplicates (e.g. "Leg Curl" into "Seated Leg Curl") without losing history.
router.post('/:id/merge', (req, res) => {
  const loserId = Number(req.params.id);
  const targetId = Number(req.body && req.body.target_id);
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'target_id is required' });
  if (loserId === targetId) return res.status(400).json({ error: 'cannot merge an exercise into itself' });

  const loser = db.prepare('SELECT id, name, created_by_profile_id FROM exercises WHERE id = ?').get(loserId);
  const target = db.prepare('SELECT id, name, created_by_profile_id FROM exercises WHERE id = ?').get(targetId);
  if (!loser || !target) return res.status(404).json({ error: 'exercise not found' });
  // Same ownership guard as delete/edit: a profile can only touch its own
  // customs or shared (seed) exercises, not another profile's custom.
  for (const ex of [loser, target]) {
    if (ex.created_by_profile_id != null && ex.created_by_profile_id !== req.profileId) {
      return res.status(403).json({ error: 'not your exercise' });
    }
  }

  const result = mergeExercises(loserId, targetId);
  if (!result.merged) return res.status(409).json({ error: 'could not merge' });
  res.json({ merged: true, into: target.name, moved_sets: result.movedSets });
});

// List this exercise's logged sessions (one row per workout the current
// profile logged it in), newest first — used by the "move sessions to another
// exercise" split UI to pick which sessions to move.
router.get('/:id(\\d+)/sessions', (req, res) => {
  const id = Number(req.params.id);
  const rows = db.prepare(`
    SELECT
      w.id            AS workout_id,
      w.started_at    AS started_at,
      COUNT(s.id)     AS set_count,
      GROUP_CONCAT(s.weight || 'x' || s.reps, ', ') AS summary,
      MAX(s.weight_unit) AS weight_unit
    FROM sets s
    JOIN workouts w ON w.id = s.workout_id
    WHERE s.exercise_id = ? AND s.profile_id = ?
    GROUP BY w.id
    ORDER BY w.started_at DESC
  `).all(id, req.profileId);
  res.json(rows);
});

// Move a subset of this exercise's sessions (by workout id) onto another
// exercise. Un-mixes an exercise logged across different equipment/loading
// under one name (e.g. barbell vs per-arm dumbbell wrist curls). Owner-guarded
// like merge; moved sets' per-arm multiplier is reset to the target's mode.
router.post('/:id(\\d+)/move-sessions', (req, res) => {
  const sourceId = Number(req.params.id);
  const targetId = Number(req.body && req.body.target_id);
  const workoutIds = Array.isArray(req.body && req.body.workout_ids)
    ? req.body.workout_ids.map(Number).filter(Number.isInteger)
    : [];
  if (!Number.isInteger(targetId)) return res.status(400).json({ error: 'target_id is required' });
  if (sourceId === targetId) return res.status(400).json({ error: 'cannot move onto the same exercise' });
  if (!workoutIds.length) return res.status(400).json({ error: 'no sessions selected' });

  const source = db.prepare('SELECT id, name, created_by_profile_id FROM exercises WHERE id = ?').get(sourceId);
  const target = db.prepare('SELECT id, name, created_by_profile_id FROM exercises WHERE id = ?').get(targetId);
  if (!source || !target) return res.status(404).json({ error: 'exercise not found' });
  for (const ex of [source, target]) {
    if (ex.created_by_profile_id != null && ex.created_by_profile_id !== req.profileId) {
      return res.status(403).json({ error: 'not your exercise' });
    }
  }

  const result = moveExerciseSessions(sourceId, targetId, workoutIds, req.profileId);
  if (!result.moved) return res.status(409).json({ error: 'nothing to move' });
  res.json({ moved_sets: result.moved, into: target.name });
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const toDelete = db.prepare('SELECT created_by_profile_id FROM exercises WHERE id = ?').get(id);
  if (!toDelete) return res.status(404).json({ error: 'exercise not found' });
  if (toDelete.created_by_profile_id != null && toDelete.created_by_profile_id !== req.profileId) {
    return res.status(403).json({ error: 'not your exercise' });
  }
  // Refuse if exercise is still used in any program or has logged sets
  const inPrograms = db.prepare('SELECT COUNT(*) as n FROM program_day_exercises WHERE exercise_id = ?').get(id).n;
  const inSets = db.prepare('SELECT COUNT(*) as n FROM sets WHERE exercise_id = ?').get(id).n;
  if (inPrograms > 0 || inSets > 0) {
    return res.status(409).json({ error: `In use: ${inPrograms} program slot${inPrograms !== 1 ? 's' : ''}, ${inSets} logged set${inSets !== 1 ? 's' : ''}` });
  }
  const result = db.prepare('DELETE FROM exercises WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'exercise not found' });
  res.json({ deleted: true });
});

router.post('/', (req, res) => {
  const { name, muscle_group, notes, equipment = 'barbell', sub_muscle, secondary_muscles, secondary_major, rep_min, rep_max, weight_mode, instructions } = req.body || {};
  if (!name || !muscle_group) {
    return res.status(400).json({ error: 'name and muscle_group are required' });
  }
  const group = String(muscle_group).trim();
  if (!MUSCLE_GROUPS.includes(group)) {
    return res.status(400).json({ error: `muscle_group must be one of: ${MUSCLE_GROUPS.join(', ')}` });
  }
  const validEquipment = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight'];
  const equip = validEquipment.includes(equipment) ? equipment : 'barbell';
  const sub = (sub_muscle && String(sub_muscle).trim()) ? String(sub_muscle).trim() : null;
  const secondaryList = cleanSecondaryList(secondary_muscles, sub);
  const secondary = secondaryList.length ? JSON.stringify(secondaryList) : null;
  const major = JSON.stringify(cleanSecondaryMajorList(secondary_major, secondaryList));
  const min = parseRepBound(rep_min);
  const max = parseRepBound(rep_max);
  if (!min.ok || !max.ok) {
    return res.status(400).json({ error: 'rep range must be whole numbers between 1 and 100' });
  }
  if (min.value != null && max.value != null && min.value > max.value) {
    return res.status(400).json({ error: 'rep range: min cannot exceed max' });
  }
  // weight_mode: explicit if sent, else by equipment — a dumbbell is naturally
  // "the weight of one" (per_arm); everything else logs the full load unless
  // the user marks it unilateral (single-arm cable pushdown, single-leg press).
  const mode = weight_mode === 'per_arm' || weight_mode === 'combined'
    ? weight_mode
    : (equip === 'dumbbell' ? 'per_arm' : 'combined');
  const howTo = (typeof instructions === 'string' && instructions.trim())
    ? instructions.trim().slice(0, 6000)
    : null;
  try {
    const info = db
      .prepare('INSERT INTO exercises (name, muscle_group, sub_muscle, secondary_muscles, secondary_major, notes, equipment, weight_mode, rep_min, rep_max, instructions, created_by_profile_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(name.trim(), group, sub, secondary, major, notes || null, equip, mode, min.value, max.value, howTo, req.profileId);
    const row = db.prepare(`SELECT ${SELECT_COLS} FROM exercises WHERE id = ?`).get(info.lastInsertRowid);
    res.status(201).json(shapeExercise(row));
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'exercise name already exists' });
    }
    throw err;
  }
});

// Clear the current profile's logged data for an exercise — its sets and PR
// cache — while keeping the catalog row. Used to scrub accidental/stray logs
// without deleting a seeded exercise (which would just re-seed on restart).
router.delete('/:id/sets', (req, res) => {
  const id = Number(req.params.id);
  const ex = db.prepare('SELECT id FROM exercises WHERE id = ?').get(id);
  if (!ex) return res.status(404).json({ error: 'exercise not found' });
  const removed = tx(() => {
    const r = db.prepare('DELETE FROM sets WHERE exercise_id = ? AND profile_id = ?').run(id, req.profileId);
    db.prepare('DELETE FROM personal_records WHERE exercise_id = ? AND profile_id = ?').run(id, req.profileId);
    return r.changes;
  });
  res.json({ cleared: true, sets_removed: Number(removed) });
});

module.exports = router;
