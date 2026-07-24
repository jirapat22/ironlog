import { $, $$, LS, escapeHtml, haptic, primeAudio, toast, actionToast, fmtDuration, stepForExercise, skeletonBlocks, showPRFlash, e1RM, toKg, fromKg, fmtSetWeight, fmtReps, weightEquiv, showSheet, hideSheet, ensureSheet, promptSheet, confirmSheet, showBadgeDetail, enableDragReorder, PICKER_GROUP_ORDER, FEEL_OPTIONS, feelEmoji, REP_GOAL_DEFAULT_MIN, REP_GOAL_DEFAULT_MAX, renderNewExerciseForm, muscleTagHTML, pickerChipsHTML, setupPickerFilter, subMuscleShadeClass, exerciseSortHTML, sortExercisesBy, groupBySubMuscle, subGroupToggleHTML, daysAgo, formatDateShort } from './utils.js';
import { API } from './api.js';
import { startRestCountdown, cancelRestCountdown, isRestActive, refreshBadgeFromCalendar } from './audio.js';
import { openBodyweightSheet } from './progress.js';

// ---------- Body-weight tracking (for e1RM / load calculations) ----------
let userBwKg = 0;

async function syncUserBodyweight() {
  try {
    const rows = await API.bodyweight();
    if (rows.length) userBwKg = toKg(rows[0].weight, rows[0].weight_unit);
  } catch { /* ignore */ }
}

function loadKg(set, exercise) {
  const base = toKg(set.weight, set.weight_unit);
  if (exercise?.is_assisted && userBwKg) return Math.max(0, userBwKg - base);
  if (exercise?.is_bodyweight && userBwKg) return base + userBwKg;
  return base;
}

function e1RMForSet(set, exercise) {
  return e1RM(loadKg(set, exercise), set.reps);
}

// ---------- Wake lock ----------
let wakeLockSentinel = null;

async function acquireWakeLock() {
  if (!('wakeLock' in navigator)) return;
  try {
    wakeLockSentinel = await navigator.wakeLock.request('screen');
    wakeLockSentinel.addEventListener('release', () => { wakeLockSentinel = null; });
  } catch { /* fail silently */ }
}

function releaseWakeLock() {
  if (wakeLockSentinel) { wakeLockSentinel.release().catch(() => {}); wakeLockSentinel = null; }
}

// ---------- Draft persistence ----------
let workoutState = null;
let stickyTimerHandle = null;
// Set for the duration of finishWorkout()/cancelWorkout(). Guards two things:
// re-entrancy on those buttons themselves (a fast double-tap shouldn't fire
// finish/delete twice), and set-logging actions that could otherwise resolve
// AFTER workoutState has been nulled out mid-flight (tap a set's checkmark
// right as Finish is tapped) and throw trying to touch it.
let workoutEnding = false;

function draftKey(workoutId) { return `ironlog.draft.${workoutId}`; }

function loadDraft(workoutId) {
  try {
    const raw = localStorage.getItem(draftKey(workoutId));
    if (!raw) return { setCounts: {}, inputs: {}, pendingEdits: {} };
    const parsed = JSON.parse(raw);
    return { setCounts: parsed.setCounts || {}, inputs: parsed.inputs || {}, pendingEdits: parsed.pendingEdits || {}, exerciseOrder: parsed.exerciseOrder, exerciseList: parsed.exerciseList, skipped: parsed.skipped || {} };
  } catch {
    return { setCounts: {}, inputs: {}, pendingEdits: {}, skipped: {} };
  }
}

// Persist the workout's current exercise list (after a swap / add / reorder) so
// it survives navigation and reload. Without this, the list is rebuilt from the
// server program template plus logged sets, which re-adds swapped-away
// exercises and drops swaps/adds that have no logged sets yet.
// Saved BOTH locally (fast, works offline) and server-side (survives iOS
// evicting PWA localStorage and resuming on another device — the local-only
// draft was how swaps "switched back" mid-workout in the field).
function persistExerciseList() {
  if (!workoutState) return;
  workoutState.draft.exerciseList = workoutState.programDay.exercises.map((e) => ({
    id: e.id ?? null,
    exercise_id: e.exercise_id,
    name: e.name,
    muscle_group: e.muscle_group,
    sub_muscle: e.sub_muscle ?? null,
    notes: e.notes ?? null,
    is_bodyweight: !!e.is_bodyweight,
    is_assisted: !!e.is_assisted,
    equipment: e.equipment || 'barbell',
    weight_mode: e.weight_mode || 'per_arm',
    target_sets: e.target_sets,
    target_reps: e.target_reps,
    rep_min: e.rep_min ?? null,
    rep_max: e.rep_max ?? null,
    rest_seconds: e.rest_seconds ?? null,
    order_index: e.order_index
  }));
  saveDraft(workoutState.workout.id, workoutState.draft);
  API.updateWorkout(workoutState.workout.id, {
    exercise_list: JSON.stringify(workoutState.draft.exerciseList)
  }).catch(() => { /* best-effort — local draft still covers this device */ });
}

