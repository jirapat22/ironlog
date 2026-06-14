'use strict';

const express = require('express');
const accounts = require('../accounts');
const {
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  requireProfile
} = require('../auth');

const router = express.Router();

// ---------------------------------------------------------------------------
// Public endpoints (no session required)
// ---------------------------------------------------------------------------

// Whether any profile exists yet — lets the lock screen tailor its copy
// (first-run "create a profile" vs "enter your passcode").
router.get('/status', (req, res) => {
  const token = getSessionToken(req);
  const profile = token ? accounts.getProfileBySession(token) : null;
  res.json({
    authenticated: !!profile,
    has_profiles: accounts.countProfiles() > 0,
    profile: profile ? accounts.publicProfile(profile) : null
  });
});

// Log in with a 4-digit passcode. Resolves the code to its owning profile.
router.post('/login', (req, res) => {
  const { passcode } = req.body || {};
  const profile = accounts.findProfileByPasscode(passcode);
  if (!profile) {
    return res.status(401).json({ error: 'incorrect passcode' });
  }
  const token = accounts.createSession(profile.id);
  setSessionCookie(res, token);
  res.json({ profile: accounts.publicProfile(profile) });
});

// Create a new profile (name + accent colour + 4-digit passcode) and log in.
router.post('/profiles', (req, res) => {
  const { name, passcode, accent_color } = req.body || {};
  const result = accounts.createProfile({ name, passcode, accent_color });
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  const token = accounts.createSession(result.profile.id);
  setSessionCookie(res, token);
  res.status(201).json({ profile: accounts.publicProfile(result.profile) });
});

// ---------------------------------------------------------------------------
// Guarded endpoints (require a valid session)
// ---------------------------------------------------------------------------
router.get('/me', requireProfile, (req, res) => {
  res.json({ profile: accounts.publicProfile(req.profile) });
});

router.patch('/me', requireProfile, (req, res) => {
  const { name, accent_color } = req.body || {};
  const result = accounts.updateProfile(req.profileId, { name, accent_color });
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  res.json({ profile: accounts.publicProfile(result.profile) });
});

router.post('/me/passcode', requireProfile, (req, res) => {
  const { passcode } = req.body || {};
  const result = accounts.setPasscode(req.profileId, passcode);
  if (result.error) {
    return res.status(result.status || 400).json({ error: result.error });
  }
  res.json({ ok: true });
});

// Rotate the API key. The user must re-paste it into Plated afterwards.
router.post('/me/api-key', requireProfile, (req, res) => {
  const apiKey = accounts.regenerateApiKey(req.profileId);
  res.json({ api_key: apiKey });
});

router.delete('/me', requireProfile, (req, res) => {
  accounts.deleteProfile(req.profileId);
  clearSessionCookie(res);
  res.json({ deleted: true });
});

router.post('/logout', requireProfile, (req, res) => {
  accounts.deleteSession(getSessionToken(req));
  clearSessionCookie(res);
  res.json({ ok: true });
});

module.exports = router;
