const express = require('express');
const { db } = require('../db');

const router = express.Router();

const CATEGORIES = ['idea', 'bug'];

// List notes: open items first (newest first), completed ones at the bottom.
router.get('/', (req, res) => {
  const rows = db
    .prepare('SELECT id, text, category, done, created_at FROM notes ORDER BY done ASC, created_at DESC')
    .all();
  res.json(rows);
});

router.post('/', (req, res) => {
  const { text, category = 'idea' } = req.body || {};
  if (!text || !String(text).trim()) return res.status(400).json({ error: 'text is required' });
  const cat = CATEGORIES.includes(category) ? category : 'idea';
  const info = db
    .prepare('INSERT INTO notes (text, category) VALUES (?, ?)')
    .run(String(text).trim(), cat);
  const row = db.prepare('SELECT id, text, category, done, created_at FROM notes WHERE id = ?').get(Number(info.lastInsertRowid));
  res.status(201).json(row);
});

router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT * FROM notes WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'note not found' });

  const updates = [];
  const values = [];
  if ('text' in (req.body || {})) {
    if (!String(req.body.text).trim()) return res.status(400).json({ error: 'text cannot be empty' });
    updates.push('text = ?'); values.push(String(req.body.text).trim());
  }
  if ('category' in (req.body || {})) {
    updates.push('category = ?'); values.push(CATEGORIES.includes(req.body.category) ? req.body.category : 'idea');
  }
  if ('done' in (req.body || {})) {
    updates.push('done = ?'); values.push(req.body.done ? 1 : 0);
  }
  if (!updates.length) return res.status(400).json({ error: 'no fields to update' });

  values.push(id);
  db.prepare(`UPDATE notes SET ${updates.join(', ')} WHERE id = ?`).run(...values);
  res.json(db.prepare('SELECT id, text, category, done, created_at FROM notes WHERE id = ?').get(id));
});

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const result = db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  if (result.changes === 0) return res.status(404).json({ error: 'note not found' });
  res.json({ deleted: true });
});

module.exports = router;