function saveDraft(workoutId, draft) {
  try { localStorage.setItem(draftKey(workoutId), JSON.stringify(draft)); } catch { /* quota */ }
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

// The small readout under a set row's weight. For a per-arm exercise it shows
// the TOTAL (both sides) alongside what you typed, so per-arm and total are
// visible SIMULTANEOUSLY — you enter one dumbbell's weight and immediately see
// the 2-arm total the volume is based on. For everything else it's the usual
// kg/lb unit equivalent.
function weightHintText(w, u, ex) {
  const wn = parseFloat(w);
  if (ex && ex.weight_mode === 'per_arm' && !ex.is_bodyweight && Number.isFinite(wn) && wn > 0) {
    return `= ${+(wn * 2).toFixed(1)} ${u} total`;
  }
  return workoutState?.showEquiv ? weightEquiv(w, u) : '';
}

// Live tag on a set row, recomputed as weight/unit change.
function updateRowEquiv(row) {
  const eqEl = row?.querySelector('[data-eq]');
  if (!eqEl) return;
  const w = row.querySelector('[data-field="weight"] .num-input__field')?.value;
  const u = row.querySelector('[data-unit]')?.textContent.trim();
  const exId = Number(row.dataset.ex);
  const ex = workoutState?.programDay?.exercises?.find((e) => e.exercise_id === exId);
  eqEl.textContent = weightHintText(w, u, ex);
}

// Picks which draft bucket a row's in-progress edits belong in: an already
// LOGGED row (has a set id) gets workoutState.draft.pendingEdits, keyed by
// set id — a still-unconfirmed row gets draft.inputs, keyed by exercise+set
// number (matching the pre-existing convention). Without routing logged rows
// somewhere, editing a mistyped weight/reps/note on a saved set had nowhere
// to live: typing a correction but tapping something on a DIFFERENT exercise
// before hitting the checkmark triggers a full renderWorkoutView() rebuild,
// which reads straight from the stale server-saved `logged.*` values and
// silently reverts the correction with zero warning.
function draftEntryFor(row) {
  if (row.dataset.setId) {
    if (!workoutState.draft.pendingEdits) workoutState.draft.pendingEdits = {};
    return { store: workoutState.draft.pendingEdits, key: row.dataset.setId };
  }
  const key = `${Number(row.dataset.ex)}-${Number(row.dataset.set)}`;
  return { store: workoutState.draft.inputs, key };
}

function markRowTouched(row) {
  if (!row || !workoutState) return;
  row.removeAttribute('data-pristine');
  const wIn = row.querySelector('[data-field="weight"] .num-input__field');
  const rIn = row.querySelector('[data-field="reps"] .num-input__field');
  const uBtn = row.querySelector('[data-unit]');
  const rirAttr = row.dataset.rir;
  const { store, key } = draftEntryFor(row);
  const existing = store[key] || {};
  store[key] = {
    ...existing,
    w: wIn ? wIn.value : '',
    u: uBtn ? uBtn.textContent.trim() : 'kg',
    r: rIn ? rIn.value : '',
    rir: rirAttr === '' || rirAttr == null ? null : Number(rirAttr)
  };
  saveDraft(workoutState.workout.id, workoutState.draft);
}

// Sibling to markRowTouched for the extras-panel fields (note, per-side
// reps) — kept separate since they live outside .num-input__field and are
// wired from a different oninput branch. Merges into the same draft entry
// (not a straight overwrite) so typing a note doesn't clobber a weight/reps
// draft already saved for this row, or vice versa.
function markRowExtrasTouched(row) {
  if (!row || !workoutState) return;
  const noteIn = row.querySelector('[data-note]');
  const rIn = row.querySelector('[data-reps-r]');
  const lIn = row.querySelector('[data-reps-l]');
  const { store, key } = draftEntryFor(row);
  const existing = store[key] || {};
  store[key] = {
    ...existing,
    note: noteIn ? noteIn.value : (existing.note ?? ''),
    repsR: rIn ? rIn.value : (existing.repsR ?? ''),
    repsL: lIn ? lIn.value : (existing.repsL ?? '')
  };
  saveDraft(workoutState.workout.id, workoutState.draft);
}

function getSetCount(ex) {
  const override = workoutState?.draft?.setCounts?.[ex.exercise_id];
  const loggedMax = Math.max(
    0,
    ...workoutState.loggedSets.filter((s) => s.exercise_id === ex.exercise_id).map((s) => s.set_number)
  );
  return Math.max(override ?? ex.target_sets, loggedMax);
}

// ---------- Log a non-strength activity (class / run / cardio) ----------
const ACTIVITY_TYPES = [
  ['hyrox', 'HYROX'], ['run', 'Run'], ['cycle', 'Cycle'], ['row', 'Row'],
  ['swim', 'Swim'], ['walk', 'Walk'], ['cardio', 'Cardio'], ['class', 'Class'], ['other', 'Other']
];

// `existing` (a workout row with kind='activity') switches this into edit
// mode: prefills every field and PATCHes instead of POSTing on save. Editing
// in place beats delete-and-relog because the latter loses the original
// logged_at/started_at and is needlessly fiddly for a typo fix.
function openActivitySheet(existing = null, { onSaved } = {}) {
  const sheet = ensureSheet('activity-sheet');
  const chip = (val, label, attr, active) =>
    `<button class="act-chip ${active ? 'act-chip--on' : ''}" data-${attr}="${val}">${escapeHtml(label)}</button>`;
  let existingTags = [];
  if (existing) { try { existingTags = JSON.parse(existing.muscle_tags || '[]'); } catch { existingTags = []; } }
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head"><button class="btn--icon" data-close-sheet>←</button><div class="sheet__title">${existing ? 'Edit activity' : 'Log activity'}</div><span style="width:40px"></span></div>
      <div class="sheet__body">
        <label class="form-label">Type</label>
        <div class="act-chips">${ACTIVITY_TYPES.map(([v, l]) => chip(v, l, 'act-type', existing ? existing.activity_type === v : v === ACTIVITY_TYPES[0][0])).join('')}</div>

        <label class="form-label" style="margin-top:16px">Duration (minutes)</label>
        <input class="input" id="act-dur" type="text" inputmode="numeric" placeholder="e.g. 45" value="${existing ? existing.duration_min : ''}"/>

        <label class="form-label" style="margin-top:16px">How hard? <span style="color:var(--text-dim);font-weight:400">· optional</span></label>
        <div class="card__subtitle" style="margin:-4px 0 8px">RPE, 6 = easy session, 10 = max effort — a different scale than the RIR on your strength sets.</div>
        <div class="act-chips">${[6, 7, 8, 9, 10].map((n) => chip(n, 'RPE ' + n, 'act-rpe', existing?.rpe === n)).join('')}</div>

        <label class="form-label" style="margin-top:16px">Distance <span style="color:var(--text-dim);font-weight:400">· optional</span></label>
        <div class="set-edit__row">
          <input class="input" id="act-dist" type="text" inputmode="decimal" placeholder="e.g. 5.2" style="flex:1" value="${existing?.distance ?? ''}"/>
          <button class="unit-toggle kg" id="act-dist-unit">${existing?.distance_unit || 'km'}</button>
        </div>

        <label class="form-label" style="margin-top:16px">Muscles worked <span style="color:var(--text-dim);font-weight:400">· keeps recovery honest</span></label>
        <div class="act-chips">${PICKER_GROUP_ORDER.map((g) => chip(g, g, 'act-mg', existingTags.includes(g))).join('')}</div>

        <label class="form-label" style="margin-top:16px">Notes</label>
        <input class="input" id="act-notes" placeholder="Optional" value="${escapeHtml(existing?.notes || '')}"/>

        <button class="btn btn--primary btn--block" id="act-save" style="margin-top:20px">${existing ? 'Update activity' : 'Save activity'}</button>
      </div>
    </div>`;
  showSheet(sheet);

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);
    const t = e.target.closest('[data-act-type]');
    if (t) { sheet.querySelectorAll('[data-act-type]').forEach((b) => b.classList.toggle('act-chip--on', b === t)); return; }
    const r = e.target.closest('[data-act-rpe]');
    if (r) { const on = r.classList.contains('act-chip--on'); sheet.querySelectorAll('[data-act-rpe]').forEach((b) => b.classList.remove('act-chip--on')); if (!on) r.classList.add('act-chip--on'); return; }
    const mg = e.target.closest('[data-act-mg]');
    if (mg) { mg.classList.toggle('act-chip--on'); haptic(8); return; }
    const u = e.target.closest('#act-dist-unit');
    if (u) { const next = u.textContent.trim() === 'km' ? 'mi' : 'km'; u.textContent = next; u.classList.toggle('kg', next === 'km'); return; }

    if (e.target.closest('#act-save')) {
      const minutes = parseInt(document.getElementById('act-dur').value || '0', 10);
      if (!minutes || minutes <= 0) return toast('Enter the duration in minutes');
      const activity_type = sheet.querySelector('[data-act-type].act-chip--on')?.dataset.actType || 'other';
      const rpeEl = sheet.querySelector('[data-act-rpe].act-chip--on');
      const rpe = rpeEl ? Number(rpeEl.dataset.actRpe) : null;
      const distVal = parseFloat(document.getElementById('act-dist').value || '');
      const distance = Number.isFinite(distVal) && distVal > 0 ? distVal : null;
      const distance_unit = distance != null ? document.getElementById('act-dist-unit').textContent.trim() : null;
      const muscle_tags = [...sheet.querySelectorAll('[data-act-mg].act-chip--on')].map((b) => b.dataset.actMg);
      const notes = document.getElementById('act-notes').value.trim() || null;
      const btn = document.getElementById('act-save');
      btn.disabled = true; btn.textContent = 'Saving…';
      const payload = { activity_type, duration_min: minutes, rpe, distance, distance_unit, muscle_tags, notes };
      try {
        const saved = existing ? await API.updateActivity(existing.id, payload) : await API.logActivity(payload);
        haptic(20); hideSheet(sheet);
        if (existing) {
          toast('Activity updated');
          onSaved?.(saved);
        } else {
          document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'history' }));
          if (saved.calories_burned == null) {
            actionToast('Activity logged — no calorie estimate (no bodyweight on file)', 'Log weight', () => openBodyweightSheet());
          } else {
            toast('Activity logged');
          }
        }
      } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = existing ? 'Update activity' : 'Save activity'; }
    }
  };
}

// ---------- Workout rendering ----------
async function renderWorkout(retriedAfterMissing = false) {
  workoutEnding = false;
  const root = $('#view-workout');
  let activeId = Number(localStorage.getItem(LS.activeWorkoutId) || 0);

  // localStorage gone (iOS storage eviction, new device) but a workout is
  // still open server-side? Adopt it instead of stranding it invisible.
  if (!activeId) {
    try {
      const active = await API.activeWorkout();
      if (active?.id) {
        activeId = active.id;
        localStorage.setItem(LS.activeWorkoutId, String(active.id));
        if (active.program_day_id) {
          localStorage.setItem(LS.activeProgramDayId, String(active.program_day_id));
        }
      }
    } catch { /* offline — fall through to the empty state */ }
  }

  if (!activeId) {
    root.innerHTML = `
      <div class="empty">
        <div class="empty__icon">&#x1F4AA;</div>
        <div style="margin-bottom:12px">No active workout</div>
        <button class="btn btn--primary btn--block" data-start-quick>Quick workout</button>
        <button class="btn btn--ghost btn--block" data-go-programs style="margin-top:8px">Pick a program</button>
        <button class="btn btn--ghost btn--block" data-log-activity style="margin-top:8px">Log a class / run / cardio</button>
      </div>`;
    root.onclick = async (e) => {
      if (e.target.closest('[data-go-programs]'))
        document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'programs' }));
      if (e.target.closest('[data-log-activity]')) return openActivitySheet();
      if (e.target.closest('[data-start-quick]')) {
        const btn = e.target.closest('[data-start-quick]');
        btn.disabled = true; btn.textContent = 'Starting…';
        try {
          const w = await API.startQuickWorkout();
          localStorage.setItem(LS.activeWorkoutId, String(w.id));
          localStorage.removeItem(LS.activeProgramDayId);
          renderWorkout();
        } catch (err) { toast(err.message); btn.disabled = false; btn.textContent = 'Quick workout'; }
      }
    };
    return;
  }

  root.innerHTML = skeletonBlocks(3);

  try {
    const workout = await API.workout(activeId);
    if (workout.finished_at) {
      localStorage.removeItem(LS.activeWorkoutId);
      localStorage.removeItem(LS.activeProgramDayId);
      return renderWorkout();
    }

    const programDayId =
      workout.program_day_id || Number(localStorage.getItem(LS.activeProgramDayId) || 0);

    const [days, last, settings, recentSessions] = await Promise.all([
      programDayId
        ? fetchDayDetails(programDayId)
        : Promise.resolve({ day_label: 'Quick Workout', exercises: [], id: null }),
      programDayId
        ? API.lastWorkout(programDayId).catch(() => null)
        : Promise.resolve(null),
      API.settings().catch(() => ({})),
      programDayId
        ? API.recentWorkouts(programDayId, 4).catch(() => [])
        : Promise.resolve([])
    ]);
    await syncUserBodyweight();

    const draft = loadDraft(workout.id);
    workoutState = {
      workout,
      programDay: days,
      last,
      // Most-recent first, excluding the current in-progress workout
      recentSessions: recentSessions.filter((w) => w.id !== workout.id),
      startedAt: workout.started_at,
      loggedSets: [...(workout.sets || [])],
      openExtras: new Set(),
      draft,
      preferredUnit: settings.preferred_unit || 'kg',
      showEquiv: settings.show_weight_equiv !== '0'
    };

    // Reconstruct any exercises that were added mid-workout (not in the program template).
    // workout.sets now includes exercise_name/muscle_group/flags from the JOIN.
    const templateExIds = new Set(workoutState.programDay.exercises.map((e) => e.exercise_id));
    const extraById = new Map();
    for (const s of workoutState.loggedSets) {
      if (!templateExIds.has(s.exercise_id) && !extraById.has(s.exercise_id)) {
        extraById.set(s.exercise_id, {
          id: null,
          exercise_id: s.exercise_id,
          name: s.exercise_name || `Exercise ${s.exercise_id}`,
          muscle_group: s.muscle_group || '',
          sub_muscle: s.sub_muscle ?? null,
          notes: null,
          is_bodyweight: !!s.is_bodyweight,
          is_assisted: !!s.is_assisted,
          equipment: s.equipment || null,
          weight_mode: s.weight_mode || 'per_arm',
          rep_min: s.rep_min ?? null,
          rep_max: s.rep_max ?? null,
          target_sets: Math.max(...workoutState.loggedSets.filter(x => x.exercise_id === s.exercise_id).map(x => x.set_number)),
          target_reps: s.reps,
          order_index: workoutState.programDay.exercises.length + extraById.size
        });
      }
    }
    for (const ex of extraById.values()) workoutState.programDay.exercises.push(ex);

    // Local draft first (freshest, survives offline edits); fall back to the
    // server-side snapshot when localStorage is gone (iOS storage eviction,
    // another device) so mid-workout swaps/adds don't silently revert.
    let savedList = draft.exerciseList;
    if (!savedList?.length && workout.exercise_list) {
      try { savedList = JSON.parse(workout.exercise_list); } catch { savedList = null; }
    }
    if (savedList?.length) {
      // The user modified this workout's exercises (swap/add/reorder), so the
      // saved list is authoritative for MEMBERSHIP and ORDER. Exercise-level
      // metadata (name, sub-muscle, weight mode, rep range…) is overlaid from
      // the fresh server data where we have it — a snapshot taken days ago
      // must not pin stale fields after the exercise itself was edited.
      const built = workoutState.programDay.exercises;
      const freshById = new Map(built.map((e) => [e.exercise_id, e]));
      const list = savedList.map((e) => {
        const fresh = freshById.get(e.exercise_id);
        if (!fresh) return e; // swapped/added with no logged sets — snapshot only
        return {
          ...e,
          name: fresh.name,
          muscle_group: fresh.muscle_group,
          sub_muscle: fresh.sub_muscle ?? null,
          is_bodyweight: !!fresh.is_bodyweight,
          is_assisted: !!fresh.is_assisted,
          equipment: fresh.equipment || e.equipment,
          weight_mode: fresh.weight_mode || 'per_arm',
          rep_min: fresh.rep_min ?? null,
          rep_max: fresh.rep_max ?? null
        };
      });
      const inList = new Set(list.map((e) => e.exercise_id));
      for (const ex of built) {
        if (!inList.has(ex.exercise_id) &&
            workoutState.loggedSets.some((s) => s.exercise_id === ex.exercise_id)) {
          list.push(ex);
          inList.add(ex.exercise_id);
        }
      }
      workoutState.programDay.exercises = list;
    } else if (draft.exerciseOrder?.length) {
      const order = draft.exerciseOrder;
      workoutState.programDay.exercises.sort((a, b) => {
        const ai = order.indexOf(a.exercise_id);
        const bi = order.indexOf(b.exercise_id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }

    // Per-exercise last performance, independent of program day, so quick
    // workouts and mid-workout-added exercises still get previous numbers,
    // prefill and progression hints. The program-day "last" session
    // (workoutState.last) still takes precedence when it has the exercise.
    workoutState.lastByExercise = {};
    try {
      const exIds = workoutState.programDay.exercises.map((e) => e.exercise_id);
      if (exIds.length) workoutState.lastByExercise = await API.lastByExercise(exIds);
    } catch { /* optional enhancement — fall back to no prefill */ }

    localStorage.setItem(LS.activeWorkoutStart, workout.started_at);

    renderWorkoutView();
    // Reopening mid-workout (app relaunch, tab switch back) used to always
    // show the exercise list from the top, so a long workout meant scrolling
    // past everything already done to find where you left off. Jump straight
    // to the first exercise that isn't finished yet — but only when there's
    // actually prior progress this session, so a freshly-started workout
    // doesn't get a pointless scroll.
    if (workoutState.loggedSets.length) {
      const nextCard = document.querySelector('#exercise-list .exercise-card:not(.exercise-card--complete)');
      nextCard?.scrollIntoView({ block: 'start' });
    }
    startStickyTimer();
    acquireWakeLock();
    const primeOnce = () => { primeAudio(); document.removeEventListener('click', primeOnce); };
    document.addEventListener('click', primeOnce);
  } catch (err) {
    // The stored active id can point at a workout the server no longer has —
    // the stale-workout sweep closes/deletes abandoned ones, but this device's
    // localStorage still remembers it. Clear the stale pointer and start over
    // (once), which falls through to /active recovery or the empty state.
    if (!retriedAfterMissing && /not found/i.test(err.message)) {
      localStorage.removeItem(LS.activeWorkoutId);
      localStorage.removeItem(LS.activeProgramDayId);
      localStorage.removeItem(LS.activeWorkoutStart);
      return renderWorkout(true);
    }
    root.innerHTML = `<div class="empty">Couldn't load workout: ${escapeHtml(err.message)}</div>`;
  }
}

async function fetchDayDetails(dayId) {
  return API.dayDetails(dayId);
}

