import { $, $$, LS, escapeHtml, haptic, primeAudio, toast, fmtDuration, stepForExercise, skeletonBlocks, showPRFlash, e1RM, toKg, fmtSetWeight, weightEquiv, showSheet, hideSheet, ensureSheet, promptSheet, confirmSheet, enableDragReorder, PICKER_GROUP_ORDER, FEEL_OPTIONS, feelEmoji, subMuscleOptions, createSecondaryPicker, pickerChipsHTML, setupPickerFilter } from './utils.js';
import { API } from './api.js';
import { startRestCountdown, cancelRestCountdown, isRestActive, refreshBadgeFromCalendar } from './audio.js';

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

function draftKey(workoutId) { return `ironlog.draft.${workoutId}`; }

function loadDraft(workoutId) {
  try {
    const raw = localStorage.getItem(draftKey(workoutId));
    if (!raw) return { setCounts: {}, inputs: {} };
    const parsed = JSON.parse(raw);
    return { setCounts: parsed.setCounts || {}, inputs: parsed.inputs || {}, exerciseOrder: parsed.exerciseOrder, exerciseList: parsed.exerciseList, skipped: parsed.skipped || {} };
  } catch {
    return { setCounts: {}, inputs: {}, skipped: {} };
  }
}

// Persist the workout's current exercise list (after a swap / add / reorder) so
// it survives navigation and reload. Without this, the list is rebuilt from the
// server program template plus logged sets, which re-adds swapped-away
// exercises and drops swaps/adds that have no logged sets yet.
function persistExerciseList() {
  if (!workoutState) return;
  workoutState.draft.exerciseList = workoutState.programDay.exercises.map((e) => ({
    id: e.id ?? null,
    exercise_id: e.exercise_id,
    name: e.name,
    muscle_group: e.muscle_group,
    notes: e.notes ?? null,
    is_bodyweight: !!e.is_bodyweight,
    is_assisted: !!e.is_assisted,
    equipment: e.equipment || 'barbell',
    target_sets: e.target_sets,
    target_reps: e.target_reps,
    rest_seconds: e.rest_seconds ?? null,
    order_index: e.order_index
  }));
  saveDraft(workoutState.workout.id, workoutState.draft);
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

// Live "≈ X kg/lb" tag on a set row, recomputed as weight/unit change.
function updateRowEquiv(row) {
  const eqEl = row?.querySelector('[data-eq]');
  if (!eqEl) return;
  if (!workoutState?.showEquiv) { eqEl.textContent = ''; return; }
  const w = row.querySelector('[data-field="weight"] .num-input__field')?.value;
  const u = row.querySelector('[data-unit]')?.textContent.trim();
  eqEl.textContent = weightEquiv(w, u);
}

function markRowTouched(row) {
  if (!row || row.dataset.setId) return;
  if (!workoutState) return;
  row.removeAttribute('data-pristine');
  const exId = Number(row.dataset.ex);
  const setNum = Number(row.dataset.set);
  const wIn = row.querySelector('[data-field="weight"] .num-input__field');
  const rIn = row.querySelector('[data-field="reps"] .num-input__field');
  const uBtn = row.querySelector('[data-unit]');
  const rirAttr = row.dataset.rir;
  workoutState.draft.inputs[`${exId}-${setNum}`] = {
    w: wIn ? wIn.value : '',
    u: uBtn ? uBtn.textContent.trim() : 'kg',
    r: rIn ? rIn.value : '',
    rir: rirAttr === '' || rirAttr == null ? null : Number(rirAttr)
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

// ---------- Workout rendering ----------
async function renderWorkout() {
  const root = $('#view-workout');
  const activeId = Number(localStorage.getItem(LS.activeWorkoutId) || 0);

  if (!activeId) {
    root.innerHTML = `
      <div class="empty">
        <div class="empty__icon">&#x1F4AA;</div>
        <div style="margin-bottom:12px">No active workout</div>
        <button class="btn btn--primary btn--block" data-start-quick>Quick workout</button>
        <button class="btn btn--ghost btn--block" data-go-programs style="margin-top:8px">Pick a program</button>
      </div>`;
    root.onclick = async (e) => {
      if (e.target.closest('[data-go-programs]'))
        document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'programs' }));
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
          notes: null,
          is_bodyweight: !!s.is_bodyweight,
          is_assisted: !!s.is_assisted,
          equipment: s.equipment || null,
          target_sets: Math.max(...workoutState.loggedSets.filter(x => x.exercise_id === s.exercise_id).map(x => x.set_number)),
          target_reps: s.reps,
          order_index: workoutState.programDay.exercises.length + extraById.size
        });
      }
    }
    for (const ex of extraById.values()) workoutState.programDay.exercises.push(ex);

    if (draft.exerciseList?.length) {
      // The user modified this workout's exercises (swap/add/reorder), so the
      // saved list is authoritative. Backfill only exercises that have logged
      // sets but are missing from it — never re-add a swapped-away template one.
      const built = workoutState.programDay.exercises;
      const list = [...draft.exerciseList];
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
    startStickyTimer();
    acquireWakeLock();
    const primeOnce = () => { primeAudio(); document.removeEventListener('click', primeOnce); };
    document.addEventListener('click', primeOnce);
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load workout: ${escapeHtml(err.message)}</div>`;
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
  for (const s of loggedSets) loggedByExerciseSet[`${s.exercise_id}-${s.set_number}`] = s;

  // Program-day "last" wins; otherwise fall back to this exercise's most recent
  // performance anywhere (covers quick workouts + mid-workout-added exercises).
  const lastByExercise = workoutState.lastByExercise || {};
  const bodyHTML = programDay.exercises
    .map((ex) => exerciseCardHTML(ex, lastSetsByExercise[ex.exercise_id] || lastByExercise[ex.exercise_id] || [], loggedByExerciseSet))
    .join('');

  root.innerHTML = `
    <div class="workout-sticky">
      <div>
        <div class="workout-sticky__name">${escapeHtml(programDay.day_label)}</div>
      </div>
      <div class="workout-sticky__time" id="sticky-elapsed">0:00</div>
    </div>
    <div id="rest-sticky" class="rest-sticky hidden"></div>
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
}

