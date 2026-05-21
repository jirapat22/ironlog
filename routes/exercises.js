const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT id, name, muscle_group, notes, is_bodyweight, is_assisted FROM exercises ORDER BY muscle_group, name')
    .all();
  res.json(rows);
});

// Usage stats — how many finished workouts each exercise appears in + last used
router.get('/stats', (req, res) => {
  const rows = db.prepare(`
    SELECT
      e.id, e.name, e.muscle_group, e.is_bodyweight, e.is_assisted,
      COUNT(DISTINCT s.workout_id) AS workout_count,
      MAX(w.started_at)            AS last_used_at
    FROM exercises e
    LEFT JOIN sets     s ON s.exercise_id = e.id
    LEFT JOIN workouts w ON w.id = s.workout_id AND w.finished_at IS NOT NULL
    GROUP BY e.id
    ORDER BY e.muscle_group ASC, workout_count DESC, e.name ASC
  `).all();
  res.json(rows);
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM exercises WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'exercise not found' });
  const fields = ['name', 'muscle_group', 'notes'];
  const updates = [], values = [];
  for (const f of fields) {
    if (f in (req.body || {})) { updates.push(`${f} = ?`); values.push(req.body[f]); }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  values.push(id);
  try {
    db.prepare(`UPDATE exercises SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) return res.status(409).json({ error: 'exercise name already exists' });
    throw err;
  }
  res.json(db.prepare('SELECT id, name, muscle_group, notes, is_bodyweight, is_assisted FROM exercises WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
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
  const { name, muscle_group, notes } = req.body || {};
  if (!name || !muscle_group) {
    return res.status(400).json({ error: 'name and muscle_group are required' });
  }
  try {
    const info = db
      .prepare('INSERT INTO exercises (name, muscle_group, notes) VALUES (?, ?, ?)')
      .run(name.trim(), muscle_group.trim(), notes || null);
    const row = db.prepare('SELECT * FROM exercises WHERE id = ?').get(info.lastInsertRowid);
    res.status(201).json(row);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'exercise name already exists' });
    }
    throw err;
  }
});

module.exports = router;
