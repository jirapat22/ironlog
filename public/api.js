// ---------- API ----------
const REST_SECONDS = 180; // 3 minutes

async function api(path, opts = {}) {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 30000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(path, {
      headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
      ...opts,
      body: opts.body ? JSON.stringify(opts.body) : undefined
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: res.statusText }));
      throw new Error(err.error || `HTTP ${res.status}`);
    }
    return res.json();
  } catch (err) {
    if (err.name === 'AbortError') throw new Error('Request timed out');
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

const API = {
  exercises: () => api('/api/exercises'),
  addExercise: (data) => api('/api/exercises', { method: 'POST', body: data }),
  programs: () => api('/api/programs'),
  program: (id) => api(`/api/programs/${id}`),
  addDayExercise: (programId, dayId, data) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises`, { method: 'POST', body: data }),
  updateDayExercise: (programId, dayId, pdeId, data) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises/${pdeId}`, { method: 'PATCH', body: data }),
  removeDayExercise: (programId, dayId, pdeId) =>
    api(`/api/programs/${programId}/days/${dayId}/exercises/${pdeId}`, { method: 'DELETE' }),
  lastWorkout: (programDayId) => api(`/api/workouts/last/${programDayId}`),
  workout: (id) => api(`/api/workouts/${id}`),
  workoutSets: (id) => api(`/api/workouts/${id}/sets`),
  startWorkout: (programDayId) =>
    api('/api/workouts', { method: 'POST', body: { program_day_id: programDayId } }),
  finishWorkout: (id) => api(`/api/workouts/${id}/finish`, { method: 'PATCH' }),
  logSet: (data) => api('/api/sets', { method: 'POST', body: data }),
  updateSet: (id, data) => api(`/api/sets/${id}`, { method: 'PATCH', body: data }),
  deleteSet: (id) => api(`/api/sets/${id}`, { method: 'DELETE' }),
  progress: (exerciseId) => api(`/api/progress/${exerciseId}`),
  weeklyVolume: (weeks = 8) => api(`/api/volume/weekly${weeks > 0 ? `?weeks=${weeks}` : ''}`),
  calendar: () => api('/api/calendar'),
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
  deleteProgram: (id) => api(`/api/programs/${id}`, { method: 'DELETE' }),
  settings: () => api('/api/settings'),
  updateSettings: (data) => api('/api/settings', { method: 'PUT', body: data })
};

export { api, API, REST_SECONDS };
