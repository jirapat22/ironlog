// IronLog - Mobile gym tracker SPA
// Single-file SPA that talks to the REST API defined in /routes.

const LS = {
  activeWorkoutId: 'ironlog.activeWorkoutId',
  activeProgramDayId: 'ironlog.activeProgramDayId',
  activeWorkoutStart: 'ironlog.activeWorkoutStart',
  pin: 'ironlog.pin',
  pinUnlocked: 'ironlog.pinUnlocked',
  currentTab: 'ironlog.currentTab',
  setNotesDraft: 'ironlog.setNotesDraft'
};

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// ---------- API ----------
async function api(path, opts = {}) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  if (!res.ok) {
    const err = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error(err.error || `HTTP ${res.status}`);
  }
  return res.json();
}

const API = {
  exercises: () => api('/api/exercises'),
  addExercise: (data) => api('/api/exercises', { method: 'POST', body: data }),
  programs: () => api('/api/programs'),
  program: (id) => api(`/api/programs/${id}`),
  addDayExercise: (programId, dayId, data) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises`, { method: 'POST', body: data }),
  updateDayExercise: (programId, dayId, pdeId, data) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises/${pdeId}`, { method: 'PATCH', body: data }),
  removeDayExercise: (programId, dayId, pdeId) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises/${pdeId}`, { method: 'DELETE' }),
  lastWorkout: (programDayId) => api(`/api/workouts/last/${programDayId}`),
  workout: (id) => api(`/api/workouts/${id}`),
  workoutSets: (id) => api(`/api/workouts/${id}/sets`),
  startWorkout: (programDayId) =>
    api('/api/workouts', { method: 'POST', body: { program_day_id: programDayId } }),
  finishWorkout: (id) => api(`/api/workouts/${id}/finish`, { method: 'PATCH' }),
  logSet: (data) => api('/api/sets', { method: 'POST', body: data }),
  updateSet: (id, data) => api(`/api/sets/${id}`, { method: 'PATCH', body: data }),
  deleteSet: (id) => api(`/api/sets/${id}`, { method: 'DELETE' }),
  progress: (exerciseId) => api(`/api/progress/${exerciseId}`),
  weeklyVolume: () => api('/api/volume/weekly'),
  calendar: () => api('/api/calendar'),
  prs: () => api('/api/prs'),
  history: () => api('/api/workouts/history'),
  updateWorkout: (id, data) => api(`/api/workouts/${id}`, { method: 'PATCH', body: data }),
  deleteWorkout: (id) => api(`/api/workouts/${id}`, { method: 'DELETE' }),
  bodyweight: () => api('/api/bodyweight'),
  addBodyweight: (data) => api('/api/bodyweight', { method: 'POST', body: data }),
  deleteBodyweight: (id) => api(`/api/bodyweight/${id}`, { method: 'DELETE' })
};

const REST_SECONDS = 180; // 3 minutes

// ---------- Global rest countdown ----------
let restState = null; // { endAt, handle, doneTimeout }

function startRestCountdown(secs = REST_SECONDS) {
  cancelRestCountdown();
  const endAt = Date.now() + secs * 1000;
  restState = { endAt, handle: null, doneTimeout: null };

  const tick = () => {
    const node = $('#rest-sticky');
    if (!node) return;
    const remain = Math.max(0, Math.round((endAt - Date.now()) / 1000));
    if (remain <= 0) {
      node.classList.add('done');
      node.innerHTML = `<span>&#x1F514; Rest done — next set</span><button class="rest-sticky__x" data-rest-cancel aria-label="Dismiss">&times;</button>`;
      if (restState?.handle) {
        clearInterval(restState.handle);
        restState.handle = null;
      }
      haptic([250, 120, 250, 120, 400]);
      if (restState) {
        restState.doneTimeout = setTimeout(cancelRestCountdown, 10000);
      }
      return;
    }
    const mm = Math.floor(remain / 60);
    const ss = remain % 60;
    node.classList.remove('done', 'hidden');
    node.innerHTML = `<span class="rest-sticky__label">Rest</span><span class="rest-sticky__time">${mm}:${String(ss).padStart(2, '0')}</span><button class="rest-sticky__x" data-rest-cancel aria-label="Cancel">&times;</button>`;
  };
  tick();
  restState.handle = setInterval(tick, 500);
}

function cancelRestCountdown() {
  if (restState?.handle) clearInterval(restState.handle);
  if (restState?.doneTimeout) clearTimeout(restState.doneTimeout);
  restState = null;
  const el = $('#rest-sticky');
  if (el) {
    el.classList.add('hidden');
    el.classList.remove('done');
    el.innerHTML = '';
  }
}