function renderWorkoutView() {
  const root = $('#view-workout');
  const { programDay, last, workout, loggedSets } = workoutState;

  // This full rebuild runs on plenty of actions unrelated to whatever row the
  // user has open (adding a set on another exercise, skipping a different
  // one, ...) — without restoring it, the extras panel silently snaps shut
  // mid-edit even though the note/per-side text itself now survives via draft.
  const openExtrasKeys = new Set(
    [...root.querySelectorAll('.set-row.extras-open')].map((el) => `${el.dataset.ex}-${el.dataset.set}`)
  );

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
  for (const s of loggedSets) loggedByExerciseSet[`${s.exercise_id}-${s.set_number}`] = s;

  // Program-day "last" wins; otherwise fall back to this exercise's most recent
  // performance anywhere (covers quick workouts + mid-workout-added exercises).
  const lastByExercise = workoutState.lastByExercise || {};
  const bodyHTML = programDay.exercises
    .map((ex) => exerciseCardHTML(ex, lastSetsByExercise[ex.exercise_id] || lastByExercise[ex.exercise_id] || [], loggedByExerciseSet))
    .join('');

  root.innerHTML = `
    <div class="workout-top-sticky">
      <div class="workout-sticky">
        <div>
          <div class="workout-sticky__name">${escapeHtml(programDay.day_label)}</div>
        </div>
        <div class="workout-sticky__time" id="sticky-elapsed">0:00</div>
      </div>
      <div id="rest-sticky" class="rest-sticky hidden"></div>
      <div id="session-coverage"></div>
    </div>
    <div id="exercise-list">${bodyHTML}</div>
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

  if (openExtrasKeys.size) {
    for (const row of root.querySelectorAll('.set-row')) {
      if (openExtrasKeys.has(`${row.dataset.ex}-${row.dataset.set}`)) row.classList.add('extras-open');
    }
  }

  const exList = document.getElementById('exercise-list');
  if (exList) {
    enableDragReorder(exList, (newOrder) => {
      workoutState.programDay.exercises = newOrder
        .map((id) => workoutState.programDay.exercises.find((ex) => ex.exercise_id === Number(id)))
        .filter(Boolean);
      workoutState.draft.exerciseOrder = newOrder.map(Number);
      persistExerciseList();
    }, { rowSel: '.exercise-card', idKey: 'ex', draggingClass: 'exercise-card--dragging' });
  }

  renderSessionCoverage();
}

// Live "muscle groups already hit this workout" strip — same primary +
// major-secondary crediting rule as the 2x/week goal strip on Programs
// (routes/progress.js's /muscle-coverage, scoped here to just this
// workout_id instead of the weekly window), so the two never disagree
// about what counts as hitting a group. Fire-and-forget: called after every
// full re-render, plus directly after a new set is confirmed/deleted (the
// in-place DOM patches used there don't otherwise touch this strip).
async function renderSessionCoverage() {
  const el = document.getElementById('session-coverage');
  if (!el || !workoutState?.workout?.id) return;
  let rows;
  try { rows = await API.workoutMuscleCoverage(workoutState.workout.id); }
  catch { return; }
  const hit = new Set(rows.filter((r) => r.sessions > 0).map((r) => r.muscle_group));
  if (!hit.size) { el.innerHTML = ''; return; }
  el.innerHTML = `
    <div class="cov-strip">
      <div class="cov-strip__title">This workout</div>
      <div class="cov-strip__chips">
        ${PICKER_GROUP_ORDER.map((g) => `<span class="cov-chip mg-${g}${hit.has(g) ? ' cov-chip--done' : ' cov-chip--zero'}">${g}${hit.has(g) ? ' &#x2713;' : ''}</span>`).join('')}
      </div>
    </div>`;
}

// " · aim 8–12" when the exercise has a target rep range set (either bound
// may be missing — "8+" / "≤12"). Distinct from the day slot's single
// target_reps number shown before it.
function repRangeLabel(ex) {
  if (ex.rep_min && ex.rep_max) return ` · aim ${ex.rep_min}–${ex.rep_max}`;
  if (ex.rep_min) return ` · aim ${ex.rep_min}+`;
  if (ex.rep_max) return ` · aim ≤${ex.rep_max}`;
  return '';
}

function exerciseCardHTML(ex, lastSets, loggedBySet) {
  const target = getSetCount(ex);
  const prevReference = lastSets[0];
  const prefillWeight = prevReference?.weight ?? '';
  const prefillUnit = prevReference?.weight_unit || workoutState.preferredUnit || 'kg';
  const prefillReps = prevReference?.reps ?? ex.target_reps;

  const rec = recommendForNext(ex, lastSets);
  const drafts = workoutState?.draft?.inputs || {};

  // The most recent working set logged for THIS exercise in THIS session.
  // Unlogged sets prefill from it so they follow what you just did — and keep
  // following it across re-renders (the in-place cascade alone didn't survive
  // a re-render).
  const loggedThisEx = workoutState.loggedSets
    .filter((s) => s.exercise_id === ex.exercise_id && !s.is_warmup)
    .sort((a, b) => a.set_number - b.set_number);
  const lastLogged = loggedThisEx[loggedThisEx.length - 1];

  const isSkipped = !!(workoutState.draft.skipped?.[ex.exercise_id]);
  const rows = [];
  let firstUnloggedSet = null;
  for (let i = 1; i <= target; i++) {
    const key = `${ex.exercise_id}-${i}`;
    const logged = loggedBySet[key];
    // When the exercise was skipped, only show logged rows on re-render
    if (isSkipped && !logged) continue;
    const prevSet = lastSets.find((s) => s.set_number === i) || prevReference;
    const draft = drafts[key];
    // An in-progress, not-yet-saved correction to an ALREADY-logged set —
    // e.g. you notice a mistyped weight and start fixing it. Must win over
    // `logged.*` (the last server-saved value) or the correction silently
    // reverts the instant any unrelated full re-render happens before you
    // tap the checkmark to actually save it.
    const pendingEdit = logged ? (workoutState.draft.pendingEdits || {})[logged.id] : null;

    const w = pendingEdit?.w ?? logged?.weight ?? draft?.w ?? lastLogged?.weight ?? rec?.recWeight ?? prevSet?.weight ?? prefillWeight;
    const u = pendingEdit?.u ?? logged?.weight_unit ?? draft?.u ?? lastLogged?.weight_unit ?? rec?.recUnit ?? prevSet?.weight_unit ?? prefillUnit;
    const r = pendingEdit?.r ?? logged?.reps ?? draft?.r ?? lastLogged?.reps ?? prevSet?.reps ?? prefillReps;
    const rir = pendingEdit?.rir ?? logged?.rir ?? draft?.rir ?? null;
    // Unlogged note/per-side text has nowhere else to live — unlike w/u/r/rir
    // it has no fallback source (prevSet etc), so without this it silently
    // evaporates the moment any full re-render happens (adding a set on
    // another exercise, skipping a different one, ...) before the row is confirmed.
    const note = pendingEdit?.note ?? logged?.notes ?? draft?.note ?? '';
    const repsR = pendingEdit?.repsR ?? logged?.reps_r ?? draft?.repsR ?? '';
    const repsL = pendingEdit?.repsL ?? logged?.reps_l ?? draft?.repsL ?? '';

    if (!logged && firstUnloggedSet === null) firstUnloggedSet = i;
    rows.push(setRowHTML(ex, i, { w, u, r, rir, note, repsR, repsL, logged, isNext: !logged && firstUnloggedSet === i, prevRepsR: prevSet?.reps_r, prevRepsL: prevSet?.reps_l }));
  }

  const trend = pastTrendFor(ex);

  const hint = rec ? buildProgressionHint(rec, trend) : (lastSets.length ? '' : firstTimeHintHTML());

  // Complete when: explicitly skipped, OR all target sets are logged (no unlogged set found)
  const isComplete = isSkipped || (target > 0 && firstUnloggedSet === null);

  const skipLabel = isSkipped ? 'Skipped — tap to undo' : 'Done with this exercise';
  const cardClasses = `exercise-card${isComplete ? ' exercise-card--complete' : ''}${isSkipped ? ' exercise-card--skipped' : ''}`;

  const hasLoggedSets = workoutState.loggedSets.some((s) => s.exercise_id === ex.exercise_id);

  return `
    <div class="${cardClasses}" data-ex="${ex.exercise_id}">
      <div class="exercise-card__head">
        <button class="exercise-card__drag" data-drag-handle aria-label="Drag to reorder">&#x2630;</button>
        <div>
          <div class="exercise-card__name">
            ${escapeHtml(ex.name)}
            ${ex.is_assisted ? ' <span class="badge badge--assisted">ASSISTED</span>' : ex.is_bodyweight ? ' <span class="badge badge--bw">BW</span>' : ''}
          </div>
          <div class="card__subtitle">${target} × ${ex.target_reps}${repRangeLabel(ex)}${ex.is_assisted ? ' · enter assistance weight (more = easier)' : ex.is_bodyweight ? ' · enter added weight (0 if none)' : ''}${ex.notes ? ` · ${escapeHtml(ex.notes)}` : ''}</div>
        </div>
        <div class="exercise-card__head-actions">
          <button class="btn--icon-text" data-howto-ex="${ex.exercise_id}" title="How to do this exercise">?</button>
          <button class="btn--icon-text" data-swap-ex="${ex.exercise_id}" title="Swap exercise">&#x21C4; Swap</button>
          <button class="btn--icon-text" data-remove-ex="${ex.exercise_id}" title="Remove exercise" style="color:var(--danger)">&#x2715; Remove</button>
          <button class="badge badge--equipment" data-equip-ex="${ex.exercise_id}" title="Change equipment">${escapeHtml(ex.equipment || 'barbell')}</button>
          ${!ex.is_bodyweight ? `<button class="badge badge--weightmode ${ex.weight_mode === 'per_arm' ? '' : 'badge--weightmode-off'}" data-weightmode-ex="${ex.exercise_id}" title="What does the weight you enter mean? Tap to flip.">${ex.weight_mode === 'per_arm' ? 'per arm/side ×2' : 'total'}</button>` : ''}
          ${muscleTagHTML(ex.muscle_group, ex.sub_muscle)}
        </div>
      </div>
      ${hint}
      <div class="set-rows">
        ${rows.join('')}
      </div>
      <div class="set-count-controls" ${isSkipped ? 'style="display:none"' : ''}>
        <button class="set-count-btn" data-remove-set-row="${ex.exercise_id}" aria-label="Remove a set">−</button>
        <span class="set-count-controls__label">${target} ${target === 1 ? 'set' : 'sets'}</span>
        <button class="set-count-btn" data-add-set-row="${ex.exercise_id}" aria-label="Add a set">+</button>
        ${hasLoggedSets ? `<button class="undo-set-btn" data-undo-set="${ex.exercise_id}" title="Undo last set">&#x21A9; Undo</button>` : ''}
      </div>
      <button class="exercise-card__skip" data-skip-ex="${ex.exercise_id}" ${isComplete && !isSkipped ? 'style="display:none"' : ''}>${skipLabel}</button>
    </div>
  `;
}

// 'decline' when the most recent session's top load dropped from the one
// before it; 'plateau' when the last two sessions sat at the exact same
// load; 'up' when the last two POINT-TO-POINT gaps were both increases (2
// consecutive increases — a single bump isn't a streak yet). null otherwise,
// including when there's too little history (<2 sessions) to say either way.
// Same function drives both the live pre-log hint (trend = past sessions
// only) and the post-workout summary (trend = past sessions + today).
function classifyTrend(trend, rec) {
  if (trend.length < 2) return null;
  const ctx = { is_bodyweight: rec.isBodyweight, is_assisted: rec.isAssisted };
  const last = loadKg(trend[trend.length - 1], ctx);
  const prev = loadKg(trend[trend.length - 2], ctx);
  // Tolerance, not exact equality — a kg/lbs unit conversion (see bestWeight
  // in recommendForNext) can leave two "identical" weights a hair apart in
  // floating point, which would otherwise misread a plateau as a decline.
  const EPS = 0.05;
  if (last < prev - EPS) return 'decline';
  if (Math.abs(last - prev) <= EPS) return 'plateau';
  if (trend.length >= 3) {
    const prevPrev = loadKg(trend[trend.length - 3], ctx);
    if (prev > prevPrev + EPS) return 'up';
  }
  return null;
}

// Tappable status badge for a classifyTrend() result — a button carrying its
// own detail message in data attributes (opened via showBadgeDetail on tap,
// wired in wireWorkoutView). `trend` is oldest→newest past sessions.
function trendBadgeHTML(status, trend, rec) {
  if (!status) return '';
  const label = (s) => `${fmtSetWeight(s.weight, s.weight_unit, !!rec.isBodyweight, !!rec.isAssisted)} on ${formatDateShort(s.logged_at)}`;
  if (status === 'decline') {
    const [prior, cur] = trend.slice(-2);
    const msg = prior && cur ? `Dropped from ${label(prior)} to ${fmtSetWeight(cur.weight, cur.weight_unit, !!rec.isBodyweight, !!rec.isAssisted)}.` : 'Dropped from the previous session.';
    return `<button class="prog-hint__badge prog-hint__badge--decline" data-badge-title="Decline" data-badge-msg="${escapeHtml(msg)}">&#x2198; Decline</button>`;
  }
  if (status === 'plateau') {
    const [prior] = trend.slice(-2);
    const msg = prior ? `Same weight as your last session — ${label(prior)}.` : 'Same weight as your last session.';
    return `<button class="prog-hint__badge prog-hint__badge--plateau" data-badge-title="Plateau" data-badge-msg="${escapeHtml(msg)}">&#x23F8; Plateau</button>`;
  }
  if (status === 'up') {
    const points = trend.slice(-3);
    const msg = points.length ? `Trending up: ${points.map(label).join(' → ')}.` : 'Two sessions in a row of weight increases.';
    return `<button class="prog-hint__badge prog-hint__badge--up" data-badge-title="Going up" data-badge-msg="${escapeHtml(msg)}">&#x2B06; Going up</button>`;
  }
  return '';
}

function buildProgressionHint(rec, trend = []) {
  const upArrow = rec.isAssisted ? '&#x2B07;' : '&#x2B06;';
  const upLabel = rec.isAssisted ? 'Reduce assistance' : 'Increase weight';
  const sameLabel = rec.isAssisted ? 'Same assistance' : 'Same weight';
  const trendStatus = classifyTrend(trend, rec);

  // Trend line: oldest → newest top weight with direction indicator
  let trendLine = '';
  if (trend.length >= 2) {
    const labels = trend.map((s) => fmtSetWeight(s.weight, s.weight_unit, !!rec.isBodyweight, !!rec.isAssisted));
    const firstKg = loadKg(trend[0], { is_bodyweight: rec.isBodyweight, is_assisted: rec.isAssisted });
    const lastKg  = loadKg(trend[trend.length - 1], { is_bodyweight: rec.isBodyweight, is_assisted: rec.isAssisted });
    const arrow = lastKg > firstKg ? '&#x2197;' : lastKg < firstKg ? '&#x2198;' : '&#x2192;';
    trendLine = `<div class="prog-hint__trend">${labels.join(' &rarr; ')} ${arrow}</div>`;
  }

  if (rec.isStale) {
    return `
      <div class="prog-hint prog-hint--stale">
        <div class="prog-hint__main">&#x1F551; Been ${rec.gapDays} days &mdash; easing back in at <strong>${rec.recDisplay}</strong></div>
        <div class="prog-hint__sub">Last: ${rec.setsLabel} @ ${rec.lastWeight} &times; ${rec.repsList} &mdash; same weight until you're back up to speed</div>
        ${trendLine}
      </div>`;
  }

  if (rec.isProgression) {
    return `
      <div class="prog-hint prog-hint--up">
        <div class="prog-hint__main">${upArrow} ${upLabel} &rarr; <strong>${rec.recDisplay} &times; ${rec.recReps}</strong> ${trendBadgeHTML(trendStatus, trend, rec)}</div>
        <div class="prog-hint__sub">Last: ${rec.setsLabel} @ ${rec.lastWeight} &times; ${rec.repsList} &mdash; all hit ${rec.hitReps}+ &#x2713;</div>
        ${trendLine}
      </div>`;
  } else if (rec.isFormHeld) {
    return `
      <div class="prog-hint prog-hint--form">
        <div class="prog-hint__main">&#x26A0; Hit ${rec.hitReps}+, but form was flagged &mdash; repeating <strong>${rec.lastWeight}</strong></div>
        <div class="prog-hint__sub">Last: ${rec.setsLabel} @ ${rec.lastWeight} &times; ${rec.repsList} &mdash; clean it up before adding weight</div>
        ${trendLine}
      </div>`;
  } else {
    const gap = rec.recReps - rec.minReps;
    const gapStr = gap > 0 ? ` (${gap} rep${gap > 1 ? 's' : ''} short)` : '';
    const nextStep = rec.isAssisted ? 'reduce assistance' : 'add weight';
    return `
      <div class="prog-hint prog-hint--same">
        <div class="prog-hint__main">&#x1F3AF; ${sameLabel} &mdash; aim for <strong>${rec.recReps} reps</strong> every set ${trendBadgeHTML(trendStatus, trend, rec)}</div>
        <div class="prog-hint__sub">Last: ${rec.setsLabel} @ ${rec.lastWeight} &times; ${rec.repsList}${gapStr} &mdash; hit ${rec.recReps} to ${nextStep}</div>
        ${trendLine}
      </div>`;
  }
}

// "First time" note shown in place of the progression hint when there's no
// history at all for this exercise (recommendForNext returned null because
// lastSets was empty) — nothing to recommend yet, but worth a friendly flag.
function firstTimeHintHTML() {
  return `
    <div class="prog-hint prog-hint--first">
      <div class="prog-hint__main">&#x1F195; <button class="prog-hint__badge prog-hint__badge--first" data-badge-title="First time" data-badge-msg="No previous sessions logged for this exercise yet — this is the first one on record.">First time</button></div>
    </div>`;
}

// Last 3 finished sessions' top set for this exercise, oldest → newest.
// Shared by the live progression hint and the post-workout summary (the
// latter appends today's own best set on top, via classifyTrend below).
function pastTrendFor(ex) {
  const sessions = (workoutState?.recentSessions || []).slice(0, 3);
  return sessions.map((session) => {
    const exSets = (session.sets || []).filter((s) => s.exercise_id === ex.exercise_id && !s.is_warmup);
    if (!exSets.length) return null;
    return exSets.reduce((best, s) => loadKg(s, ex) >= loadKg(best, ex) ? s : best, exSets[0]);
  }).filter(Boolean).reverse();
}

