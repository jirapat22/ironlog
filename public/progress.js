import { $, escapeHtml, haptic, toast, formatDateShort, humanAgo, daysAgo, skeletonBlocks, toKg, e1RM, fmtSetWeight, showSheet, hideSheet, ensureSheet, confirmSheet, SUB_MUSCLES, PICKER_GROUP_ORDER } from './utils.js';
import { API } from './api.js';

const chartInstances = {};
let localBwKg = 0; // updated by renderBodyweightSection; used for strength chart & PR timeline

// helper: e1RM for a set, folding in BW when appropriate
function calcE1RM(set, exercise, bwKg) {
  const base = toKg(set.weight, set.weight_unit);
  let load;
  if (exercise?.is_assisted && bwKg) load = Math.max(0, bwKg - base);
  else if (exercise?.is_bodyweight && bwKg) load = base + bwKg;
  else load = base;
  return e1RM(load, set.reps);
}

// ---------- PROGRESS tab ----------
// ---------- Collapsible section helpers ----------
function getCollapsedSet() {
  try {
    const raw = localStorage.getItem('ironlog.progress.collapsed');
    // Default: Personal Records collapsed
    return new Set(raw ? JSON.parse(raw) : ['ps-pr']);
  } catch { return new Set(['ps-pr']); }
}

function saveCollapsedSet(set) {
  localStorage.setItem('ironlog.progress.collapsed', JSON.stringify([...set]));
}

function restoreCollapsedSections() {
  const collapsed = getCollapsedSet();
  for (const id of collapsed) {
    const section = document.getElementById(id);
    if (!section) continue;
    section.classList.add('ps--collapsed');
    const btn = section.querySelector('[data-ps-toggle]');
    if (btn) btn.textContent = '▸';
  }
}

