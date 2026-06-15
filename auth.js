'use strict';

const accounts = require('./accounts');

const SESSION_COOKIE = 'il_session';

// Minimal cookie parser — avoids pulling in cookie-parser for one cookie.
function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}

function setSessionCookie(res, token) {
  const parts = [
    `${SESSION_COOKIE}=${token}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${accounts.SESSION_MAX_AGE_DAYS * 24 * 60 * 60}`
  ];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(res) {
  const parts = [`${SESSION_COOKIE}=`, 'Path=/', 'HttpOnly', 'SameSite=Lax', 'Max-Age=0'];
  if (process.env.NODE_ENV === 'production') parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}

function getSessionToken(req) {
  return parseCookies(req)[SESSION_COOKIE] || null;
}

// Gate for the human-facing app + API. Validates the session cookie and sets
// req.profileId / req.profile. Replaces the old HTTP Basic Auth gate.
function requireProfile(req, res, next) {
  const token = getSessionToken(req);
  const profile = token ? accounts.getProfileBySession(token) : null;
  if (!profile) {
    return res.status(401).json({ error: 'authentication required' });
  }
  req.profileId = profile.id;
  req.profile = profile;
  next();
}

// Best-effort gate: sets req.profileId/req.profile when a valid session
// cookie is present, but never rejects. Used by routes (e.g. bug reports)
// that must work even pre-login (lock screen errors).
function optionalProfile(req, res, next) {
  const token = getSessionToken(req);
  const profile = token ? accounts.getProfileBySession(token) : null;
  if (profile) {
    req.profileId = profile.id;
    req.profile = profile;
  }
  next();
}

// Machine-to-machine key check for the Plated integration and any other
// API-key caller. Reads `X-API-Key` (preferred) or `Authorization: Bearer`,
// resolves it to a profile, and sets req.profileId. Never reads the query
// string. Missing/unknown key -> 401 with the exact Plated error contract.
function platedAuth(req, res, next) {
  const provided = (
    req.headers['x-api-key'] ||
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    ''
  ).trim();
  const profile = provided ? accounts.findProfileByApiKey(provided) : null;
  if (!profile) {
    return res.status(401).json({ success: false, error: 'invalid or missing API key' });
  }
  req.profileId = profile.id;
  req.profile = profile;
  next();
}

module.exports = {
  SESSION_COOKIE,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  getSessionToken,
  requireProfile,
  optionalProfile,
  platedAuth
};
