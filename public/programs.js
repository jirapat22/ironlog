import { $, LS, escapeHtml, haptic, toast, humanAgo, skeletonBlocks, showSheet, hideSheet, ensureSheet, promptSheet, confirmSheet, enableDragReorder, PICKER_GROUP_ORDER, renderExerciseEditForm, renderNewExerciseForm, muscleTagHTML, pickerChipsHTML, setupPickerFilter, fmtSetWeight, subMuscleShadeClass, exerciseSortHTML, sortExercisesBy } from './utils.js';
import { API, REST_SECONDS } from './api.js';

function fmtRest(s) {
  if (s == null) return '—';
  const m = Math.floor(s / 60), sec = s % 60;
  return m > 0 ? (sec > 0 ? `${m}:${String(sec).padStart(2, '0')}` : `${m}m`) : `${s}s`;
}

// Name + optional description sheet, used for both Create and Edit. Resolves
// { name, description } or null if cancelled.
function programFormSheet({ title, name = '', description = '', confirmText = 'Save' }) {
  return new Promise((resolve) => {
    const sheet = ensureSheet('program-form-sheet');
    sheet.innerHTML = `
      <div class="sheet__inner">
        <div class="sheet__head">
          <button class="btn--icon" data-cancel>←</button>
          <div class="sheet__title">${escapeHtml(title)}</div>
          <span style="width:40px"></span>
        </div>
        <div class="sheet__body">
          <label class="form-label">Program name</label>
          <input class="input" id="pf-name" autocomplete="off" maxlength="60" value="${escapeHtml(name)}" placeholder="My Program"/>
          <label class="form-label" style="margin-top:14px">Description (optional)</label>
          <textarea class="input" id="pf-desc" rows="2" maxlength="200" placeholder="What's this program for?">${escapeHtml(description)}</textarea>
          <button class="btn btn--primary btn--block" id="pf-save" style="margin-top:20px">${escapeHtml(confirmText)}</button>
        </div>
      </div>`;
    showSheet(sheet);
    let done = false;
    const finish = (v) => { if (done) return; done = true; hideSheet(sheet); resolve(v); };
    sheet.querySelector('[data-cancel]').onclick = () => finish(null);
    sheet.querySelector('#pf-save').onclick = () => {
      const n = sheet.querySelector('#pf-name').value.trim();
      if (!n) return toast('Name required');
      finish({ name: n, description: sheet.querySelector('#pf-desc').value.trim() });
    };
    setTimeout(() => sheet.querySelector('#pf-name')?.focus(), 60);
  });
}

async function createProgramFlow() {
  const data = await programFormSheet({ title: 'New program', name: 'My Program', confirmText: 'Create' });
  if (!data) return;
  try {
    const p = await API.createProgram(data);
    const day = await API.addDay(p.id, { day_label: 'Day 1' });
    haptic(20);
    openEditDay(p.id, day.id);
  } catch (err) { toast(err.message); }
}

// ---------- PROGRAMS tab ----------
// Weekly muscle-coverage strip: sessions so far this week (Mon start, local
// time) per primary muscle group vs the 2×/week goal. One chip per group in
// its muscle colour — 0/2 dim, 1/2 tinted, 2/2 ✓ solid. Groups only appear
// once trained at least once EVER (a never-trained group isn't a weekly goal).
const COVERAGE_GOAL = 2;
async function renderMuscleCoverage() {
  const el = document.getElementById('mg-coverage');
  if (!el) return;
  let week, ever;
  try { [week, ever] = await Promise.all([API.muscleCoverage(), API.muscleFrequency()]); }
  catch { return; }
  const by = Object.fromEntries(week.map((r) => [r.muscle_group, r.sessions]));
  const trained = new Set(ever.map((r) => r.muscle_group));
  const groups = PICKER_GROUP_ORDER.filter((g) => trained.has(g) || by[g]);
  if (!groups.length) return;
  el.innerHTML = `
    <div class="cov-strip">
      <div class="cov-strip__title">This week · ${COVERAGE_GOAL}× each</div>
      <div class="cov-strip__chips">
        ${groups.map((g) => {
          const n = by[g] || 0;
          const cls = n >= COVERAGE_GOAL ? ' cov-chip--done' : n === 0 ? ' cov-chip--zero' : '';
          return `<span class="cov-chip mg-${g}${cls}">${g} ${n}/${COVERAGE_GOAL}${n >= COVERAGE_GOAL ? ' ✓' : ''}</span>`;
        }).join('')}
      </div>
    </div>`;
}

