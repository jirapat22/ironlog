import { $, LS, escapeHtml, haptic, toast, fmtSetWeight, fmtReps, skeletonBlocks, showSheet, hideSheet, ensureSheet, confirmSheet, showBadgeDetail, formatDateShort, PICKER_GROUP_ORDER, FEEL_OPTIONS, feelEmoji, stepForExercise, muscleTagHTML, pickerChipsHTML, setupPickerFilter, weightEquiv, e1RM, toKg, subMuscleShadeClass, exerciseSortHTML, sortExercisesBy } from './utils.js';

let showEquiv = true; // mirrors the show_weight_equiv setting; refreshed in renderHistory
import { API } from './api.js';
import { saveAsTemplate, openActivitySheet } from './workout.js';
import { reportHandled } from './bugreport.js';

// ---------- HISTORY tab ----------
// Kind filter (All / Strength / Cardio) — a workout that logs lots of walks
// otherwise buries strength sessions in scroll; this hides the other kind
// outright rather than just visually distinguishing the cards. Persists
// across visits (same tier as other lightweight UI-only prefs).
const HISTORY_KIND_FILTERS = [
  { key: 'all', label: 'All' },
  { key: 'strength', label: 'Strength' },
  { key: 'activity', label: 'Cardio' }
];

function historyKindFilterHTML(current) {
  return `<div class="ex-sort" data-history-kind style="margin-bottom:12px">
    ${HISTORY_KIND_FILTERS.map((f) => `<button class="ex-sort__btn${f.key === current ? ' ex-sort__btn--active' : ''}" data-kind="${f.key}">${f.label}</button>`).join('')}
  </div>`;
}

