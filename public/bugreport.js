// ---------- Bug reporting ----------
// Captures uncaught frontend errors and forwards them (via the backend) to
// Orbit, plus a manual "Report a bug" path from Settings.
//
// Everything automatic (window error, unhandledrejection, api errors,
// wrapped console.error, reportHandled, assert) funnels through reportAuto()
// below: deduped by message (5-min window) and capped at AUTO_CAP per page
// load, so a tight error loop can't spam Orbit or fill the table. Manual
// submissions and the offline outbox bypass both the cap and that funnel —
// they're rare, user-initiated, and shouldn't ever be silently dropped.

import { LS } from './utils.js';
import { API } from './api.js';

const SW_VERSION = 'ironlog-v78';
const SEEN_KEY = 'ironlog.bugReportsSeen';
const SEEN_WINDOW_MS = 5 * 60 * 1000;
const OUTBOX_KEY = 'ironlog.bugReportsOutbox';
const OUTBOX_MAX = 20;
const AUTO_CAP = 25;

let autoReportCount = 0;

function baseContext() {
  return {
    url: location.pathname,
    tab: localStorage.getItem(LS.currentTab) || null,
    app_version: SW_VERSION,
    user_agent: navigator.userAgent
  };
}

// Avoid spamming the backend with the same error repeatedly (e.g. an error
// that fires on every render tick).
function alreadyReported(key) {
  let seen = {};
  try { seen = JSON.parse(sessionStorage.getItem(SEEN_KEY) || '{}'); } catch { seen = {}; }
  const now = Date.now();
  for (const k of Object.keys(seen)) {
    if (now - seen[k] > SEEN_WINDOW_MS) delete seen[k];
  }
  const wasSeen = key in seen;
  seen[key] = now;
  try { sessionStorage.setItem(SEEN_KEY, JSON.stringify(seen)); } catch { /* ignore */ }
  return wasSeen;
}

// ---------- Offline outbox (manual submissions only) ----------
// Manual reports matter — a user took the time to write one — so unlike
// automatic reports, a failed send gets queued and retried on next load
// instead of silently dropped.
function readOutbox() {
  try { return JSON.parse(localStorage.getItem(OUTBOX_KEY) || '[]'); } catch { return []; }
}

function writeOutbox(items) {
  try { localStorage.setItem(OUTBOX_KEY, JSON.stringify(items.slice(-OUTBOX_MAX))); } catch { /* quota */ }
}

function queueForRetry(payload) {
  writeOutbox([...readOutbox(), payload]);
}

async function flushOutbox() {
  const items = readOutbox();
  if (!items.length) return;
  writeOutbox([]); // clear up front so a crash mid-flush can't double-queue forever
  for (const payload of items) {
    try { await API.reportBug(payload); } catch { queueForRetry(payload); }
  }
}

// Funnel for ALL automatic report sources — capped + deduped. Best-effort:
// a failed send is just dropped (auto-reports aren't worth retrying offline).
function reportAuto(payload, dedupeKey) {
  if (dedupeKey && alreadyReported(dedupeKey)) return;
  if (autoReportCount >= AUTO_CAP) return;
  autoReportCount++;
  API.reportBug(payload).catch(() => { /* best-effort */ });
}

function installErrorReporting() {
  window.addEventListener('error', (e) => {
    const message = e.message || String(e.error || 'Unknown error');
    const stack = e.error && e.error.stack ? e.error.stack : null;
    reportAuto(
      { source: 'frontend', message, stack, context: { ...baseContext(), kind: 'window_error', filename: e.filename, lineno: e.lineno, colno: e.colno } },
      `${message}|${e.filename || ''}|${e.lineno || ''}`
    );
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const message = reason && reason.message ? reason.message : String(reason);
    const stack = reason && reason.stack ? reason.stack : null;
    reportAuto(
      { source: 'frontend', message, stack, context: { ...baseContext(), kind: 'unhandledrejection' } },
      `rejection|${message}`
    );
  });

  // api.js dispatches this for network failures / 5xx responses (it skips
  // 401, handled separately, and 4xx, which is usually expected
  // validation/conflict — not a bug).
  document.addEventListener('ironlog:api-error', (e) => {
    const { path, method, status, message } = e.detail || {};
    reportAuto(
      { source: 'frontend', message, context: { ...baseContext(), kind: 'api_error', path, method, status } },
      `api|${method}|${path}|${status}`
    );
  });

  installConsoleErrorReporting();
  flushOutbox();
}

// Wrap console.error so logged-but-swallowed errors still get reported. The
// original call always runs first — this never changes what shows up in
// devtools, it just also forwards a copy.
function installConsoleErrorReporting() {
  const orig = console.error.bind(console);
  console.error = (...args) => {
    orig(...args);
    try {
      const message = args
        .map((a) => {
          if (a instanceof Error) return a.stack || a.message;
          if (typeof a === 'string') return a;
          try { return JSON.stringify(a); } catch { return String(a); }
        })
        .join(' ')
        .slice(0, 2000);
      if (!message || message.includes('/api/bug-report')) return;
      const stack = args.find((a) => a instanceof Error)?.stack || null;
      reportAuto(
        { source: 'frontend', message, stack, context: { ...baseContext(), kind: 'console' } },
        `console|${message}`
      );
    } catch { /* never let reporting break the console */ }
  };
}

// Use in catch blocks for "this shouldn't happen" swallows — not expected
// control flow (optional fetches, private-mode storage, not-found lookups).
function reportHandled(err, ctx = {}) {
  const message = err && err.message ? err.message : String(err);
  const stack = err && err.stack ? err.stack : null;
  reportAuto(
    { source: 'frontend', message, stack, context: { ...baseContext(), ...ctx, kind: 'handled' } },
    `handled|${message}`
  );
}

// Invariant check: if `condition` is false, report and continue — never
// throw in prod. The only lever for catching silent logic bugs we didn't
// anticipate a try/catch around.
function assert(condition, message, ctx = {}) {
  if (condition) return;
  reportAuto(
    { source: 'frontend', type: 'bug_report', message: `Invariant failed: ${message}`, context: { ...baseContext(), ...ctx, kind: 'invariant' } },
    `invariant|${message}`
  );
}

// Manual "Report a bug" / "Idea" — user-supplied description plus current
// context. `type` is 'bug_report' (default) or 'idea'; `details` is an
// optional free-text addendum (steps to reproduce, links, etc.). Bypasses
// the automatic-report cap and dedupe, and queues for retry on failure.
function reportBugManually(description, { type = 'bug_report', details = '', extraContext = {} } = {}) {
  const context = { ...baseContext(), ...extraContext };
  if (details) context.details = details;
  const payload = { source: 'manual', type, message: description, context };
  return API.reportBug(payload).catch((err) => { queueForRetry(payload); throw err; });
}

export { installErrorReporting, reportBugManually, reportHandled, assert };
