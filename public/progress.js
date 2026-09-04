import { $, escapeHtml, haptic, toast, formatDateShort, humanAgo, daysAgo, skeletonBlocks, toKg, e1RM, effectiveLoadKg, fmtSetWeight, showSheet, hideSheet, ensureSheet, confirmSheet, SUB_MUSCLES, PICKER_GROUP_ORDER, muscleTagHTML, subMuscleTagHTML } from './utils.js';
import { API } from './api.js';
import { assert } from './bugreport.js';

// Deep-links to History (e.g. "View full history" / a specific past set from
// the exercise-detail sheet below). Event-based rather than an import — this
// module already gets imported BY workout.js (openBodyweightSheet), so
// importing history.js directly would cycle; history.js listens for this
// event globally instead, same pattern as the 'ironlog:switch-tab' event.
function jumpToHistory({ exerciseName = '', workoutId = null } = {}) {
  document.dispatchEvent(new CustomEvent('ironlog:history-focus', { detail: { exerciseName, workoutId } }));
}

const chartInstances = {};
let localBwKg = 0; // updated by renderBodyweightSection; used for strength chart & PR timeline
// Module-level (not function-local) so it survives renderBodyweightSection()
// re-running — deleting or logging a bodyweight entry both call it again,
// which used to quietly re-collapse an expanded "show more" list back to
// the default 4 rows.
let bwHistoryExpanded = false;

// helper: e1RM for a set, folding in BW and per-arm doubling
function calcE1RM(set, exercise, bwKg) {
  return e1RM(effectiveLoadKg(set, exercise, bwKg), set.reps);
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
    <div class="progress-section" id="ps-volume">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Weekly Volume</div>
        <button class="ps-toggle" data-ps-toggle="ps-volume">▾</button>
      </div>
      <div class="ps-body">
        <div id="volume-chart-wrap"></div>
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

    const movementDetail = e.target.closest('[data-movement-detail]');
    if (movementDetail) return openMovementDetail(movementDetail.dataset.movementDetail);

    const overloadToggle = e.target.closest('[data-overload-toggle]');
    if (overloadToggle) {
      const group = overloadToggle.closest('.overload-group');
      if (group) {
        group.classList.toggle('overload-group--collapsed');
        // Remember the manual choice as this render's default, so clearing the
        // search box restores what the user last chose rather than snapping
        // everything shut again (every group now starts collapsed, so the
        // hardcoded default would otherwise undo every expand on clear).
        group.dataset.defaultCollapsed = group.classList.contains('overload-group--collapsed') ? '1' : '0';
        const chevron = overloadToggle.querySelector('.overload-group__chevron');
        if (chevron) chevron.textContent = group.classList.contains('overload-group--collapsed') ? '▸' : '▾';
      }
      return;
    }

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
    renderVolumeSection();
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
    ticks: { color: '#9a8f7e' },
    grid: { color: 'rgba(255,255,255,0.06)' },
    border: { display: false }
  };
}

const MONTHS_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
// "2026-07-08" -> "8 Jul" — compact so several fit on a phone-width axis.
function shortDateLabel(iso) {
  const parts = String(iso).split('-');
  if (parts.length !== 3) return iso;
  return `${Number(parts[2])} ${MONTHS_SHORT[Number(parts[1]) - 1] || ''}`.trim();
}

// Chart.js category x-axis that ALWAYS labels the first and last points plus a
// few evenly-spaced ones between, using the compact "8 Jul" format. Chart.js's
// default autoSkip drops the last tick when it sits close to the previous one —
// which hid the most recent session's date (a lift done today, a few days
// after the prior session, showed no date and looked like the line ended
// earlier). `d` = chartDefaults().
function dateAxis(d) {
  return {
    ...d,
    ticks: {
      ...d.ticks,
      autoSkip: false,
      maxRotation: 0,
      callback(value, index) {
        const n = this.chart.data.labels.length;
        const show = () => shortDateLabel(this.getLabelForValue(value));
        // At most ~5 labels including first + last; keep the last (most recent)
        // date always, and don't place an interior label right next to it.
        if (index === 0 || index === n - 1) return show();
        const step = Math.max(1, Math.ceil((n - 1) / 4));
        return index % step === 0 && index < n - 1 - Math.ceil(step / 2) ? show() : '';
      }
    }
  };
}


const MIN_WEEKLY_SESSIONS = 3;

