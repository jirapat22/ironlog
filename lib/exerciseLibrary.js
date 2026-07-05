/**
 * Vendored exercise library (slimmed from hasaneyldrm/exercises-dataset by
 * scripts/build-exercise-library.js): ~1,300 exercises pre-mapped onto
 * IronLog's muscle groups / sub-muscles / equipment classes, each with
 * step-by-step instructions and a unilateral flag.
 *
 * Backs two features:
 *  • GET /api/exercise-library/search — the "search to add" flow in the
 *    new-exercise forms;
 *  • the one-time enrichment migration in db.js that attaches instructions
 *    to the seeded catalog by name match.
 */

'use strict';

const fs = require('fs');
const path = require('path');

let LIBRARY = null;

function load() {
  if (LIBRARY) return LIBRARY;
  try {
    LIBRARY = JSON.parse(
      fs.readFileSync(path.join(__dirname, '..', 'vendor', 'exercise-library.json'), 'utf8')
    );
  } catch {
    LIBRARY = []; // vendored file missing — search returns nothing, app still works
  }
  return LIBRARY;
}

function norm(s) {
  return String(s).toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim();
}

// Vocabulary folding so user phrasing meets dataset phrasing:
// "single arm" ↔ "one arm", "db" → "dumbbell", etc.
const SYNONYM = { single: 'one', db: 'dumbbell', bb: 'barbell', kb: 'kettlebell' };

function tokensOf(s) {
  return norm(s).split(' ').filter(Boolean).map((t) => SYNONYM[t] || t);
}

// Every query token must prefix-match some name token (any order) —
// "tricep" matches "triceps", "single arm row" matches "One Arm Cable Row".
function tokenMatch(qToks, nToks) {
  return qToks.every((qt) => nToks.some((nt) => nt.startsWith(qt)));
}

function search(q, limit = 20) {
  const qToks = tokensOf(q);
  if (!qToks.length || norm(q).length < 2) return [];
  const scored = [];
  for (const e of load()) {
    const nToks = tokensOf(e.name);
    if (!tokenMatch(qToks, nToks)) continue;
    // Fewer leftover words = closer match; prefix start = small bonus.
    const extra = nToks.length - qToks.length;
    const startsBonus = nToks[0] && nToks[0].startsWith(qToks[0]) ? 0 : 0.5;
    scored.push([extra + startsBonus, norm(e.name).length, e]);
  }
  scored.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return scored.slice(0, limit).map((s) => s[2]);
}

// Best-effort instructions lookup for an existing exercise: all of the
// exercise's name tokens must appear in the library name, then rank by
// matching equipment (the dataset prefixes it — "Barbell Bench Press" must
// beat "Band Bench Press" for a barbell exercise), then fewest extra words.
function instructionsFor(name, equipment = null) {
  const qToks = tokensOf(name);
  if (!qToks.length) return null;
  let best = null;
  for (const e of load()) {
    if (!e.instructions) continue;
    const nToks = tokensOf(e.name);
    if (!tokenMatch(qToks, nToks)) continue;
    const rank =
      (equipment && e.equipment === equipment ? 0 : 1) * 1e6 +
      (nToks.length - qToks.length) * 1e3 +
      Math.min(norm(e.name).length, 999);
    if (!best || rank < best.rank) best = { rank, e };
  }
  return best ? best.e.instructions : null;
}

module.exports = { search, instructionsFor };
