const express = require('express');
const { db, tx } = require('../db');

const router = express.Router();

// Ownership guards — programs are per-profile; days and day-exercises inherit
// ownership through their program. Each returns a row (truthy) or undefined.
const ownsProgram = (profileId, programId) =>
  db.prepare('SELECT id FROM programs WHERE id = ? AND profile_id = ?').get(programId, profileId);
const ownsDay = (profileId, dayId) =>
  db.prepare(
    `SELECT pd.id FROM program_days pd JOIN programs p ON p.id = pd.program_id
     WHERE pd.id = ? AND p.profile_id = ?`
  ).get(dayId, profileId);
const ownsPde = (profileId, pdeId) =>
  db.prepare(
    `SELECT pde.id FROM program_day_exercises pde
     JOIN program_days pd ON pd.id = pde.program_day_id
     JOIN programs p ON p.id = pd.program_id
     WHERE pde.id = ? AND p.profile_id = ?`
  ).get(pdeId, profileId);

// Create a blank program
router.post('/', (req, res) => {
  const { name, description = '' } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'name is required' });
  const info = db.prepare('INSERT INTO programs (profile_id, name, description) VALUES (?, ?, ?)')
    .run(req.profileId, String(name).trim(), description || '');
  const row = db.prepare('SELECT id, name, description FROM programs WHERE id = ?').get(info.lastInsertRowid);
  res.status(201).json(row);
});

// Add a day to a program
router.post('/:id/days', (req, res) => {
  const programId = Number(req.params.id);
  const { day_label } = req.body || {};
  if (!day_label || !String(day_label).trim()) return res.status(400).json({ error: 'day_label is required' });
  const program = ownsProgram(req.profileId, programId);
  if (!program) return res.status(404).json({ error: 'program not found' });
  const { m } = db.prepare('SELECT COALESCE(MAX(day_order), -1) as m FROM program_days WHERE program_id = ?').get(programId);
  const info = db.prepare('INSERT INTO program_days (program_id, day_label, day_order) VALUES (?, ?, ?)')
    .run(programId, String(day_label).trim(), m + 1);
  const row = db.prepare('SELECT * FROM program_days WHERE id = ?').get(info.lastInsertRowid);
  row.exercises = [];
  res.status(201).json(row);
});

// Reorder every day in a program atomically, from a full ordered id list —
// renumbering server-side in one transaction instead of the client sending N
// independent day_order PATCHes (the previous approach). N separate writes
// have no atomicity: a dropped request mid-batch (flaky connection) or two
// tabs reordering the same program concurrently can each partially apply,
// leaving two days sharing a day_order that only surfaces as a silent
// reshuffle on next load. Registered BEFORE the /:dayId route below —
// otherwise Express would match "reorder" as a :dayId param first.
router.patch('/:id/days/reorder', (req, res) => {
  const programId = Number(req.params.id);
  if (!ownsProgram(req.profileId, programId)) return res.status(404).json({ error: 'program not found' });

  const dayIds = (req.body && req.body.day_ids || []).map(Number);
  if (!dayIds.length || dayIds.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'day_ids must be a non-empty array of ids' });
  }

  const currentIds = db.prepare('SELECT id FROM program_days WHERE program_id = ?').all(programId).map((r) => r.id);
  // Must be exactly the same SET of ids (order aside) — a mismatch means the
  // client's list is stale (a day was added/removed since it loaded), and
  // blindly renumbering off it would silently drop or duplicate a position.
  const sameSet = currentIds.length === dayIds.length && new Set(currentIds).size === new Set(dayIds).size &&
    dayIds.every((id) => currentIds.includes(id));
  if (!sameSet) return res.status(409).json({ error: 'day list is out of date — reload and try again' });

  const upd = db.prepare('UPDATE program_days SET day_order = ? WHERE id = ?');
  tx(() => { dayIds.forEach((id, i) => upd.run(i, id)); });

  res.json({ reordered: true });
});