// Format a Date as local YYYY-MM-DD (avoids UTC-shift on toISOString in +12/+13 timezones)
function localDateStr(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// Days since a plain "YYYY-MM-DD" local-calendar-day string (as produced by
// loggedLocalDay below) — NOT a full timestamp, so this reads it as local
// midnight rather than routing through isoToMs's UTC-assuming parse.
function daysSinceLocalDay(dayStr) {
  return Math.floor((Date.now() - new Date(`${dayStr}T00:00:00`).getTime()) / 86400000);
}

// An exercise not trained in this long is retired, not "progressing" — drop
// it from Progressive Overload the same way a single-session exercise is
// dropped (see the perExercise filter below), so it can't linger on its own
// card or ride along as a merged contributor forever.
const OVERLOAD_STALE_EXERCISE_DAYS = 90;

// Fixed-order categorical palette for movements that combine multiple
// exercises (e.g. swapped equipment) into one chart — one color per
// contributor line, validated for CVD-safe + normal-vision separation and
// contrast against the app's dark surface via the dataviz skill's palette
// validator. Capped at 4: beyond that, `renderOverloadChart` falls back to
// the single merged line rather than reusing (cycling) a color.
const OVERLOAD_LINE_COLORS = ['#3987e5', '#199e70', '#e66767', '#a02fbc'];

// A stored "YYYY-MM-DD HH:MM:SS" is UTC; bucket it by the user's LOCAL calendar
// day (not the raw UTC date) so a morning session in +12/+13 doesn't land on
// the previous day — matching how History and the calendar already group. This
// is what makes "today" land on today in the strength charts.
function loggedLocalDay(loggedAt) {
  return localDateStr(new Date(loggedAt.replace(' ', 'T') + 'Z'));
}

// Group order + the sub-muscles we expect under each, so untrained regions show
// up (not just ones that already have logged sets). Cloned from the canonical
// SUB_MUSCLES (utils.js) because we augment it at runtime with any sub-muscle
// found in the data that isn't in the static list.
const SUB_MUSCLE_MAP = JSON.parse(JSON.stringify(SUB_MUSCLES));

function freqColor(days) {
  if (days == null) return '#9a8f7e';                      // steel — never
  return days >= 7 ? '#c8492b'                              // oxide — overdue
    : days >= 4 ? '#d99a3c'                                 // amber — getting stale
    : days >= 2 ? '#8fb45a'                                 // sage — ok
    : '#b6d06a';                                            // bright sage — fresh
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

    // Per-group recency (min days-ago across its sub-muscles), so we can sort
    // the most-overdue muscles to the top — "what needs attention" at a glance.
    const groupDaysMap = new Map();
    for (const g of groupOrder) {
      let gd = null;
      for (const sub of (SUB_MUSCLE_MAP[g] || [])) {
        const row = byKey.get(`${g}|${sub}`);
        const days = row ? daysSince(row.last_trained_at) : null;
        if (days != null && (gd == null || days < gd)) gd = days;
      }
      groupDaysMap.set(g, gd);
    }
    // Most days since training first; never-trained groups sink to the bottom.
    const sortedGroups = [...groupOrder].sort((a, b) => {
      const da = groupDaysMap.get(a), dbb = groupDaysMap.get(b);
      if (da == null && dbb == null) return 0;
      if (da == null) return 1;
      if (dbb == null) return -1;
      return dbb - da;
    });

    // Per-group HTML for both states, swapped on toggle without a full re-render.
    const groupContent = new Map();

    const html = sortedGroups.map((g) => {
      const subs = SUB_MUSCLE_MAP[g] || [];
      const groupDays = groupDaysMap.get(g);
      const subRows = subs.map((sub) => {
        const row = byKey.get(`${g}|${sub}`);
        const days = row ? daysSince(row.last_trained_at) : null;
        // Untagged "whole muscle" work counts toward group recency above but
        // gets no row of its own — it's noise in the breakdown.
        if (sub === g) return '';
        if (days == null || days >= 7) stale.push(sub);
        const label = days == null ? 'Never' : days === 0 ? 'Today' : days === 1 ? 'Yesterday' : `${days}d ago`;
        const color = freqColor(days);
        return `
          <div class="mfreq-row mfreq-row--sub">
            <span class="mfreq-sub-name">${escapeHtml(sub)}</span>
            <div class="mfreq-bar-wrap"><div class="mfreq-bar" style="background:${color}"></div></div>
            <span class="mfreq-label" style="color:${color}">${label}</span>
          </div>`;
      }).join('');

      // Collapsed view (the default): one clean colored "last trained" line.
      const groupLabel = groupDays == null ? 'Never' : groupDays === 0 ? 'Today' : groupDays === 1 ? 'Yesterday' : `${groupDays}d ago`;
      const groupColor = freqColor(groupDays);
      const summaryRow = `
        <div class="mfreq-row mfreq-row--sub mfreq-row--summary">
          <span class="mfreq-sub-name" style="color:var(--text-dim)">${groupDays == null ? 'Not trained yet' : 'Last trained'}</span>
          <div class="mfreq-bar-wrap"><div class="mfreq-bar" style="background:${groupColor}"></div></div>
          <span class="mfreq-label" style="color:${groupColor}">${groupLabel}</span>
        </div>`;
      groupContent.set(g, { subRows, summaryRow });

      const collapsed = collapsedSet.has(g);
      return `
        <div class="mfreq-group ${collapsed ? 'mfreq-group--collapsed' : ''}" data-mfreq-group="${escapeHtml(g)}">
          <button class="mfreq-group__head" data-toggle-group="${escapeHtml(g)}">
            <span class="badge badge--mg mg-${PICKER_GROUP_ORDER.includes(g) ? g : 'other'}">${g}</span>
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

async function renderVolumeSection() {
  const root = $('#volume-chart-wrap');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;
  try {
    const [rows, compare] = await Promise.all([
      API.weeklyVolume(8),
      API.weekVolumeCompare().catch(() => null)
    ]);
    if (!rows.length) {
      root.innerHTML = `<div class="bw-current__empty">Log some working sets to see weekly volume by muscle group.</div>`;
      return;
    }
    const weeks = [...new Set(rows.map((r) => r.week))].sort();
    // strftime('%Y-%W') -> "2026-25"; just show the week number, the trend matters more than the date.
    const weekLabel = (w) => `Wk ${Number(w.slice(5))}`;

    // One total per week (sum across muscle groups) — a single-hue bar trend
    // answers "am I trending up overall?" at a glance. The old chart stacked
    // up to 8 muscle-group colors per bar; besides being cramped on a phone
    // screen, each group's color was picked by its POSITION in that week's
    // set of trained groups, not a fixed identity — so the same color could
    // mean "chest" one render and "legs" the next as trained groups came in
    // and out of the 8-week window. A single hue sidesteps that entirely.
    const totals = weeks.map((w) => Math.round(
      rows.filter((r) => r.week === w).reduce((sum, r) => sum + r.volume, 0)
    ));
    const thisWeek = totals[totals.length - 1];
    // Trend vs LAST WEEK THROUGH THE SAME POINT (not the full last week), so a
    // partial current week isn't unfairly "down". Falls back to the old full-
    // week-vs-full-week compare if the endpoint is unavailable (offline / old
    // cached server). Labelled "vs same point last wk" so the number is clear.
    let trendStr = '';
    const baseline = compare ? compare.last_to_date : (totals.length > 1 ? totals[totals.length - 2] : null);
    const current = compare ? compare.this_so_far : thisWeek;
    if (baseline != null && baseline > 0) {
      const pct = Math.round(((current - baseline) / baseline) * 100);
      if (Math.abs(pct) >= 1) {
        const sign = pct > 0 ? '+' : '';
        const title = compare ? ' title="vs the same point last week"' : '';
        trendStr = `<span class="bw-current__trend ${pct > 0 ? 'vol-up' : 'vol-down'}"${title}>${sign}${pct}%${compare ? ' vs last wk' : ''}</span>`;
      }
    }

    // Breakdown, by muscle group, for the most recent trained week. Bars
    // encode HARD SETS, not kg — tonnage can't be compared across muscle
    // groups (legs dwarf everything because squat/leg-press loads are huge),
    // but sets per group per week is the standard, load-independent training
    // volume measure, so the bars sit on even footing. The kg figure rides
    // along per row for detail. Bonus: bodyweight work with no added load
    // (0 kg tonnage) now shows up instead of being invisible.
    const latestWeek = weeks[weeks.length - 1];
    const breakdown = rows
      .filter((r) => r.week === latestWeek && ((r.sets ?? 0) > 0 || r.volume > 0))
      .map((r) => ({ group: r.muscle_group, volume: Math.round(r.volume), sets: r.sets ?? 0 }))
      .sort((a, b) => b.sets - a.sets || b.volume - a.volume);
    const maxSets = Math.max(1, ...breakdown.map((b) => b.sets));

    root.innerHTML = `
      <div class="card__subtitle" style="margin-bottom:12px">Total working-set volume (kg) per week — are you trending up overall?</div>
      <div class="bw-current__row" style="margin-bottom:10px">
        <span class="bw-current__val">${thisWeek.toLocaleString()}</span>
        <span class="bw-current__unit">kg this week</span>
        ${trendStr}
      </div>
      <div class="chart-wrap" style="height:120px"><canvas id="volume-chart"></canvas></div>
      ${breakdown.length ? `
        <div class="volume-breakdown">
          <div class="volume-breakdown__title">By muscle group — ${weekLabel(latestWeek)}</div>
          ${breakdown.map((b) => `
            <div class="volume-row">
              <span class="volume-row__label mg-title mg-${escapeHtml(b.group)}">${escapeHtml(b.group)}</span>
              <span class="volume-row__track"><span class="volume-row__fill" style="width:${Math.max(4, Math.round((b.sets / maxSets) * 100))}%"></span></span>
              <span class="volume-row__sets">${b.sets} set${b.sets === 1 ? '' : 's'}</span>
              <span class="volume-row__val">${b.volume.toLocaleString()} kg</span>
            </div>`).join('')}
        </div>` : ''}`;

    const canvas = document.getElementById('volume-chart');
    if (chartInstances.volume) chartInstances.volume.destroy();
    const d = chartDefaults();
    chartInstances.volume = new Chart(canvas, {
      type: 'bar',
      data: {
        labels: weeks.map(weekLabel),
        datasets: [{
          data: totals,
          backgroundColor: '#e07a3c',
          borderRadius: 3,
          maxBarThickness: 28
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toLocaleString()} kg` } }
        },
        scales: { x: d, y: { ...d, beginAtZero: true } }
      }
    });
  } catch (err) { root.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`; }
}

function renderCalendar(entries) {
  const root = $('#calendar');
  // Gym-attendance heat + streak/best/totals are driven ONLY by `count` —
  // unchanged from before. `activity_count` (cardio) is tracked separately
  // and only ever shown as a small dot on the cell, so a heavy-walking week
  // can't inflate the streak or "days at the gym" numbers.
  const countMap = new Map(entries.map((e) => [e.date, e.count]));
  const activityCountMap = new Map(entries.map((e) => [e.date, e.activity_count || 0]));
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
    if (!e.count) continue; // cardio-only day: dotted separately, must not enter the gym-streak/best map (a present-but-zero week would break the run)
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
    const actCnt = activityCountMap.get(iso) || 0;
    const isToday = iso === todayIso;
    const cls = cnt >= 2 ? 'cal-cell--hi' : cnt === 1 ? 'cal-cell--med' : '';
    const tipParts = [iso];
    if (cnt) tipParts.push(`${cnt} session${cnt > 1 ? 's' : ''}`);
    if (actCnt) tipParts.push(`${actCnt} cardio`);
    // The cardio dots are a secondary marker only — they never change cls/the
    // cell's own background, so gym-attendance intensity reads exactly as
    // before even on a day that also had a walk. One dot per session, capped
    // at 3 (a 14px cell can't legibly show more) — the tooltip always has the
    // real count regardless of how many render.
    const dots = actCnt
      ? `<span class="cal-cell__dots">${'<span class="cal-cell__dot"></span>'.repeat(Math.min(actCnt, 3))}</span>`
      : '';
    return `<div class="cal-cell ${cls} ${isToday ? 'cal-cell--today' : ''}" title="${tipParts.join(' · ')}">${dots}</div>`;
  };

  const gridHTML = monthGroups.map(({ label, cols }) => `
    <div class="cal-month-grp">
      <div class="cal-month-name">${label}</div>
      <div class="cal-month-cols">${cols.map((col) => `<div class="cal-col">${col.map(cell).join('')}</div>`).join('')}</div>
    </div>`).join('');

  root.innerHTML = `
    <div class="cal-stats">
      <div class="cal-stat"><div class="cal-stat__val" style="${currentStreak > 0 ? 'color:var(--success)' : ''}">${currentStreak}</div><div class="cal-stat__lbl">wk streak</div></div>
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
    ${entries.some((e) => e.activity_count > 0) ? `
    <div class="cal-legend">
      <span style="font-size:10px;color:var(--text-dim)"><span class="cal-cell__dot" style="position:static;display:inline-block;margin-right:4px;vertical-align:middle"></span>cardio logged that day (doesn't count toward streak)</span>
    </div>` : ''}
  `;

  // The grid renders oldest-month-first (left) through today (right) — with
  // 6 months of history, scrollLeft defaulting to 0 buried today off-screen
  // to the right. Center today instead so it opens where you actually look
  // first; dragging left from there reaches earlier months same as before.
  const scrollEl = root.querySelector('.cal-scroll');
  const todayCell = root.querySelector('.cal-cell--today');
  if (scrollEl && todayCell) {
    // Today is the LAST column in the grid — there's no future data after it
    // to scroll into, so the browser clamps scrollLeft at max and pins today
    // to the right edge instead of the middle (max scroll = scrollWidth -
    // clientWidth, which lands short of the centering target whenever that's
    // less than half the viewport). A trailing spacer gives it room to scroll
    // past today into, same trick as end-padding on a carousel. The spacer
    // needs a non-zero height (not just width via flex-basis) — a height:0
    // flex item is excluded from the scroll container's scrollWidth entirely
    // in Chromium, silently making the spacer a no-op.
    const grid = scrollEl.querySelector('.cal-grid');
    if (grid) {
      const spacer = document.createElement('div');
      spacer.style.flex = `0 0 ${scrollEl.clientWidth / 2}px`;
      spacer.style.height = '1px';
      grid.appendChild(spacer);
    }
    const scrollRect = scrollEl.getBoundingClientRect();
    const cellRect = todayCell.getBoundingClientRect();
    const target = (cellRect.left - scrollRect.left) + scrollEl.scrollLeft - scrollEl.clientWidth / 2 + cellRect.width / 2;
    scrollEl.scrollLeft = Math.max(0, target);
  }
}


// Plateau = no new e1RM high across the last 3 sessions. Compare the best of
// the last 3 sessions to the best of everything before them; if it didn't clear
// the prior best by more than ~1% (noise tolerance), the lift has stalled.
// Needs 4+ sessions so there's a prior window to judge "no gain" against —
// avoids false-flagging brand-new lifts that are still ramping up.
function detectPlateau(values) {
  if (values.length < 4) return false;
  const recentBest = Math.max(...values.slice(-3));
  const priorBest = Math.max(...values.slice(0, -3));
  return recentBest <= priorBest * 1.01;
}

// Estimated-1RM trend, grouped by muscle group then movement. Same-sub_muscle
// exercises whose active date ranges DON'T overlap are merged into one trend —
// that's the swap-by-machine-availability pattern (Leg Press this week, Hack
// Squat next week because Leg Press was taken). Exercises whose ranges DO
// overlap were deliberately programmed together (e.g. Leg Press as the main
// lift + Leg Extension as an accessory, every week) and stay on separate lines
// — merging those would blend incompatible load magnitudes into a meaningless
// zigzag. Needs at least 2 distinct sessions (after merging) to draw a line.
let lastOverloadSeries = [];

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
    // lift got weaker mid-session — the top set is the honest progression signal.
    const perExercise = [];
    for (const ex of history) {
      const byDay = new Map();
      for (const s of ex.sets) {
        const val = calcE1RM(s, ex, bwKg);
        if (!val) continue; // skip sets that can't yield a real e1RM (e.g. unlogged-BW)
        const day = loggedLocalDay(s.logged_at);
        if (!byDay.has(day) || val > byDay.get(day)) byDay.set(day, val);
      }
      const days = [...byDay.keys()].sort();
      // A single session is a dot, not a trend — excluded here (not just at
      // the merged-chart level) so it can't sneak into a movement card as a
      // 2nd/3rd contributor either, where it would otherwise still render as
      // an isolated point and can stretch the shared axis around an outlier
      // that has nothing to compare against yet. Reappears automatically the
      // moment a 2nd session gives it something real to plot.
      if (days.length < 2) continue;
      // Same for an exercise that's gone quiet — its last session is too old
      // to still call "progress," and left in it can merge with a currently
      // trained exercise under the same movement, stretching that chart back
      // to a date that's no longer relevant. Comes back the moment it's
      // trained again.
      if (daysSinceLocalDay(days[days.length - 1]) > OVERLOAD_STALE_EXERCISE_DAYS) continue;
      perExercise.push({
        exercise_id: ex.exercise_id,
        exercise_name: ex.exercise_name,
        muscle_group: ex.muscle_group,
        sub_muscle: ex.sub_muscle || null,
        byDay,
        minDay: days[0],
        maxDay: days[days.length - 1]
      });
    }

    const byMovement = new Map();
    for (const ex of perExercise) {
      const key = `${ex.muscle_group}|${ex.sub_muscle || ex.muscle_group}`;
      if (!byMovement.has(key)) byMovement.set(key, []);
      byMovement.get(key).push(ex);
    }

    const series = [];
    let seriesIdx = 0;
    for (const candidates of byMovement.values()) {
      candidates.sort((a, b) => a.minDay.localeCompare(b.minDay));
      let cluster = null;
      const flush = () => {
        if (!cluster) return;
        const days = [...cluster.byDay.keys()].sort();
        // Belt-and-braces: every contributor is already filtered to >= 2 days
        // before clustering (see the perExercise loop), and merging can only
        // add days — so this can't actually fail any more. Kept so the
        // invariant is enforced here too if that filter ever moves.
        if (days.length >= 2) {
          const values = days.map((d) => Math.round(cluster.byDay.get(d)));
          const first = cluster.contributors[0];
          // Per-contributor series aligned to the shared `days` axis, with a
          // real gap (null) on days that exercise wasn't trained — plotted as
          // its own line rather than folded into one merged best-of value, so
          // switching exercises never reads as a fake jump in strength.
          const lines = cluster.contributors.map((c) => ({
            exercise_id: c.exercise_id,
            exercise_name: c.exercise_name,
            values: days.map((d) => (c.byDay.has(d) ? Math.round(c.byDay.get(d)) : null))
          }));
          series.push({
            key: `movement-${seriesIdx++}`,
            title: cluster.contributors.length > 1 ? (first.sub_muscle || first.muscle_group) : first.exercise_name,
            muscle_group: first.muscle_group,
            sub_muscle: first.sub_muscle,
            contributors: cluster.contributors,
            labels: days,
            values,
            lines,
            plateau: detectPlateau(values)
          });
        }
        cluster = null;
      };
      for (const ex of candidates) {
        if (cluster && ex.minDay > cluster.maxDay) {
          // Starts after everything seen in the cluster so far — no overlap,
          // treat as a continuation (swap) of the same movement.
          for (const [d, v] of ex.byDay) {
            if (!cluster.byDay.has(d) || v > cluster.byDay.get(d)) cluster.byDay.set(d, v);
          }
          cluster.contributors.push(ex);
          if (ex.maxDay > cluster.maxDay) cluster.maxDay = ex.maxDay;
        } else {
          flush();
          cluster = { byDay: new Map(ex.byDay), maxDay: ex.maxDay, contributors: [ex] };
        }
      }
      flush();
    }

    lastOverloadSeries = series;

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

    const subtitle = `<div class="card__subtitle" style="margin-bottom:10px">Best estimated 1-rep max per session, over time — the clearest sign you're getting stronger on a lift. Tap a lift to see its full history. Swapped between equivalent exercises (e.g. machine availability)? They're shown on one chart, one color per exercise, instead of blended into a single misleading line.</div>`;
    const search = `<div class="overload-search"><input class="input" id="overload-search-input" type="search" placeholder="Find a lift…" autocomplete="off" style="margin-bottom:12px"></div>
      <div id="overload-search-empty" class="bw-current__empty hidden">No lifts match "<span id="overload-search-empty-term"></span>".</div>`;

    root.innerHTML = search + subtitle + groupOrder.map((group) => {
      // Section by sub-muscle within the group — "General <group>" (no
      // specific sub-muscle) first, then the group's canonical sub-muscle
      // order, so e.g. Legs reads General -> Quads -> Hamstrings -> Glutes...
      // rather than one flat alphabetical list of exercises.
      const bySub = new Map();
      for (const s of byGroup.get(group)) {
        const subKey = s.sub_muscle || '';
        if (!bySub.has(subKey)) bySub.set(subKey, []);
        bySub.get(subKey).push(s);
      }
      const canonicalSubs = SUB_MUSCLES[group] || [];
      const subOrder = [...bySub.keys()].sort((a, b) => {
        if (a === '') return -1;
        if (b === '') return 1;
        const ia = canonicalSubs.indexOf(a), ib = canonicalSubs.indexOf(b);
        if (ia === -1 && ib === -1) return a.localeCompare(b);
        if (ia === -1) return 1;
        if (ib === -1) return -1;
        return ia - ib;
      });

      const groupSeries = byGroup.get(group);
      // Every group starts collapsed — keeps the page short on open; tap a
      // group to expand it. Manual expand/collapse only lasts this render.
      const collapsed = true;
      const liftCount = groupSeries.length;
      const slug = group.toLowerCase().replace(/[^a-z0-9]+/g, '-');

      return `<div class="overload-group${collapsed ? ' overload-group--collapsed' : ''}" id="ovg-${slug}" data-default-collapsed="${collapsed ? '1' : '0'}">
        <div class="overload-group__head" data-overload-toggle role="button" tabindex="0">
          ${muscleTagHTML(group)}
          <span class="overload-group__meta">${liftCount} lift${liftCount !== 1 ? 's' : ''} <span class="overload-group__chevron">${collapsed ? '▸' : '▾'}</span></span>
        </div>
        <div class="overload-group__body">
          ${subOrder.map((subKey) => {
            const movements = [...bySub.get(subKey)].sort((a, b) => a.title.localeCompare(b.title));
            return `<div class="overload-subgroup">
              ${subMuscleTagHTML(group, subKey || null)}
              ${movements.map((s) => {
                // Only worth a legend/multi-color when every contributor gets
                // its own validated palette slot — beyond that, fall back to
                // the plain "+"-joined label (renderOverloadChart falls back
                // to the merged single line for the same reason).
                const multiColor = s.contributors.length > 1 && s.contributors.length <= OVERLOAD_LINE_COLORS.length;
                const searchText = `${s.title} ${s.muscle_group} ${s.sub_muscle || ''} ${s.contributors.map((c) => c.exercise_name).join(' ')}`.toLowerCase();
                return `
              <div class="overload-exercise" data-search="${escapeHtml(searchText)}">
                <div class="overload-exercise__name" data-movement-detail="${s.key}" role="button" tabindex="0">
                  ${escapeHtml(s.title)}
                  ${s.plateau ? '<span class="overload-plateau-badge">Plateau</span>' : ''}
                </div>
                ${multiColor
                  ? `<div class="overload-legend">${s.contributors.map((c, i) => `<span class="overload-legend__item"><span class="overload-legend__dot" style="background:${OVERLOAD_LINE_COLORS[i]}"></span>${escapeHtml(c.exercise_name)}</span>`).join('')}</div>`
                  : s.contributors.length > 1 ? `<span class="overload-exercise__sub">${s.contributors.map((c) => escapeHtml(c.exercise_name)).join(' + ')}</span>` : ''}
                <div class="overload-chart-wrap"><canvas id="overload-chart-${s.key}"></canvas></div>
                ${s.plateau ? `<div class="overload-plateau-tip">No new high in 3 sessions — train <strong>${escapeHtml(s.sub_muscle || s.muscle_group)}</strong> more often to break the stall.</div>` : ''}
              </div>`;
              }).join('')}
            </div>`;
          }).join('')}
        </div>
      </div>`;
    }).join('');

    for (const s of series) renderOverloadChart(s);
    wireOverloadSearch(root);
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`;
  }
}

