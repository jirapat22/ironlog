// IronLog - Mobile gym tracker SPA
// Single-file SPA that talks to the REST API defined in /routes.

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

// ---------- API ----------
async function api(path, opts = {}) {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
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
  weeklyVolume: (weeks = 8) => api(`/api/volume/weekly${weeks > 0 ? `?weeks=${weeks}` : ''}`),
  calendar: () => api('/api/calendar'),
  prs: () => api('/api/prs'),
  history: () => api('/api/workouts/history'),
  updateWorkout: (id, data) => api(`/api/workouts/${id}`, { method: 'PATCH', body: data }),
  updateFeel: (id, rating) => api(`/api/workouts/${id}`, { method: 'PATCH', body: { feel_rating: rating } }),
  deleteWorkout: (id) => api(`/api/workouts/${id}`, { method: 'DELETE' }),
  bodyweight: () => api('/api/bodyweight'),
  addBodyweight: (data) => api('/api/bodyweight', { method: 'POST', body: data }),
  deleteBodyweight: (id) => api(`/api/bodyweight/${id}`, { method: 'DELETE' }),
  duplicateProgram: (id, data) => api(`/api/programs/${id}/duplicate`, { method: 'POST', body: data }),
  updateProgram: (id, data) => api(`/api/programs/${id}`, { method: 'PATCH', body: data }),
  deleteProgram: (id) => api(`/api/programs/${id}`, { method: 'DELETE' }),
  settings: () => api('/api/settings'),
  updateSettings: (data) => api('/api/settings', { method: 'PUT', body: data })
};

const REST_SECONDS = 180; // 3 minutes

// ---------- Wake lock (keep screen awake during workout) ----------
let wakeLockSentinel = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => {
      wakeLockSentinel = null;
    });
  } catch {
    /* user gesture required or not permitted — fail silently */
  }
}

function releaseWakeLock() {
  if (wakeLockSentinel) {
    wakeLockSentinel.release().catch(() => {});
    wakeLockSentinel = null;
  }
}

async function flushPendingNotes() {
  // Active workout notes
  const workoutNotesEl = document.querySelector('[data-workout-notes]');
  if (workoutNotesEl && workoutState?.workout) {
    const value = workoutNotesEl.value.trim() || null;
    const current = workoutState.workout.notes || null;
    if (value !== current) {
      try {
        await API.updateWorkout(workoutState.workout.id, { notes: value });
        workoutState.workout.notes = value;
      } catch {
        /* ignore — best-effort */
      }
    }
  }
  // History notes (one per expanded card)
  for (const el of document.querySelectorAll('[data-history-notes]')) {
    const card = el.closest('.history-card');
    if (!card) continue;
    const prev = el.dataset.prev || null;
    const value = el.value.trim() || null;
    if (value === prev) continue;
    try {
      await API.updateWorkout(Number(card.dataset.id), { notes: value });
      el.dataset.prev = value ?? '';
    } catch {
      /* ignore */
    }
  }
}

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && localStorage.getItem(LS.activeWorkoutId)) {
    acquireWakeLock();
  }
  if (document.visibilityState === 'hidden') {
    flushPendingNotes();
  }
});

// ---------- Notifications / Web Push / Badge ----------
function notifPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

async function ensureNotifPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    const result = await Notification.requestPermission();
    return result;
  } catch {
    return 'denied';
  }
}

async function showLocalNotification(title, body, opts = {}) {
  if (!('serviceWorker' in navigator)) return;
  if (Notification.permission !== 'granted') return;
  try {
    const reg = await navigator.serviceWorker.ready;
    reg.active?.postMessage({
      type: 'show-notification',
      title,
      body,
      tag: opts.tag || 'ironlog',
      vibrate: opts.vibrate,
      requireInteraction: opts.requireInteraction ?? false
    });
  } catch {
    /* ignore */
  }
}

function urlBase64ToUint8Array(base64String) {
  const padding = '='.repeat((4 - (base64String.length % 4)) % 4);
  const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
  const rawData = atob(base64);
  const output = new Uint8Array(rawData.length);
  for (let i = 0; i < rawData.length; i++) output[i] = rawData.charCodeAt(i);
  return output;
}

async function subscribeWebPush() {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) return null;
  try {
    const reg = await navigator.serviceWorker.ready;
    let sub = await reg.pushManager.getSubscription();
    if (!sub) {
      const { publicKey } = await api('/api/push/public-key');
      sub = await reg.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: urlBase64ToUint8Array(publicKey)
      });
    }
    const json = sub.toJSON();
    await api('/api/push/subscribe', { method: 'POST', body: json });
    return sub;
  } catch (err) {
    console.warn('Web Push subscribe failed', err);
    return null;
  }
}

async function unsubscribeWebPush() {
  if (!('serviceWorker' in navigator)) return;
  try {
    const reg = await navigator.serviceWorker.ready;
    const sub = await reg.pushManager.getSubscription();
    if (!sub) return;
    await api('/api/push/unsubscribe', { method: 'POST', body: { endpoint: sub.endpoint } });
    await sub.unsubscribe();
  } catch {
    /* ignore */
  }
}

async function scheduleRestPushBackup(seconds) {
  try {
    await api('/api/push/rest-timer', { method: 'POST', body: { seconds } });
  } catch {
    /* optional — main-thread local notification is primary */
  }
}

async function cancelRestPushBackup() {
  try {
    await api('/api/push/rest-timer/cancel', { method: 'POST', body: {} });
  } catch {
    /* ignore — server may not have pending timer */
  }
}

async function setAppBadge(n) {
  if ('setAppBadge' in navigator) {
    try {
      if (!n) await navigator.clearAppBadge();
      else await navigator.setAppBadge(n);
    } catch {
      /* not supported or blocked */
    }
  }
}

async function refreshBadgeFromCalendar() {
  try {
    const dates = await API.calendar();
    const now = new Date();
    const day = now.getDay(); // 0=Sun
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - day); // Sunday
    let count = 0;
    for (const d of dates) {
      const when = new Date(d + 'T00:00:00');
      if (when >= start) count++;
    }
    setAppBadge(count);
  } catch {
    /* ignore */
  }
}

// ---------- iOS install hint ----------
function isIOS() {
  return /iPad|iPhone|iPod/.test(navigator.userAgent) && !window.MSStream;
}

function isStandalone() {
  return (
    window.matchMedia('(display-mode: standalone)').matches ||
    window.navigator.standalone === true
  );
}

function showInstallHintIfNeeded() {
  if (!isIOS() || isStandalone()) return;
  if (localStorage.getItem(LS.installHintDismissed) === '1') return;

  const banner = document.createElement('div');
  banner.id = 'install-hint';
  banner.className = 'install-hint';
  banner.innerHTML = `
    <div class="install-hint__text">
      <strong>Install IronLog</strong>
      <div>Tap <span class="install-hint__share">&#x2B06;</span> <em>Share</em>, then <em>Add to Home Screen</em> for a full-app experience.</div>
    </div>
    <button class="install-hint__close" aria-label="Dismiss">&times;</button>
  `;
  document.body.appendChild(banner);
  banner.querySelector('.install-hint__close').onclick = () => {
    localStorage.setItem(LS.installHintDismissed, '1');
    banner.remove();
  };
}

// ---------- e1RM (Epley) ----------
function e1RM(weight, reps) {
  if (!weight || !reps) return 0;
  if (reps === 1) return weight;
  return weight * (1 + reps / 30);
}

function toKg(weight, unit) {
  return unit === 'lbs' ? weight * 0.45359237 : weight;
}

// Human-readable weight for a set. BW exercises at 0 show "BW",
// at non-zero show "+X unit" (dip belt etc.).
function fmtSetWeight(weight, unit, isBw) {
  if (isBw) {
    if (!weight || weight === 0) return 'BW';
    return `BW+${weight}${unit}`;
  }
  return `${weight}${unit}`;
}

// Cached latest body weight (kg). Set from renderBodyweightSection + syncBw().
let userBwKg = 0;

async function syncUserBodyweight() {
  try {
    const rows = await API.bodyweight();
    if (rows.length) userBwKg = toKg(rows[0].weight, rows[0].weight_unit);
  } catch {
    /* ignore */
  }
}

// Total load lifted for a set (kg), accounting for bodyweight-driven movements
// where the logged "weight" is external load added to body weight.
function loadKg(set, exercise) {
  const base = toKg(set.weight, set.weight_unit);
  if (exercise?.is_bodyweight && userBwKg) return base + userBwKg;
  return base;
}

function e1RMForSet(set, exercise) {
  return e1RM(loadKg(set, exercise), set.reps);
}

// Used by every exercise picker so the order is consistent. `arms` is
// kept for any custom user exercises still on the legacy group.
const PICKER_GROUP_ORDER = [
  'chest', 'back', 'shoulders', 'biceps', 'triceps', 'arms', 'legs', 'core'
];

// ---------- Global rest countdown ----------
let restState = null; // { endAt, handle, doneTimeout }

function startRestCountdown(secs = REST_SECONDS) {
  cancelRestCountdown();
  const endAt = Date.now() + secs * 1000;
  restState = { endAt, handle: null, doneTimeout: null, notified: false };

  // Ask server to push as a backup in case the tab gets suspended / OS throttles
  if (localStorage.getItem(LS.notifEnabled) === '1') {
    scheduleRestPushBackup(secs);
  }

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
      playBeep();
      if (restState && !restState.notified) {
        restState.notified = true;
        showLocalNotification('Rest done', 'Time for your next set', {
          tag: 'ironlog-rest',
          vibrate: [250, 120, 250, 120, 400],
          requireInteraction: false
        });
      }
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
  const hadActiveTimer = !!restState?.handle;
  if (restState?.handle) clearInterval(restState.handle);
  if (restState?.doneTimeout) clearTimeout(restState.doneTimeout);
  restState = null;
  const el = $('#rest-sticky');
  if (el) {
    el.classList.add('hidden');
    el.classList.remove('done');
    el.innerHTML = '';
  }
  // Tell the server to drop its pending backup push so it doesn't fire
  // after the user has already moved on.
  if (hadActiveTimer && localStorage.getItem(LS.notifEnabled) === '1') {
    cancelRestPushBackup();
  }
}

// ---------- Helpers ----------
function haptic(ms = 30) {
  if (navigator.vibrate) navigator.vibrate(ms);
}

