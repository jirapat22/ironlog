'use strict';

// Polar watch connection for the signed-in profile (see lib/polar.js).
// Mounted behind the session gate, so everything here is scoped to req.profileId.
// The one route Polar itself calls back to, /polar/callback, is in server.js:
// it arrives from Polar's site and is tied to a profile by the `state` below.

const crypto = require('crypto');
const express = require('express');
const polar = require('../lib/polar');

const router = express.Router();

// state → { profileId, at }. A random one-time value per "Connect" tap, so the
// callback knows which profile said yes, and nobody can link their Polar
// account to someone else's profile. In memory: a restart just means tapping Connect again.
const pending = new Map();
const STATE_TTL_MS = 10 * 60 * 1000;          // Polar's code also dies after 10 minutes

function takeState(state) {
  const hit = pending.get(state);
  pending.delete(state);
  return hit && Date.now() - hit.at < STATE_TTL_MS ? hit.profileId : null;
}

router.get('/status', (req, res) => {
  const l = polar.link(req.profileId);
  res.json({
    available: polar.configured(),
    connected: !!l,
    last_sync_at: l?.last_sync_at || null,
    last_error: l?.last_error || null
  });
});

// The app then sends the browser to this URL (Polar's "Allow Ironlog?" page).
router.post('/connect', (req, res) => {
  if (!polar.configured()) return res.status(503).json({ error: 'Polar is not set up on the server' });
  for (const [k, v] of pending) if (Date.now() - v.at > STATE_TTL_MS) pending.delete(k);
  const state = crypto.randomBytes(16).toString('hex');
  pending.set(state, { profileId: req.profileId, at: Date.now() });
  res.json({ url: polar.authUrl(state) });
});

router.post('/sync', async (req, res) => {
  if (!polar.link(req.profileId)) return res.status(404).json({ error: 'Polar is not connected' });
  try {
    res.json({ saved: await polar.sync(req.profileId) });
  } catch (err) {
    res.status(502).json({ error: polar.link(req.profileId)?.last_error || 'Polar did not answer' });
  }
});

router.delete('/', async (req, res) => {
  await polar.disconnect(req.profileId);
  res.json({ ok: true });
});

module.exports = router;
module.exports.takeState = takeState;
module.exports._pending = pending;
