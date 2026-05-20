import { $, escapeHtml, haptic, toast, formatDateShort, humanAgo, daysAgo, skeletonBlocks, toKg, e1RM, fmtSetWeight, showSheet, hideSheet, ensureSheet } from './utils.js';
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
async function renderProgress() {
  const root = $('#view-progress');
  root.innerHTML = `
    <div class="progress-section">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Body Weight</div>
        <button class="btn btn--ghost btn--sm" data-log-bw>+ Log</button>
      </div>
      <div id="bw-current" class="bw-current"></div>
      <div id="bw-recent" class="bw-recent"></div>
      <div class="chart-wrap bw-chart-wrap hidden" id="bw-chart-wrap"><canvas id="bw-chart"></canvas></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Consistency (6 months)</div>
      <div id="calendar" class="calendar"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Daily Calories</div>
        <button class="btn btn--ghost btn--sm" data-edit-profile>Profile</button>
      </div>
      <div id="tdee-card"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Strength Standards (vs. body weight)</div>
      <div id="strength-standards"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">What if I took a break?</div>
      <div id="break-projection"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Readiness (RPE trend)</div>
      <div id="readiness"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Personal Records (best per rep count)</div>
      <div id="pr-timeline"></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__title">Strength Curve</div>
      <select class="input" id="strength-ex"></select>
      <div class="chart-wrap" style="margin-top:12px"><canvas id="strength-chart"></canvas></div>
      <div class="progress-section__title" style="margin-top:18px">Weekly volume — same exercise</div>
      <div class="chart-wrap"><canvas id="ex-volume-chart"></canvas></div>
    </div>
    <div class="progress-section">
      <div class="progress-section__head">
        <div class="progress-section__title" style="margin:0">Weekly Volume by Muscle Group</div>
        <select class="input" id="volume-range" style="width:auto;min-height:34px;padding:0 10px;font-size:13px">
          <option value="4">4 weeks</option>
          <option value="8" selected>8 weeks</option>
          <option value="13">3 months</option>
          <option value="26">6 months</option>
          <option value="52">1 year</option>
          <option value="0">All time</option>
        </select>
      </div>
      <div class="chart-wrap" style="margin-top:12px"><canvas id="volume-chart"></canvas></div>
    </div>
  `;

  root.onclick = async (e) => {
    if (e.target.closest('[data-log-bw]')) return openBodyweightSheet();
    if (e.target.closest('[data-edit-profile]')) return openProfileSheet();
    const del = e.target.closest('[data-del-bw]');
    if (del) {
      const id = Number(del.dataset.delBw);
      if (!confirm('Delete this entry?')) return;
      try {
        await API.deleteBodyweight(id);
        await renderBodyweightSection();
        await renderTdeeSection();
      } catch (err) { toast(err.message); }
    }
  };

  try {
    const [exercises, weekly, calendarDates] = await Promise.all([
      API.exercises(),
      API.weeklyVolume(),
      API.calendar()
    ]);

    await renderBodyweightSection();

    const sel = $('#strength-ex');
    sel.innerHTML = '<option value="">Select an exercise…</option>' +
      exercises.map((e) => `<option value="${e.id}">${escapeHtml(e.name)} (${escapeHtml(e.muscle_group)})</option>`).join('');
    sel.onchange = async () => {
      const id = Number(sel.value);
      if (!id) return;
      const data = await API.progress(id);
      renderStrengthChart(data);
      renderExerciseVolumeChart(data.sets);
    };

    renderVolumeChart(weekly);
    renderCalendar(calendarDates);

    document.getElementById('volume-range').onchange = async (e) => {
      const data = await API.weeklyVolume(Number(e.target.value));
      renderVolumeChart(data);
    };
    renderStrengthStandards();
    renderBreakProjection();
    renderPrTimeline();
    renderReadiness(exercises);
    renderTdeeSection();
  } catch (err) {
    root.innerHTML = `<div class="empty">Couldn't load progress: ${err.message}</div>`;
  }
}

function chartDefaults() {
  return {
    ticks: { color: '#8a8a8a' },
    grid: { color: 'rgba(255,255,255,0.06)' },
    border: { display: false }
  };
}