// Shared AudioContext — created lazily, kept alive so audio policy doesn't
// block playback when the beep fires from a setInterval (no recent user
// gesture). primeAudio() is called on user interactions to ensure the
// context is in 'running' state before the beep needs to play.
let audioCtx = null;
function primeAudio() {
  try {
    if (!audioCtx) {
      audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
  } catch {
    /* not supported */
  }
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
  } catch {
    /* fail silently */
  }
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
      const dupBtn = e.target.closest('[data-dup-program]');
      if (dupBtn) {
        e.stopPropagation();
        const id = Number(dupBtn.dataset.dupProgram);
        const src = full.find((p) => p.id === id);
        const suggested = `My ${src?.name || 'Program'}`;
        const name = prompt('Name for the new program?', suggested);
        if (!name || !name.trim()) return;
        try {
          await API.duplicateProgram(id, { name: name.trim() });
          haptic(20);
          toast('Program duplicated');
          renderPrograms();
        } catch (err) {
          toast(err.message);
        }
        return;
      }

      const renameBtn = e.target.closest('[data-rename-program]');
      if (renameBtn) {
        e.stopPropagation();
        const id = Number(renameBtn.dataset.renameProgram);
        const src = full.find((p) => p.id === id);
        const name = prompt('Rename program to?', src?.name || '');
        if (!name || !name.trim() || name.trim() === src?.name) return;
        try {
          await API.updateProgram(id, { name: name.trim() });
          haptic(20);
          renderPrograms();
        } catch (err) {
          toast(err.message);
        }
        return;
      }

      const delBtn = e.target.closest('[data-delete-program]');
      if (delBtn) {
        e.stopPropagation();
        const id = Number(delBtn.dataset.deleteProgram);
        const src = full.find((p) => p.id === id);
        if (!confirm(`Delete "${src?.name}" and all its days? This cannot be undone.`)) return;
        try {
          await API.deleteProgram(id);
          haptic(20);
          renderPrograms();
        } catch (err) {
          toast(err.message);
        }
        return;
      }

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
        <div class="program-card__actions">
          <button class="btn btn--ghost btn--sm" data-dup-program="${p.id}">&#x29C9; Duplicate</button>
          <button class="btn btn--ghost btn--sm" data-rename-program="${p.id}">&#x270E; Rename</button>
          <button class="btn btn--ghost btn--sm" data-delete-program="${p.id}" style="color:var(--danger)">&times; Delete</button>
        </div>
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
          <button class="edit-row__drag" data-drag-handle aria-label="Drag to reorder">&#x2630;</button>
          <div class="edit-row__head-text">
            <div class="edit-row__name">${escapeHtml(e.name)}</div>
            <div class="edit-row__muscle">${escapeHtml(e.muscle_group)}</div>
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
        <div class="edit-rows" id="edit-rows-container">${rows}</div>
        ${day.exercises.length ? '' : '<div class="empty" style="padding:20px 0">No exercises yet. Add one below.</div>'}
        <button class="btn btn--primary btn--block" data-open-picker style="margin-top:16px">+ Add exercise</button>
      </div>
    </div>
  `;

  const rowsContainer = sheet.querySelector('#edit-rows-container');
  if (rowsContainer) enableDragReorder(rowsContainer, persistEditRowOrder);

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

async function persistEditRowOrder() {
  const container = document.getElementById('edit-rows-container');
  if (!container) return;
  const order = [...container.children].map((r) => Number(r.dataset.pde));
  // Sort state array to match DOM
  editDayState.day.exercises.sort(
    (a, b) => order.indexOf(a.id) - order.indexOf(b.id)
  );
  // Persist any order_index changes
  const updates = [];
  for (let i = 0; i < editDayState.day.exercises.length; i++) {
    const ex = editDayState.day.exercises[i];
    if (ex.order_index !== i) {
      updates.push(
        API.updateDayExercise(editDayState.programId, editDayState.dayId, ex.id, {
          order_index: i
        }).then(() => {
          ex.order_index = i;
        })
      );
    }
  }
  try {
    await Promise.all(updates);
    haptic(15);
  } catch (err) {
    toast(err.message);
  }
}

function enableDragReorder(container, onDrop) {
  let drag = null;

  const onDown = (e) => {
    const handle = e.target.closest('[data-drag-handle]');
    if (!handle) return;
    const row = handle.closest('.edit-row');
    if (!row || !container.contains(row)) return;
    e.preventDefault();
    drag = {
      row,
      pointerId: e.pointerId,
      startY: e.clientY,
      origOrder: [...container.children].map((r) => r.dataset.pde)
    };
    row.classList.add('edit-row--dragging');
    try {
      row.setPointerCapture(e.pointerId);
    } catch {}
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
      const rowAfterSib =
        drag.row.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_PRECEDING;
      const rowBeforeSib =
        drag.row.compareDocumentPosition(sib) & Node.DOCUMENT_POSITION_FOLLOWING;
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
    row.classList.remove('edit-row--dragging');
    row.style.transform = '';
    row.style.zIndex = '';
    const newOrder = [...container.children].map((r) => r.dataset.pde);
    const moved = newOrder.some((id, i) => id !== drag.origOrder[i]);
    drag = null;
    if (moved) await onDrop();
  };

  container.addEventListener('pointerdown', onDown);
  container.addEventListener('pointermove', onMove);
  container.addEventListener('pointerup', onUp);
  container.addEventListener('pointercancel', onUp);
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

  const keys = [...new Set([...PICKER_GROUP_ORDER, ...Object.keys(groups)])].filter((k) => groups[k]);

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
          <option value="biceps">biceps</option>
          <option value="triceps">triceps</option>
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

// ---------- Set-count overrides + draft persistence ----------
function draftKey(workoutId) {
  return `ironlog.draft.${workoutId}`;
}

function loadDraft(workoutId) {
  try {
    const raw = localStorage.getItem(draftKey(workoutId));
    if (!raw) return { setCounts: {}, inputs: {} };
    const parsed = JSON.parse(raw);
    return {
      setCounts: parsed.setCounts || {},
      inputs: parsed.inputs || {}
    };
  } catch {
    return { setCounts: {}, inputs: {} };
  }
}

function saveDraft(workoutId, draft) {
  try {
    localStorage.setItem(draftKey(workoutId), JSON.stringify(draft));
  } catch {
    /* quota exceeded — best-effort only */
  }
}

function clearDraft(workoutId) {
  try { localStorage.removeItem(draftKey(workoutId)); } catch { /* ignore */ }
}

function clearDraftInput(workoutId, exId, setNum) {
  if (!workoutState) return;
  const key = `${exId}-${setNum}`;
  if (workoutState.draft.inputs[key]) {
    delete workoutState.draft.inputs[key];
    saveDraft(workoutId, workoutState.draft);
  }
}

function getSetCount(ex) {
  const override = workoutState?.draft?.setCounts?.[ex.exercise_id];
  const loggedMax = Math.max(
    0,
    ...workoutState.loggedSets
      .filter((s) => s.exercise_id === ex.exercise_id)
      .map((s) => s.set_number)
  );
  const target = override ?? ex.target_sets;
  // Never render fewer rows than the user has already logged
  return Math.max(target, loggedMax);
}

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

    // Get program + day details (and latest bodyweight for BW-relative e1RM)
    const [days, last] = await Promise.all([
      fetchDayDetails(programDayId),
      API.lastWorkout(programDayId).catch(() => null)
    ]);
    await syncUserBodyweight();

    workoutState = {
      workout,
      programDay: days,
      last,
      startedAt: workout.started_at,
      loggedSets: [...(workout.sets || [])],
      openExtras: new Set(),
      draft: loadDraft(workout.id)
    };

    localStorage.setItem(LS.activeWorkoutStart, workout.started_at);

    renderWorkoutView();
    startStickyTimer();
    acquireWakeLock();
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
    <button class="btn btn--ghost btn--block" data-add-workout-ex style="margin-top:12px">+ Add exercise to this workout</button>
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
  const target = getSetCount(ex);
  const prevReference = lastSets[0];
  const prefillWeight = prevReference?.weight ?? '';
  const prefillUnit = prevReference?.weight_unit || 'kg';
  const prefillReps = prevReference?.reps ?? ex.target_reps;

  const rec = recommendForNext(ex, lastSets);
  const drafts = workoutState?.draft?.inputs || {};

  const rows = [];
  let firstUnloggedSet = null;
  for (let i = 1; i <= target; i++) {
    const key = `${ex.exercise_id}-${i}`;
    const logged = loggedBySet[key];
    const prevSet = lastSets.find((s) => s.set_number === i) || prevReference;
    const draft = drafts[key];

    // Priority: logged > draft (unconfirmed input from previous session) > recommendation > last-session > defaults
    const w = logged?.weight
      ?? draft?.w
      ?? rec?.recWeight
      ?? prevSet?.weight
      ?? prefillWeight;
    const u = logged?.weight_unit
      ?? draft?.u
      ?? rec?.recUnit
      ?? prevSet?.weight_unit
      ?? prefillUnit;
    const r = logged?.reps ?? draft?.r ?? prevSet?.reps ?? prefillReps;

    if (!logged && firstUnloggedSet === null) firstUnloggedSet = i;
    rows.push(setRowHTML(ex, i, { w, u, r, logged, isNext: !logged && firstUnloggedSet === i }));
  }

  const hint = rec ? buildProgressionHint(rec) : '';

  return `
    <div class="exercise-card" data-ex="${ex.exercise_id}">
      <div class="exercise-card__head">
        <div>
          <div class="exercise-card__name">${escapeHtml(ex.name)}${ex.is_bodyweight ? ' <span class="badge badge--bw">BW</span>' : ''}</div>
          <div class="card__subtitle">${target} × ${ex.target_reps}${ex.is_bodyweight ? ' · enter added weight (0 if none)' : ''}</div>
        </div>
        <div class="exercise-card__head-actions">
          <button class="btn--icon-text" data-swap-ex="${ex.exercise_id}" title="Swap exercise">&#x21C4; Swap</button>
          <span class="badge badge--muscle">${escapeHtml(ex.muscle_group)}</span>
        </div>
      </div>
      ${hint}
      <div class="set-rows">
        ${rows.join('')}
      </div>
      <div class="set-count-controls">
        <button class="set-count-btn" data-remove-set-row="${ex.exercise_id}" aria-label="Remove a set">−</button>
        <span class="set-count-controls__label">${target} ${target === 1 ? 'set' : 'sets'}</span>
        <button class="set-count-btn" data-add-set-row="${ex.exercise_id}" aria-label="Add a set">+</button>
      </div>
      <button class="exercise-card__skip" data-skip-ex="${ex.exercise_id}">Done with this exercise</button>
    </div>
  `;
}

function buildProgressionHint(rec) {
  if (rec.isProgression) {
    return `
      <div class="prog-hint prog-hint--up">
        <div class="prog-hint__main">&#x2B06; Try <strong>${rec.recDisplay} &times; ${rec.recReps}</strong> today</div>
        <div class="prog-hint__sub">Last session: ${rec.lastWeight} &times; ${rec.repsList} &mdash; all sets hit ${rec.recReps}+ reps &#x2713;</div>
      </div>`;
  } else {
    const gap = rec.recReps - rec.minReps;
    const gapStr = gap > 0 ? ` (${gap} rep${gap > 1 ? 's' : ''} short)` : '';
    return `
      <div class="prog-hint prog-hint--same">
        <div class="prog-hint__main">&#x1F3AF; Keep <strong>${rec.recDisplay}</strong> &mdash; aim for <strong>${rec.recReps} reps</strong> every set</div>
        <div class="prog-hint__sub">Last: ${rec.lastWeight} &times; ${rec.repsList}${gapStr} &mdash; hit ${rec.recReps} on all sets to add weight</div>
      </div>`;
  }
}

function recommendForNext(ex, lastSets) {
  if (!lastSets.length) return null;
  const targetReps = ex.target_reps;

  // Find the top working weight (kg-normalised for comparison, original unit for display)
  let bestKg = 0;
  let bestSet = null;
  for (const s of lastSets) {
    const kg = loadKg(s, ex);
    if (kg > bestKg) { bestKg = kg; bestSet = s; }
  }
  if (!bestSet) return null;

  // Only look at sets done at that top weight — ignores warmups at lighter loads
  const workingSets = lastSets.filter(
    (s) => s.weight === bestSet.weight && s.weight_unit === bestSet.weight_unit
  );

  // All working sets reached target reps → ready to add weight
  const allHit = workingSets.every((s) => s.reps >= targetReps);

  const unit = bestSet.weight_unit;
  const step = stepFor(unit);
  const isBw = !!ex.is_bodyweight;

  let recWeight, isProgression;
  if (allHit) {
    recWeight = +(bestSet.weight + step).toFixed(2);
    isProgression = true;
  } else {
    recWeight = bestSet.weight;
    isProgression = false;
  }

  // Human-readable last-session summary
  const repsList = workingSets.map((s) => s.reps).join(', ');
  const setsLabel = workingSets.length === 1 ? '1 set' : `${workingSets.length} sets`;
  const minReps = Math.min(...workingSets.map((s) => s.reps));

  return {
    recWeight,
    recUnit: unit,
    recReps: targetReps,
    isProgression,
    isBodyweight: isBw,
    lastWeight: fmtSetWeight(bestSet.weight, unit, isBw),
    recDisplay: isBw
      ? (recWeight === 0 ? 'BW' : `BW+${recWeight}${unit}`)
      : `${recWeight}${unit}`,
    setsLabel,
    repsList,
    minReps
  };
}

function setRowHTML(ex, setNumber, { w, u, r, logged, isNext }) {
  const isBw = !!ex.is_bodyweight;
  // For BW exercises with no added weight yet, show empty input + "BW" placeholder.
  // Otherwise show the numeric value.
  const showAsEmpty = isBw && (w === 0 || w === '' || w == null);
  const wStr = showAsEmpty ? '' : (w === '' ? '' : Number(w));
  const wPlaceholder = isBw ? 'BW' : '0';
  const rpe = logged?.rpe ?? '';
  const note = logged?.notes ?? '';
  const rpeButtons = [6, 7, 8, 9, 10]
    .map(
      (n) => `<button class="rpe-btn ${Number(rpe) === n ? 'rpe-btn--active' : ''}" data-rpe="${n}">${n}</button>`
    )
    .join('');
  const rpeBadge = rpe !== '' && rpe != null ? `<span class="set-row__rpe-badge" data-rpe-badge>RPE ${rpe}</span>` : '';

  return `
    <div class="set-row ${logged ? 'done' : ''} ${isNext ? 'set-row--next' : ''}" data-ex="${ex.exercise_id}" data-set="${setNumber}" data-rpe="${rpe}" data-pristine="1" ${logged ? `data-set-id="${logged.id}"` : ''}>
      <div class="set-row__num">${setNumber}</div>
      <div class="num-input" data-field="weight">
        <button class="num-input__btn" data-step="-1">−</button>
        <input class="num-input__field" type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" value="${wStr}" placeholder="${wPlaceholder}" aria-label="weight"/>
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
          <div class="rpe-group" data-rpe-group>
            <span class="rpe-group__label">RPE</span>
            ${rpeButtons}
            ${rpe !== '' && rpe != null ? '<button class="rpe-btn rpe-btn--clear" data-rpe-clear>×</button>' : ''}
          </div>
        </div>
        <input class="set-row__note" data-note placeholder="Form cue, tempo, etc." value="${escapeHtml(note)}"/>
      </div>
      ${rpeBadge}
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
      fireStep(stepBtn, row);
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

    const rpeBtn = e.target.closest('[data-rpe]');
    if (rpeBtn) {
      const val = Number(rpeBtn.dataset.rpe);
      row.dataset.rpe = String(val);
      row.querySelectorAll('.rpe-btn').forEach((b) =>
        b.classList.toggle('rpe-btn--active', Number(b.dataset.rpe) === val)
      );
      haptic(10);
      // If this set is already logged, persist immediately
      if (row.dataset.setId) persistRpeChange(row);
      updateRpeBadge(row);
      return;
    }

    if (e.target.closest('[data-rpe-clear]')) {
      row.dataset.rpe = '';
      row.querySelectorAll('.rpe-btn').forEach((b) => b.classList.remove('rpe-btn--active'));
      if (row.dataset.setId) persistRpeChange(row);
      updateRpeBadge(row);
      return;
    }

    const restBtn = e.target.closest('[data-rest]');
    if (restBtn) return toggleRestTimer(restBtn, row);

    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) return deleteLoggedSet(row);
  };

  // Swap / skip / add-exercise / set-count handlers (outside row scope)
  root.addEventListener('click', async (e) => {
    const swapBtn = e.target.closest('[data-swap-ex]');
    if (swapBtn) {
      e.stopPropagation();
      haptic(15);
      openSwapPicker(Number(swapBtn.dataset.swapEx));
      return;
    }
    const skipBtn = e.target.closest('[data-skip-ex]');
    if (skipBtn) {
      e.stopPropagation();
      haptic(15);
      skipRemainingForExercise(Number(skipBtn.dataset.skipEx));
      return;
    }
    if (e.target.closest('[data-add-workout-ex]')) {
      haptic(15);
      openWorkoutAddExercisePicker();
      return;
    }

    const addRow = e.target.closest('[data-add-set-row]');
    if (addRow) {
      e.stopPropagation();
      haptic(10);
      const exId = Number(addRow.dataset.addSetRow);
      const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exId);
      if (!ex) return;
      const current = getSetCount(ex);
      workoutState.draft.setCounts[exId] = current + 1;
      saveDraft(workoutState.workout.id, workoutState.draft);
      renderWorkoutView();
      return;
    }
    const removeRow = e.target.closest('[data-remove-set-row]');
    if (removeRow) {
      e.stopPropagation();
      const exId = Number(removeRow.dataset.removeSetRow);
      const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exId);
      if (!ex) return;
      const current = getSetCount(ex);
      const loggedMax = Math.max(
        0,
        ...workoutState.loggedSets.filter((s) => s.exercise_id === exId).map((s) => s.set_number)
      );
      // Can't remove a row that's already logged (use swipe-to-delete for that)
      if (current <= loggedMax) {
        toast('Delete a logged set first');
        return;
      }
      if (current <= 1) return;
      haptic(10);
      workoutState.draft.setCounts[exId] = current - 1;
      // Drop any draft input for the removed row
      const removedKey = `${exId}-${current}`;
      delete workoutState.draft.inputs[removedKey];
      saveDraft(workoutState.workout.id, workoutState.draft);
      renderWorkoutView();
    }
  });

  // Save unconfirmed input as drafts so accidental reloads don't lose work
  root.addEventListener('input', (e) => {
    const input = e.target.closest('.num-input__field');
    if (!input) return;
    const row = input.closest('.set-row');
    if (!row || row.dataset.setId) return; // ignore logged rows
    row.removeAttribute('data-pristine');
    const exId = Number(row.dataset.ex);
    const setNum = Number(row.dataset.set);
    const w = row.querySelector('[data-field="weight"] .num-input__field').value;
    const r = row.querySelector('[data-field="reps"] .num-input__field').value;
    const u = row.querySelector('[data-unit]').textContent.trim();
    const key = `${exId}-${setNum}`;
    workoutState.draft.inputs[key] = { w, u, r };
    saveDraft(workoutState.workout.id, workoutState.draft);
  });

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

  // Hold-to-repeat on +/− buttons: fires faster the longer you hold
  attachHoldRepeat(root);
}