async function renderHistory() {
  const root = $('#view-history');
  let kindFilter = localStorage.getItem(LS.historyKindFilter) || 'all';
  root.innerHTML = `
    ${historyKindFilterHTML(kindFilter)}
    <input class="input" id="history-filter" placeholder="Filter by exercise name…" style="margin-bottom:12px"/>
    <div id="history-list">${skeletonBlocks(4)}</div>
  `;

  try {
    const [history, settings] = await Promise.all([API.history(), API.settings().catch(() => ({}))]);
    showEquiv = settings.show_weight_equiv !== '0';
    const list = $('#history-list');

    if (!history.length) { list.innerHTML = `<div class="empty">No workouts yet</div>`; return; }
    list.innerHTML = history.map((w) => historyCardHTML(w)).join('') +
      `<div class="empty hidden" id="history-empty-filtered"></div>`;

    // Combines the name-search text and the kind toggle — a card must match
    // both to stay visible. When a filter hides EVERY card, show a message
    // instead of silent blank space that looks like a broken/loading screen.
    const applyFilters = () => {
      const f = list.dataset.filter || '';
      let anyVisible = false;
      [...list.querySelectorAll('.history-card')].forEach((card) => {
        const isActivity = card.classList.contains('history-card--activity');
        const kindMatch = kindFilter === 'all' || (kindFilter === 'activity') === isActivity;
        const hay = card.dataset.exerciseNames || '';
        const textMatch = !f || hay.includes(f);
        const visible = kindMatch && textMatch;
        card.classList.toggle('hidden', !visible);
        if (visible) anyVisible = true;
      });
      const emptyEl = list.querySelector('#history-empty-filtered');
      if (emptyEl) {
        emptyEl.classList.toggle('hidden', anyVisible);
        if (!anyVisible) {
          const kindLabel = HISTORY_KIND_FILTERS.find((k) => k.key === kindFilter)?.label;
          emptyEl.textContent = f
            ? `No ${kindFilter !== 'all' ? kindLabel.toLowerCase() + ' ' : ''}workouts match "${f}"`
            : `No ${kindLabel.toLowerCase()} sessions yet`;
        }
      }
    };

    $('#history-filter').oninput = (e) => {
      list.dataset.filter = e.target.value.trim().toLowerCase();
      applyFilters();
    };

    root.querySelector('[data-history-kind]').onclick = (e) => {
      const btn = e.target.closest('[data-kind]');
      if (!btn) return;
      kindFilter = btn.dataset.kind;
      localStorage.setItem(LS.historyKindFilter, kindFilter);
      root.querySelectorAll('[data-history-kind] .ex-sort__btn').forEach((b) =>
        b.classList.toggle('ex-sort__btn--active', b.dataset.kind === kindFilter));
      haptic(10);
      applyFilters();
    };

    applyFilters(); // apply the persisted kind filter immediately on load

    list.onclick = async (e) => {
      // Checked first: a status badge (New PR) can sit INSIDE the set-row
      // button, so its detail popup must intercept the click before it also
      // opens the edit-set sheet underneath it.
      const badgeBtn = e.target.closest('[data-badge-title]');
      if (badgeBtn) {
        e.stopPropagation();
        showBadgeDetail(badgeBtn.dataset.badgeTitle, badgeBtn.dataset.badgeMsg);
        return;
      }

      const editSetBtn = e.target.closest('[data-edit-set]');
      if (editSetBtn) {
        e.stopPropagation();
        const card = editSetBtn.closest('.history-card');
        openEditSetSheet(Number(editSetBtn.dataset.editSet), Number(card.dataset.id));
        return;
      }

      const addSetBtn = e.target.closest('[data-add-set]');
      if (addSetBtn) {
        e.stopPropagation();
        const card = addSetBtn.closest('.history-card');
        openAddSetSheet(Number(addSetBtn.dataset.addSet), Number(card.dataset.id), Number(addSetBtn.dataset.nextSet), addSetBtn.dataset.exName);
        return;
      }

      const addExBtn = e.target.closest('[data-add-history-ex]');
      if (addExBtn) {
        e.stopPropagation();
        const card = addExBtn.closest('.history-card');
        openHistoryAddExercisePicker(Number(card.dataset.id));
        return;
      }

      const removeExBtn = e.target.closest('[data-remove-ex]');
      if (removeExBtn) {
        e.stopPropagation();
        const card = removeExBtn.closest('.history-card');
        const exId = Number(removeExBtn.dataset.removeEx);
        const exName = removeExBtn.dataset.exName || 'this exercise';
        const ok = await confirmSheet({ title: 'Remove exercise', message: `Remove "${exName}" and all its sets from this workout? This can't be undone.`, confirmText: 'Remove', danger: true });
        if (!ok) return;
        try {
          const resp = await API.removeWorkoutExercise(Number(card.dataset.id), exId);
          haptic(20);
          if (resp.workout_deleted) { toast('Workout removed — no exercises left'); card.remove(); }
          else await refreshHistoryCard(Number(card.dataset.id));
        } catch (err) { toast(err.message); }
        return;
      }

      const feelBtn = e.target.closest('[data-history-feel]');
      if (feelBtn) {
        e.stopPropagation();
        const card = feelBtn.closest('.history-card');
        const id = Number(card.dataset.id);
        const rating = Number(feelBtn.dataset.historyFeel);
        const willClear = feelBtn.classList.contains('feel-btn--active');
        const newVal = willClear ? null : rating;
        try {
          await API.updateFeel(id, newVal);
          card.querySelectorAll('[data-history-feel]').forEach((b) =>
            b.classList.toggle('feel-btn--active', !willClear && Number(b.dataset.historyFeel) === rating)
          );
          const meta = card.querySelector('.history-card__meta');
          if (meta) {
            const baseText = meta.textContent.split(' · ').slice(0, 2).join(' · ');
            meta.textContent = newVal ? `${baseText} · ${feelEmoji(newVal)}` : baseText;
          }
          haptic(15);
        } catch (err) { toast(err.message); }
        return;
      }

      const editActivityBtn = e.target.closest('[data-edit-activity]');
      if (editActivityBtn) {
        e.stopPropagation();
        const card = editActivityBtn.closest('.history-card');
        const id = Number(card.dataset.id);
        try {
          const workout = await API.workout(id);
          openActivitySheet(workout, { onSaved: () => refreshHistoryCard(id) });
        } catch (err) { toast(err.message); }
        return;
      }

      const delWorkoutBtn = e.target.closest('[data-delete-workout]');
      if (delWorkoutBtn) {
        e.stopPropagation();
        const card = delWorkoutBtn.closest('.history-card');
        const ok = await confirmSheet({ title: 'Delete workout', message: 'Delete this workout and all its sets? This cannot be undone.', confirmText: 'Delete', danger: true });
        if (!ok) return;
        try {
          await API.deleteWorkout(Number(card.dataset.id));
          renderHistory();
        } catch (err) { toast(err.message); }
        return;
      }

      const saveTplBtn = e.target.closest('[data-save-template-history]');
      if (saveTplBtn) {
        e.stopPropagation();
        const card = saveTplBtn.closest('.history-card');
        const dayLabel = card.querySelector('.history-card__title')?.textContent || 'My Workout';
        // templateExercises is captured in the closure from loadHistoryCardBody
        const tplData = card._templateExercises;
        if (tplData) saveAsTemplate(tplData, dayLabel);
        return;
      }

      if (e.target.closest('[data-history-notes], .history-ex__sets, .history-card__body-actions')) return;

      const head = e.target.closest('.history-card__head');
      if (!head) return;
      const card = head.closest('.history-card');
      card.classList.toggle('expanded');
      if (card.classList.contains('expanded') && !card.dataset.loaded) await loadHistoryCardBody(card);
    };

    // Long-press on card head → delete (600ms)
    let _lpTimer = null, _lpStartX = 0, _lpStartY = 0;
    list.addEventListener('pointerdown', (e) => {
      const head = e.target.closest('.history-card__head');
      if (!head) return;
      const card = head.closest('.history-card');
      _lpStartX = e.clientX; _lpStartY = e.clientY;
      _lpTimer = setTimeout(async () => {
        _lpTimer = null;
        haptic([30, 30, 60]);
        const ok = await confirmSheet({ title: 'Delete workout', message: 'Delete this workout and all its sets? This cannot be undone.', confirmText: 'Delete', danger: true });
        if (!ok) return;
        try { await API.deleteWorkout(Number(card.dataset.id)); card.remove(); haptic(30); }
        catch (err) { toast(err.message); }
      }, 600);
    });
    list.addEventListener('pointermove', (e) => {
      if (!_lpTimer) return;
      if (Math.abs(e.clientX - _lpStartX) > 10 || Math.abs(e.clientY - _lpStartY) > 10) { clearTimeout(_lpTimer); _lpTimer = null; }
    });
    const cancelLp = () => { clearTimeout(_lpTimer); _lpTimer = null; };
    list.addEventListener('pointerup', cancelLp);
    list.addEventListener('pointercancel', cancelLp);

    list.addEventListener('focusout', async (e) => {
      const notesInput = e.target.closest('[data-history-notes]');
      if (!notesInput) return;
      const card = notesInput.closest('.history-card');
      const id = Number(card.dataset.id);
      const value = notesInput.value.trim() || null;
      const prev = notesInput.dataset.prev || null;
      if (value === prev) return;
      try { await API.updateWorkout(id, { notes: value }); notesInput.dataset.prev = value ?? ''; }
      catch (err) { toast(err.message); }
    });
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load history: ${escapeHtml(err.message)}</div>`;
  }
}

// showSkeleton=false is for refreshing an ALREADY-rendered card (e.g. right
// after saving an edited set): collapsing it to an 80px skeleton first, then
// back to full height once the re-fetch resolves, shrank-then-regrew the
// card in place — everything below it jumped up and then snapped back down,
// reported as the page "pushing downward" right when an edit finished. Keep
// the existing (already correctly-sized) content on screen until the fresh
// content is ready, so there's one direct height change instead of two.
async function loadHistoryCardBody(card, { showSkeleton = true } = {}) {
  const id = Number(card.dataset.id);
  const body = card.querySelector('.history-card__body');
  if (showSkeleton) body.innerHTML = `<div class="skeleton" style="height:80px"></div>`;
  try {
    const [sets, workout] = await Promise.all([API.workoutSets(id), API.workout(id)]);

    if (workout.kind === 'activity') {
      let tags = [];
      try { tags = JSON.parse(workout.muscle_tags || '[]'); } catch { tags = []; }
      body.innerHTML = `
        <div class="history-activity">
          <div class="history-activity__line"><span>Duration</span><strong>${workout.duration_min || 0} min</strong></div>
          ${workout.distance ? `<div class="history-activity__line"><span>Distance</span><strong>${workout.distance} ${escapeHtml(workout.distance_unit || '')}</strong></div>` : ''}
          ${workout.rpe ? `<div class="history-activity__line"><span>Intensity</span><strong>RPE ${workout.rpe}</strong></div>` : ''}
          ${workout.calories_burned ? `<div class="history-activity__line"><span>Calories</span><strong>~${workout.calories_burned} kcal</strong></div>` : ''}
          ${tags.length ? `<div class="history-activity__line"><span>Worked</span><strong>${tags.map(escapeHtml).join(', ')}</strong></div>` : ''}
        </div>
        <label class="form-label" style="margin-top:12px">Notes</label>
        <textarea class="input" data-history-notes rows="2" data-prev="${escapeHtml(workout.notes || '')}" placeholder="How did it go?">${escapeHtml(workout.notes || '')}</textarea>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn--ghost btn--sm" data-edit-activity style="flex:1">Edit</button>
          <button class="btn btn--ghost btn--sm" data-delete-workout style="color:var(--danger)">Delete</button>
        </div>`;
      card.dataset.loaded = '1';
      card.dataset.exerciseNames = '';
      return;
    }

    // Map, NOT a plain object: numeric-string keys in an object iterate in
    // ASCENDING NUMERIC order, which displayed exercises sorted by database id
    // instead of the order they were performed. Map preserves insertion order,
    // and sets arrive ordered by logged_at.
    const grouped = new Map();
    for (const s of sets) {
      if (!grouped.has(s.exercise_id)) grouped.set(s.exercise_id, {
        exerciseId: s.exercise_id, name: s.exercise_name, muscle: s.muscle_group, sub: s.sub_muscle,
        isBodyweight: s.is_bodyweight, isAssisted: s.is_assisted,
        trendStatus: s.trend_status, isFirstTime: s.is_first_time, trendPoints: s.trend_points,
        sets: []
      });
      grouped.get(s.exercise_id).sets.push(s);
    }
    for (const g of grouped.values()) g.sets.sort((a, b) => a.set_number - b.set_number);

    // Same status tags as the live workout hint (workout.js's classifyTrend),
    // computed server-side since they need the PRIOR session's sets, which
    // this card doesn't otherwise fetch. Each badge is a button carrying its
    // own detail message in data attributes — tap it to see the specifics.
    const badgeAttrs = (title, msg) => `data-badge-title="${escapeHtml(title)}" data-badge-msg="${escapeHtml(msg)}"`;
    const pointLabel = (g, p) => `${fmtSetWeight(p.weight, p.unit, g.isBodyweight, g.isAssisted)} on ${formatDateShort(p.date)}`;
    const trendBadgeHTML = (g) => {
      if (g.isFirstTime) {
        return `<button class="history-ex__trend history-ex__trend--first" ${badgeAttrs('First time', `No previous sessions logged for ${g.name} yet — this is the first one on record.`)}>&#x1F195; First time</button>`;
      }
      const points = g.trendPoints || [];
      if (g.trendStatus === 'decline') {
        const [prior, cur] = points.slice(-2);
        const msg = prior && cur ? `Dropped from ${pointLabel(g, prior)} to ${fmtSetWeight(cur.weight, cur.unit, g.isBodyweight, g.isAssisted)} this session.` : 'Dropped from the previous session.';
        return `<button class="history-ex__trend history-ex__trend--decline" ${badgeAttrs('Decline', msg)}>&#x2198; Decline</button>`;
      }
      if (g.trendStatus === 'plateau') {
        const [prior] = points.slice(-2);
        const msg = prior ? `Same weight as your last session — ${pointLabel(g, prior)}.` : 'Same weight as your last session.';
        return `<button class="history-ex__trend history-ex__trend--plateau" ${badgeAttrs('Plateau', msg)}>&#x23F8; Plateau</button>`;
      }
      if (g.trendStatus === 'up') {
        const msg = points.length ? `Trending up: ${points.map((p) => pointLabel(g, p)).join(' → ')}.` : 'Two sessions in a row of weight increases.';
        return `<button class="history-ex__trend history-ex__trend--up" ${badgeAttrs('Going up', msg)}>&#x2B06; Going up</button>`;
      }
      return '';
    };

    const exHTML = [...grouped.values()].map((g) => `
      <div class="history-ex" data-ex="${g.exerciseId}">
        <div class="history-ex__head">
          <div class="history-ex__name">${escapeHtml(g.name)}${g.muscle ? ` ${muscleTagHTML(g.muscle, g.sub)}` : ''} ${trendBadgeHTML(g)}</div>
          <button class="history-ex__remove" data-remove-ex="${g.exerciseId}" data-ex-name="${escapeHtml(g.name)}" title="Remove exercise">&#x2715;</button>
        </div>
        <div class="history-ex__sets">
          ${g.sets.map((s) => `
            <button class="history-ex__set" data-edit-set="${s.id}">
              <span class="history-ex__set-n">Set ${s.set_number}</span>
              <span class="history-ex__set-w">${fmtSetWeight(s.weight, s.weight_unit, s.is_bodyweight, s.is_assisted)} × ${fmtReps(s.reps, s.reps_r, s.reps_l)}</span>
              ${s.is_pr ? `<span class="history-ex__set-pr" ${badgeAttrs('New PR', `New personal record: ${fmtSetWeight(s.weight, s.weight_unit, s.is_bodyweight, s.is_assisted)} × ${s.reps} reps.`)}>&#x1F3C6;</span>` : ''}
              ${showEquiv && !s.is_bodyweight && !s.is_assisted && weightEquiv(s.weight, s.weight_unit) ? `<span class="history-ex__set-aux">${weightEquiv(s.weight, s.weight_unit)}</span>` : ''}
              ${!s.is_warmup && !s.is_bodyweight && !s.is_assisted && s.reps > 0 && s.weight > 0 ? `<span class="history-ex__set-aux">~${Math.round(e1RM(toKg(s.weight, s.weight_unit), s.reps))}kg 1RM</span>` : ''}
              ${s.rir != null ? `<span class="history-ex__set-rpe">RIR ${s.rir}</span>` : ''}
              ${s.rpe != null ? `<span class="history-ex__set-rpe">@${s.rpe}</span>` : ''}
              ${s.notes ? `<span class="history-ex__set-note">${escapeHtml(s.notes)}</span>` : ''}
            </button>`).join('')}
          <button class="history-ex__addset" data-add-set="${g.exerciseId}" data-next-set="${g.sets.length + 1}" data-ex-name="${escapeHtml(g.name)}">+ Add set</button>
        </div>
      </div>`).join('');

    const notes = workout.notes || '';
    const currentFeel = workout.feel_rating;
    const feelButtons = FEEL_OPTIONS.map((o) => `
      <button class="feel-btn feel-btn--small ${currentFeel === o.v ? 'feel-btn--active' : ''}" data-history-feel="${o.v}" title="${o.label}">
        <span class="feel-btn__emoji">${o.emoji}</span>
        <span class="feel-btn__label">${o.label}</span>
      </button>`).join('');

    // Build template data from the grouped sets for "Save as template" button
    const templateExercises = [...grouped.values()].map((g) => {
      const workingSets = g.sets.filter((s) => !s.is_warmup);
      if (!workingSets.length) return null;
      const lastSet = workingSets[workingSets.length - 1];
      return {
        exercise_id: g.exerciseId,
        name: g.name,
        target_sets: Math.max(...workingSets.map((s) => s.set_number)),
        target_reps: lastSet.reps,
        rest_seconds: null
      };
    }).filter(Boolean);

    body.innerHTML = `
      ${exHTML || '<div class="empty">No sets logged</div>'}
      <button class="btn btn--ghost btn--block" data-add-history-ex style="margin-top:10px">+ Add exercise</button>
      <div class="history-card__body-actions">
        <label class="form-label">How did it feel?</label>
        <div class="feel-prompt__options">${feelButtons}</div>
        <label class="form-label" style="margin-top:14px">Workout notes</label>
        <textarea class="input" data-history-notes rows="2" data-prev="${escapeHtml(notes)}" placeholder="How did it go?">${escapeHtml(notes)}</textarea>
        <div style="display:flex;gap:8px;margin-top:10px">
          <button class="btn btn--ghost btn--sm" data-save-template-history style="flex:1">&#x1F4CB; Save as template</button>
          <button class="btn btn--ghost btn--sm" data-delete-workout style="color:var(--danger)">Delete</button>
        </div>
      </div>`;
    card._templateExercises = templateExercises;
    card.dataset.loaded = '1';
    card.dataset.exerciseNames = [...grouped.values()].map((g) => g.name.toLowerCase()).join('|');
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
    const wasExpanded = card.classList.contains('expanded');
    if (w.kind === 'activity') {
      // Activity head (meta line, calorie stat) is derived straight from the
      // row, so a field edit (duration/RPE/etc.) needs the whole head
      // re-rendered, not just the stats tile the strength-workout path patches.
      card.outerHTML = historyCardHTML(w);
      const fresh = document.querySelector(`.history-card[data-id="${workoutId}"]`);
      if (wasExpanded && fresh) { fresh.classList.add('expanded'); await loadHistoryCardBody(fresh); }
      return;
    }
    const stats = card.querySelector('.history-card__stats');
    if (stats) stats.innerHTML = `${w.total_sets} sets<br/>${Math.round(w.total_volume).toLocaleString()} kg`;
    if (wasExpanded) { card.dataset.loaded = ''; await loadHistoryCardBody(card, { showSkeleton: false }); }
  } catch (err) { toast(err.message); }
}