async function renderPrograms() {
  const root = $('#view-programs');
  root.innerHTML = skeletonBlocks(2);

  try {
    const programs = await API.programs();
    if (!programs.length) {
      root.innerHTML = `
        <div class="empty"><div class="empty__icon">&#x1F4C5;</div><div style="margin-bottom:12px">No programs yet</div></div>
        <button class="btn btn--primary btn--block" data-new-program style="margin-top:8px">+ Create program</button>`;
      root.querySelector('[data-new-program]').addEventListener('click', createProgramFlow);
      return;
    }

    const full = await Promise.all(programs.map((p) => API.program(p.id)));
    root.innerHTML = `<div id="mg-coverage"></div>` +
      full.map((p, i) => programCardHTML(p, i, full.length)).join('') +
      `<button class="btn btn--ghost btn--block" data-new-program style="margin-top:12px">+ Create program</button>`;
    renderMuscleCoverage(); // fire-and-forget — the strip is decor, never blocks the list
    await Promise.all(full.flatMap((p) => p.days.map((d) => decorateLastTrained(d.id))));

    root.onclick = async (e) => {
      const moveBtn = e.target.closest('[data-move-program]');
      if (moveBtn) {
        e.stopPropagation();
        const id = Number(moveBtn.dataset.programId);
        const dir = moveBtn.dataset.moveProgram === 'up' ? -1 : 1;
        const idx = full.findIndex((p) => p.id === id);
        const swap = idx + dir;
        if (swap < 0 || swap >= full.length) return;
        [full[idx], full[swap]] = [full[swap], full[idx]];
        haptic(10);
        try {
          // ponytail: rewrite every program's sort_order to its index — N is a
          // handful, so a per-program PATCH is simpler than a diff and robust
          // when some rows still have NULL sort_order.
          await Promise.all(full.map((p, i) => API.updateProgram(p.id, { sort_order: i })));
          renderPrograms();
        } catch (err) { toast(err.message); }
        return;
      }

      const dupBtn = e.target.closest('[data-dup-program]');
      if (dupBtn) {
        e.stopPropagation();
        const id = Number(dupBtn.dataset.dupProgram);
        const src = full.find((p) => p.id === id);
        const suggested = `My ${src?.name || 'Program'}`;
        const name = await promptSheet({ title: 'Duplicate program', label: 'Name for the new program', value: suggested, confirmText: 'Duplicate' });
        if (!name || !name.trim()) return;
        try {
          await API.duplicateProgram(id, { name: name.trim() });
          haptic(20); toast('Program duplicated'); renderPrograms();
        } catch (err) { toast(err.message); }
        return;
      }

      const renameBtn = e.target.closest('[data-rename-program]');
      if (renameBtn) {
        e.stopPropagation();
        const id = Number(renameBtn.dataset.renameProgram);
        const src = full.find((p) => p.id === id);
        const data = await programFormSheet({ title: 'Edit program', name: src?.name || '', description: src?.description || '', confirmText: 'Save' });
        if (!data || (data.name === src?.name && data.description === (src?.description || ''))) return;
        try {
          await API.updateProgram(id, data);
          haptic(20); renderPrograms();
        } catch (err) { toast(err.message); }
        return;
      }

      const deleteBtn = e.target.closest('[data-delete-program]');
      if (deleteBtn) {
        e.stopPropagation();
        const id = Number(deleteBtn.dataset.deleteProgram);
        const src = full.find((p) => p.id === id);
        const ok = await confirmSheet({ title: 'Delete program', message: `Delete "${src?.name || 'this program'}"? This cannot be undone.`, confirmText: 'Delete', danger: true });
        if (!ok) return;
        try {
          await API.deleteProgram(id);
          haptic(20); renderPrograms();
        } catch (err) { toast(err.message); }
        return;
      }

      const deleteDayBtn = e.target.closest('[data-delete-day]');
      if (deleteDayBtn) {
        e.stopPropagation();
        const ok = await confirmSheet({ title: 'Delete day', message: 'Delete this day and all its exercises?', confirmText: 'Delete', danger: true });
        if (!ok) return;
        const dayId = Number(deleteDayBtn.dataset.deleteDay);
        const programId = Number(deleteDayBtn.dataset.programId);
        try {
          await API.deleteDay(programId, dayId);
          haptic(20); renderPrograms();
        } catch (err) { toast(err.message); }
        return;
      }

      const header = e.target.closest('.program-card__header');
      if (header) { header.closest('.program-card').classList.toggle('expanded'); return; }

      const editBtn = e.target.closest('[data-edit-day]');
      if (editBtn) {
        haptic(15);
        openEditDay(Number(editBtn.dataset.programId), Number(editBtn.dataset.editDay));
        return;
      }

      const addDayBtn = e.target.closest('[data-add-day]');
      if (addDayBtn) {
        e.stopPropagation();
        const programId = Number(addDayBtn.dataset.addDay);
        const label = await promptSheet({ title: 'Add day', label: 'Day name', value: 'Day', confirmText: 'Add day' });
        if (!label || !label.trim()) return;
        try {
          const newDay = await API.addDay(programId, { day_label: label.trim() });
          haptic(20);
          openEditDay(programId, newDay.id);
        } catch (err) { toast(err.message); }
        return;
      }

      const startBtn = e.target.closest('[data-start-day]');
      if (startBtn) {
        haptic();
        const dayId = Number(startBtn.dataset.startDay);
        startBtn.disabled = true;
        startBtn.textContent = 'Starting…';
        try {
          const w = await API.startWorkout(dayId);
          localStorage.setItem(LS.activeWorkoutId, String(w.id));
          localStorage.setItem(LS.activeProgramDayId, String(dayId));
          localStorage.setItem(LS.activeWorkoutStart, w.started_at);
          document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'workout' }));
        } catch (err) {
          toast(err.message);
          startBtn.disabled = false;
          startBtn.textContent = 'Start workout';
        }
      }
    };

    // Create new program button (outside the program list)
    root.querySelector('[data-new-program]')?.addEventListener('click', createProgramFlow);
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load programs: ${escapeHtml(err.message)}</div>`;
  }
}

function programCardHTML(p, i, total) {
  return `
    <div class="program-card" data-program-id="${p.id}">
      <button class="program-card__header">
        <div>
          <div class="program-card__title">${escapeHtml(p.name)}</div>
          <div class="program-card__desc">${escapeHtml(p.description || '')}</div>
        </div>
        <span class="program-card__chevron">&#x276F;</span>
      </button>
      <div class="program-card__body">
        <div class="program-card__actions">
          <button class="btn btn--ghost btn--sm" data-move-program="up" data-program-id="${p.id}" title="Move up" ${i === 0 ? 'disabled' : ''}>&#x2191;</button>
          <button class="btn btn--ghost btn--sm" data-move-program="down" data-program-id="${p.id}" title="Move down" ${i === total - 1 ? 'disabled' : ''}>&#x2193;</button>
          <button class="btn btn--ghost btn--sm" data-dup-program="${p.id}">&#x29C9; Duplicate</button>
          <button class="btn btn--ghost btn--sm" data-rename-program="${p.id}">&#x270E; Edit</button>
          <button class="btn btn--ghost btn--sm" data-delete-program="${p.id}" style="color:var(--danger)">&times; Delete</button>
        </div>
        ${p.days.map((d) => dayCardHTML(d, p.id)).join('')}
        <button class="btn btn--ghost btn--sm" data-add-day="${p.id}" style="margin-top:8px;width:100%">+ Add day</button>
      </div>
    </div>
  `;
}

function dayCardHTML(d, programId) {
  const exList = d.exercises.length
    ? d.exercises.map((e) => `<span>${escapeHtml(e.name)} <span style="opacity:.6">${e.target_sets}×${e.target_reps}</span><span class="day-card__ex-last" data-ex-last="${e.exercise_id}"></span></span>`).join(' · ')
    : '<em style="opacity:.5">No exercises yet — tap Edit to add some</em>';
  return `
    <div class="day-card" data-day-id="${d.id}">
      <div class="day-card__top">
        <div class="day-card__label">${escapeHtml(d.day_label)}</div>
        <div class="day-card__last" data-last="${d.id}">—</div>
      </div>
      <div class="day-card__exercises">${exList}</div>
      <div class="day-card__actions">
        <button class="btn btn--ghost btn--sm" data-edit-day="${d.id}" data-program-id="${programId}">Edit</button>
        <button class="btn btn--primary btn--sm" data-start-day="${d.id}" style="flex:1">Start workout</button>
        <button class="btn btn--ghost btn--sm" data-delete-day="${d.id}" data-program-id="${programId}" style="color:var(--danger)" title="Delete day">&times;</button>
      </div>
    </div>
  `;
}

async function decorateLastTrained(dayId) {
  try {
    const last = await API.lastWorkout(dayId);
    const el = document.querySelector(`[data-last="${dayId}"]`);
    if (el) el.textContent = last ? `Last trained ${humanAgo(last.finished_at || last.started_at)}` : 'Never trained';
    if (!last?.sets?.length) return;

    // Best non-warmup set per exercise (heaviest, ties broken by more reps) —
    // gives a load to plan from before the user even taps Start.
    const bestByEx = new Map();
    for (const s of last.sets) {
      if (s.is_warmup) continue;
      const cur = bestByEx.get(s.exercise_id);
      if (!cur || s.weight > cur.weight || (s.weight === cur.weight && s.reps > cur.reps)) {
        bestByEx.set(s.exercise_id, s);
      }
    }
    const dayCard = document.querySelector(`[data-day-id="${dayId}"]`);
    if (!dayCard) return;
    for (const [exId, s] of bestByEx) {
      const lastEl = dayCard.querySelector(`[data-ex-last="${exId}"]`);
      if (lastEl) lastEl.textContent = ` · last ${fmtSetWeight(s.weight, s.weight_unit, s.is_bodyweight, s.is_assisted)}×${s.reps}`;
    }
  } catch { /* ignore */ }
}

// ---------- Edit Program Day ----------
let editDayState = null;

async function openEditDay(programId, dayId) {
  const sheet = ensureSheet('edit-sheet');
  sheet.innerHTML = `<div class="sheet__inner"><div class="skeleton" style="height:120px"></div></div>`;
  showSheet(sheet);
  try {
    const [program, allExercises] = await Promise.all([API.program(programId), API.exerciseStats()]);
    const day = program.days.find((d) => d.id === dayId);
    if (!day) throw new Error('Day not found');
    editDayState = { programId, dayId, day, allExercises };
    renderEditSheet();
  } catch (err) {
    sheet.innerHTML = `<div class="sheet__inner"><div class="empty">Couldn't load: ${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div>`;
  }
}