// Which unit you've actually logged most for this exercise across the last
// session plus your last few finished workouts (workoutState.recentSessions).
// Returns null when there isn't enough history (<2 sets) or it's genuinely
// split close to 50/50 — in both cases the caller falls back to trusting
// whichever set it already picked, same as before this existed.
function majorityUnitFor(exerciseId, lastSets) {
  const counts = { kg: 0, lbs: 0 };
  for (const s of lastSets) counts[s.weight_unit === 'lbs' ? 'lbs' : 'kg']++;
  for (const session of workoutState?.recentSessions || []) {
    for (const s of session.sets || []) {
      if (s.exercise_id === exerciseId && !s.is_warmup) counts[s.weight_unit === 'lbs' ? 'lbs' : 'kg']++;
    }
  }
  const total = counts.kg + counts.lbs;
  if (total < 2) return null;
  if (counts.kg >= counts.lbs * 2) return 'kg';
  if (counts.lbs >= counts.kg * 2) return 'lbs';
  return null;
}

function recommendForNext(ex, lastSets) {
  if (!lastSets.length) return null;
  // Double progression is keyed on the exercise's rep RANGE, not the slot's
  // single target: top the range on every set → add weight and drop back to
  // the bottom. Unset ranges default to 6–8, except when the day slot aims
  // higher (a deliberate 2×12 slot shouldn't trigger "add weight" at 8).
  const repMax = ex.rep_max ?? Math.max(REP_GOAL_DEFAULT_MAX, Number(ex.target_reps) || 0);
  const repMin = Math.min(ex.rep_min ?? REP_GOAL_DEFAULT_MIN, repMax);
  const targetReps = repMax;

  let bestKg = 0, bestSet = null;
  for (const s of lastSets) {
    const kg = loadKg(s, ex);
    if (kg > bestKg) { bestKg = kg; bestSet = s; }
  }
  if (!bestSet) return null;

  const workingSets = lastSets.filter(
    (s) => s.weight === bestSet.weight && s.weight_unit === bestSet.weight_unit
  );
  // A set flagged "form broke down" still counts as done, but not as a hit —
  // it shouldn't be able to push you into progressing the weight next time.
  const allHit = workingSets.every((s) => s.reps >= targetReps && !s.form_flag);
  // Distinguish "you actually missed the reps" from "you hit them, but form
  // broke down" — every set that kept you from allHit did so ONLY via the
  // form flag (its reps were fine on their own). Drives a distinct hint
  // instead of lumping this in with a genuine miss or a plateau.
  const missedSets = workingSets.filter((s) => !(s.reps >= targetReps && !s.form_flag));
  const isFormHeld = missedSets.length > 0 && missedSets.every((s) => s.form_flag && s.reps >= targetReps);

  // Long layoff (3+ weeks since this exercise's last session): don't trust
  // last time's numbers enough to push a weight increase — ease back in at
  // the same weight regardless of whether that session hit its reps.
  const gapDays = Math.max(...lastSets.map((s) => daysAgo(s.logged_at) ?? 0));
  const isStale = gapDays >= 21;

  // Which unit you've actually been using for this exercise lately — a
  // single stray unit-toggle tap on one set shouldn't get "remembered" as
  // the new normal forever. Only overrides bestSet's own unit when recent
  // history shows a clear (2:1+) majority for the OTHER unit; otherwise
  // falls back to bestSet's unit, same as before this existed.
  const majority = majorityUnitFor(ex.exercise_id, lastSets);
  const unit = majority || bestSet.weight_unit;
  const bestWeight = unit === bestSet.weight_unit
    ? bestSet.weight
    : +fromKg(toKg(bestSet.weight, bestSet.weight_unit), unit).toFixed(2);
  const step = stepForExercise(unit, ex);
  const isBw = !!ex.is_bodyweight;
  const isAssisted = !!ex.is_assisted;

  let recWeight, isProgression;
  if (allHit && !isStale) {
    if (isAssisted) {
      recWeight = Math.max(0, +(bestWeight - step).toFixed(2));
    } else {
      recWeight = +(bestWeight + step).toFixed(2);
    }
    isProgression = true;
  } else {
    recWeight = bestWeight;
    isProgression = false;
  }

  const repsList = workingSets.map((s) => s.reps).join(', ');
  const setsLabel = workingSets.length === 1 ? '1 set' : `${workingSets.length} sets`;
  const minReps = Math.min(...workingSets.map((s) => s.reps));

  return {
    // After a weight bump, aim resets to the BOTTOM of the range (double
    // progression); otherwise keep chasing the top. hitReps is what the last
    // session's sets were measured against, for the hint's "all hit N+" line.
    recWeight, recUnit: unit, recReps: (allHit && !isStale) ? repMin : targetReps, hitReps: targetReps,
    isProgression, isBodyweight: isBw, isAssisted, isStale, gapDays, isFormHeld,
    lastWeight: fmtSetWeight(bestWeight, unit, isBw, isAssisted),
    recDisplay: isAssisted
      ? (recWeight === 0 ? 'BW (no assistance)' : `${recWeight}${unit} assistance`)
      : isBw
        ? (recWeight === 0 ? 'BW' : `BW+${recWeight}${unit}`)
        : `${recWeight}${unit}`,
    setsLabel, repsList, minReps
  };
}

function setRowHTML(ex, setNumber, { w, u, r, rir, note, repsR: repsRVal, repsL: repsLVal, logged, isNext, prevRepsR, prevRepsL }) {
  const isBw = !!ex.is_bodyweight;
  const isAssisted = !!ex.is_assisted;
  const showAsEmpty = (isBw || isAssisted) && (w === 0 || w === '' || w == null);
  const wStr = showAsEmpty ? '' : (w === '' ? '' : Number(w));
  const wPlaceholder = isAssisted ? '0 = unassisted' : isBw ? 'BW' : '0';
  // rir/note are already fully resolved by the caller (pendingEdit > logged
  // > draft), so this row always reflects any in-progress unsaved correction
  // rather than the stale server-saved value.
  const effRir = rir ?? '';
  // RIR scale 0–4: 0 = to failure, 1 = 1 left, …, 4 = 4+ left
  const rirButtons = [0, 1, 2, 3, 4]
    .map((n) => `<button class="rpe-btn ${Number(effRir) === n && effRir !== '' ? 'rpe-btn--active' : ''}" data-rir="${n}">${n}</button>`)
    .join('');
  const isWarmup = !!(logged?.is_warmup);
  // e1RM badge on logged working sets (not warmups, reps must be > 0)
  let e1rmBadge = '';
  if (logged && !isWarmup && logged.reps > 0) {
    const load = loadKg({ weight: logged.weight, weight_unit: logged.weight_unit }, ex);
    if (load > 0) e1rmBadge = `<span class="set-row__hint">~${Math.round(e1RM(load, logged.reps))} kg 1RM</span>`;
  }
  const perArmBadge = (logged?.reps_r != null && logged?.reps_l != null && logged.reps_r !== logged.reps_l)
    ? `<span class="set-row__hint">${fmtReps(logged.reps, logged.reps_r, logged.reps_l)}</span>`
    : '';
  // is_new_pr only exists on the object returned by the POST that just
  // logged this set (see confirmSet) — it isn't a stored column, so it
  // won't survive a full refetch/resume. Same ephemeral scope as the PR
  // flash animation it accompanies; History is the durable record of PRs.
  const prBadge = logged?.is_new_pr
    ? `<button class="set-row__pr" data-badge-title="New PR" data-badge-msg="New personal record: ${escapeHtml(fmtSetWeight(logged.weight, logged.weight_unit, isBw, isAssisted))} × ${logged.reps} reps.">&#x1F3C6;</button>`
    : '';
  // e1RM estimate, per-side reps, new-PR flag share one line at the bottom
  // of the row (previously two of them were absolutely positioned and could
  // visually overlap on a narrow phone screen). The weight-equivalent
  // (kg/lbs) text is kept separate, directly under the weight number itself
  // — it reads as a conversion of THAT number, not a general session stat,
  // so it should sit next to what it's converting rather than down with the
  // other hints. data-eq stays in the DOM unconditionally: updateRowEquiv()
  // needs it to live-update as weight/unit change, even before there's
  // anything to show.
  const hintsHTML = `<div class="set-row__hints">${e1rmBadge}${perArmBadge}${prBadge}</div>`;
  // Optional per-side rep breakdown (right/left) for dumbbell-type per-arm
  // exercises, e.g. right hand got 9, left got 7 — the main reps field above
  // stays the single "official" number (the weaker side); this is opt-in
  // detail entered/edited via the extras panel, same place as the note.
  const isPerArm = ex.weight_mode === 'per_arm' && !isBw;
  const repsR = repsRVal ?? '';
  const repsL = repsLVal ?? '';
  // Ghost the last session's per-side split into the placeholder (not the
  // value) so it's visible as a reference without silently carrying last
  // time's asymmetry into a set the user hasn't entered yet.
  const repsRPlaceholder = !logged && prevRepsR != null && prevRepsL != null && prevRepsR !== prevRepsL ? String(prevRepsR) : '—';
  const repsLPlaceholder = !logged && prevRepsR != null && prevRepsL != null && prevRepsR !== prevRepsL ? String(prevRepsL) : '—';
  return `
    <div class="set-row ${logged ? 'done' : ''} ${isNext ? 'set-row--next' : ''} ${isWarmup ? 'warmup' : ''}" data-ex="${ex.exercise_id}" data-set="${setNumber}" data-rir="${effRir}" data-warmup="${isWarmup ? 1 : 0}" data-pristine="1" ${logged ? `data-set-id="${logged.id}"` : ''}>
      <button class="set-row__num" data-toggle-warmup title="Tap to mark as warmup">${isWarmup ? 'W' : setNumber}</button>
      <div class="num-input" data-field="weight">
        <button class="num-input__btn" data-step="-1">−</button>
        <input class="num-input__field" type="text" inputmode="decimal" pattern="[0-9]*\\.?[0-9]*" value="${wStr}" placeholder="${wPlaceholder}" aria-label="weight"/>
        <button class="num-input__btn" data-step="1">+</button>
      </div>
      <span class="set-row__weight-eq" data-eq>${weightHintText(w, u, ex)}</span>
      <button class="unit-toggle ${u === 'kg' ? 'kg' : 'lbs'}" data-unit>${u}</button>
      <div class="num-input" data-field="reps">
        <button class="num-input__btn" data-step="-1">−</button>
        <input class="num-input__field" type="text" inputmode="numeric" pattern="[0-9]*" value="${r ?? ''}" aria-label="reps"/>
        <button class="num-input__btn" data-step="1">+</button>
      </div>
      <button class="set-check" data-confirm>&#x2713;</button>
      <div class="set-row__rir" data-rir-group>
        <span class="rpe-group__label" title="Reps in reserve — how many more you could have done">RIR</span>
        ${rirButtons}
        <button class="rpe-btn rpe-btn--clear" data-rir-clear ${effRir !== '' && effRir != null ? '' : 'style="visibility:hidden"'}>×</button>
        <button class="set-row__note-toggle" data-toggle-note title="Add a note">&#x270E;</button>
        ${logged && !isWarmup ? `<button class="set-row__form-flag${logged.form_flag ? ' set-row__form-flag--on' : ''}" data-toggle-form title="Form broke down on this set — won't count toward progressing next time">&#x26A0;&#xFE0F;</button>` : ''}
        <button data-rest class="rest-timer">rest</button>
      </div>
      ${hintsHTML}
      <div class="set-row__extras">
        <input class="set-row__note" data-note placeholder="Form cue, tempo, etc." value="${escapeHtml(note)}"/>
        ${isPerArm ? `
        <div class="set-row__perarm">
          <span class="set-row__perarm-label">Reps differ per side?</span>
          <label>L <input class="set-row__perarm-input" type="text" inputmode="numeric" pattern="[0-9]*" data-reps-l value="${repsL}" placeholder="${repsLPlaceholder}"/></label>
          <label>R <input class="set-row__perarm-input" type="text" inputmode="numeric" pattern="[0-9]*" data-reps-r value="${repsR}" placeholder="${repsRPlaceholder}"/></label>
        </div>` : ''}
      </div>
      ${logged ? '<div class="set-row__delete" data-delete>Delete</div>' : ''}
    </div>
  `;
}

// Rebuilds a logged row's hints (e1RM/per-arm/PR badges) and form-flag
// button from scratch, matching exactly what setRowHTML would render for
// the same state. Needed because toggling warmup on an already-logged row
// flips is_warmup without a full re-render, and setRowHTML gates both the
// e1RM badge and the form-flag button on !isWarmup.
function reconcileSetRowBadges(row, logged) {
  const exId = Number(row.dataset.ex);
  const ex = workoutState?.programDay?.exercises?.find((x) => x.exercise_id === exId);
  const isBw = !!ex?.is_bodyweight;
  const isAssisted = !!ex?.is_assisted;
  const isWarmup = !!logged.is_warmup;

  let e1rmBadge = '';
  if (!isWarmup && logged.reps > 0) {
    const load = loadKg({ weight: logged.weight, weight_unit: logged.weight_unit }, ex);
    if (load > 0) e1rmBadge = `<span class="set-row__hint">~${Math.round(e1RM(load, logged.reps))} kg 1RM</span>`;
  }
  const perArmBadge = (logged.reps_r != null && logged.reps_l != null && logged.reps_r !== logged.reps_l)
    ? `<span class="set-row__hint">${fmtReps(logged.reps, logged.reps_r, logged.reps_l)}</span>`
    : '';
  const prBadge = logged.is_new_pr
    ? `<button class="set-row__pr" data-badge-title="New PR" data-badge-msg="New personal record: ${escapeHtml(fmtSetWeight(logged.weight, logged.weight_unit, isBw, isAssisted))} × ${logged.reps} reps.">&#x1F3C6;</button>`
    : '';
  const hints = row.querySelector('.set-row__hints');
  if (hints) hints.innerHTML = e1rmBadge + perArmBadge + prBadge;

  const existingFormBtn = row.querySelector('[data-toggle-form]');
  if (!isWarmup && !existingFormBtn) {
    const formBtn = document.createElement('button');
    formBtn.className = `set-row__form-flag${logged.form_flag ? ' set-row__form-flag--on' : ''}`;
    formBtn.dataset.toggleForm = '1';
    formBtn.title = "Form broke down on this set — won't count toward progressing next time";
    formBtn.textContent = '⚠️';
    row.querySelector('[data-rest]')?.insertAdjacentElement('beforebegin', formBtn);
  } else if (isWarmup && existingFormBtn) {
    existingFormBtn.remove();
  }
}

