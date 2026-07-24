// ---------- API ----------
const REST_SECONDS = 180; // 3 minutes

// Report genuine API failures (5xx server errors) for automatic bug tracking.
// Deliberately narrow, because the loudest false positives are NOT bugs:
//   • 4xx — expected validation/conflict/not-found responses.
//   • status 0 — the request never got a response: a network blip, a server
//     redeploy, the tab being backgrounded, a navigation/reload aborting an
//     in-flight fetch, or a timeout. Transport/infra noise, not an app bug,
//     and the user already sees an error in the UI.
//   • offline — every call fails then; that's the network, not a bug.
//   • the bug-report endpoint itself — self-referential loop.
// A 5xx means the server actually threw, which is worth surfacing.
function reportApiError(path, method, status, message) {
  if (!status || status < 500) return;
  if (!navigator.onLine) return;
  if (String(path).includes('/api/bug-report')) return;
  document.dispatchEvent(new CustomEvent('ironlog:api-error', { detail: { path, method, status, message } }));
}

// Gateway-level failures (proxy couldn't get a response from the app at all
// — a deploy mid-request, a container restart, a platform blip) are worth
// one silent retry, but ONLY for idempotent methods: retrying a PATCH/DELETE
// just re-applies the same end state, but retrying a POST could create a
// duplicate if the original request actually succeeded and only the
// response got lost in transit.
const RETRYABLE_STATUS = new Set([502, 503, 504]);
const RETRYABLE_METHODS = new Set(['GET', 'PATCH', 'DELETE', 'PUT']);