// Live filter over exercise/muscle/sub-muscle text. Matching cards stay
// visible and their group auto-expands (even if collapsed by default) so
// typing always surfaces a hit; clearing the box restores each group's
// freshness-based default instead of leaving everything forced open.
function wireOverloadSearch(root) {
  const input = root.querySelector('#overload-search-input');
  const emptyMsg = root.querySelector('#overload-search-empty');
  const emptyTerm = root.querySelector('#overload-search-empty-term');
  if (!input) return;
  input.oninput = () => {
    const q = input.value.trim().toLowerCase();
    let anyVisible = false;
    for (const card of root.querySelectorAll('.overload-exercise')) {
      const match = !q || (card.dataset.search || '').includes(q);
      card.classList.toggle('overload-exercise--hidden', !match);
      if (match) anyVisible = true;
    }
    for (const sub of root.querySelectorAll('.overload-subgroup')) {
      const hasVisible = [...sub.querySelectorAll('.overload-exercise')].some((c) => !c.classList.contains('overload-exercise--hidden'));
      sub.classList.toggle('overload-subgroup--hidden', !hasVisible);
    }
    for (const group of root.querySelectorAll('.overload-group')) {
      const hasVisible = [...group.querySelectorAll('.overload-exercise')].some((c) => !c.classList.contains('overload-exercise--hidden'));
      group.classList.toggle('overload-group--hidden', !hasVisible);
      if (q && hasVisible) group.classList.remove('overload-group--collapsed');
      else if (!q) group.classList.toggle('overload-group--collapsed', group.dataset.defaultCollapsed === '1');
      const chevron = group.querySelector('.overload-group__chevron');
      if (chevron) chevron.textContent = group.classList.contains('overload-group--collapsed') ? '▸' : '▾';
    }
    emptyMsg.classList.toggle('hidden', anyVisible || !q);
    if (emptyTerm) emptyTerm.textContent = q;
  };
}

