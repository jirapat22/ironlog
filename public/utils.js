// ---------- Shared utilities ----------

import { API } from './api.js';

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

// Toast with an inline action button — for opt-in follow-ups to something that
// just happened (e.g. "Swapped to X" → "Keep for next time?") where forcing a
// blocking dialog would slow down the common case that doesn't need it.
function actionToast(msg, actionLabel, onAction, ms = 5000) {
  const el = $('#toast');
  el.innerHTML = `<span>${escapeHtml(msg)}</span> <button type="button" class="toast__action">${escapeHtml(actionLabel)}</button>`;
  el.classList.remove('hidden');
  clearTimeout(toast._t);
  const btn = el.querySelector('.toast__action');
  btn.onclick = () => { clearTimeout(toast._t); el.classList.add('hidden'); onAction(); };
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

// Accepts SQLite "YYYY-MM-DD HH:MM:SS" (UTC, no zone marker) or a real ISO
// string. Only bare timestamps get 'Z' appended — appending to a string that
// already ends in Z (e.g. Date.toISOString()) produced "…ZZ" → Invalid Date →
// the summary's "Time: NaN".
function isoToMs(iso) {
  return new Date(/Z$|[+-]\d\d:?\d\d$/.test(iso) ? iso : iso.replace(' ', 'T') + 'Z').getTime();
}

function fmtDuration(startIso, endIso) {
  if (!startIso) return '';
  const start = isoToMs(startIso);
  const end = endIso ? isoToMs(endIso) : Date.now();
  const s = Math.max(0, Math.floor((end - start) / 1000));
  const mm = Math.floor(s / 60);
  const ss = s % 60;
  if (mm >= 60) {
    const hh = Math.floor(mm / 60);
    return `${hh}:${String(mm % 60).padStart(2, '0')}:${String(ss).padStart(2, '0')}`;
  }
  return `${mm}:${String(ss).padStart(2, '0')}`;
}

// Read + validate the optional "target rep range" pair of inputs shared by
// the exercise create/edit forms. Empty fields mean "no bound".
function readRepRangeInputs(rootEl, minSel, maxSel) {
  const parse = (sel) => {
    const raw = rootEl.querySelector(sel)?.value.trim();
    if (!raw) return { ok: true, value: null };
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1 || n > 100) return { ok: false };
    return { ok: true, value: n };
  };
  const min = parse(minSel);
  const max = parse(maxSel);
  if (!min.ok || !max.ok) return { ok: false, error: 'Rep range must be whole numbers 1–100' };
  if (min.value != null && max.value != null && min.value > max.value) {
    return { ok: false, error: 'Rep range: min can’t exceed max' };
  }
  return { ok: true, rep_min: min.value, rep_max: max.value };
}

