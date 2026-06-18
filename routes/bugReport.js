/**
 * POST /api/bug-report — capture an error (frontend, backend, or manual) and
 * forward it to Orbit. Mounted before the session gate so it works even on
 * the lock screen (uses optionalProfile, so profile_id may be null).
 */

'use strict';

const express = require('express');
const { recordBugReport } = require('../lib/bugReports');

const router = express.Router();

router.post('/', (req, res) => {
  const { source, message, stack, context, type } = req.body || {};
  if (!message || !String(message).trim()) {
    return res.status(400).json({ error: 'message is required' });
  }
  const result = recordBugReport({ profileId: req.profileId || null, source, message, stack, context, type });
  res.status(202).json({ received: true, deduped: !!result.deduped });
});

module.exports = router;
