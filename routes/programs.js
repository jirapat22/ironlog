const express = require('express');
const { db, tx } = require('../db');

const router = express.Router();

// Duplicate a program (with all days + exercises) under a new name
router.post('/:id/duplicate', (req, res) => {
  const srcId = Number(req.params.id);
  const { name } = req.body || {};
  const src = db.prepare('SELECT * FROM programs WHERE id = ?').get(srcId);
  if (!src) return res.status(404).json({ error: 'program not found' });

  const newName = (name && String(name).trim()) || `Copy of ${src.name}`;

  try {
    const newId = tx(() => {
      const info = db
        .prepare('INSERT INTO programs (name, description) VALUES (?, ?)')
        .run(newName, src.description);
      const programId = Number(info.lastInsertRowid);

      const days = db
        .prepare('SELECT * FROM program_days WHERE program_id = ? ORDER BY day_order')
        .all(srcId);
      const insertDay = db.prepare(
        'INSERT INTO program_days (program_id, day_label, day_order) VALUES (?, ?, ?)'
      );
      const srcEx = db.prepare(
        'SELECT * FROM program_day_exercises WHERE program_day_id = ? ORDER BY order_index'
      );
      const insertEx = db.prepare(
        'INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index) VALUES (?, ?, ?, ?, ?)'
      );

      for (const d of days) {
        const newDayId = Number(insertDay.run(programId, d.day_label, d.day_order).lastInsertRowid);
        for (const e of srcEx.all(d.id)) {
          insertEx.run(newDayId, e.exercise_id, e.target_sets, e.target_reps, e.order_index);
        }
      }
      return programId;
    });
    const row = db.prepare('SELECT id, name, description FROM programs WHERE id = ?').get(newId);
    res.status(201).json(row);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Rename / update a program
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'program not found' });
  const fields = ['name', 'description'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  values.push(id);
  db.prepare(`UPDATE programs SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT id, name, description FROM programs WHERE id = ?').get(id);
  res.json(row);
});

// Delete a program (cascades to days + pde rows)
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM programs WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'program not found' });
  res.json({ deleted: true });
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT id, name, description FROM programs ORDER BY id').all();
  res.json(rows);
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const program = db.prepare('SELECT * FROM programs WHERE id = ?').get(id);
  if (!program) return res.status(404).json({ error: 'program not found' });

  const days = db
    .prepare('SELECT * FROM program_days WHERE program_id = ? ORDER BY day_order')
    .all(id);

  const dayExStmt = db.prepare(`
    SELECT pde.id, pde.target_sets, pde.target_reps, pde.order_index,
           e.id as exercise_id, e.name, e.muscle_group, e.notes, e.is_bodyweight
    FROM program_day_exercises pde
    JOIN exercises e ON e.id = pde.exercise_id
    WHERE pde.program_day_id = ?
    ORDER BY pde.order_index
  `);

  for (const day of days) {
    day.exercises = dayExStmt.all(day.id);
  }

  program.days = days;
  res.json(program);
});

// Add an exercise to a program day
router.post('/:programId/days/:dayId/exercises', (req, res) => {
  const dayId = Number(req.params.dayId);
  const { exercise_id, target_sets = 3, target_reps = 10 } = req.body || {};
  if (!exercise_id) return res.status(400).json({ error: 'exercise_id is required' });

  const day = db.prepare('SELECT id FROM program_days WHERE id = ?').get(dayId);
  if (!day) return res.status(404).json({ error: 'program day not found' });

  const maxOrder =
    db
      .prepare('SELECT COALESCE(MAX(order_index), -1) as m FROM program_day_exercises WHERE program_day_id = ?')
      .get(dayId).m + 1;

  const info = db
    .prepare(
      `INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index)
       VALUES (?, ?, ?, ?, ?)`
    )
    .run(dayId, exercise_id, target_sets, target_reps, maxOrder);

  const row = db
    .prepare(
      `SELECT pde.id, pde.target_sets, pde.target_reps, pde.order_index,
              e.id as exercise_id, e.name, e.muscle_group, e.notes, e.is_bodyweight
       FROM program_day_exercises pde
       JOIN exercises e ON e.id = pde.exercise_id
       WHERE pde.id = ?`
    )
    .get(Number(info.lastInsertRowid));
  res.status(201).json(row);
});

// Update a program day exercise (sets, reps, swap exercise, reorder)
router.patch('/:programId/days/:dayId/exercises/:pdeId', (req, res) => {
  const pdeId = Number(req.params.pdeId);
  const existing = db.prepare('SELECT * FROM program_day_exercises WHERE id = ?').get(pdeId);
  if (!existing) return res.status(404).json({ error: 'entry not found' });

  const fields = ['target_sets', 'target_reps', 'exercise_id', 'order_index'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      values.push(req.body[f]);
    }
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  values.push(pdeId);

  db.prepare(`UPDATE program_day_exercises SET ${updates.join(', ')} WHERE id = ?`).run(...values);

  const row = db
    .prepare(
      `SELECT pde.id, pde.target_sets, pde.target_reps, pde.order_index,
              e.id as exercise_id, e.name, e.muscle_group, e.notes, e.is_bodyweight
       FROM program_day_exercises pde
       JOIN exercises e ON e.id = pde.exercise_id
       WHERE pde.id = ?`
    )
    .get(pdeId);
  res.json(row);
});

// Remove an exercise from a program day
router.delete('/:programId/days/:dayId/exercises/:pdeId', (req, res) => {
  const pdeId = Number(req.params.pdeId);
  const result = db.prepare('DELETE FROM program_day_exercises WHERE id = ?').run(pdeId);
  if (result.changes === 0) return res.status(404).json({ error: 'entry not found' });
  res.json({ deleted: true });
});

module.exports = router;
