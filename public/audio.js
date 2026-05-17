import { $, LS, haptic, playBeep } from './utils.js';
import { api, API, REST_SECONDS } from './api.js';

// ---------- Notifications / Web Push / Badge ----------
function notifPermission() {
  return 'Notification' in window ? Notification.permission : 'unsupported';
}

async function ensureNotifPermission() {
  if (!('Notification' in window)) return 'unsupported';
  if (Notification.permission === 'granted') return 'granted';
  if (Notification.permission === 'denied') return 'denied';
  try {
    return await Notification.requestPermission();
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
  } catch { /* ignore */ }
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
  } catch { /* ignore */ }
}

async function scheduleRestPushBackup(seconds) {
  try {
    await api('/api/push/rest-timer', { method: 'POST', body: { seconds } });
  } catch { /* optional — main-thread local notification is primary */ }
}

async function cancelRestPushBackup() {
  try {
    await api('/api/push/rest-timer/cancel', { method: 'POST', body: {} });
  } catch { /* ignore */ }
}

async function setAppBadge(n) {
  if ('setAppBadge' in navigator) {
    try {
      if (!n) await navigator.clearAppBadge();
      else await navigator.setAppBadge(n);
    } catch { /* not supported or blocked */ }
  }
}

async function refreshBadgeFromCalendar() {
  try {
    const entries = await API.calendar();
    const now = new Date();
    const day = now.getDay();
    const start = new Date(now);
    start.setHours(0, 0, 0, 0);
    start.setDate(start.getDate() - day);
    let count = 0;
    for (const e of entries) {
      const when = new Date((e.date || e) + 'T00:00:00');
      if (when >= start) count++;
    }
    setAppBadge(count);
  } catch { /* ignore */ }
}

// ---------- Global rest countdown ----------
let restState = null; // { endAt, handle, doneTimeout, notified }

function startRestCountdown(secs = REST_SECONDS) {
  cancelRestCountdown();
  const endAt = Date.now() + secs * 1000;
  restState = { endAt, handle: null, doneTimeout: null, notified: false };

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
      if (restState?.handle) { clearInterval(restState.handle); restState.handle = null; }
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
      if (restState) restState.doneTimeout = setTimeout(cancelRestCountdown, 10000);
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
  if (el) { el.classList.add('hidden'); el.classList.remove('done'); el.innerHTML = ''; }
  if (hadActiveTimer && localStorage.getItem(LS.notifEnabled) === '1') cancelRestPushBackup();
}

function isRestActive() { return !!restState; }

export {
  notifPermission, ensureNotifPermission, showLocalNotification,
  urlBase64ToUint8Array, subscribeWebPush, unsubscribeWebPush,
  scheduleRestPushBackup, cancelRestPushBackup,
  setAppBadge, refreshBadgeFromCalendar,
  restState, startRestCountdown, cancelRestCountdown, isRestActive
};
