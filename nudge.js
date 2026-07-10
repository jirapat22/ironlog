const { db } = require('./db');
const push = require('./push');
const settingsRouter = require('./routes/settings');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_NUDGE_GAP_HOURS = 20; // don't send more than ~once per day

function allProfileIds() {
  return db.prepare('SELECT id FROM profiles ORDER BY id').all().map((r) => r.id);
}

function setProfileSetting(profileId, key, value) {
  db.prepare(
    'INSERT INTO app_settings (profile_id, key, value) VALUES (?, ?, ?) ON CONFLICT(profile_id, key) DO UPDATE SET value = excluded.value'
  ).run(profileId, key, value);
}

function userLocalHour(tzOffsetMin) {
  // tzOffsetMin matches JS Date.getTimezoneOffset() — minutes to ADD to local to get UTC.
  // Example: Bangkok UTC+7 returns -420. Local time = UTC - offset.
  const shifted = new Date(Date.now() - tzOffsetMin * 60_000);
  return shifted.getUTCHours();
}

function inQuietHours(hourOfDay, startHour, endHour) {
  if (startHour <= endHour) return hourOfDay >= startHour && hourOfDay < endHour;
  return hourOfDay >= startHour || hourOfDay < endHour;
}

function hoursBetween(aIso, bIso) {
  if (!aIso) return Infinity;
  const a = new Date(aIso.replace(' ', 'T') + 'Z');
  const b = bIso ? new Date(bIso.replace(' ', 'T') + 'Z') : new Date();
  return (b - a) / 3_600_000;
}

async function runNudgeCheck() {
  for (const profileId of allProfileIds()) {
    try {
      await nudgeProfile(profileId);
    } catch (err) {
      console.warn(`Nudge check failed for profile ${profileId}:`, err.message);
    }
  }
}

async function nudgeProfile(profileId) {
  const settings = settingsRouter.getSettings(profileId);
  if (settings.nudge_enabled !== '1') return;
  const threshold = Number(settings.nudge_threshold_days || 3);
  const qStart = Number(settings.nudge_quiet_start || 22);
  const qEnd = Number(settings.nudge_quiet_end || 8);
  const tzOffset = Number(settings.nudge_tz_offset_minutes || 0);

  const hour = userLocalHour(tzOffset);
  if (inQuietHours(hour, qStart, qEnd)) return;

  // Activity sessions (walks especially) don't count toward "did you train"
  // here — a walk logged purely for calories shouldn't silence the "go lift"
  // reminder, matching the Consistency calendar's same exclusion.
  const last = db
    .prepare(
      `SELECT MAX(finished_at) as t FROM workouts
       WHERE profile_id = ? AND finished_at IS NOT NULL AND (kind IS NULL OR kind != 'activity')`
    )
    .get(profileId);
  const lastTs = last?.t;
  if (!lastTs) return; // no finished workouts ever — don't nag

  const daysSince = hoursBetween(lastTs) / 24;
  if (daysSince < threshold) return;

  const lastNudge = settings.nudge_last_sent_at;
  const hoursSinceNudge = lastNudge ? hoursBetween(lastNudge) : Infinity;
  if (hoursSinceNudge < MIN_NUDGE_GAP_HOURS) return;

  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE profile_id = ?').all(profileId);
  if (!subs.length) return;

  const days = Math.floor(daysSince);
  const payload = {
    title: 'IronLog',
    body:
      days <= 3
        ? "Been a few days. Today's a good day 💪"
        : days <= 7
          ? `It's been ${days} days. Quick session?`
          : `Welcome back whenever — ${days} days off is not the end of gains.`,
    tag: 'ironlog-nudge'
  };

  const results = await Promise.allSettled(
    subs.map((s) =>
      push.sendTo(
        { endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } },
        payload
      )
    )
  );
  // Clean up gone subs
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected' && results[i].reason?.statusCode === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subs[i].endpoint);
    }
  }
  setProfileSetting(profileId, 'nudge_last_sent_at', new Date().toISOString().slice(0, 19).replace('T', ' '));

  console.log(`Nudge sent to ${results.filter((r) => r.status === 'fulfilled').length} device(s) for profile ${profileId} — ${days}d since last workout`);
}