// Shared step handler — used by both click and hold-repeat
function fireStep(btn, rowCtx) {
  const wrap = btn.closest('.num-input');
  if (!wrap) return;
  const input = wrap.querySelector('.num-input__field');
  const field = wrap.dataset.field;
  let v = parseFloat(input.value || '0');
  if (Number.isNaN(v)) v = 0;
  const row = rowCtx || btn.closest('.set-row');
  const unit = row?.querySelector('[data-unit]')?.textContent?.trim() || 'kg';
  const step = Number(btn.dataset.step) * (field === 'weight' ? stepFor(unit) : 1);
  let next = v + step;
  if (next < 0) next = 0;
  input.value = field === 'weight' ? String(+next.toFixed(2)) : String(Math.floor(next));
  haptic(8);
}

function attachHoldRepeat(container) {
  let holdTimer = null;
  let holdInterval = null;
  let activeBtn = null;

  const stop = () => {
    clearTimeout(holdTimer);
    clearInterval(holdInterval);
    holdTimer = null;
    holdInterval = null;
    activeBtn = null;
  };

  container.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.num-input__btn');
    if (!btn) return;
    activeBtn = btn;
    // Wait 400ms then start repeating
    holdTimer = setTimeout(() => {
      let delay = 120;
      holdInterval = setInterval(() => {
        if (!activeBtn) return stop();
        fireStep(activeBtn, activeBtn.closest('.set-row'));
        // Accelerate: every 5 ticks halve the delay (floor 40ms)
        delay = Math.max(40, delay - 10);
      }, delay);
    }, 400);
  });

  container.addEventListener('pointerup', stop);
  container.addEventListener('pointercancel', stop);
  // Finger dragged away from button
  container.addEventListener('pointermove', (e) => {
    if (!activeBtn) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (!over || !activeBtn.contains(over) && over !== activeBtn) stop();
  });
}