// ---------- Helpers ----------
function haptic(ms = 30) {
  if (navigator.vibrate) navigator.vibrate(ms);
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
  const diffMs = Date.now() - d.getTime();
  return Math.floor(diffMs / 86400000);
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

// ---------- Router / tabs ----------
const TABS = ['workout', 'programs', 'progress', 'history'];

function setTab(tab) {
  if (!TABS.includes(tab)) tab = 'programs';
  localStorage.setItem(LS.currentTab, tab);

  $$('.view').forEach((v) => v.classList.add('hidden'));
  const view = $(`#view-${tab}`);
  if (view) view.classList.remove('hidden');

  $$('.nav__btn').forEach((b) =>
    b.classList.toggle('active', b.dataset.tab === tab)
  );

  $('#app-title').textContent =
    { workout: 'Workout', programs: 'Programs', progress: 'Progress', history: 'History' }[tab];
  $('#app-subtitle').textContent = '';

  const renderers = { workout: renderWorkout, programs: renderPrograms, progress: renderProgress, history: renderHistory };
  renderers[tab]?.();
}

// ---------- PIN lock ----------
let pinBuffer = '';
let pinMode = 'enter'; // 'enter' | 'set' | 'confirm'
let pinFirst = '';

function renderPinKeypad() {
  const pad = $('#pin-keypad');
  const keys = ['1', '2', '3', '4', '5', '6', '7', '8', '9', '', '0', '⌫'];
  pad.innerHTML = keys
    .map((k) =>
      k === ''
        ? '<span></span>'
        : `<button class="pin-key" data-key="${k}">${k}</button>`
    )
    .join('');
  pad.onclick = (e) => {
    const btn = e.target.closest('.pin-key');
    if (!btn) return;
    haptic(15);
    const k = btn.dataset.key;
    if (k === '⌫') {
      pinBuffer = pinBuffer.slice(0, -1);
    } else if (pinBuffer.length < 4) {
      pinBuffer += k;
    }
    renderPinDots();
    if (pinBuffer.length === 4) setTimeout(onPinComplete, 120);
  };
}

function renderPinDots() {
  const dots = $$('#pin-dots span');
  dots.forEach((d, i) => d.classList.toggle('filled', i < pinBuffer.length));
}

function onPinComplete() {
  const saved = localStorage.getItem(LS.pin);
  const lockEl = $('#pin-lock');

  if (!saved) {
    if (pinMode === 'set') {
      pinFirst = pinBuffer;
      pinBuffer = '';
      pinMode = 'confirm';
      $('#pin-subtitle').textContent = 'Confirm PIN';
      renderPinDots();
      return;
    }
    if (pinMode === 'confirm') {
      if (pinBuffer === pinFirst) {
        localStorage.setItem(LS.pin, pinBuffer);
        sessionStorage.setItem(LS.pinUnlocked, '1');
        hidePinLock();
        return;
      }
      pinFirst = '';
      pinBuffer = '';
      pinMode = 'set';
      $('#pin-subtitle').textContent = 'PINs did not match — set a new PIN';
      lockEl.classList.add('error');
      setTimeout(() => lockEl.classList.remove('error'), 400);
      renderPinDots();
      return;
    }
  }

  if (pinBuffer === saved) {
    sessionStorage.setItem(LS.pinUnlocked, '1');
    hidePinLock();
  } else {
    pinBuffer = '';
    lockEl.classList.add('error');
    setTimeout(() => lockEl.classList.remove('error'), 400);
    renderPinDots();
  }
}

function showPinLock() {
  const saved = localStorage.getItem(LS.pin);
  pinBuffer = '';
  pinFirst = '';
  pinMode = saved ? 'enter' : 'set';
  $('#pin-subtitle').textContent = saved ? 'Enter PIN' : 'Set a 4-digit PIN';
  renderPinKeypad();
  renderPinDots();
  $('#pin-lock').classList.remove('hidden');
}

function hidePinLock() {
  $('#pin-lock').classList.add('hidden');
  boot();
}

// ---------- PROGRAMS tab ----------
async function renderPrograms() {
  const root = $('#view-programs');
  root.innerHTML = skeletonBlocks(2);

  try {
    const programs = await API.programs();
    if (!programs.length) {
      root.innerHTML = `<div class="empty"><div class="empty__icon">&#x1F4C5;</div><div>No programs yet</div></div>`;
      return;
    }

    const full = await Promise.all(programs.map((p) => API.program(p.id)));

    root.innerHTML = full.map((p) => programCardHTML(p)).join('');

    await Promise.all(
      full.flatMap((p) => p.days.map((d) => decorateLastTrained(d.id)))
    );

    root.onclick = async (e) => {
      const header = e.target.closest('.program-card__header');
      if (header) {
        header.closest('.program-card').classList.toggle('expanded');
        return;
      }
      const editBtn = e.target.closest('[data-edit-day]');
      if (editBtn) {
        haptic(15);
        const dayId = Number(editBtn.dataset.editDay);
        const programId = Number(editBtn.dataset.programId);
        openEditDay(programId, dayId);
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
          setTab('workout');
        } catch (err) {
          toast(err.message);
          startBtn.disabled = false;
          startBtn.textContent = 'Start workout';
        }
      }
    };
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load programs: ${err.message}</div>`;
  }
}

function programCardHTML(p) {
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
        ${p.days.map((d) => dayCardHTML(d, p.id)).join('')}
      </div>
    </div>
  `;
}

function dayCardHTML(d, programId) {
  const exList = d.exercises.length
    ? d.exercises
        .map(
          (e) =>
            `${escapeHtml(e.name)} <span style="opacity:.6">${e.target_sets}×${e.target_reps}</span>`
        )
        .join(' · ')
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
      </div>
    </div>
  `;
}

async function decorateLastTrained(dayId) {
  try {
    const last = await API.lastWorkout(dayId);
    const el = document.querySelector(`[data-last="${dayId}"]`);
    if (!el) return;
    if (!last) {
      el.textContent = 'Never trained';
    } else {
      el.textContent = `Last trained ${humanAgo(last.finished_at || last.started_at)}`;
    }
  } catch {
    /* ignore */
  }
}

// ---------- Edit Program Day ----------
let editDayState = null; // { programId, dayId, day, allExercises }

async function openEditDay(programId, dayId) {
  const sheet = ensureEditSheet();
  sheet.innerHTML = `<div class="sheet__inner"><div class="skeleton" style="height:120px"></div></div>`;
  showSheet(sheet);

  try {
    const [program, allExercises] = await Promise.all([API.program(programId), API.exercises()]);
    const day = program.days.find((d) => d.id === dayId);
    if (!day) throw new Error('Day not found');
    editDayState = { programId, dayId, day, allExercises };
    renderEditSheet();
  } catch (err) {
    sheet.innerHTML = `<div class="sheet__inner"><div class="empty">Couldn't load: ${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div>`;
  }
}

function ensureEditSheet() {
  let sheet = document.getElementById('edit-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'edit-sheet';
    sheet.className = 'sheet hidden';
    document.body.appendChild(sheet);
  }
  return sheet;
}

function showSheet(el) {
  el.classList.remove('hidden');
  requestAnimationFrame(() => el.classList.add('open'));
}

function hideSheet(el) {
  el.classList.remove('open');
  setTimeout(() => el.classList.add('hidden'), 180);
}

function renderEditSheet() {
  const sheet = document.getElementById('edit-sheet');
  const { day, programId, dayId } = editDayState;

  const rows = day.exercises
    .map(
      (e, i) => `
      <div class="edit-row" data-pde="${e.id}">
        <div class="edit-row__main">
          <div class="edit-row__name">${escapeHtml(e.name)}</div>
          <div class="edit-row__muscle">${escapeHtml(e.muscle_group)}</div>
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
        </div>
        <div class="edit-row__actions">
          <button class="btn--icon" data-move="up" title="Move up" ${i === 0 ? 'disabled' : ''}>↑</button>
          <button class="btn--icon" data-move="down" title="Move down" ${i === day.exercises.length - 1 ? 'disabled' : ''}>↓</button>
          <button class="btn--icon btn--icon-danger" data-remove title="Remove">×</button>
        </div>
      </div>
    `
    )
    .join('');

  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">${escapeHtml(day.day_label)}</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        ${rows || '<div class="empty" style="padding:20px 0">No exercises yet. Add one below.</div>'}
        <button class="btn btn--primary btn--block" data-open-picker style="margin-top:16px">+ Add exercise</button>
      </div>
    </div>
  `;

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) {
      hideSheet(sheet);
      if (localStorage.getItem(LS.currentTab) === 'programs') renderPrograms();
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
      const next = Math.max(1, current[field] + delta);
      current[field] = next;
      row.querySelector(`[data-display="${field}"]`).textContent = next;
      haptic(10);
      try {
        await API.updateDayExercise(programId, dayId, pdeId, { [field]: next });
      } catch (err) {
        toast(err.message);
      }
      return;
    }

    const remove = e.target.closest('[data-remove]');
    if (remove) {
      if (!confirm('Remove this exercise from the day?')) return;
      try {
        await API.removeDayExercise(programId, dayId, pdeId);
        editDayState.day.exercises = editDayState.day.exercises.filter((x) => x.id !== pdeId);
        renderEditSheet();
        haptic(20);
      } catch (err) {
        toast(err.message);
      }
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
      renderEditSheet();
      haptic(10);
      try {
        await Promise.all(
          exs.map((x, i) =>
            x.order_index !== i
              ? API.updateDayExercise(programId, dayId, x.id, { order_index: i }).then(() => {
                  x.order_index = i;
                })
              : null
          )
        );
      } catch (err) {
        toast(err.message);
      }
    }
  };
}

// ---------- Exercise picker ----------
async function openPicker() {
  const picker = ensurePicker();
  const { allExercises } = editDayState;
  const groups = {};
  for (const ex of allExercises) {
    if (!groups[ex.muscle_group]) groups[ex.muscle_group] = [];
    groups[ex.muscle_group].push(ex);
  }

  const currentIds = new Set(editDayState.day.exercises.map((e) => e.exercise_id));

  const groupOrder = ['chest', 'back', 'shoulders', 'arms', 'legs', 'core'];
  const keys = [...new Set([...groupOrder, ...Object.keys(groups)])].filter((k) => groups[k]);

  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-picker>←</button>
        <div class="sheet__title">Pick exercise</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <input class="input" id="picker-search" placeholder="Search exercises…" style="margin-bottom:12px"/>
        <button class="btn btn--ghost btn--block" data-new-exercise style="margin-bottom:16px">+ Create custom exercise</button>
        ${keys
          .map(
            (g) => `
          <div class="picker-group" data-group="${g}">
            <div class="picker-group__title">${escapeHtml(g)}</div>
            ${groups[g]
              .map(
                (ex) => `
                <button class="picker-row ${currentIds.has(ex.id) ? 'picker-row--added' : ''}" data-pick="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}">
                  <span>${escapeHtml(ex.name)}</span>
                  <span class="picker-row__state">${currentIds.has(ex.id) ? 'added' : '+'}</span>
                </button>
              `
              )
              .join('')}
          </div>
        `
          )
          .join('')}
      </div>
    </div>
  `;
  showSheet(picker);

  const search = document.getElementById('picker-search');
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    picker.querySelectorAll('.picker-row').forEach((r) => {
      r.classList.toggle('hidden', q && !r.dataset.name.includes(q));
    });
    picker.querySelectorAll('.picker-group').forEach((g) => {
      const any = [...g.querySelectorAll('.picker-row')].some((r) => !r.classList.contains('hidden'));
      g.classList.toggle('hidden', !any);
    });
  };

  picker.onclick = async (e) => {
    if (e.target.closest('[data-close-picker]')) return hideSheet(picker);
    if (e.target.closest('[data-new-exercise]')) return openNewExerciseForm(picker);

    const pickBtn = e.target.closest('[data-pick]');
    if (!pickBtn) return;
    if (pickBtn.classList.contains('picker-row--added')) {
      toast('Already in this day');
      return;
    }
    const exerciseId = Number(pickBtn.dataset.pick);
    haptic(20);
    try {
      const row = await API.addDayExercise(editDayState.programId, editDayState.dayId, {
        exercise_id: exerciseId,
        target_sets: 3,
        target_reps: 10
      });
      editDayState.day.exercises.push(row);
      hideSheet(picker);
      renderEditSheet();
    } catch (err) {
      toast(err.message);
    }
  };
}

