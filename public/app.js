// IronLog — main entry point. Imports all tab modules and handles boot/routing.
import { $, $$, LS, haptic, isIOS, isStandalone } from './utils.js';
import { API } from './api.js';
import { refreshBadgeFromCalendar } from './audio.js';
import { renderWorkout, flushWorkoutNotes } from './workout.js';
import { renderPrograms } from './programs.js';
import { renderProgress } from './progress.js';
import { renderHistory, flushHistoryNotes } from './history.js';
import { openSettingsSheet } from './settings.js';

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

// ---------- PIN lock ----------
let pinBuffer = '', pinMode = 'enter', pinFirst = '';

function renderPinKeypad() {
  const pad = $('#pin-keypad');
  const keys = ['1','2','3','4','5','6','7','8','9','','0','⌫'];
  pad.innerHTML = keys.map((k) =>
    k === '' ? '<span></span>' : `<button class="pin-key" data-key="${k}">${k}</button>`
  ).join('');
  pad.onclick = (e) => {
    const btn = e.target.closest('.pin-key');
    if (!btn) return;
    haptic(15);
    const k = btn.dataset.key;
    if (k === '⌫') pinBuffer = pinBuffer.slice(0, -1);
    else if (pinBuffer.length < 4) pinBuffer += k;
    renderPinDots();
    if (pinBuffer.length === 4) setTimeout(onPinComplete, 120);
  };
}

function renderPinDots() {
  $$('#pin-dots span').forEach((d, i) => d.classList.toggle('filled', i < pinBuffer.length));
}

function onPinComplete() {
  const saved = localStorage.getItem(LS.pin);
  const lockEl = $('#pin-lock');
  if (!saved || saved === 'none') {
    if (pinMode === 'set') {
      pinFirst = pinBuffer; pinBuffer = ''; pinMode = 'confirm';
      $('#pin-subtitle').textContent = 'Confirm PIN';
      renderPinDots(); return;
    }
    if (pinMode === 'confirm') {
      if (pinBuffer === pinFirst) {
        localStorage.setItem(LS.pin, pinBuffer);
        sessionStorage.setItem(LS.pinUnlocked, '1');
        hidePinLock(); return;
      }
      pinFirst = ''; pinBuffer = ''; pinMode = 'set';
      $('#pin-subtitle').textContent = 'PINs did not match — set a new PIN';
      lockEl.classList.add('error');
      setTimeout(() => lockEl.classList.remove('error'), 400);
      renderPinDots(); return;
    }
  }
  if (saved && saved !== 'none' && pinBuffer === saved) {
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
  const hasPIN = saved && saved !== 'none';
  pinBuffer = ''; pinFirst = '';
  pinMode = hasPIN ? 'enter' : 'set';
  $('#pin-subtitle').textContent = hasPIN ? 'Enter PIN' : 'Set a 4-digit PIN';
  renderPinKeypad();
  renderPinDots();

  // Show "Skip" only on first-time PIN setup (not on the enter screen)
  let skipBtn = document.getElementById('pin-skip');
  if (!skipBtn) {
    skipBtn = document.createElement('button');
    skipBtn.id = 'pin-skip';
    skipBtn.className = 'btn btn--ghost';
    skipBtn.style.cssText = 'margin-top:16px;opacity:.7;font-size:13px';
    skipBtn.textContent = 'Skip — use without PIN';
    $('#pin-lock .pin-lock__inner').appendChild(skipBtn);
  }
  skipBtn.style.display = hasPIN ? 'none' : '';
  skipBtn.onclick = () => {
    localStorage.setItem(LS.pin, 'none');
    hidePinLock();
  };

  $('#pin-lock').classList.remove('hidden');
}

function hidePinLock() {
  $('#pin-lock').classList.add('hidden');
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

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch(() => {});
  }

  refreshBadgeFromCalendar();
  showInstallHintIfNeeded();
  syncTimezoneOffset();
}

// PIN gate — 'none' means user explicitly skipped setup
const _pin = localStorage.getItem(LS.pin);
if (!_pin) {
  showPinLock(); // first launch: offer setup or skip
} else if (_pin === 'none') {
  boot(); // skipped PIN
} else if (sessionStorage.getItem(LS.pinUnlocked) !== '1') {
  showPinLock(); // has PIN, needs to enter it
} else {
  boot();
}
