/**
 * One-shot build script: slims the hasaneyldrm/exercises-dataset JSON
 * (https://github.com/hasaneyldrm/exercises-dataset, ~9.7 MB, EN+IT) down to
 * the fields IronLog needs, pre-mapped onto IronLog's taxonomy (8 muscle
 * groups + sub-muscles, 5 equipment classes, unilateral flag). Output goes to
 * data/exercise-library.json (~1 MB), which lib/exerciseLibrary.js serves.
 *
 * Usage: node scripts/build-exercise-library.js path/to/exercises.json
 * Re-run only when refreshing the vendored dataset.
 */

'use strict';

const fs = require('fs');
const path = require('path');

const src = process.argv[2];
if (!src) {
  console.error('usage: node scripts/build-exercise-library.js <exercises.json>');
  process.exit(1);
}

const raw = JSON.parse(fs.readFileSync(src, 'utf8'));
const entries = Array.isArray(raw) ? raw : raw.exercises || Object.values(raw)[0];

// dataset equipment → IronLog's 5 classes. Cardio machines never reach this
// (the whole "cardio" category is excluded below).
const EQUIPMENT_MAP = {
  'body weight': 'bodyweight', weighted: 'bodyweight', 'stability ball': 'bodyweight',
  'bosu ball': 'bodyweight', 'medicine ball': 'bodyweight', roller: 'bodyweight',
  'wheel roller': 'bodyweight', tire: 'bodyweight',
  cable: 'cable', rope: 'cable', band: 'cable', 'resistance band': 'cable',
  barbell: 'barbell', 'ez barbell': 'barbell', 'olympic barbell': 'barbell', 'trap bar': 'barbell',
  'smith machine': 'machine', 'leverage machine': 'machine', 'sled machine': 'machine',
  assisted: 'machine', hammer: 'machine',
  dumbbell: 'dumbbell', kettlebell: 'dumbbell'
};

// dataset target muscle → [IronLog group, sub_muscle|null]. Subs that depend
// on the movement (incline chest, rear delts) are refined from the name below.
const TARGET_MAP = {
  abs: ['core', 'abs'],
  quads: ['legs', 'quads'], hamstrings: ['legs', 'hamstrings'], glutes: ['legs', 'glutes'],
  calves: ['legs', 'calves'], adductors: ['legs', 'adductors'], abductors: ['legs', 'abductors'],
  lats: ['back', 'lats'], 'upper back': ['back', 'upper back'], traps: ['back', 'traps'],
  spine: ['back', 'lower back'], 'levator scapulae': ['back', 'traps'],
  pectorals: ['chest', 'mid chest'], 'serratus anterior': ['chest', null],
  delts: ['shoulders', null],
  triceps: ['triceps', null], biceps: ['biceps', 'biceps'], forearms: ['forearms', null]
};

function refineSub(name, group, sub) {
  const n = name.toLowerCase();
  if (group === 'chest') {
    if (n.includes('incline')) return 'upper chest';
    if (n.includes('decline')) return 'lower chest';
    return sub;
  }
  if (group === 'shoulders') {
    if (n.includes('lateral') || n.includes('side')) return 'side delt';
    if (n.includes('rear') || n.includes('reverse')) return 'rear delt';
    if (n.includes('front')) return 'front delt';
    return null;
  }
  if (group === 'triceps' && n.includes('overhead')) return 'long head';
  if (group === 'core' && n.includes('oblique')) return 'obliques';
  return sub;
}

const UNILATERAL_RE = /\b(one|single)[- ](arm|leg)\b|alternat|unilateral/i;

function titleCase(s) {
  return s.replace(/\S+/g, (w) => /^(v|t|y|l)-/i.test(w) || /^[0-9]/.test(w)
    ? w
    : w.charAt(0).toUpperCase() + w.slice(1));
}

const out = [];
const seen = new Set();
let skipped = 0;

for (const e of entries) {
  if (e.category === 'cardio' || e.target === 'cardiovascular system') { skipped++; continue; }
  const equipment = EQUIPMENT_MAP[e.equipment];
  const mapped = TARGET_MAP[e.target];
  if (!equipment || !mapped) { skipped++; continue; }
  const name = titleCase(String(e.name).trim());
  const key = name.toLowerCase();
  if (seen.has(key)) { skipped++; continue; }
  seen.add(key);
  const [group, subRaw] = mapped;
  out.push({
    name,
    muscle_group: group,
    sub_muscle: refineSub(name, group, subRaw),
    equipment,
    unilateral: UNILATERAL_RE.test(name),
    instructions: (e.instructions && e.instructions.en) ? String(e.instructions.en).trim() : null
  });
}

out.sort((a, b) => a.name.localeCompare(b.name));

// vendor/ (not data/ — that's the gitignored SQLite home)
const dest = path.join(__dirname, '..', 'vendor', 'exercise-library.json');
fs.writeFileSync(dest, JSON.stringify(out));
console.log(`wrote ${out.length} exercises (${skipped} skipped) → ${dest}`);
console.log(`size: ${(fs.statSync(dest).size / 1024 / 1024).toFixed(2)} MB`);