function ensurePicker() {
  let picker = document.getElementById('picker-sheet');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'picker-sheet';
    picker.className = 'sheet hidden';
    document.body.appendChild(picker);
  }
  return picker;
}

function openNewExerciseForm(picker) {
  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-back-picker>←</button>
        <div class="sheet__title">New exercise</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <label class="form-label">Name</label>
        <input class="input" id="new-ex-name" placeholder="e.g. Cable Pullover" />

        <label class="form-label" style="margin-top:14px">Muscle group</label>
        <select class="input" id="new-ex-muscle">
          <option value="chest">chest</option>
          <option value="back">back</option>
          <option value="shoulders">shoulders</option>
          <option value="arms">arms</option>
          <option value="legs">legs</option>
          <option value="core">core</option>
        </select>

        <label class="form-label" style="margin-top:14px">Notes (optional)</label>
        <input class="input" id="new-ex-notes" placeholder="Setup cue or variation" />

        <button class="btn btn--primary btn--block" id="new-ex-save" style="margin-top:20px">Create & add</button>
      </div>
    </div>
  `;

  picker.querySelector('[data-back-picker]').onclick = () => openPicker();
  picker.querySelector('#new-ex-save').onclick = async () => {
    const name = picker.querySelector('#new-ex-name').value.trim();
    const muscle = picker.querySelector('#new-ex-muscle').value;
    const notes = picker.querySelector('#new-ex-notes').value.trim() || null;
    if (!name) return toast('Name required');
    try {
      const ex = await API.addExercise({ name, muscle_group: muscle, notes });
      // Refresh exercise list so picker shows it next time
      editDayState.allExercises.push(ex);
      // Immediately add to day
      const row = await API.addDayExercise(editDayState.programId, editDayState.dayId, {
        exercise_id: ex.id,
        target_sets: 3,
        target_reps: 10
      });
      editDayState.day.exercises.push(row);
      hideSheet(picker);
      renderEditSheet();
    } catch (err) {
      toast(err.message);
    }
  };
}

// ---------- WORKOUT tab ----------
let workoutState = null;
let stickyTimerHandle = null;

async function renderWorkout() {
  const root = $('#view-workout');
  const activeId = Number(localStorage.getItem(LS.activeWorkoutId) || 0);

  if (!activeId) {
    root.innerHTML = `
      <div class="empty">
        <div class="empty__icon">&#x1F4AA;</div>
        <div style="margin-bottom:12px">No active workout</div>
        <button class="btn btn--primary" data-go-programs>Pick a program</button>
      </div>`;
    root.onclick = (e) => {
      if (e.target.closest('[data-go-programs]')) setTab('programs');
    };
    return;
  }

  root.innerHTML = skeletonBlocks(3);

  try {
    const workout = await API.workout(activeId);
    if (workout.finished_at) {
      // Stale active ref — clean up
      localStorage.removeItem(LS.activeWorkoutId);
      localStorage.removeItem(LS.activeProgramDayId);
      return renderWorkout();
    }

    const programDayId =
      workout.program_day_id || Number(localStorage.getItem(LS.activeProgramDayId) || 0);
    if (!programDayId) {
      root.innerHTML = `<div class="empty">Workout has no program day attached.</div>`;
      return;
    }

    // Get program + day details
    const days = await fetchDayDetails(programDayId);
    const last = await API.lastWorkout(programDayId).catch(() => null);

    workoutState = {
      workout,
      programDay: days,
      last,
      startedAt: workout.started_at,
      loggedSets: [...(workout.sets || [])],
      openExtras: new Set()
    };

    localStorage.setItem(LS.activeWorkoutStart, workout.started_at);

    renderWorkoutView();
    startStickyTimer();
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load workout: ${err.message}</div>`;
  }
}

async function fetchDayDetails(dayId) {
  const programs = await API.programs();
  for (const p of programs) {
    const full = await API.program(p.id);
    const day = full.days.find((d) => d.id === dayId);
    if (day) return { ...day, program_name: full.name };
  }
  throw new Error('Program day not found');
}

function renderWorkoutView() {
  const root = $('#view-workout');
  const { programDay, last, workout, loggedSets } = workoutState;

  const lastSetsByExercise = {};
  if (last?.sets) {
    for (const s of last.sets) {
      if (!lastSetsByExercise[s.exercise_id]) lastSetsByExercise[s.exercise_id] = [];
      lastSetsByExercise[s.exercise_id].push(s);
    }
    for (const arr of Object.values(lastSetsByExercise))
      arr.sort((a, b) => a.set_number - b.set_number);
  }

  const loggedByExerciseSet = {};
  for (const s of loggedSets) {
    loggedByExerciseSet[`${s.exercise_id}-${s.set_number}`] = s;
  }

  const bodyHTML = programDay.exercises
    .map((ex) => exerciseCardHTML(ex, lastSetsByExercise[ex.exercise_id] || [], loggedByExerciseSet))
    .join('');

  root.innerHTML = `
    <div class="workout-sticky">
      <div>
        <div class="workout-sticky__name">${escapeHtml(programDay.day_label)}</div>
      </div>
      <div class="workout-sticky__time" id="sticky-elapsed">0:00</div>
    </div>
    <div id="rest-sticky" class="rest-sticky hidden"></div>
    ${bodyHTML}
    <div class="workout-notes-wrap">
      <label class="form-label">Workout notes</label>
      <textarea class="input workout-notes" data-workout-notes rows="2" placeholder="How did it feel? Energy, form cues…">${escapeHtml(workout.notes || '')}</textarea>
    </div>
    <div class="finish-bar">
      <button class="btn btn--ghost" data-cancel-workout>Cancel</button>
      <button class="btn btn--primary btn--block" data-finish-workout>Finish workout</button>
    </div>
  `;

  wireWorkoutView();
}