async function renderProgress() {
  const root = $('#view-progress');
  root.innerHTML = `
    <div class="progress-section" id="ps-bodyweight">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Body Weight</div>
        <div class="ps-head-actions">
          <button class="btn btn--ghost btn--sm" data-log-bw>+ Log</button>
          <button class="ps-toggle" data-ps-toggle="ps-bodyweight">▾</button>
        </div>
      </div>
      <div class="ps-body">
        <div id="bw-current" class="bw-current"></div>
        <div id="bw-recent" class="bw-recent"></div>
        <div class="chart-wrap bw-chart-wrap hidden" id="bw-chart-wrap"><canvas id="bw-chart"></canvas></div>
      </div>
    </div>
    <div class="progress-section" id="ps-consistency">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Consistency (6 months)</div>
        <button class="ps-toggle" data-ps-toggle="ps-consistency">▾</button>
      </div>
      <div class="ps-body">
        <div id="calendar" class="calendar"></div>
      </div>
    </div>
    <div class="progress-section" id="ps-muscle-freq">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Muscle Detail</div>
        <button class="ps-toggle" data-ps-toggle="ps-muscle-freq">▾</button>
      </div>
      <div class="ps-body">
        <div id="muscle-frequency"></div>
      </div>
    </div>
    <div class="progress-section" id="ps-tdee">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Daily Calories</div>
        <div class="ps-head-actions">
          <button class="btn btn--ghost btn--sm" data-edit-profile>Profile</button>
          <button class="ps-toggle" data-ps-toggle="ps-tdee">▾</button>
        </div>
      </div>
      <div class="ps-body">
        <div id="tdee-card"></div>
      </div>
    </div>
    <div class="progress-section" id="ps-overload">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Progressive Overload</div>
        <button class="ps-toggle" data-ps-toggle="ps-overload">▾</button>
      </div>
      <div class="ps-body">
        <div id="overload-charts"></div>
      </div>
    </div>
    <div class="progress-section" id="ps-pr">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Personal Records</div>
        <button class="ps-toggle" data-ps-toggle="ps-pr">▾</button>
      </div>
      <div class="ps-body">
        <div id="pr-timeline"></div>
      </div>
    </div>
  `;

  root.onclick = async (e) => {
    if (e.target.closest('[data-log-bw]')) return openBodyweightSheet();
    if (e.target.closest('[data-edit-profile]')) return openProfileSheet();

    const toggle = e.target.closest('[data-ps-toggle]');
    if (toggle) {
      const sectionId = toggle.dataset.psToggle;
      const section = document.getElementById(sectionId);
      if (section) {
        section.classList.toggle('ps--collapsed');
        toggle.textContent = section.classList.contains('ps--collapsed') ? '▸' : '▾';
        const collapsed = getCollapsedSet();
        if (section.classList.contains('ps--collapsed')) collapsed.add(sectionId);
        else collapsed.delete(sectionId);
        saveCollapsedSet(collapsed);
      }
      return;
    }

    const del = e.target.closest('[data-del-bw]');
    if (del) {
      const id = Number(del.dataset.delBw);
      const ok = await confirmSheet({ title: 'Delete entry', message: 'Delete this body-weight entry?', confirmText: 'Delete', danger: true });
      if (!ok) return;
      try {
        await API.deleteBodyweight(id);
        await renderBodyweightSection();
        await renderTdeeSection();
      } catch (err) { toast(err.message); }
    }
  };

  try {
    const calendarDates = await API.calendar();

    await renderBodyweightSection();
    renderCalendar(calendarDates);
    renderMuscleFrequency();
    renderOverloadCharts();
    renderPrTimeline();
    renderTdeeSection();

    restoreCollapsedSections();
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load progress: ${escapeHtml(err.message)}</div>`;
  }
}

function chartDefaults() {
  return {
    ticks: { color: '#8a8a8a' },
    grid: { color: 'rgba(255,255,255,0.06)' },
    border: { display: false }
  };
}


const MIN_WEEKLY_SESSIONS = 3;

// Format a Date as local YYYY-MM-DD (avoids UTC-shift on toISOString in +12/+13 timezones)
function localDateStr(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Group order + the sub-muscles we expect under each, so untrained regions show
// up (not just ones that already have logged sets). Cloned from the canonical
// SUB_MUSCLES (utils.js) because we augment it at runtime with any sub-muscle
// found in the data that isn't in the static list.
const SUB_MUSCLE_MAP = JSON.parse(JSON.stringify(SUB_MUSCLES));

function freqColor(days) {
  if (days == null) return '#8a8a8a';
  return days >= 7 ? '#ff8a8a' : days >= 4 ? '#ffb347' : days >= 2 ? '#9effa8' : 'var(--accent)';
}

async function renderMuscleFrequency() {
  const root = $('#muscle-frequency');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:120px"></div>`;
  try {
    const rows = await API.subMuscleFrequency();
    const now = Date.now();
    const daysSince = (iso) => iso == null ? null : Math.floor((now - new Date(iso.replace(' ', 'T') + 'Z').getTime()) / 86400000);

    // Index logged rows by group → sub-muscle
    const byKey = new Map();
    for (const r of rows) byKey.set(`${r.muscle_group}|${r.sub_muscle}`, r);

    const GROUPS = Object.keys(SUB_MUSCLE_MAP);
    // Include any group/sub-muscle that appears in data but isn't in the static map
    for (const r of rows) {
      if (!SUB_MUSCLE_MAP[r.muscle_group]) SUB_MUSCLE_MAP[r.muscle_group] = [];
      if (!SUB_MUSCLE_MAP[r.muscle_group].includes(r.sub_muscle)) SUB_MUSCLE_MAP[r.muscle_group].push(r.sub_muscle);
    }
    const groupOrder = [...new Set([...GROUPS, ...rows.map((r) => r.muscle_group)])];

    // "Train next": sub-muscles never trained or 7+ days stale.
    const stale = [];

    const collapsedKey = 'ironlog.mfreqCollapsed';
    let collapsedGroups;
    const stored = localStorage.getItem(collapsedKey);
    if (stored == null) {
      // First visit: start with every group collapsed (show group names only).
      collapsedGroups = [...groupOrder];
    } else {
      try { collapsedGroups = JSON.parse(stored); } catch { collapsedGroups = []; }
    }
    const collapsedSet = new Set(collapsedGroups);

    // Per-group HTML for both states, swapped on toggle without a full re-render.
    const groupContent = new Map();

    const html = groupOrder.map((g) => {
      const subs = SUB_MUSCLE_MAP[g] || [];
      let groupDays = null;
      const subRows = subs.map((sub) => {
        const row = byKey.get(`${g}|${sub}`);
        const days = row ? daysSince(row.last_trained_at) : null;
        if (days != null && (groupDays == null || days < groupDays)) groupDays = days;
        const displayName = sub === g ? 'Unspecified' : sub;
        if (days == null || days >= 7) stale.push(displayName === 'Unspecified' ? `${g} (unspecified)` : displayName);
        const label = days == null ? 'Never' : days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d ago`;
        const color = freqColor(days);
        return `
          <div class="mfreq-row mfreq-row--sub">
            <span class="mfreq-sub-name">${escapeHtml(displayName)}</span>
            <div class="mfreq-bar-wrap"><div class="mfreq-bar" style="background:${color}"></div></div>
            <span class="mfreq-label" style="color:${color}">${label}</span>
          </div>`;
      }).join('');

      // Collapsed summary: most-recent "last trained" across this group's sub-muscles.
      const groupLabel = groupDays == null ? 'Never' : groupDays === 0 ? 'Today' : groupDays === 1 ? 'Yesterday' : `${groupDays}d ago`;
      const groupColor = freqColor(groupDays);
      const summaryRow = `
        <div class="mfreq-row mfreq-row--sub mfreq-row--summary">
          <span class="mfreq-sub-name">Last trained</span>
          <div class="mfreq-bar-wrap"><div class="mfreq-bar" style="background:${groupColor}"></div></div>
          <span class="mfreq-label" style="color:${groupColor}">${groupLabel}</span>
        </div>`;
      groupContent.set(g, { subRows, summaryRow });

      const collapsed = collapsedSet.has(g);
      return `
        <div class="mfreq-group ${collapsed ? 'mfreq-group--collapsed' : ''}" data-mfreq-group="${escapeHtml(g)}">
          <button class="mfreq-group__head" data-toggle-group="${escapeHtml(g)}">
            <span class="badge badge--group badge--g-${g}">${g}</span>
            <span class="mfreq-group__chevron">&#9656;</span>
          </button>
          <div class="mfreq-group__subs">${collapsed ? summaryRow : subRows}</div>
        </div>`;
    }).join('');

    const hint = stale.length
      ? `<div class="mfreq-hint">Train next: ${stale.slice(0, 5).map((s) => escapeHtml(s)).join(', ')}${stale.length > 5 ? '…' : ''}</div>`
      : '';

    const allCollapsed = groupOrder.every((g) => collapsedSet.has(g));
    const toggleAllLabel = allCollapsed ? 'Expand all' : 'Collapse all';
    const toggleAll = `<button class="mfreq-toggle-all" id="mfreq-toggle-all">${toggleAllLabel}</button>`;

    root.innerHTML = toggleAll + (rows.length ? '' : `<div class="bw-current__empty" style="margin-bottom:8px">No workouts logged yet — defaults shown.</div>`) + hint + html;

    $('#mfreq-toggle-all').onclick = () => {
      collapsedGroups = allCollapsed ? [] : [...groupOrder];
      localStorage.setItem(collapsedKey, JSON.stringify(collapsedGroups));
      renderMuscleFrequency();
    };

    root.querySelectorAll('[data-toggle-group]').forEach((btn) => {
      btn.onclick = () => {
        const g = btn.dataset.toggleGroup;
        const groupEl = btn.closest('.mfreq-group');
        const subsEl = groupEl.querySelector('.mfreq-group__subs');
        const willCollapse = !groupEl.classList.contains('mfreq-group--collapsed');
        groupEl.classList.toggle('mfreq-group--collapsed', willCollapse);
        const content = groupContent.get(g);
        if (content) subsEl.innerHTML = willCollapse ? content.summaryRow : content.subRows;
        const next = willCollapse
          ? [...new Set([...collapsedGroups, g])]
          : collapsedGroups.filter((x) => x !== g);
        collapsedGroups = next;
        localStorage.setItem(collapsedKey, JSON.stringify(collapsedGroups));
        const nowAllCollapsed = groupOrder.every((x) => collapsedGroups.includes(x));
        const toggleAllBtn = $('#mfreq-toggle-all');
        if (toggleAllBtn) toggleAllBtn.textContent = nowAllCollapsed ? 'Expand all' : 'Collapse all';
      };
    });
  } catch (err) { root.innerHTML = `<div class="empty">${escapeHtml(err.message)}</div>`; }
}

function renderCalendar(entries) {
  const root = $('#calendar');
  const countMap = new Map(entries.map((e) => [e.date, e.count]));
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const todayIso = localDateStr(today);   // was toISOString() — wrong in UTC+ timezones
  const MONTHS = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const DAY_LETTERS = ['M','T','W','T','F','S','S'];

  const rangeStart = entries.length
    ? new Date(entries[0].date + 'T00:00:00')  // parse as local, not UTC
    : new Date(today.getFullYear(), today.getMonth() - 1, 1);

  const monthGroups = [];
  const mCursor = new Date(rangeStart.getFullYear(), rangeStart.getMonth(), 1);
  while (mCursor <= today) {
    const year = mCursor.getFullYear(), month = mCursor.getMonth();
    const lastDayNum = new Date(year, month + 1, 0).getDate();
    const allDays = [];
    for (let d = 1; d <= lastDayNum; d++) {
      const dt = new Date(year, month, d);
      if (dt > today) break;
      allDays.push(localDateStr(dt));   // was toISOString() — shifted by UTC offset
    }
    const firstDow = (new Date(year, month, 1).getDay() + 6) % 7;
    const cols = [];
    const firstSlice = 7 - firstDow;
    cols.push([...Array(firstDow).fill(null), ...allDays.slice(0, firstSlice)]);
    for (let i = firstSlice; i < allDays.length; i += 7) {
      const chunk = allDays.slice(i, i + 7);
      while (chunk.length < 7) chunk.push(null);
      cols.push(chunk);
    }
    monthGroups.push({ label: MONTHS[month], cols });
    mCursor.setMonth(mCursor.getMonth() + 1);
  }

  // Parse entry dates as local midnight so getDay() returns the correct local weekday
  const toMonday = (d) => { const m = new Date(d); m.setDate(m.getDate() - ((m.getDay() + 6) % 7)); m.setHours(0,0,0,0); return m; };
  const weekMap = new Map();
  for (const e of entries) {
    const key = localDateStr(toMonday(new Date(e.date + 'T00:00:00')));  // was toISOString()
    weekMap.set(key, (weekMap.get(key) || 0) + e.count);
  }
  const sortedWeeks = [...weekMap.keys()].sort();
  const thisWeekKey = localDateStr(toMonday(today));  // was toISOString()

  let currentStreak = 0;
  let skipCurrent = (weekMap.get(thisWeekKey) || 0) < MIN_WEEKLY_SESSIONS;
  for (let i = sortedWeeks.length - 1; i >= 0; i--) {
    const k = sortedWeeks[i];
    if (skipCurrent && k === thisWeekKey) { skipCurrent = false; continue; }
    skipCurrent = false;
    if ((weekMap.get(k) || 0) >= MIN_WEEKLY_SESSIONS) currentStreak++;
    else break;
  }

  let best = 0, run = 0;
  for (const k of sortedWeeks) {
    if ((weekMap.get(k) || 0) >= MIN_WEEKLY_SESSIONS) { run++; best = Math.max(best, run); }
    else run = 0;
  }

  const monthKey = todayIso.slice(0, 7);
  const thisMonth = entries.filter((e) => e.date.startsWith(monthKey)).reduce((a, e) => a + e.count, 0);
  const total = entries.reduce((a, e) => a + e.count, 0);

  const cell = (iso) => {
    if (!iso) return '<div class="cal-cell cal-cell--empty"></div>';
    const cnt = countMap.get(iso) || 0;
    const isToday = iso === todayIso;
    const cls = cnt >= 2 ? 'cal-cell--hi' : cnt === 1 ? 'cal-cell--med' : '';
    const tip = cnt ? `${iso} · ${cnt} session${cnt > 1 ? 's' : ''}` : iso;
    return `<div class="cal-cell ${cls} ${isToday ? 'cal-cell--today' : ''}" title="${tip}"></div>`;
  };

  const gridHTML = monthGroups.map(({ label, cols }) => `
    <div class="cal-month-grp">
      <div class="cal-month-name">${label}</div>
      <div class="cal-month-cols">${cols.map((col) => `<div class="cal-col">${col.map(cell).join('')}</div>`).join('')}</div>
    </div>`).join('');

  root.innerHTML = `
    <div class="cal-stats">
      <div class="cal-stat"><div class="cal-stat__val">${currentStreak}</div><div class="cal-stat__lbl">wk streak</div></div>
      <div class="cal-stat"><div class="cal-stat__val">${best}</div><div class="cal-stat__lbl">best</div></div>
      <div class="cal-stat"><div class="cal-stat__val">${thisMonth}</div><div class="cal-stat__lbl">this month</div></div>
      <div class="cal-stat"><div class="cal-stat__val">${total}</div><div class="cal-stat__lbl">total</div></div>
    </div>
    <div class="cal-wrap">
      <div class="cal-day-col">${DAY_LETTERS.map((l) => `<span>${l}</span>`).join('')}</div>
      <div class="cal-scroll"><div class="cal-grid">${gridHTML}</div></div>
    </div>
    <div class="cal-legend">
      <span style="font-size:10px;color:var(--text-dim)">${MIN_WEEKLY_SESSIONS}+ sessions/wk = active week</span>
      <span style="margin-left:auto;font-size:10px;color:var(--text-dim)">None</span>
      <div class="cal-cell"></div>
      <div class="cal-cell cal-cell--med"></div>
      <div class="cal-cell cal-cell--hi"></div>
      <span style="font-size:10px;color:var(--text-dim)">2+/day</span>
    </div>
  `;
}


// Estimated-1RM trend per set, grouped by muscle group then exercise.
// Needs at least 2 sets on an exercise to draw a meaningful line.
async function renderOverloadCharts() {
  const root = $('#overload-charts');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;
  try {
    const [history, bwRows] = await Promise.all([API.strengthHistory(), API.bodyweight().catch(() => [])]);
    const bwKg = bwRows.length ? toKg(bwRows[0].weight, bwRows[0].weight_unit) : 0;

    for (const key of Object.keys(chartInstances)) {
      if (key.startsWith('overload-')) { chartInstances[key].destroy(); delete chartInstances[key]; }
    }

    // Collapse each exercise to one point per SESSION: the best working-set
    // e1RM that day. Plotting every set makes back-off/drop sets look like the
    // lift got weaker mid-session — the top set is the honest progression
    // signal. Need 2+ distinct sessions to draw a meaningful trend.
    const series = [];
    for (const ex of history) {
      const byDay = new Map();
      for (const s of ex.sets) {
        const val = calcE1RM(s, ex, bwKg);
        if (!val) continue; // skip sets that can't yield a real e1RM (e.g. unlogged-BW)
        const day = s.logged_at.slice(0, 10);
        if (!byDay.has(day) || val > byDay.get(day)) byDay.set(day, val);
      }
      const days = [...byDay.keys()].sort();
      if (days.length < 2) continue;
      series.push({
        exercise_id: ex.exercise_id,
        exercise_name: ex.exercise_name,
        muscle_group: ex.muscle_group,
        labels: days,
        values: days.map((d) => Math.round(byDay.get(d)))
      });
    }

    if (!series.length) {
      root.innerHTML = `<div class="bw-current__empty">Train an exercise across at least 2 sessions to see its trend.</div>`;
      return;
    }

    const byGroup = new Map();
    for (const s of series) {
      if (!byGroup.has(s.muscle_group)) byGroup.set(s.muscle_group, []);
      byGroup.get(s.muscle_group).push(s);
    }
    const groupOrder = [...byGroup.keys()].sort((a, b) => {
      const ia = PICKER_GROUP_ORDER.indexOf(a), ib = PICKER_GROUP_ORDER.indexOf(b);
      if (ia === -1 && ib === -1) return a.localeCompare(b);
      if (ia === -1) return 1;
      if (ib === -1) return -1;
      return ia - ib;
    });

    const subtitle = `<div class="card__subtitle" style="margin-bottom:10px">Best estimated 1-rep max per session, over time — the clearest sign you're getting stronger on a lift.</div>`;

    root.innerHTML = subtitle + groupOrder.map((group) => {
      const exercises = [...byGroup.get(group)].sort((a, b) => a.exercise_name.localeCompare(b.exercise_name));
      return `<div class="overload-group">
        <div class="overload-group__name">${escapeHtml(group)}</div>
        ${exercises.map((ex) => `
          <div class="overload-exercise">
            <div class="overload-exercise__name">${escapeHtml(ex.exercise_name)}</div>
            <div class="overload-chart-wrap"><canvas id="overload-chart-${ex.exercise_id}"></canvas></div>
          </div>`).join('')}
      </div>`;
    }).join('');

    for (const s of series) renderOverloadChart(s);
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`;
  }
}

function renderOverloadChart(s) {
  const canvas = document.getElementById(`overload-chart-${s.exercise_id}`);
  if (!canvas) return;
  const key = `overload-${s.exercise_id}`;
  if (chartInstances[key]) chartInstances[key].destroy();

  const d = chartDefaults();
  chartInstances[key] = new Chart(canvas, {
    type: 'line',
    data: {
      labels: s.labels,
      datasets: [{
        data: s.values, borderColor: '#5ac46a', backgroundColor: 'rgba(90,196,106,0.12)',
        // 'monotone' keeps the curve from overshooting below/above the actual
        // points — plain bezier tension invents phantom dips between values.
        cubicInterpolationMode: 'monotone', tension: 0.25,
        fill: true, pointRadius: 2, pointBackgroundColor: '#5ac46a', pointBorderColor: '#0f0f0f'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `e1RM ${ctx.parsed.y} kg` } } },
      scales: { x: { ...d, ticks: { ...d.ticks, maxTicksLimit: 6 } }, y: { ...d, beginAtZero: false } }
    }
  });
}

async function renderPrTimeline() {
  const root = $('#pr-timeline');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;
  try {
    const [prs, allExercises, bwRows] = await Promise.all([API.prs(), API.exercises(), API.bodyweight().catch(() => [])]);
    const bwKg = bwRows.length ? toKg(bwRows[0].weight, bwRows[0].weight_unit) : 0;
    const exById = new Map(allExercises.map((e) => [e.id, e]));
    const events = [];
    for (const g of prs) {
      const ex = exById.get(g.exercise_id);
      for (const r of g.records) {
        events.push({
          exerciseName: g.exercise_name, muscleGroup: g.muscle_group,
          weight: r.weight, weight_unit: r.weight_unit, reps: r.reps, achievedAt: r.achieved_at,
          isBodyweight: !!ex?.is_bodyweight, isAssisted: !!ex?.is_assisted,
          e1rm: calcE1RM(r, ex, bwKg)
        });
      }
    }
    if (!events.length) { root.innerHTML = `<div class="bw-current__empty">No PRs yet — log some sets to build this up.</div>`; return; }
    events.sort((a, b) => b.achievedAt.localeCompare(a.achievedAt));
    const subtitle = `<div class="card__subtitle" style="margin-bottom:10px">Your current best weight at each rep count, per lift. Recomputes when you edit or delete sets.</div>`;
    const byExercise = new Map();
    for (const ev of events) {
      if (!byExercise.has(ev.exerciseName)) byExercise.set(ev.exerciseName, []);
      byExercise.get(ev.exerciseName).push(ev);
    }
    const groupOrder = [...byExercise.keys()].sort((a, b) => byExercise.get(b)[0].achievedAt.localeCompare(byExercise.get(a)[0].achievedAt));
    root.innerHTML = subtitle + groupOrder.map((name) => {
      const list = [...byExercise.get(name)].sort((a, b) => a.reps - b.reps);
      return `<div class="pr-group"><div class="pr-group__name">${escapeHtml(name)}</div>
        ${list.map((ev) => `<div class="pr-event">
          <div class="pr-event__date">${ev.reps}-rep max</div>
          <div class="pr-event__body">
            <span class="pr-event__main">${fmtSetWeight(ev.weight, ev.weight_unit, ev.isBodyweight, ev.isAssisted)} × ${ev.reps}</span>
            <span class="pr-event__e1rm">${formatDateShort(ev.achievedAt)} · e1RM ${Math.round(ev.e1rm)} kg</span>
          </div></div>`).join('')}
      </div>`;
    }).join('');
  } catch (err) { root.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`; }
}


async function renderBodyweightSection() {
  const currentEl = $('#bw-current'), recentEl = $('#bw-recent'), chartWrap = $('#bw-chart-wrap');
  if (!currentEl) return;
  let rows = [];
  try { rows = await API.bodyweight(); }
  catch (err) { currentEl.innerHTML = `<div class="bw-current__empty">${escapeHtml(err.message)}</div>`; return; }

  if (!rows.length) {
    currentEl.innerHTML = `<div class="bw-current__empty">No entries yet. Tap + Log to add your first one.</div>`;
    recentEl.innerHTML = ''; chartWrap.classList.add('hidden');
    if (chartInstances.bw) { chartInstances.bw.destroy(); delete chartInstances.bw; }
    return;
  }

  const latest = rows[0];
  localBwKg = toKg(latest.weight, latest.weight_unit);

  let trendStr = '';
  if (rows.length > 1) {
    const diff = toKg(latest.weight, latest.weight_unit) - toKg(rows[1].weight, rows[1].weight_unit);
    if (Math.abs(diff) >= 0.05) {
      const sign = diff > 0 ? '+' : '';
      trendStr = `<span class="bw-current__trend ${diff > 0 ? 'up' : 'down'}">${sign}${diff.toFixed(1)} kg</span>`;
    }
  }

  const daysSinceLog = daysAgo(latest.logged_at);
  const staleNote = daysSinceLog >= 7
    ? `<div class="bw-stale">Last logged ${daysSinceLog} days ago — tap + Log to keep your trend accurate</div>` : '';

  currentEl.innerHTML = `
    <div class="bw-current__row">
      <span class="bw-current__val">${escapeHtml(String(latest.weight))}</span>
      <span class="bw-current__unit">${escapeHtml(latest.weight_unit)}</span>
      ${trendStr}
      <span class="bw-current__when">${humanAgo(latest.logged_at)}</span>
    </div>${staleNote}`;

  const SHOW_DEFAULT = 4;
  const hasMore = rows.length > SHOW_DEFAULT;
  function renderRecentList(expanded) {
    const visible = expanded ? rows : rows.slice(0, SHOW_DEFAULT);
    return `<div class="bw-list">${visible.map((r) => `
      <div class="bw-item">
        <span class="bw-item__date">${formatDateShort(r.logged_at)}</span>
        <span class="bw-item__w">${r.weight} ${r.weight_unit}</span>
        ${r.notes ? `<span class="bw-item__note">${escapeHtml(r.notes)}</span>` : ''}
        <button class="bw-item__del" data-del-bw="${r.id}" aria-label="Delete">&times;</button>
      </div>`).join('')}</div>
      ${hasMore ? `<button class="bw-toggle" data-bw-toggle>${expanded ? '&#x25B2; Show less' : `&#x25BC; ${rows.length - SHOW_DEFAULT} more entries`}</button>` : ''}`;
  }
  let historyExpanded = false;
  recentEl.innerHTML = renderRecentList(false);
  recentEl.onclick = (e) => {
    if (e.target.closest('[data-bw-toggle]')) { historyExpanded = !historyExpanded; recentEl.innerHTML = renderRecentList(historyExpanded); }
  };
  if (rows.length >= 2) { chartWrap.classList.remove('hidden'); renderBwChart(rows); }
  else chartWrap.classList.add('hidden');
}

// ---------- TDEE ----------
const ACTIVITY_MULTIPLIERS = { sedentary: 1.2, light: 1.375, moderate: 1.55, very: 1.725, athlete: 1.9 };
const ACTIVITY_LABELS = {
  sedentary: 'Sedentary (desk job, no exercise)', light: 'Light (1–3 days/week)',
  moderate: 'Moderate (3–5 days/week)', very: 'Very active (6–7 days/week)',
  athlete: 'Athlete (2× daily / physical job)'
};
function calcBmrMifflin(weightKg, heightCm, age, sex) {
  const base = 10 * weightKg + 6.25 * heightCm - 5 * age;
  return sex === 'female' ? base - 161 : base + 5;
}
function computeMacros(goalKcal, weightKg, goal) {
  const proteinPerKg = goal === 'cut' ? 2.2 : 2.0;
  const proteinG = Math.round(weightKg * proteinPerKg);
  const fatG = Math.round((goalKcal * 0.25) / 9);
  const proteinKcal = proteinG * 4, fatKcal = fatG * 9;
  const carbKcal = Math.max(0, goalKcal - proteinKcal - fatKcal);
  const carbG = Math.round(carbKcal / 4);
  return {
    protein: { g: proteinG, kcal: proteinKcal, pct: Math.round((proteinKcal / goalKcal) * 100) },
    fat: { g: fatG, kcal: fatKcal, pct: Math.round((fatKcal / goalKcal) * 100) },
    carbs: { g: carbG, kcal: carbKcal, pct: Math.round((carbKcal / goalKcal) * 100) },
    proteinPerKg
  };
}
const GOAL_OFFSETS = { cut: -500, maintain: 0, bulk: 300 };
const GOAL_LABELS = { cut: 'Cut', maintain: 'Maintain', bulk: 'Bulk' };

async function renderTdeeSection() {
  const root = $('#tdee-card');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;
  let settings, bw;
  try { [settings, bw] = await Promise.all([API.settings(), API.bodyweight()]); }
  catch (err) { root.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`; return; }
  const heightCm = Number(settings.profile_height_cm);
  const age = Number(settings.profile_age);
  const activity = settings.profile_activity || 'moderate';
  const sex = settings.strength_standard_gender === 'female' ? 'female' : 'male';
  const goal = ['cut','maintain','bulk'].includes(settings.profile_goal) ? settings.profile_goal : 'maintain';
  const missing = [];
  if (!bw.length) missing.push('body weight');
  if (!heightCm) missing.push('height');
  if (!age) missing.push('age');
  if (missing.length) {
    root.innerHTML = `<div class="bw-current__empty" style="padding:6px 0">Set ${missing.join(', ')} to see your daily calorie targets.</div>
      <button class="btn btn--primary btn--block" data-edit-profile style="margin-top:6px">Set up profile</button>`;
    return;
  }
  const weightKg = toKg(bw[0].weight, bw[0].weight_unit);
  const bmr = Math.round(calcBmrMifflin(weightKg, heightCm, age, sex));
  const multiplier = ACTIVITY_MULTIPLIERS[activity] || 1.55;
  const tdee = Math.round(bmr * multiplier);
  const goalKcal = tdee + GOAL_OFFSETS[goal];
  const macros = computeMacros(goalKcal, weightKg, goal);

  // Today's workout calorie burn (if any finished workouts today)
  let todayBurn = 0;
  try {
    const pad = (n) => String(n).padStart(2, '0');
    const todayStr = (() => { const d = new Date(); return `${d.getFullYear()}-${pad(d.getMonth()+1)}-${pad(d.getDate())}`; })();
    const history = await API.history();
    for (const w of history) {
      const wDate = new Date(w.started_at.replace(' ', 'T') + 'Z');
      const wLocal = `${wDate.getFullYear()}-${pad(wDate.getMonth()+1)}-${pad(wDate.getDate())}`;
      if (wLocal === todayStr && w.calories_burned) todayBurn += w.calories_burned;
    }
  } catch { /* non-critical */ }

  // Only suggest "eat back" when the activity multiplier doesn't already include the session.
  // Sedentary / light users don't have workouts pre-baked into their TDEE.
  const earnedBack = activity === 'sedentary' || activity === 'light';
  const burnRow = todayBurn
    ? `<div class="tdee-workout-burn">
         <span>Today&#39;s workout burned</span>
         <strong>~${todayBurn} kcal</strong>
       </div>
       ${earnedBack
         ? `<div class="tdee-workout-burn tdee-workout-burn--net">
              <span>Eat back (not in your TDEE)</span>
              <strong>${(goalKcal + todayBurn).toLocaleString()} kcal today</strong>
            </div>`
         : `<div class="card__subtitle" style="margin:4px 0 8px">Already counted in your TDEE (${ACTIVITY_LABELS[activity]?.split('(')[0].trim()}).</div>`}`
    : '';

  const goalTile = (key) => {
    const kcal = tdee + GOAL_OFFSETS[key];
    const offset = GOAL_OFFSETS[key];
    const offsetStr = offset === 0 ? '±0' : (offset > 0 ? '+' : '') + offset;
    return `<button class="tdee-goal tdee-goal--${key} ${goal === key ? 'tdee-goal--active' : ''}" data-goal="${key}"><div class="tdee-goal__label">${GOAL_LABELS[key]}</div><div class="tdee-goal__val">${kcal.toLocaleString()}</div><div class="tdee-goal__delta">${offsetStr}</div></button>`;
  };
  root.innerHTML = `
    <div class="tdee-main"><div class="tdee-main__val">${goalKcal.toLocaleString()}</div><div class="tdee-main__unit">kcal / day · ${GOAL_LABELS[goal]}</div></div>
    <div class="tdee-breakdown"><span>TDEE <strong>${tdee.toLocaleString()}</strong></span><span>·</span><span>BMR <strong>${bmr.toLocaleString()}</strong> × ${multiplier.toFixed(3)}</span></div>
    <div class="tdee-goals">${goalTile('cut')}${goalTile('maintain')}${goalTile('bulk')}</div>
    ${burnRow}
    <div class="macros">
      <div class="macros__title">Daily macros</div>
      <div class="macro-row macro-row--protein"><span class="macro-row__name">Protein</span><span class="macro-row__g">${macros.protein.g} g</span><span class="macro-row__kcal">${macros.protein.kcal} kcal</span><span class="macro-row__pct">${macros.protein.pct}%</span></div>
      <div class="macro-bar"><div class="macro-bar__fill macro-bar__fill--protein" style="width:${macros.protein.pct}%"></div><div class="macro-bar__fill macro-bar__fill--carbs" style="width:${macros.carbs.pct}%"></div><div class="macro-bar__fill macro-bar__fill--fat" style="width:${macros.fat.pct}%"></div></div>
      <div class="macro-row macro-row--carbs"><span class="macro-row__name">Carbs</span><span class="macro-row__g">${macros.carbs.g} g</span><span class="macro-row__kcal">${macros.carbs.kcal} kcal</span><span class="macro-row__pct">${macros.carbs.pct}%</span></div>
      <div class="macro-row macro-row--fat"><span class="macro-row__name">Fat</span><span class="macro-row__g">${macros.fat.g} g</span><span class="macro-row__kcal">${macros.fat.kcal} kcal</span><span class="macro-row__pct">${macros.fat.pct}%</span></div>
    </div>
    <div class="card__subtitle" style="margin-top:10px">${weightKg.toFixed(1)} kg · ${heightCm} cm · ${age} yr · ${sex} · ${macros.proteinPerKg} g protein/kg.</div>`;
  root.querySelectorAll('[data-goal]').forEach((btn) => {
    btn.onclick = async () => {
      const next = btn.dataset.goal;
      if (next === goal) return;
      try { await API.updateSettings({ profile_goal: next }); haptic(10); renderTdeeSection(); }
      catch (err) { toast(err.message); }
    };
  });
}

async function openProfileSheet() {
  const sheet = ensureSheet('profile-sheet');
  sheet.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:120px"></div></div></div>`;
  showSheet(sheet);
  let settings;
  try { settings = await API.settings(); }
  catch (err) { sheet.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`; return; }
  const height = settings.profile_height_cm || '';
  const age = settings.profile_age || '';
  const activity = settings.profile_activity || 'moderate';
  const sex = settings.strength_standard_gender === 'female' ? 'female' : 'male';
  const activityOptions = Object.entries(ACTIVITY_LABELS).map(([key, label]) => `
    <label class="radio-row ${activity === key ? 'radio-row--active' : ''}">
      <input type="radio" name="prof-activity" value="${key}" ${activity === key ? 'checked' : ''}/><span>${label}</span>
    </label>`).join('');
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head"><button class="btn--icon" data-close-sheet>←</button><div class="sheet__title">Profile</div><span style="width:40px"></span></div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:12px">Used to compute your daily calorie targets (TDEE). Sex follows your Strength Standards setting (currently <strong>${sex}</strong>).</div>
        <label class="form-label">Height (cm)</label>
        <input class="input" id="prof-height" type="number" inputmode="numeric" min="100" max="250" value="${height}" placeholder="e.g. 178"/>
        <label class="form-label" style="margin-top:14px">Age</label>
        <input class="input" id="prof-age" type="number" inputmode="numeric" min="13" max="100" value="${age}" placeholder="e.g. 28"/>
        <label class="form-label" style="margin-top:14px">Activity level</label>
        <div class="radio-group">${activityOptions}</div>
        <button class="btn btn--primary btn--block" id="prof-save" style="margin-top:20px">Save</button>
      </div>
    </div>`;
  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);
    const radioRow = e.target.closest('.radio-row');
    if (radioRow) { sheet.querySelectorAll('.radio-row').forEach((r) => r.classList.toggle('radio-row--active', r === radioRow)); radioRow.querySelector('input[type=radio]').checked = true; return; }
    if (e.target.closest('#prof-save')) {
      const h = sheet.querySelector('#prof-height').value.trim();
      const a = sheet.querySelector('#prof-age').value.trim();
      const act = sheet.querySelector('input[name=prof-activity]:checked')?.value || 'moderate';
      const heightNum = Number(h), ageNum = Number(a);
      if (!heightNum || heightNum < 100 || heightNum > 250) return toast('Enter a valid height (100–250 cm)');
      if (!ageNum || ageNum < 13 || ageNum > 100) return toast('Enter a valid age (13–100)');
      try {
        await API.updateSettings({ profile_height_cm: String(heightNum), profile_age: String(ageNum), profile_activity: act });
        haptic(20); hideSheet(sheet); await renderTdeeSection(); toast('Profile saved');
      } catch (err) { toast(err.message); }
    }
  };
}

function renderBwChart(rows) {
  const canvas = document.getElementById('bw-chart');
  if (!canvas) return;
  if (chartInstances.bw) chartInstances.bw.destroy();
  const chronological = [...rows].reverse();
  const labels = chronological.map((r) => r.logged_at.slice(0, 10));
  const values = chronological.map((r) => Number((r.weight_unit === 'lbs' ? r.weight * 0.45359237 : r.weight).toFixed(1)));
  const d = chartDefaults();
  chartInstances.bw = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{ data: values, borderColor: '#62d8ff', backgroundColor: 'rgba(98,216,255,0.12)', tension: 0.25, fill: true, pointRadius: 3, pointBackgroundColor: '#62d8ff', pointBorderColor: '#0f0f0f' }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} kg` } } },
      scales: { x: d, y: { ...d, beginAtZero: false } }
    }
  });
}

function openBodyweightSheet() {
  const sheet = ensureSheet('bw-sheet');
  const today = new Date();
  // Prefill with the device's LOCAL date/time, not UTC. toISOString() would
  // shift by the timezone offset (e.g. UTC+7 prefills 7h behind), so the picker
  // would show the wrong "now". datetime-local expects a local wall-clock string.
  const pad = (n) => String(n).padStart(2, '0');
  const iso = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}T${pad(today.getHours())}:${pad(today.getMinutes())}`;
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head"><button class="btn--icon" data-close-sheet>←</button><div class="sheet__title">Log body weight</div><span style="width:40px"></span></div>
      <div class="sheet__body">
        <label class="form-label">Weight</label>
        <div class="set-edit__row">
          <div class="num-input" data-field="weight">
            <button class="num-input__btn" data-bw-step="-1">−</button>
            <input class="num-input__field" id="bw-weight" type="text" inputmode="decimal" value=""/>
            <button class="num-input__btn" data-bw-step="1">+</button>
          </div>
          <button class="unit-toggle kg" id="bw-unit">kg</button>
        </div>
        <label class="form-label" style="margin-top:14px">Date</label>
        <input class="input" id="bw-date" type="datetime-local" value="${iso}"/>
        <label class="form-label" style="margin-top:14px">Notes (optional)</label>
        <input class="input" id="bw-notes" placeholder="Morning, fasted, etc."/>
        <button class="btn btn--primary btn--block" id="bw-save" style="margin-top:20px">Save</button>
      </div>
    </div>`;
  showSheet(sheet);
  sheet.onclick = async (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);
    const unitBtn = e.target.closest('#bw-unit');
    if (unitBtn) { const next = unitBtn.textContent.trim() === 'kg' ? 'lbs' : 'kg'; unitBtn.textContent = next; unitBtn.classList.toggle('kg', next === 'kg'); return; }
    const step = e.target.closest('[data-bw-step]');
    if (step) {
      const input = document.getElementById('bw-weight');
      let v = parseFloat(input.value || '0');
      if (Number.isNaN(v)) v = 0;
      const unit = document.getElementById('bw-unit').textContent.trim();
      const delta = Number(step.dataset.bwStep) * (unit === 'lbs' ? 1 : 0.5);
      let next = v + delta;
      if (next < 0) next = 0;
      input.value = String(+next.toFixed(2));
      haptic(10); return;
    }
    if (e.target.closest('#bw-save')) {
      const weight = parseFloat(document.getElementById('bw-weight').value || '0');
      const unit = document.getElementById('bw-unit').textContent.trim();
      const notes = document.getElementById('bw-notes').value.trim() || null;
      const dateVal = document.getElementById('bw-date').value;
      if (!weight || weight <= 0) return toast('Enter a weight');
      let logged_at = null;
      if (dateVal) { const d = new Date(dateVal); logged_at = d.toISOString().slice(0, 19).replace('T', ' '); }
      try {
        await API.addBodyweight({ weight, weight_unit: unit, notes, logged_at });
        hideSheet(sheet); haptic(20); toast('Logged');
        await renderBodyweightSection();
      } catch (err) { toast(err.message); }
    }
  };
}

export { renderProgress };