function exerciseCardHTML(ex, lastSets, loggedBySet) {
  const target = getSetCount(ex);
  const prevReference = lastSets[0];
  const prefillWeight = prevReference?.weight ?? '';
  const prefillUnit = prevReference?.weight_unit || workoutState.preferredUnit || 'kg';
  const prefillReps = prevReference?.reps ?? ex.target_reps;

  const rec = recommendForNext(ex, lastSets);
  const drafts = workoutState?.draft?.inputs || {};

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

    const w = logged?.weight ?? draft?.w ?? rec?.recWeight ?? prevSet?.weight ?? prefillWeight;
    const u = logged?.weight_unit ?? draft?.u ?? rec?.recUnit ?? prevSet?.weight_unit ?? prefillUnit;
    const r = logged?.reps ?? draft?.r ?? prevSet?.reps ?? prefillReps;
    const rir = draft?.rir ?? null;

    if (!logged && firstUnloggedSet === null) firstUnloggedSet = i;
    rows.push(setRowHTML(ex, i, { w, u, r, rir, logged, isNext: !logged && firstUnloggedSet === i }));
  }

  // Build trend from last 3 finished sessions (oldest → newest top weight)
  const sessions = (workoutState.recentSessions || []).slice(0, 3);
  const trend = sessions.map((session) => {
    const exSets = (session.sets || []).filter((s) => s.exercise_id === ex.exercise_id && !s.is_warmup);
    if (!exSets.length) return null;
    return exSets.reduce((best, s) => loadKg(s, ex) >= loadKg(best, ex) ? s : best, exSets[0]);
  }).filter(Boolean).reverse(); // oldest first

  const hint = rec ? buildProgressionHint(rec, trend) : '';

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
          <div class="card__subtitle">${target} × ${ex.target_reps}${ex.is_assisted ? ' · enter assistance weight (more = easier)' : ex.is_bodyweight ? ' · enter added weight (0 if none)' : ''}${ex.notes ? ` · ${escapeHtml(ex.notes)}` : ''}</div>
        </div>
        <div class="exercise-card__head-actions">
          <button class="btn--icon-text" data-swap-ex="${ex.exercise_id}" title="Swap exercise">&#x21C4; Swap</button>
          <button class="btn--icon-text" data-remove-ex="${ex.exercise_id}" title="Remove exercise" style="color:var(--danger)">&#x2715; Remove</button>
          <button class="badge badge--equipment" data-equip-ex="${ex.exercise_id}" title="Change equipment">${escapeHtml(ex.equipment || 'barbell')}</button>
          <span class="badge badge--muscle">${escapeHtml(ex.muscle_group)}</span>
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