function exerciseCardHTML(ex, lastSets, loggedBySet) {
  const target = ex.target_sets;
  const prevReference = lastSets[0];
  const prefillWeight = prevReference?.weight ?? '';
  const prefillUnit = prevReference?.weight_unit || 'kg';
  const prefillReps = prevReference?.reps ?? ex.target_reps;

  // overload nudge: all last sets hit weight & target reps
  let overload = false;
  if (lastSets.length >= target) {
    const allHit = lastSets.slice(0, target).every(
      (s) => s.reps >= ex.target_reps && s.weight === prefillReference(lastSets).weight
    );
    overload = allHit;
  }

  const rows = [];
  for (let i = 1; i <= target; i++) {
    const key = `${ex.exercise_id}-${i}`;
    const logged = loggedBySet[key];
    const prevSet = lastSets.find((s) => s.set_number === i) || prevReference;
    const w = logged?.weight ?? prevSet?.weight ?? prefillWeight;
    const u = logged?.weight_unit ?? prevSet?.weight_unit ?? prefillUnit;
    const r = logged?.reps ?? prevSet?.reps ?? prefillReps;
    rows.push(setRowHTML(ex, i, { w, u, r, logged }));
  }

  return `
    <div class="exercise-card" data-ex="${ex.exercise_id}">
      <div class="exercise-card__head">
        <div>
          <div class="exercise-card__name">${escapeHtml(ex.name)}</div>
          <div class="card__subtitle">${target} × ${ex.target_reps}</div>
        </div>
        <span class="badge badge--muscle">${escapeHtml(ex.muscle_group)}</span>
      </div>
      ${overload ? `<div class="overload-banner">Ready to progress — try +${stepFor(prefillUnit)}${prefillUnit} today</div>` : ''}
      <div class="set-rows">
        ${rows.join('')}
      </div>
    </div>
  `;
}

function prefillReference(lastSets) {
  return lastSets[0] || { weight: 0, weight_unit: 'kg' };
}

function setRowHTML(ex, setNumber, { w, u, r, logged }) {
  const wStr = w === '' ? '' : Number(w);
  return `
    <div class="set-row ${logged ? 'done' : ''}" data-ex="${ex.exercise_id}" data-set="${setNumber}" ${logged ? `data-set-id="${logged.id}"` : ''}>
      <div class="set-row__num">${setNumber}</div>
      <div class="num-input" data-field="weight">
        <button class="num-input__btn" data-step="-1">−</button>
        <input class="num-input__field" type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" value="${wStr}" aria-label="weight"/>
        <button class="num-input__btn" data-step="1">+</button>
      </div>
      <button class="unit-toggle ${u === 'kg' ? 'kg' : 'lbs'}" data-unit>${u}</button>
      <div class="num-input" data-field="reps">
        <button class="num-input__btn" data-step="-1">−</button>
        <input class="num-input__field" type="text" inputmode="numeric" pattern="[0-9]*" value="${r ?? ''}" aria-label="reps"/>
        <button class="num-input__btn" data-step="1">+</button>
      </div>
      <button class="set-check" data-confirm>&#x2713;</button>

      <div class="set-row__extras">
        <div class="set-row__tools">
          <button data-toggle-note>&#x270E; note</button>
          <button data-rest class="rest-timer">start rest</button>
        </div>
        <input class="set-row__note" data-note placeholder="Form cue, RPE, etc." />
      </div>
      ${logged ? '<div class="set-row__delete" data-delete>Delete</div>' : ''}
    </div>
  `;
}

function wireWorkoutView() {
  const root = $('#view-workout');
  root.onclick = async (e) => {
    // Sticky buttons
    if (e.target.closest('[data-finish-workout]')) return finishWorkout();
    if (e.target.closest('[data-cancel-workout]')) return cancelWorkout();
    if (e.target.closest('[data-rest-cancel]')) return cancelRestCountdown();

    const row = e.target.closest('.set-row');
    if (!row) return;

    const unitBtn = e.target.closest('[data-unit]');
    if (unitBtn) {
      const cur = unitBtn.textContent.trim();
      const next = cur === 'kg' ? 'lbs' : 'kg';
      unitBtn.textContent = next;
      unitBtn.classList.toggle('kg', next === 'kg');
      return;
    }

    const stepBtn = e.target.closest('.num-input__btn');
    if (stepBtn) {
      const wrap = stepBtn.closest('.num-input');
      const input = wrap.querySelector('.num-input__field');
      const field = wrap.dataset.field;
      let v = parseFloat(input.value || '0');
      if (Number.isNaN(v)) v = 0;
      const unit = row.querySelector('[data-unit]').textContent.trim();
      const step = Number(stepBtn.dataset.step) * (field === 'weight' ? stepFor(unit) : 1);
      let next = v + step;
      if (next < 0) next = 0;
      input.value = field === 'weight' ? String(+next.toFixed(2)) : String(Math.floor(next));
      haptic(10);
      return;
    }

    const confirm = e.target.closest('[data-confirm]');
    if (confirm) return confirmSet(row);

    const noteToggle = e.target.closest('[data-toggle-note]');
    if (noteToggle) {
      row.classList.toggle('extras-open');
      const noteInput = row.querySelector('[data-note]');
      if (row.classList.contains('extras-open')) noteInput.focus();
      return;
    }

    const restBtn = e.target.closest('[data-rest]');
    if (restBtn) return toggleRestTimer(restBtn, row);

    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) return deleteLoggedSet(row);
  };

  // Workout-level notes: PATCH on blur if changed
  const notesEl = root.querySelector('[data-workout-notes]');
  if (notesEl) {
    notesEl.onblur = async () => {
      const value = notesEl.value.trim() || null;
      const current = workoutState.workout.notes || null;
      if (value === current) return;
      try {
        await API.updateWorkout(workoutState.workout.id, { notes: value });
        workoutState.workout.notes = value;
      } catch (err) {
        toast(err.message);
      }
    };
  }

  // Swipe-to-delete
  let touchStartX = null;
  let currentRow = null;
  root.ontouchstart = (e) => {
    const row = e.target.closest('.set-row');
    if (!row || !row.dataset.setId) return;
    touchStartX = e.touches[0].clientX;
    currentRow = row;
  };
  root.ontouchmove = (e) => {
    if (!currentRow || touchStartX === null) return;
    const dx = e.touches[0].clientX - touchStartX;
    if (dx < -60) currentRow.classList.add('swiped');
    else if (dx > 10) currentRow.classList.remove('swiped');
  };
  root.ontouchend = () => {
    touchStartX = null;
    currentRow = null;
  };
}

async function confirmSet(row) {
  const exId = Number(row.dataset.ex);
  const setNumber = Number(row.dataset.set);
  const unit = row.querySelector('[data-unit]').textContent.trim();
  const weight = parseFloat(
    row.querySelector('[data-field="weight"] .num-input__field').value || '0'
  );
  const reps = parseInt(
    row.querySelector('[data-field="reps"] .num-input__field').value || '0',
    10
  );
  const note = row.querySelector('[data-note]')?.value?.trim() || null;

  if (!weight || !reps) {
    toast('Enter weight and reps first');
    return;
  }

  try {
    if (row.dataset.setId) {
      // Already logged: update
      await API.updateSet(Number(row.dataset.setId), {
        weight,
        weight_unit: unit,
        reps,
        notes: note
      });
      haptic(20);
      toast('Set updated');
    } else {
      const res = await API.logSet({
        workout_id: workoutState.workout.id,
        exercise_id: exId,
        set_number: setNumber,
        weight,
        weight_unit: unit,
        reps,
        notes: note
      });
      row.dataset.setId = res.id;
      row.classList.add('done');
      workoutState.loggedSets.push(res);
      haptic(30);
      if (res.is_new_pr) showPRFlash();
      startRestCountdown();
    }
  } catch (err) {
    toast(err.message);
  }
}