function renderStrengthChart({ sets, prs, exercise }) {
  const canvas = document.getElementById('strength-chart');
  if (!canvas) return;
  if (chartInstances.strength) chartInstances.strength.destroy();

  const isBw = !!exercise?.is_bodyweight;
  const byDay = new Map();
  for (const s of sets) {
    const day = s.logged_at.slice(0, 10);
    const kg = isBw ? toKg(s.weight, s.weight_unit) + (localBwKg || 0) : toKg(s.weight, s.weight_unit);
    const prev = byDay.get(day) || 0;
    if (kg > prev) byDay.set(day, kg);
  }
  const labels = [...byDay.keys()].sort();
  const values = labels.map((l) => Number(byDay.get(l).toFixed(1)));
  const prDays = new Set(prs.map((p) => p.achieved_at.slice(0, 10)));
  const pointStyle = labels.map((l) => (prDays.has(l) ? 'star' : 'circle'));
  const pointSize = labels.map((l) => (prDays.has(l) ? 9 : 4));
  const d = chartDefaults();

  chartInstances.strength = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        data: values,
        borderColor: '#e8ff47',
        backgroundColor: 'rgba(232,255,71,0.1)',
        tension: 0.25, fill: true,
        pointStyle, pointRadius: pointSize,
        pointBackgroundColor: '#e8ff47',
        pointBorderColor: '#0f0f0f'
      }]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y} kg${isBw ? ' (incl. BW)' : ''}` } } },
      scales: { x: d, y: { ...d, beginAtZero: true } }
    }
  });
}

function renderVolumeChart(rows) {
  const canvas = document.getElementById('volume-chart');
  if (!canvas) return;
  if (chartInstances.volume) chartInstances.volume.destroy();

  const weeks = [...new Set(rows.map((r) => r.week))].sort();
  const groups = [...new Set(rows.map((r) => r.muscle_group))];
  const palette = {
    chest: '#e8ff47', back: '#62d8ff', shoulders: '#ffb347',
    biceps: '#c6a1ff', triceps: '#ff8ad1', arms: '#c6a1ff',
    legs: '#9effa8', core: '#ffe066'
  };
  const defaults = chartDefaults();
  const datasets = groups.map((g) => ({
    label: g,
    data: weeks.map((w) => {
      const row = rows.find((r) => r.week === w && r.muscle_group === g);
      return row ? Math.round(row.volume) : 0;
    }),
    backgroundColor: palette[g] || '#8a8a8a',
    borderRadius: 2
  }));

  chartInstances.volume = new Chart(canvas, {
    type: 'bar',
    data: { labels: weeks, datasets },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { labels: { color: '#c8c8c8', boxWidth: 12 } } },
      scales: { x: { ...defaults, stacked: true }, y: { ...defaults, stacked: true, beginAtZero: true } }
    }
  });
}

const MIN_WEEKLY_SESSIONS = 3;

// Format a Date as local YYYY-MM-DD (avoids UTC-shift on toISOString in +12/+13 timezones)
function localDateStr(d) {
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
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

const STRENGTH_STANDARDS = {
  male: [
    { name: 'Bench Press', novice: 0.75, inter: 1.25, adv: 1.5, elite: 2.0 },
    { name: 'Back Squat', novice: 1.25, inter: 1.75, adv: 2.25, elite: 2.75 },
    { name: 'Deadlift', novice: 1.5, inter: 2.25, adv: 2.75, elite: 3.25 },
    { name: 'Overhead Press', novice: 0.55, inter: 0.9, adv: 1.15, elite: 1.4 }
  ],
  female: [
    { name: 'Bench Press', novice: 0.5, inter: 0.8, adv: 1.0, elite: 1.3 },
    { name: 'Back Squat', novice: 0.9, inter: 1.25, adv: 1.6, elite: 2.0 },
    { name: 'Deadlift', novice: 1.0, inter: 1.5, adv: 2.0, elite: 2.5 },
    { name: 'Overhead Press', novice: 0.35, inter: 0.55, adv: 0.75, elite: 1.0 }
  ]
};

function classifyStrength(ratio, std) {
  if (ratio >= std.elite) return { label: 'Elite', color: '#e8ff47' };
  if (ratio >= std.adv) return { label: 'Advanced', color: '#9effa8' };
  if (ratio >= std.inter) return { label: 'Intermediate', color: '#62d8ff' };
  if (ratio >= std.novice) return { label: 'Novice', color: '#ffb347' };
  return { label: 'Beginner', color: '#8a8a8a' };
}

async function renderStrengthStandards() {
  const root = $('#strength-standards');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;
  try {
    const [prs, bw, settings] = await Promise.all([
      API.prs(), API.bodyweight(),
      API.settings().catch(() => ({ strength_standard_gender: 'male' }))
    ]);
    if (!bw.length) { root.innerHTML = `<div class="bw-current__empty">Log your body weight above to see strength ratios.</div>`; return; }
    const bwKg = toKg(bw[0].weight, bw[0].weight_unit);
    const gender = settings.strength_standard_gender === 'female' ? 'female' : 'male';
    const standards = STRENGTH_STANDARDS[gender];

    const rows = standards.map((std) => {
      const group = prs.find((p) => p.exercise_name === std.name);
      if (!group || !group.records.length) return `<div class="std-row std-row--empty"><div class="std-row__name">${std.name}</div><div class="std-row__meta">No data yet</div></div>`;
      let bestE1RM = 0, bestRec = null;
      for (const r of group.records) {
        const e = e1RM(toKg(r.weight, r.weight_unit), r.reps);
        if (e > bestE1RM) { bestE1RM = e; bestRec = r; }
      }
      const ratio = bestE1RM / bwKg;
      const cls = classifyStrength(ratio, std);
      const pct = Math.min(100, (ratio / std.elite) * 100);
      return `
        <div class="std-row">
          <div class="std-row__top">
            <div class="std-row__name">${std.name}</div>
            <div class="std-row__ratio">${ratio.toFixed(2)}× <span style="color:${cls.color}">${cls.label}</span></div>
          </div>
          <div class="std-row__bar">
            <div class="std-row__fill" style="width:${pct}%;background:${cls.color}"></div>
            <div class="std-row__tick" style="left:${(std.novice / std.elite) * 100}%" title="Novice"></div>
            <div class="std-row__tick" style="left:${(std.inter / std.elite) * 100}%" title="Intermediate"></div>
            <div class="std-row__tick" style="left:${(std.adv / std.elite) * 100}%" title="Advanced"></div>
          </div>
          <div class="std-row__meta">Est. 1RM ${Math.round(bestE1RM)} kg · best ${bestRec.weight}${bestRec.weight_unit} × ${bestRec.reps}</div>
        </div>`;
    }).join('');

    root.innerHTML = `
      <div class="std-header">
        <div class="card__subtitle">Based on best e1RM ÷ body weight (${bw[0].weight} ${bw[0].weight_unit}) · ${gender} standards</div>
        <div class="std-header__toggle">
          <button class="std-tab ${gender === 'male' ? 'std-tab--active' : ''}" data-std-gender="male">Male</button>
          <button class="std-tab ${gender === 'female' ? 'std-tab--active' : ''}" data-std-gender="female">Female</button>
        </div>
      </div>${rows}`;

    root.querySelectorAll('[data-std-gender]').forEach((btn) => {
      btn.onclick = async () => {
        const next = btn.dataset.stdGender;
        if (next === gender) return;
        try { await API.updateSettings({ strength_standard_gender: next }); haptic(10); renderStrengthStandards(); }
        catch (err) { toast(err.message); }
      };
    });
  } catch (err) { root.innerHTML = `<div class="empty">Couldn't compute: ${escapeHtml(err.message)}</div>`; }
}