const ACTIVITY_LABELS = {
  hyrox: 'HYROX', run: 'Run', cycle: 'Cycle', row: 'Row', swim: 'Swim',
  walk: 'Walk', cardio: 'Cardio', class: 'Class', other: 'Activity'
};

function historyCardHTML(w) {
  const started = new Date(w.started_at.replace(' ', 'T') + 'Z');
  // Lowercased, pipe-joined exercise names for the "filter by exercise" box —
  // set on the card up front so COLLAPSED cards filter too (they used to only
  // get this after being expanded, which is why the filter did nothing).
  const exAttr = `data-exercise-names="${escapeHtml((w.exercise_names || '').toLowerCase())}"`;

  if (w.kind === 'activity') {
    const label = ACTIVITY_LABELS[w.activity_type] || 'Activity';
    let tags = [];
    try { tags = JSON.parse(w.muscle_tags || '[]'); } catch { tags = []; }
    const badges = tags.map((g) => `<span class="badge badge--mg mg-${PICKER_GROUP_ORDER.includes(g) ? g : 'other'}">${escapeHtml(g)}</span>`).join('');
    const dist = w.distance ? ` · ${w.distance}${w.distance_unit || ''}` : '';
    const meta = `${started.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${w.duration_min || 0}m${w.rpe ? ` · RPE ${w.rpe}` : ''}${dist}`;
    return `
      <div class="history-card history-card--activity" data-id="${w.id}" ${exAttr}>
        <button class="history-card__head">
          <div>
            <div class="history-card__title">${escapeHtml(label)} <span class="history-card__kind">activity</span></div>
            <div class="history-card__meta">${meta}</div>
            ${badges ? `<div class="history-card__groups">${badges}</div>` : ''}
          </div>
          <div class="history-card__stats">
            ${w.calories_burned ? `~${w.calories_burned}<br/><span style="font-size:11px;color:var(--text-dim)">kcal</span>` : '<span style="font-size:11px;color:var(--text-dim)">no kcal</span>'}
          </div>
        </button>
        <div class="history-card__body"></div>
      </div>`;
  }

  const finished = w.finished_at ? new Date(w.finished_at.replace(' ', 'T') + 'Z') : null;
  const durMs = finished ? finished - started : 0;
  const durMin = Math.floor(durMs / 60000);
  const dur = durMin >= 60 ? `${Math.floor(durMin / 60)}h ${durMin % 60}m` : `${durMin}m`;
  // One colored chip per trained muscle group, listing its sub-muscles —
  // e.g. "LEGS · QUADS · CALVES" in the group's hue, matching the tags
  // everywhere else. muscle_subs is "group|sub,group|sub,…"; fall back to
  // plain groups if the field is missing (older cached server mid-deploy).
  const subsByGroup = new Map();
  for (const pair of (w.muscle_subs || '').split(',')) {
    const [g, sub] = pair.split('|').map((x) => (x || '').trim());
    if (!g) continue;
    if (!subsByGroup.has(g)) subsByGroup.set(g, new Set());
    if (sub) subsByGroup.get(g).add(sub);
  }
  if (!subsByGroup.size) {
    for (const g of (w.muscle_groups || '').split(',').map((x) => x.trim()).filter(Boolean)) {
      subsByGroup.set(g, new Set());
    }
  }
  const groupBadges = [...subsByGroup.entries()].map(([g, subs]) =>
    `<span class="badge badge--mg mg-${PICKER_GROUP_ORDER.includes(g) ? g : 'other'}">${escapeHtml(g)}${subs.size ? ' · ' + [...subs].map(escapeHtml).join(' · ') : ''}</span>`
  ).join('');
  return `
    <div class="history-card" data-id="${w.id}" ${exAttr}>
      <button class="history-card__head">
        <div>
          <div class="history-card__title">${escapeHtml(w.day_label || 'Workout')}</div>
          <div class="history-card__meta">${started.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })} · ${dur}${w.feel_rating ? ' · ' + feelEmoji(w.feel_rating) : ''}</div>
          ${groupBadges ? `<div class="history-card__groups">${groupBadges}</div>` : ''}
        </div>
        <div class="history-card__stats">
          ${w.total_sets} sets<br/>
          ${Math.round(w.total_volume).toLocaleString()} kg
          ${w.calories_burned ? `<br/><span style="font-size:11px;color:var(--text-dim)">~${w.calories_burned} kcal</span>` : ''}
        </div>
      </button>
      <div class="history-card__body"></div>
    </div>`;
}

