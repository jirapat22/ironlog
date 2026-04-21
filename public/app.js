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
  history: () => api('/api/workouts/history')
};

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
        ${p.days.map((d) => dayCardHTML(d)).join('')}
      </div>
    </div>
  `;
}

function dayCardHTML(d) {
  const exList = d.exercises
    .map((e) => `${escapeHtml(e.name)} <span style="opacity:.6">${e.target_sets}×${e.target_reps}</span>`)
    .join(' · ');
  return `
    <div class="day-card" data-day-id="${d.id}">
      <div class="day-card__top">
        <div class="day-card__label">${escapeHtml(d.day_label)}</div>
        <div class="day-card__last" data-last="${d.id}">—</div>
      </div>
      <div class="day-card__exercises">${exList}</div>
      <button class="btn btn--primary btn--block btn--sm" data-start-day="${d.id}">Start workout</button>
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

// ---------- WORKOUT tab ----------
let workoutState = null;
let stickyTimerHandle = null;
const restTimers = new Map(); // key: exerciseId-setIdx, value: { el, start, handle }

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
    ${bodyHTML}
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
    const row = e.target.closest('.set-row');

    // Sticky buttons
    if (e.target.closest('[data-finish-workout]')) return finishWorkout();
    if (e.target.closest('[data-cancel-workout]')) return cancelWorkout();

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

function toggleRestTimer(btn, row) {
  const key = `${row.dataset.ex}-${row.dataset.set}`;
  const existing = restTimers.get(key);
  if (existing) {
    clearInterval(existing.handle);
    restTimers.delete(key);
    btn.textContent = 'start rest';
    btn.classList.remove('running');
    return;
  }
  const start = Date.now();
  const handle = setInterval(() => {
    const s = Math.floor((Date.now() - start) / 1000);
    const mm = Math.floor(s / 60);
    const ss = s % 60;
    btn.textContent = `${mm}:${String(ss).padStart(2, '0')}`;
  }, 1000);
  btn.textContent = '0:00';
  btn.classList.add('running');
  restTimers.set(key, { handle });
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

  try {
    const [exercises, weekly, calendarDates] = await Promise.all([
      API.exercises(),
      API.weeklyVolume(),
      API.calendar()
    ]);

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

// ---------- HISTORY tab ----------
async function renderHistory() {
  const root = $('#view-history');
  root.innerHTML = `
    <input class="input" id="history-filter" placeholder="Filter by exercise name…" style="margin-bottom:12px"/>
    <div id="history-list">${skeletonBlocks(4)}</div>
  `;

  try {
    const [history, exercises] = await Promise.all([API.history(), API.exercises()]);
    const exerciseById = new Map(exercises.map((e) => [e.id, e]));

    const list = $('#history-list');
    const all = history;

    function render(filter = '') {
      const lower = filter.trim().toLowerCase();
      const filtered = all; // we filter after expanding below, since set data is lazy
      if (!filtered.length) {
        list.innerHTML = `<div class="empty">No workouts yet</div>`;
        return;
      }
      list.innerHTML = filtered.map((w) => historyCardHTML(w)).join('');
      list.dataset.filter = lower;
    }

    render('');

    $('#history-filter').oninput = (e) => {
      list.dataset.filter = e.target.value.trim().toLowerCase();
      // Re-filter visible cards
      const f = list.dataset.filter;
      [...list.querySelectorAll('.history-card')].forEach((card) => {
        if (!f) {
          card.classList.remove('hidden');
          return;
        }
        // If expanded, we have the set data in DOM; else we check card attr
        const hay = card.dataset.exerciseNames || '';
        card.classList.toggle('hidden', hay && !hay.includes(f));
      });
    };

    list.onclick = async (e) => {
      const head = e.target.closest('.history-card__head');
      if (!head) return;
      const card = head.closest('.history-card');
      card.classList.toggle('expanded');
      if (card.classList.contains('expanded') && !card.dataset.loaded) {
        const id = Number(card.dataset.id);
        const body = card.querySelector('.history-card__body');
        body.innerHTML = `<div class="skeleton" style="height:80px"></div>`;
        try {
          const sets = await API.workoutSets(id);
          const grouped = {};
          for (const s of sets) {
            if (!grouped[s.exercise_id]) {
              grouped[s.exercise_id] = { name: s.exercise_name, muscle: s.muscle_group, sets: [] };
            }
            grouped[s.exercise_id].sets.push(s);
          }
          const html = Object.values(grouped)
            .map(
              (g) => `
              <div class="history-ex">
                <div class="history-ex__name">${escapeHtml(g.name)}</div>
                ${g.sets
                  .map(
                    (s) => `<div class="history-ex__set">Set ${s.set_number}: ${s.weight}${s.weight_unit} × ${s.reps}${s.notes ? ' · ' + escapeHtml(s.notes) : ''}</div>`
                  )
                  .join('')}
              </div>
            `
            )
            .join('');
          body.innerHTML = html || '<div class="empty">No sets logged</div>';
          card.dataset.loaded = '1';
          card.dataset.exerciseNames = Object.values(grouped)
            .map((g) => g.name.toLowerCase())
            .join('|');
          // Re-apply filter if active
          const f = list.dataset.filter;
          if (f && !card.dataset.exerciseNames.includes(f)) card.classList.add('hidden');
        } catch (err) {
          body.innerHTML = `<div class="empty">Couldn't load: ${err.message}</div>`;
        }
      }
    };
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load history: ${err.message}</div>`;
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