async function deleteLoggedSet(row) {
  const id = Number(row.dataset.setId);
  if (!id) return;
  try {
    await API.deleteSet(id);
    workoutState.loggedSets = workoutState.loggedSets.filter((s) => s.id !== id);
    row.classList.remove('done', 'swiped');
    row.removeAttribute('data-set-id');
    // Remove the delete overlay
    const overlay = row.querySelector('[data-delete]');
    if (overlay) overlay.remove();
    haptic(20);
    toast('Set deleted');
  } catch (err) {
    toast(err.message);
  }
}

function toggleRestTimer() {
  if (restState) cancelRestCountdown();
  else startRestCountdown();
}

function startStickyTimer() {
  if (stickyTimerHandle) clearInterval(stickyTimerHandle);
  const tick = () => {
    const el = $('#sticky-elapsed');
    if (!el) return;
    el.textContent = fmtDuration(workoutState.startedAt);
  };
  tick();
  stickyTimerHandle = setInterval(tick, 1000);
}

async function cancelWorkout() {
  if (!confirm('Cancel this workout? Logged sets will be kept.')) return;
  localStorage.removeItem(LS.activeWorkoutId);
  localStorage.removeItem(LS.activeProgramDayId);
  if (stickyTimerHandle) clearInterval(stickyTimerHandle);
  setTab('programs');
}

async function finishWorkout() {
  const id = workoutState?.workout?.id;
  if (!id) return;
  try {
    await API.finishWorkout(id);
    if (stickyTimerHandle) clearInterval(stickyTimerHandle);

    const sets = await API.workoutSets(id);
    const totalVolume = sets.reduce((acc, s) => acc + s.weight * s.reps, 0);

    const prs = await API.prs();
    const newPRs = prs.flatMap((g) =>
      g.records
        .filter((r) => {
          const achieved = new Date(r.achieved_at.replace(' ', 'T') + 'Z').getTime();
          const started = new Date(workoutState.startedAt.replace(' ', 'T') + 'Z').getTime();
          return achieved >= started;
        })
        .map((r) => ({ name: g.exercise_name, ...r }))
    );

    renderSummary({
      sets: sets.length,
      volume: totalVolume,
      duration: fmtDuration(workoutState.startedAt, new Date().toISOString()),
      newPRs,
      dayLabel: workoutState.programDay.day_label
    });

    localStorage.removeItem(LS.activeWorkoutId);
    localStorage.removeItem(LS.activeProgramDayId);
    localStorage.removeItem(LS.activeWorkoutStart);
    workoutState = null;
  } catch (err) {
    toast(err.message);
  }
}

function renderSummary({ sets, volume, duration, newPRs, dayLabel }) {
  const root = $('#view-workout');
  root.innerHTML = `
    <div class="summary">
      <div class="summary__stat">${escapeHtml(dayLabel)}</div>
      <div class="card__subtitle">Workout complete</div>
      <div class="summary__grid">
        <div class="summary__tile">
          <div class="summary__tile-label">Sets</div>
          <div class="summary__tile-value">${sets}</div>
        </div>
        <div class="summary__tile">
          <div class="summary__tile-label">Volume</div>
          <div class="summary__tile-value">${Math.round(volume).toLocaleString()}</div>
        </div>
        <div class="summary__tile">
          <div class="summary__tile-label">Time</div>
          <div class="summary__tile-value">${duration}</div>
        </div>
      </div>
      ${
        newPRs.length
          ? `<div class="card" style="text-align:left">
              <div class="card__title">New PRs &#x1F3C6;</div>
              ${newPRs
                .map(
                  (pr) =>
                    `<div class="card__subtitle" style="margin-top:6px"><strong style="color:var(--accent)">${escapeHtml(pr.name)}</strong> — ${pr.weight}${pr.weight_unit} × ${pr.reps}</div>`
                )
                .join('')}
            </div>`
          : ''
      }
      <button class="btn btn--primary btn--block" data-go-programs>Done</button>
    </div>
  `;
  root.onclick = (e) => {
    if (e.target.closest('[data-go-programs]')) setTab('programs');
  };
}

// ---------- PROGRESS tab ----------
const chartInstances = {};

async function renderProgress() {
  const root = $('#view-progress');
  root.innerHTML = `
    <div class="progress-section">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Body Weight</div>
        <button class="btn btn--ghost btn--sm" data-log-bw>+ Log</button>
      </div>
      <div id="bw-current" class="bw-current"></div>
      <div class="chart-wrap bw-chart-wrap hidden" id="bw-chart-wrap"><canvas id="bw-chart"></canvas></div>
      <div id="bw-recent" class="bw-recent"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Strength Curve</div>
      <select class="input" id="strength-ex"></select>
      <div class="chart-wrap" style="margin-top:12px"><canvas id="strength-chart"></canvas></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Weekly Volume by Muscle Group</div>
      <div class="chart-wrap"><canvas id="volume-chart"></canvas></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Consistency (6 months)</div>
      <div id="calendar" class="calendar"></div>
    </div>
  `;

  root.onclick = async (e) => {
    if (e.target.closest('[data-log-bw]')) return openBodyweightSheet();
    const del = e.target.closest('[data-del-bw]');
    if (del) {
      const id = Number(del.dataset.delBw);
      if (!confirm('Delete this entry?')) return;
      try {
        await API.deleteBodyweight(id);
        await renderBodyweightSection();
      } catch (err) {
        toast(err.message);
      }
    }
  };

  try {
    const [exercises, weekly, calendarDates] = await Promise.all([
      API.exercises(),
      API.weeklyVolume(),
      API.calendar()
    ]);

    await renderBodyweightSection();

    const sel = $('#strength-ex');
    sel.innerHTML =
      '<option value="">Select an exercise…</option>' +
      exercises
        .map(
          (e) => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.muscle_group)})</option>`
        )
        .join('');
    sel.onchange = async () => {
      const id = Number(sel.value);
      if (!id) return;
      const data = await API.progress(id);
      renderStrengthChart(data);
    };

    renderVolumeChart(weekly);
    renderCalendar(calendarDates);
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load progress: ${err.message}</div>`;
  }
}

function chartDefaults() {
  return {
    ticks: { color: '#8a8a8a' },
    grid: { color: 'rgba(255,255,255,0.06)' },
    border: { display: false }
  };
}

