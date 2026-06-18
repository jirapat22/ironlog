// ---------- Bug reporting ----------
// Captures uncaught frontend errors and forwards them (via the backend) to
// Orbit, plus a manual "Report a bug" path from Settings.

import { LS } from './utils.js';
import { API } from './api.js';

const SW_VERSION = 'ironlog-v74';
const SEEN_KEY = 'ironlog.bugReportsSeen';
const SEEN_WINDOW_MS = 5 * 60 * 1000;

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

function send(payload) {
  API.reportBug(payload).catch(() => { /* swallow — best effort */ });
}

function installErrorReporting() {
  window.addEventListener('error', (e) => {
    const message = e.message || String(e.error || 'Unknown error');
    const stack = e.error && e.error.stack ? e.error.stack : null;
    const key = `${message}|${e.filename || ''}|${e.lineno || ''}`;
    if (alreadyReported(key)) return;
    send({ source: 'frontend', message, stack, context: { ...baseContext(), filename: e.filename, lineno: e.lineno, colno: e.colno } });
  });

  window.addEventListener('unhandledrejection', (e) => {
    const reason = e.reason;
    const message = reason && reason.message ? reason.message : String(reason);
    const stack = reason && reason.stack ? reason.stack : null;
    const key = `rejection|${message}`;
    if (alreadyReported(key)) return;
    send({ source: 'frontend', message, stack, context: baseContext() });
  });
}

// Manual "Report a bug" / "Idea" — user-supplied description plus current
// context. `type` is 'bug_report' (default) or 'idea'; `details` is an
// optional free-text addendum (steps to reproduce, links, etc.).
function reportBugManually(description, { type = 'bug_report', details = '', extraContext = {} } = {}) {
  const context = { ...baseContext(), ...extraContext };
  if (details) context.details = details;
  return API.reportBug({
    source: 'manual',
    type,
    message: description,
    context
  });
}

export { installErrorReporting, reportBugManually };