function wireWorkoutView() {
  const root = $('#view-workout');
  root.onclick = async (e) => {
    const badgeBtn = e.target.closest('[data-badge-title]');
    if (badgeBtn) { showBadgeDetail(badgeBtn.dataset.badgeTitle, badgeBtn.dataset.badgeMsg); return; }

    if (e.target.closest('[data-finish-workout]')) return finishWorkout();
    if (e.target.closest('[data-cancel-workout]')) return cancelWorkout();
    if (e.target.closest('[data-rest-cancel]')) return cancelRestCountdown();

    const undoBtn = e.target.closest('[data-undo-set]');
    if (undoBtn) { haptic(20); return undoLastSet(Number(undoBtn.dataset.undoSet)); }

    // Card-level controls — must be checked before the set-row guard below
    const howtoBtn = e.target.closest('[data-howto-ex]');
    if (howtoBtn) { haptic(10); openHowToSheet(Number(howtoBtn.dataset.howtoEx)); return; }

    const swapBtn = e.target.closest('[data-swap-ex]');
    if (swapBtn) { haptic(15); openSwapPicker(Number(swapBtn.dataset.swapEx)); return; }

    const removeExBtn = e.target.closest('[data-remove-ex]');
    if (removeExBtn) { haptic(15); removeExerciseFromWorkout(Number(removeExBtn.dataset.removeEx)); return; }

    const equipBtn = e.target.closest('[data-equip-ex]');
    if (equipBtn) { haptic(15); openEquipmentPicker(Number(equipBtn.dataset.equipEx)); return; }

    // Dumbbell "per arm ×2" / "both = total" badge — tap to flip how the
    // entered weight is interpreted (persisted on the exercise itself).
    const wmBtn = e.target.closest('[data-weightmode-ex]');
    if (wmBtn) {
      haptic(15);
      const exId = Number(wmBtn.dataset.weightmodeEx);
      const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exId);
      if (!ex) return;
      const next = ex.weight_mode === 'combined' ? 'per_arm' : 'combined';
      API.updateExercise(exId, { weight_mode: next }).then(() => {
        ex.weight_mode = next;
        persistExerciseList();
        renderWorkoutView();
        toast(next === 'combined'
          ? 'Weight = the full load (counted as-is)'
          : 'Weight = one arm/side (doubled for volume)');
      }).catch((err) => toast(err.message));
      return;
    }

    const skipBtn = e.target.closest('[data-skip-ex]');
    if (skipBtn) {
      haptic(15);
      const exId = Number(skipBtn.dataset.skipEx);
      if (workoutState.draft.skipped?.[exId]) {
        delete workoutState.draft.skipped[exId];
        saveDraft(workoutState.workout.id, workoutState.draft);
        renderWorkoutView();
      } else {
        skipRemainingForExercise(exId);
      }
      return;
    }

    if (e.target.closest('[data-add-workout-ex]')) { haptic(15); openWorkoutAddExercisePicker(); return; }

    const addRow = e.target.closest('[data-add-set-row]');
    if (addRow) {
      haptic(10);
      const exId = Number(addRow.dataset.addSetRow);
      const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exId);
      if (!ex) return;
      workoutState.draft.setCounts[exId] = getSetCount(ex) + 1;
      saveDraft(workoutState.workout.id, workoutState.draft);
      renderWorkoutView();
      return;
    }
    const removeRow = e.target.closest('[data-remove-set-row]');
    if (removeRow) {
      const exId = Number(removeRow.dataset.removeSetRow);
      const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exId);
      if (!ex) return;
      const current = getSetCount(ex);
      const loggedMax = Math.max(0, ...workoutState.loggedSets.filter((s) => s.exercise_id === exId).map((s) => s.set_number));
      if (current <= loggedMax) { toast('Delete a logged set first'); return; }
      if (current <= 1) return;
      haptic(10);
      workoutState.draft.setCounts[exId] = current - 1;
      delete workoutState.draft.inputs[`${exId}-${current}`];
      saveDraft(workoutState.workout.id, workoutState.draft);
      renderWorkoutView();
      return;
    }

    const row = e.target.closest('.set-row');
    if (!row) return;
    // A just-logged row's checkmark doubles as an immediate "undo" (see the
    // data-confirm handler below) — but ONLY for the very next tap, and only
    // if nothing else about the set has been touched since. Any other
    // interaction with the row means the tap is a deliberate edit, not a
    // slip, so the checkmark reverts to its normal "save" behavior.
    if (!e.target.closest('[data-confirm]')) delete row.dataset.justConfirmed;

    const warmupBtn = e.target.closest('[data-toggle-warmup]');
    if (warmupBtn) {
      const nowWarmup = row.dataset.warmup !== '1';
      row.dataset.warmup = nowWarmup ? '1' : '0';
      row.classList.toggle('warmup', nowWarmup);
      warmupBtn.textContent = nowWarmup ? 'W' : row.dataset.set;
      haptic(10);
      if (row.dataset.setId) {
        const setId = Number(row.dataset.setId);
        API.updateSet(setId, { is_warmup: nowWarmup ? 1 : 0 }).catch(() => {});
        const logged = workoutState.loggedSets.find((s) => s.id === setId);
        if (logged) {
          logged.is_warmup = nowWarmup ? 1 : 0;
          reconcileSetRowBadges(row, logged);
        }
      }
      return;
    }

    const formFlagBtn = e.target.closest('[data-toggle-form]');
    if (formFlagBtn) {
      const nowFlagged = !formFlagBtn.classList.contains('set-row__form-flag--on');
      formFlagBtn.classList.toggle('set-row__form-flag--on', nowFlagged);
      haptic(10);
      const setId = row.dataset.setId ? Number(row.dataset.setId) : null;
      if (setId) {
        // Keep in-memory state consistent — the finish-workout summary reads
        // workoutState.loggedSets directly, not the DOM, to compute "ready to
        // go up" for today's sets.
        const s = workoutState.loggedSets.find((x) => x.id === setId);
        if (s) s.form_flag = nowFlagged ? 1 : 0;
        API.updateSet(setId, { form_flag: nowFlagged ? 1 : 0 }).catch(() => {});
      }
      return;
    }

    const unitBtn = e.target.closest('[data-unit]');
    if (unitBtn) {
      const cur = unitBtn.textContent.trim();
      const next = cur === 'kg' ? 'lbs' : 'kg';
      unitBtn.textContent = next;
      unitBtn.classList.toggle('kg', next === 'kg');
      markRowTouched(row);
      updateRowEquiv(row);
      return;
    }

    const stepBtn = e.target.closest('.num-input__btn');
    if (stepBtn) { fireStep(stepBtn, row); updateRowEquiv(row); return; }

    const confirm = e.target.closest('[data-confirm]');
    if (confirm) return row.dataset.justConfirmed === '1' ? deleteLoggedSet(row) : confirmSet(row);

    const noteToggle = e.target.closest('[data-toggle-note]');
    if (noteToggle) {
      row.classList.toggle('extras-open');
      const noteInput = row.querySelector('[data-note]');
      if (row.classList.contains('extras-open')) noteInput.focus();
      return;
    }

    const rirBtn = e.target.closest('[data-rir]');
    if (rirBtn) {
      const val = Number(rirBtn.dataset.rir);
      row.dataset.rir = String(val);
      row.querySelectorAll('[data-rir]').forEach((b) =>
        b.classList.toggle('rpe-btn--active', Number(b.dataset.rir) === val)
      );
      const clearBtn = row.querySelector('[data-rir-clear]');
      if (clearBtn) clearBtn.style.visibility = 'visible';
      haptic(10);
      if (row.dataset.setId) persistRirChange(row);
      else markRowTouched(row);
      return;
    }

    if (e.target.closest('[data-rir-clear]')) {
      row.dataset.rir = '';
      row.querySelectorAll('[data-rir]').forEach((b) => b.classList.remove('rpe-btn--active'));
      e.target.closest('[data-rir-clear]').style.visibility = 'hidden';
      if (row.dataset.setId) persistRirChange(row);
      else markRowTouched(row);
      return;
    }

    const restBtn = e.target.closest('[data-rest]');
    if (restBtn) return toggleRestTimer();

    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) return deleteLoggedSet(row);
  };

  root.oninput = (e) => {
    const input = e.target.closest('.num-input__field');
    if (input) {
      const row = input.closest('.set-row');
      delete row.dataset.justConfirmed;
      markRowTouched(row);
      updateRowEquiv(row);
      return;
    }
    const extrasInput = e.target.closest('[data-note], [data-reps-r], [data-reps-l]');
    if (extrasInput) markRowExtrasTouched(extrasInput.closest('.set-row'));
  };

  root.onfocusin = (e) => {
    const input = e.target.closest('.num-input__field');
    if (!input) return;
    const row = input.closest('.set-row');
    if (!row || !row.classList.contains('done')) return;
    row.classList.add('editing');
  };
  root.onfocusout = (e) => {
    const input = e.target.closest('.num-input__field');
    if (!input) return;
    const row = input.closest('.set-row');
    if (!row) return;
    setTimeout(() => row.classList.remove('editing'), 200);
  };

  const notesEl = root.querySelector('[data-workout-notes]');
  if (notesEl) {
    notesEl.onblur = async () => {
      const value = notesEl.value.trim() || null;
      const current = workoutState.workout.notes || null;
      if (value === current) return;
      try {
        await API.updateWorkout(workoutState.workout.id, { notes: value });
        workoutState.workout.notes = value;
      } catch (err) { toast(err.message); }
    };
  }

  let touchStartX = null, currentRow = null;
  root.ontouchstart = (e) => {
    const row = e.target.closest('.set-row');
    if (!row || !row.dataset.setId) return;
    touchStartX = e.touches[0].clientX; currentRow = row;
  };
  root.ontouchmove = (e) => {
    if (!currentRow || touchStartX === null) return;
    const dx = e.touches[0].clientX - touchStartX;
    if (dx < -60) currentRow.classList.add('swiped');
    else if (dx > 10) currentRow.classList.remove('swiped');
  };
  root.ontouchend = () => { touchStartX = null; currentRow = null; };

  // wireWorkoutView() re-runs on every render (add/remove set, swap, equip
  // change, etc.) against the SAME persistent #view-workout node — only its
  // innerHTML is replaced. attachHoldRepeat uses addEventListener, which
  // isn't idempotent like the .onclick/.oninput assignments above, so it
  // must only ever be wired once or stepper holds fire once per accumulated
  // listener.
  if (!root.dataset.holdWired) {
    root.dataset.holdWired = '1';
    attachHoldRepeat(root);
  }
}

function fireStep(btn, rowCtx) {
  const wrap = btn.closest('.num-input');
  if (!wrap) return;
  const input = wrap.querySelector('.num-input__field');
  const field = wrap.dataset.field;
  let v = parseFloat(input.value || '0');
  if (Number.isNaN(v)) v = 0;
  const row = rowCtx || btn.closest('.set-row');
  const unit = row?.querySelector('[data-unit]')?.textContent?.trim() || 'kg';
  const exId = row ? Number(row.dataset.ex) : null;
  const ex = workoutState?.programDay?.exercises?.find((e) => e.exercise_id === exId);
  const step = Number(btn.dataset.step) * (field === 'weight' ? stepForExercise(unit, ex) : 1);
  let next = v + step;
  if (next < 0) next = 0;
  input.value = field === 'weight' ? String(+next.toFixed(2)) : String(Math.floor(next));
  haptic(8);
  markRowTouched(row);
}

function attachHoldRepeat(container) {
  let holdTimer = null, repeatTimer = null, activeBtn = null;
  const stop = () => { clearTimeout(holdTimer); clearTimeout(repeatTimer); holdTimer = null; repeatTimer = null; activeBtn = null; };
  container.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.num-input__btn');
    if (!btn) return;
    activeBtn = btn;
    // Wait before auto-repeat so a normal tap never triggers it. Then ramp:
    // start slow (~3.5/s) and accelerate to a floor (~9/s). A self-scheduling
    // timeout is used because setInterval can't change its own period mid-run.
    holdTimer = setTimeout(() => {
      let delay = 280;
      const tick = () => {
        if (!activeBtn) return stop();
        fireStep(activeBtn, activeBtn.closest('.set-row'));
        delay = Math.max(110, delay - 18);
        repeatTimer = setTimeout(tick, delay);
      };
      tick();
    }, 450);
  });
  container.addEventListener('pointerup', stop);
  container.addEventListener('pointercancel', stop);
  container.addEventListener('pointermove', (e) => {
    if (!activeBtn) return;
    const over = document.elementFromPoint(e.clientX, e.clientY);
    if (!over || (!activeBtn.contains(over) && over !== activeBtn)) stop();
  });
}