function renderStrengthChart({ sets, prs }) {
  const canvas = document.getElementById('strength-chart');
  if (!canvas) return;
  if (chartInstances.strength) chartInstances.strength.destroy();

  // Max weight per day
  const byDay = new Map();
  for (const s of sets) {
    const day = s.logged_at.slice(0, 10);
    const weightKg = s.weight_unit === 'lbs' ? s.weight * 0.45359237 : s.weight;
    const prev = byDay.get(day) || 0;
    if (weightKg > prev) byDay.set(day, weightKg);
  }
  const labels = [...byDay.keys()].sort();
  const values = labels.map((l) => Number(byDay.get(l).toFixed(1)));

  const prDays = new Set(prs.map((p) => p.achieved_at.slice(0, 10)));
  const pointStyle = labels.map((l) => (prDays.has(l) ? 'star' : 'circle'));
  const pointSize = labels.map((l) => (prDays.has(l) ? 9 : 4));
  const d = chartDefaults();

  chartInstances.strength = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: values,
          borderColor: '#e8ff47',
          backgroundColor: 'rgba(232,255,71,0.1)',
          tension: 0.25,
          fill: true,
          pointStyle,
          pointRadius: pointSize,
          pointBackgroundColor: '#e8ff47',
          pointBorderColor: '#0f0f0f'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} kg` } } },
      scales: { x: d, y: { ...d, beginAtZero: true } }
    }
  });
}

function renderVolumeChart(rows) {
  const canvas = document.getElementById('volume-chart');
  if (!canvas) return;
  if (chartInstances.volume) chartInstances.volume.destroy();

  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  const groups = [...new Set(rows.map((r) => r.muscle_group))];
  const palette = {
    chest: '#e8ff47',
    back: '#62d8ff',
    shoulders: '#ffb347',
    arms: '#c6a1ff',
    legs: '#9effa8'
  };
  const defaults = chartDefaults();

  const datasets = groups.map((g) => ({
    label: g,
    data: weeks.map((w) => {
      const row = rows.find((r) => r.week === w && r.muscle_group === g);
      return row ? Math.round(row.volume) : 0;
    }),
    backgroundColor: palette[g] || '#888',
    borderRadius: 4
  }));

  chartInstances.volume = new Chart(canvas, {
    type: 'bar',
    data: { labels: weeks, datasets },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#c8c8c8', boxWidth: 12 } } },
      scales: { x: { ...defaults, stacked: true }, y: { ...defaults, stacked: true, beginAtZero: true } }
    }
  });
}

function renderCalendar(dates) {
  const set = new Set(dates);
  const root = $('#calendar');
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const start = new Date(today);
  start.setMonth(start.getMonth() - 6);
  // Start on Sunday of that week
  start.setDate(start.getDate() - start.getDay());

  const cells = [];
  const cursor = new Date(start);
  while (cursor <= today) {
    const iso = cursor.toISOString().slice(0, 10);
    const active = set.has(iso);
    cells.push(
      `<div class="calendar__cell${active ? ' active' : ''}" title="${iso}${active ? ' — worked out' : ''}"></div>`
    );
    cursor.setDate(cursor.getDate() + 1);
  }

  root.innerHTML = cells.join('');
}

async function renderBodyweightSection() {
  const currentEl = $('#bw-current');
  const recentEl = $('#bw-recent');
  const chartWrap = $('#bw-chart-wrap');
  if (!currentEl) return;

  let rows = [];
  try {
    rows = await API.bodyweight();
  } catch (err) {
    currentEl.innerHTML = `<div class="bw-current__empty">${escapeHtml(err.message)}</div>`;
    return;
  }

  if (!rows.length) {
    currentEl.innerHTML = `<div class="bw-current__empty">No entries yet. Tap + Log to add your first one.</div>`;
    recentEl.innerHTML = '';
    chartWrap.classList.add('hidden');
    if (chartInstances.bw) {
      chartInstances.bw.destroy();
      delete chartInstances.bw;
    }
    return;
  }

  const latest = rows[0];
  let trend = '';
  if (rows.length > 1) {
    const prev = rows[1];
    const pKg = prev.weight_unit === 'lbs' ? prev.weight * 0.45359237 : prev.weight;
    const lKg = latest.weight_unit === 'lbs' ? latest.weight * 0.45359237 : latest.weight;
    const diff = lKg - pKg;
    if (Math.abs(diff) >= 0.05) {
      const arrow = diff > 0 ? '▲' : '▼';
      trend = `<span class="bw-current__trend ${diff > 0 ? 'up' : 'down'}">${arrow} ${Math.abs(diff).toFixed(1)} kg</span>`;
    }
  }

  currentEl.innerHTML = `
    <div class="bw-current__main">
      <span class="bw-current__val">${latest.weight}</span>
      <span class="bw-current__unit">${latest.weight_unit}</span>
      ${trend}
    </div>
    <div class="bw-current__when">${humanAgo(latest.logged_at)}</div>
  `;

  if (rows.length >= 2) {
    chartWrap.classList.remove('hidden');
    renderBwChart(rows);
  } else {
    chartWrap.classList.add('hidden');
  }

  recentEl.innerHTML =
    '<div class="bw-recent__title">Recent</div>' +
    rows
      .slice(0, 8)
      .map(
        (r) => `
          <div class="bw-item">
            <div class="bw-item__main">
              <div class="bw-item__w">${r.weight} ${r.weight_unit}</div>
              <div class="bw-item__when">${formatDateShort(r.logged_at)}${r.notes ? ' · ' + escapeHtml(r.notes) : ''}</div>
            </div>
            <button class="btn--icon btn--icon-danger" data-del-bw="${r.id}" aria-label="Delete">&times;</button>
          </div>
        `
      )
      .join('');
}

function renderBwChart(rows) {
  const canvas = document.getElementById('bw-chart');
  if (!canvas) return;
  if (chartInstances.bw) chartInstances.bw.destroy();

  const chronological = [...rows].reverse();
  const labels = chronological.map((r) => r.logged_at.slice(0, 10));
  const values = chronological.map((r) =>
    Number((r.weight_unit === 'lbs' ? r.weight * 0.45359237 : r.weight).toFixed(1))
  );
  const d = chartDefaults();

  chartInstances.bw = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        {
          data: values,
          borderColor: '#62d8ff',
          backgroundColor: 'rgba(98,216,255,0.12)',
          tension: 0.25,
          fill: true,
          pointRadius: 3,
          pointBackgroundColor: '#62d8ff',
          pointBorderColor: '#0f0f0f'
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} kg` } }
      },
      scales: { x: d, y: { ...d, beginAtZero: false } }
    }
  });
}