function buildProgressionHint(rec, trend = []) {
  const upArrow = rec.isAssisted ? '&#x2B07;' : '&#x2B06;';
  const upLabel = rec.isAssisted ? 'Reduce assistance' : 'Increase weight';
  const sameLabel = rec.isAssisted ? 'Same assistance' : 'Same weight';

  // Trend line: oldest → newest top weight with direction indicator
  let trendLine = '';
  if (trend.length >= 2) {
    const labels = trend.map((s) => fmtSetWeight(s.weight, s.weight_unit, !!rec.isBodyweight, !!rec.isAssisted));
    const firstKg = loadKg(trend[0], { is_bodyweight: rec.isBodyweight, is_assisted: rec.isAssisted });
    const lastKg  = loadKg(trend[trend.length - 1], { is_bodyweight: rec.isBodyweight, is_assisted: rec.isAssisted });
    const arrow = lastKg > firstKg ? '&#x2197;' : lastKg < firstKg ? '&#x2198;' : '&#x2192;';
    trendLine = `<div class="prog-hint__trend">${labels.join(' &rarr; ')} ${arrow}</div>`;
  }

  if (rec.isProgression) {
    return `
      <div class="prog-hint prog-hint--up">
        <div class="prog-hint__main">${upArrow} ${upLabel} &rarr; <strong>${rec.recDisplay} &times; ${rec.recReps}</strong></div>
        <div class="prog-hint__sub">Last: ${rec.setsLabel} @ ${rec.lastWeight} &times; ${rec.repsList} &mdash; all hit ${rec.recReps}+ &#x2713;</div>
        ${trendLine}
      </div>`;
  } else {
    const gap = rec.recReps - rec.minReps;
    const gapStr = gap > 0 ? ` (${gap} rep${gap > 1 ? 's' : ''} short)` : '';
    const nextStep = rec.isAssisted ? 'reduce assistance' : 'add weight';
    return `
      <div class="prog-hint prog-hint--same">
        <div class="prog-hint__main">&#x1F3AF; ${sameLabel} &mdash; aim for <strong>${rec.recReps} reps</strong> every set</div>
        <div class="prog-hint__sub">Last: ${rec.setsLabel} @ ${rec.lastWeight} &times; ${rec.repsList}${gapStr} &mdash; hit ${rec.recReps} to ${nextStep}</div>
        ${trendLine}
      </div>`;
  }
}

