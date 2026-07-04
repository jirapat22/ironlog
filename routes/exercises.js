const express = require('express');
const { db, REGION_TO_GROUP, MUSCLE_GROUPS, tx } = require('../db');

const router = express.Router();

const SELECT_COLS =
  'id, name, muscle_group, sub_muscle, secondary_muscles, notes, is_bodyweight, is_assisted, equipment, weight_mode, step_override';

// Parse the stored JSON secondary_muscles into an array for the API response.
function shapeExercise(row) {
  if (!row) return row;
  let secondary = [];
  if (row.secondary_muscles) {
    try { secondary = JSON.parse(row.secondary_muscles); } catch { secondary = []; }
  }
  return { ...row, secondary_muscles: Array.isArray(secondary) ? secondary : [] };
}

// Validate/clean a secondary_muscles array: keep known regions, drop the
// primary and duplicates. Returns a JSON string to store, or null if empty.
function cleanSecondary(input, primarySub) {
  if (!Array.isArray(input)) return null;
  const out = [...new Set(input.map((r) => String(r).trim()))]
    .filter((r) => REGION_TO_GROUP[r] && r !== primarySub);
  return out.length ? JSON.stringify(out) : null;
}

router.get('/', (req, res) => {
  const rows = db
    .prepare(`SELECT ${SELECT_COLS} FROM exercises ORDER BY muscle_group, name`)
    .all();
  res.json(rows.map(shapeExercise));
});

// Usage stats — how many finished workouts each exercise appears in + last used
router.get('/stats', (req, res) => {
  const rows = db.prepare(`
    SELECT
      e.id, e.name, e.muscle_group, e.sub_muscle, e.secondary_muscles,
      e.notes, e.equipment, e.is_bodyweight, e.is_assisted, e.weight_mode, e.step_override,
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
  }
  if ('step_override' in (req.body || {})) {
    const raw = req.body.step_override;
    const v = (raw === null || raw === '') ? null : Number(raw);
    if (v != null && (!Number.isFinite(v) || v <= 0)) {
      return res.status(400).json({ error: 'step_override must be a positive number' });
    }
    updates.push('step_override = ?'); values.push(v);
  }
  if ('secondary_muscles' in (req.body || {})) {
    // Primary to exclude = the new sub_muscle if being set, else the existing one.
    const primary = 'sub_muscle' in req.body
      ? (req.body.sub_muscle && String(req.body.sub_muscle).trim()) || null
      : existing.sub_muscle;
    updates.push('secondary_muscles = ?');
    values.push(cleanSecondary(req.body.secondary_muscles, primary));
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
  const { name, muscle_group, notes, equipment = 'barbell', sub_muscle, secondary_muscles } = req.body || {};
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
  const secondary = cleanSecondary(secondary_muscles, sub);
  try {
    const info = db
      .prepare('INSERT INTO exercises (name, muscle_group, sub_muscle, secondary_muscles, notes, equipment, created_by_profile_id) VALUES (?, ?, ?, ?, ?, ?, ?)')
      .run(name.trim(), group, sub, secondary, notes || null, equip, req.profileId);
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