function userLocalDayKey(tzOffsetMin) {
  const shifted = new Date(Date.now() - tzOffsetMin * 60_000);
  return shifted.toISOString().slice(0, 10); // YYYY-MM-DD in user-local
}

function userLocalDayOfWeek(tzOffsetMin) {
  const shifted = new Date(Date.now() - tzOffsetMin * 60_000);
  return shifted.getUTCDay(); // 0=Sun, 6=Sat
}

async function runWeeklySummary() {
  for (const profileId of allProfileIds()) {
    try {
      await weeklySummaryProfile(profileId);
    } catch (err) {
      console.warn(`Weekly summary failed for profile ${profileId}:`, err.message);
    }
  }
}

async function weeklySummaryProfile(profileId) {
  const settings = settingsRouter.getSettings(profileId);
  if (settings.weekly_summary_enabled !== '1') return;

  const tzOffset = Number(settings.nudge_tz_offset_minutes || 0);
  const targetDay = Number(settings.weekly_summary_day || 0); // 0 = Sunday
  const targetHour = Number(settings.weekly_summary_hour || 19);

  const now = new Date(Date.now() - tzOffset * 60_000);
  if (now.getUTCDay() !== targetDay) return;
  if (now.getUTCHours() < targetHour) return;

  // Idempotence: one summary per local-week
  const todayKey = userLocalDayKey(tzOffset);
  if (settings.weekly_summary_last_sent === todayKey) return;

  // Stats for the last 7 calendar days (warmup sets excluded from volume/count;
  // activity sessions excluded from the "workouts" count — a walk logged for
  // calories isn't a lifting session, and it has no sets so it'd report as a
  // free "0 kg" workout otherwise).
  const stats = db.prepare(
    `SELECT
      COUNT(DISTINCT w.id) as workouts,
      COALESCE(SUM(
        CASE WHEN s.is_warmup = 0
        THEN (CASE WHEN s.weight_unit = 'lbs' THEN s.weight * 0.45359237 ELSE s.weight END) * s.reps
        ELSE 0 END
      ), 0) as volume_kg,
      COUNT(CASE WHEN s.is_warmup = 0 THEN 1 END) as sets
     FROM workouts w
     LEFT JOIN sets s ON s.workout_id = w.id
     WHERE w.profile_id = ?
       AND w.finished_at IS NOT NULL
       AND (w.kind IS NULL OR w.kind != 'activity')
       AND w.finished_at >= datetime('now', '-7 days')`
  ).get(profileId);

  const prCount = db.prepare(
    `SELECT COUNT(*) as n FROM personal_records
     WHERE profile_id = ? AND achieved_at >= datetime('now', '-7 days')`
  ).get(profileId).n;

  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE profile_id = ?').all(profileId);
  if (!subs.length) return;

  let body;
  if (stats.workouts === 0) {
    body = 'No workouts this week. Fresh slate tomorrow 🌅';
  } else {
    const vol = Math.round(stats.volume_kg).toLocaleString();
    const prStr = prCount > 0 ? ` · ${prCount} new PR${prCount === 1 ? '' : 's'} 🏆` : '';
    body = `${stats.workouts} workout${stats.workouts === 1 ? '' : 's'} · ${vol} kg total${prStr}`;
  }

  const payload = { title: 'Weekly recap', body, tag: 'ironlog-weekly' };
  const results = await Promise.allSettled(
    subs.map((s) =>
      push.sendTo({ endpoint: s.endpoint, keys: { p256dh: s.p256dh, auth: s.auth } }, payload)
    )
  );
  for (let i = 0; i < results.length; i++) {
    if (results[i].status === 'rejected' && results[i].reason?.statusCode === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(subs[i].endpoint);
    }
  }
  setProfileSetting(profileId, 'weekly_summary_last_sent', todayKey);

  console.log(`Weekly summary sent for profile ${profileId}: ${body}`);
}

function tick() {
  runNudgeCheck();
  runWeeklySummary();
}

function start() {
  // Run once shortly after startup, then on interval
  setTimeout(tick, 30_000);
  setInterval(tick, CHECK_INTERVAL_MS);
}

module.exports = { start, runNudgeCheck, runWeeklySummary };
