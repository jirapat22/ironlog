/**
 * Shared core for the bug-report pipeline: dedupe → local store → Orbit
 * forward. Used by the public POST /api/bug-report route and by the
 * server-side reportHandled()/assertInvariant() instrumentation below.
 */

'use strict';

const { db } = require('../db');
const { sendBugReportToOrbit } = require('./orbitReport');

const SOURCES = ['frontend', 'backend', 'manual'];
const TYPES = ['bug_report', 'idea'];
const DEDUPE_WINDOW_SECONDS = 300; // 5 minutes

/**
 * Insert a bug report (deduped) and forward it to Orbit in the background.
 * Synchronous and never throws — callers (including the HTTP route) can
 * respond immediately without waiting on the Orbit round-trip.
 */
function recordBugReport({ profileId = null, source, message, stack = null, context = null, type = 'bug_report' }) {
  // The whole body is wrapped, not just the risky bits — this function's
  // documented contract is "never throws," and its only caller from inside
  // Express's final error handler (server.js) calls it bare. If the insert
  // itself failed (WAL contention, disk full) and this weren't caught, the
  // ORIGINAL error would be lost — reporting the failure is what failed.
  try {
    const msg = String(message || '').trim().slice(0, 2000);
    if (!msg) return { recorded: false };
    const src = SOURCES.includes(source) ? source : 'frontend';
    const typ = TYPES.includes(type) ? type : 'bug_report';
    const stk = stack ? String(stack).slice(0, 8000) : null;
    const ctxStr = context ? JSON.stringify(context).slice(0, 4000) : null;

    // Dedupe identical reports (same source+message+stack) within a short
    // window so a tight error loop doesn't spam Orbit / fill the table. Manual
    // submissions (notes/ideas/bugs the user typed) are deliberate — never dedupe
    // them, or a repeated note silently fails to reach Orbit.
    if (src !== 'manual') {
      const dupe = db
        .prepare(
          `SELECT id FROM bug_reports
           WHERE source = ? AND message = ? AND IFNULL(stack, '') = IFNULL(?, '')
             AND created_at >= datetime('now', ?)
           ORDER BY id DESC LIMIT 1`
        )
        .get(src, msg, stk, `-${DEDUPE_WINDOW_SECONDS} seconds`);
      if (dupe) return { recorded: false, deduped: true };
    }

    const info = db
      .prepare(
        'INSERT INTO bug_reports (profile_id, source, message, stack, context, type) VALUES (?, ?, ?, ?, ?, ?)'
      )
      .run(profileId, src, msg, stk, ctxStr, typ);
    const id = Number(info.lastInsertRowid);

    // Forward to Orbit in the background — never block the caller on it.
    sendBugReportToOrbit({
      type: typ,
      source: src,
      message: msg,
      stack: stk,
      context: context || null,
      created_at: new Date().toISOString()
    })
      .then((result) => {
        if (result.sent) db.prepare('UPDATE bug_reports SET orbit_sent = 1 WHERE id = ?').run(id);
      })
      .catch(() => { /* best-effort */ });

    return { recorded: true, deduped: false, id };
  } catch {
    return { recorded: false };
  }
}

/**
 * Server-side equivalent of the frontend reportHandled(). Use ONLY in catch
 * blocks for "this shouldn't happen" swallows — not expected control flow
 * (e.g. an optional lookup that legitimately returns nothing).
 */
function reportHandled(err, ctx = {}) {
  try {
    recordBugReport({
      profileId: ctx.profileId ?? null,
      source: 'backend',
      message: err?.message || String(err),
      stack: err?.stack || null,
      context: { ...ctx, kind: 'handled' },
      type: 'bug_report'
    });
  } catch { /* never let reporting break the caller */ }
}

/**
 * Server-side invariant check. If `condition` is false, reports and
 * continues — never throws in prod, since a bad report is worse than a
 * silent log entry.
 */
function assertInvariant(condition, message, ctx = {}) {
  if (condition) return;
  try {
    recordBugReport({
      profileId: ctx.profileId ?? null,
      source: 'backend',
      message: `Invariant failed: ${message}`,
      context: { ...ctx, kind: 'invariant' },
      type: 'bug_report'
    });
  } catch { /* never let reporting break the caller */ }
}

module.exports = { recordBugReport, reportHandled, assertInvariant };
