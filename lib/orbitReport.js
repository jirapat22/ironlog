/**
 * Forward a bug report to Orbit. Best-effort: if ORBIT_URL isn't set, or the
 * request fails, the caller still keeps its own local copy (bug_reports table).
 *
 * Orbit-side contract (POST {ORBIT_URL}/api/bug-reports): { app: 'ironlog',
 * type: 'bug_report', message, stack, context, created_at }. Auth:
 * INGEST_SECRET, sent as X-API-Key.
 */

'use strict';

const ORBIT_URL = (process.env.ORBIT_URL || '').trim().replace(/\/+$/, '');
const INGEST_SECRET = (process.env.INGEST_SECRET || '').trim();

// Orbit sleeps on Railway now, so the first report after a quiet period pays
// a container start. 5 seconds with no retry was shorter than that start, and
// a dropped bug report is the one thing here most worth keeping — IronLog's
// own copy survives either way (bugReports.js inserts before calling this),
// but Orbit then only learns of it whenever its reconcile next pulls
// /api/orbit. Same shape Plated adopted for its calls to us.
//
// Retries ONLY where a retry can help: the request never got an answer, or a
// proxy answered for a backend that was not up yet. A 4xx is Orbit rejecting
// the payload and will reject it again.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const TIMEOUT_MS = 15000;

async function postOnce(report) {
  const headers = { 'Content-Type': 'application/json' };
  if (INGEST_SECRET) headers['X-API-Key'] = INGEST_SECRET;
  return fetch(`${ORBIT_URL}/api/bug-reports`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ app: 'ironlog', type: report.type || 'bug_report', ...report }),
    signal: AbortSignal.timeout(TIMEOUT_MS)
  });
}

async function sendBugReportToOrbit(report) {
  if (!ORBIT_URL) return { sent: false, reason: 'ORBIT_URL not configured' };
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const res = await postOnce(report);
      if (res.ok || !RETRYABLE_STATUS.has(res.status) || attempt === 1) {
        return { sent: res.ok, status: res.status };
      }
    } catch (err) {
      // Transport failure (timeout, DNS, connection refused) — the cold-start
      // case. Worth one more go; a second failure is reported as before.
      if (attempt === 1) return { sent: false, reason: err.message };
    }
  }
  return { sent: false, reason: 'unreachable' };
}

module.exports = { sendBugReportToOrbit };