// Compounds-first ordering nudge. Classify by seeded secondary-muscle count:
// 0 = isolation (curls, laterals, pushdowns...), 1+ = multi-muscle lift.
// The threshold is 1, not 2, because region validation trims some seeded
// intents — every chest/shoulder press stores exactly one secondary (its
// 'triceps' entry isn't a valid region), and missing "laterals before Bench"
// would defeat the whole feature. One dim line, never a block: big lifts get
// their best sets when they come before isolation work, and a consistent
// order also keeps the strength-trend charts comparing like with like.
function dayOrderHintHTML() {
  const { day, allExercises } = editDayState;
  const secCount = new Map(allExercises.map((x) => [x.id, (x.secondary_muscles || []).length]));
  let firstIso = null;
  for (const e of day.exercises) {
    const n = secCount.get(e.exercise_id);
    if (firstIso === null && n === 0) { firstIso = e; continue; }
    if (firstIso !== null && n >= 1) {
      return `Try <strong>${escapeHtml(e.name)}</strong> before <strong>${escapeHtml(firstIso.name)}</strong> — lifts that work more muscles get your freshest effort.`;
    }
  }
  return '';
}

function refreshOrderHint() {
  const el = document.getElementById('day-order-hint');
  if (!el) return;
  const html = dayOrderHintHTML();
  el.innerHTML = html;
  el.style.display = html ? '' : 'none';
}

