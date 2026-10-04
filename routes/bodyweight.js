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
    .prepare('SELECT id, weight, weight_unit, logged_at, notes, source FROM bodyweights WHERE profile_id = ? ORDER BY logged_at DESC')
    .all(req.profileId);
  res.json(rows);
});

// ?tzOffset= is minutes EAST of UTC (i.e. -getTimezoneOffset()), matching
// /api/calendar and the volume endpoints. Not the raw getTimezoneOffset that
// /api/plated/* takes under ?tz= — the two conventions are opposite signs, and
// getting it backwards here would bucket a weigh-in a day early, which is
// exactly the failure Plated reported hitting from the other direction.
function tzModFromOffset(offsetMin) {
  const clamped = Math.max(-840, Math.min(840, Math.trunc(offsetMin)));
  return `${clamped >= 0 ? '+' : ''}${clamped} minutes`;
}

router.post('/', (req, res) => {
  const { weight, weight_unit = 'kg', notes = null, logged_at = null } = req.body || {};
  const err = validateBodyweightFields({ weight, weight_unit, logged_at }, { requireWeight: true });
  if (err) return res.status(400).json({ error: err });

  const tz = Number(req.query.tzOffset);
  const mod = tzModFromOffset(Number.isFinite(tz) ? tz : 0);

  // One weigh-in per LOCAL day, whatever wrote it. Previously this was a plain
  // INSERT while Plated's own writer deduped only against its own rows, so a
  // weigh-in entered on each side of the integration on the same day left two
  // rows for that date: the chart drew two points and "current weight" (newest
  // logged_at wins) silently picked whichever landed later. Plated confirmed it
  // never wants more than one reading per day.
  //
  // Local day, not the UTC date of logged_at: a 7am NZ weigh-in stores as
  // ~19:00 UTC the previous day, so bucketing on the raw timestamp files it
  // under the wrong date for anyone east of UTC.
  const existing = db
    .prepare(
      `SELECT id FROM bodyweights
        WHERE profile_id = ?
          AND date(logged_at, ?) = date(COALESCE(?, datetime('now')), ?)`
    )
    .get(req.profileId, mod, logged_at, mod);

  // A human typing a weight into this app OWNS that day's reading from then
  // on — source becomes 'manual' even if Plated wrote the row originally.
  // Plated's writer respects that (it skips a day that holds a manual row),
  // which is the mirror of its own rule that it only corrects rows it
  // sourced. Without this, correcting a Plated-pushed figure here was
  // undone by the next sync.
  let id;
  if (existing) {
    // The newer reading replaces the day's value rather than joining it. Keeps
    // a correction propagating instead of leaving two rows to disagree.
    db.prepare(
      `UPDATE bodyweights SET weight = ?, weight_unit = ?, notes = ?, source = 'manual',
              logged_at = COALESCE(?, datetime('now'))
        WHERE id = ?`
    ).run(Number(weight), weight_unit, notes, logged_at, existing.id);
    id = existing.id;
  } else if (logged_at) {
    id = Number(db
      .prepare("INSERT INTO bodyweights (weight, weight_unit, notes, logged_at, profile_id, source) VALUES (?, ?, ?, ?, ?, 'manual')")
      .run(Number(weight), weight_unit, notes, logged_at, req.profileId).lastInsertRowid);
  } else {
    id = Number(db
      .prepare("INSERT INTO bodyweights (weight, weight_unit, notes, profile_id, source) VALUES (?, ?, ?, ?, 'manual')")
      .run(Number(weight), weight_unit, notes, req.profileId).lastInsertRowid);
  }
  const row = db.prepare('SELECT * FROM bodyweights WHERE id = ?').get(id);
  res.status(existing ? 200 : 201).json(row);
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
  // Editing the weight itself is a human taking ownership of the day, same as
  // POST above. Editing only the note is not — renaming a note shouldn't stop
  // Plated keeping its own row current.
  if ('weight' in (req.body || {})) updates.push("source = 'manual'");
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
