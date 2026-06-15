/**
 * Forward a bug report to Orbit. Best-effort: if ORBIT_URL isn't set, or the
 * request fails, the caller still keeps its own local copy (bug_reports table).
 *
 * Orbit-side contract (POST {ORBIT_URL}/api/ingest), per Orbit's generic
 * inbound path: { app: 'ironlog', type: 'bug_report', message, stack,
 * context, created_at }. Auth: INGEST_SECRET, sent as X-API-Key.
 */

'use strict';

const ORBIT_URL = (process.env.ORBIT_URL || '').trim().replace(/\/+$/, '');
const INGEST_SECRET = (process.env.INGEST_SECRET || '').trim();

async function sendBugReportToOrbit(report) {
  if (!ORBIT_URL) return { sent: false, reason: 'ORBIT_URL not configured' };
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (INGEST_SECRET) headers['X-API-Key'] = INGEST_SECRET;
    const res = await fetch(`${ORBIT_URL}/api/ingest`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ app: 'ironlog', type: 'bug_report', ...report }),
      signal: AbortSignal.timeout(5000)
    });
    return { sent: res.ok, status: res.status };
  } catch (err) {
    return { sent: false, reason: err.message };
  }
}

module.exports = { sendBugReportToOrbit };