function recommendForNext(ex, lastSets) {
  if (!lastSets.length) return null;
  const targetReps = ex.target_reps;

  let bestKg = 0, bestSet = null;
  for (const s of lastSets) {
    const kg = loadKg(s, ex);
    if (kg > bestKg) { bestKg = kg; bestSet = s; }
  }
  if (!bestSet) return null;

  const workingSets = lastSets.filter(
    (s) => s.weight === bestSet.weight && s.weight_unit === bestSet.weight_unit
  );
  const allHit = workingSets.every((s) => s.reps >= targetReps);

  const unit = bestSet.weight_unit;
  const step = stepForExercise(unit, ex);
  const isBw = !!ex.is_bodyweight;
  const isAssisted = !!ex.is_assisted;

  let recWeight, isProgression;
  if (allHit) {
    if (isAssisted) {
      recWeight = Math.max(0, +(bestSet.weight - step).toFixed(2));
    } else {
      recWeight = +(bestSet.weight + step).toFixed(2);
    }
    isProgression = true;
  } else {
    recWeight = bestSet.weight;
    isProgression = false;
  }

  const repsList = workingSets.map((s) => s.reps).join(', ');
  const setsLabel = workingSets.length === 1 ? '1 set' : `${workingSets.length} sets`;
  const minReps = Math.min(...workingSets.map((s) => s.reps));

  return {
    recWeight, recUnit: unit, recReps: targetReps,
    isProgression, isBodyweight: isBw, isAssisted,
    lastWeight: fmtSetWeight(bestSet.weight, unit, isBw, isAssisted),
    recDisplay: isAssisted
      ? (recWeight === 0 ? 'BW (no assistance)' : `${recWeight}${unit} assistance`)
      : isBw
        ? (recWeight === 0 ? 'BW' : `BW+${recWeight}${unit}`)
        : `${recWeight}${unit}`,
    setsLabel, repsList, minReps
  };
}

function setRowHTML(ex, setNumber, { w, u, r, rir, logged, isNext }) {
  const isBw = !!ex.is_bodyweight;
  const isAssisted = !!ex.is_assisted;
  const showAsEmpty = (isBw || isAssisted) && (w === 0 || w === '' || w == null);
  const wStr = showAsEmpty ? '' : (w === '' ? '' : Number(w));
  const wPlaceholder = isAssisted ? '0 = unassisted' : isBw ? 'BW' : '0';
  const effRir = logged?.rir ?? rir ?? '';
  const note = logged?.notes ?? '';
  // RIR scale 0–4: 0 = to failure, 1 = 1 left, …, 4 = 4+ left
  const rirButtons = [0, 1, 2, 3, 4]
    .map((n) => `<button class="rpe-btn ${Number(effRir) === n && effRir !== '' ? 'rpe-btn--active' : ''}" data-rir="${n}">${n}</button>`)
    .join('');
  const isWarmup = !!(logged?.is_warmup);
  // e1RM badge on logged working sets (not warmups, reps must be > 0)
  let e1rmBadge = '';
  if (logged && !isWarmup && logged.reps > 0) {
    const load = loadKg({ weight: logged.weight, weight_unit: logged.weight_unit }, ex);
    if (load > 0) e1rmBadge = `<span class="set-row__e1rm">~${Math.round(e1RM(load, logged.reps))} kg 1RM</span>`;
  }
  return `
    <div class="set-row ${logged ? 'done' : ''} ${isNext ? 'set-row--next' : ''} ${isWarmup ? 'warmup' : ''}" data-ex="${ex.exercise_id}" data-set="${setNumber}" data-rir="${effRir}" data-warmup="${isWarmup ? 1 : 0}" data-pristine="1" ${logged ? `data-set-id="${logged.id}"` : ''}>
      <button class="set-row__num" data-toggle-warmup title="Tap to mark as warmup">${isWarmup ? 'W' : setNumber}</button>
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
      <div class="set-row__rir" data-rir-group>
        <span class="rpe-group__label" title="Reps in reserve — how many more you could have done">RIR</span>
        ${rirButtons}
        <button class="rpe-btn rpe-btn--clear" data-rir-clear ${effRir !== '' && effRir != null ? '' : 'style="visibility:hidden"'}>×</button>
        <button class="set-row__note-toggle" data-toggle-note title="Add a note">&#x270E;</button>
        <button data-rest class="rest-timer">rest</button>
        <span class="set-row__eq" data-eq>${workoutState?.showEquiv ? weightEquiv(w, u) : ''}</span>
      </div>
      <div class="set-row__extras">
        <input class="set-row__note" data-note placeholder="Form cue, tempo, etc." value="${escapeHtml(note)}"/>
      </div>
      ${e1rmBadge}
      ${logged ? '<div class="set-row__delete" data-delete>Delete</div>' : ''}
    </div>
  `;
}

