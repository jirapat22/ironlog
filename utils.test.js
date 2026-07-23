'use strict';

const { test } = require('node:test');
const assert = require('node:assert');

// public/utils.js is loaded by the browser as an ES module (import/export),
// so it's imported here the same way rather than duplicated/rewritten for
// Node — public/package.json marks that directory "type": "module" so
// Node's loader parses it correctly. It also imports api.js, which only
// touches browser globals (fetch/navigator/document) inside function
// bodies, never at module scope, so the import itself is side-effect free.
const utilsPromise = import('./public/utils.js');

test('fmtSetWeight: plain, bodyweight, and assisted display', async () => {
  const { fmtSetWeight } = await utilsPromise;
  assert.strictEqual(fmtSetWeight(100, 'kg', false, false), '100kg');
  // Bodyweight: 0 added weight just reads "BW", not "BW+0kg"
  assert.strictEqual(fmtSetWeight(0, 'kg', true, false), 'BW');
  assert.strictEqual(fmtSetWeight(10, 'kg', true, false), 'BW+10kg');
  // Assisted: more assistance = easier, sign is inverted in the label
  assert.strictEqual(fmtSetWeight(0, 'kg', false, true), 'BW');
  assert.strictEqual(fmtSetWeight(20, 'kg', false, true), 'BW−20kg');
});

test('fmtReps: shows L before R only when the sides actually differ', async () => {
  const { fmtReps } = await utilsPromise;
  assert.strictEqual(fmtReps(9, null, null), '9');
  assert.strictEqual(fmtReps(9, 9, 9), '9'); // identical sides isn't worth cluttering the row
  assert.strictEqual(fmtReps(7, 9, 7), '7 (L7/R9)');
});

test('e1RM: Epley formula, with reps=1 and weight=0 edge cases', async () => {
  const { e1RM } = await utilsPromise;
  assert.strictEqual(e1RM(100, 1), 100); // a 1RM is just the weight itself
  assert.strictEqual(e1RM(100, 5), 100 * (1 + 5 / 30));
  assert.strictEqual(e1RM(0, 5), 0);
  assert.strictEqual(e1RM(100, 0), 0);
});

test('toKg/fromKg: unit conversion round-trips', async () => {
  const { toKg, fromKg } = await utilsPromise;
  assert.strictEqual(toKg(100, 'kg'), 100);
  assert.strictEqual(toKg(100, 'lbs'), 100 * 0.45359237);
  assert.strictEqual(fromKg(100, 'kg'), 100);
  assert.ok(Math.abs(fromKg(toKg(220, 'lbs'), 'lbs') - 220) < 1e-9);
});

test('weightEquiv: converts to the OTHER unit, blank for non-positive input', async () => {
  const { weightEquiv } = await utilsPromise;
  assert.strictEqual(weightEquiv(100, 'kg'), '≈ 220.5 lb');
  assert.strictEqual(weightEquiv(100, 'lbs'), '≈ 45.4 kg');
  assert.strictEqual(weightEquiv(0, 'kg'), '');
  assert.strictEqual(weightEquiv(-5, 'kg'), '');
});

test('fmtDuration: mm:ss under an hour, hh:mm:ss over it', async () => {
  const { fmtDuration } = await utilsPromise;
  assert.strictEqual(fmtDuration('2026-01-01 10:00:00', '2026-01-01 10:05:30'), '5:30');
  assert.strictEqual(fmtDuration('2026-01-01 10:00:00', '2026-01-01 11:30:15'), '1:30:15');
  assert.strictEqual(fmtDuration(''), '');
});

// The app only ever passes bare SQLite "YYYY-MM-DD HH:MM:SS" timestamps to
// these today, but daysAgo/formatDateShort used to append "Z" unconditionally
// — fed a real ISO string (already ending in Z, e.g. Date.toISOString()),
// that produced "...ZZ" and silently returned NaN/"Invalid Date". fmtDuration
// was already hardened against this (via isoToMs); this pins the same fix on
// its two siblings, which shared the naive version until now.
test('daysAgo/formatDateShort: accept a real ISO string, not just bare SQLite timestamps', async () => {
  const { daysAgo, formatDateShort } = await utilsPromise;
  const bare = '2026-01-01 00:00:00';
  const real = '2026-01-01T00:00:00.000Z';
  assert.strictEqual(daysAgo(bare), daysAgo(real));
  assert.strictEqual(formatDateShort(bare), formatDateShort(real));
  assert.ok(Number.isFinite(daysAgo(real)), 'daysAgo must not be NaN for a real ISO string');
});

test('daysAgo/humanAgo: relative-time boundaries', async () => {
  const { daysAgo, humanAgo } = await utilsPromise;
  const iso = (d) => {
    const dt = new Date(Date.now() - d * 86400000);
    return dt.toISOString().slice(0, 19).replace('T', ' '); // SQLite-style, matching real API data
  };
  assert.strictEqual(daysAgo(null), null);
  assert.strictEqual(humanAgo(iso(0)), 'today');
  assert.strictEqual(humanAgo(iso(1)), 'yesterday');
  assert.strictEqual(humanAgo(iso(3)), '3 days ago');
  assert.strictEqual(humanAgo(iso(10)), '1 week ago');
  assert.strictEqual(humanAgo(iso(35)), '1 month ago');
});