async function confirmSet(row) {
  const checkBtn = row.querySelector('[data-confirm]');
  if (checkBtn?.disabled) return;
  // Prime AudioContext while we still have a fresh user gesture, so the
  // rest-done beep can fire from setInterval 3 minutes later.
  primeAudio();

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
  const rpeRaw = row.dataset.rpe;
  const rpe = rpeRaw === '' || rpeRaw == null ? null : Number(rpeRaw);

  // BW exercises can legitimately have 0 added weight — only reject negative/NaN
  const exIsBw = workoutState?.programDay?.exercises
    ?.find((e) => e.exercise_id === exId)?.is_bodyweight;
  if ((weight < 0 || (weight === 0 && !exIsBw) || Number.isNaN(weight)) || !reps) {
    toast(exIsBw ? 'Enter reps (weight can be 0 for bodyweight)' : 'Enter weight and reps first');
    return;
  }

  if (checkBtn) checkBtn.disabled = true;
  try {
    if (row.dataset.setId) {
      await API.updateSet(Number(row.dataset.setId), {
        weight,
        weight_unit: unit,
        reps,
        rpe,
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
        rpe,
        notes: note
      });
      row.dataset.setId = res.id;
      row.classList.add('done');
      row.classList.remove('set-row--next');
      workoutState.loggedSets.push(res);
      clearDraftInput(workoutState.workout.id, exId, setNumber);
      cascadePrefillSiblings(row, weight, unit, reps);
      moveNextHighlight(exId);
      haptic(30);
      if (res.is_new_pr) showPRFlash();
      startRestCountdown();
    }
    updateRpeBadge(row);
  } catch (err) {
    toast(err.message);
  } finally {
    if (checkBtn) checkBtn.disabled = false;
  }
}

// After a set is confirmed, push its values to any unlogged sibling rows
// for the same exercise that haven't been touched (still pristine).
function cascadePrefillSiblings(confirmedRow, weight, unit, reps) {
  const exId = confirmedRow.dataset.ex;
  const card = confirmedRow.closest('.exercise-card');
  if (!card) return;
  const siblings = card.querySelectorAll(`.set-row[data-ex="${exId}"]`);
  for (const sib of siblings) {
    if (sib === confirmedRow) continue;
    if (sib.dataset.setId) continue; // already logged
    if (sib.dataset.pristine !== '1') continue; // user has touched it
    const wIn = sib.querySelector('[data-field="weight"] .num-input__field');
    const rIn = sib.querySelector('[data-field="reps"] .num-input__field');
    const uBtn = sib.querySelector('[data-unit]');
    if (wIn) wIn.value = String(weight);
    if (rIn) rIn.value = String(reps);
    if (uBtn) {
      uBtn.textContent = unit;
      uBtn.classList.toggle('kg', unit === 'kg');
    }
  }
}

// Move the "next" highlight to the lowest unlogged set for this exercise
function moveNextHighlight(exId) {
  const card = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  if (!card) return;
  card.querySelectorAll('.set-row--next').forEach((r) => r.classList.remove('set-row--next'));
  const next = [...card.querySelectorAll('.set-row')].find(
    (r) => !r.dataset.setId
  );
  if (next) next.classList.add('set-row--next');
}

async function persistRpeChange(row) {
  const setId = Number(row.dataset.setId);
  if (!setId) return;
  const raw = row.dataset.rpe;
  const rpe = raw === '' || raw == null ? null : Number(raw);
  try {
    await API.updateSet(setId, { rpe });
  } catch (err) {
    toast(err.message);
  }
}