function wireWorkoutView() {
  const root = $('#view-workout');
  root.onclick = async (e) => {
    if (e.target.closest('[data-finish-workout]')) return finishWorkout();
    if (e.target.closest('[data-cancel-workout]')) return cancelWorkout();
    if (e.target.closest('[data-rest-cancel]')) return cancelRestCountdown();

    // Card-level controls — must be checked before the set-row guard below
    const swapBtn = e.target.closest('[data-swap-ex]');
    if (swapBtn) { haptic(15); openSwapPicker(Number(swapBtn.dataset.swapEx)); return; }

    const removeExBtn = e.target.closest('[data-remove-ex]');
    if (removeExBtn) { haptic(15); removeExerciseFromWorkout(Number(removeExBtn.dataset.removeEx)); return; }

    const equipBtn = e.target.closest('[data-equip-ex]');
    if (equipBtn) { haptic(15); openEquipmentPicker(Number(equipBtn.dataset.equipEx)); return; }

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

    const warmupBtn = e.target.closest('[data-toggle-warmup]');
    if (warmupBtn) {
      const nowWarmup = row.dataset.warmup !== '1';
      row.dataset.warmup = nowWarmup ? '1' : '0';
      row.classList.toggle('warmup', nowWarmup);
      warmupBtn.textContent = nowWarmup ? 'W' : row.dataset.set;
      haptic(10);
      if (row.dataset.setId) API.updateSet(Number(row.dataset.setId), { is_warmup: nowWarmup ? 1 : 0 }).catch(() => {});
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
    if (confirm) return confirmSet(row);

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

  // Undo last set — outside set-row guard, so handle separately
  root.addEventListener('click', async (e) => {
    const undoBtn = e.target.closest('[data-undo-set]');
    if (!undoBtn) return;
    haptic(20);
    await undoLastSet(Number(undoBtn.dataset.undoSet));
  }, { capture: false });


  root.oninput = (e) => {
    const input = e.target.closest('.num-input__field');
    if (!input) return;
    const row = input.closest('.set-row');
    markRowTouched(row);
    updateRowEquiv(row);
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

  attachHoldRepeat(root);
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
  const checkBtn = row.querySelector('[data-confirm]');
  if (checkBtn?.disabled) return;
  primeAudio();

  const exId = Number(row.dataset.ex);
  const setNumber = Number(row.dataset.set);
  const unit = row.querySelector('[data-unit]').textContent.trim();
  const weight = parseFloat(row.querySelector('[data-field="weight"] .num-input__field').value || '0');
  const reps = parseInt(row.querySelector('[data-field="reps"] .num-input__field').value || '0', 10);
  const note = row.querySelector('[data-note]')?.value?.trim() || null;
  const rirRaw = row.dataset.rir;
  const rir = rirRaw === '' || rirRaw == null ? null : Number(rirRaw);
  const isWarmup = row.dataset.warmup === '1';

  const exIsBw = workoutState?.programDay?.exercises?.find((e) => e.exercise_id === exId)?.is_bodyweight;
  if ((weight < 0 || (weight === 0 && !exIsBw) || Number.isNaN(weight)) || !reps) {
    toast(exIsBw ? 'Enter reps (weight can be 0 for bodyweight)' : 'Enter weight and reps first');
    return;
  }

  if (checkBtn) checkBtn.disabled = true;
  try {
    if (row.dataset.setId) {
      await API.updateSet(Number(row.dataset.setId), { weight, weight_unit: unit, reps, rir, notes: note });
      row.classList.remove('editing');
      haptic(20);
      toast('Updated');
    } else {
      const res = await API.logSet({
        workout_id: workoutState.workout.id,
        exercise_id: exId,
        set_number: setNumber,
        weight, weight_unit: unit, reps, rir,
        notes: note,
        is_warmup: isWarmup ? 1 : 0
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
      const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exId);
      startRestCountdown(ex?.rest_seconds ?? undefined);
      // Append e1RM badge to the newly-done row
      if (!isWarmup && reps > 0) {
        const load = loadKg({ weight, weight_unit: unit }, ex);
        if (load > 0) {
          const badge = document.createElement('span');
          badge.className = 'set-row__e1rm';
          badge.textContent = `~${Math.round(e1RM(load, reps))} kg 1RM`;
          row.appendChild(badge);
        }
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

async function undoLastSet(exId) {
  const exSets = workoutState.loggedSets.filter((s) => s.exercise_id === exId);
  if (!exSets.length) return;
  const lastSet = exSets.reduce((a, b) => a.set_number > b.set_number ? a : b);
  try {
    await API.deleteSet(lastSet.id);
    workoutState.loggedSets = workoutState.loggedSets.filter((s) => s.id !== lastSet.id);
    haptic(20);
    toast('Set undone');
    renderWorkoutView();
  } catch (err) { toast(err.message); }
}

async function deleteLoggedSet(row) {
  const id = Number(row.dataset.setId);
  if (!id) return;
  try {
    await API.deleteSet(id);
    workoutState.loggedSets = workoutState.loggedSets.filter((s) => s.id !== id);
    row.classList.remove('done', 'swiped');
    row.removeAttribute('data-set-id');
    const overlay = row.querySelector('[data-delete]');
    if (overlay) overlay.remove();
    haptic(20);
    toast('Set deleted');
  } catch (err) { toast(err.message); }
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

async function openSwapPicker(currentExerciseId) {
  const picker = ensureSheet('swap-picker-sheet');
  picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(picker);

  let exercises;
  try { exercises = await API.exercises(); }
  catch (err) {
    picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    return;
  }

  const currentIdx = workoutState.programDay.exercises.findIndex((e) => e.exercise_id === currentExerciseId);
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
        <button class="btn--icon" id="swap-create-new" title="Create new exercise" style="font-size:20px;font-weight:700">+</button>
      </div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:10px">Pick a replacement. This only affects today's workout.</div>
        <input class="input" id="swap-search" data-picker-search placeholder="Search exercises…" style="margin-bottom:12px"/>
        ${pickerChipsHTML(keys)}
        ${keys.map((g) => `
          <div class="picker-group" data-group="${g}">
            <div class="picker-group__title">${escapeHtml(g)}</div>
            ${groups[g].map((ex) => `
              <button class="picker-row ${ex.id === currentExerciseId ? 'picker-row--added' : ''}" data-swap-pick="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}">
                <span>${escapeHtml(ex.name)}</span>
                <span class="picker-row__state">${ex.id === currentExerciseId ? 'current' : 'pick'}</span>
              </button>`).join('')}
          </div>`).join('')}
      </div>
    </div>`;

  document.getElementById('swap-create-new').onclick = () => openWorkoutNewExerciseForm(picker, {
    onBack: () => openSwapPicker(currentExerciseId),
    onCreated: (ex) => {
      // Swap the current exercise with the newly created one
      workoutState.programDay.exercises[currentIdx] = {
        ...currentEx,
        exercise_id: ex.id,
        name: ex.name,
        muscle_group: ex.muscle_group,
        is_bodyweight: !!ex.is_bodyweight,
        is_assisted: !!ex.is_assisted,
        notes: ex.notes || null
      };
      hideSheet(picker);
      toast(`Swapped to ${ex.name}`);
      renderWorkoutView();
    }
  });

  setupPickerFilter(picker);

  picker.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(picker);
    const pickBtn = e.target.closest('[data-swap-pick]');
    if (!pickBtn) return;
    const newExId = Number(pickBtn.dataset.swapPick);
    if (newExId === currentExerciseId) { toast('Same exercise — nothing to swap'); return; }
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
      name: newEx.name,
      muscle_group: newEx.muscle_group,
      is_bodyweight: !!newEx.is_bodyweight,
      is_assisted: !!newEx.is_assisted,
      equipment: newEx.equipment || 'barbell',
      notes: newEx.notes || null
    };
    if (workoutState.draft.exerciseOrder?.length) {
      workoutState.draft.exerciseOrder = workoutState.draft.exerciseOrder.map(
        (id) => id === currentExerciseId ? newExId : id
      );
    }
    persistExerciseList();
    hideSheet(picker);
    haptic(20);
    toast(`Swapped to ${newEx.name}`);
    renderWorkoutView();
  };
}

async function openWorkoutAddExercisePicker() {
  const picker = ensureSheet('swap-picker-sheet');
  picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(picker);

  let exercises;
  try { exercises = await API.exercises(); }
  catch (err) {
    picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    return;
  }

  const inWorkout = new Set(workoutState.programDay.exercises.map((e) => e.exercise_id));
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
        <div class="sheet__title">Add exercise</div>
        <button class="btn--icon" id="wkadd-create" title="Create new exercise" style="font-size:20px;font-weight:700">+</button>
      </div>
      <div class="sheet__body">
        <input class="input" id="wkadd-search" data-picker-search placeholder="Search exercises…" style="margin-bottom:12px"/>
        ${pickerChipsHTML(keys)}
        ${keys.map((g) => `
          <div class="picker-group" data-group="${g}">
            <div class="picker-group__title">${escapeHtml(g)}</div>
            ${groups[g].map((ex) => `
              <button class="picker-row ${inWorkout.has(ex.id) ? 'picker-row--added' : ''}" data-wkadd="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}">
                <span>${escapeHtml(ex.name)}</span>
                <span class="picker-row__state">${inWorkout.has(ex.id) ? 'added' : 'add'}</span>
              </button>`).join('')}
          </div>`).join('')}
      </div>
    </div>`;

  setupPickerFilter(picker);

  document.getElementById('wkadd-create').onclick = () => openWorkoutNewExerciseForm(picker, {
    onBack: () => openWorkoutAddExercisePicker(),
    onCreated: (ex) => {
      workoutState.programDay.exercises.push({
        id: null,
        exercise_id: ex.id,
        name: ex.name,
        muscle_group: ex.muscle_group,
        notes: ex.notes || null,
        is_bodyweight: !!ex.is_bodyweight,
        is_assisted: !!ex.is_assisted,
        equipment: ex.equipment || 'barbell',
        target_sets: 3,
        target_reps: 10,
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
    const pickBtn = e.target.closest('[data-wkadd]');
    if (!pickBtn) return;
    const exId = Number(pickBtn.dataset.wkadd);
    const newEx = exercises.find((x) => x.id === exId);
    if (!newEx) return;
    if (inWorkout.has(exId)) { toast('Already in this workout'); return; }
    workoutState.programDay.exercises.push({
      id: null,
      exercise_id: exId,
      name: newEx.name,
      muscle_group: newEx.muscle_group,
      notes: newEx.notes || null,
      is_bodyweight: !!newEx.is_bodyweight,
      is_assisted: !!newEx.is_assisted,
      equipment: newEx.equipment || 'barbell',
      target_sets: 3,
      target_reps: 10,
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
  const ok = await confirmSheet({ title: 'Cancel workout', message: 'Cancel this workout? All logged sets will be deleted.', confirmText: 'Cancel workout', cancelText: 'Keep going', danger: true });
  if (!ok) return;
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
  const id = workoutState?.workout?.id;
  if (!id) return;
  if ((workoutState.loggedSets || []).length === 0) {
    // Nothing logged — discard instead of saving an empty workout that would
    // just clutter History.
    const ok = await confirmSheet({ title: 'Nothing logged', message: 'No sets were logged. Discard this workout?', confirmText: 'Discard', danger: true });
    if (!ok) return;
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
  try {
    const finishedWorkout = await API.finishWorkout(id);
    if (stickyTimerHandle) clearInterval(stickyTimerHandle);
    releaseWakeLock();
    cancelRestCountdown();

    const sets = await API.workoutSets(id);
    const totalVolume = sets.reduce((acc, s) => {
      if (s.is_warmup) return acc;
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
      dayId: tmplDayId
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

function renderSummary({ workoutId, sets, volume, duration, newPRs, dayLabel, calories, templateExercises, programId, dayId }) {
  const root = $('#view-workout');
  const calTile = calories
    ? `<div class="summary__tile"><div class="summary__tile-label">Burned (est.)</div><div class="summary__tile-value">${calories}&nbsp;kcal</div></div>`
    : '';
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
    for (const ex of payload) {
      await API.addDayExercise(prog.id, day.id, ex);
    }
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
  const GROUPS = ['chest','back','shoulders','biceps','triceps','arms','legs','core'];
  const EQUIPMENT = ['barbell','dumbbell','cable','machine','bodyweight'];
  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head">
        <button class="btn--icon" id="wknew-back">←</button>
        <div class="sheet__title">New exercise</div>
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <label class="form-label">Name</label>
        <input class="input" id="wknew-name" placeholder="e.g. Cable Pullover"/>
        <label class="form-label" style="margin-top:14px">Muscle group</label>
        <select class="input" id="wknew-muscle">
          ${GROUPS.map((g) => `<option value="${g}">${g}</option>`).join('')}
        </select>
        <label class="form-label" style="margin-top:14px">Sub-muscle (optional)</label>
        <select class="input" id="wknew-sub">${subMuscleOptions(GROUPS[0], '')}</select>
        <label class="form-label" style="margin-top:14px">Also works (optional)</label>
        <div class="sub2-list" id="wknew-sub2"></div>
        <label class="form-label" style="margin-top:14px">Equipment</label>
        <select class="input" id="wknew-equipment">
          ${EQUIPMENT.map((e) => `<option value="${e}">${e}</option>`).join('')}
        </select>
        <label class="form-label" style="margin-top:14px">Notes (optional)</label>
        <input class="input" id="wknew-notes" placeholder="Setup cue or variation"/>
        <button class="btn btn--primary btn--block" id="wknew-save" style="margin-top:20px">Create & add to workout</button>
      </div>
    </div>`;

  document.getElementById('wknew-back').onclick = () => onBack();
  const subSel = document.getElementById('wknew-sub');
  const sub2 = createSecondaryPicker(document.getElementById('wknew-sub2'), () => subSel.value, []);
  document.getElementById('wknew-muscle').onchange = (e) => {
    subSel.innerHTML = subMuscleOptions(e.target.value, '');
    sub2.render();
  };
  subSel.onchange = () => sub2.render();

  document.getElementById('wknew-save').onclick = async () => {
    const name = document.getElementById('wknew-name').value.trim();
    const muscle = document.getElementById('wknew-muscle').value;
    const sub_muscle = subSel.value || null;
    const secondary_muscles = sub2.getSelected();
    const equipment = document.getElementById('wknew-equipment').value;
    const notes = document.getElementById('wknew-notes').value.trim() || null;
    if (!name) return toast('Name required');
    try {
      const ex = await API.addExercise({ name, muscle_group: muscle, sub_muscle, secondary_muscles, equipment, notes });
      haptic(20);
      onCreated(ex);
    } catch (err) { toast(err.message); }
  };
}

export {
  renderWorkout, workoutState, flushWorkoutNotes,
  userBwKg, syncUserBodyweight, loadKg, e1RMForSet,
  saveAsTemplate
};
