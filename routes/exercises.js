const express = require('express');
const { db } = require('../db');

const router = express.Router();

router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT id, name, muscle_group, notes FROM exercises ORDER BY muscle_group, name')
    .all();
  res.json(rows);
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