async function confirmSet(row) {
  if (workoutEnding || !workoutState) return;
  const checkBtn = row.querySelector('[data-confirm]');
  if (checkBtn?.disabled) return;
  primeAudio();

  const exId = Number(row.dataset.ex);
  const setNumber = Number(row.dataset.set);
  const unit = row.querySelector('[data-unit]').textContent.trim();
  const weight = parseFloat(row.querySelector('[data-field="weight"] .num-input__field').value || '0');
  const repsInput = parseInt(row.querySelector('[data-field="reps"] .num-input__field').value || '0', 10);
  const note = row.querySelector('[data-note]')?.value?.trim() || null;
  const rirRaw = row.dataset.rir;
  const rir = rirRaw === '' || rirRaw == null ? null : Number(rirRaw);
  const isWarmup = row.dataset.warmup === '1';

  // Optional right/left rep breakdown (per-arm exercises) — when both sides
  // are filled, the weaker side becomes the "official" reps (same number
  // every other calculation already keys off), overriding the main stepper.
  const repsRRaw = row.querySelector('[data-reps-r]')?.value?.trim();
  const repsLRaw = row.querySelector('[data-reps-l]')?.value?.trim();
  const repsR = repsRRaw ? parseInt(repsRRaw, 10) : null;
  const repsL = repsLRaw ? parseInt(repsLRaw, 10) : null;
  if ((repsR != null) !== (repsL != null)) {
    toast('Enter reps for both sides, or leave both blank');
    return;
  }
  const reps = repsR != null ? Math.min(repsR, repsL) : repsInput;

  // weight=0 is a legitimate, meaningful value for both bodyweight (no added
  // weight) and assisted exercises (no assistance — the hardest variant, and
  // exactly what the progression hint recommends once you've outgrown the
  // machine's lowest setting). Previously only bodyweight was exempted, so
  // the UI silently refused to log the assisted case the app itself suggests.
  const ex = workoutState?.programDay?.exercises?.find((e) => e.exercise_id === exId);
  const allowZeroWeight = !!(ex?.is_bodyweight || ex?.is_assisted);
  if ((weight < 0 || (weight === 0 && !allowZeroWeight) || Number.isNaN(weight)) || !reps) {
    toast(allowZeroWeight ? 'Enter reps (weight can be 0)' : 'Enter weight and reps first');
    return;
  }

  if (checkBtn) checkBtn.disabled = true;
  try {
    if (row.dataset.setId) {
      const updated = await API.updateSet(Number(row.dataset.setId), { weight, weight_unit: unit, reps, reps_r: repsR, reps_l: repsL, rir, notes: note });
      // This was the only confirmSet path that never wrote its result back
      // into workoutState.loggedSets — the DOM row looked right immediately
      // (it's just left alone here, not re-rendered), but a LATER full
      // re-render (renderWorkoutView(), triggered by an unrelated action
      // like adding a set on a different exercise) rebuilds every row from
      // workoutState, so the edit silently reverted to its stale pre-edit
      // value even though the server already had the correct one.
      const setIdx = workoutState.loggedSets.findIndex((s) => s.id === Number(row.dataset.setId));
      if (setIdx !== -1) workoutState.loggedSets[setIdx] = updated;
      // The correction is now the server-saved value too — drop the pending
      // draft so a stale copy doesn't linger and override a FUTURE edit.
      if (workoutState.draft.pendingEdits) delete workoutState.draft.pendingEdits[row.dataset.setId];
      saveDraft(workoutState.workout.id, workoutState.draft);
      row.classList.remove('editing');
      haptic(20);
      toast('Updated');
    } else {
      const res = await API.logSet({
        workout_id: workoutState.workout.id,
        exercise_id: exId,
        set_number: setNumber,
        weight, weight_unit: unit, reps, reps_r: repsR, reps_l: repsL, rir,
        notes: note,
        is_warmup: isWarmup ? 1 : 0
      });
      // The set was persisted server-side regardless — this only guards
      // against touching workoutState after Finish/Cancel already nulled it
      // out while this request was in flight.
      if (!workoutState) return;
      row.dataset.setId = res.id;
      row.dataset.justConfirmed = '1';
      row.classList.add('done');
      row.classList.remove('set-row--next');
      workoutState.loggedSets.push(res);
      clearDraftInput(workoutState.workout.id, exId, setNumber);
      cascadePrefillSiblings(row, weight, unit, reps);
      moveNextHighlight(exId);
      haptic(30);
      if (!isWarmup) renderSessionCoverage();
      const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exId);
      // Newly-confirmed rows are patched in place rather than fully
      // re-rendered via setRowHTML, so the form-flag button (only present in
      // the template when `logged` is set) has to be added here too —
      // otherwise it silently doesn't exist until some unrelated action
      // happens to trigger a full re-render.
      if (!isWarmup) {
        const formBtn = document.createElement('button');
        formBtn.className = 'set-row__form-flag';
        formBtn.dataset.toggleForm = '1';
        formBtn.title = "Form broke down on this set — won't count toward progressing next time";
        formBtn.textContent = '⚠️';
        row.querySelector('[data-rest]')?.insertAdjacentElement('beforebegin', formBtn);
      }
      const hints = row.querySelector('.set-row__hints');
      if (res.is_new_pr) {
        showPRFlash();
        const prBadge = document.createElement('button');
        prBadge.className = 'set-row__pr';
        prBadge.dataset.badgeTitle = 'New PR';
        prBadge.dataset.badgeMsg = `New personal record: ${fmtSetWeight(weight, unit, !!ex?.is_bodyweight, !!ex?.is_assisted)} × ${reps} reps.`;
        prBadge.textContent = '🏆';
        hints?.appendChild(prBadge);
      }
      startRestCountdown(ex?.rest_seconds ?? undefined);
      // Append e1RM hint to the newly-done row
      if (!isWarmup && reps > 0) {
        const load = loadKg({ weight, weight_unit: unit }, ex);
        if (load > 0) {
          const badge = document.createElement('span');
          badge.className = 'set-row__hint';
          badge.textContent = `~${Math.round(e1RM(load, reps))} kg 1RM`;
          hints?.appendChild(badge);
        }
      }
      // Same gap as the PR/form-flag ones above: setRowHTML's perArmBadge
      // only ever renders on a full re-render, so a newly-confirmed set
      // with a right/left breakdown showed nothing until something else
      // forced one.
      if (repsR != null && repsL != null && repsR !== repsL) {
        const perArmBadge = document.createElement('span');
        perArmBadge.className = 'set-row__hint';
        perArmBadge.textContent = fmtReps(reps, repsR, repsL);
        hints?.appendChild(perArmBadge);
      }
      // Same gap again: setRowHTML always renders the swipe-to-delete
      // overlay for a logged row, but this patch path skipped it — swiping
      // a just-confirmed set did nothing until a later full re-render.
      if (!row.querySelector('[data-delete]')) {
        const deleteOverlay = document.createElement('div');
        deleteOverlay.className = 'set-row__delete';
        deleteOverlay.dataset.delete = '';
        deleteOverlay.textContent = 'Delete';
        row.appendChild(deleteOverlay);
      }
    }
  } catch (err) {
    toast(err.message);
  } finally {
    if (checkBtn) checkBtn.disabled = false;
  }
}

function cascadePrefillSiblings(confirmedRow, weight, unit, reps) {
  const exId = confirmedRow.dataset.ex;
  const card = confirmedRow.closest('.exercise-card');
  if (!card) return;
  const siblings = card.querySelectorAll(`.set-row[data-ex="${exId}"]`);
  for (const sib of siblings) {
    if (sib === confirmedRow) continue;
    if (sib.dataset.setId) continue;
    if (sib.dataset.pristine !== '1') continue;
    const wIn = sib.querySelector('[data-field="weight"] .num-input__field');
    const rIn = sib.querySelector('[data-field="reps"] .num-input__field');
    const uBtn = sib.querySelector('[data-unit]');
    if (wIn) wIn.value = String(weight);
    if (rIn) rIn.value = String(reps);
    if (uBtn) { uBtn.textContent = unit; uBtn.classList.toggle('kg', unit === 'kg'); }
  }
}

function moveNextHighlight(exId) {
  const card = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  if (!card) return;
  card.querySelectorAll('.set-row--next').forEach((r) => r.classList.remove('set-row--next'));
  const next = [...card.querySelectorAll('.set-row')].find((r) => !r.dataset.setId);
  if (next) next.classList.add('set-row--next');
  checkExerciseComplete(exId);
}

function checkExerciseComplete(exId) {
  const card = document.querySelector(`.exercise-card[data-ex="${exId}"]`);
  if (!card) return;
  const isSkipped = card.classList.contains('exercise-card--skipped');
  const visibleRows = [...card.querySelectorAll('.set-row')].filter((r) => !r.classList.contains('hidden'));
  const allDone = isSkipped || (visibleRows.length > 0 && visibleRows.every((r) => !!r.dataset.setId));
  card.classList.toggle('exercise-card--complete', allDone);
  const skipBtn = card.querySelector('[data-skip-ex]');
  if (skipBtn) {
    // Hide skip button when fully logged; show "Skipped" undo button when skipped
    if (isSkipped) skipBtn.style.display = '';
    else skipBtn.style.display = allDone ? 'none' : '';
  }
}

async function persistRirChange(row) {
  const setId = Number(row.dataset.setId);
  if (!setId) return;
  const raw = row.dataset.rir;
  const rir = raw === '' || raw == null ? null : Number(raw);
  try { await API.updateSet(setId, { rir }); } catch (err) { toast(err.message); }
}

// Guards undoLastSet/deleteLoggedSet against a fast double-tap sending two
// DELETE requests for the same set — the second would 404 (already gone)
// and surface a confusing error toast despite the delete having succeeded.
const setsBeingDeleted = new Set();

async function undoLastSet(exId) {
  if (workoutEnding || !workoutState) return;
  const exSets = workoutState.loggedSets.filter((s) => s.exercise_id === exId);
  if (!exSets.length) return;
  const lastSet = exSets.reduce((a, b) => a.set_number > b.set_number ? a : b);
  if (setsBeingDeleted.has(lastSet.id)) return;
  setsBeingDeleted.add(lastSet.id);
  try {
    await API.deleteSet(lastSet.id);
    if (!workoutState) return;
    workoutState.loggedSets = workoutState.loggedSets.filter((s) => s.id !== lastSet.id);
    haptic(20);
    toast('Set undone');
    renderWorkoutView();
  } catch (err) { toast(err.message); }
  finally { setsBeingDeleted.delete(lastSet.id); }
}

async function deleteLoggedSet(row) {
  if (!workoutState) return;
  const id = Number(row.dataset.setId);
  if (!id || setsBeingDeleted.has(id)) return;
  setsBeingDeleted.add(id);
  try {
    await API.deleteSet(id);
    if (!workoutState) return;
    workoutState.loggedSets = workoutState.loggedSets.filter((s) => s.id !== id);
    if (workoutState.draft.pendingEdits) delete workoutState.draft.pendingEdits[id];
    saveDraft(workoutState.workout.id, workoutState.draft);
    row.classList.remove('done', 'swiped');
    row.removeAttribute('data-set-id');
    delete row.dataset.justConfirmed;
    const overlay = row.querySelector('[data-delete]');
    if (overlay) overlay.remove();
    haptic(20);
    toast('Set deleted');
    renderSessionCoverage();
  } catch (err) { toast(err.message); }
  finally { setsBeingDeleted.delete(id); }
}

function toggleRestTimer() {
  if (isRestActive()) cancelRestCountdown();
  else startRestCountdown();
}

function skipRemainingForExercise(exerciseId) {
  const card = document.querySelector(`.exercise-card[data-ex="${exerciseId}"]`);
  if (!card) return;
  const rows = [...card.querySelectorAll('.set-row')];
  const unlogged = rows.filter((r) => !r.dataset.setId);
  if (!unlogged.length) return;

  // Persist skip state so it survives re-renders
  if (!workoutState.draft.skipped) workoutState.draft.skipped = {};
  workoutState.draft.skipped[exerciseId] = true;
  saveDraft(workoutState.workout.id, workoutState.draft);

  unlogged.forEach((r) => r.classList.add('hidden'));
  card.classList.add('exercise-card--skipped', 'exercise-card--complete');
  const skipBtn = card.querySelector('[data-skip-ex]');
  if (skipBtn) {
    skipBtn.style.display = '';
    skipBtn.textContent = 'Skipped — tap to undo';
  }

  toast(`Skipped ${unlogged.length} remaining set${unlogged.length > 1 ? 's' : ''}`);
}

// Remove an exercise from the active workout entirely. If it has logged sets,
// those are deleted server-side (with confirmation); otherwise it's just
// dropped from the in-progress list.
async function removeExerciseFromWorkout(exerciseId) {
  const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exerciseId);
  if (!ex) return;
  const loggedCount = workoutState.loggedSets.filter((s) => s.exercise_id === exerciseId).length;
  const ok = await confirmSheet({
    title: 'Remove exercise',
    message: loggedCount
      ? `Remove "${ex.name}" and delete its ${loggedCount} logged set${loggedCount > 1 ? 's' : ''}? This can't be undone.`
      : `Remove "${ex.name}" from this workout?`,
    confirmText: 'Remove',
    danger: true
  });
  if (!ok) return;
  if (loggedCount) {
    try { await API.removeWorkoutExercise(workoutState.workout.id, exerciseId); }
    catch (err) { return toast(err.message); }
    workoutState.loggedSets = workoutState.loggedSets.filter((s) => s.exercise_id !== exerciseId);
  }
  workoutState.programDay.exercises = workoutState.programDay.exercises.filter((x) => x.exercise_id !== exerciseId);
  // Scrub any per-exercise draft state so it doesn't resurrect on reload.
  if (workoutState.draft.setCounts) delete workoutState.draft.setCounts[exerciseId];
  if (workoutState.draft.skipped) delete workoutState.draft.skipped[exerciseId];
  for (const k of Object.keys(workoutState.draft.inputs || {})) {
    if (k.startsWith(`${exerciseId}-`)) delete workoutState.draft.inputs[k];
  }
  persistExerciseList();
  haptic(20);
  toast(`Removed ${ex.name}`);
  renderWorkoutView();
}

const EQUIPMENT_OPTIONS = [
  { value: 'barbell',    label: 'Barbell',    step: 'kg +5 / lbs +10' },
  { value: 'dumbbell',   label: 'Dumbbell',   step: 'kg +2 / lbs +5' },
  { value: 'cable',      label: 'Cable',      step: 'kg +2.5 / lbs +5' },
  { value: 'machine',    label: 'Machine',    step: 'kg +2.5 / lbs +5' },
  { value: 'bodyweight', label: 'Bodyweight', step: 'kg +1' },
];

