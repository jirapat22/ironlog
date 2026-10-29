'use strict';

// I.O. — Pat's Discord assistant — runs a training coach in his #ironlog
// channel: a Sunday check-in plus answers to "what should I train today?".
// It needs to READ the last few weeks; it never writes anything here.
//
// Its own key (IO_API_KEY), pinned to one profile (IO_PROFILE_ID), failing
// closed when either is unset. Not the profile's Plated API key: that one can
// write (POST /api/plated/profile, /bodyweight), and the coach only reads.

const crypto = require('crypto');
const express = require('express');
const { db } = require('../db');
const { weeklySummary } = require('../lib/weekly');
const { buildProfilePayload } = require('./plated');

const router = express.Router();
const WEEK_MS = 7 * 24 * 60 * 60 * 1000;

function sameKey(given, required) {
  // Hash both to a fixed length so timingSafeEqual can't throw on a length
  // mismatch, and the compare time says nothing about how close a guess was.
  const a = crypto.createHash('sha256').update(String(given || '')).digest();
  const b = crypto.createHash('sha256').update(required).digest();
  return crypto.timingSafeEqual(a, b);
}

router.use((req, res, next) => {
  const required = (process.env.IO_API_KEY || '').trim();
  const pid = parseInt(process.env.IO_PROFILE_ID, 10);
  if (!required || !(pid > 0)) return res.status(503).json({ error: 'I.O. access is not configured' });
  if (!req.headers['x-io-key'] || !sameKey(req.headers['x-io-key'], required)) {
    return res.status(401).json({ error: 'invalid or missing I.O. key' });
  }
  req.profileId = pid;
  next();
});

// GET /api/io/coach?weeks=4&to=<ISO> — the last N weekly summaries (same numbers
// as the Obsidian weekly export), body weights over the same span, and the
// profile's goal/TDEE. `to` is the end of the latest week (exclusive), worked
// out by I.O. in NZ time; it defaults to now.
router.get('/coach', (req, res) => {
  const weeks = Math.min(Math.max(parseInt(req.query.weeks, 10) || 4, 1), 12);
  const to = req.query.to ? new Date(req.query.to) : new Date();
  if (Number.isNaN(to.getTime())) return res.status(400).json({ error: 'to must be a date' });
  try {
    const summaries = [];
    for (let i = weeks - 1; i >= 0; i--) {
      const end = new Date(to.getTime() - i * WEEK_MS);
      const start = new Date(end.getTime() - WEEK_MS);
      summaries.push({ from: start.toISOString(), to: end.toISOString(),
                       ...weeklySummary(req.profileId, start.toISOString(), end.toISOString()) });
    }
    const since = new Date(to.getTime() - weeks * WEEK_MS).toISOString().slice(0, 19).replace('T', ' ');
    const bodyweights = db.prepare(
      `SELECT weight, weight_unit, logged_at FROM bodyweights
       WHERE profile_id = ? AND logged_at >= ? ORDER BY logged_at`
    ).all(req.profileId, since);
    let profile = null;
    try { profile = buildProfilePayload(req.profileId); } catch { /* profile incomplete: coach copes */ }
    res.json({ weeks: summaries, bodyweights, profile });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'internal server error' });
  }
});

module.exports = router;
