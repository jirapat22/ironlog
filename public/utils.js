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
  // Use equipment field if available; fall back to name regex for older data
  const equipment = ex?.equipment
    || (/dumbbell|\bdb\b/i.test(ex?.name || '') ? 'dumbbell'
        : /cable|machine|assisted/i.test(ex?.name || '') ? 'cable'
        : 'barbell');

  if (unit === 'lbs') {
    if (equipment === 'barbell') return 10;   // 5 lbs/side
    if (equipment === 'dumbbell') return 5;   // standard US dumbbell jump
    return 5;                                  // cable / machine stack
  }
  // kg
  if (equipment === 'barbell') return 5;      // 2.5 kg/side
  if (equipment === 'dumbbell') return 2;     // standard DB increment
  return 2.5;                                  // cable / machine
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
  let rafId = null;

  // Page scrolls on the document (body), so auto-scroll drives the document
  // scroller. EDGE is the zone near the viewport top/bottom that triggers it;
  // HEADER/NAV keep the trigger clear of the sticky header and fixed bottom nav.
  const scroller = document.scrollingElement || document.documentElement;
  const EDGE = 90;
  const HEADER = 64;
  const NAV = 72;

  // Move the dragged row to its correct slot for a given pointer Y. Shared by
  // pointer moves and the auto-scroll loop (so order keeps updating while the
  // finger is held still in an edge zone and the content scrolls underneath).
  const applyReorder = (clientY) => {
    const siblings = [...container.children].filter((c) => c !== drag.row);
    for (const sib of siblings) {
      const rect = sib.getBoundingClientRect();
      const mid = rect.top + rect.height / 2;
      const rowAfterSib = drag.row.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_PRECEDING;
      const rowBeforeSib = drag.row.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING;
      if (clientY < mid && rowAfterSib) {
        drag.row.style.transform = '';
        drag.startY = clientY;
        container.insertBefore(drag.row, sib);
        return;
      }
      if (clientY > mid && rowBeforeSib) {
        drag.row.style.transform = '';
        drag.startY = clientY;
        container.insertBefore(drag.row, sib.nextSibling);
        return;
      }
    }
  };

  const autoScrollStep = () => {
    if (!drag) { rafId = null; return; }
    const y = drag.lastClientY;
    const vh = window.innerHeight;
    let speed = 0;
    if (y < HEADER + EDGE) speed = -Math.ceil((HEADER + EDGE - y) / 6);
    else if (y > vh - NAV - EDGE) speed = Math.ceil((y - (vh - NAV - EDGE)) / 6);
    if (speed !== 0) {
      const before = scroller.scrollTop;
      scroller.scrollTop = before + speed;
      // Only reflow if the scroll actually moved (not clamped at an end).
      if (scroller.scrollTop !== before) {
        drag.row.style.transform = `translateY(${y - drag.startY}px)`;
        applyReorder(y);
      }
    }
    rafId = requestAnimationFrame(autoScrollStep);
  };

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
      lastClientY: e.clientY,
      origOrder: [...container.children].map((r) => r.dataset[idKey])
    };
    row.classList.add(draggingClass);
    try { row.setPointerCapture(e.pointerId); } catch {}
    haptic(15);
    if (!rafId) rafId = requestAnimationFrame(autoScrollStep);
  };

  const onMove = (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    e.preventDefault();
    drag.lastClientY = e.clientY;
    drag.row.style.transform = `translateY(${e.clientY - drag.startY}px)`;
    drag.row.style.zIndex = '10';
    applyReorder(e.clientY);
  };

  const onUp = async (e) => {
    if (!drag || e.pointerId !== drag.pointerId) return;
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    const row = drag.row;
    row.classList.remove(draggingClass);
    row.style.transform = '';
    row.style.zIndex = '';
    const newOrder = [...container.children].map((r) => r.dataset[idKey]);
    const moved = newOrder.some((id, i) => id !== drag.origOrder[i]);
    drag = null;
    if (moved) {
      // Suppress the synthetic click that fires after pointerup so it can't
      // accidentally hit a button (e.g. "Done with this exercise") at the drop position.
      container.addEventListener('click', (ev) => ev.stopPropagation(), { once: true, capture: true });
      await onDrop(newOrder);
    }
  };

  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerup', onUp);
  container.addEventListener('pointercancel', onUp);
}

// ---------- In-app prompt (replaces window.prompt) ----------
// Native prompt()/confirm() are unreliable in standalone iOS PWAs — invoking a
// system dialog can interrupt the JS execution context, breaking async chains.
// This resolves to the entered string, or null if cancelled.
function promptSheet({ title, label = '', value = '', placeholder = '', confirmText = 'Save' } = {}) {
  return new Promise((resolve) => {
    const sheet = ensureSheet('prompt-sheet');
    sheet.innerHTML = `
      <div class="sheet__inner">
        <div class="sheet__head">
          <button class="btn--icon" data-prompt-cancel aria-label="Cancel">←</button>
          <div class="sheet__title">${escapeHtml(title || '')}</div>
          <span style="width:32px"></span>
        </div>
        <div class="sheet__body">
          ${label ? `<label class="form-label">${escapeHtml(label)}</label>` : ''}
          <input class="input" id="prompt-sheet-input" placeholder="${escapeHtml(placeholder)}" autocomplete="off" />
          <button class="btn btn--primary btn--block" data-prompt-ok style="margin-top:16px">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    const input = sheet.querySelector('#prompt-sheet-input');
    input.value = value;

    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      hideSheet(sheet);
      resolve(val);
    };
    sheet.querySelector('[data-prompt-cancel]').onclick = () => finish(null);
    sheet.querySelector('[data-prompt-ok]').onclick = () => finish(input.value);
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(input.value); });

    showSheet(sheet);
    setTimeout(() => { input.focus(); input.select(); }, 60);
  });
}

// In-app confirm (replaces window.confirm) — same iOS-standalone rationale as
// promptSheet. Resolves true if confirmed, false if cancelled/dismissed.
function confirmSheet({ title, message = '', confirmText = 'Confirm', cancelText = 'Cancel', danger = false } = {}) {
  return new Promise((resolve) => {
    const sheet = ensureSheet('confirm-sheet');
    sheet.innerHTML = `
      <div class="sheet__inner">
        <div class="sheet__head">
          <button class="btn--icon" data-confirm-cancel aria-label="Cancel">←</button>
          <div class="sheet__title">${escapeHtml(title || '')}</div>
          <span style="width:32px"></span>
        </div>
        <div class="sheet__body">
          ${message ? `<p style="color:var(--text-dim);margin:0 0 16px">${escapeHtml(message)}</p>` : ''}
          <button class="btn ${danger ? 'btn--danger' : 'btn--primary'} btn--block" data-confirm-ok>${escapeHtml(confirmText)}</button>
          <button class="btn btn--ghost btn--block" data-confirm-cancel style="margin-top:8px">${escapeHtml(cancelText)}</button>
        </div>
      </div>`;
    let settled = false;
    const finish = (val) => {
      if (settled) return;
      settled = true;
      hideSheet(sheet);
      resolve(val);
    };
    sheet.querySelectorAll('[data-confirm-cancel]').forEach((b) => { b.onclick = () => finish(false); });
    sheet.querySelector('[data-confirm-ok]').onclick = () => finish(true);
    showSheet(sheet);
  });
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
  showSheet, hideSheet, ensureSheet, promptSheet, confirmSheet,
  enableDragReorder,
  PICKER_GROUP_ORDER, FEEL_OPTIONS, feelEmoji,
  isIOS, isStandalone
};