// ---------- Set edit/add sheet ----------
let setEditState = null;

async function openEditSetSheet(setId, workoutId) {
  const sheet = ensureSheet('set-edit-sheet');
  sheet.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(sheet);
  try {
    const sets = await API.workoutSets(workoutId);
    const set = sets.find((s) => s.id === setId);
    if (!set) throw new Error('Set not found');
    setEditState = { mode: 'edit', setId, workoutId, exerciseId: set.exercise_id, exerciseName: set.exercise_name, setNumber: set.set_number, weight: set.weight, weight_unit: set.weight_unit, reps: set.reps, rir: set.rir ?? null, notes: set.notes || '' };
    renderSetEditSheet();
  } catch (err) {
    sheet.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
  }
}

async function openAddSetSheet(exerciseId, workoutId, nextSetNumber, exName) {
  const sheet = ensureSheet('set-edit-sheet');
  let prior = null;
  try {
    const sets = await API.workoutSets(workoutId);
    const priors = sets.filter((s) => s.exercise_id === exerciseId).sort((a, b) => b.set_number - a.set_number);
    prior = priors[0];
  } catch { /* use defaults */ }
  setEditState = { mode: 'add', workoutId, exerciseId, exerciseName: prior?.exercise_name || exName || '', setNumber: nextSetNumber, weight: prior?.weight ?? 0, weight_unit: prior?.weight_unit || 'kg', reps: prior?.reps ?? 10, rir: null, notes: '' };
  renderSetEditSheet();
  showSheet(sheet);
}