function openBodyweightSheet() {
  const sheet = ensureBwSheet();
  const today = new Date();
  const iso = today.toISOString().slice(0, 16); // datetime-local format
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Log body weight</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <label class="form-label">Weight</label>
        <div class="set-edit__row">
          <div class="num-input" data-field="weight">
            <button class="num-input__btn" data-bw-step="-1">−</button>
            <input class="num-input__field" id="bw-weight" type="text" inputmode="decimal" value=""/>
            <button class="num-input__btn" data-bw-step="1">+</button>
          </div>
          <button class="unit-toggle kg" id="bw-unit">kg</button>
        </div>

        <label class="form-label" style="margin-top:14px">Date</label>
        <input class="input" id="bw-date" type="datetime-local" value="${iso}"/>

        <label class="form-label" style="margin-top:14px">Notes (optional)</label>
        <input class="input" id="bw-notes" placeholder="Morning, fasted, etc."/>

        <button class="btn btn--primary btn--block" id="bw-save" style="margin-top:20px">Save</button>
      </div>
    </div>
  `;
  showSheet(sheet);

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);

    const unitBtn = e.target.closest('#bw-unit');
    if (unitBtn) {
      const next = unitBtn.textContent.trim() === 'kg' ? 'lbs' : 'kg';
      unitBtn.textContent = next;
      unitBtn.classList.toggle('kg', next === 'kg');
      return;
    }

    const step = e.target.closest('[data-bw-step]');
    if (step) {
      const input = document.getElementById('bw-weight');
      let v = parseFloat(input.value || '0');
      if (Number.isNaN(v)) v = 0;
      const unit = document.getElementById('bw-unit').textContent.trim();
      const delta = Number(step.dataset.bwStep) * (unit === 'lbs' ? 1 : 0.5);
      let next = v + delta;
      if (next < 0) next = 0;
      input.value = String(+next.toFixed(2));
      haptic(10);
      return;
    }

    if (e.target.closest('#bw-save')) {
      const weight = parseFloat(document.getElementById('bw-weight').value || '0');
      const unit = document.getElementById('bw-unit').textContent.trim();
      const notes = document.getElementById('bw-notes').value.trim() || null;
      const dateVal = document.getElementById('bw-date').value;
      if (!weight || weight <= 0) return toast('Enter a weight');

      let logged_at = null;
      if (dateVal) {
        // datetime-local is local time; convert to UTC "YYYY-MM-DD HH:MM:SS"
        const d = new Date(dateVal);
        logged_at = d.toISOString().slice(0, 19).replace('T', ' ');
      }

      try {
        await API.addBodyweight({ weight, weight_unit: unit, notes, logged_at });
        hideSheet(sheet);
        haptic(20);
        toast('Logged');
        await renderBodyweightSection();
      } catch (err) {
        toast(err.message);
      }
    }
  };
}

function ensureBwSheet() {
  let sheet = document.getElementById('bw-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'bw-sheet';
    sheet.className = 'sheet hidden';
    document.body.appendChild(sheet);
  }
  return sheet;
}

// ---------- HISTORY tab ----------
async function renderHistory() {
  const root = $('#view-history');
  root.innerHTML = `
    <input class="input" id="history-filter" placeholder="Filter by exercise name…" style="margin-bottom:12px"/>
    <div id="history-list">${skeletonBlocks(4)}</div>
  `;

  try {
    const history = await API.history();
    const list = $('#history-list');

    if (!history.length) {
      list.innerHTML = `<div class="empty">No workouts yet</div>`;
      return;
    }
    list.innerHTML = history.map((w) => historyCardHTML(w)).join('');

    $('#history-filter').oninput = (e) => {
      list.dataset.filter = e.target.value.trim().toLowerCase();
      const f = list.dataset.filter;
      [...list.querySelectorAll('.history-card')].forEach((card) => {
        if (!f) {
          card.classList.remove('hidden');
          return;
        }
        const hay = card.dataset.exerciseNames || '';
        card.classList.toggle('hidden', hay && !hay.includes(f));
      });
    };

    list.onclick = async (e) => {
      // Edit a logged set
      const editSetBtn = e.target.closest('[data-edit-set]');
      if (editSetBtn) {
        e.stopPropagation();
        const card = editSetBtn.closest('.history-card');
        openEditSetSheet(Number(editSetBtn.dataset.editSet), Number(card.dataset.id));
        return;
      }

      // Add a set to an exercise in a finished workout
      const addSetBtn = e.target.closest('[data-add-set]');
      if (addSetBtn) {
        e.stopPropagation();
        const card = addSetBtn.closest('.history-card');
        openAddSetSheet(
          Number(addSetBtn.dataset.addSet),
          Number(card.dataset.id),
          Number(addSetBtn.dataset.nextSet),
          addSetBtn.dataset.exName
        );
        return;
      }

      // Delete whole workout
      const delWorkoutBtn = e.target.closest('[data-delete-workout]');
      if (delWorkoutBtn) {
        e.stopPropagation();
        const card = delWorkoutBtn.closest('.history-card');
        if (!confirm('Delete this workout and all its sets? This cannot be undone.')) return;
        try {
          await API.deleteWorkout(Number(card.dataset.id));
          renderHistory();
        } catch (err) {
          toast(err.message);
        }
        return;
      }

      // Ignore clicks inside the notes input or the body area
      if (e.target.closest('[data-history-notes], .history-ex__sets, .history-card__body-actions')) {
        return;
      }

      // Head expand/collapse
      const head = e.target.closest('.history-card__head');
      if (!head) return;
      const card = head.closest('.history-card');
      card.classList.toggle('expanded');
      if (card.classList.contains('expanded') && !card.dataset.loaded) {
        await loadHistoryCardBody(card);
      }
    };

    // Save workout notes on blur (event delegation)
    list.addEventListener('focusout', async (e) => {
      const notesInput = e.target.closest('[data-history-notes]');
      if (!notesInput) return;
      const card = notesInput.closest('.history-card');
      const id = Number(card.dataset.id);
      const value = notesInput.value.trim() || null;
      const prev = notesInput.dataset.prev || null;
      if (value === prev) return;
      try {
        await API.updateWorkout(id, { notes: value });
        notesInput.dataset.prev = value ?? '';
      } catch (err) {
        toast(err.message);
      }
    });
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load history: ${err.message}</div>`;
  }
}