function renderOverloadChart(s) {
  const canvas = document.getElementById(`overload-chart-${s.key}`);
  if (!canvas) return;
  const key = `overload-${s.key}`;
  if (chartInstances[key]) chartInstances[key].destroy();

  const d = chartDefaults();
  // Multiple contributors get one line each (matching the legend chips
  // rendered above the chart) instead of one merged best-of-day line — a
  // swap between different exercises should never read as a jump in
  // strength. Beyond the validated palette's 4 slots this falls back to the
  // single merged line rather than reusing a color.
  const multi = s.lines.length > 1 && s.lines.length <= OVERLOAD_LINE_COLORS.length;
  const datasets = multi
    ? s.lines.map((line, i) => {
      const color = OVERLOAD_LINE_COLORS[i];
      return {
        label: line.exercise_name,
        data: line.values, borderColor: color, backgroundColor: 'transparent',
        spanGaps: false, // a gap is a real "didn't train this exercise that day", not noise to smooth over
        cubicInterpolationMode: 'monotone', tension: 0.25,
        fill: false, pointRadius: 2, pointBackgroundColor: color, pointBorderColor: '#16130f'
      };
    })
    : [{
      data: s.values, borderColor: '#e07a3c', backgroundColor: 'rgba(224,122,60,0.14)',
      // 'monotone' keeps the curve from overshooting below/above the actual
      // points — plain bezier tension invents phantom dips between values.
      cubicInterpolationMode: 'monotone', tension: 0.25,
      fill: true, pointRadius: 2, pointBackgroundColor: '#e07a3c', pointBorderColor: '#16130f'
    }];

  chartInstances[key] = new Chart(canvas, {
    type: 'line',
    data: { labels: s.labels, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: {
        legend: { display: false }, // the colored name chips above the chart are the legend
        tooltip: { callbacks: { label: (ctx) => `${multi ? ctx.dataset.label + ': ' : ''}e1RM ${ctx.parsed.y} kg` } }
      },
      scales: { x: dateAxis(d), y: { ...d, beginAtZero: false } }
    }
  });
}