function projectStrengthLoss(daysOff) {
  if (daysOff <= 0) return 0;
  if (daysOff <= 7) return daysOff * 0.0014;
  if (daysOff <= 21) return 0.01 + (daysOff - 7) * 0.003;
  if (daysOff <= 56) return 0.05 + (daysOff - 21) * 0.004;
  return Math.min(0.35, 0.19 + (daysOff - 56) * 0.002);
}

async function renderBreakProjection() {
  const root = $('#break-projection');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;
  try {
    const prs = await API.prs();
    const mainLifts = ['Bench Press', 'Back Squat', 'Deadlift', 'Overhead Press'];
    const rows = [];
    for (const name of mainLifts) {
      const group = prs.find((p) => p.exercise_name === name);
      if (!group || !group.records.length) { rows.push({ name, empty: true }); continue; }
      let bestE1RM = 0, bestAt = null;
      for (const r of group.records) {
        const e = e1RM(toKg(r.weight, r.weight_unit), r.reps);
        if (e > bestE1RM) { bestE1RM = e; bestAt = r.achieved_at; }
      }
      let daysSince = null;
      try {
        const data = await API.progress(group.exercise_id);
        const lastSet = data.sets[data.sets.length - 1];
        if (lastSet) daysSince = Math.floor((Date.now() - new Date(lastSet.logged_at.replace(' ', 'T') + 'Z').getTime()) / 86400000);
      } catch { /* ignore */ }
      rows.push({ name, bestE1RM, bestAt, daysSince, projections: [{ label: '1 wk', days: 7 }, { label: '2 wk', days: 14 }, { label: '1 mo', days: 30 }, { label: '2 mo', days: 60 }] });
    }
    if (rows.every((r) => r.empty)) { root.innerHTML = `<div class="bw-current__empty">Log a few sessions of the main lifts (bench, squat, deadlift, press) to see this.</div>`; return; }
    root.innerHTML = `
      <div class="card__subtitle" style="margin-bottom:12px">Rough detraining projection from your current best e1RM. Comes back fast when you resume.</div>
      ${rows.map((r) => {
        if (r.empty) return `<div class="break-row break-row--empty"><div class="break-row__name">${r.name}</div><div class="break-row__meta">No data yet</div></div>`;
        const cells = r.projections.map((p) => {
          const loss = projectStrengthLoss(p.days);
          const projected = r.bestE1RM * (1 - loss);
          return `<div class="break-cell"><div class="break-cell__label">${p.label}</div><div class="break-cell__val">${Math.round(projected)}</div><div class="break-cell__delta">-${Math.round(loss * 100)}%</div></div>`;
        }).join('');
        const daysSinceTxt = r.daysSince == null ? '' : r.daysSince === 0 ? 'today' : r.daysSince === 1 ? 'yesterday' : `${r.daysSince}d ago`;
        return `<div class="break-row"><div class="break-row__head"><div class="break-row__name">${r.name}</div><div class="break-row__meta"><span>Now: <strong>${Math.round(r.bestE1RM)} kg</strong></span>${daysSinceTxt ? `<span class="break-row__since">last ${daysSinceTxt}</span>` : ''}</div></div><div class="break-cells">${cells}</div></div>`;
      }).join('')}`;
  } catch (err) { root.innerHTML = `<div class="empty">Couldn't compute: ${escapeHtml(err.message)}</div>`; }
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

async function renderReadiness(exercises) {
  const root = $('#readiness');
  if (!root) return;
  root.innerHTML = `<div class="skeleton" style="height:100px"></div>`;
  const since = Date.now() - 42 * 86400000;
  try {
    const prs = await API.prs();
    const tracked = prs.map((p) => p.exercise_id);
    const datas = await Promise.all(tracked.map((id) => API.progress(id).then((d) => ({ id, d })).catch(() => null)));
    const rows = [];
    for (const item of datas) {
      if (!item) continue;
      const { id, d } = item;
      const exName = exercises.find((e) => e.id === id)?.name || '?';
      const bySession = new Map();
      for (const s of d.sets) {
        if (s.rpe == null) continue;
        const t = new Date(s.logged_at.replace(' ', 'T') + 'Z').getTime();
        if (t < since) continue;
        const day = s.logged_at.slice(0, 10);
        if (!bySession.has(day)) bySession.set(day, []);
        bySession.get(day).push(s);
      }
      if (bySession.size < 2) continue;
      const sessionKeys = [...bySession.keys()].sort();
      const sessionAvgRpe = sessionKeys.map((k) => {
        const sets = bySession.get(k);
        const avg = sets.reduce((acc, s) => acc + s.rpe, 0) / sets.length;
        const maxW = Math.max(...sets.map((s) => toKg(s.weight, s.weight_unit)));
        return { day: k, avgRpe: avg, maxW };
      });
      const recent = sessionAvgRpe.slice(-3);
      const prior = sessionAvgRpe.slice(-6, -3);
      const recentAvg = recent.reduce((a, s) => a + s.avgRpe, 0) / recent.length;
      const priorAvg = prior.length ? prior.reduce((a, s) => a + s.avgRpe, 0) / prior.length : recentAvg;
      const delta = recentAvg - priorAvg;
      const recentW = recent[recent.length - 1].maxW;
      const priorW = prior.length ? prior[prior.length - 1].maxW : recentW;
      const weightUp = recentW > priorW;
      let label, color;
      if (delta >= 0.75 && !weightUp) { label = 'Fatigue building'; color = '#ff8a8a'; }
      else if (delta >= 0.5 && !weightUp) { label = 'Watch it'; color = '#ffb347'; }
      else if (delta <= -0.5 || (delta <= 0.25 && weightUp)) { label = 'Progressing'; color = '#9effa8'; }
      else { label = 'Stable'; color = '#62d8ff'; }
      rows.push({ exName, recentAvg, priorAvg, delta, label, color, weightUp, recentW });
    }
    if (!rows.length) { root.innerHTML = `<div class="bw-current__empty">Log RPE on a few sets to see fatigue/readiness trends.</div>`; return; }
    rows.sort((a, b) => b.delta - a.delta);
    root.innerHTML = `<div class="card__subtitle" style="margin-bottom:10px">Rising RPE at the same weight = fatigue building. Last 3 sessions vs. prior 3.</div>
      ${rows.map((r) => `<div class="ready-row">
        <div class="ready-row__top"><div class="ready-row__name">${escapeHtml(r.exName)}</div><div class="ready-row__label" style="color:${r.color}">${r.label}</div></div>
        <div class="ready-row__meta">Avg RPE ${r.priorAvg.toFixed(1)} → ${r.recentAvg.toFixed(1)} <span style="color:${r.delta > 0 ? '#ff8a8a' : '#9effa8'}">${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)}</span> · ${Math.round(r.recentW)} kg ${r.weightUp ? '↑' : ''}</div>
      </div>`).join('')}`;
  } catch (err) { root.innerHTML = `<div class="empty">Couldn't load: ${escapeHtml(err.message)}</div>`; }
}