// Small "≈ X kg/lb" hint under the weight — handy when an old set was logged
// in the other unit (e.g. after switching gyms).
function updateWeightEq() {
  const wEl = document.getElementById('se-weight');
  const uEl = document.getElementById('se-unit');
  const eq = document.getElementById('se-weight-eq');
  if (!wEl || !uEl || !eq) return;
  const w = parseFloat(wEl.value);
  if (!Number.isFinite(w) || w <= 0) { eq.textContent = ''; return; }
  eq.textContent = uEl.textContent.trim() === 'kg'
    ? `≈ ${+(w / 0.45359237).toFixed(1)} lb`
    : `≈ ${+(w * 0.45359237).toFixed(1)} kg`;
}

function renderSetEditSheet() {
  const sheet = document.getElementById('set-edit-sheet');
  const s = setEditState;
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head"><button class="btn--icon" data-close-sheet>←</button><div class="sheet__title">${s.mode === 'edit' ? 'Edit set' : 'Add set'}</div><span style="width:40px"></span></div>
      <div class="sheet__body">
        <div class="set-edit__head"><div class="set-edit__ex">${escapeHtml(s.exerciseName)}</div><div class="card__subtitle">Set ${s.setNumber}</div></div>
        <label class="form-label" style="margin-top:18px">Weight</label>
        <div class="set-edit__row">
          <div class="num-input" data-field="weight">
            <button class="num-input__btn" data-se-step="-1">−</button>
            <input class="num-input__field" id="se-weight" type="text" inputmode="decimal" value="${s.weight}"/>
            <button class="num-input__btn" data-se-step="1">+</button>
          </div>
          <button class="unit-toggle ${s.weight_unit === 'kg' ? 'kg' : 'lbs'}" id="se-unit">${s.weight_unit}</button>
        </div>
        <div class="card__subtitle" id="se-weight-eq" style="margin-top:6px"></div>
        <label class="form-label" style="margin-top:14px">Reps</label>
        <div class="num-input" data-field="reps">
          <button class="num-input__btn" data-se-step-reps="-1">−</button>
          <input class="num-input__field" id="se-reps" type="text" inputmode="numeric" value="${s.reps}"/>
          <button class="num-input__btn" data-se-step-reps="1">+</button>
        </div>
        <label class="form-label" style="margin-top:14px">RIR <span style="color:var(--text-dim);font-weight:400">· reps in reserve</span></label>
        <div class="rpe-group rpe-group--wide" id="se-rir-group">
          ${[0,1,2,3,4].map((n) => `<button class="rpe-btn ${Number(s.rir) === n ? 'rpe-btn--active' : ''}" data-se-rir="${n}">${n}</button>`).join('')}
          <button class="rpe-btn rpe-btn--clear ${s.rir == null ? 'rpe-btn--active' : ''}" data-se-rir="">none</button>
        </div>
        <label class="form-label" style="margin-top:14px">Notes</label>
        <input class="input" id="se-notes" value="${escapeHtml(s.notes)}" placeholder="Optional"/>
        <button class="btn btn--primary btn--block" id="se-save" style="margin-top:20px">${s.mode === 'edit' ? 'Save changes' : 'Add set'}</button>
        ${s.mode === 'edit' ? `<button class="btn btn--ghost btn--block" id="se-delete" style="margin-top:10px;color:var(--danger)">Delete set</button>` : ''}
      </div>
    </div>`;

  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);
    const unitBtn = e.target.closest('#se-unit');
    if (unitBtn) { const next = unitBtn.textContent.trim() === 'kg' ? 'lbs' : 'kg'; unitBtn.textContent = next; unitBtn.classList.toggle('kg', next === 'kg'); updateWeightEq(); return; }
    const wStep = e.target.closest('[data-se-step]');
    if (wStep) {
      const input = document.getElementById('se-weight');
      let v = parseFloat(input.value || '0');
      if (Number.isNaN(v)) v = 0;
      const unit = document.getElementById('se-unit').textContent.trim();
      const delta = Number(wStep.dataset.seStep) * stepForExercise(unit, { name: s.exerciseName });
      let next = v + delta; if (next < 0) next = 0;
      input.value = String(+next.toFixed(2)); updateWeightEq(); haptic(10); return;
    }
    const rStep = e.target.closest('[data-se-step-reps]');
    if (rStep) {
      const input = document.getElementById('se-reps');
      let v = parseInt(input.value || '0', 10);
      if (Number.isNaN(v)) v = 0;
      let next = v + Number(rStep.dataset.seStepReps); if (next < 0) next = 0;
      input.value = String(next); haptic(10); return;
    }
    const rirBtn = e.target.closest('[data-se-rir]');
    if (rirBtn) {
      const raw = rirBtn.dataset.seRir;
      s.rir = raw === '' ? null : Number(raw);
      sheet.querySelectorAll('[data-se-rir]').forEach((b) => {
        const v = b.dataset.seRir === '' ? null : Number(b.dataset.seRir);
        b.classList.toggle('rpe-btn--active', v === s.rir);
      });
      haptic(10); return;
    }
    if (e.target.closest('#se-save')) {
      const weight = parseFloat(document.getElementById('se-weight').value || '0');
      const reps = parseInt(document.getElementById('se-reps').value || '0', 10);
      const unit = document.getElementById('se-unit').textContent.trim();
      const notes = document.getElementById('se-notes').value.trim() || null;
      if (weight < 0 || Number.isNaN(weight) || !reps) return toast('Enter weight and reps');
      try {
        if (s.mode === 'edit') {
          await API.updateSet(s.setId, { weight, weight_unit: unit, reps, rir: s.rir, notes });
        } else {
          await API.logSet({ workout_id: s.workoutId, exercise_id: s.exerciseId, set_number: s.setNumber, weight, weight_unit: unit, reps, rir: s.rir, notes });
        }
        hideSheet(sheet); haptic(20); await refreshHistoryCard(s.workoutId);
      } catch (err) { toast(err.message); }
      return;
    }
    if (e.target.closest('#se-delete')) {
      const ok = await confirmSheet({ title: 'Delete set', message: 'Delete this set?', confirmText: 'Delete', danger: true });
      if (!ok) return;
      try { await API.deleteSet(s.setId); hideSheet(sheet); haptic(20); await refreshHistoryCard(s.workoutId); }
      catch (err) { toast(err.message); }
    }
  };

  document.getElementById('se-weight')?.addEventListener('input', updateWeightEq);
  updateWeightEq();
}

let historyPickerSort = 'frequent';

async function openHistoryAddExercisePicker(workoutId) {
  const picker = ensureSheet('history-add-picker-sheet');
  picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(picker);
  let exercises;
  try { exercises = await API.exerciseStats(); }
  catch (err) {
    picker.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    return;
  }

  function buildList() {
    const groups = {};
    for (const ex of exercises) (groups[ex.muscle_group] ||= []).push(ex);
    for (const g of Object.keys(groups)) groups[g] = sortExercisesBy(groups[g], historyPickerSort);
    const keys = [...new Set([...PICKER_GROUP_ORDER, ...Object.keys(groups)])].filter((k) => groups[k]);
    picker.querySelector('#histadd-sort').innerHTML = exerciseSortHTML(historyPickerSort);
    picker.querySelector('#histadd-list').innerHTML = pickerChipsHTML(keys) + keys.map((g) => `<div class="picker-group" data-group="${g}"><div class="picker-group__title mg-title mg-${g}">${escapeHtml(g)}</div>
      ${groups[g].map((ex) => `<button class="picker-row" data-histadd="${ex.id}" data-name="${escapeHtml(ex.name).toLowerCase()}" data-ex-name="${escapeHtml(ex.name)}"><span>${escapeHtml(ex.name)}${ex.sub_muscle ? ` <span class="picker-row__sub mg-title mg-${g}${subMuscleShadeClass(g, ex.sub_muscle)}">${escapeHtml(ex.sub_muscle)}</span>` : ''}</span><span class="picker-row__state">+</span></button>`).join('')}
    </div>`).join('');
    setupPickerFilter(picker);
  }

  picker.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head"><button class="btn--icon" data-close-sheet>←</button><div class="sheet__title">Add exercise to this workout</div><span style="width:40px"></span></div>
      <div class="sheet__body">
        <input class="input" id="histadd-search" data-picker-search placeholder="Search…" style="margin-bottom:12px"/>
        <div id="histadd-sort"></div>
        <div id="histadd-list"></div>
      </div>
    </div>`;
  buildList();
  picker.onclick = (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(picker);
    const sortBtn = e.target.closest('[data-sort]');
    if (sortBtn) { historyPickerSort = sortBtn.dataset.sort; buildList(); return; }
    const pickBtn = e.target.closest('[data-histadd]');
    if (!pickBtn) return;
    const exId = Number(pickBtn.dataset.histadd);
    const exName = pickBtn.dataset.exName;
    hideSheet(picker);
    openAddSetSheet(exId, workoutId, 1, exName);
  };
}

async function flushHistoryNotes() {
  for (const el of document.querySelectorAll('[data-history-notes]')) {
    const card = el.closest('.history-card');
    if (!card) continue;
    const prev = el.dataset.prev || null;
    const value = el.value.trim() || null;
    if (value === prev) continue;
    try { await API.updateWorkout(Number(card.dataset.id), { notes: value }); el.dataset.prev = value ?? ''; }
    catch (err) { reportHandled(err, { where: 'flushHistoryNotes', workoutId: card.dataset.id }); }
  }
}

export { renderHistory, flushHistoryNotes };
