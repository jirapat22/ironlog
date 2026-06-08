const crypto = require('crypto');

// Constant-time comparison that tolerates differing lengths by hashing first.
// (crypto.timingSafeEqual throws on length mismatch and would otherwise leak
// length through an early return.)
function safeEqual(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

// HTTP Basic Auth gate for the human-facing app + API. The browser handles the
// credential prompt natively, so no login UI is needed and same-origin PWA
// fetches carry the header automatically. Enabled only when APP_PASSWORD is
// set, so local dev stays frictionless and existing deploys can opt in.
function basicAuth(req, res, next) {
  const password = process.env.APP_PASSWORD;
  if (!password) return next(); // auth disabled
  const user = process.env.APP_USER || 'admin';

  const [scheme, encoded] = (req.headers.authorization || '').split(' ');
  if (scheme === 'Basic' && encoded) {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    const idx = decoded.indexOf(':');
    const u = decoded.slice(0, idx);
    const p = decoded.slice(idx + 1);
    // Evaluate both halves before returning so timing doesn't reveal which failed.
    const ok = safeEqual(u, user) & safeEqual(p, password);
    if (ok) return next();
  }
  res.set('WWW-Authenticate', 'Basic realm="IronLog", charset="UTF-8"');
  return res.status(401).json({ error: 'Authentication required' });
}

// Machine-to-machine key check for the Plated integration. Accepts either an
// `Authorization: Bearer <key>` or `X-API-Key` header. Enabled only when
// PLATED_API_KEY is set. Must run AFTER the CORS/OPTIONS handler so preflight
// requests are never rejected.
function platedAuth(req, res, next) {
  const key = process.env.PLATED_API_KEY;
  if (!key) return next(); // not configured → no key required (back-compat)
  const provided =
    (req.headers.authorization || '').replace(/^Bearer\s+/i, '') ||
    req.headers['x-api-key'] ||
    '';
  if (provided && safeEqual(provided, key)) return next();
  return res.status(401).json({ success: false, error: 'invalid or missing API key' });
}

module.exports = { basicAuth, platedAuth, safeEqual };