async function openEquipmentPicker(exerciseId) {
  const ex = workoutState?.programDay?.exercises?.find((e) => e.exercise_id === exerciseId);
  if (!ex) return;
  const sheet = ensureSheet('equipment-picker-sheet');
  const current = ex.equipment || 'barbell';

  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Equipment — ${escapeHtml(ex.name)}</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:12px">Affects the +/− step size and weight recommendation.</div>
        ${EQUIPMENT_OPTIONS.map((opt) => `
          <button class="equip-option ${opt.value === current ? 'equip-option--active' : ''}" data-equip-pick="${opt.value}">
            <div class="equip-option__label">${opt.label}</div>
            <div class="equip-option__step">${opt.step}</div>
          </button>`).join('')}
      </div>
    </div>`;

  sheet.querySelector('[data-close-sheet]').onclick = () => hideSheet(sheet);
  sheet.querySelectorAll('[data-equip-pick]').forEach((btn) => {
    btn.onclick = async () => {
      const newEquip = btn.dataset.equipPick;
      if (newEquip === current) { hideSheet(sheet); return; }
      try {
        await API.updateExercise(exerciseId, { equipment: newEquip });
        ex.equipment = newEquip;
        haptic(20);
        hideSheet(sheet);
        renderWorkoutView();
        toast(`Equipment updated to ${newEquip}`);
      } catch (err) { toast(err.message); }
    };
  });

  showSheet(sheet);
}

// "How to" sheet: instructions live server-side (deliberately not in the list
// payloads — they're ~1KB each), so fetch the single exercise on demand.
async function openHowToSheet(exerciseId) {
  const ex = workoutState?.programDay.exercises.find((x) => x.exercise_id === exerciseId);
  let full = null;
  try { full = await API.exercise(exerciseId); } catch { /* offline */ }
  if (!full?.instructions) {
    toast('No how-to for this exercise yet');
    return;
  }
  const sheet = ensureSheet('howto-sheet');
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-howto>←</button>
        <div class="sheet__title">${escapeHtml(ex?.name || full.name)}</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:10px">${escapeHtml(full.muscle_group)}${full.sub_muscle ? ` · ${escapeHtml(full.sub_muscle)}` : ''} · ${escapeHtml(full.equipment || '')}</div>
        <div class="howto-text">${escapeHtml(full.instructions)}</div>
      </div>
    </div>`;
  sheet.querySelector('[data-close-howto]').onclick = () => hideSheet(sheet);
  showSheet(sheet);
}

// Persists across re-opens (swap/add both use it) within a session — same
// tier as other lightweight UI-only prefs.
let workoutPickerSort = 'frequent';
let workoutPickerSubGroup = false;

// Fields copied from the exercise catalog whenever an exercise is placed (or
// replaced) in workoutState.programDay.exercises — every consumer reads
// these off THIS object, not a live re-fetch (muscleTagHTML's group/sub-muscle
// chip, the per-arm ×2 doubling via weight_mode, the rep-range progression
// hint). Missing one here goes stale silently: wrong muscle tag, wrong
// volume math, or a stuck rep target, all invisible until the user notices.
// Shared by both the swap and add pickers' create-new AND pick-existing paths
// so the four call sites can't drift out of sync with each other again.
function exerciseCatalogFields(ex) {
  return {
    name: ex.name,
    muscle_group: ex.muscle_group,
    sub_muscle: ex.sub_muscle ?? null,
    is_bodyweight: !!ex.is_bodyweight,
    is_assisted: !!ex.is_assisted,
    equipment: ex.equipment || 'barbell',
    // Default to 'combined' (not per-arm) on missing data — under-counting
    // volume is a safer failure than silently doubling it.
    weight_mode: ex.weight_mode || 'combined',
    rep_min: ex.rep_min ?? null,
    rep_max: ex.rep_max ?? null,
    notes: ex.notes || null
  };
}

async function openSwapPicker(currentExerciseId) {
  const picker = ensureSheet('workout-swap-picker-sheet');
  picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(picker);

  let exercises;
  try { exercises = await API.exerciseStats(); }
  catch (err) {
    picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    return;
  }

  const currentIdx = workoutState.programDay.exercises.findIndex((e) => e.exercise_id === currentExerciseId);
  const currentEx = workoutState.programDay.exercises[currentIdx];
  const inWorkoutElsewhere = new Set(
    workoutState.programDay.exercises.filter((e, i) => i !== currentIdx).map((e) => e.exercise_id)
  );

  const pickRowHTML = (ex, g, showSubTag) => `
    <button class="picker-row ${ex.id === currentExerciseId || inWorkoutElsewhere.has(ex.id) ? 'picker-row--added' : ''}" data-swap-pick="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}">
      <span>${escapeHtml(ex.name)}${showSubTag && ex.sub_muscle ? ` <span class="picker-row__sub mg-title mg-${g}${subMuscleShadeClass(g, ex.sub_muscle)}">${escapeHtml(ex.sub_muscle)}</span>` : ''}</span>
      <span class="picker-row__state">${ex.id === currentExerciseId ? 'current' : inWorkoutElsewhere.has(ex.id) ? 'in workout' : 'pick'}</span>
    </button>`;

  function buildList() {
    // Preserve whichever tab (a muscle group, or "All") was open before this
    // rebuild — sort/split-by-sub-muscle toggles used to always regenerate
    // the chip bar with "All" active, silently resetting it.
    const prevChip = picker.querySelector('.picker-chip--active')?.dataset.chip ?? '';
    const groups = {};
    for (const ex of exercises) {
      if (!groups[ex.muscle_group]) groups[ex.muscle_group] = [];
      groups[ex.muscle_group].push(ex);
    }
    for (const g of Object.keys(groups)) groups[g] = sortExercisesBy(groups[g], workoutPickerSort);
    const keys = [...new Set([...PICKER_GROUP_ORDER, ...Object.keys(groups)])].filter((k) => groups[k]);
    const activeChip = prevChip === '' || keys.includes(prevChip) ? prevChip : '';
    picker.querySelector('#swap-sort').innerHTML = exerciseSortHTML(workoutPickerSort) + subGroupToggleHTML(workoutPickerSubGroup);
    picker.querySelector('#swap-list').innerHTML = pickerChipsHTML(keys, activeChip) + keys.map((g) => `
      <div class="picker-group" data-group="${g}">
        <div class="picker-group__title mg-title mg-${g}">${escapeHtml(g)}</div>
        ${workoutPickerSubGroup
          ? groupBySubMuscle(g, groups[g]).map(({ sub, exercises: exs }) => `
              <div class="picker-subgroup__title mg-title mg-${g}${subMuscleShadeClass(g, sub)}">${escapeHtml(sub || 'General')}</div>
              ${exs.map((ex) => pickRowHTML(ex, g, false)).join('')}
            `).join('')
          : groups[g].map((ex) => pickRowHTML(ex, g, true)).join('')}
      </div>`).join('');
    setupPickerFilter(picker)();
  }

  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Swap ${escapeHtml(currentEx?.name || 'exercise')}</div>
        <button class="btn--icon" id="swap-create-new" title="Create new exercise" style="font-size:20px;font-weight:700">+</button>
      </div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:10px">Pick a replacement. This only affects today's workout.</div>
        <input class="input" id="swap-search" data-picker-search placeholder="Search exercises…" style="margin-bottom:12px"/>
        <div id="swap-sort"></div>
        <div id="swap-list"></div>
      </div>
    </div>`;
  buildList();

  document.getElementById('swap-create-new').onclick = () => openWorkoutNewExerciseForm(picker, {
    onBack: () => openSwapPicker(currentExerciseId),
    onCreated: (ex) => {
      // Swap the current exercise with the newly created one
      workoutState.programDay.exercises[currentIdx] = {
        ...currentEx,
        exercise_id: ex.id,
        ...exerciseCatalogFields(ex)
      };
      hideSheet(picker);
      toast(`Swapped to ${ex.name}`);
      renderWorkoutView();
    }
  });

  picker.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(picker);
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { workoutPickerSort = sortBtn.dataset.sort; buildList(); return; }
    const subgroupBtn = e.target.closest('[data-subgroup-toggle]');
    if (subgroupBtn) { workoutPickerSubGroup = !workoutPickerSubGroup; buildList(); return; }
    const pickBtn = e.target.closest('[data-swap-pick]');
    if (!pickBtn) return;
    const newExId = Number(pickBtn.dataset.swapPick);
    if (newExId === currentExerciseId) { toast('Same exercise — nothing to swap'); return; }
    if (workoutState.programDay.exercises.some((e, i) => i !== currentIdx && e.exercise_id === newExId)) {
      toast('That exercise is already in this workout');
      return;
    }
    const newEx = exercises.find((x) => x.id === newExId);
    if (!newEx) return;

    const logged = workoutState.loggedSets.filter((s) => s.exercise_id === currentExerciseId);
    if (logged.length) {
      const msg = `Delete ${logged.length} logged set${logged.length > 1 ? 's' : ''} for ${currentEx.name} and swap?`;
      const ok = await confirmSheet({ title: 'Swap exercise', message: msg, confirmText: 'Delete & swap', danger: true });
      if (!ok) return;
      try {
        await Promise.all(logged.map((s) => API.deleteSet(s.id)));
        workoutState.loggedSets = workoutState.loggedSets.filter((s) => s.exercise_id !== currentExerciseId);
      } catch (err) { toast(err.message); return; }
    }

    workoutState.programDay.exercises[currentIdx] = {
      ...currentEx,
      exercise_id: newExId,
      ...exerciseCatalogFields(newEx)
    };
    if (workoutState.draft.exerciseOrder?.length) {
      workoutState.draft.exerciseOrder = workoutState.draft.exerciseOrder.map(
        (id) => id === currentExerciseId ? newExId : id
      );
    }
    persistExerciseList();
    hideSheet(picker);
    haptic(20);

    // Offer to persist the swap into the program template — but only when
    // there's a real template slot (currentEx.id) and a real program day
    // (not a quick workout) to write it back to. The swap itself stays
    // local/ephemeral unless the user opts in, so the common "just today"
    // case stays frictionless. Captured now (not re-read from workoutState
    // inside the toast's callback) because the toast can outlive this
    // workout — finishing it nulls out workoutState before the 5s toast expires.
    const { id: dayId, program_id: programId } = workoutState.programDay;
    const canPersist = currentEx.id && dayId && programId;
    if (canPersist) {
      actionToast(`Swapped to ${newEx.name}`, 'Keep for next time', async () => {
        try {
          await API.updateDayExercise(programId, dayId, currentEx.id, { exercise_id: newExId });
          toast(`${newEx.name} saved to this program day`);
        } catch (err) { toast(err.message); }
      });
    } else {
      toast(`Swapped to ${newEx.name}`);
    }
    // Pull the swapped-in exercise's previous numbers so its card shows real
    // history instead of "First time" — workoutState.lastByExercise was only
    // ever fetched for the program day's ORIGINAL exercise list, so a
    // swapped-in exercise has no entry until this backfills it (previously
    // only a full page reload re-fetched it, which is what "First time" was
    // really reporting: no data fetched yet, not no history).
    try {
      const m = await API.lastByExercise([newExId]);
      workoutState.lastByExercise = { ...(workoutState.lastByExercise || {}), ...m };
    } catch { /* optional — render without prefill */ }
    if (!workoutState) return; // workout was finished/cancelled while this was in flight
    renderWorkoutView();
  };
}

async function openWorkoutAddExercisePicker() {
  const picker = ensureSheet('workout-add-picker-sheet');
  picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(picker);

  let exercises;
  try { exercises = await API.exerciseStats(); }
  catch (err) {
    picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    return;
  }

  const inWorkout = new Set(workoutState.programDay.exercises.map((e) => e.exercise_id));

  const addRowHTML = (ex, g, showSubTag) => `
    <button class="picker-row ${inWorkout.has(ex.id) ? 'picker-row--added' : ''}" data-wkadd="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}">
      <span>${escapeHtml(ex.name)}${showSubTag && ex.sub_muscle ? ` <span class="picker-row__sub mg-title mg-${g}${subMuscleShadeClass(g, ex.sub_muscle)}">${escapeHtml(ex.sub_muscle)}</span>` : ''}</span>
      <span class="picker-row__state">${inWorkout.has(ex.id) ? 'added' : 'add'}</span>
    </button>`;

  function buildList() {
    // Preserve whichever tab (a muscle group, or "All") was open before this
    // rebuild — see the identical fix/comment in openSwapPicker's buildList.
    const prevChip = picker.querySelector('.picker-chip--active')?.dataset.chip ?? '';
    const groups = {};
    for (const ex of exercises) {
      if (!groups[ex.muscle_group]) groups[ex.muscle_group] = [];
      groups[ex.muscle_group].push(ex);
    }
    for (const g of Object.keys(groups)) groups[g] = sortExercisesBy(groups[g], workoutPickerSort);
    const keys = [...new Set([...PICKER_GROUP_ORDER, ...Object.keys(groups)])].filter((k) => groups[k]);
    const activeChip = prevChip === '' || keys.includes(prevChip) ? prevChip : '';
    picker.querySelector('#wkadd-sort').innerHTML = exerciseSortHTML(workoutPickerSort) + subGroupToggleHTML(workoutPickerSubGroup);
    picker.querySelector('#wkadd-list').innerHTML = pickerChipsHTML(keys, activeChip) + keys.map((g) => `
      <div class="picker-group" data-group="${g}">
        <div class="picker-group__title mg-title mg-${g}">${escapeHtml(g)}</div>
        ${workoutPickerSubGroup
          ? groupBySubMuscle(g, groups[g]).map(({ sub, exercises: exs }) => `
              <div class="picker-subgroup__title mg-title mg-${g}${subMuscleShadeClass(g, sub)}">${escapeHtml(sub || 'General')}</div>
              ${exs.map((ex) => addRowHTML(ex, g, false)).join('')}
            `).join('')
          : groups[g].map((ex) => addRowHTML(ex, g, true)).join('')}
      </div>`).join('');
    setupPickerFilter(picker)();
  }

  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" data-close-sheet>←</button>
        <div class="sheet__title">Add exercise</div>
        <button class="btn--icon" id="wkadd-create" title="Create new exercise" style="font-size:20px;font-weight:700">+</button>
      </div>
      <div class="sheet__body">
        <input class="input" id="wkadd-search" data-picker-search placeholder="Search exercises…" style="margin-bottom:12px"/>
        <div id="wkadd-sort"></div>
        <div id="wkadd-list"></div>
      </div>
    </div>`;
  buildList();

  document.getElementById('wkadd-create').onclick = () => openWorkoutNewExerciseForm(picker, {
    onBack: () => openWorkoutAddExercisePicker(),
    onCreated: (ex) => {
      workoutState.programDay.exercises.push({
        id: null,
        exercise_id: ex.id,
        ...exerciseCatalogFields(ex),
        target_sets: 2,
        target_reps: 8,
        order_index: workoutState.programDay.exercises.length
      });
      persistExerciseList();
      hideSheet(picker);
      toast(`Added ${ex.name}`);
      renderWorkoutView();
    }
  });

  picker.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(picker);
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { workoutPickerSort = sortBtn.dataset.sort; buildList(); return; }
    const subgroupBtn = e.target.closest('[data-subgroup-toggle]');
    if (subgroupBtn) { workoutPickerSubGroup = !workoutPickerSubGroup; buildList(); return; }
    const pickBtn = e.target.closest('[data-wkadd]');
    if (!pickBtn) return;
    const exId = Number(pickBtn.dataset.wkadd);
    const newEx = exercises.find((x) => x.id === exId);
    if (!newEx) return;
    if (inWorkout.has(exId)) { toast('Already in this workout'); return; }
    workoutState.programDay.exercises.push({
      id: null,
      exercise_id: exId,
      ...exerciseCatalogFields(newEx),
      target_sets: 2,
      target_reps: 8,
      order_index: workoutState.programDay.exercises.length
    });
    persistExerciseList();
    hideSheet(picker);
    haptic(20);
    toast(`Added ${newEx.name}`);
    // Pull this exercise's previous numbers so prefill + hints show right away.
    try {
      const m = await API.lastByExercise([exId]);
      workoutState.lastByExercise = { ...(workoutState.lastByExercise || {}), ...m };
    } catch { /* optional — render without prefill */ }
    if (!workoutState) return; // workout was finished/cancelled while this was in flight
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
  if (workoutEnding) return;
  const ok = await confirmSheet({ title: 'Cancel workout', message: 'Cancel this workout? All logged sets will be deleted.', confirmText: 'Cancel workout', cancelText: 'Keep going', danger: true });
  if (!ok) return;
  workoutEnding = true;
  const id = workoutState?.workout?.id;
  if (id) {
    clearDraft(id);
    try { await API.deleteWorkout(id); } catch { /* sets cascade-delete with workout */ }
  }
  localStorage.removeItem(LS.activeWorkoutId);
  localStorage.removeItem(LS.activeProgramDayId);
  localStorage.removeItem(LS.activeWorkoutStart);
  if (stickyTimerHandle) clearInterval(stickyTimerHandle);
  releaseWakeLock();
  cancelRestCountdown();
  document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'programs' }));
}

