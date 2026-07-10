// IronLog — main entry point. Imports all tab modules and handles boot/routing.
import { $, $$, LS, haptic, isIOS, isStandalone } from './utils.js';
import { API } from './api.js';
import { refreshBadgeFromCalendar } from './audio.js';
import { renderWorkout, flushWorkoutNotes } from './workout.js';
import { renderPrograms } from './programs.js';
import { renderProgress } from './progress.js';
import { renderHistory, flushHistoryNotes } from './history.js';
import { openSettingsSheet } from './settings.js';
import { installErrorReporting } from './bugreport.js';

installErrorReporting();

// ---------- Tab routing ----------
const TABS = ['workout', 'programs', 'progress', 'history'];

function setTab(tab) {
  if (!TABS.includes(tab)) tab = 'programs';
  localStorage.setItem(LS.currentTab, tab);

  $$('.view').forEach((v) => v.classList.add('hidden'));
  const view = $(`#view-${tab}`);
  if (view) view.classList.remove('hidden');

  $$('.nav__btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));

  $('#app-title').textContent =
    { workout: 'Workout', programs: 'Programs', progress: 'Progress', history: 'History' }[tab];
  $('#app-subtitle').textContent = '';

  const renderers = { workout: renderWorkout, programs: renderPrograms, progress: renderProgress, history: renderHistory };
  renderers[tab]?.();
}

// Custom event used by workout/programs modules to switch tabs without importing app.js
document.addEventListener('ironlog:switch-tab', (e) => setTab(e.detail));

// ---------- Notes flush on hide ----------
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && localStorage.getItem(LS.activeWorkoutId)) {
    // Re-acquire wake lock is handled inside workout module on next render
  }
  if (document.visibilityState === 'hidden') {
    flushWorkoutNotes();
    flushHistoryNotes();
  }
});

// ---------- Profile auth / lock screen ----------
// Server-backed per-profile login (replaces the old local-only PIN). The numpad
// resolves a 4-digit passcode to a profile; an unknown code offers to create a
// new profile with that code.
let currentProfile = null;
let lockBuffer = '';
let pendingCode = '';   // passcode captured for the create-a-profile flow
let lockBusy = false;

const ACCENTS = ['#e8643c', '#3ca0e8', '#5ac46a', '#b06cf0', '#f0a92c', '#e8519b', '#2cc4c4', '#8a90a0'];

function renderProfilePill() {
  const pill = $('#profile-pill');
  if (!pill) return;
  if (currentProfile) {
    pill.textContent = currentProfile.name;
    pill.style.background = currentProfile.accent_color || '#e8643c';
    pill.classList.remove('hidden');
  } else {
    pill.classList.add('hidden');
  }
}

function renderLockKeypad() {
  const pad = $('#pin-keypad');
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  pad.innerHTML = keys.map((k) =>
    k === '' ? '<span></span>' : `<button class="pin-key" data-key="${k}">${k}</button>`
  ).join('');
  pad.onclick = (e) => {
    const btn = e.target.closest('.pin-key');
    if (!btn || lockBusy) return;
    haptic(15);
    const k = btn.dataset.key;
    if (k === '⌫') lockBuffer = lockBuffer.slice(0, -1);
    else if (lockBuffer.length < 4) lockBuffer += k;
    renderLockDots();
    if (lockBuffer.length === 4) setTimeout(onCodeComplete, 120);
  };
}

function renderLockDots() {
  $$('#pin-dots span').forEach((d, i) => d.classList.toggle('filled', i < lockBuffer.length));
}

async function onCodeComplete() {
  const code = lockBuffer;
  lockBusy = true;
  try {
    const { profile } = await API.login(code);
    currentProfile = profile;
    hideLock();
  } catch {
    // Unknown code (or network) → offer to create a profile with it.
    pendingCode = code;
    showCreateForm();
  } finally {
    lockBusy = false;
  }
}

function showLock() {
  currentProfile = null;
  renderProfilePill();
  lockBuffer = '';
  pendingCode = '';
  $('#pin-subtitle').textContent = 'Enter your passcode';
  $('#pin-keypad').classList.remove('hidden');
  $('#pin-dots').classList.remove('hidden');
  $('#pin-create').classList.add('hidden');
  renderLockKeypad();
  renderLockDots();
  $('#pin-lock').classList.remove('hidden');
}

function showCreateForm() {
  $('#pin-subtitle').textContent = 'New passcode — create a profile';
  $('#pin-keypad').classList.add('hidden');
  $('#pin-dots').classList.add('hidden');
  const box = $('#pin-create');
  box.innerHTML = `
    <input class="input" id="create-name" placeholder="Your name" autocomplete="off" maxlength="24" />
    <div class="accent-row" id="create-accents">
      ${ACCENTS.map((c, i) => `<button class="accent-dot ${i === 0 ? 'accent-dot--active' : ''}" data-accent="${c}" style="background:${c}" aria-label="accent colour"></button>`).join('')}
    </div>
    <button class="btn btn--primary btn--block" id="create-go" style="margin-top:14px">Create profile</button>
    <button class="btn btn--ghost btn--block" id="create-back" style="margin-top:8px">Back</button>
    <div class="pin-lock__err" id="create-err"></div>`;
  box.classList.remove('hidden');
  let accent = ACCENTS[0];
  box.querySelector('#create-accents').onclick = (e) => {
    const dot = e.target.closest('[data-accent]');
    if (!dot) return;
    accent = dot.dataset.accent;
    box.querySelectorAll('.accent-dot').forEach((d) => d.classList.toggle('accent-dot--active', d === dot));
  };
  box.querySelector('#create-back').onclick = () => showLock();
  box.querySelector('#create-go').onclick = async () => {
    const name = box.querySelector('#create-name').value.trim();
    const errEl = box.querySelector('#create-err');
    if (!name) { errEl.textContent = 'Enter a name'; return; }
    try {
      const { profile } = await API.createProfile({ name, passcode: pendingCode, accent_color: accent });
      currentProfile = profile;
      hideLock();
    } catch (err) {
      errEl.textContent = err.message;
    }
  };
  setTimeout(() => box.querySelector('#create-name')?.focus(), 60);
}

