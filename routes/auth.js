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
// Simple in-memory rate limiter — 10 attempts per 15 minutes per IP.
// Protects login and profile-creation from brute-force (4-digit PINs have
// only 10 000 combinations).
// ---------------------------------------------------------------------------
const loginAttempts = new Map();
const RATE_WINDOW_MS = 15 * 60 * 1000;
const RATE_MAX = 10;

function checkRateLimit(ip) {
  const now = Date.now();
  // This endpoint is internet-reachable with no IP allowlist, so it gets
  // scanned/probed over the app's lifetime — sweep expired entries
  // opportunistically (not every call — this is a hot-ish path) so the map
  // doesn't grow unbounded between restarts.
  if (Math.random() < 0.02) {
    for (const [k, v] of loginAttempts) if (now > v.resetAt) loginAttempts.delete(k);
  }
  let entry = loginAttempts.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 0, resetAt: now + RATE_WINDOW_MS };
  }
  if (entry.count >= RATE_MAX) {
    loginAttempts.set(ip, entry);
    return false;
  }
  entry.count++;
  loginAttempts.set(ip, entry);
  return true;
}

// ---------------------------------------------------------------------------
// Global (cross-IP) failed-login lockout. The per-IP limiter above caps any
// ONE IP at 10 attempts/15min, but a 4-digit PIN's full keyspace (10 000
// codes) is still crackable by spreading guesses across many source IPs —
// trivial with cloud egress or IPv6 rotation, and a correct guess there is a
// full account takeover, not mere noise. This counts only FAILED attempts
// (a real user's own successful login never contributes) app-wide, so even a
// distributed attacker is capped at the same total guess budget as a single
// attacker would be.
// ---------------------------------------------------------------------------
const GLOBAL_FAIL_WINDOW_MS = 15 * 60 * 1000;
const GLOBAL_FAIL_MAX = 20;
let globalFailures = { count: 0, resetAt: 0 };

function globalLockoutActive() {
  const now = Date.now();
  if (now > globalFailures.resetAt) globalFailures = { count: 0, resetAt: now + GLOBAL_FAIL_WINDOW_MS };
  return globalFailures.count >= GLOBAL_FAIL_MAX;
}

function recordGlobalLoginFailure() {
  const now = Date.now();
  if (now > globalFailures.resetAt) globalFailures = { count: 0, resetAt: now + GLOBAL_FAIL_WINDOW_MS };
  globalFailures.count++;
}

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
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'too many attempts — try again in 15 minutes' });
  }
  if (globalLockoutActive()) {
    return res.status(429).json({ error: 'too many failed attempts — try again in 15 minutes' });
  }
  const { passcode } = req.body || {};
  const profile = accounts.findProfileByPasscode(passcode);
  if (!profile) {
    recordGlobalLoginFailure();
    return res.status(401).json({ error: 'incorrect passcode' });
  }
  const token = accounts.createSession(profile.id);
  setSessionCookie(res, token);
  res.json({ profile: accounts.publicProfile(profile) });
});

// Create a new profile (name + accent colour + 4-digit passcode) and log in.
router.post('/profiles', (req, res) => {
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'too many attempts — try again in 15 minutes' });
  }
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

// Retrieve the current API key (never included in publicProfile to limit exposure).
router.get('/me/api-key', requireProfile, (req, res) => {
  res.json({ api_key: req.profile.api_key });
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
