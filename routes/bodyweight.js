const express = require('express');
const { db } = require('../db');

const router = express.Router();

// Shared by POST and PATCH so an update can't silently persist a value POST
// would have rejected (e.g. a bogus weight_unit like "stone" that every
// toKg()-style helper downstream just treats as kg).
function validateBodyweightFields({ weight, weight_unit, logged_at }, { requireWeight = false } = {}) {
  if (weight !== undefined || requireWeight) {
    const w = Number(weight);
    if (!Number.isFinite(w) || w <= 0) return 'weight must be a positive number';
  }
  if (weight_unit !== undefined && !['kg', 'lbs'].includes(weight_unit)) {
    return 'weight_unit must be kg or lbs';
  }
  if (logged_at && !/^\d{4}-\d{2}-\d{2}([ T]\d{2}:\d{2}(:\d{2})?)?$/.test(String(logged_at))) {
    return 'logged_at must be a valid date string (YYYY-MM-DD)';
  }
  return null;
}

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT id, weight, weight_unit, logged_at, notes FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC')
    .all(req.profileId);
  res.json(rows);
});

router.post('/', (req, res) => {
  const { weight, weight_unit = 'kg', notes = null, logged_at = null } = req.body || {};
  const err = validateBodyweightFields({ weight, weight_unit, logged_at }, { requireWeight: true });
  if (err) return res.status(400).json({ error: err });

  let info;
  if (logged_at) {
    info = db
      .prepare('INSERT INTO bodyweights (weight, weight_unit, notes, logged_at, profile_id) VALUES (?, ?, ?, ?, ?)')
      .run(Number(weight), weight_unit, notes, logged_at, req.profileId);
  } else {
    info = db
      .prepare('INSERT INTO bodyweights (weight, weight_unit, notes, profile_id) VALUES (?, ?, ?, ?)')
      .run(Number(weight), weight_unit, notes, req.profileId);
  }
  const row = db.prepare('SELECT * FROM bodyweights WHERE id = ?').get(Number(info.lastInsertRowid));
  res.status(201).json(row);
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM bodyweights WHERE id = ? AND profile_id = ?').get(id, req.profileId);
  if (!existing) return res.status(404).json({ error: 'entry not found' });

  const err = validateBodyweightFields(req.body || {});
  if (err) return res.status(400).json({ error: err });

  const fields = ['weight', 'weight_unit', 'notes', 'logged_at'];
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
  db.prepare(`UPDATE bodyweights SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  const row = db.prepare('SELECT * FROM bodyweights WHERE id = ?').get(id);
  res.json(row);
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM bodyweights WHERE id = ? AND profile_id = ?').run(id, req.profileId);
  if (result.changes === 0) return res.status(404).json({ error: 'entry not found' });
  res.json({ deleted: true });
});

module.exports = router;