function hideLock() {
  $('#pin-lock').classList.add('hidden');
  renderProfilePill();
  boot();
}

// ---------- iOS install hint ----------
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
    <button class="install-hint__close" aria-label="Dismiss">&times;</button>`;
  document.body.appendChild(banner);
  banner.querySelector('.install-hint__close').onclick = () => {
    localStorage.setItem(LS.installHintDismissed, '1');
    banner.remove();
  };
}

// ---------- Service worker + update prompt ----------
let swRegistered = false;
let updateAccepted = false; // set only when the user taps "Refresh"
function registerServiceWorker() {
  if (!('serviceWorker' in navigator) || swRegistered) return;
  swRegistered = true;

  // Reload once the new worker takes control — but ONLY after the user accepted
  // an update. The first-ever install also fires controllerchange (via
  // clients.claim()); reloading then would bounce the page on first load.
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!updateAccepted || reloading) return;
    reloading = true;
    window.location.reload();
  });

  navigator.serviceWorker.register('/sw.js').then((reg) => {
    // A new version may already be waiting from a previous visit.
    if (reg.waiting && navigator.serviceWorker.controller) showUpdateBanner(reg.waiting);
    reg.addEventListener('updatefound', () => {
      const nw = reg.installing;
      if (!nw) return;
      nw.addEventListener('statechange', () => {
        // "installed" while a controller already exists = an update (not first
        // install). Prompt the user instead of swapping silently.
        if (nw.state === 'installed' && navigator.serviceWorker.controller) showUpdateBanner(nw);
      });
    });
    // Actively check for a new worker whenever the app is reopened. iOS keeps
    // installed PWAs warm and rarely checks on its own, which is how phones got
    // stuck on stale code; this forces the check on every foreground.
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible') reg.update().catch(() => {});
    });
  }).catch(() => {});
}

function showUpdateBanner(worker) {
  if (document.getElementById('update-banner')) return;
  const banner = document.createElement('div');
  banner.id = 'update-banner';
  banner.className = 'update-banner';
  banner.innerHTML = `
    <span class="update-banner__text">A new version is ready</span>
    <button class="update-banner__btn" id="update-refresh">Refresh</button>`;
  document.body.appendChild(banner);
  banner.querySelector('#update-refresh').onclick = () => {
    updateAccepted = true;
    worker.postMessage({ type: 'skip-waiting' });
    banner.remove();
  };
}

async function syncTimezoneOffset() {
  try {
    const current = String(new Date().getTimezoneOffset());
    const settings = await API.settings();
    if (settings.nudge_tz_offset_minutes !== current) {
      await API.updateSettings({ nudge_tz_offset_minutes: current });
    }
  } catch { /* non-critical */ }
}

// ---------- Boot ----------
function boot() {
  $$('.nav__btn').forEach((b) => {
    b.onclick = () => { haptic(10); setTab(b.dataset.tab); };
  });

  const settingsBtn = $('#settings-btn');
  if (settingsBtn) settingsBtn.onclick = () => openSettingsSheet();

  const activeId = localStorage.getItem(LS.activeWorkoutId);
  const saved = localStorage.getItem(LS.currentTab);
  const initial = activeId ? 'workout' : saved || 'programs';
  setTab(initial);

  registerServiceWorker();

  refreshBadgeFromCalendar();
  showInstallHintIfNeeded();
  syncTimezoneOffset();
}

// A guarded API call returned 401 (session expired/invalid) — bounce to lock.
document.addEventListener('ironlog:unauthorized', () => {
  if ($('#pin-lock').classList.contains('hidden')) showLock();
});

// Settings asks us to re-lock (log out / delete profile). Clear per-profile
// UI-only preferences that live in localStorage — otherwise the next profile
// on this device silently inherits e.g. profile A's "Cardio only" History
// filter with no indication a filter is even active. (Active-workout pointers
// are deliberately left alone: they self-heal via a 404 check in workout.js
// if they turn out to belong to a workout the next profile can't see.)
document.addEventListener('ironlog:lock', () => {
  localStorage.removeItem(LS.historyKindFilter);
  showLock();
});

// Settings changed the profile name/colour — refresh the header pill.
document.addEventListener('ironlog:profile-updated', (e) => {
  currentProfile = e.detail;
  renderProfilePill();
});

// ---------- Startup: resolve session, then lock or boot ----------
(async function start() {
  try {
    const status = await API.authStatus();
    if (status.authenticated) {
      currentProfile = status.profile;
      renderProfilePill();
      boot();
    } else {
      showLock();
    }
  } catch {
    showLock();
  }
})();
