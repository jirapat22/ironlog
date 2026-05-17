import { $, LS, haptic, toast, showSheet, hideSheet, ensureSheet, isStandalone } from './utils.js';
import { api, API } from './api.js';
import { notifPermission, ensureNotifPermission, subscribeWebPush, unsubscribeWebPush, showLocalNotification } from './audio.js';

async function openSettingsSheet() {
  const sheet = ensureSheet('settings-sheet');
  const perm = notifPermission();
  const enabled = localStorage.getItem(LS.notifEnabled) === '1';
  const canNotif = 'Notification' in window && 'serviceWorker' in navigator;

  let serverSettings = {};
  try { serverSettings = await API.settings(); }
  catch { serverSettings = { nudge_enabled: '1', nudge_threshold_days: '3' }; }
  const nudgeOn = serverSettings.nudge_enabled === '1';
  const nudgeDays = Number(serverSettings.nudge_threshold_days || 3);
  const weeklyOn = serverSettings.weekly_summary_enabled === '1';

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
      <div class="card__subtitle" style="margin-top:8px">On iOS, notifications require adding the app to the Home Screen first.</div>`;
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
            <button class="toggle ${nudgeOn ? 'toggle--on' : ''}" id="toggle-nudge" aria-pressed="${nudgeOn}"><span class="toggle__dot"></span></button>
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
          <label class="settings-row" style="margin-top:10px">
            <span>Weekly summary (Sundays 7pm)</span>
            <button class="toggle ${weeklyOn ? 'toggle--on' : ''}" id="toggle-weekly" aria-pressed="${weeklyOn}"><span class="toggle__dot"></span></button>
          </label>
        </div>
        <div class="settings-group">
          <div class="settings-group__title">App</div>
          <div class="settings-row"><span>Installed as PWA</span><span class="settings-row__val">${standalone ? 'Yes' : 'No'}</span></div>
          <div class="settings-row"><span>PIN lock</span><button class="btn btn--ghost btn--sm" id="reset-pin">${pinSet ? 'Change / reset PIN' : 'Set PIN'}</button></div>
        </div>
        <div class="settings-group">
          <div class="settings-group__title">Data</div>
          <div class="settings-row"><span>Export everything to JSON</span><a class="btn btn--ghost btn--sm" href="/api/export" download>Download</a></div>
          <div class="settings-row">
            <span>Restore from backup</span>
            <label class="btn btn--ghost btn--sm" style="cursor:pointer">Import<input type="file" accept=".json" id="import-file-input" style="display:none"/></label>
          </div>
          <div class="card__subtitle" style="margin-top:4px">Export includes all workouts, sets, body weight, PRs and programs. Import merges — duplicate records are skipped safely.</div>
        </div>
        <div class="settings-group">
          <div class="settings-group__title">About</div>
          <div class="card__subtitle">IronLog · open-source PWA gym tracker</div>
        </div>
      </div>
    </div>`;
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
        if (result !== 'granted') { toast(result === 'denied' ? 'Permission denied' : 'Could not enable'); return; }
        const sub = await subscribeWebPush();
        localStorage.setItem(LS.notifEnabled, '1');
        toast(sub ? 'Notifications on' : 'On (local only)');
      }
      openSettingsSheet();
      return;
    }

    if (e.target.closest('#test-notif')) {
      try {
        const res = await api('/api/push/test', { method: 'POST', body: { title: 'IronLog', body: 'Push test — you should see this!' } });
        toast(`Sent to ${res.sent} device${res.sent === 1 ? '' : 's'}`);
      } catch {
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
      try { await API.updateSettings({ nudge_enabled: on ? '0' : '1' }); haptic(10); openSettingsSheet(); }
      catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('#toggle-weekly')) {
      const btn = e.target.closest('#toggle-weekly');
      const on = btn.classList.contains('toggle--on');
      try { await API.updateSettings({ weekly_summary_enabled: on ? '0' : '1' }); haptic(10); openSettingsSheet(); }
      catch (err) { toast(err.message); }
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
      } catch (err) { toast(err.message); }
    }
  };

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
      } catch (err) { toast(`Import failed: ${err.message}`); }
    };
  }
}

export { openSettingsSheet };