async function finishWorkout() {
  if (workoutEnding) return;
  const id = workoutState?.workout?.id;
  if (!id) return;
  if ((workoutState.loggedSets || []).length === 0) {
    // Nothing logged — discard instead of saving an empty workout that would
    // just clutter History.
    workoutEnding = true;
    const ok = await confirmSheet({ title: 'Nothing logged', message: 'No sets were logged. Discard this workout?', confirmText: 'Discard', danger: true });
    if (!ok) { workoutEnding = false; return; }
    clearDraft(id);
    try { await API.deleteWorkout(id); } catch { /* sets cascade with the workout */ }
    localStorage.removeItem(LS.activeWorkoutId);
    localStorage.removeItem(LS.activeProgramDayId);
    localStorage.removeItem(LS.activeWorkoutStart);
    if (stickyTimerHandle) clearInterval(stickyTimerHandle);
    releaseWakeLock();
    cancelRestCountdown();
    toast('Workout discarded');
    document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'programs' }));
    return;
  }
  workoutEnding = true;
  try {
    const finishedWorkout = await API.finishWorkout(id);
    if (stickyTimerHandle) clearInterval(stickyTimerHandle);
    releaseWakeLock();
    cancelRestCountdown();

    const sets = await API.workoutSets(id);
    const totalVolume = sets.reduce((acc, s) => {
      if (s.is_warmup) return acc;
      // Bodyweight/assisted go through loadKg (the same helper e1RM uses) so an
      // assisted lift subtracts the assistance instead of adding it — the old
      // inline calc treated assisted as is_bodyweight and ADDED the assistance,
      // inflating the finish-summary volume and disagreeing with History. Only
      // weighted sets take the per-arm multiplier (bodyweight isn't per-arm).
      const kg = s.is_bodyweight
        ? loadKg(s, s)
        : toKg(s.weight, s.weight_unit) * (s.load_multiplier ?? (s.weight_mode === 'per_arm' ? 2 : 1));
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

    // Build template data before clearing workoutState
    const templateExercises = workoutState.programDay.exercises
      .filter((ex) => workoutState.loggedSets.some((s) => s.exercise_id === ex.exercise_id && !s.is_warmup))
      .map((ex) => {
        const logged = workoutState.loggedSets.filter((s) => s.exercise_id === ex.exercise_id && !s.is_warmup);
        const lastSet = logged[logged.length - 1];
        return {
          exercise_id: ex.exercise_id,
          name: ex.name,
          target_sets: Math.max(...logged.map((s) => s.set_number)),
          target_reps: lastSet?.reps || ex.target_reps,
          rest_seconds: ex.rest_seconds || null
        };
      });

    // Capture program/day ids before workoutState is cleared so "Save as
    // template" can overwrite the exact day that was trained (null for a
    // quick workout, which falls back to creating a new program).
    const tmplProgramId = workoutState.programDay.program_id ?? null;
    const tmplDayId = workoutState.workout.program_day_id ?? workoutState.programDay.id ?? null;

    // Which lifts topped their rep range this session (every working set hit
    // the range max)? Same engine as the next-session card hint, fed with
    // TODAY's sets — so the finish screen and the future hint always agree.
    // Also flags plateau/decline for lifts that didn't: same engine as the
    // live hint's badge, with today's best set appended to the trend so a
    // stuck or dropping streak shows up as soon as it happens, not next visit.
    const readyToGoUp = [];
    const goingUp = [];
    const worthALook = [];
    for (const ex of workoutState.programDay.exercises) {
      const logged = workoutState.loggedSets.filter((s) => s.exercise_id === ex.exercise_id && !s.is_warmup);
      if (!logged.length) continue;
      const rec = recommendForNext(ex, logged);
      if (!rec) continue;
      if (rec.isProgression) { readyToGoUp.push({ name: ex.name, rec }); continue; }
      if (rec.isStale || rec.isFormHeld) continue;
      const todayBest = logged.reduce((best, s) => loadKg(s, ex) >= loadKg(best, ex) ? s : best, logged[0]);
      const status = classifyTrend([...pastTrendFor(ex), todayBest], rec);
      if (status === 'up') goingUp.push({ name: ex.name });
      else if (status) worthALook.push({ name: ex.name, status });
    }

    renderSummary({
      workoutId: id,
      sets: sets.length,
      volume: totalVolume,
      duration: fmtDuration(workoutState.startedAt, new Date().toISOString()),
      newPRs,
      dayLabel: workoutState.programDay.day_label,
      calories: finishedWorkout.calories_burned ?? null,
      templateExercises,
      programId: tmplProgramId,
      dayId: tmplDayId,
      readyToGoUp,
      goingUp,
      worthALook
    });

    clearDraft(id);
    localStorage.removeItem(LS.activeWorkoutId);
    localStorage.removeItem(LS.activeProgramDayId);
    localStorage.removeItem(LS.activeWorkoutStart);
    workoutState = null;
    refreshBadgeFromCalendar();
  } catch (err) {
    workoutEnding = false;
    toast(err.message);
  }
}

function renderSummary({ workoutId, sets, volume, duration, newPRs, dayLabel, calories, templateExercises, programId, dayId, readyToGoUp = [], goingUp = [], worthALook = [] }) {
  const root = $('#view-workout');
  const calTile = calories
    ? `<div class="summary__tile"><div class="summary__tile-label">Burned (est.)</div><div class="summary__tile-value">${calories}&nbsp;kcal</div></div>`
    : `<button class="summary__tile summary__tile--nudge" data-log-bw-nudge><div class="summary__tile-label">Burned (est.)</div><div class="summary__tile-value" style="font-size:13px">Log weight to see this →</div></button>`;
  root.innerHTML = `
    <div class="summary">
      <div class="summary__stat">${escapeHtml(dayLabel)}</div>
      <div class="card__subtitle">Workout complete</div>
      <div class="summary__grid">
        <div class="summary__tile"><div class="summary__tile-label">Sets</div><div class="summary__tile-value">${sets}</div></div>
        <div class="summary__tile"><div class="summary__tile-label">Volume (kg)</div><div class="summary__tile-value">${Math.round(volume).toLocaleString()}</div></div>
        <div class="summary__tile"><div class="summary__tile-label">Time</div><div class="summary__tile-value">${duration}</div></div>
        ${calTile}
      </div>
      ${newPRs.length ? `<div class="card" style="text-align:left">
          <div class="card__title">New PRs &#x1F3C6;</div>
          ${newPRs.map((pr) => `<div class="card__subtitle" style="margin-top:6px"><strong style="color:var(--accent)">${escapeHtml(pr.name)}</strong> — ${pr.weight}${pr.weight_unit} × ${pr.reps}</div>`).join('')}
        </div>` : ''}
      ${readyToGoUp.length ? `<div class="card" style="text-align:left">
          <div class="card__title">Ready to go up &#x2B06;</div>
          ${readyToGoUp.map(({ name, rec }) => `<div class="card__subtitle" style="margin-top:6px"><strong style="color:var(--accent)">${escapeHtml(name)}</strong> — hit ${rec.hitReps}+ every set. Next time: <strong>${rec.recDisplay} × ${rec.recReps}</strong></div>`).join('')}
        </div>` : ''}
      ${goingUp.length ? `<div class="card" style="text-align:left">
          <div class="card__title">Trending up &#x1F4C8;</div>
          ${goingUp.map(({ name }) => `<div class="card__subtitle" style="margin-top:6px"><strong style="color:var(--accent)">${escapeHtml(name)}</strong> — 2 sessions in a row of weight increases</div>`).join('')}
        </div>` : ''}
      ${worthALook.length ? `<div class="card" style="text-align:left">
          <div class="card__title">Worth a look</div>
          ${worthALook.map(({ name, status }) => `<div class="card__subtitle" style="margin-top:6px"><strong style="color:${status === 'decline' ? 'var(--danger)' : 'var(--text-dim)'}">${escapeHtml(name)}</strong> — ${status === 'decline' ? 'dropped from last session' : 'stuck at the same weight for 2+ sessions'}</div>`).join('')}
        </div>` : ''}
      <div class="feel-prompt">
        <div class="feel-prompt__label">How did it feel?</div>
        <div class="feel-prompt__options">
          ${FEEL_OPTIONS.map((o) => `
            <button class="feel-btn" data-feel="${o.v}" title="${o.label}">
              <span class="feel-btn__emoji">${o.emoji}</span>
              <span class="feel-btn__label">${o.label}</span>
            </button>`).join('')}
        </div>
      </div>
      ${templateExercises?.length ? `<button class="btn btn--ghost btn--block" data-save-template style="margin-top:8px">&#x1F4CB; ${dayId ? `Update “${escapeHtml(dayLabel)}” template` : 'Save as program template'}</button>` : ''}
      <button class="btn btn--primary btn--block" data-go-programs style="margin-top:8px">Done</button>
    </div>
  `;

  root.onclick = async (e) => {
    if (e.target.closest('[data-go-programs]'))
      return document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'programs' }));
    if (e.target.closest('[data-save-template]'))
      return saveAsTemplate(templateExercises, dayLabel, programId, dayId);
    if (e.target.closest('[data-log-bw-nudge]')) return openBodyweightSheet();
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

async function saveAsTemplate(exercises, dayLabel, programId, dayId) {
  const payload = exercises.map((ex) => ({
    exercise_id: ex.exercise_id,
    target_sets: ex.target_sets,
    target_reps: ex.target_reps,
    rest_seconds: ex.rest_seconds
  }));

  // From a program day → overwrite that exact day to match this session.
  if (programId && dayId) {
    const ok = await confirmSheet({
      title: 'Update template',
      message: `Update “${dayLabel}” to match this session? This replaces its exercises, sets, reps and rest with what you just did.`,
      confirmText: 'Update template'
    });
    if (!ok) return;
    try {
      await API.replaceDayExercises(programId, dayId, { exercises: payload });
      haptic(20);
      toast(`Updated “${dayLabel}”`);
    } catch (err) {
      toast(`Couldn't update: ${err.message}`);
    }
    return;
  }

  // Quick workout (no program day) → create a new program.
  const name = await promptSheet({
    title: 'Save as program',
    label: 'Program name',
    value: dayLabel || 'My Program',
    confirmText: 'Save program'
  });
  if (!name || !name.trim()) return;
  try {
    const prog = await API.createProgram({ name: name.trim() });
    const day = await API.addDay(prog.id, { day_label: dayLabel || 'Day 1' });
    await API.replaceDayExercises(prog.id, day.id, { exercises: payload });
    haptic(20);
    toast(`Saved as "${name.trim()}" — find it in Programs`);
  } catch (err) {
    toast(`Couldn't save: ${err.message}`);
  }
}

async function flushWorkoutNotes() {
  const notesEl = document.querySelector('[data-workout-notes]');
  if (notesEl && workoutState?.workout) {
    const value = notesEl.value.trim() || null;
    const current = workoutState.workout.notes || null;
    if (value !== current) {
      try {
        await API.updateWorkout(workoutState.workout.id, { notes: value });
        workoutState.workout.notes = value;
      } catch { /* best-effort */ }
    }
  }
}

// onBack: () => void — returns to the calling picker
// onCreated: (ex) => void — what to do once exercise is created (add vs swap)
function openWorkoutNewExerciseForm(picker, { onBack, onCreated }) {
  renderNewExerciseForm(picker, {
    ctaLabel: 'Create & add to workout',
    onBack,
    onCreated
  });
}

export {
  renderWorkout, workoutState, flushWorkoutNotes,
  userBwKg, syncUserBodyweight, loadKg, e1RMForSet,
  saveAsTemplate, openActivitySheet
};
