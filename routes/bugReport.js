/**
 * POST /api/bug-report — capture an error (frontend, backend, or manual) and
 * forward it to Orbit. Mounted before the session gate so it works even on
 * the lock screen (uses optionalProfile, so profile_id may be null).
 */

'use strict';

const express = require('express');
const { db } = require('../db');
const { sendBugReportToOrbit } = require('../lib/orbitReport');

const router = express.Router();

const SOURCES = ['frontend', 'backend', 'manual'];
const DEDUPE_WINDOW_SECONDS = 300; // 5 minutes

router.post('/', async (req, res) => {
  const { source, message, stack, context } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  const src = SOURCES.includes(source) ? source : 'frontend';
  const msg = String(message).trim().slice(0, 2000);
  const stk = stack ? String(stack).slice(0, 8000) : null;
  const ctxStr = context ? JSON.stringify(context).slice(0, 4000) : null;

  // Dedupe identical reports (same source+message+stack) within a short
  // window so a tight error loop doesn't spam Orbit / fill the table.
  const dupe = db
    .prepare(
      `SELECT id FROM bug_reports
       WHERE source = ? AND message = ? AND IFNULL(stack, '') = IFNULL(?, '')
         AND created_at >= datetime('now', ?)
       ORDER BY id DESC LIMIT 1`
    )
    .get(src, msg, stk, `-${DEDUPE_WINDOW_SECONDS} seconds`);
  if (dupe) return res.status(202).json({ received: true, deduped: true });

  const info = db
    .prepare(
      'INSERT INTO bug_reports (profile_id, source, message, stack, context) VALUES (?, ?, ?, ?, ?)'
    )
    .run(req.profileId || null, src, msg, stk, ctxStr);

  res.status(202).json({ received: true });

  // Forward to Orbit after responding — never block the caller on it.
  const result = await sendBugReportToOrbit({
    source: src,
    message: msg,
    stack: stk,
    context: context || null,
    created_at: new Date().toISOString()
  });
  if (result.sent) {
    db.prepare('UPDATE bug_reports SET orbit_sent = 1 WHERE id = ?').run(Number(info.lastInsertRowid));
  }
});

module.exports = router;