// ---------- Fix #3: per-exercise drill-in (tap a lift in the overload list) ----------
function openMovementDetail(seriesKey) {
  const s = lastOverloadSeries.find((x) => x.key === seriesKey);
  if (!s) return;
  if (s.contributors.length > 1) openMovementChooser(s);
  else openExerciseDetailSheet(s.contributors[0].exercise_id, s.contributors[0].exercise_name);
}

function openMovementChooser(s) {
  const sheet = ensureSheet('movement-chooser-sheet');
  sheet.innerHTML = `
    <div class="sheet__inner">
      <div class="sheet__head"><button class="btn--icon" data-close-sheet>←</button><div class="sheet__title">${escapeHtml(s.title)}</div><span style="width:40px"></span></div>
      <div class="sheet__body">
        <div class="card__subtitle" style="margin-bottom:10px">This trend combines sessions across the exercises you swapped between. Pick one to see its full history.</div>
        ${s.contributors.map((c) => `<button class="picker-row" data-detail-pick="${c.exercise_id}" data-detail-name="${escapeHtml(c.exercise_name)}"><span>${escapeHtml(c.exercise_name)}</span><span class="picker-row__state">view</span></button>`).join('')}
      </div>
    </div>`;
  showSheet(sheet);
  sheet.onclick = (e) => {
    if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);
    const pick = e.target.closest('[data-detail-pick]');
    if (pick) { hideSheet(sheet); openExerciseDetailSheet(Number(pick.dataset.detailPick), pick.dataset.detailName); }
  };
}