function stepForExercise(unit, ex) {
  // A per-exercise custom increment (stored in kg) overrides the equipment
  // default entirely — e.g. a pin-loaded machine that jumps 20kg per stack
  // notch instead of the generic 2.5kg machine default.
  if (ex?.step_override != null && Number.isFinite(Number(ex.step_override))) {
    const kg = Number(ex.step_override);
    return unit === 'lbs' ? Math.round((kg / 0.45359237) * 10) / 10 : kg;
  }

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

// Small "≈ X kg/lb" equivalent for a logged weight (the opposite unit). Empty
// for non-positive weights. Used as a tag on set rows.
function weightEquiv(weight, unit) {
  const w = Number(weight);
  if (!Number.isFinite(w) || w <= 0) return '';
  return unit === 'lbs' ? `≈ ${+(w * 0.45359237).toFixed(1)} kg` : `≈ ${+(w / 0.45359237).toFixed(1)} lb`;
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
    if (y < HEADER + EDGE) speed = -Math.ceil((HEADER + EDGE - y) / 3);
    else if (y > vh - NAV - EDGE) speed = Math.ceil((y - (vh - NAV - EDGE)) / 3);
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
    // A second touch mid-drag (other finger, palm graze) must not start a new
    // drag — it used to overwrite `drag`, orphaning the first row in its
    // dragging state forever (pointerup no longer matched its pointerId).
    // A drag whose row left the DOM (re-render) is stale — discard it.
    if (drag) {
      if (drag.row.isConnected) return;
      drag.row.classList.remove(draggingClass);
      drag = null;
    }
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

// ---------- Sub-muscle taxonomy ----------
// Single source of truth: canonical regions per muscle group, in display order.
// Drives the sub-muscle picker (exercise add/edit), the Muscle Detail analytics
// (progress.js clones this), AND the group lists below — so there's one list to
// edit. An empty sub-muscle choice ('') = whole muscle, stored as null.
const SUB_MUSCLES = {
  chest: ['upper chest', 'mid chest', 'lower chest'],
  back: ['lats', 'upper back', 'lower back', 'traps'],
  shoulders: ['front delt', 'side delt', 'rear delt'],
  biceps: ['biceps', 'long head', 'short head', 'brachialis'],
  triceps: ['long head', 'lateral head'],
  forearms: ['wrist flexors', 'wrist extensors'],
  legs: ['quads', 'hamstrings', 'glutes', 'calves', 'abductors', 'adductors'],
  core: ['abs', 'obliques']
};

// ---------- Constants ----------
// Group order + the exercise-form group list both derive from SUB_MUSCLES keys.
const PICKER_GROUP_ORDER = Object.keys(SUB_MUSCLES);

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


// Build <option> markup for a group's sub-muscle dropdown. `selected` is the
// currently-saved sub_muscle (may be null/''). A saved value outside the
// canonical list (legacy/custom) is preserved as its own option.
function subMuscleOptions(group, selected) {
  const subs = SUB_MUSCLES[group] || [];
  const sel = selected || '';
  const opts = [`<option value="">— whole ${escapeHtml(group || 'muscle')} —</option>`];
  for (const s of subs) {
    opts.push(`<option value="${s}" ${sel === s ? 'selected' : ''}>${s}</option>`);
  }
  if (sel && !subs.includes(sel)) {
    opts.push(`<option value="${escapeHtml(sel)}" selected>${escapeHtml(sel)}</option>`);
  }
  return opts.join('');
}

// Checklist markup for the "also works" secondary muscles: every region across
// all groups except the chosen primary, with current selections checked.
function secondaryChecklistHTML(primaryRegion, selectedSet) {
  const sel = selectedSet instanceof Set ? selectedSet : new Set(selectedSet || []);
  return Object.entries(SUB_MUSCLES).map(([g, subs]) => {
    const items = subs
      .filter((s) => s !== primaryRegion)
      .map((s) => `<label class="sub2-item"><input type="checkbox" value="${s}" ${sel.has(s) ? 'checked' : ''}/><span>${s}</span></label>`)
      .join('');
    return items ? `<div class="sub2-group"><div class="sub2-group__title">${g}</div>${items}</div>` : '';
  }).join('');
}

// Mount a self-managing secondary-muscle picker into containerEl. `getPrimary`
// returns the current primary region (excluded from the list). Call .render()
// after the primary changes; .getSelected() returns the chosen regions.
function createSecondaryPicker(containerEl, getPrimary, initial = []) {
  const selected = new Set(initial || []);
  function render() {
    const primary = getPrimary();
    if (primary) selected.delete(primary);
    containerEl.innerHTML = secondaryChecklistHTML(primary, selected);
  }
  containerEl.addEventListener('change', (e) => {
    const cb = e.target.closest('input[type=checkbox]');
    if (!cb) return;
    if (cb.checked) selected.add(cb.value); else selected.delete(cb.value);
  });
  render();
  return { render, getSelected: () => [...selected] };
}

// ---------- Exercise edit form ----------
// Renders the "Edit exercise" form into containerEl and wires save/delete.
// Callbacks: onBack() — go back/close; onSaved(updatedExercise); onDeleted().
const EXERCISE_GROUPS = PICKER_GROUP_ORDER;
const EXERCISE_EQUIPMENT = ['barbell', 'dumbbell', 'cable', 'machine', 'bodyweight'];

function renderExerciseEditForm(containerEl, ex, { onBack, onSaved, onDeleted, onCleared } = {}) {
  containerEl.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-back-edit-ex>&larr;</button>
        <div class="sheet__title">Edit exercise</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <label class="form-label">Name</label>
        <input class="input" id="edit-ex-name" value="${escapeHtml(ex.name)}"/>
        <label class="form-label" style="margin-top:14px">Muscle group</label>
        <select class="input" id="edit-ex-muscle">
          ${EXERCISE_GROUPS.map((g) => `<option value="${g}" ${ex.muscle_group === g ? 'selected' : ''}>${g}</option>`).join('')}
        </select>
        <label class="form-label" style="margin-top:14px">Sub-muscle (optional)</label>
        <select class="input" id="edit-ex-sub">${subMuscleOptions(ex.muscle_group, ex.sub_muscle)}</select>
        <label class="form-label" style="margin-top:14px">Also works (optional)</label>
        <div class="sub2-list" id="edit-ex-sub2"></div>
        <label class="form-label" style="margin-top:14px">Equipment</label>
        <select class="input" id="edit-ex-equipment">
          ${EXERCISE_EQUIPMENT.map((e) => `<option value="${e}" ${ex.equipment === e ? 'selected' : ''}>${e}</option>`).join('')}
        </select>
        <div id="edit-ex-weightmode-wrap" style="${ex.equipment === 'dumbbell' ? '' : 'display:none'}">
          <label class="form-label" style="margin-top:14px">Weight entry</label>
          <select class="input" id="edit-ex-weightmode">
            <option value="per_arm" ${ex.weight_mode !== 'combined' ? 'selected' : ''}>Per arm (doubled for volume)</option>
            <option value="combined" ${ex.weight_mode === 'combined' ? 'selected' : ''}>Combined (already the full load)</option>
          </select>
        </div>
        <label class="form-label" style="margin-top:14px">Custom weight step (kg, optional)</label>
        <input class="input" type="number" step="0.5" min="0" id="edit-ex-step" value="${ex.step_override != null ? ex.step_override : ''}" placeholder="Default for ${ex.equipment || 'this equipment'}"/>
        <label class="form-label" style="margin-top:14px">Target rep range (optional)</label>
        <div class="rep-range-inputs">
          <input class="input" type="number" min="1" max="100" step="1" id="edit-ex-repmin" value="${ex.rep_min ?? ''}" placeholder="min"/>
          <span class="rep-range-inputs__dash">–</span>
          <input class="input" type="number" min="1" max="100" step="1" id="edit-ex-repmax" value="${ex.rep_max ?? ''}" placeholder="max"/>
        </div>
        <label class="form-label" style="margin-top:14px">Notes (optional)</label>
        <input class="input" id="edit-ex-notes" value="${escapeHtml(ex.notes || '')}" placeholder="Setup cue or variation"/>
        <button class="btn btn--primary btn--block" id="edit-ex-save" style="margin-top:20px">Save changes</button>
        ${ex.workout_count > 0
          ? `<button class="btn btn--ghost btn--block" id="edit-ex-clear" style="margin-top:10px;color:var(--danger)">Clear logged data (${ex.workout_count} workout${ex.workout_count !== 1 ? 's' : ''})</button>`
          : ex.program_count
            ? `<div class="card__subtitle" style="margin-top:10px">In ${ex.program_count} program slot${ex.program_count !== 1 ? 's' : ''} — remove it from your program day(s) to delete.</div>`
            : `<button class="btn btn--ghost btn--block" id="edit-ex-delete" style="margin-top:10px;color:var(--danger)">Delete exercise</button>`}
      </div>
    </div>`;

  containerEl.querySelector('[data-back-edit-ex]').onclick = () => onBack && onBack();
  const subSel = containerEl.querySelector('#edit-ex-sub');
  const sub2 = createSecondaryPicker(containerEl.querySelector('#edit-ex-sub2'), () => subSel.value, ex.secondary_muscles || []);
  // When the group changes, reset the sub-muscle dropdown to that group's
  // regions, then refresh the "also works" list to exclude the new primary.
  containerEl.querySelector('#edit-ex-muscle').onchange = (e) => {
    const keep = e.target.value === ex.muscle_group ? ex.sub_muscle : '';
    subSel.innerHTML = subMuscleOptions(e.target.value, keep);
    sub2.render();
  };
  subSel.onchange = () => sub2.render();

  const weightModeWrap = containerEl.querySelector('#edit-ex-weightmode-wrap');
  containerEl.querySelector('#edit-ex-equipment').onchange = (e) => {
    weightModeWrap.style.display = e.target.value === 'dumbbell' ? '' : 'none';
  };

  containerEl.querySelector('#edit-ex-save').onclick = async () => {
    const name = containerEl.querySelector('#edit-ex-name').value.trim();
    const muscle_group = containerEl.querySelector('#edit-ex-muscle').value;
    const sub_muscle = subSel.value || null;
    const secondary_muscles = sub2.getSelected();
    const equipment = containerEl.querySelector('#edit-ex-equipment').value;
    const weight_mode = containerEl.querySelector('#edit-ex-weightmode').value;
    const stepRaw = containerEl.querySelector('#edit-ex-step').value.trim();
    if (stepRaw && (!Number.isFinite(Number(stepRaw)) || Number(stepRaw) <= 0)) {
      return toast('Custom step must be a positive number');
    }
    const step_override = stepRaw ? Number(stepRaw) : null;
    const repRange = readRepRangeInputs(containerEl, '#edit-ex-repmin', '#edit-ex-repmax');
    if (!repRange.ok) return toast(repRange.error);
    const notes = containerEl.querySelector('#edit-ex-notes').value.trim() || null;
    if (!name) return toast('Name required');
    try {
      const updated = await API.updateExercise(ex.id, { name, muscle_group, sub_muscle, secondary_muscles, equipment, weight_mode, step_override, rep_min: repRange.rep_min, rep_max: repRange.rep_max, notes });
      haptic(10);
      toast('Saved');
      if (onSaved) onSaved(updated);
    } catch (err) { toast(err.message); }
  };

  const deleteBtn = containerEl.querySelector('#edit-ex-delete');
  if (deleteBtn) deleteBtn.onclick = async () => {
    const ok = await confirmSheet({ title: 'Delete exercise', message: `Delete "${ex.name}"? This only works if it's not used in any program or workout.`, confirmText: 'Delete', danger: true });
    if (!ok) return;
    try {
      await API.deleteExercise(ex.id);
      haptic(20);
      toast(`Deleted ${ex.name}`);
      if (onDeleted) onDeleted();
    } catch (err) { toast(err.message); } // server returns 409 if in use
  };

  // Shown for exercises that have logged sets: wipe this profile's sets + PRs
  // for the lift while keeping the catalog entry. Lets you scrub a stray or
  // accidental log (a seeded exercise can't be deleted — it would re-seed).
  const clearBtn = containerEl.querySelector('#edit-ex-clear');
  if (clearBtn) clearBtn.onclick = async () => {
    const ok = await confirmSheet({ title: 'Clear logged data', message: `Remove all your logged sets and PRs for "${ex.name}"? The exercise stays in your library. This can't be undone.`, confirmText: 'Clear data', danger: true });
    if (!ok) return;
    try {
      const { sets_removed } = await API.clearExerciseData(ex.id);
      haptic(20);
      toast(`Cleared ${sets_removed} set${sets_removed !== 1 ? 's' : ''}`);
      if (onCleared) onCleared();
      else if (onSaved) onSaved(ex);
    } catch (err) { toast(err.message); }
  };
}

// ---------- Exercise picker filtering ----------
// Shared muscle-group filter chips + search for the exercise pickers (workout
// add, swap, history add). All three render the same structure: a search input
// and `.picker-group[data-group]` blocks of `.picker-row[data-name]` buttons.
//
// Markup: drop `pickerChipsHTML(keys)` right under the search input, give the
// search input `data-picker-search`, then call `setupPickerFilter(pickerEl)`
// once after rendering. A chip narrows to one muscle group and scrolls it into
// view; search narrows rows by name; the two compose.
function pickerChipsHTML(keys) {
  return `<div class="picker-chips" data-picker-chips>
    <button class="picker-chip picker-chip--active" data-chip="">All</button>
    ${keys.map((g) => `<button class="picker-chip" data-chip="${escapeHtml(g)}">${escapeHtml(g)}</button>`).join('')}
  </div>`;
}

function setupPickerFilter(pickerEl) {
  const search = pickerEl.querySelector('[data-picker-search]');
  const chipsBar = pickerEl.querySelector('[data-picker-chips]');
  const apply = () => {
    const q = (search?.value || '').trim().toLowerCase();
    const activeChip = chipsBar?.querySelector('.picker-chip--active')?.dataset.chip || '';
    pickerEl.querySelectorAll('.picker-row').forEach((r) => {
      r.classList.toggle('hidden', !!q && !r.dataset.name.includes(q));
    });
    pickerEl.querySelectorAll('.picker-group').forEach((g) => {
      const matchesChip = !activeChip || g.dataset.group === activeChip;
      const anyRow = [...g.querySelectorAll('.picker-row')].some((r) => !r.classList.contains('hidden'));
      g.classList.toggle('hidden', !matchesChip || !anyRow);
    });
  };
  if (search) search.addEventListener('input', apply);
  if (chipsBar) {
    chipsBar.addEventListener('click', (e) => {
      const chip = e.target.closest('.picker-chip');
      if (!chip) return;
      chipsBar.querySelectorAll('.picker-chip').forEach((c) => c.classList.toggle('picker-chip--active', c === chip));
      apply();
      if (chip.dataset.chip) {
        const g = pickerEl.querySelector(`.picker-group[data-group="${chip.dataset.chip}"]`);
        g?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      } else {
        pickerEl.querySelector('.sheet__body')?.scrollTo({ top: 0, behavior: 'smooth' });
      }
    });
  }
  return apply;
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
  LS, $, $$, escapeHtml, haptic, primeAudio, playBeep, toast, actionToast,
  formatDateShort, daysAgo, humanAgo, fmtDuration,
  stepForExercise, readRepRangeInputs, skeletonBlocks, showPRFlash,
  e1RM, toKg, fmtSetWeight, weightEquiv,
  showSheet, hideSheet, ensureSheet, promptSheet, confirmSheet,
  enableDragReorder,
  PICKER_GROUP_ORDER, FEEL_OPTIONS, feelEmoji,
  SUB_MUSCLES, subMuscleOptions, secondaryChecklistHTML, createSecondaryPicker,
  renderExerciseEditForm,
  pickerChipsHTML, setupPickerFilter,
  isIOS, isStandalone
};