function renderExerciseVolumeChart(sets) {
  const canvas = document.getElementById('ex-volume-chart');
  if (!canvas) return;
  if (chartInstances.exVolume) chartInstances.exVolume.destroy();
  if (!sets.length) { const ctx = canvas.getContext('2d'); ctx.clearRect(0, 0, canvas.width, canvas.height); return; }
  const byWeek = new Map();
  for (const s of sets) {
    const d = new Date(s.logged_at.replace(' ', 'T') + 'Z');
    const week = isoWeekKey(d);
    byWeek.set(week, (byWeek.get(week) || 0) + toKg(s.weight, s.weight_unit) * s.reps);
  }
  const labels = [...byWeek.keys()].sort();
  const values = labels.map((w) => Math.round(byWeek.get(w)));
  const d = chartDefaults();
  chartInstances.exVolume = new Chart(canvas, {
    type: 'bar',
    data: { labels, datasets: [{ data: values, backgroundColor: 'rgba(232,255,71,0.8)', borderRadius: 4 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false }, tooltip: { callbacks: { label: (ctx) => `${ctx.parsed.y.toLocaleString()} kg volume` } } },
      scales: { x: d, y: { ...d, beginAtZero: true } }
    }
  });
}

function isoWeekKey(date) {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d - yearStart) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
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
      <span class="bw-current__val">${latest.weight}</span>
      <span class="bw-current__unit">${latest.weight_unit}</span>
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
  const iso = today.toISOString().slice(0, 16);
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