async function loadHistoryCardBody(card) {
  const id = Number(card.dataset.id);
  const body = card.querySelector('.history-card__body');
  body.innerHTML = `<div class="skeleton" style="height:80px"></div>`;
  try {
    const [sets, workout] = await Promise.all([API.workoutSets(id), API.workout(id)]);
    const grouped = {};
    for (const s of sets) {
      if (!grouped[s.exercise_id]) {
        grouped[s.exercise_id] = {
          exerciseId: s.exercise_id,
          name: s.exercise_name,
          muscle: s.muscle_group,
          sets: []
        };
      }
      grouped[s.exercise_id].sets.push(s);
    }
    for (const g of Object.values(grouped)) {
      g.sets.sort((a, b) => a.set_number - b.set_number);
    }

    const exHTML = Object.values(grouped)
      .map(
        (g) => `
          <div class="history-ex" data-ex="${g.exerciseId}">
            <div class="history-ex__name">${escapeHtml(g.name)}</div>
            <div class="history-ex__sets">
              ${g.sets
                .map(
                  (s) => `
                    <button class="history-ex__set" data-edit-set="${s.id}">
                      <span class="history-ex__set-n">Set ${s.set_number}</span>
                      <span class="history-ex__set-w">${s.weight}${s.weight_unit} × ${s.reps}</span>
                      ${s.notes ? `<span class="history-ex__set-note">${escapeHtml(s.notes)}</span>` : ''}
                    </button>
                  `
                )
                .join('')}
              <button class="history-ex__addset" data-add-set="${g.exerciseId}" data-next-set="${g.sets.length + 1}" data-ex-name="${escapeHtml(g.name)}">+ Add set</button>
            </div>
          </div>
        `
      )
      .join('');

    const notes = workout.notes || '';
    body.innerHTML = `
      ${exHTML || '<div class="empty">No sets logged</div>'}
      <div class="history-card__body-actions">
        <label class="form-label">Workout notes</label>
        <textarea class="input" data-history-notes rows="2" data-prev="${escapeHtml(notes)}" placeholder="How did it go?">${escapeHtml(notes)}</textarea>
        <button class="btn btn--ghost btn--sm" data-delete-workout style="color:var(--danger);margin-top:10px">Delete workout</button>
      </div>
    `;
    card.dataset.loaded = '1';
    card.dataset.exerciseNames = Object.values(grouped)
      .map((g) => g.name.toLowerCase())
      .join('|');
  } catch (err) {
    body.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`;
  }
}

async function refreshHistoryCard(workoutId) {
  try {
    const history = await API.history();
    const w = history.find((x) => x.id === workoutId);
    const card = document.querySelector(`.history-card[data-id="${workoutId}"]`);
    if (!card) return renderHistory();
    if (!w) return renderHistory();

    const stats = card.querySelector('.history-card__stats');
    if (stats) {
      stats.innerHTML = `${w.total_sets} sets<br/>${Math.round(w.total_volume).toLocaleString()} kg`;
    }

    if (card.classList.contains('expanded')) {
      card.dataset.loaded = '';
      await loadHistoryCardBody(card);
    }
  } catch (err) {
    toast(err.message);
  }
}

function historyCardHTML(w) {
  const started = new Date(w.started_at.replace(' ', 'T') + 'Z');
  const finished = w.finished_at ? new Date(w.finished_at.replace(' ', 'T') + 'Z') : null;
  const durMs = finished ? finished - started : 0;
  const durMin = Math.floor(durMs / 60000);
  const dur = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : `${durMin}m`;
  return `
    <div class="history-card" data-id="${w.id}">
      <button class="history-card__head">
        <div>
          <div class="history-card__title">${escapeHtml(w.day_label || 'Workout')}</div>
          <div class="history-card__meta">${started.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${dur}</div>
        </div>
        <div class="history-card__stats">
          ${w.total_sets} sets<br/>
          ${Math.round(w.total_volume).toLocaleString()} kg
        </div>
      </button>
      <div class="history-card__body"></div>
    </div>
  `;
}

// ---------- Set edit/add sheet (for history) ----------
let setEditState = null;

async function openEditSetSheet(setId, workoutId) {
  const sheet = ensureSetEditSheet();
  sheet.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(sheet);
  try {
    const sets = await API.workoutSets(workoutId);
    const set = sets.find((s) => s.id === setId);
    if (!set) throw new Error('Set not found');
    setEditState = {
      mode: 'edit',
      setId,
      workoutId,
      exerciseId: set.exercise_id,
      exerciseName: set.exercise_name,
      setNumber: set.set_number,
      weight: set.weight,
      weight_unit: set.weight_unit,
      reps: set.reps,
      notes: set.notes || ''
    };
    renderSetEditSheet();
  } catch (err) {
    sheet.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
  }
}

async function openAddSetSheet(exerciseId, workoutId, nextSetNumber, exName) {
  const sheet = ensureSetEditSheet();
  let prior = null;
  try {
    const sets = await API.workoutSets(workoutId);
    const priors = sets
      .filter((s) => s.exercise_id === exerciseId)
      .sort((a, b) => b.set_number - a.set_number);
    prior = priors[0];
  } catch {
    /* ignore — use defaults */
  }
  setEditState = {
    mode: 'add',
    workoutId,
    exerciseId,
    exerciseName: prior?.exercise_name || exName || '',
    setNumber: nextSetNumber,
    weight: prior?.weight ?? 0,
    weight_unit: prior?.weight_unit || 'kg',
    reps: prior?.reps ?? 10,
    notes: ''
  };
  renderSetEditSheet();
  showSheet(sheet);
}

function ensureSetEditSheet() {
  let sheet = document.getElementById('set-edit-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'set-edit-sheet';
    sheet.className = 'sheet hidden';
    document.body.appendChild(sheet);
  }
  return sheet;
}

function renderSetEditSheet() {
  const sheet = document.getElementById('set-edit-sheet');
  const s = setEditState;
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">${s.mode === 'edit' ? 'Edit set' : 'Add set'}</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="set-edit__head">
          <div class="set-edit__ex">${escapeHtml(s.exerciseName)}</div>
          <div class="card__subtitle">Set ${s.setNumber}</div>
        </div>

        <label class="form-label" style="margin-top:18px">Weight</label>
        <div class="set-edit__row">
          <div class="num-input" data-field="weight">
            <button class="num-input__btn" data-se-step="-1">−</button>
            <input class="num-input__field" id="se-weight" type="text" inputmode="decimal" value="${s.weight}"/>
            <button class="num-input__btn" data-se-step="1">+</button>
          </div>
          <button class="unit-toggle ${s.weight_unit === 'kg' ? 'kg' : 'lbs'}" id="se-unit">${s.weight_unit}</button>
        </div>

        <label class="form-label" style="margin-top:14px">Reps</label>
        <div class="num-input" data-field="reps">
          <button class="num-input__btn" data-se-step-reps="-1">−</button>
          <input class="num-input__field" id="se-reps" type="text" inputmode="numeric" value="${s.reps}"/>
          <button class="num-input__btn" data-se-step-reps="1">+</button>
        </div>

        <label class="form-label" style="margin-top:14px">Notes</label>
        <input class="input" id="se-notes" value="${escapeHtml(s.notes)}" placeholder="Optional"/>

        <button class="btn btn--primary btn--block" id="se-save" style="margin-top:20px">${s.mode === 'edit' ? 'Save changes' : 'Add set'}</button>
        ${s.mode === 'edit' ? `<button class="btn btn--ghost btn--block" id="se-delete" style="margin-top:10px;color:var(--danger)">Delete set</button>` : ''}
      </div>
    </div>
  `;

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);

    const unitBtn = e.target.closest('#se-unit');
    if (unitBtn) {
      const next = unitBtn.textContent.trim() === 'kg' ? 'lbs' : 'kg';
      unitBtn.textContent = next;
      unitBtn.classList.toggle('kg', next === 'kg');
      return;
    }

    const wStep = e.target.closest('[data-se-step]');
    if (wStep) {
      const input = document.getElementById('se-weight');
      let v = parseFloat(input.value || '0');
      if (Number.isNaN(v)) v = 0;
      const unit = document.getElementById('se-unit').textContent.trim();
      const delta = Number(wStep.dataset.seStep) * stepFor(unit);
      let next = v + delta;
      if (next < 0) next = 0;
      input.value = String(+next.toFixed(2));
      haptic(10);
      return;
    }

    const rStep = e.target.closest('[data-se-step-reps]');
    if (rStep) {
      const input = document.getElementById('se-reps');
      let v = parseInt(input.value || '0', 10);
      if (Number.isNaN(v)) v = 0;
      let next = v + Number(rStep.dataset.seStepReps);
      if (next < 0) next = 0;
      input.value = String(next);
      haptic(10);
      return;
    }

    if (e.target.closest('#se-save')) {
      const weight = parseFloat(document.getElementById('se-weight').value || '0');
      const reps = parseInt(document.getElementById('se-reps').value || '0', 10);
      const unit = document.getElementById('se-unit').textContent.trim();
      const notes = document.getElementById('se-notes').value.trim() || null;
      if (!weight || !reps) return toast('Enter weight and reps');

      try {
        if (s.mode === 'edit') {
          await API.updateSet(s.setId, { weight, weight_unit: unit, reps, notes });
        } else {
          await API.logSet({
            workout_id: s.workoutId,
            exercise_id: s.exerciseId,
            set_number: s.setNumber,
            weight,
            weight_unit: unit,
            reps,
            notes
          });
        }
        hideSheet(sheet);
        haptic(20);
        await refreshHistoryCard(s.workoutId);
      } catch (err) {
        toast(err.message);
      }
      return;
    }

    if (e.target.closest('#se-delete')) {
      if (!confirm('Delete this set?')) return;
      try {
        await API.deleteSet(s.setId);
        hideSheet(sheet);
        haptic(20);
        await refreshHistoryCard(s.workoutId);
      } catch (err) {
        toast(err.message);
      }
    }
  };
}

// ---------- Utility ----------
function escapeHtml(s) {
  return String(s ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// ---------- Boot ----------
function boot() {
  // Wire nav
  $$('.nav__btn').forEach((b) => {
    b.onclick = () => {
      haptic(10);
      setTab(b.dataset.tab);
    };
  });

  // Decide initial tab
  const activeId = localStorage.getItem(LS.activeWorkoutId);
  const saved = localStorage.getItem(LS.currentTab);
  const initial = activeId ? 'workout' : saved || 'programs';
  setTab(initial);

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }
}

// PIN gate first
if (localStorage.getItem(LS.pin) && sessionStorage.getItem(LS.pinUnlocked) !== '1') {
  showPinLock();
} else if (!localStorage.getItem(LS.pin)) {
  // First run: force user to set a PIN
  showPinLock();
} else {
  boot();
}