// Rename a day and/or reposition it within its program (day_order — used to
// move a day up/down in the list, the same way sort_order repositions programs).
router.patch('/:id/days/:dayId', (req, res) => {
  const dayId = Number(req.params.dayId);
  const { day_label, day_order } = req.body || {};
  if (!ownsDay(req.profileId, dayId)) return res.status(404).json({ error: 'day not found' });
  const updates = [], values = [];
  if ('day_label' in (req.body || {})) {
    if (!day_label || !String(day_label).trim()) return res.status(400).json({ error: 'day_label is required' });
    updates.push('day_label = ?'); values.push(String(day_label).trim());
  }
  if ('day_order' in (req.body || {})) {
    const n = Number(day_order);
    if (!Number.isInteger(n)) return res.status(400).json({ error: 'day_order must be a whole number' });
    updates.push('day_order = ?'); values.push(n);
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });
  values.push(dayId);
  db.prepare(`UPDATE program_days SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT * FROM program_days WHERE id = ?').get(dayId));
});

// Delete a day (cascades to exercises)
router.delete('/:id/days/:dayId', (req, res) => {
  const dayId = Number(req.params.dayId);
  if (!ownsDay(req.profileId, dayId)) return res.status(404).json({ error: 'day not found' });
  db.prepare('DELETE FROM program_days WHERE id = ?').run(dayId);
  res.json({ deleted: true });
});

// Duplicate a program (with all days + exercises) under a new name
router.post('/:id/duplicate', (req, res) => {
  const srcId = Number(req.params.id);
  const { name } = req.body || {};
  const src = db.prepare('SELECT * FROM programs WHERE id = ? AND profile_id = ?').get(srcId, req.profileId);
  if (!src) return res.status(404).json({ error: 'program not found' });

  const newName = (name && String(name).trim()) || `Copy of ${src.name}`;

  try {
    const newId = tx(() => {
      const info = db
        .prepare('INSERT INTO programs (profile_id, name, description) VALUES (?, ?, ?)')
        .run(req.profileId, newName, src.description);
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
        'INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index, rest_seconds) VALUES (?, ?, ?, ?, ?, ?)'
      );

      for (const d of days) {
        const newDayId = Number(insertDay.run(programId, d.day_label, d.day_order).lastInsertRowid);
        for (const e of srcEx.all(d.id)) {
          insertEx.run(newDayId, e.exercise_id, e.target_sets, e.target_reps, e.order_index, e.rest_seconds ?? null);
        }
      }
      return programId;
    });
    const row = db.prepare('SELECT id, name, description FROM programs WHERE id = ?').get(newId);
    res.status(201).json(row);
  } catch (err) {
    console.error(err); res.status(500).json({ error: 'internal server error' });
  }
});

// Reorder every program for this profile atomically, from a full ordered id
// list — same rationale as the day/exercise reorder endpoints: N independent
// sort_order PATCHes have no atomicity. Registered BEFORE the /:id route
// below — otherwise Express would match "reorder" as an :id param first.
router.patch('/reorder', (req, res) => {
  const programIds = (req.body && req.body.program_ids || []).map(Number);
  if (!programIds.length || programIds.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'program_ids must be a non-empty array of ids' });
  }

  const currentIds = db.prepare('SELECT id FROM programs WHERE profile_id = ?').all(req.profileId).map((r) => r.id);
  const sameSet = currentIds.length === programIds.length && new Set(currentIds).size === new Set(programIds).size &&
    programIds.every((id) => currentIds.includes(id));
  if (!sameSet) return res.status(409).json({ error: 'program list is out of date — reload and try again' });

  const upd = db.prepare('UPDATE programs SET sort_order = ? WHERE id = ?');
  tx(() => { programIds.forEach((id, i) => upd.run(i, id)); });

  res.json({ reordered: true });
});

// Rename / update a program
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM programs WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'program not found' });
  const fields = ['name', 'description', 'sort_order'];
  const updates = [];
  const values = [];
  for (const f of fields) {
    if (f in (req.body || {})) {
      updates.push(`${f} = ?`);
      values.push(f === 'sort_order' ? Number(req.body[f]) : req.body[f]);
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
  const result = db.prepare('DELETE FROM programs WHERE id = ? AND profile_id = ?').run(id, req.profileId);
  if (result.changes === 0) return res.status(404).json({ error: 'program not found' });
  res.json({ deleted: true });
});

router.get('/', (req, res) => {
  const rows = db.prepare('SELECT id, name, description FROM programs WHERE profile_id = ? ORDER BY COALESCE(sort_order, id), id').all(req.profileId);
  res.json(rows);
});

// Direct day lookup by id — lets the workout screen fetch a program day's
// exercises in one request instead of listing every program and fetching
// each one in turn until the matching day turns up (that scaled with total
// program count, not with anything relevant to the workout being started).
router.get('/days/:dayId', (req, res) => {
  const dayId = Number(req.params.dayId);
  const day = db.prepare(
    `SELECT pd.*, p.name as program_name
     FROM program_days pd
     JOIN programs p ON p.id = pd.program_id
     WHERE pd.id = ? AND p.profile_id = ?`
  ).get(dayId, req.profileId);
  if (!day) return res.status(404).json({ error: 'program day not found' });

  day.exercises = db.prepare(`
    SELECT pde.id, pde.target_sets, pde.target_reps, pde.order_index, pde.rest_seconds,
           e.id as exercise_id, e.name, e.muscle_group, e.sub_muscle, e.notes, e.is_bodyweight, e.is_assisted, e.equipment, e.weight_mode, e.step_override, e.rep_min, e.rep_max
    FROM program_day_exercises pde
    JOIN exercises e ON e.id = pde.exercise_id
    WHERE pde.program_day_id = ?
    ORDER BY pde.order_index
  `).all(dayId);

  res.json(day);
});

router.get('/:id', (req, res) => {
  const id = Number(req.params.id);
  const program = db.prepare('SELECT * FROM programs WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!program) return res.status(404).json({ error: 'program not found' });

  const days = db
    .prepare('SELECT * FROM program_days WHERE program_id = ? ORDER BY day_order')
    .all(id);

  const dayExStmt = db.prepare(`
    SELECT pde.id, pde.target_sets, pde.target_reps, pde.order_index, pde.rest_seconds,
           e.id as exercise_id, e.name, e.muscle_group, e.sub_muscle, e.notes, e.is_bodyweight, e.is_assisted, e.equipment, e.weight_mode, e.step_override, e.rep_min, e.rep_max
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
  const { exercise_id, target_sets = 2, target_reps = 8, rest_seconds = null } = req.body || {};
  if (!exercise_id) return res.status(400).json({ error: 'exercise_id is required' });

  if (!ownsDay(req.profileId, dayId)) return res.status(404).json({ error: 'program day not found' });

  const maxOrder =
    db
      .prepare('SELECT COALESCE(MAX(order_index), -1) as m FROM program_day_exercises WHERE program_day_id = ?')
      .get(dayId).m + 1;

  let info;
  try {
    info = db
      .prepare(
        `INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index, rest_seconds)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(dayId, exercise_id, target_sets, target_reps, maxOrder, rest_seconds);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That exercise is already in this day' });
    }
    throw err;
  }

  const row = db
    .prepare(
      `SELECT pde.id, pde.target_sets, pde.target_reps, pde.order_index, pde.rest_seconds,
              e.id as exercise_id, e.name, e.muscle_group, e.sub_muscle, e.notes, e.is_bodyweight, e.is_assisted, e.equipment, e.weight_mode, e.step_override, e.rep_min, e.rep_max
       FROM program_day_exercises pde
       JOIN exercises e ON e.id = pde.exercise_id
       WHERE pde.id = ?`
    )
    .get(Number(info.lastInsertRowid));
  res.status(201).json(row);
});

// Replace a day's entire exercise list atomically — used by "Save as template"
// to overwrite the day with exactly what was done in a session.
router.put('/:programId/days/:dayId/exercises', (req, res) => {
  const dayId = Number(req.params.dayId);
  const { exercises } = req.body || {};
  if (!Array.isArray(exercises)) return res.status(400).json({ error: 'exercises array required' });

  if (!ownsDay(req.profileId, dayId)) return res.status(404).json({ error: 'program day not found' });

  try {
    tx(() => {
      db.prepare('DELETE FROM program_day_exercises WHERE program_day_id = ?').run(dayId);
      const ins = db.prepare(
        `INSERT INTO program_day_exercises (program_day_id, exercise_id, target_sets, target_reps, order_index, rest_seconds)
         VALUES (?, ?, ?, ?, ?, ?)`
      );
      const seen = new Set();
      let i = 0;
      for (const e of exercises) {
        if (!e.exercise_id || seen.has(e.exercise_id)) continue;
        seen.add(e.exercise_id);
        ins.run(dayId, e.exercise_id, e.target_sets ?? 2, e.target_reps ?? 8, i, e.rest_seconds ?? null);
        i++;
      }
    });
  } catch (err) {
    console.error(err); return res.status(500).json({ error: 'internal server error' });
  }

  const rows = db
    .prepare(
      `SELECT pde.id, pde.target_sets, pde.target_reps, pde.order_index, pde.rest_seconds,
              e.id as exercise_id, e.name, e.muscle_group, e.sub_muscle, e.notes, e.is_bodyweight, e.is_assisted, e.equipment, e.weight_mode, e.step_override, e.rep_min, e.rep_max
       FROM program_day_exercises pde
       JOIN exercises e ON e.id = pde.exercise_id
       WHERE pde.program_day_id = ?
       ORDER BY pde.order_index`
    )
    .all(dayId);
  res.json({ day_id: dayId, exercises: rows });
});

// Reorder every exercise slot within a day atomically, from a full ordered
// id list — same rationale as the day-reorder endpoint above: N independent
// order_index PATCHes have no atomicity, so a dropped request mid-batch or
// two tabs reordering the same day concurrently can leave two slots sharing
// an order_index. Registered BEFORE the /:pdeId route below — otherwise
// Express would match "reorder" as a :pdeId param first.
router.patch('/:programId/days/:dayId/exercises/reorder', (req, res) => {
  const dayId = Number(req.params.dayId);
  if (!ownsDay(req.profileId, dayId)) return res.status(404).json({ error: 'day not found' });

  const pdeIds = (req.body && req.body.pde_ids || []).map(Number);
  if (!pdeIds.length || pdeIds.some((id) => !Number.isInteger(id))) {
    return res.status(400).json({ error: 'pde_ids must be a non-empty array of ids' });
  }

  const currentIds = db.prepare('SELECT id FROM program_day_exercises WHERE program_day_id = ?').all(dayId).map((r) => r.id);
  const sameSet = currentIds.length === pdeIds.length && new Set(currentIds).size === new Set(pdeIds).size &&
    pdeIds.every((id) => currentIds.includes(id));
  if (!sameSet) return res.status(409).json({ error: 'exercise list is out of date — reload and try again' });

  const upd = db.prepare('UPDATE program_day_exercises SET order_index = ? WHERE id = ?');
  tx(() => { pdeIds.forEach((id, i) => upd.run(i, id)); });

  res.json({ reordered: true });
});

// Update a program day exercise (sets, reps, swap exercise, reorder)
router.patch('/:programId/days/:dayId/exercises/:pdeId', (req, res) => {
  const pdeId = Number(req.params.pdeId);
  const existing = db.prepare('SELECT * FROM program_day_exercises WHERE id = ?').get(pdeId);
  if (!existing || !ownsPde(req.profileId, pdeId)) return res.status(404).json({ error: 'entry not found' });

  const fields = ['target_sets', 'target_reps', 'exercise_id', 'order_index', 'rest_seconds'];
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

  try {
    db.prepare(`UPDATE program_day_exercises SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  } catch (err) {
    if (String(err.message).includes('UNIQUE')) {
      return res.status(409).json({ error: 'That exercise is already in this day' });
    }
    throw err;
  }

  const row = db
    .prepare(
      `SELECT pde.id, pde.target_sets, pde.target_reps, pde.order_index, pde.rest_seconds,
              e.id as exercise_id, e.name, e.muscle_group, e.sub_muscle, e.notes, e.is_bodyweight, e.is_assisted, e.equipment, e.weight_mode, e.step_override, e.rep_min, e.rep_max
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
  if (!ownsPde(req.profileId, pdeId)) return res.status(404).json({ error: 'entry not found' });
  db.prepare('DELETE FROM program_day_exercises WHERE id = ?').run(pdeId);
  res.json({ deleted: true });
});

module.exports = router;