async function api(path, opts = {}, isRetry = false) {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const method = opts.method || 'GET';
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (res.status === 401) {
      // Session expired or missing — bounce to the lock screen. Swallow the
      // throw at call sites by surfacing a tagged error.
      document.dispatchEvent(new CustomEvent('ironlog:unauthorized'));
      const err = new Error('authentication required');
      err.unauthorized = true;
      throw err;
    }
    if (!res.ok) {
      if (!isRetry && RETRYABLE_STATUS.has(res.status) && RETRYABLE_METHODS.has(method)) {
        clearTimeout(timer);
        await new Promise((r) => setTimeout(r, 400));
        return api(path, opts, true);
      }
      const err = await res.json().catch(() => ({ error: res.statusText }));
      const message = err.error || `HTTP ${res.status}`;
      reportApiError(path, method, res.status, message);
      const thrown = new Error(message);
      thrown.reported = true;
      throw thrown;
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') {
      reportApiError(path, method, 0, 'Request timed out');
      throw new Error('Request timed out');
    }
    if (!err.unauthorized && !err.reported) {
      // Network-level failure (offline, DNS, CORS) — never reached fetch's
      // response handling above, so it hasn't been reported yet.
      reportApiError(path, method, 0, err.message);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const API = {
  createProgram: (data) => api('/api/programs', { method: 'POST', body: data }),
  addDay: (programId, data) => api(`/api/programs/${programId}/days`, { method: 'POST', body: data }),
  renameDay: (programId, dayId, data) => api(`/api/programs/${programId}/days/${dayId}`, { method: 'PATCH', body: data }),
  reorderDays: (programId, dayIds) => api(`/api/programs/${programId}/days/reorder`, { method: 'PATCH', body: { day_ids: dayIds } }),
  deleteDay: (programId, dayId) => api(`/api/programs/${programId}/days/${dayId}`, { method: 'DELETE' }),
  updateExercise: (id, data) => api(`/api/exercises/${id}`, { method: 'PATCH', body: data }),
  deleteExercise: (id) => api(`/api/exercises/${id}`, { method: 'DELETE' }),
  mergeExercise: (id, targetId, adminCode) => api(`/api/exercises/${id}/merge`, { method: 'POST', body: { target_id: targetId, admin_code: adminCode } }),
  exerciseSessions: (id) => api(`/api/exercises/${id}/sessions`),
  moveExerciseSessions: (id, targetId, workoutIds) => api(`/api/exercises/${id}/move-sessions`, { method: 'POST', body: { target_id: targetId, workout_ids: workoutIds } }),
  clearExerciseData: (id) => api(`/api/exercises/${id}/sets`, { method: 'DELETE' }),
  exercises: () => api('/api/exercises'),
  exerciseStats: () => api('/api/exercises/stats'),
  addExercise: (data) => api('/api/exercises', { method: 'POST', body: data }),
  programs: () => api('/api/programs'),
  program: (id) => api(`/api/programs/${id}`),
  dayDetails: (dayId) => api(`/api/programs/days/${dayId}`),
  addDayExercise: (programId, dayId, data) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises`, { method: 'POST', body: data }),
  replaceDayExercises: (programId, dayId, data) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises`, { method: 'PUT', body: data }),
  updateDayExercise: (programId, dayId, pdeId, data) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises/${pdeId}`, { method: 'PATCH', body: data }),
  reorderDayExercises: (programId, dayId, pdeIds) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises/reorder`, { method: 'PATCH', body: { pde_ids: pdeIds } }),
  removeDayExercise: (programId, dayId, pdeId) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises/${pdeId}`, { method: 'DELETE' }),
  lastWorkout: (programDayId) => api(`/api/workouts/last/${programDayId}`),
  lastByExercise: (exerciseIds) => api('/api/workouts/last-by-exercise', { method: 'POST', body: { exercise_ids: exerciseIds } }),
  removeWorkoutExercise: (workoutId, exerciseId) => api(`/api/workouts/${workoutId}/exercises/${exerciseId}`, { method: 'DELETE' }),
  recentWorkouts: (programDayId, n = 3) => api(`/api/workouts/recent/${programDayId}?n=${n}`),
  muscleFrequency: () => api('/api/muscle-frequency'),
  muscleCoverage: () => api(`/api/muscle-coverage?tzOffset=${-new Date().getTimezoneOffset()}`),
  workoutMuscleCoverage: (workoutId) => api(`/api/muscle-coverage?workout_id=${workoutId}`),
  subMuscleFrequency: () => api('/api/sub-muscle-frequency'),
  workout: (id) => api(`/api/workouts/${id}`),
  workoutSets: (id) => api(`/api/workouts/${id}/sets`),
  activeWorkout: () => api('/api/workouts/active'),
  exercise: (id) => api(`/api/exercises/${id}`),
  searchExerciseLibrary: (q) => api(`/api/exercises/library/search?q=${encodeURIComponent(q)}`),
  startWorkout: (programDayId) =>
    api('/api/workouts', { method: 'POST', body: { program_day_id: programDayId } }),
  startQuickWorkout: () => api('/api/workouts', { method: 'POST', body: {} }),
  logActivity: (data) => api('/api/workouts/activity', { method: 'POST', body: data }),
  updateActivity: (id, data) => api(`/api/workouts/${id}/activity`, { method: 'PATCH', body: data }),
  finishWorkout: (id) => api(`/api/workouts/${id}/finish`, { method: 'PATCH' }),
  logSet: (data) => api('/api/sets', { method: 'POST', body: data }),
  updateSet: (id, data) => api(`/api/sets/${id}`, { method: 'PATCH', body: data }),
  deleteSet: (id) => api(`/api/sets/${id}`, { method: 'DELETE' }),
  unitOutliers: () => api('/api/sets/unit-outliers'),
  progress: (exerciseId) => api(`/api/progress/${exerciseId}`),
  strengthHistory: () => api('/api/strength-history'),
  weeklyVolume: (weeks = 8) => api(`/api/volume/weekly?tzOffset=${-new Date().getTimezoneOffset()}${weeks > 0 ? `&weeks=${weeks}` : ''}`),
  weekVolumeCompare: () => api(`/api/volume/week-compare?tzOffset=${-new Date().getTimezoneOffset()}`),
  calendar: () => api(`/api/calendar?tzOffset=${-new Date().getTimezoneOffset()}`),
  prs: () => api('/api/prs'),
  history: () => api('/api/workouts/history'),
  updateWorkout: (id, data) => api(`/api/workouts/${id}`, { method: 'PATCH', body: data }),
  updateFeel: (id, rating) => api(`/api/workouts/${id}`, { method: 'PATCH', body: { feel_rating: rating } }),
  deleteWorkout: (id) => api(`/api/workouts/${id}`, { method: 'DELETE' }),
  bodyweight: () => api('/api/bodyweight'),
  addBodyweight: (data) => api('/api/bodyweight', { method: 'POST', body: data }),
  deleteBodyweight: (id) => api(`/api/bodyweight/${id}`, { method: 'DELETE' }),
  duplicateProgram: (id, data) => api(`/api/programs/${id}/duplicate`, { method: 'POST', body: data }),
  updateProgram: (id, data) => api(`/api/programs/${id}`, { method: 'PATCH', body: data }),
  reorderPrograms: (programIds) => api('/api/programs/reorder', { method: 'PATCH', body: { program_ids: programIds } }),
  deleteProgram: (id) => api(`/api/programs/${id}`, { method: 'DELETE' }),
  settings: () => api('/api/settings'),
  updateSettings: (data) => api('/api/settings', { method: 'PUT', body: data }),
  notes: () => api('/api/notes'),
  addNote: (data) => api('/api/notes', { method: 'POST', body: data }),
  updateNote: (id, data) => api(`/api/notes/${id}`, { method: 'PATCH', body: data }),
  deleteNote: (id) => api(`/api/notes/${id}`, { method: 'DELETE' }),

  // ---- Auth / profiles ----
  authStatus: () => api('/api/auth/status'),
  login: (passcode) => api('/api/auth/login', { method: 'POST', body: { passcode } }),
  createProfile: (data) => api('/api/auth/profiles', { method: 'POST', body: data }),
  me: () => api('/api/auth/me'),
  updateMe: (data) => api('/api/auth/me', { method: 'PATCH', body: data }),
  changePasscode: (passcode) => api('/api/auth/me/passcode', { method: 'POST', body: { passcode } }),
  getApiKey: () => api('/api/auth/me/api-key'),
  regenerateApiKey: () => api('/api/auth/me/api-key', { method: 'POST' }),
  deleteMe: () => api('/api/auth/me', { method: 'DELETE' }),
  logout: () => api('/api/auth/logout', { method: 'POST' }),

  // ---- Bug reports ----
  reportBug: (data) => api('/api/bug-report', { method: 'POST', body: data })
};

export { api, API, REST_SECONDS };
