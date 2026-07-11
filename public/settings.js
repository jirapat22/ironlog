import { $, LS, escapeHtml, haptic, toast, showSheet, hideSheet, ensureSheet, confirmSheet, promptSheet, isStandalone, renderExerciseEditForm, renderNewExerciseForm, pickerChipsHTML, PICKER_GROUP_ORDER, REP_GOAL_DEFAULT_MIN, REP_GOAL_DEFAULT_MAX, subMuscleShadeClass, exerciseSortHTML, sortExercisesBy, groupBySubMuscle, subGroupToggleHTML } from './utils.js';
import { api, API } from './api.js';
import { notifPermission, ensureNotifPermission, subscribeWebPush, unsubscribeWebPush, showLocalNotification } from './audio.js';
import { reportBugManually, reportHandled } from './bugreport.js';

// Keep in sync with the lock-screen palette in app.js.
const ACCENTS = ['#e8643c', '#3ca0e8', '#5ac46a', '#b06cf0', '#f0a92c', '#e8519b', '#2cc4c4', '#8a90a0'];

async function openSettingsSheet() {
  const sheet = ensureSheet('settings-sheet');
  const perm = notifPermission();
  const enabled = localStorage.getItem(LS.notifEnabled) === '1';
  const canNotif = 'Notification' in window && 'serviceWorker' in navigator;

  let me = null;
  try { me = (await API.me()).profile; } catch { /* not logged in */ }

  let apiKey = null;
  if (me) { try { apiKey = (await API.getApiKey()).api_key; } catch (err) { reportHandled(err, { where: 'openSettingsSheet:getApiKey' }); } }

  let serverSettings = {};
  try { serverSettings = await API.settings(); }
  catch { serverSettings = { nudge_enabled: '1', nudge_threshold_days: '3' }; }
  const nudgeOn = serverSettings.nudge_enabled === '1';
  const nudgeDays = Number(serverSettings.nudge_threshold_days || 3);
  const prefUnit = serverSettings.preferred_unit || 'kg';
  const equivOn = serverSettings.show_weight_equiv !== '0';
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

  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Settings</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">

        ${me ? `
        <div class="settings-group__title">Profile</div>
        <div class="settings-group">
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
        </div>` : ''}

        <div class="settings-group__title">Exercises</div>
        <div class="settings-group">
          <div class="settings-row">
            <span>Manage exercises</span>
            <button class="btn btn--ghost btn--sm" id="open-ex-library">View</button>
          </div>
          <div class="card__subtitle">Edit muscle group, sub-muscle and "also works" tags, see usage stats, or delete unused exercises.</div>
        </div>

        <div class="settings-group__title">Ideas &amp; Bugs</div>
        <div class="settings-group">
          <div class="settings-row">
            <span>Upgrade ideas &amp; bug list</span>
            <button class="btn btn--ghost btn--sm" id="open-notes">Open</button>
          </div>
          <div class="card__subtitle">A checklist for things to build or fix — also sent to Orbit for review. Tick items off when done.</div>
        </div>

        <div class="settings-group__title">Workout</div>
        <div class="settings-group">
          <div class="settings-row">
            <span>Weight unit</span>
            <div class="unit-pick">
              <button class="unit-btn ${prefUnit === 'kg' ? 'unit-btn--active' : ''}" data-pref-unit="kg">kg</button>
              <button class="unit-btn ${prefUnit === 'lbs' ? 'unit-btn--active' : ''}" data-pref-unit="lbs">lbs</button>
            </div>
          </div>
          <label class="settings-row">
            <span>Show kg/lb equivalent on sets</span>
            <button class="toggle ${equivOn ? 'toggle--on' : ''}" id="toggle-equiv" aria-pressed="${equivOn}"><span class="toggle__dot"></span></button>
          </label>
        </div>

        <div class="settings-group__title">Notifications</div>
        <div class="settings-group ${!canNotif || perm === 'denied' ? 'settings-group--free' : ''}">
          ${notifBody}
        </div>

        <div class="settings-group__title">Reminders</div>
        <div class="settings-group">
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
          <label class="settings-row">
            <span>Weekly summary <span class="settings-row__val">(Sundays 7pm)</span></span>
            <button class="toggle ${weeklyOn ? 'toggle--on' : ''}" id="toggle-weekly" aria-pressed="${weeklyOn}"><span class="toggle__dot"></span></button>
          </label>
          <div class="card__subtitle">Quiet hours: 10pm–8am. Requires notifications on.</div>
        </div>

        <div class="settings-group__title">Data</div>
        <div class="settings-group">
          <div class="settings-row"><span>Export to JSON</span><a class="btn btn--ghost btn--sm" href="/api/export" download>Download</a></div>
          <div class="settings-row">
            <span>Restore from backup</span>
            <label class="btn btn--ghost btn--sm" style="cursor:pointer">Import<input type="file" accept=".json" id="import-file-input" style="display:none"/></label>
          </div>
          <div class="card__subtitle">Export includes all workouts, sets, body weight, PRs and programs. Import merges — duplicate records are skipped safely.</div>
        </div>

        ${me ? `
        <div class="settings-group__title">Plated API Key</div>
        <div class="settings-group settings-group--free">
          <div class="card__subtitle" style="margin-bottom:10px;padding-bottom:0">Paste this into your Plated profile so it can read your IronLog data.</div>
          <div class="apikey-box" id="apikey-box">${escapeHtml(apiKey || '')}</div>
          <div style="display:flex;gap:8px;margin-top:10px">
            <button class="btn btn--ghost btn--sm" id="copy-key" style="flex:1">Copy</button>
            <button class="btn btn--ghost btn--sm" id="regen-key" style="flex:1">Regenerate</button>
          </div>
        </div>` : ''}

        <div class="settings-group__title">App</div>
        <div class="settings-group">
          <div class="settings-row"><span>Installed as PWA</span><span class="settings-row__val">${standalone ? 'Yes' : 'No'}</span></div>
        </div>

        ${me ? `
        <div class="settings-group__title">Account</div>
        <div class="settings-group settings-group--free">
          <button class="btn btn--ghost btn--block" id="logout-btn">Log out</button>
          <button class="btn btn--danger btn--block" id="delete-profile" style="margin-top:8px">Delete profile</button>
          <div class="card__subtitle" style="margin-top:8px;padding-bottom:0">Deleting removes this profile and all its workouts, body weight and settings. This cannot be undone.</div>
        </div>` : ''}

        <div class="settings-group__title">About</div>
        <div class="settings-group settings-group--free">
          <div class="card__subtitle" style="padding-bottom:0">IronLog · open-source PWA gym tracker</div>
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
        await navigator.clipboard.writeText(apiKey || '');
        toast('API key copied');
      } catch { toast('Copy failed — select it manually'); }
      return;
    }

    if (e.target.closest('#regen-key')) {
      const ok = await confirmSheet({ title: 'Regenerate API key', message: 'Your old key stops working immediately. You must paste the new key into Plated.', confirmText: 'Regenerate', danger: true });
      if (!ok) return;
      try {
        const { api_key } = await API.regenerateApiKey();
        apiKey = api_key;
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

    if (e.target.closest('#toggle-equiv')) {
      const btn = e.target.closest('#toggle-equiv');
      const on = btn.classList.contains('toggle--on');
      try { await API.updateSettings({ show_weight_equiv: on ? '0' : '1' }); haptic(10); openSettingsSheet(); }
      catch (err) { toast(err.message); }
      return;
    }

    if (e.target.closest('#open-ex-library')) { openExerciseLibrary(); return; }

    if (e.target.closest('#open-notes')) { openNotesSheet(); return; }

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
        <button class="btn--icon" data-new-library-ex title="New exercise" style="font-size:20px;font-weight:700">+</button>
      </div>
      <div class="sheet__body" id="ex-lib-body">
        <div class="skeleton" style="height:200px"></div>
      </div>
    </div>`;
  sheet.querySelector('[data-new-library-ex]').onclick = () => {
    renderNewExerciseForm(sheet, {
      ctaLabel: 'Create exercise',
      onBack: () => openExerciseLibrary(),
      onCreated: (ex) => {
        toast(`${ex.name} created`);
        openExerciseLibrary();
      }
    });
  };
  showSheet(sheet);
  renderExerciseLibraryList(sheet);
}

// Persists across re-opens (edit/save/delete all re-call renderExerciseLibraryList)
// but not page reloads — same tier as other lightweight UI-only preferences.
let exLibSort = 'frequent';
let exLibSubGroup = false;

async function renderExerciseLibraryList(sheet) {
  let stats;
  try { stats = await API.exerciseStats(); }
  catch (err) {
    document.getElementById('ex-lib-body').innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`;
    return;
  }

  const GROUPS = PICKER_GROUP_ORDER;

  const pad = (n) => String(n).padStart(2, '0');
  const fmtDate = (iso) => {
    if (!iso) return 'never';
    const d = new Date(iso.replace(' ', 'T') + 'Z');
    return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`;
  };

  // Tappable rep-range goal chip on every row — the fast path for tuning
  // double-progression windows without opening each exercise's edit form.
  // Unset exercises show the 6–8 default (dimmed) and that IS the goal the
  // workout screen's progression hint uses, so the chip never lies.
  const repGoalChipHTML = (ex) => {
    const hasGoal = ex.rep_min != null || ex.rep_max != null;
    const min = ex.rep_min ?? REP_GOAL_DEFAULT_MIN;
    const max = ex.rep_max ?? REP_GOAL_DEFAULT_MAX;
    return `<button class="rep-goal${hasGoal ? '' : ' rep-goal--default'}" data-rep-goal="${ex.id}" title="Rep-range goal — tap to adjust">${min}–${max}</button>`;
  };

  // Rebuilds the body from the already-fetched `stats` — used on first render
  // and again whenever the sort-within-group choice changes, with no refetch.
  // The muscle-group sectioning itself is untouched by sort; only each
  // section's internal order changes.
  function buildBody() {
    const byGroup = {};
    for (const ex of stats) {
      const g = ex.muscle_group || 'other';
      if (!byGroup[g]) byGroup[g] = [];
      byGroup[g].push(ex);
    }
    for (const g of Object.keys(byGroup)) byGroup[g] = sortExercisesBy(byGroup[g], exLibSort);

    const order = [...new Set([...GROUPS, ...Object.keys(byGroup)])].filter((g) => byGroup[g]);

    const rowHTML = (ex, g, showSubTag) => `
      <div class="ex-lib-row ${ex.workout_count === 0 ? 'ex-lib-row--unused' : ''}">
        <div class="ex-lib-row__info">
          <div class="ex-lib-row__name">${escapeHtml(ex.name)}${showSubTag && ex.sub_muscle ? ` <span class="picker-row__sub mg-title mg-${g}${subMuscleShadeClass(g, ex.sub_muscle)}">${escapeHtml(ex.sub_muscle)}</span>` : ''}</div>
          <div class="ex-lib-row__meta">
            ${ex.workout_count === 0
              ? '<span style="color:var(--text-dim)">Never used</span>'
              : `<span style="color:var(--accent)">${ex.workout_count} workout${ex.workout_count !== 1 ? 's' : ''}</span> · last ${fmtDate(ex.last_used_at)}`}
          </div>
        </div>
        ${repGoalChipHTML(ex)}
        <button class="btn--icon" data-edit-ex="${ex.id}" title="Edit">&#x270E;</button>
        ${ex.workout_count === 0 && !ex.program_count
          ? `<button class="btn--icon btn--icon-danger" data-del-ex="${ex.id}" title="Delete">×</button>`
          : ''}
      </div>`;

    // When split-by-sub-muscle is on, the sub-muscle already IS the section
    // header, so the inline tag on each row (showSubTag) would be redundant —
    // suppressed the same way subMuscleTagHTML's sectioned views already do.
    const html = order.map((g) => `
      <div class="ex-lib-group" data-group="${g}">
        <div class="ex-lib-group__title mg-title mg-${g}">${g}</div>
        ${exLibSubGroup
          ? groupBySubMuscle(g, byGroup[g]).map(({ sub, exercises }) => `
              <div class="picker-subgroup__title mg-title mg-${g}${subMuscleShadeClass(g, sub)}">${escapeHtml(sub || 'General')}</div>
              ${exercises.map((ex) => rowHTML(ex, g, false)).join('')}
            `).join('')
          : byGroup[g].map((ex) => rowHTML(ex, g, true)).join('')}
      </div>`).join('');

    const unusedCount = stats.filter((e) => e.workout_count === 0).length;
    const body = document.getElementById('ex-lib-body');
    body.innerHTML = `
      <div class="card__subtitle" style="margin-bottom:12px">
        ${stats.length} exercises total · <strong>${unusedCount}</strong> never used
      </div>
      ${exerciseSortHTML(exLibSort)}
      ${subGroupToggleHTML(exLibSubGroup)}
      ${pickerChipsHTML(order)}
      ${html}`;

    // Jump-to-group: no search here, so chips just scroll to the group.
    const chips = body.querySelector('[data-picker-chips]');
    chips?.addEventListener('click', (e) => {
      const chip = e.target.closest('.picker-chip');
      if (!chip) return;
      chips.querySelectorAll('.picker-chip').forEach((c) => c.classList.toggle('picker-chip--active', c === chip));
      if (chip.dataset.chip) body.querySelector(`.ex-lib-group[data-group="${chip.dataset.chip}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'start' });
      else body.scrollTo({ top: 0, behavior: 'smooth' });
    });
  }

  buildBody();

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);

    const subgroupBtn = e.target.closest('[data-subgroup-toggle]');
    if (subgroupBtn) {
      if (sheet.querySelector('.rep-goal-edit')) { toast('Finish editing the rep goal first'); return; }
      exLibSubGroup = !exLibSubGroup;
      buildBody();
      return;
    }

    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) {
      // buildBody() fully rebuilds the list — if a rep-goal edit is open, that
      // would silently wipe whatever the user just typed with no warning.
      if (sheet.querySelector('.rep-goal-edit')) { toast('Finish editing the rep goal first'); return; }
      exLibSort = sortBtn.dataset.sort;
      buildBody();
      return;
    }

    // Tap the rep-goal chip → swap it for min/max inputs in place. Empty
    // inputs clear the override (back to the 6–8 default). Saving PATCHes
    // just rep_min/rep_max and swaps the chip back — no list re-render.
    const goalBtn = e.target.closest('[data-rep-goal]');
    if (goalBtn) {
      const exId = Number(goalBtn.dataset.repGoal);
      const ex = stats.find((x) => x.id === exId);
      if (!ex) return;
      const wrap = document.createElement('span');
      wrap.className = 'rep-goal-edit';
      wrap.innerHTML = `
        <input type="number" min="1" max="100" inputmode="numeric" value="${ex.rep_min ?? ''}" placeholder="${REP_GOAL_DEFAULT_MIN}" data-goal-min/>
        <span class="rep-goal-edit__dash">–</span>
        <input type="number" min="1" max="100" inputmode="numeric" value="${ex.rep_max ?? ''}" placeholder="${REP_GOAL_DEFAULT_MAX}" data-goal-max/>
        <button class="rep-goal-edit__save" data-goal-save>&#x2713;</button>`;
      goalBtn.replaceWith(wrap);
      let saving = false;
      const save = async (ev) => {
        ev.stopPropagation();
        if (saving) return; // guards Enter + tap both firing, or a double-tap re-submitting mid-flight
        const minRaw = wrap.querySelector('[data-goal-min]').value.trim();
        const maxRaw = wrap.querySelector('[data-goal-max]').value.trim();
        const minV = minRaw === '' ? null : Number(minRaw);
        const maxV = maxRaw === '' ? null : Number(maxRaw);
        for (const v of [minV, maxV]) {
          if (v != null && (!Number.isInteger(v) || v < 1 || v > 100)) return toast('Reps must be whole numbers 1–100');
        }
        if (minV != null && maxV != null && minV > maxV) return toast('Min can’t exceed max');
        saving = true;
        wrap.querySelectorAll('input, button').forEach((el) => { el.disabled = true; });
        try {
          const updated = await API.updateExercise(exId, { rep_min: minV, rep_max: maxV });
          Object.assign(ex, { rep_min: updated.rep_min ?? null, rep_max: updated.rep_max ?? null });
          const tmp = document.createElement('div');
          tmp.innerHTML = repGoalChipHTML(ex);
          wrap.replaceWith(tmp.firstElementChild);
          haptic(10);
        } catch (err) {
          // Fall back to the chip unchanged rather than leaving the row stuck
          // showing raw inputs with no way back except closing the sheet —
          // the user can tap the chip again to retry.
          toast(err.message);
          const tmp = document.createElement('div');
          tmp.innerHTML = repGoalChipHTML(ex);
          wrap.replaceWith(tmp.firstElementChild);
        }
      };
      wrap.querySelector('[data-goal-save]').onclick = save;
      wrap.querySelectorAll('input').forEach((inp) => {
        inp.onkeydown = (ev) => { if (ev.key === 'Enter') save(ev); };
      });
      wrap.querySelector('[data-goal-min]').focus();
      return;
    }
    // Clicks inside the open inline editor (inputs) shouldn't fall through.
    if (e.target.closest('.rep-goal-edit')) return;

    const editBtn = e.target.closest('[data-edit-ex]');
    if (editBtn) {
      const exId = Number(editBtn.dataset.editEx);
      const ex = stats.find((x) => x.id === exId);
      if (!ex) return;
      renderExerciseEditForm(sheet, ex, {
        onBack: () => openExerciseLibrary(),
        onSaved: () => openExerciseLibrary(),
        onDeleted: () => openExerciseLibrary(),
        onCleared: () => openExerciseLibrary()
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
      reportBugManually(text, { type: category === 'bug' ? 'bug_report' : 'idea', extraContext: { note_id: note.id } }).catch(() => {});
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

export { openSettingsSheet };