async function openExerciseDetailSheet(exerciseId, displayName) {
  const sheet = ensureSheet('exercise-detail-sheet');
  sheet.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="skeleton" style="height:160px"></div></div></div>`;
  showSheet(sheet);
  const closeHandler = (e) => { if (e.target.closest('[data-close-sheet]')) hideSheet(sheet); };
  try {
    const [data, bwRows] = await Promise.all([API.progress(exerciseId), API.bodyweight().catch(() => [])]);
    const bwKg = bwRows.length ? toKg(bwRows[0].weight, bwRows[0].weight_unit) : 0;
    const { sets, prs, exercise } = data;
    const name = displayName || exercise?.name || 'Exercise';

    const byDay = new Map();
    for (const s of sets) {
      const val = calcE1RM(s, exercise, bwKg);
      if (!val) continue;
      const day = loggedLocalDay(s.logged_at);
      if (!byDay.has(day) || val > byDay.get(day)) byDay.set(day, val);
    }
    const days = [...byDay.keys()].sort();
    const values = days.map((d) => Math.round(byDay.get(d)));

    // Sets carry the per-arm factor they were logged under, frozen at the
    // time. Answering "just going forward" when an exercise's per-arm setting
    // is changed leaves both factors in the same history, and the e1RM chart
    // then shows a cliff where nothing actually changed: the same 9kg x 10
    // reads ~24kg before the flip and ~12kg after. Worth naming on the screen
    // where that cliff is visible, rather than leaving it to look like a
    // collapse in strength.
    const factorOf = (s) => s.load_multiplier ?? (exercise?.weight_mode === 'per_arm' ? 2 : 1);
    const mixedFactors = !exercise?.is_bodyweight && new Set(sets.map(factorOf)).size > 1;
    const currentFactor = exercise?.weight_mode === 'per_arm' ? 2 : 1;

    // Newest first. Capped in the initial view because a well-used exercise
    // runs to hundreds of sets, but the cap used to be the end of the list
    // with nothing saying so — reported as "recent sets doesn't show the
    // whole one, there is a cap". The rest are now a tap away.
    const allSets = [...sets].reverse();
    const SETS_SHOW_DEFAULT = 15;
    let setsExpanded = false;
    const prRows = [...prs].sort((a, b) => a.reps - b.reps);

    // Collapsed to one headline row by default — a rep-max row per distinct
    // rep count logged gets noisy fast; the rest are a tap away.
    const PR_SHOW_DEFAULT = 1;
    let prExpanded = false;
    const renderPrRows = (expanded) => {
      const visible = expanded ? prRows : prRows.slice(0, PR_SHOW_DEFAULT);
      const hasMore = prRows.length > PR_SHOW_DEFAULT;
      return `${visible.map((r) => `<div class="history-activity__line"><span>${r.reps}-rep max</span><strong>${fmtSetWeight(r.weight, r.weight_unit, exercise?.is_bodyweight, exercise?.is_assisted)} · ${formatDateShort(r.achieved_at)}</strong></div>`).join('')}
        ${hasMore ? `<button class="bw-toggle" data-pr-toggle>${expanded ? '▲ Show less' : `▼ ${prRows.length - PR_SHOW_DEFAULT} more`}</button>` : ''}`;
    };

    const renderSetRows = (expanded) => {
      if (!allSets.length) return '<div class="bw-current__empty">No sets logged yet.</div>';
      const visible = expanded ? allSets : allSets.slice(0, SETS_SHOW_DEFAULT);
      const hidden = allSets.length - visible.length;
      return `${visible.map((s) => {
        const rm = calcE1RM(s, exercise, bwKg);
        return `
        <div class="history-activity__line history-activity__line--link" data-jump-set data-workout-id="${s.workout_id}" role="button" tabindex="0">
          <span>${formatDateShort(s.logged_at)}</span>
          <strong>${fmtSetWeight(s.weight, s.weight_unit, exercise?.is_bodyweight, exercise?.is_assisted)} × ${s.reps}${s.rpe != null ? ` @${s.rpe}` : ''}${rm ? ` · ~${Math.round(rm)}kg 1RM` : ''}</strong>
        </div>`;
      }).join('')}
        ${hidden > 0 ? `<button class="bw-toggle" data-sets-toggle>▼ ${hidden} more</button>`
          : allSets.length > SETS_SHOW_DEFAULT ? `<button class="bw-toggle" data-sets-toggle>▲ Show less</button>` : ''}`;
    };

    sheet.innerHTML = `
      <div class="sheet__inner">
        <div class="sheet__head">
          <button class="btn--icon" data-close-sheet>←</button>
          <div class="sheet__title">${escapeHtml(name)}</div>
          <span style="width:40px"></span>
        </div>
        <div class="sheet__body">
          ${mixedFactors ? `
            <div class="prog-hint prog-hint--mislog" style="margin-bottom:12px">
              <div class="prog-hint__main">&#x26A0; Older sets are counted differently</div>
              <div class="prog-hint__sub">Some sets here count both sides and some count one, so the 1RM halves partway along the chart. That's how they're counted, not what you lifted.</div>
              <button class="btn btn--ghost btn--sm" data-normalise-factors style="margin-top:8px">Count every set as ${currentFactor === 2 ? 'both sides' : 'one side'}</button>
              <div class="card__subtitle" style="margin-top:6px">Your logged weights don't change — only how they're added up. To use the other basis instead, change this exercise's per-side setting first.</div>
            </div>` : ''}
          ${days.length >= 2 ? `<div class="chart-wrap" style="height:160px"><canvas id="ex-detail-chart"></canvas></div>` : `<div class="bw-current__empty">Log this exercise across 2+ sessions to see a trend.</div>`}
          <button class="btn btn--ghost btn--sm" data-view-history style="width:100%;margin:10px 0 2px">View full history →</button>
          ${prRows.length ? `<div class="form-label" style="margin-top:14px">Personal records</div>
            <div id="pr-list">${renderPrRows(prExpanded)}</div>` : ''}
          <div class="form-label" style="margin-top:14px">Recent sets <span style="color:var(--text-dim);font-weight:400">· tap to fix in History</span></div>
          ${exercise?.weight_mode === 'per_arm' && !exercise?.is_bodyweight ? `<div class="card__subtitle" style="margin:-2px 0 6px">Logged per arm/side — the 1RM counts both sides, so it reads about double the weight shown.</div>` : ''}
          <div id="recent-sets-list">${renderSetRows(setsExpanded)}</div>
        </div>
      </div>`;
    sheet.onclick = (e) => {
      if (e.target.closest('[data-close-sheet]')) return hideSheet(sheet);
      if (e.target.closest('[data-view-history]')) { hideSheet(sheet); return jumpToHistory({ exerciseName: name }); }
      if (e.target.closest('[data-pr-toggle]')) { prExpanded = !prExpanded; sheet.querySelector('#pr-list').innerHTML = renderPrRows(prExpanded); return; }
      if (e.target.closest('[data-sets-toggle]')) { setsExpanded = !setsExpanded; sheet.querySelector('#recent-sets-list').innerHTML = renderSetRows(setsExpanded); return; }
      const normalise = e.target.closest('[data-normalise-factors]');
      if (normalise) {
        normalise.disabled = true;
        // Re-stamps every set's factor to the exercise's current setting. The
        // numbers you typed are untouched; only how they are counted changes.
        API.updateExercise(exerciseId, { weight_mode: exercise.weight_mode || 'combined', recompute_past_sets: true })
          .then((r) => {
            haptic(10);
            toast(r.recomputed_sets ? `${r.recomputed_sets} sets recounted` : 'Nothing to change');
            hideSheet(sheet);
            openExerciseDetailSheet(exerciseId, displayName);
          })
          .catch((err) => { toast(err.message); normalise.disabled = false; });
        return;
      }

      const jumpSet = e.target.closest('[data-jump-set]');
      if (jumpSet) { hideSheet(sheet); return jumpToHistory({ exerciseName: name, workoutId: Number(jumpSet.dataset.workoutId) }); }
    };
    if (days.length >= 2) renderExerciseDetailChart(days, values);
  } catch (err) {
    sheet.innerHTML = `<div class="sheet__inner"><div class="sheet__body"><div class="empty">${escapeHtml(err.message)}</div><button class="btn btn--block" data-close-sheet>Close</button></div></div>`;
    sheet.onclick = closeHandler;
  }
}

function renderExerciseDetailChart(days, values) {
  const canvas = document.getElementById('ex-detail-chart');
  if (!canvas) return;
  if (chartInstances.exDetail) chartInstances.exDetail.destroy();
  const d = chartDefaults();
  chartInstances.exDetail = new Chart(canvas, {
    type: 'line',
    data: {
      labels: days,
      datasets: [{
        data: values, borderColor: '#e07a3c', backgroundColor: 'rgba(224,122,60,0.14)',
        cubicInterpolationMode: 'monotone', tension: 0.25,
        fill: true, pointRadius: 2, pointBackgroundColor: '#e07a3c', pointBorderColor: '#16130f'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `e1RM ${ctx.parsed.y} kg` } } },
      scales: { x: dateAxis(d), y: { ...d, beginAtZero: false } }
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
          load_multiplier: r.load_multiplier,
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
        ${list.map((ev) => { const recent = (daysAgo(ev.achievedAt) ?? 99) <= 14; return `<div class="pr-event${recent ? ' pr-event--recent' : ''}">
          <div class="pr-event__date">${ev.reps}-rep max</div>
          <div class="pr-event__body">
            <span class="pr-event__main">${fmtSetWeight(ev.weight, ev.weight_unit, ev.isBodyweight, ev.isAssisted)} × ${ev.reps}${recent ? ' <span class="pr-event__new">✨ new</span>' : ''}</span>
            <span class="pr-event__e1rm">${formatDateShort(ev.achievedAt)} · e1RM ${Math.round(ev.e1rm)} kg</span>
          </div></div>`; }).join('')}
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
  recentEl.innerHTML = renderRecentList(bwHistoryExpanded);
  recentEl.onclick = (e) => {
    if (e.target.closest('[data-bw-toggle]')) { bwHistoryExpanded = !bwHistoryExpanded; recentEl.innerHTML = renderRecentList(bwHistoryExpanded); }
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
  // Guarded divisor: a 0 goal rendered "Infinity%" and style="width:NaN%".
  const pct = (kcal) => (goalKcal > 0 ? Math.round((kcal / goalKcal) * 100) : 0);
  // Protein is a fixed g/kg target, so on an aggressive cut it can exceed the
  // whole goal on its own (past ~103kg at the 1200 floor) and the true
  // percentages then sum well over 100. The NUMBERS stay honest — that
  // overshoot is real and worth seeing — but the bar is a fixed-width
  // container, so its segments get normalised to fit instead of overflowing.
  const raw = { protein: pct(proteinKcal), fat: pct(fatKcal), carbs: pct(carbKcal) };
  const total = raw.protein + raw.fat + raw.carbs;
  const scale = total > 100 ? 100 / total : 1;
  return {
    protein: { g: proteinG, kcal: proteinKcal, pct: raw.protein, barPct: Math.round(raw.protein * scale) },
    fat: { g: fatG, kcal: fatKcal, pct: raw.fat, barPct: Math.round(raw.fat * scale) },
    carbs: { g: carbG, kcal: carbKcal, pct: raw.carbs, barPct: Math.round(raw.carbs * scale) },
    proteinPerKg
  };
}
const GOAL_LABELS = { cut: 'Cut', maintain: 'Maintain', bulk: 'Bulk' };

// A user-set kcal offset. `|| fallback` can't be used: a deliberate 0 ("cut at
// maintenance") is falsy and would snap back to 500/300 — save a 0, reopen the
// profile sheet, and it read 500 again. Only missing/unparseable gets default.
function readKcalOffset(raw, fallback) {
  // Missing must come FIRST. getSetting() returns null for an absent row and
  // Number(null) is 0 — which is finite, so a bare isFinite check handed back
  // a 0 kcal offset for every user who had never saved the Profile sheet,
  // silently telling Plated a cutting user should eat at maintenance. Only a
  // real stored value reaches the numeric path; '0' still means 0.
  if (raw === null || raw === undefined || raw === '') return fallback;
  const n = Math.abs(Number(raw));
  return Number.isFinite(n) ? Math.min(n, 2000) : fallback;
}

// Floor for the daily target — mirrors floorGoalKcal in routes/plated.js so the
// app and Plated can't quote different numbers. Since the offsets became
// adjustable (0-2000) a small TDEE plus a big deficit went NEGATIVE, taking fat
// grams and the macro percentages with it. Never below 1200, never above TDEE.
function floorGoalKcal(goalKcal, tdee) {
  // Math.max(0, ...) so a nonsensical TDEE can't make the floor itself
  // negative and pass a negative goal straight through.
  return Math.max(Math.max(0, Math.min(1200, tdee)), goalKcal);
}

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
  const cutDeficit = readKcalOffset(settings.profile_cut_deficit, 500);
  const bulkSurplus = readKcalOffset(settings.profile_bulk_surplus, 300);
  const GOAL_OFFSETS = { cut: -cutDeficit, maintain: 0, bulk: bulkSurplus };
  const missing = [];
  if (!bw.length) missing.push('body weight');
  if (!heightCm) missing.push('height');
  if (!age) missing.push('age');
  if (missing.length) {
    root.innerHTML = `<div class="bw-current__empty" style="padding:6px 0">Set ${missing.join(', ')} to see your daily calorie targets.</div>
      <button class="btn btn--primary btn--block" data-edit-profile style="margin-top:6px">Set up profile</button>`;
    return;
  }
  // Rounded to 2dp to match routes/plated.js, which reports bodyweight_kg that
  // way and feeds the same rounded value into BMR — without this an lbs user
  // saw different protein/carb grams in the app than Plated received.
  const weightKg = +toKg(bw[0].weight, bw[0].weight_unit).toFixed(2);
  const bmr = Math.round(calcBmrMifflin(weightKg, heightCm, age, sex));
  const multiplier = ACTIVITY_MULTIPLIERS[activity] || 1.55;
  const tdee = Math.round(bmr * multiplier);
  const goalKcal = floorGoalKcal(tdee + GOAL_OFFSETS[goal], tdee);
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
    const kcal = floorGoalKcal(tdee + GOAL_OFFSETS[key], tdee);
    const offset = GOAL_OFFSETS[key];
    // Show the EFFECTIVE delta. When the floor clamps a big cut, the raw
    // offset is a lie about the number right above it — a tile reading 1,200
    // captioned "-2000" off a 1,367 TDEE, or two tiles showing the same kcal
    // with different deltas.
    const effective = kcal - tdee;
    const offsetStr = effective === 0 ? '±0' : (effective > 0 ? '+' : '') + effective;
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
      <div class="macro-bar"><div class="macro-bar__fill macro-bar__fill--protein" style="width:${macros.protein.barPct}%"></div><div class="macro-bar__fill macro-bar__fill--carbs" style="width:${macros.carbs.barPct}%"></div><div class="macro-bar__fill macro-bar__fill--fat" style="width:${macros.fat.barPct}%"></div></div>
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
  const cutDeficit = readKcalOffset(settings.profile_cut_deficit, 500);
  const bulkSurplus = readKcalOffset(settings.profile_bulk_surplus, 300);
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
        <label class="form-label" style="margin-top:14px">Cut deficit (kcal/day below TDEE)</label>
        <input class="input" id="prof-cut" type="number" inputmode="numeric" min="0" max="2000" value="${cutDeficit}" placeholder="e.g. 500"/>
        <label class="form-label" style="margin-top:14px">Bulk surplus (kcal/day above TDEE)</label>
        <input class="input" id="prof-bulk" type="number" inputmode="numeric" min="0" max="2000" value="${bulkSurplus}" placeholder="e.g. 300"/>
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
      const cut = sheet.querySelector('#prof-cut').value.trim();
      const bulk = sheet.querySelector('#prof-bulk').value.trim();
      const heightNum = Number(h), ageNum = Number(a);
      // Empty means "restore the default", not 0 — now that 0 is a legitimate
      // stored value ("cut at maintenance"), a blank box would otherwise save
      // a real zero. The server rejects '' for these keys outright.
      const cutNum = cut === '' ? 500 : Number(cut);
      const bulkNum = bulk === '' ? 300 : Number(bulk);
      if (!heightNum || heightNum < 100 || heightNum > 250) return toast('Enter a valid height (100–250 cm)');
      if (!ageNum || ageNum < 13 || ageNum > 100) return toast('Enter a valid age (13–100)');
      if (!Number.isFinite(cutNum) || cutNum < 0 || cutNum > 2000) return toast('Enter a valid cut deficit (0–2000 kcal)');
      if (!Number.isFinite(bulkNum) || bulkNum < 0 || bulkNum > 2000) return toast('Enter a valid bulk surplus (0–2000 kcal)');
      try {
        await API.updateSettings({
          profile_height_cm: String(heightNum), profile_age: String(ageNum), profile_activity: act,
          profile_cut_deficit: String(cutNum), profile_bulk_surplus: String(bulkNum)
        });
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
  const labels = chronological.map((r) => loggedLocalDay(r.logged_at));
  const values = chronological.map((r) => Number((r.weight_unit === 'lbs' ? r.weight * 0.45359237 : r.weight).toFixed(1)));
  const d = chartDefaults();
  chartInstances.bw = new Chart(canvas, {
    type: 'line',
    data: { labels, datasets: [{ data: values, borderColor: '#cfc4b2', backgroundColor: 'rgba(207,196,178,0.10)', tension: 0.25, fill: true, pointRadius: 3, pointBackgroundColor: '#cfc4b2', pointBorderColor: '#16130f' }] },
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
      const prevBwKg = localBwKg;
      try {
        await API.addBodyweight({ weight, weight_unit: unit, notes, logged_at });
        hideSheet(sheet); haptic(20);
        await renderBodyweightSection();
        const newBwKg = toKg(weight, unit);
        const deltaKg = Math.abs(newBwKg - prevBwKg);
        const jumpOk = prevBwKg <= 0 || (deltaKg <= 5 && deltaKg / prevBwKg <= 0.15);
        assert(jumpOk, 'large bodyweight jump between consecutive entries', {
          prevBwKg: +prevBwKg.toFixed(2), newBwKg: +newBwKg.toFixed(2), deltaKg: +deltaKg.toFixed(2)
        });
        toast(jumpOk ? 'Logged' : `Logged — that's a ${deltaKg.toFixed(1)}kg jump since last time, worth double-checking`);
      } catch (err) { toast(err.message); }
    }
  };
}

export { renderProgress, openBodyweightSheet };
