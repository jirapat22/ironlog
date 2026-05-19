import { $, $$, LS, escapeHtml, haptic, primeAudio, toast, fmtDuration, stepForExercise, skeletonBlocks, showPRFlash, e1RM, toKg, fmtSetWeight, showSheet, hideSheet, ensureSheet, enableDragReorder, PICKER_GROUP_ORDER, FEEL_OPTIONS, feelEmoji } from './utils.js';
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
    return { setCounts: parsed.setCounts || {}, inputs: parsed.inputs || {}, exerciseOrder: parsed.exerciseOrder, skipped: parsed.skipped || {} };
  } catch {
    return { setCounts: {}, inputs: {}, skipped: {} };
  }
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

function markRowTouched(row) {
  if (!row || row.dataset.setId) return;
  if (!workoutState) return;
  row.removeAttribute('data-pristine');
  const exId = Number(row.dataset.ex);
  const setNum = Number(row.dataset.set);
  const wIn = row.querySelector('[data-field="weight"] .num-input__field');
  const rIn = row.querySelector('[data-field="reps"] .num-input__field');
  const uBtn = row.querySelector('[data-unit]');
  const rpeAttr = row.dataset.rpe;
  workoutState.draft.inputs[`${exId}-${setNum}`] = {
    w: wIn ? wIn.value : '',
    u: uBtn ? uBtn.textContent.trim() : 'kg',
    r: rIn ? rIn.value : '',
    rpe: !rpeAttr || rpeAttr === '0' ? null : Number(rpeAttr)
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
        <button class="btn btn--primary" data-go-programs>Pick a program</button>
      </div>`;
    root.onclick = (e) => {
      if (e.target.closest('[data-go-programs]'))
        document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'programs' }));
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
    if (!programDayId) {
      root.innerHTML = `<div class="empty">Workout has no program day attached.</div>`;
      return;
    }

    const [days, last] = await Promise.all([
      fetchDayDetails(programDayId),
      API.lastWorkout(programDayId).catch(() => null)
    ]);
    await syncUserBodyweight();

    const draft = loadDraft(workout.id);
    workoutState = {
      workout,
      programDay: days,
      last,
      startedAt: workout.started_at,
      loggedSets: [...(workout.sets || [])],
      openExtras: new Set(),
      draft
    };

    if (draft.exerciseOrder?.length) {
      const order = draft.exerciseOrder;
      workoutState.programDay.exercises.sort((a, b) => {
        const ai = order.indexOf(a.exercise_id);
        const bi = order.indexOf(b.exercise_id);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
      });
    }

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
      saveDraft(workoutState.workout.id, workoutState.draft);
    }, { rowSel: '.exercise-card', idKey: 'ex', draggingClass: 'exercise-card--dragging' });
  }
}

function exerciseCardHTML(ex, lastSets, loggedBySet) {
  const target = getSetCount(ex);
  const prevReference = lastSets[0];
  const prefillWeight = prevReference?.weight ?? '';
  const prefillUnit = prevReference?.weight_unit || 'kg';
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
    const rpe = draft?.rpe ?? null;

    if (!logged && firstUnloggedSet === null) firstUnloggedSet = i;
    rows.push(setRowHTML(ex, i, { w, u, r, rpe, logged, isNext: !logged && firstUnloggedSet === i }));
  }

  const hint = rec ? buildProgressionHint(rec) : '';

  // Complete when: explicitly skipped, OR all target sets are logged (no unlogged set found)
  const isComplete = isSkipped || (target > 0 && firstUnloggedSet === null);

  const skipLabel = isSkipped ? 'Skipped — tap to undo' : 'Done with this exercise';
  const cardClasses = `exercise-card${isComplete ? ' exercise-card--complete' : ''}${isSkipped ? ' exercise-card--skipped' : ''}`;

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
      </div>
      <button class="exercise-card__skip" data-skip-ex="${ex.exercise_id}" ${isComplete && !isSkipped ? 'style="display:none"' : ''}>${skipLabel}</button>
    </div>
  `;
}

function buildProgressionHint(rec) {
  const upArrow = rec.isAssisted ? '&#x2B07;' : '&#x2B06;';
  const upLabel = rec.isAssisted ? 'Reduce assistance' : 'Increase weight';
  const sameLabel = rec.isAssisted ? 'Same assistance' : 'Same weight';

  if (rec.isProgression) {
    return `
      <div class="prog-hint prog-hint--up">
        <div class="prog-hint__main">${upArrow} ${upLabel} &rarr; <strong>${rec.recDisplay} &times; ${rec.recReps}</strong></div>
        <div class="prog-hint__sub">Last: ${rec.setsLabel} @ ${rec.lastWeight} &times; ${rec.repsList} &mdash; all hit ${rec.recReps}+ &#x2713;</div>
      </div>`;
  } else {
    const gap = rec.recReps - rec.minReps;
    const gapStr = gap > 0 ? ` (${gap} rep${gap > 1 ? 's' : ''} short)` : '';
    const nextStep = rec.isAssisted ? 'reduce assistance' : 'add weight';
    return `
      <div class="prog-hint prog-hint--same">
        <div class="prog-hint__main">&#x1F3AF; ${sameLabel} &mdash; aim for <strong>${rec.recReps} reps</strong> every set</div>
        <div class="prog-hint__sub">Last: ${rec.setsLabel} @ ${rec.lastWeight} &times; ${rec.repsList}${gapStr} &mdash; hit ${rec.recReps} to ${nextStep}</div>
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

function setRowHTML(ex, setNumber, { w, u, r, rpe, logged, isNext }) {
  const isBw = !!ex.is_bodyweight;
  const isAssisted = !!ex.is_assisted;
  const showAsEmpty = (isBw || isAssisted) && (w === 0 || w === '' || w == null);
  const wStr = showAsEmpty ? '' : (w === '' ? '' : Number(w));
  const wPlaceholder = isAssisted ? '0 = unassisted' : isBw ? 'BW' : '0';
  const effRpe = logged?.rpe ?? rpe ?? '';
  const note = logged?.notes ?? '';
  const rpeButtons = [6, 7, 8, 9, 10]
    .map((n) => `<button class="rpe-btn ${Number(effRpe) === n ? 'rpe-btn--active' : ''}" data-rpe="${n}">${n}</button>`)
    .join('');
  const rpeBadge = effRpe && Number(effRpe) >= 6 ? `<span class="set-row__rpe-badge" data-rpe-badge>RPE ${effRpe}</span>` : '';
  const isWarmup = !!(logged?.is_warmup);
  return `
    <div class="set-row ${logged ? 'done' : ''} ${isNext ? 'set-row--next' : ''} ${isWarmup ? 'warmup' : ''}" data-ex="${ex.exercise_id}" data-set="${setNumber}" data-rpe="${effRpe}" data-warmup="${isWarmup ? 1 : 0}" data-pristine="1" ${logged ? `data-set-id="${logged.id}"` : ''}>
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
      <div class="set-row__extras">
        <div class="set-row__tools">
          <button data-toggle-note>&#x270E; note</button>
          <button data-rest class="rest-timer">start rest</button>
          <div class="rpe-group" data-rpe-group>
            <span class="rpe-group__label">RPE</span>
            ${rpeButtons}
            ${effRpe !== '' && effRpe != null ? '<button class="rpe-btn rpe-btn--clear" data-rpe-clear>×</button>' : ''}
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
    if (e.target.closest('[data-finish-workout]')) return finishWorkout();
    if (e.target.closest('[data-cancel-workout]')) return cancelWorkout();
    if (e.target.closest('[data-rest-cancel]')) return cancelRestCountdown();

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
      return;
    }

    const stepBtn = e.target.closest('.num-input__btn');
    if (stepBtn) { fireStep(stepBtn, row); return; }

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
      if (row.dataset.setId) persistRpeChange(row);
      else markRowTouched(row);
      updateRpeBadge(row);
      return;
    }

    if (e.target.closest('[data-rpe-clear]')) {
      row.dataset.rpe = '';
      row.querySelectorAll('.rpe-btn').forEach((b) => b.classList.remove('rpe-btn--active'));
      if (row.dataset.setId) persistRpeChange(row);
      else markRowTouched(row);
      updateRpeBadge(row);
      return;
    }

    const restBtn = e.target.closest('[data-rest]');
    if (restBtn) return toggleRestTimer();

    const delBtn = e.target.closest('[data-delete]');
    if (delBtn) return deleteLoggedSet(row);
  };

  root.addEventListener('click', async (e) => {
    const swapBtn = e.target.closest('[data-swap-ex]');
    if (swapBtn) { e.stopPropagation(); haptic(15); openSwapPicker(Number(swapBtn.dataset.swapEx)); return; }
    const skipBtn = e.target.closest('[data-skip-ex]');
    if (skipBtn) { e.stopPropagation(); haptic(15); skipRemainingForExercise(Number(skipBtn.dataset.skipEx)); return; }
    if (e.target.closest('[data-add-workout-ex]')) { haptic(15); openWorkoutAddExercisePicker(); return; }

    const addRow = e.target.closest('[data-add-set-row]');
    if (addRow) {
      e.stopPropagation(); haptic(10);
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
      e.stopPropagation();
      const exId = Number(removeRow.dataset.removeSetRow);
      const ex = workoutState.programDay.exercises.find((x) => x.exercise_id === exId);
      if (!ex) return;
      const current = getSetCount(ex);
      const loggedMax = Math.max(
        0,
        ...workoutState.loggedSets.filter((s) => s.exercise_id === exId).map((s) => s.set_number)
      );
      if (current <= loggedMax) { toast('Delete a logged set first'); return; }
      if (current <= 1) return;
      haptic(10);
      workoutState.draft.setCounts[exId] = current - 1;
      delete workoutState.draft.inputs[`${exId}-${current}`];
      saveDraft(workoutState.workout.id, workoutState.draft);
      renderWorkoutView();
    }
  });

  root.addEventListener('input', (e) => {
    const input = e.target.closest('.num-input__field');
    if (!input) return;
    markRowTouched(input.closest('.set-row'));
  });

  root.addEventListener('focusin', (e) => {
    const input = e.target.closest('.num-input__field');
    if (!input) return;
    const row = input.closest('.set-row');
    if (!row || !row.classList.contains('done')) return;
    row.classList.add('editing');
  });
  root.addEventListener('focusout', (e) => {
    const input = e.target.closest('.num-input__field');
    if (!input) return;
    const row = input.closest('.set-row');
    if (!row) return;
    setTimeout(() => row.classList.remove('editing'), 200);
  });

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
  let holdTimer = null, holdInterval = null, activeBtn = null;
  const stop = () => { clearTimeout(holdTimer); clearInterval(holdInterval); holdTimer = null; holdInterval = null; activeBtn = null; };
  container.addEventListener('pointerdown', (e) => {
    const btn = e.target.closest('.num-input__btn');
    if (!btn) return;
    activeBtn = btn;
    holdTimer = setTimeout(() => {
      let delay = 120;
      holdInterval = setInterval(() => {
        if (!activeBtn) return stop();
        fireStep(activeBtn, activeBtn.closest('.set-row'));
        delay = Math.max(40, delay - 10);
      }, delay);
    }, 400);
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
  const rpeRaw = row.dataset.rpe;
  const rpe = !rpeRaw || rpeRaw === '0' ? null : Number(rpeRaw);
  const isWarmup = row.dataset.warmup === '1';

  const exIsBw = workoutState?.programDay?.exercises?.find((e) => e.exercise_id === exId)?.is_bodyweight;
  if ((weight < 0 || (weight === 0 && !exIsBw) || Number.isNaN(weight)) || !reps) {
    toast(exIsBw ? 'Enter reps (weight can be 0 for bodyweight)' : 'Enter weight and reps first');
    return;
  }

  if (checkBtn) checkBtn.disabled = true;
  try {
    if (row.dataset.setId) {
      await API.updateSet(Number(row.dataset.setId), { weight, weight_unit: unit, reps, rpe, notes: note });
      row.classList.remove('editing');
      haptic(20);
      toast('Updated');
    } else {
      const res = await API.logSet({
        workout_id: workoutState.workout.id,
        exercise_id: exId,
        set_number: setNumber,
        weight, weight_unit: unit, reps, rpe,
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
      startRestCountdown();
    }
    updateRpeBadge(row);
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

async function persistRpeChange(row) {
  const setId = Number(row.dataset.setId);
  if (!setId) return;
  const raw = row.dataset.rpe;
  const rpe = raw === '' || raw == null ? null : Number(raw);
  try { await API.updateSet(setId, { rpe }); } catch (err) { toast(err.message); }
}

function updateRpeBadge(row) {
  const existing = row.querySelector('[data-rpe-badge]');
  const raw = row.dataset.rpe;
  if (raw === '' || raw == null) { existing?.remove(); return; }
  if (existing) { existing.textContent = `RPE ${raw}`; }
  else {
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

  skipBtn?.addEventListener('click', (e) => {
    if (!card.classList.contains('exercise-card--skipped')) return;
    e.stopPropagation();
    // Un-skip: remove from draft, re-render so the hidden rows come back
    if (workoutState.draft.skipped) {
      delete workoutState.draft.skipped[exerciseId];
      saveDraft(workoutState.workout.id, workoutState.draft);
    }
    renderWorkoutView();
  }, { once: true });

  toast(`Skipped ${unlogged.length} remaining set${unlogged.length > 1 ? 's' : ''}`);
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
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:10px">Pick a replacement. This only affects today's workout.</div>
        <input class="input" id="swap-search" placeholder="Search exercises…" style="margin-bottom:12px"/>
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

  const search = document.getElementById('swap-search');
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    picker.querySelectorAll('.picker-row').forEach((r) => r.classList.toggle('hidden', q && !r.dataset.name.includes(q)));
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
    if (newExId === currentExerciseId) { toast('Same exercise — nothing to swap'); return; }
    const newEx = exercises.find((x) => x.id === newExId);
    if (!newEx) return;

    const logged = workoutState.loggedSets.filter((s) => s.exercise_id === currentExerciseId);
    if (logged.length) {
      const msg = `Delete ${logged.length} logged set${logged.length > 1 ? 's' : ''} for ${currentEx.name} and swap?`;
      if (!confirm(msg)) return;
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
      notes: newEx.notes || null
    };
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
        <span style="width:40px"></span>
      </div>
      <div class="sheet__body">
        <input class="input" id="wkadd-search" placeholder="Search exercises…" style="margin-bottom:12px"/>
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

  const search = document.getElementById('wkadd-search');
  search.oninput = () => {
    const q = search.value.trim().toLowerCase();
    picker.querySelectorAll('.picker-row').forEach((r) => r.classList.toggle('hidden', q && !r.dataset.name.includes(q)));
    picker.querySelectorAll('.picker-group').forEach((g) => {
      const any = [...g.querySelectorAll('.picker-row')].some((r) => !r.classList.contains('hidden'));
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
    if (inWorkout.has(exId)) { toast('Already in this workout'); return; }
    workoutState.programDay.exercises.push({
      id: null,
      exercise_id: exId,
      name: newEx.name,
      muscle_group: newEx.muscle_group,
      notes: newEx.notes || null,
      is_bodyweight: !!newEx.is_bodyweight,
      is_assisted: !!newEx.is_assisted,
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
  if (!confirm('Cancel this workout? All logged sets will be deleted.')) return;
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
    if (!confirm('No sets logged. Finish this workout anyway? It will show in History as empty.')) return;
  }
  try {
    await API.finishWorkout(id);
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

    const finishedWorkout = await API.workout(id);
    renderSummary({
      workoutId: id,
      sets: sets.length,
      volume: totalVolume,
      duration: fmtDuration(workoutState.startedAt, new Date().toISOString()),
      newPRs,
      dayLabel: workoutState.programDay.day_label,
      calories: finishedWorkout.calories_burned ?? null
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

function renderSummary({ workoutId, sets, volume, duration, newPRs, dayLabel, calories }) {
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
      <button class="btn btn--primary btn--block" data-go-programs>Done</button>
    </div>
  `;

  root.onclick = async (e) => {
    if (e.target.closest('[data-go-programs]'))
      return document.dispatchEvent(new CustomEvent('ironlog:switch-tab', { detail: 'programs' }));
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

export {
  renderWorkout, workoutState, flushWorkoutNotes,
  userBwKg, syncUserBodyweight, loadKg, e1RMForSet
};
