// ---------- Shared utilities ----------

const LS = {
  activeWorkoutId: 'ironlog.activeWorkoutId',
  activeProgramDayId: 'ironlog.activeProgramDayId',
  activeWorkoutStart: 'ironlog.activeWorkoutStart',
  pin: 'ironlog.pin',
  pinUnlocked: 'ironlog.pinUnlocked',
  currentTab: 'ironlog.currentTab',
  setNotesDraft: 'ironlog.setNotesDraft',
  notifEnabled: 'ironlog.notifEnabled',
  installHintDismissed: 'ironlog.installHintDismissed'
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function haptic(ms = 30) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// Shared AudioContext — created lazily, kept alive so audio policy doesn't
// block playback when the beep fires from a setInterval (no recent user gesture).
let audioCtx = null;
function primeAudio() {
  try {
    if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch { /* not supported */ }
}

function playBeep() {
  primeAudio();
  if (!audioCtx) return;
  try {
    const schedule = (freq, start, dur) => {
      const osc = audioCtx.createOscillator();
      const gain = audioCtx.createGain();
      osc.connect(gain);
      gain.connect(audioCtx.destination);
      osc.type = 'sine';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(0.35, start);
      gain.gain.exponentialRampToValueAtTime(0.001, start + dur);
      osc.start(start);
      osc.stop(start + dur);
    };
    const t = audioCtx.currentTime;
    schedule(880, t, 0.12);
    schedule(880, t + 0.18, 0.12);
    schedule(1100, t + 0.36, 0.25);
  } catch { /* fail silently */ }
}

function toast(msg, ms = 2000) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.add('hidden'), ms);
}

function formatDateShort(iso) {
  if (!iso) return '';
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function daysAgo(iso) {
  if (!iso) return null;
  const d = new Date(iso.replace(' ', 'T') + 'Z');
  return Math.floor((Date.now() - d.getTime()) / 86400000);
}

function humanAgo(iso) {
  const d = daysAgo(iso);
  if (d === null) return '';
  if (d === 0) return 'today';
  if (d === 1) return 'yesterday';
  if (d < 7) return `${d} days ago`;
  const w = Math.floor(d / 7);
  if (w < 5) return `${w} week${w > 1 ? 's' : ''} ago`;
  const m = Math.floor(d / 30);
  return `${m} month${m > 1 ? 's' : ''} ago`;
}

function fmtDuration(startIso, endIso) {
  if (!startIso) return '';
  const start = new Date(startIso.replace(' ', 'T') + 'Z').getTime();
  const end = endIso ? new Date(endIso.replace(' ', 'T') + 'Z').getTime() : Date.now();
  const s = Math.max(0, Math.floor((end - start) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm >= 60) {
    const hh = Math.floor(mm / 60);
    return `${hh}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

function stepFor(unit) {
  return unit === 'lbs' ? 5 : 2.5;
}

function stepForExercise(unit, ex) {
  const fineGrain = ex && /dumbbell|\bdb\b|cable|machine|assisted/i.test(ex.name);
  if (unit === 'lbs') return fineGrain ? 2.5 : 5;
  return fineGrain ? 1 : 2.5;
}

function skeletonBlocks(n = 3) {
  return Array.from({ length: n })
    .map(() => '<div class="card"><div class="skeleton" style="height:64px"></div></div>')
    .join('');
}

function showPRFlash() {
  const el = $('#pr-flash');
  el.classList.remove('hidden');
  haptic([40, 40, 80]);
  setTimeout(() => el.classList.add('hidden'), 1500);
}

// ---------- e1RM / weight helpers ----------
function e1RM(weight, reps) {
  if (!weight || !reps) return 0;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

function toKg(weight, unit) {
  return unit === 'lbs' ? weight * 0.45359237 : weight;
}

function fmtSetWeight(weight, unit, isBw, isAssisted) {
  if (isAssisted) {
    if (!weight || weight === 0) return 'BW';
    return `BW−${weight}${unit}`;
  }
  if (isBw) {
    if (!weight || weight === 0) return 'BW';
    return `BW+${weight}${unit}`;
  }
  return `${weight}${unit}`;
}

// ---------- Sheet helpers ----------
function showSheet(el) {
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('open'));
}

function hideSheet(el) {
  el.classList.remove('open');
  setTimeout(() => el.classList.add('hidden'), 180);
}

function ensureSheet(id) {
  let el = document.getElementById(id);
  if (!el) {
    el = document.createElement('div');
    el.id = id;
    el.className = 'sheet hidden';
    document.body.appendChild(el);
  }
  return el;
}

// ---------- Drag-to-reorder ----------
function enableDragReorder(container, onDrop, { rowSel = '.edit-row', idKey = 'pde', draggingClass = 'edit-row--dragging' } = {}) {
  let drag = null;

  const onDown = (e) => {
    const handle = e.target.closest('[data-drag-handle]');
    if (!handle) return;
    const row = handle.closest(rowSel);
    if (!row || !container.contains(row)) return;
    e.preventDefault();
    drag = {
      row,
      pointerId: e.pointerId,
      startY: e.clientY,
      origOrder: [...container.children].map((r) => r.dataset[idKey])
    };
    row.classList.add(draggingClass);
    try { row.setPointerCapture(e.pointerId); } catch {}
    haptic(15);
  };

  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    const dy = e.clientY - drag.startY;
    drag.row.style.transform = `translateY(${dy}px)`;
    drag.row.style.zIndex = '10';

    const siblings = [...container.children].filter((c) => c !== drag.row);
    for (const sib of siblings) {
      const rect = sib.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const rowAfterSib = drag.row.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_PRECEDING;
      const rowBeforeSib = drag.row.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (e.clientY < mid && rowAfterSib) {
        drag.row.style.transform = '';
        drag.startY = e.clientY;
        container.insertBefore(drag.row, sib);
        return;
      }
      if (e.clientY > mid && rowBeforeSib) {
        drag.row.style.transform = '';
        drag.startY = e.clientY;
        container.insertBefore(drag.row, sib.nextSibling);
        return;
      }
    }
  };

  const onUp = async (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    const row = drag.row;
    row.classList.remove(draggingClass);
    row.style.transform = '';
    row.style.zIndex = '';
    const newOrder = [...container.children].map((r) => r.dataset[idKey]);
    const moved = newOrder.some((id, i) => id !== drag.origOrder[i]);
    drag = null;
    if (moved) await onDrop(newOrder);
  };

  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerup', onUp);
  container.addEventListener('pointercancel', onUp);
}

// ---------- Constants ----------
const PICKER_GROUP_ORDER = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'arms', 'legs', 'core'
];

const FEEL_OPTIONS = [
  { v: 1, emoji: '😴', label: 'Dead' },
  { v: 2, emoji: '😐', label: 'Tired' },
  { v: 3, emoji: '🙂', label: 'OK' },
  { v: 4, emoji: '💪', label: 'Strong' },
  { v: 5, emoji: '🔥', label: 'Beast' }
];

function feelEmoji(rating) {
  return FEEL_OPTIONS.find((o) => o.v === rating)?.emoji || '';
}

// ---------- iOS helpers ----------
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

export {
  LS, $, $$, escapeHtml, haptic, primeAudio, playBeep, toast,
  formatDateShort, daysAgo, humanAgo, fmtDuration,
  stepFor, stepForExercise, skeletonBlocks, showPRFlash,
  e1RM, toKg, fmtSetWeight,
  showSheet, hideSheet, ensureSheet,
  enableDragReorder,
  PICKER_GROUP_ORDER, FEEL_OPTIONS, feelEmoji,
  isIOS, isStandalone
};