function renderEditSheet() {
  const sheet = document.getElementById('edit-sheet');
  const { day, programId, dayId } = editDayState;

  const rows = day.exercises.map((e, i) => `
    <div class="edit-row" data-pde="${e.id}">
      <div class="edit-row__main">
        <button class="edit-row__drag" data-drag-handle aria-label="Drag to reorder">&#x2630;</button>
        <div class="edit-row__head-text">
          <div class="edit-row__name">${escapeHtml(e.name)}</div>
          <div class="edit-row__muscle">${muscleTagHTML(e.muscle_group, e.sub_muscle)}${e.notes ? ` ${escapeHtml(e.notes)}` : ''}</div>
        </div>
      </div>
      <div class="edit-row__controls">
        <div class="edit-stepper">
          <button class="edit-stepper__btn" data-field="target_sets" data-step="-1">−</button>
          <span class="edit-stepper__value" data-display="target_sets">${e.target_sets}</span>
          <button class="edit-stepper__btn" data-field="target_sets" data-step="1">+</button>
          <span class="edit-stepper__label">sets</span>
        </div>
        <div class="edit-stepper">
          <button class="edit-stepper__btn" data-field="target_reps" data-step="-1">−</button>
          <span class="edit-stepper__value" data-display="target_reps">${e.target_reps}</span>
          <button class="edit-stepper__btn" data-field="target_reps" data-step="1">+</button>
          <span class="edit-stepper__label">reps</span>
        </div>
        <div class="edit-stepper">
          <button class="edit-stepper__btn" data-field="rest_seconds" data-step="-30">−</button>
          <span class="edit-stepper__value" data-display="rest_seconds">${fmtRest(e.rest_seconds)}</span>
          <button class="edit-stepper__btn" data-field="rest_seconds" data-step="30">+</button>
          <span class="edit-stepper__label">rest</span>
        </div>
      </div>
      <div class="edit-row__actions">
        <button class="btn--icon" data-move="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="btn--icon" data-move="down" title="Move down" ${i === day.exercises.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="btn--icon" data-swap-slot title="Swap for another exercise">&#x21C4;</button>
        <button class="btn--icon btn--icon-danger" data-remove title="Remove">×</button>
      </div>
    </div>`).join('');

  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <button class="sheet__title sheet__title--tap" data-rename-day title="Tap to rename">${escapeHtml(day.day_label)} &#x270E;</button>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="edit-rows" id="edit-rows-container">${rows}</div>
        <div class="order-hint" id="day-order-hint"></div>
        ${day.exercises.length ? '' : '<div class="empty" style="padding:20px 0">No exercises yet. Add one below.</div>'}
        <button class="btn btn--primary btn--block" data-open-picker style="margin-top:16px">+ Add exercise</button>
      </div>
    </div>
  `;

  const rowsContainer = sheet.querySelector('#edit-rows-container');
  if (rowsContainer) enableDragReorder(rowsContainer, persistEditRowOrder);
  refreshOrderHint();

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) {
      hideSheet(sheet);
      if (localStorage.getItem(LS.currentTab) === 'programs') renderPrograms();
      return;
    }
    if (e.target.closest('[data-rename-day]')) {
      const newLabel = await promptSheet({ title: 'Rename day', label: 'Day name', value: day.day_label, confirmText: 'Rename' });
      if (!newLabel || !newLabel.trim() || newLabel.trim() === day.day_label) return;
      try {
        await API.renameDay(programId, dayId, { day_label: newLabel.trim() });
        day.day_label = newLabel.trim();
        const btn = sheet.querySelector('[data-rename-day]');
        if (btn) btn.textContent = `${newLabel.trim()} ✎`;
        haptic(10);
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.closest('[data-open-picker]')) return openPicker();

    const row = e.target.closest('.edit-row');
    if (!row) return;
    const pdeId = Number(row.dataset.pde);

    const step = e.target.closest('.edit-stepper__btn');
    if (step) {
      const field = step.dataset.field;
      const delta = Number(step.dataset.step);
      const current = editDayState.day.exercises.find((x) => x.id === pdeId);
      let next, display;
      if (field === 'rest_seconds') {
        // null = "use global default". Step below 30 → back to null.
        const base = current.rest_seconds ?? REST_SECONDS;
        const raw = base + delta;
        next = raw < 30 ? null : Math.min(600, raw);
        current.rest_seconds = next;
        display = fmtRest(next);
      } else {
        next = Math.max(1, current[field] + delta);
        current[field] = next;
        display = String(next);
      }
      row.querySelector(`[data-display="${field}"]`).textContent = display;
      haptic(10);
      try { await API.updateDayExercise(programId, dayId, pdeId, { [field]: next }); }
      catch (err) { toast(err.message); }
      return;
    }

    // Swap this slot's exercise for another — opens the picker in swap mode.
    // Sets/reps/rest and position stay; only the exercise changes.
    if (e.target.closest('[data-swap-slot]')) return openPicker({ swapPde: pdeId });

    const remove = e.target.closest('[data-remove]');
    if (remove) {
      const ok = await confirmSheet({ title: 'Remove exercise', message: 'Remove this exercise from the day?', confirmText: 'Remove', danger: true });
      if (!ok) return;
      try {
        await API.removeDayExercise(programId, dayId, pdeId);
        editDayState.day.exercises = editDayState.day.exercises.filter((x) => x.id !== pdeId);
        renderEditSheet(); haptic(20);
      } catch (err) { toast(err.message); }
      return;
    }

    const move = e.target.closest('[data-move]');
    if (move) {
      const dir = move.dataset.move === 'up' ? -1 : 1;
      const exs = editDayState.day.exercises;
      const idx = exs.findIndex((x) => x.id === pdeId);
      const swapIdx = idx + dir;
      if (swapIdx < 0 || swapIdx >= exs.length) return;
      [exs[idx], exs[swapIdx]] = [exs[swapIdx], exs[idx]];
      renderEditSheet(); haptic(10);
      try {
        await Promise.all(exs.map((x, i) =>
          x.order_index !== i
            ? API.updateDayExercise(programId, dayId, x.id, { order_index: i }).then(() => { x.order_index = i; })
            : null
        ));
      } catch (err) { toast(err.message); }
    }
  };
}

async function persistEditRowOrder() {
  const container = document.getElementById('edit-rows-container');
  if (!container) return;
  const order = [...container.children].map((r) => Number(r.dataset.pde));
  editDayState.day.exercises.sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  refreshOrderHint(); // drag doesn't re-render the sheet — recompute in place
  const updates = [];
  for (let i = 0; i < editDayState.day.exercises.length; i++) {
    const ex = editDayState.day.exercises[i];
    if (ex.order_index !== i) {
      updates.push(
        API.updateDayExercise(editDayState.programId, editDayState.dayId, ex.id, { order_index: i })
          .then(() => { ex.order_index = i; })
      );
    }
  }
  try { await Promise.all(updates); haptic(15); }
  catch (err) { toast(err.message); }
}

// ---------- Exercise picker (programs context only) ----------
// Persists across re-opens (back-navigation from edit/create sub-forms calls
// openPicker again) within a session, same tier as other lightweight prefs.
let dayPickerSort = 'frequent';

// Two modes: add (default) appends the pick to the day; swap (`swapPde` = a
// program_day_exercises id) replaces that slot's exercise in place — sets,
// reps, rest and position all survive, only the movement changes.
async function openPicker({ swapPde = null } = {}) {
  const picker = ensureSheet('picker-sheet');
  const { allExercises } = editDayState;
  const swapping = swapPde ? editDayState.day.exercises.find((x) => x.id === swapPde) : null;
  const currentIds = new Set(editDayState.day.exercises.map((e) => e.exercise_id));

  function buildList() {
    const groups = {};
    for (const ex of allExercises) {
      if (!groups[ex.muscle_group]) groups[ex.muscle_group] = [];
      groups[ex.muscle_group].push(ex);
    }
    for (const g of Object.keys(groups)) groups[g] = sortExercisesBy(groups[g], dayPickerSort);
    const keys = [...new Set([...PICKER_GROUP_ORDER, ...Object.keys(groups)])].filter((k) => groups[k]);
    picker.querySelector('#picker-sort').innerHTML = exerciseSortHTML(dayPickerSort);
    picker.querySelector('#picker-list').innerHTML = pickerChipsHTML(keys) + keys.map((g) => `
      <div class="picker-group" data-group="${g}">
        <div class="picker-group__title mg-title mg-${g}">${escapeHtml(g)}</div>
        ${groups[g].map((ex) => `
          <div class="picker-row-wrap">
            <button class="picker-row ${currentIds.has(ex.id) ? 'picker-row--added' : ''}" data-pick="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}">
              <span>${escapeHtml(ex.name)}${ex.sub_muscle ? ` <span class="picker-row__sub mg-title mg-${g}${subMuscleShadeClass(g, ex.sub_muscle)}">${escapeHtml(ex.sub_muscle)}</span>` : ''}</span>
              <span class="picker-row__state">${currentIds.has(ex.id) ? 'added' : '+'}</span>
            </button>
            <button class="picker-row__edit" data-edit-ex="${ex.id}" title="Edit">&#x270E;</button>
          </div>`).join('')}
      </div>`).join('');
    setupPickerFilter(picker);
  }

  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-picker>←</button>
        <div class="sheet__title">${swapping ? 'Swap exercise' : 'Pick exercise'}</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        ${swapping ? `<div class="card__subtitle" style="margin-bottom:10px">Replacing <strong>${escapeHtml(swapping.name)}</strong> — its sets/reps/rest stay.</div>` : ''}
        <input class="input" id="picker-search" data-picker-search placeholder="Search exercises…" style="margin-bottom:12px"/>
        <button class="btn btn--ghost btn--block" data-new-exercise style="margin-bottom:12px">+ Create custom exercise</button>
        <div id="picker-sort"></div>
        <div id="picker-list"></div>
      </div>
    </div>
  `;
  showSheet(picker);
  buildList();

  picker.onclick = async (e) => {
    if (e.target.closest('[data-close-picker]')) return hideSheet(picker);
    if (e.target.closest('[data-new-exercise]')) return openNewExerciseForm(picker, swapPde);

    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { dayPickerSort = sortBtn.dataset.sort; buildList(); return; }

    const editExBtn = e.target.closest('[data-edit-ex]');
    if (editExBtn) {
      const exId = Number(editExBtn.dataset.editEx);
      const ex = allExercises.find((x) => x.id === exId);
      if (!ex) return;
      openEditExerciseForm(picker, ex, allExercises, swapPde);
      return;
    }

    const pickBtn = e.target.closest('[data-pick]');
    if (!pickBtn) return;
    if (pickBtn.classList.contains('picker-row--added')) { toast('Already in this day'); return; }
    const exerciseId = Number(pickBtn.dataset.pick);
    haptic(20);
    try { await applyPick(picker, exerciseId, swapPde); }
    catch (err) { toast(err.message); }
  };
}