function updateRpeBadge(row) {
  const existing = row.querySelector('[data-rpe-badge]');
  const raw = row.dataset.rpe;
  if (raw === '' || raw == null) {
    existing?.remove();
    return;
  }
  if (existing) {
    existing.textContent = `RPE ${raw}`;
  } else {
    const badge = document.createElement('span');
    badge.className = 'set-row__rpe-badge';
    badge.dataset.rpeBadge = '';
    badge.textContent = `RPE ${raw}`;
    row.appendChild(badge);
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

function skipRemainingForExercise(exerciseId) {
  const card = document.querySelector(`.exercise-card[data-ex="${exerciseId}"]`);
  if (!card) return;
  const rows = [...card.querySelectorAll('.set-row')];
  const unlogged = rows.filter((r) => !r.dataset.setId);
  if (!unlogged.length) {
    toast('All sets already logged');
    return;
  }
  unlogged.forEach((r) => r.classList.add('hidden'));
  card.classList.add('exercise-card--skipped');
  const skipBtn = card.querySelector('[data-skip-ex]');
  if (skipBtn) skipBtn.textContent = 'Skipped — tap to undo';
  skipBtn?.addEventListener(
    'click',
    (e) => {
      if (!card.classList.contains('exercise-card--skipped')) return;
      e.stopPropagation();
      card.classList.remove('exercise-card--skipped');
      unlogged.forEach((r) => r.classList.remove('hidden'));
      skipBtn.textContent = 'Done with this exercise';
    },
    { once: true }
  );
  toast(`Skipped ${unlogged.length} remaining set${unlogged.length > 1 ? 's' : ''}`);
}

async function openSwapPicker(currentExerciseId) {
  const picker = ensureSwapPicker();
  picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(picker);

  let exercises;
  try {
    exercises = await API.exercises();
  } catch (err) {
    picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    return;
  }

  const currentIdx = workoutState.programDay.exercises.findIndex(
    (e) => e.exercise_id === currentExerciseId
  );
  const currentEx = workoutState.programDay.exercises[currentIdx];

  const groups = {};
  for (const ex of exercises) {
    if (!groups[ex.muscle_group]) groups[ex.muscle_group] = [];
    groups[ex.muscle_group].push(ex);
  }
  const keys = [...new Set([...PICKER_GROUP_ORDER, ...Object.keys(groups)])].filter((k) => groups[k]);

  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Swap ${escapeHtml(currentEx?.name || 'exercise')}</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:10px">Pick a replacement. This only affects today's workout.</div>
        <input class="input" id="swap-search" placeholder="Search exercises…" style="margin-bottom:12px"/>
        ${keys
          .map(
            (g) => `
          <div class="picker-group" data-group="${g}">
            <div class="picker-group__title">${escapeHtml(g)}</div>
            ${groups[g]
              .map(
                (ex) => `
                <button class="picker-row ${ex.id === currentExerciseId ? 'picker-row--added' : ''}" data-swap-pick="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}">
                  <span>${escapeHtml(ex.name)}</span>
                  <span class="picker-row__state">${ex.id === currentExerciseId ? 'current' : 'pick'}</span>
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

  const search = document.getElementById('swap-search');
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
    if (e.target.closest('[data-close-sheet]')) return hideSheet(picker);
    const pickBtn = e.target.closest('[data-swap-pick]');
    if (!pickBtn) return;
    const newExId = Number(pickBtn.dataset.swapPick);
    if (newExId === currentExerciseId) {
      toast('Same exercise — nothing to swap');
      return;
    }
    const newEx = exercises.find((x) => x.id === newExId);
    if (!newEx) return;

    // Any sets logged against this exercise in the current workout?
    const logged = workoutState.loggedSets.filter((s) => s.exercise_id === currentExerciseId);
    if (logged.length) {
      const msg = `Delete ${logged.length} logged set${logged.length > 1 ? 's' : ''} for ${currentEx.name} and swap?`;
      if (!confirm(msg)) return;
      try {
        await Promise.all(logged.map((s) => API.deleteSet(s.id)));
        workoutState.loggedSets = workoutState.loggedSets.filter(
          (s) => s.exercise_id !== currentExerciseId
        );
      } catch (err) {
        toast(err.message);
        return;
      }
    }

    // Swap in workoutState (local only — doesn't modify the program).
    // `workoutState.last` is keyed by programDay, not exercise, so it doesn't
    // need to be refetched — the old exercise's "last session" data just won't
    // match anything in the new card, which is the correct behavior.
    workoutState.programDay.exercises[currentIdx] = {
      ...currentEx,
      exercise_id: newExId,
      name: newEx.name,
      muscle_group: newEx.muscle_group
    };

    hideSheet(picker);
    haptic(20);
    toast(`Swapped to ${newEx.name}`);
    renderWorkoutView();
  };
}

function ensureSwapPicker() {
  let picker = document.getElementById('swap-picker-sheet');
  if (!picker) {
    picker = document.createElement('div');
    picker.id = 'swap-picker-sheet';
    picker.className = 'sheet hidden';
    document.body.appendChild(picker);
  }
  return picker;
}

async function openHistoryAddExercisePicker(workoutId) {
  const picker = ensureSwapPicker();
  picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(picker);

  let exercises;
  try {
    exercises = await API.exercises();
  } catch (err) {
    picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    return;
  }

  const groups = {};
  for (const ex of exercises) (groups[ex.muscle_group] ||= []).push(ex);
  const keys = [...new Set([...PICKER_GROUP_ORDER, ...Object.keys(groups)])].filter((k) => groups[k]);

  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Add exercise to this workout</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <input class="input" id="histadd-search" placeholder="Search…" style="margin-bottom:12px"/>
        ${keys
          .map(
            (g) => `
          <div class="picker-group" data-group="${g}">
            <div class="picker-group__title">${escapeHtml(g)}</div>
            ${groups[g]
              .map(
                (ex) => `
                <button class="picker-row" data-histadd="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}" data-ex-name="${escapeHtml(ex.name)}">
                  <span>${escapeHtml(ex.name)}</span>
                  <span class="picker-row__state">+</span>
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

  const search = document.getElementById('histadd-search');
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

  picker.onclick = (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(picker);
    const pickBtn = e.target.closest('[data-histadd]');
    if (!pickBtn) return;
    const exId = Number(pickBtn.dataset.histadd);
    const exName = pickBtn.dataset.exName;
    hideSheet(picker);
    // Open the add-set sheet for the new exercise; refreshHistoryCard will
    // make the new exercise group appear after save.
    openAddSetSheet(exId, workoutId, 1, exName);
  };
}

async function openWorkoutAddExercisePicker() {
  const picker = ensureSwapPicker();
  picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(picker);

  let exercises;
  try {
    exercises = await API.exercises();
  } catch (err) {
    picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    return;
  }

  const inWorkout = new Set(workoutState.programDay.exercises.map((e) => e.exercise_id));
  const groups = {};
  for (const ex of exercises) {
    (groups[ex.muscle_group] ||= []).push(ex);
  }
  const keys = [...new Set([...PICKER_GROUP_ORDER, ...Object.keys(groups)])].filter((k) => groups[k]);

  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Add exercise to workout</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:10px">This only adds it to today's session — your program template stays unchanged.</div>
        <input class="input" id="wkadd-search" placeholder="Search…" style="margin-bottom:12px"/>
        ${keys
          .map(
            (g) => `
          <div class="picker-group" data-group="${g}">
            <div class="picker-group__title">${escapeHtml(g)}</div>
            ${groups[g]
              .map(
                (ex) => `
                <button class="picker-row ${inWorkout.has(ex.id) ? 'picker-row--added' : ''}" data-wkadd="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}">
                  <span>${escapeHtml(ex.name)}</span>
                  <span class="picker-row__state">${inWorkout.has(ex.id) ? 'in workout' : '+'}</span>
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

  const search = document.getElementById('wkadd-search');
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    picker.querySelectorAll('.picker-row').forEach((r) => {
      r.classList.toggle('hidden', q && !r.dataset.name.includes(q));
    });
    picker.querySelectorAll('.picker-group').forEach((g) => {
      const any = [...g.querySelectorAll('.picker-row')].some(
        (r) => !r.classList.contains('hidden')
      );
      g.classList.toggle('hidden', !any);
    });
  };

  picker.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(picker);
    const pickBtn = e.target.closest('[data-wkadd]');
    if (!pickBtn) return;
    const exId = Number(pickBtn.dataset.wkadd);
    const newEx = exercises.find((x) => x.id === exId);
    if (!newEx) return;
    if (inWorkout.has(exId)) {
      toast('Already in this workout');
      return;
    }
    workoutState.programDay.exercises.push({
      id: null, // virtual — not in the program template
      exercise_id: exId,
      name: newEx.name,
      muscle_group: newEx.muscle_group,
      notes: newEx.notes,
      is_bodyweight: !!newEx.is_bodyweight,
      target_sets: 3,
      target_reps: 10,
      order_index: workoutState.programDay.exercises.length
    });
    hideSheet(picker);
    haptic(20);
    toast(`Added ${newEx.name}`);
    renderWorkoutView();
  };
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
  if (workoutState?.workout?.id) clearDraft(workoutState.workout.id);
  localStorage.removeItem(LS.activeWorkoutId);
  localStorage.removeItem(LS.activeProgramDayId);
  if (stickyTimerHandle) clearInterval(stickyTimerHandle);
  releaseWakeLock();
  cancelRestCountdown();
  setTab('programs');
}

async function finishWorkout() {
  const id = workoutState?.workout?.id;
  if (!id) return;
  try {
    await API.finishWorkout(id);
    if (stickyTimerHandle) clearInterval(stickyTimerHandle);
    releaseWakeLock();
    cancelRestCountdown();

    const sets = await API.workoutSets(id);
    // BW exercises (pull-ups, push-ups, core etc.) need bodyweight folded in
    // or they contribute zero to volume despite being real work.
    const totalVolume = sets.reduce((acc, s) => {
      const kg = s.is_bodyweight
        ? toKg(s.weight, s.weight_unit) + (userBwKg || 0)
        : toKg(s.weight, s.weight_unit);
      return acc + kg * s.reps;
    }, 0);

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
      workoutId: id,
      sets: sets.length,
      volume: totalVolume,
      duration: fmtDuration(workoutState.startedAt, new Date().toISOString()),
      newPRs,
      dayLabel: workoutState.programDay.day_label
    });

    clearDraft(id);
    localStorage.removeItem(LS.activeWorkoutId);
    localStorage.removeItem(LS.activeProgramDayId);
    localStorage.removeItem(LS.activeWorkoutStart);
    workoutState = null;
    refreshBadgeFromCalendar();
  } catch (err) {
    toast(err.message);
  }
}

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

function renderSummary({ workoutId, sets, volume, duration, newPRs, dayLabel }) {
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
          <div class="summary__tile-label">Volume (kg)</div>
          <div class="summary__tile-value">${Math.round(volume).toLocaleString()}</div>
        </div>
        <div class="summary__tile">
          <div class="summary__tile-label">Time</div>
          <div class="summary__tile-value">${duration}</div>
        </div>
      </div>
      ${newPRs.length
        ? `<div class="card" style="text-align:left">
            <div class="card__title">New PRs &#x1F3C6;</div>
            ${newPRs.map((pr) =>
              `<div class="card__subtitle" style="margin-top:6px"><strong style="color:var(--accent)">${escapeHtml(pr.name)}</strong> — ${pr.weight}${pr.weight_unit} × ${pr.reps}</div>`
            ).join('')}
          </div>`
        : ''}
      <div class="feel-prompt">
        <div class="feel-prompt__label">How did it feel?</div>
        <div class="feel-prompt__options">
          ${FEEL_OPTIONS.map((o) => `
            <button class="feel-btn" data-feel="${o.v}" title="${o.label}">
              <span class="feel-btn__emoji">${o.emoji}</span>
              <span class="feel-btn__label">${o.label}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <button class="btn btn--primary btn--block" data-go-programs>Done</button>
    </div>
  `;

  root.onclick = async (e) => {
    if (e.target.closest('[data-go-programs]')) return setTab('programs');
    const feelBtn = e.target.closest('[data-feel]');
    if (feelBtn && workoutId) {
      const rating = Number(feelBtn.dataset.feel);
      root.querySelectorAll('.feel-btn').forEach((b) =>
        b.classList.toggle('feel-btn--active', Number(b.dataset.feel) === rating)
      );
      haptic(20);
      try { await API.updateFeel(workoutId, rating); } catch { /* non-critical */ }
    }
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
      <div id="bw-recent" class="bw-recent"></div>
      <div class="chart-wrap bw-chart-wrap hidden" id="bw-chart-wrap"><canvas id="bw-chart"></canvas></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Strength Standards (vs. body weight)</div>
      <div id="strength-standards"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">What if I took a break?</div>
      <div id="break-projection"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Readiness (RPE trend)</div>
      <div id="readiness"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Personal Records (best per rep count)</div>
      <div id="pr-timeline"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Strength Curve</div>
      <select class="input" id="strength-ex"></select>
      <div class="chart-wrap" style="margin-top:12px"><canvas id="strength-chart"></canvas></div>
      <div class="progress-section__title" style="margin-top:18px">Weekly volume — same exercise</div>
      <div class="chart-wrap"><canvas id="ex-volume-chart"></canvas></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Weekly Volume by Muscle Group</div>
        <select class="input" id="volume-range" style="width:auto;min-height:34px;padding:0 10px;font-size:13px">
          <option value="4">4 weeks</option>
          <option value="8" selected>8 weeks</option>
          <option value="13">3 months</option>
          <option value="26">6 months</option>
          <option value="52">1 year</option>
          <option value="0">All time</option>
        </select>
      </div>
      <div class="chart-wrap" style="margin-top:12px"><canvas id="volume-chart"></canvas></div>
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
      renderExerciseVolumeChart(data.sets, data.exercise);
    };

    renderVolumeChart(weekly);
    renderCalendar(calendarDates);

    document.getElementById('volume-range').onchange = async (e) => {
      const weeks = Number(e.target.value);
      const data = await API.weeklyVolume(weeks);
      renderVolumeChart(data);
    };
    renderStrengthStandards();
    renderBreakProjection();
    renderPrTimeline();
    renderReadiness(exercises);
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

function renderStrengthChart({ sets, prs, exercise }) {
  const canvas = document.getElementById('strength-chart');
  if (!canvas) return;
  if (chartInstances.strength) chartInstances.strength.destroy();

  const isBw = !!exercise?.is_bodyweight;

  // Max effective load per day (adds userBwKg for bodyweight exercises)
  const byDay = new Map();
  for (const s of sets) {
    const day = s.logged_at.slice(0, 10);
    const kg = isBw
      ? toKg(s.weight, s.weight_unit) + (userBwKg || 0)
      : toKg(s.weight, s.weight_unit);
    const prev = byDay.get(day) || 0;
    if (kg > prev) byDay.set(day, kg);
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
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} kg${isBw ? ' (incl. BW)' : ''}` } } },
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
    biceps: '#c6a1ff',
    triceps: '#ff8ad1',
    arms: '#c6a1ff',
    legs: '#9effa8',
    core: '#ffe066'
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

// Strength standard ratios (multiples of body weight) for novice/intermediate/
// advanced/elite. Values are rough — derived from commonly-cited lifter charts.
const STRENGTH_STANDARDS = {
  male: [
    { name: 'Bench Press', novice: 0.75, inter: 1.25, adv: 1.5, elite: 2.0 },
    { name: 'Back Squat', novice: 1.25, inter: 1.75, adv: 2.25, elite: 2.75 },
    { name: 'Deadlift', novice: 1.5, inter: 2.25, adv: 2.75, elite: 3.25 },
    { name: 'Overhead Press', novice: 0.55, inter: 0.9, adv: 1.15, elite: 1.4 }
  ],
  female: [
    { name: 'Bench Press', novice: 0.5, inter: 0.8, adv: 1.0, elite: 1.3 },
    { name: 'Back Squat', novice: 0.9, inter: 1.25, adv: 1.6, elite: 2.0 },
    { name: 'Deadlift', novice: 1.0, inter: 1.5, adv: 2.0, elite: 2.5 },
    { name: 'Overhead Press', novice: 0.35, inter: 0.55, adv: 0.75, elite: 1.0 }
  ]
};

function classifyStrength(ratio, std) {
  if (ratio >= std.elite) return { label: 'Elite', color: '#e8ff47' };
  if (ratio >= std.adv) return { label: 'Advanced', color: '#9effa8' };
  if (ratio >= std.inter) return { label: 'Intermediate', color: '#62d8ff' };
  if (ratio >= std.novice) return { label: 'Novice', color: '#ffb347' };
  return { label: 'Beginner', color: '#8a8a8a' };
}

async function renderStrengthStandards() {
  const root = $('#strength-standards');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;

  try {
    const [prs, bw, settings] = await Promise.all([
      API.prs(),
      API.bodyweight(),
      API.settings().catch(() => ({ strength_standard_gender: 'male' }))
    ]);
    if (!bw.length) {
      root.innerHTML = `<div class="bw-current__empty">Log your body weight above to see strength ratios.</div>`;
      return;
    }
    const bwKg = toKg(bw[0].weight, bw[0].weight_unit);
    const gender = settings.strength_standard_gender === 'female' ? 'female' : 'male';
    const standards = STRENGTH_STANDARDS[gender];

    const rows = standards.map((std) => {
      const group = prs.find((p) => p.exercise_name === std.name);
      if (!group || !group.records.length) {
        return `
          <div class="std-row std-row--empty">
            <div class="std-row__name">${std.name}</div>
            <div class="std-row__meta">No data yet</div>
          </div>
        `;
      }
      // Best e1RM across all PR records for this exercise
      let bestE1RM = 0;
      let bestRec = null;
      for (const r of group.records) {
        const e = e1RM(toKg(r.weight, r.weight_unit), r.reps);
        if (e > bestE1RM) {
          bestE1RM = e;
          bestRec = r;
        }
      }
      const ratio = bestE1RM / bwKg;
      const cls = classifyStrength(ratio, std);
      const pct = Math.min(100, (ratio / std.elite) * 100);
      return `
        <div class="std-row">
          <div class="std-row__top">
            <div class="std-row__name">${std.name}</div>
            <div class="std-row__ratio">${ratio.toFixed(2)}× <span style="color:${cls.color}">${cls.label}</span></div>
          </div>
          <div class="std-row__bar">
            <div class="std-row__fill" style="width:${pct}%;background:${cls.color}"></div>
            <div class="std-row__tick" style="left:${(std.novice / std.elite) * 100}%" title="Novice"></div>
            <div class="std-row__tick" style="left:${(std.inter / std.elite) * 100}%" title="Intermediate"></div>
            <div class="std-row__tick" style="left:${(std.adv / std.elite) * 100}%" title="Advanced"></div>
          </div>
          <div class="std-row__meta">Est. 1RM ${Math.round(bestE1RM)} kg · best ${bestRec.weight}${bestRec.weight_unit} × ${bestRec.reps}</div>
        </div>
      `;
    }).join('');

    root.innerHTML = `
      <div class="std-header">
        <div class="card__subtitle">Based on best e1RM ÷ body weight (${bw[0].weight} ${bw[0].weight_unit}) · ${gender} standards</div>
        <div class="std-header__toggle">
          <button class="std-tab ${gender === 'male' ? 'std-tab--active' : ''}" data-std-gender="male">Male</button>
          <button class="std-tab ${gender === 'female' ? 'std-tab--active' : ''}" data-std-gender="female">Female</button>
        </div>
      </div>
      ${rows}
    `;

    root.querySelectorAll('[data-std-gender]').forEach((btn) => {
      btn.onclick = async () => {
        const next = btn.dataset.stdGender;
        if (next === gender) return;
        try {
          await API.updateSettings({ strength_standard_gender: next });
          haptic(10);
          renderStrengthStandards();
        } catch (err) {
          toast(err.message);
        }
      };
    });
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't compute: ${escapeHtml(err.message)}</div>`;
  }
}

// Rough detraining model based on published literature:
// - Week 1 off: ~1% loss (mostly negligible, may even improve recovery)
// - Weeks 2-3: ~0.5%/day loss accelerating
// - Weeks 4+: ~0.7%/day, plateauing around 30-40% loss at several months
function projectStrengthLoss(daysOff) {
  if (daysOff <= 0) return 0;
  if (daysOff <= 7) return daysOff * 0.0014; // ~1% total at 1 week
  if (daysOff <= 21) return 0.01 + (daysOff - 7) * 0.003; // ~5% at 2 wk, ~7% at 3 wk
  if (daysOff <= 56) return 0.05 + (daysOff - 21) * 0.004; // ~19% at 2 months
  return Math.min(0.35, 0.19 + (daysOff - 56) * 0.002);
}

async function renderBreakProjection() {
  const root = $('#break-projection');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;

  try {
    const prs = await API.prs();
    const mainLifts = ['Bench Press', 'Back Squat', 'Deadlift', 'Overhead Press'];
    const rows = [];

    for (const name of mainLifts) {
      const group = prs.find((p) => p.exercise_name === name);
      if (!group || !group.records.length) {
        rows.push({ name, empty: true });
        continue;
      }
      let bestE1RM = 0;
      let bestAt = null;
      for (const r of group.records) {
        const e = e1RM(toKg(r.weight, r.weight_unit), r.reps);
        if (e > bestE1RM) {
          bestE1RM = e;
          bestAt = r.achieved_at;
        }
      }

      // Days since last session containing this exercise (from progress endpoint)
      let daysSince = null;
      try {
        const data = await API.progress(group.exercise_id);
        const lastSet = data.sets[data.sets.length - 1];
        if (lastSet) {
          const d = new Date(lastSet.logged_at.replace(' ', 'T') + 'Z');
          daysSince = Math.floor((Date.now() - d.getTime()) / 86400000);
        }
      } catch {
        /* ignore */
      }

      rows.push({
        name,
        bestE1RM,
        bestAt,
        daysSince,
        projections: [
          { label: '1 wk', days: 7 },
          { label: '2 wk', days: 14 },
          { label: '1 mo', days: 30 },
          { label: '2 mo', days: 60 }
        ]
      });
    }

    if (rows.every((r) => r.empty)) {
      root.innerHTML = `<div class="bw-current__empty">Log a few sessions of the main lifts (bench, squat, deadlift, press) to see this.</div>`;
      return;
    }

    root.innerHTML = `
      <div class="card__subtitle" style="margin-bottom:12px">Rough detraining projection from your current best e1RM. Comes back fast when you resume.</div>
      ${rows
        .map((r) => {
          if (r.empty) {
            return `<div class="break-row break-row--empty"><div class="break-row__name">${r.name}</div><div class="break-row__meta">No data yet</div></div>`;
          }
          const cells = r.projections
            .map((p) => {
              const loss = projectStrengthLoss(p.days);
              const projected = r.bestE1RM * (1 - loss);
              return `
                <div class="break-cell">
                  <div class="break-cell__label">${p.label}</div>
                  <div class="break-cell__val">${Math.round(projected)}</div>
                  <div class="break-cell__delta">-${Math.round(loss * 100)}%</div>
                </div>`;
            })
            .join('');
          const daysSinceTxt =
            r.daysSince == null
              ? ''
              : r.daysSince === 0
                ? 'today'
                : r.daysSince === 1
                  ? 'yesterday'
                  : `${r.daysSince}d ago`;
          return `
            <div class="break-row">
              <div class="break-row__head">
                <div class="break-row__name">${r.name}</div>
                <div class="break-row__meta">
                  <span>Now: <strong>${Math.round(r.bestE1RM)} kg</strong></span>
                  ${daysSinceTxt ? `<span class="break-row__since">last ${daysSinceTxt}</span>` : ''}
                </div>
              </div>
              <div class="break-cells">${cells}</div>
            </div>
          `;
        })
        .join('')}
    `;
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't compute: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderPrTimeline() {
  const root = $('#pr-timeline');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;

  try {
    const [prs, allExercises] = await Promise.all([API.prs(), API.exercises()]);
    await syncUserBodyweight();
    const exById = new Map(allExercises.map((e) => [e.id, e]));
    // Flatten to events
    const events = [];
    for (const g of prs) {
      const ex = exById.get(g.exercise_id);
      for (const r of g.records) {
        events.push({
          exerciseName: g.exercise_name,
          muscleGroup: g.muscle_group,
          weight: r.weight,
          weight_unit: r.weight_unit,
          reps: r.reps,
          achievedAt: r.achieved_at,
          isBodyweight: !!ex?.is_bodyweight,
          e1rm: e1RMForSet(r, ex)
        });
      }
    }
    if (!events.length) {
      root.innerHTML = `<div class="bw-current__empty">No PRs yet — log some sets to build this up.</div>`;
      return;
    }
    events.sort((a, b) => b.achievedAt.localeCompare(a.achievedAt));

    // Header explaining what this section actually is (current bests, not event history)
    const subtitle = `<div class="card__subtitle" style="margin-bottom:10px">Your current best weight at each rep count, per lift. Recomputes when you edit or delete sets.</div>`;

    // Group by exercise, preserve date order within
    const byExercise = new Map();
    for (const ev of events) {
      if (!byExercise.has(ev.exerciseName)) byExercise.set(ev.exerciseName, []);
      byExercise.get(ev.exerciseName).push(ev);
    }

    const groupOrder = [...byExercise.keys()].sort((a, b) => {
      const aLatest = byExercise.get(a)[0].achievedAt;
      const bLatest = byExercise.get(b)[0].achievedAt;
      return bLatest.localeCompare(aLatest);
    });

    root.innerHTML =
      subtitle +
      groupOrder
        .map((name) => {
          const list = byExercise.get(name);
          list.sort((a, b) => a.reps - b.reps);
          return `
            <div class="pr-group">
              <div class="pr-group__name">${escapeHtml(name)}</div>
              ${list
                .map(
                  (ev) => `
                    <div class="pr-event">
                      <div class="pr-event__date">${ev.reps}-rep max</div>
                      <div class="pr-event__body">
                        <span class="pr-event__main">${fmtSetWeight(ev.weight, ev.weight_unit, ev.isBodyweight)} × ${ev.reps}</span>
                        <span class="pr-event__e1rm">${formatDateShort(ev.achievedAt)} · e1RM ${Math.round(ev.e1rm)} kg</span>
                      </div>
                    </div>
                  `
                )
                .join('')}
            </div>
          `;
        })
        .join('');
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`;
  }
}

async function renderReadiness(exercises) {
  const root = $('#readiness');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;

  const since = Date.now() - 42 * 86400000; // last 6 weeks

  // Fetch per-exercise data in parallel, but only for exercises with likely data.
  // We piggyback on the strength standards signals to keep it scoped.
  try {
    const rows = [];
    // Limit to exercises that have at least one PR (proxy for "tracked")
    const prs = await API.prs();
    const tracked = prs.map((p) => p.exercise_id);

    const datas = await Promise.all(
      tracked.map((id) => API.progress(id).then((d) => ({ id, d })).catch(() => null))
    );

    for (const item of datas) {
      if (!item) continue;
      const { id, d } = item;
      const exName = exercises.find((e) => e.id === id)?.name || '?';
      // Group sets by session (date), only those with rpe logged, within 6 weeks
      const bySession = new Map();
      for (const s of d.sets) {
        if (s.rpe == null) continue;
        const t = new Date(s.logged_at.replace(' ', 'T') + 'Z').getTime();
        if (t < since) continue;
        const day = s.logged_at.slice(0, 10);
        if (!bySession.has(day)) bySession.set(day, []);
        bySession.get(day).push(s);
      }
      if (bySession.size < 2) continue;
      const sessionKeys = [...bySession.keys()].sort();
      const sessionAvgRpe = sessionKeys.map((k) => {
        const sets = bySession.get(k);
        const avg = sets.reduce((acc, s) => acc + s.rpe, 0) / sets.length;
        const maxW = Math.max(...sets.map((s) => toKg(s.weight, s.weight_unit)));
        return { day: k, avgRpe: avg, maxW };
      });

      // Compare last 3 to prior 3 (or fewer)
      const recent = sessionAvgRpe.slice(-3);
      const prior = sessionAvgRpe.slice(-6, -3);
      const recentAvg = recent.reduce((a, s) => a + s.avgRpe, 0) / recent.length;
      const priorAvg = prior.length ? prior.reduce((a, s) => a + s.avgRpe, 0) / prior.length : recentAvg;
      const delta = recentAvg - priorAvg;

      const recentW = recent[recent.length - 1].maxW;
      const priorW = prior.length ? prior[prior.length - 1].maxW : recentW;
      const weightUp = recentW > priorW;

      let label, color;
      if (delta >= 0.75 && !weightUp) {
        label = 'Fatigue building';
        color = '#ff8a8a';
      } else if (delta >= 0.5 && !weightUp) {
        label = 'Watch it';
        color = '#ffb347';
      } else if (delta <= -0.5 || (delta <= 0.25 && weightUp)) {
        label = 'Progressing';
        color = '#9effa8';
      } else {
        label = 'Stable';
        color = '#62d8ff';
      }

      rows.push({
        exName,
        recentAvg,
        priorAvg,
        delta,
        label,
        color,
        sessions: sessionAvgRpe,
        weightUp,
        recentW
      });
    }

    if (!rows.length) {
      root.innerHTML = `<div class="bw-current__empty">Log RPE on a few sets to see fatigue/readiness trends.</div>`;
      return;
    }

    // Fatigue-risk first
    rows.sort((a, b) => b.delta - a.delta);

    root.innerHTML = `
      <div class="card__subtitle" style="margin-bottom:10px">Rising RPE at the same weight = fatigue building. Last 3 sessions vs. prior 3.</div>
      ${rows
        .map(
          (r) => `
            <div class="ready-row">
              <div class="ready-row__top">
                <div class="ready-row__name">${escapeHtml(r.exName)}</div>
                <div class="ready-row__label" style="color:${r.color}">${r.label}</div>
              </div>
              <div class="ready-row__meta">
                Avg RPE ${r.priorAvg.toFixed(1)} → ${r.recentAvg.toFixed(1)}
                <span style="color:${r.delta > 0 ? '#ff8a8a' : '#9effa8'}">
                  ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}
                </span>
                · ${Math.round(r.recentW)} kg ${r.weightUp ? '↑' : ''}
              </div>
            </div>
          `
        )
        .join('')}
    `;
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderExerciseVolumeChart(sets) {
  const canvas = document.getElementById('ex-volume-chart');
  if (!canvas) return;
  if (chartInstances.exVolume) chartInstances.exVolume.destroy();

  if (!sets.length) {
    const ctx = canvas.getContext('2d');
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    return;
  }

  // Aggregate by ISO week
  const byWeek = new Map();
  for (const s of sets) {
    const d = new Date(s.logged_at.replace(' ', 'T') + 'Z');
    const week = isoWeekKey(d);
    const volKg = toKg(s.weight, s.weight_unit) * s.reps;
    byWeek.set(week, (byWeek.get(week) || 0) + volKg);
  }
  const labels = [...byWeek.keys()].sort();
  const values = labels.map((w) => Math.round(byWeek.get(w)));
  const d = chartDefaults();

  chartInstances.exVolume = new Chart(canvas, {
    type: 'bar',
    data: {
      labels,
      datasets: [
        {
          data: values,
          backgroundColor: 'rgba(232,255,71,0.8)',
          borderRadius: 4
        }
      ]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toLocaleString()} kg volume` } }
      },
      scales: { x: d, y: { ...d, beginAtZero: true } }
    }
  });
}

function isoWeekKey(date) {
  // ISO week (Mon-Sun), year-week
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
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
  userBwKg = toKg(latest.weight, latest.weight_unit);

  // Trend vs previous entry
  let trendStr = '';
  if (rows.length > 1) {
    const diff = toKg(latest.weight, latest.weight_unit) - toKg(rows[1].weight, rows[1].weight_unit);
    if (Math.abs(diff) >= 0.05) {
      const sign = diff > 0 ? '+' : '';
      trendStr = `<span class="bw-current__trend ${diff > 0 ? 'up' : 'down'}">${sign}${diff.toFixed(1)} kg</span>`;
    }
  }

  // Staleness nudge — encourage consistent logging
  const daysSinceLog = daysAgo(latest.logged_at);
  const staleNote = daysSinceLog >= 7
    ? `<div class="bw-stale">Last logged ${daysSinceLog} days ago — tap + Log to keep your trend accurate</div>`
    : '';

  currentEl.innerHTML = `
    <div class="bw-current__row">
      <span class="bw-current__val">${latest.weight}</span>
      <span class="bw-current__unit">${latest.weight_unit}</span>
      ${trendStr}
      <span class="bw-current__when">${humanAgo(latest.logged_at)}</span>
    </div>
    ${staleNote}
  `;

  // Collapsible history — show 4 by default, toggle to see all
  const SHOW_DEFAULT = 4;
  const hasMore = rows.length > SHOW_DEFAULT;

  function renderRecentList(expanded) {
    const visible = expanded ? rows : rows.slice(0, SHOW_DEFAULT);
    return `
      <div class="bw-list">
        ${visible.map((r, i) => `
          <div class="bw-item">
            <span class="bw-item__date">${formatDateShort(r.logged_at)}</span>
            <span class="bw-item__w">${r.weight} ${r.weight_unit}</span>
            ${r.notes ? `<span class="bw-item__note">${escapeHtml(r.notes)}</span>` : ''}
            <button class="bw-item__del" data-del-bw="${r.id}" aria-label="Delete">&times;</button>
          </div>
        `).join('')}
      </div>
      ${hasMore
        ? `<button class="bw-toggle" data-bw-toggle>${expanded
            ? `&#x25B2; Show less`
            : `&#x25BC; ${rows.length - SHOW_DEFAULT} more entries`
          }</button>`
        : ''}
    `;
  }

  let historyExpanded = false;
  recentEl.innerHTML = renderRecentList(false);

  recentEl.onclick = (e) => {
    if (e.target.closest('[data-bw-toggle]')) {
      historyExpanded = !historyExpanded;
      recentEl.innerHTML = renderRecentList(historyExpanded);
    }
  };

  if (rows.length >= 2) {
    chartWrap.classList.remove('hidden');
    renderBwChart(rows);
  } else {
    chartWrap.classList.add('hidden');
  }
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

      // Add an entirely new exercise to a finished workout
      const addExBtn = e.target.closest('[data-add-history-ex]');
      if (addExBtn) {
        e.stopPropagation();
        const card = addExBtn.closest('.history-card');
        openHistoryAddExercisePicker(Number(card.dataset.id));
        return;
      }

      // Set/change feel rating for a past workout
      const feelBtn = e.target.closest('[data-history-feel]');
      if (feelBtn) {
        e.stopPropagation();
        const card = feelBtn.closest('.history-card');
        const id = Number(card.dataset.id);
        const rating = Number(feelBtn.dataset.historyFeel);
        // Toggle: tap the active one again to clear
        const willClear = feelBtn.classList.contains('feel-btn--active');
        const newVal = willClear ? null : rating;
        try {
          await API.updateFeel(id, newVal);
          card.querySelectorAll('[data-history-feel]').forEach((b) =>
            b.classList.toggle('feel-btn--active', !willClear && Number(b.dataset.historyFeel) === rating)
          );
          // Update meta-line emoji on the card head
          const meta = card.querySelector('.history-card__meta');
          if (meta) {
            const baseText = meta.textContent.split(' · ').slice(0, 2).join(' · ');
            meta.textContent = newVal ? `${baseText} · ${feelEmoji(newVal)}` : baseText;
          }
          haptic(15);
        } catch (err) {
          toast(err.message);
        }
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
                      <span class="history-ex__set-w">${fmtSetWeight(s.weight, s.weight_unit, s.is_bodyweight)} × ${s.reps}</span>
                      ${s.rpe != null ? `<span class="history-ex__set-rpe">@${s.rpe}</span>` : ''}
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
    const currentFeel = workout.feel_rating;
    const feelButtons = FEEL_OPTIONS.map((o) => `
      <button class="feel-btn feel-btn--small ${currentFeel === o.v ? 'feel-btn--active' : ''}" data-history-feel="${o.v}" title="${o.label}">
        <span class="feel-btn__emoji">${o.emoji}</span>
        <span class="feel-btn__label">${o.label}</span>
      </button>
    `).join('');

    body.innerHTML = `
      ${exHTML || '<div class="empty">No sets logged</div>'}
      <button class="btn btn--ghost btn--block" data-add-history-ex style="margin-top:10px">+ Add exercise</button>
      <div class="history-card__body-actions">
        <label class="form-label">How did it feel?</label>
        <div class="feel-prompt__options">${feelButtons}</div>
        <label class="form-label" style="margin-top:14px">Workout notes</label>
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
  const groups = (w.muscle_groups || '')
    .split(',')
    .map((g) => g.trim())
    .filter(Boolean);
  const groupBadges = groups
    .map((g) => `<span class="badge badge--group badge--g-${g}">${escapeHtml(g)}</span>`)
    .join('');
  return `
    <div class="history-card" data-id="${w.id}">
      <button class="history-card__head">
        <div>
          <div class="history-card__title">${escapeHtml(w.day_label || 'Workout')}</div>
          <div class="history-card__meta">${started.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${dur}${w.feel_rating ? ' · ' + feelEmoji(w.feel_rating) : ''}</div>
          ${groupBadges ? `<div class="history-card__groups">${groupBadges}</div>` : ''}
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
      rpe: set.rpe ?? null,
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
    rpe: null,
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

        <label class="form-label" style="margin-top:14px">RPE</label>
        <div class="rpe-group rpe-group--wide" id="se-rpe-group">
          ${[6, 7, 8, 9, 10]
            .map(
              (n) =>
                `<button class="rpe-btn ${Number(s.rpe) === n ? 'rpe-btn--active' : ''}" data-se-rpe="${n}">${n}</button>`
            )
            .join('')}
          <button class="rpe-btn rpe-btn--clear ${s.rpe == null ? 'rpe-btn--active' : ''}" data-se-rpe="">none</button>
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

    const rpeBtn = e.target.closest('[data-se-rpe]');
    if (rpeBtn) {
      const raw = rpeBtn.dataset.seRpe;
      s.rpe = raw === '' ? null : Number(raw);
      sheet.querySelectorAll('[data-se-rpe]').forEach((b) => {
        const v = b.dataset.seRpe === '' ? null : Number(b.dataset.seRpe);
        b.classList.toggle('rpe-btn--active', v === s.rpe);
      });
      haptic(10);
      return;
    }

    if (e.target.closest('#se-save')) {
      const weight = parseFloat(document.getElementById('se-weight').value || '0');
      const reps = parseInt(document.getElementById('se-reps').value || '0', 10);
      const unit = document.getElementById('se-unit').textContent.trim();
      const notes = document.getElementById('se-notes').value.trim() || null;
      if (weight < 0 || Number.isNaN(weight) || !reps) return toast('Enter weight and reps');

      try {
        if (s.mode === 'edit') {
          await API.updateSet(s.setId, { weight, weight_unit: unit, reps, rpe: s.rpe, notes });
        } else {
          await API.logSet({
            workout_id: s.workoutId,
            exercise_id: s.exerciseId,
            set_number: s.setNumber,
            weight,
            weight_unit: unit,
            reps,
            rpe: s.rpe,
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

// ---------- Settings sheet ----------
function ensureSettingsSheet() {
  let sheet = document.getElementById('settings-sheet');
  if (!sheet) {
    sheet = document.createElement('div');
    sheet.id = 'settings-sheet';
    sheet.className = 'sheet hidden';
    document.body.appendChild(sheet);
  }
  return sheet;
}

async function openSettingsSheet() {
  const sheet = ensureSettingsSheet();
  const perm = notifPermission();
  const enabled = localStorage.getItem(LS.notifEnabled) === '1';
  const canNotif = 'Notification' in window && 'serviceWorker' in navigator;

  let serverSettings = {};
  try {
    serverSettings = await API.settings();
  } catch {
    serverSettings = { nudge_enabled: '1', nudge_threshold_days: '3' };
  }
  const nudgeOn = serverSettings.nudge_enabled === '1';
  const nudgeDays = Number(serverSettings.nudge_threshold_days || 3);

  let notifBody = '';
  if (!canNotif) {
    notifBody = `<div class="card__subtitle">Not supported in this browser.</div>`;
  } else if (perm === 'denied') {
    notifBody = `<div class="card__subtitle" style="color:var(--danger)">Blocked in browser settings. Re-enable for this site to receive rest-timer alerts.</div>`;
  } else {
    notifBody = `
      <label class="settings-row">
        <span>Rest-timer alerts${enabled ? '' : ' (off)'}</span>
        <button class="toggle ${enabled && perm === 'granted' ? 'toggle--on' : ''}" id="toggle-notif" aria-pressed="${enabled && perm === 'granted'}">
          <span class="toggle__dot"></span>
        </button>
      </label>
      <button class="btn btn--ghost btn--block" id="test-notif" style="margin-top:10px" ${enabled ? '' : 'disabled'}>Send test notification</button>
      <div class="card__subtitle" style="margin-top:8px">On iOS, notifications require adding the app to the Home Screen first.</div>
    `;
  }

  const pinSet = !!localStorage.getItem(LS.pin);
  const standalone = isStandalone();

  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Settings</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="settings-group">
          <div class="settings-group__title">Notifications</div>
          ${notifBody}
        </div>

        <div class="settings-group">
          <div class="settings-group__title">Reminders</div>
          <label class="settings-row">
            <span>Missed-training nudge</span>
            <button class="toggle ${nudgeOn ? 'toggle--on' : ''}" id="toggle-nudge" aria-pressed="${nudgeOn}">
              <span class="toggle__dot"></span>
            </button>
          </label>
          <div class="settings-row">
            <span>Nudge after</span>
            <div class="stepper" id="nudge-days-stepper">
              <button class="stepper__btn" data-nudge-step="-1">−</button>
              <span class="stepper__val" id="nudge-days-val">${nudgeDays} day${nudgeDays === 1 ? '' : 's'}</span>
              <button class="stepper__btn" data-nudge-step="1">+</button>
            </div>
          </div>
          <div class="card__subtitle" style="margin-top:6px">Quiet hours: 10pm–8am. Requires notifications on.</div>
        </div>

        <div class="settings-group">
          <div class="settings-group__title">App</div>
          <div class="settings-row">
            <span>Installed as PWA</span>
            <span class="settings-row__val">${standalone ? 'Yes' : 'No'}</span>
          </div>
          <div class="settings-row">
            <span>PIN lock</span>
            <button class="btn btn--ghost btn--sm" id="reset-pin">${pinSet ? 'Change / reset PIN' : 'Set PIN'}</button>
          </div>
        </div>

        <div class="settings-group">
          <div class="settings-group__title">Data</div>
          <div class="settings-row">
            <span>Export everything to JSON</span>
            <a class="btn btn--ghost btn--sm" href="/api/export" download>Download</a>
          </div>
          <div class="settings-row">
            <span>Restore from backup</span>
            <label class="btn btn--ghost btn--sm" style="cursor:pointer">
              Import
              <input type="file" accept=".json" id="import-file-input" style="display:none"/>
            </label>
          </div>
          <div class="card__subtitle" style="margin-top:4px">Export includes all workouts, sets, body weight, PRs and programs. Import merges — duplicate records are skipped safely.</div>
        </div>

        <div class="settings-group">
          <div class="settings-group__title">About</div>
          <div class="card__subtitle">IronLog · open-source PWA gym tracker</div>
        </div>
      </div>
    </div>
  `;
  showSheet(sheet);

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);

    if (e.target.closest('#toggle-notif')) {
      const btn = e.target.closest('#toggle-notif');
      const currentlyOn = btn.classList.contains('toggle--on');
      if (currentlyOn) {
        localStorage.setItem(LS.notifEnabled, '0');
        await unsubscribeWebPush();
        toast('Notifications off');
      } else {
        const result = await ensureNotifPermission();
        if (result !== 'granted') {
          toast(result === 'denied' ? 'Permission denied' : 'Could not enable');
          return;
        }
        const sub = await subscribeWebPush();
        localStorage.setItem(LS.notifEnabled, '1');
        toast(sub ? 'Notifications on' : 'On (local only)');
      }
      openSettingsSheet(); // re-render
      return;
    }

    if (e.target.closest('#test-notif')) {
      try {
        const res = await api('/api/push/test', {
          method: 'POST',
          body: { title: 'IronLog', body: 'Push test — you should see this!' }
        });
        toast(`Sent to ${res.sent} device${res.sent === 1 ? '' : 's'}`);
      } catch (err) {
        // Fallback to local SW notification
        await showLocalNotification('IronLog', 'Local test notification', { tag: 'ironlog-test' });
        toast('Sent locally');
      }
      return;
    }

    if (e.target.closest('#reset-pin')) {
      if (!confirm('Clear saved PIN? You will be prompted to set a new one.')) return;
      localStorage.removeItem(LS.pin);
      sessionStorage.removeItem(LS.pinUnlocked);
      hideSheet(sheet);
      setTimeout(() => location.reload(), 200);
      return;
    }

    if (e.target.closest('#toggle-nudge')) {
      const btn = e.target.closest('#toggle-nudge');
      const on = btn.classList.contains('toggle--on');
      try {
        await API.updateSettings({ nudge_enabled: on ? '0' : '1' });
        haptic(10);
        openSettingsSheet();
      } catch (err) {
        toast(err.message);
      }
      return;
    }

    const nudgeStep = e.target.closest('[data-nudge-step]');
    if (nudgeStep) {
      const delta = Number(nudgeStep.dataset.nudgeStep);
      const current = Number(document.getElementById('nudge-days-val').textContent.match(/\d+/)[0]);
      const next = Math.max(1, Math.min(14, current + delta));
      if (next === current) return;
      try {
        await API.updateSettings({ nudge_threshold_days: String(next) });
        document.getElementById('nudge-days-val').textContent = `${next} day${next === 1 ? '' : 's'}`;
        haptic(10);
      } catch (err) {
        toast(err.message);
      }
    }
  };

  // File input for import (needs change event, not click)
  const fileInput = sheet.querySelector('#import-file-input');
  if (fileInput) {
    fileInput.onchange = async () => {
      const file = fileInput.files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const json = JSON.parse(text);
        if (!confirm(`Import ${(json.workouts || []).length} workouts and ${(json.bodyweights || []).length} body-weight entries? Existing records are preserved.`)) return;
        const result = await api('/api/import', { method: 'POST', body: json, timeoutMs: 60000 });
        toast(`Imported: ${result.imported_workouts} workouts, ${result.imported_sets} sets, ${result.imported_bodyweights} BW entries`);
        fileInput.value = '';
      } catch (err) {
        toast(`Import failed: ${err.message}`);
      }
    };
  }
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

  // Wire settings gear
  const settingsBtn = $('#settings-btn');
  if (settingsBtn) settingsBtn.onclick = () => openSettingsSheet();

  // Decide initial tab
  const activeId = localStorage.getItem(LS.activeWorkoutId);
  const saved = localStorage.getItem(LS.currentTab);
  const initial = activeId ? 'workout' : saved || 'programs';
  setTab(initial);

  // Register service worker
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  // Refresh badge + show iOS install hint
  refreshBadgeFromCalendar();
  showInstallHintIfNeeded();
  syncTimezoneOffset();
}

async function syncTimezoneOffset() {
  try {
    const current = String(new Date().getTimezoneOffset());
    const settings = await API.settings();
    if (settings.nudge_tz_offset_minutes !== current) {
      await API.updateSettings({ nudge_tz_offset_minutes: current });
    }
  } catch {
    /* non-critical */
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
