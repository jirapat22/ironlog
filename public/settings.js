import { $, LS, escapeHtml, haptic, toast, showSheet, hideSheet, ensureSheet, confirmSheet, promptSheet, isStandalone, renderExerciseEditForm } from './utils.js';
import { api, API } from './api.js';
import { notifPermission, ensureNotifPermission, subscribeWebPush, unsubscribeWebPush, showLocalNotification } from './audio.js';
import { reportBugManually } from './bugreport.js';

// Keep in sync with the lock-screen palette in app.js.
const ACCENTS = ['#e8643c', '#3ca0e8', '#5ac46a', '#b06cf0', '#f0a92c', '#e8519b', '#2cc4c4', '#8a90a0'];

async function openSettingsSheet() {
  const sheet = ensureSheet('settings-sheet');
  const perm = notifPermission();
  const enabled = localStorage.getItem(LS.notifEnabled) === '1';
  const canNotif = 'Notification' in window && 'serviceWorker' in navigator;

  let me = null;
  try { me = (await API.me()).profile; } catch { /* not logged in */ }

  let serverSettings = {};
  try { serverSettings = await API.settings(); }
  catch { serverSettings = { nudge_enabled: '1', nudge_threshold_days: '3' }; }
  const nudgeOn = serverSettings.nudge_enabled === '1';
  const nudgeDays = Number(serverSettings.nudge_threshold_days || 3);
  const prefUnit = serverSettings.preferred_unit || 'kg';
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

  const standalone = isStandalone();

  const accountGroup = me ? `
        <div class="settings-group">
          <div class="settings-group__title">Profile</div>
          <div class="settings-row">
            <span>Signed in as</span>
            <span class="profile-pill" style="background:${escapeHtml(me.accent_color || '#e8643c')}">${escapeHtml(me.name)}</span>
          </div>
          <div class="settings-row"><span>Display name</span><button class="btn btn--ghost btn--sm" id="edit-name">Edit</button></div>
          <div class="settings-row"><span>Accent colour</span>
            <div class="accent-row" id="settings-accents">
              ${ACCENTS.map((c) => `<button class="accent-dot ${c === me.accent_color ? 'accent-dot--active' : ''}" data-accent="${c}" style="background:${c}" aria-label="accent colour"></button>`).join('')}
            </div>
          </div>
          <div class="settings-row"><span>Passcode</span><button class="btn btn--ghost btn--sm" id="change-pass">Change</button></div>
        </div>
        <div class="settings-group">
          <div class="settings-group__title">Plated API key</div>
          <div class="card__subtitle" style="margin-bottom:8px">Paste this into your Plated profile so it can read your IronLog data.</div>
          <div class="apikey-box" id="apikey-box">${escapeHtml(me.api_key)}</div>
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn--ghost btn--sm" id="copy-key" style="flex:1">Copy</button>
            <button class="btn btn--ghost btn--sm" id="regen-key" style="flex:1">Regenerate</button>
          </div>
        </div>` : '';

  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Settings</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        ${accountGroup}
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
          <div class="settings-group__title">Workout defaults</div>
          <div class="settings-row">
            <span>Weight unit</span>
            <div class="unit-pick">
              <button class="unit-btn ${prefUnit === 'kg' ? 'unit-btn--active' : ''}" data-pref-unit="kg">kg</button>
              <button class="unit-btn ${prefUnit === 'lbs' ? 'unit-btn--active' : ''}" data-pref-unit="lbs">lbs</button>
            </div>
          </div>
        </div>
        <div class="settings-group">
          <div class="settings-group__title">App</div>
          <div class="settings-row"><span>Installed as PWA</span><span class="settings-row__val">${standalone ? 'Yes' : 'No'}</span></div>
        </div>
        ${me ? `
        <div class="settings-group">
          <div class="settings-group__title">Account</div>
          <button class="btn btn--ghost btn--block" id="logout-btn">Log out</button>
          <button class="btn btn--danger btn--block" id="delete-profile" style="margin-top:8px">Delete profile</button>
          <div class="card__subtitle" style="margin-top:6px">Deleting removes this profile and all its workouts, body weight and settings. This cannot be undone.</div>
        </div>` : ''}
        <div class="settings-group">
          <div class="settings-group__title">Exercises</div>
          <div class="settings-row">
            <span>Manage exercises</span>
            <button class="btn btn--ghost btn--sm" id="open-ex-library">View</button>
          </div>
          <div class="card__subtitle" style="margin-top:4px">Edit muscle group, sub-muscle and "also works" tags, see usage stats, or delete unused exercises.</div>
        </div>
        <div class="settings-group">
          <div class="settings-group__title">Ideas &amp; Bugs</div>
          <div class="settings-row">
            <span>Upgrade ideas &amp; bug list</span>
            <button class="btn btn--ghost btn--sm" id="open-notes">Open</button>
          </div>
          <div class="card__subtitle" style="margin-top:4px">A checklist for things to build or fix. Tick items off when done.</div>
          <div class="settings-row" style="margin-top:10px">
            <span>Feedback</span>
            <button class="btn btn--ghost btn--sm" id="report-bug">Send</button>
          </div>
          <div class="card__subtitle" style="margin-top:4px">Report a bug or share an idea — sent straight to Orbit for review.</div>
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

    if (e.target.closest('#edit-name')) {
      const name = await promptSheet({ title: 'Display name', label: 'Your name', value: me?.name || '', confirmText: 'Save' });
      if (name == null || !name.trim()) return;
      try {
        const { profile } = await API.updateMe({ name: name.trim() });
        document.dispatchEvent(new CustomEvent('ironlog:profile-updated', { detail: profile }));
        toast('Name updated');
        openSettingsSheet();
      } catch (err) { toast(err.message); }
      return;
    }

    const accentDot = e.target.closest('#settings-accents [data-accent]');
    if (accentDot) {
      try {
        const { profile } = await API.updateMe({ accent_color: accentDot.dataset.accent });
        document.dispatchEvent(new CustomEvent('ironlog:profile-updated', { detail: profile }));
        haptic(10);
        openSettingsSheet();
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('#change-pass')) {
      const code = await promptSheet({ title: 'Change passcode', label: 'New 4-digit passcode', placeholder: '••••', confirmText: 'Save' });
      if (code == null) return;
      if (!/^\d{4}$/.test(code.trim())) { toast('Passcode must be 4 digits'); return; }
      try { await API.changePasscode(code.trim()); toast('Passcode changed'); }
      catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('#copy-key')) {
      try {
        await navigator.clipboard.writeText(me.api_key);
        toast('API key copied');
      } catch { toast('Copy failed — select it manually'); }
      return;
    }

    if (e.target.closest('#regen-key')) {
      const ok = await confirmSheet({ title: 'Regenerate API key', message: 'Your old key stops working immediately. You must paste the new key into Plated.', confirmText: 'Regenerate', danger: true });
      if (!ok) return;
      try {
        const { api_key } = await API.regenerateApiKey();
        me.api_key = api_key;
        const box = sheet.querySelector('#apikey-box');
        if (box) box.textContent = api_key;
        toast('New key generated — update Plated');
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('#logout-btn')) {
      try { await API.logout(); } catch { /* ignore */ }
      hideSheet(sheet);
      document.dispatchEvent(new CustomEvent('ironlog:lock'));
      return;
    }

    if (e.target.closest('#delete-profile')) {
      const ok = await confirmSheet({ title: 'Delete profile', message: `Permanently delete "${me?.name}" and all its data?`, confirmText: 'Delete forever', danger: true });
      if (!ok) return;
      try {
        await API.deleteMe();
        hideSheet(sheet);
        document.dispatchEvent(new CustomEvent('ironlog:lock'));
      } catch (err) { toast(err.message); }
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

    if (e.target.closest('#open-ex-library')) { openExerciseLibrary(); return; }

    if (e.target.closest('#open-notes')) { openNotesSheet(); return; }

    if (e.target.closest('#report-bug')) {
      openFeedbackSheet();
      return;
    }

    const prefUnitBtn = e.target.closest('[data-pref-unit]');
    if (prefUnitBtn) {
      try {
        await API.updateSettings({ preferred_unit: prefUnitBtn.dataset.prefUnit });
        haptic(10); openSettingsSheet();
      } catch (err) { toast(err.message); }
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
        const ok = await confirmSheet({ title: 'Import backup', message: `Import ${(json.workouts || []).length} workouts and ${(json.bodyweights || []).length} body-weight entries? Existing records are preserved.`, confirmText: 'Import' });
        if (!ok) { fileInput.value = ''; return; }
        const result = await api('/api/import', { method: 'POST', body: json, timeoutMs: 60000 });
        toast(`Imported: ${result.imported_workouts} workouts, ${result.imported_sets} sets, ${result.imported_bodyweights} BW entries`);
        fileInput.value = '';
      } catch (err) { toast(`Import failed: ${err.message}`); }
    };
  }
}

async function openExerciseLibrary() {
  const sheet = ensureSheet('ex-library-sheet');
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Manage Exercises</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body" id="ex-lib-body">
        <div class="skeleton" style="height:200px"></div>
      </div>
    </div>`;
  showSheet(sheet);
  renderExerciseLibraryList(sheet);
}

async function renderExerciseLibraryList(sheet) {
  let stats;
  try { stats = await API.exerciseStats(); }
  catch (err) {
    document.getElementById('ex-lib-body').innerHTML = `<div class="empty">${err.message}</div>`;
    return;
  }

  const GROUPS = ['chest','back','shoulders','biceps','triceps','arms','legs','core'];
  const byGroup = {};
  for (const ex of stats) {
    const g = ex.muscle_group || 'other';
    if (!byGroup[g]) byGroup[g] = [];
    byGroup[g].push(ex);
  }

  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (iso) => {
    if (!iso) return 'never';
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  };

  const order = [...new Set([...GROUPS, ...Object.keys(byGroup)])].filter((g) => byGroup[g]);
  const html = order.map((g) => `
    <div class="ex-lib-group">
      <div class="ex-lib-group__title">${g}</div>
      ${byGroup[g].map((ex) => `
        <div class="ex-lib-row ${ex.workout_count === 0 ? 'ex-lib-row--unused' : ''}">
          <div class="ex-lib-row__info">
            <div class="ex-lib-row__name">${escapeHtml(ex.name)}</div>
            <div class="ex-lib-row__meta">
              ${ex.workout_count === 0
                ? '<span style="color:var(--text-dim)">Never used</span>'
                : `<span style="color:var(--accent)">${ex.workout_count} workout${ex.workout_count !== 1 ? 's' : ''}</span> · last ${fmtDate(ex.last_used_at)}`}
            </div>
          </div>
          <button class="btn--icon" data-edit-ex="${ex.id}" title="Edit">&#x270E;</button>
          ${ex.workout_count === 0
            ? `<button class="btn--icon btn--icon-danger" data-del-ex="${ex.id}" title="Delete">×</button>`
            : ''}
        </div>`).join('')}
    </div>`).join('');

  const unusedCount = stats.filter((e) => e.workout_count === 0).length;
  document.getElementById('ex-lib-body').innerHTML = `
    <div class="card__subtitle" style="margin-bottom:12px">
      ${stats.length} exercises total · <strong>${unusedCount}</strong> never used
    </div>
    ${html}`;

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);

    const editBtn = e.target.closest('[data-edit-ex]');
    if (editBtn) {
      const exId = Number(editBtn.dataset.editEx);
      const ex = stats.find((x) => x.id === exId);
      if (!ex) return;
      renderExerciseEditForm(sheet, ex, {
        onBack: () => openExerciseLibrary(),
        onSaved: () => openExerciseLibrary(),
        onDeleted: () => openExerciseLibrary()
      });
      return;
    }

    const delBtn = e.target.closest('[data-del-ex]');
    if (delBtn) {
      const exId = Number(delBtn.dataset.delEx);
      const row = delBtn.closest('.ex-lib-row');
      const name = row?.querySelector('.ex-lib-row__name')?.textContent || 'this exercise';
      const ok = await confirmSheet({ title: 'Delete exercise', message: `Delete "${name}"?`, confirmText: 'Delete', danger: true });
      if (!ok) return;
      try {
        await API.deleteExercise(exId);
        row.remove();
        haptic(20);
        toast(`Deleted ${name}`);
      } catch (err) { toast(err.message); }
    }
  };
}

async function openNotesSheet() {
  const sheet = ensureSheet('notes-sheet');
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Ideas &amp; Bugs</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="note-add">
          <div class="unit-pick" id="note-cat">
            <button class="unit-btn unit-btn--active" data-note-cat="idea">💡 Idea</button>
            <button class="unit-btn" data-note-cat="bug">🐞 Bug</button>
          </div>
          <div class="note-add__row">
            <input class="input" id="note-input" placeholder="Add an idea or bug…" autocomplete="off"/>
            <button class="btn btn--primary" id="note-add-btn">Add</button>
          </div>
        </div>
        <div id="notes-list"><div class="skeleton" style="height:120px"></div></div>
      </div>
    </div>`;
  showSheet(sheet);

  let notes = [];
  let category = 'idea';
  const sortNotes = () => notes.sort((a, b) => (a.done - b.done) || (b.created_at < a.created_at ? -1 : 1));

  const listHTML = () => {
    if (!notes.length) {
      return `<div class="empty" style="padding:24px 0"><div class="card__subtitle">No notes yet. Add your first idea or bug above.</div></div>`;
    }
    return notes.map((n) => `
      <div class="note-row ${n.done ? 'note-row--done' : ''}" data-note-id="${n.id}">
        <button class="note-row__check" data-note-toggle aria-label="Toggle done">${n.done ? '✓' : ''}</button>
        <div class="note-row__body">
          <span class="note-tag note-tag--${n.category === 'bug' ? 'bug' : 'idea'}">${n.category === 'bug' ? 'Bug' : 'Idea'}</span>
          <span class="note-row__text">${escapeHtml(n.text)}</span>
        </div>
        <button class="btn--icon btn--icon-danger" data-note-del aria-label="Delete">×</button>
      </div>`).join('');
  };
  const renderList = () => { const el = document.getElementById('notes-list'); if (el) el.innerHTML = listHTML(); };

  try { notes = await API.notes(); }
  catch (err) { const el = document.getElementById('notes-list'); if (el) el.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`; return; }
  renderList();

  const input = document.getElementById('note-input');
  const addNote = async () => {
    const text = input.value.trim();
    if (!text) return;
    try {
      const note = await API.addNote({ text, category });
      notes.unshift(note);
      sortNotes();
      input.value = '';
      haptic(10);
      renderList();
    } catch (err) { toast(err.message); }
  };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') addNote(); });

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);

    const catBtn = e.target.closest('[data-note-cat]');
    if (catBtn) {
      category = catBtn.dataset.noteCat;
      sheet.querySelectorAll('#note-cat .unit-btn').forEach((b) => b.classList.toggle('unit-btn--active', b === catBtn));
      return;
    }

    if (e.target.closest('#note-add-btn')) return addNote();

    const row = e.target.closest('.note-row');
    if (!row) return;
    const id = Number(row.dataset.noteId);
    const note = notes.find((n) => n.id === id);
    if (!note) return;

    if (e.target.closest('[data-note-toggle]')) {
      const done = note.done ? 0 : 1;
      try {
        await API.updateNote(id, { done });
        note.done = done;
        sortNotes();
        haptic(10);
        renderList();
      } catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('[data-note-del]')) {
      const ok = await confirmSheet({ title: 'Delete note', message: `Delete "${note.text}"?`, confirmText: 'Delete', danger: true });
      if (!ok) return;
      try {
        await API.deleteNote(id);
        notes = notes.filter((n) => n.id !== id);
        haptic(15);
        renderList();
      } catch (err) { toast(err.message); }
    }
  };
}

async function openFeedbackSheet() {
  const sheet = ensureSheet('feedback-sheet');
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Feedback</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="unit-pick" id="fb-type">
          <button class="unit-btn unit-btn--active" data-fb-type="bug_report">🐞 Bug</button>
          <button class="unit-btn" data-fb-type="idea">💡 Idea</button>
        </div>
        <label class="form-label" style="margin-top:14px">What's going on?</label>
        <textarea class="input" id="fb-message" rows="4" placeholder="Describe the bug or idea…" style="height:auto;padding:10px 14px;resize:vertical"></textarea>
        <label class="form-label" style="margin-top:14px">Additional details (optional)</label>
        <textarea class="input" id="fb-details" rows="3" placeholder="Steps to reproduce, links, etc." style="height:auto;padding:10px 14px;resize:vertical"></textarea>
        <button class="btn btn--primary btn--block" id="fb-send" style="margin-top:16px">Send</button>
      </div>
    </div>`;
  showSheet(sheet);

  let type = 'bug_report';

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);

    const typeBtn = e.target.closest('[data-fb-type]');
    if (typeBtn) {
      type = typeBtn.dataset.fbType;
      sheet.querySelectorAll('#fb-type .unit-btn').forEach((b) => b.classList.toggle('unit-btn--active', b === typeBtn));
      return;
    }

    if (e.target.closest('#fb-send')) {
      const message = sheet.querySelector('#fb-message').value.trim();
      const details = sheet.querySelector('#fb-details').value.trim();
      if (!message) return toast('Describe what\'s going on first');
      try {
        await reportBugManually(message, { type, details });
        haptic(10);
        toast('Sent — thanks!');
        hideSheet(sheet);
      } catch (err) { toast(err.message); }
    }
  };
}

export { openSettingsSheet };