// Add mode: append the exercise as a new 2×8 slot. Swap mode: PATCH the
// existing slot's exercise_id (server rejects a duplicate within the day) and
// replace it in local state with the fresh joined row the server returns.
async function applyPick(picker, exerciseId, swapPde) {
  if (swapPde) {
    const row = await API.updateDayExercise(editDayState.programId, editDayState.dayId, swapPde, { exercise_id: exerciseId });
    const idx = editDayState.day.exercises.findIndex((x) => x.id === swapPde);
    if (idx !== -1) editDayState.day.exercises[idx] = row;
  } else {
    const row = await API.addDayExercise(editDayState.programId, editDayState.dayId, {
      exercise_id: exerciseId, target_sets: 2, target_reps: 8
    });
    editDayState.day.exercises.push(row);
  }
  hideSheet(picker);
  renderEditSheet();
}

function openNewExerciseForm(picker, swapPde = null) {
  renderNewExerciseForm(picker, {
    ctaLabel: swapPde ? 'Create & swap in' : 'Create & add',
    onBack: () => openPicker({ swapPde }),
    onCreated: async (ex) => {
      ex.workout_count = 0;
      ex.program_count = 1; // about to be placed in this day, below
      editDayState.allExercises.push(ex);
      try { await applyPick(picker, ex.id, swapPde); }
      catch (err) { toast(err.message); }
    }
  });
}

function openEditExerciseForm(picker, ex, allExercises, swapPde = null) {
  renderExerciseEditForm(picker, ex, {
    onBack: () => openPicker({ swapPde }),
    onSaved: (updated) => {
      Object.assign(ex, updated);
      editDayState.allExercises = editDayState.allExercises.map((x) => x.id === ex.id ? updated : x);
      for (const pde of editDayState.day.exercises) {
        if (pde.exercise_id === ex.id) {
          pde.name = updated.name;
          pde.muscle_group = updated.muscle_group;
          pde.equipment = updated.equipment;
          pde.notes = updated.notes;
        }
      }
      openPicker({ swapPde });
    },
    onDeleted: () => {
      editDayState.allExercises = editDayState.allExercises.filter((x) => x.id !== ex.id);
      openPicker({ swapPde });
    }
  });
}

export { renderPrograms };
