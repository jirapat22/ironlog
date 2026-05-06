const { db } = require('./db');
const push = require('./push');
const settingsRouter = require('./routes/settings');

const CHECK_INTERVAL_MS = 60 * 60 * 1000; // 1 hour
const MIN_NUDGE_GAP_HOURS = 20; // don't send more than ~once per day

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
  try {
    const settings = settingsRouter.getSettings();
    if (settings.nudge_enabled !== '1') return;
    const threshold = Number(settings.nudge_threshold_days || 3);
    const qStart = Number(settings.nudge_quiet_start || 22);
    const qEnd = Number(settings.nudge_quiet_end || 8);
    const tzOffset = Number(settings.nudge_tz_offset_minutes || 0);

    const hour = userLocalHour(tzOffset);
    if (inQuietHours(hour, qStart, qEnd)) return;

    const last = db
      .prepare(
        `SELECT MAX(finished_at) as t FROM workouts WHERE finished_at IS NOT NULL`
      )
      .get();
    const lastTs = last?.t;
    if (!lastTs) return; // no finished workouts ever — don't nag

    const daysSince = hoursBetween(lastTs) / 24;
    if (daysSince < threshold) return;

    const lastNudge = settings.nudge_last_sent_at;
    const hoursSinceNudge = lastNudge ? hoursBetween(lastNudge) : Infinity;
    if (hoursSinceNudge < MIN_NUDGE_GAP_HOURS) return;

    const subs = db.prepare('SELECT * FROM push_subscriptions').all();
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
    db.prepare(
      'INSERT INTO app_settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value'
    ).run('nudge_last_sent_at', new Date().toISOString().slice(0, 19).replace('T', ' '));

    console.log(`Nudge sent to ${results.filter((r) => r.status === 'fulfilled').length} device(s) — ${days}d since last workout`);
  } catch (err) {
    console.warn('Nudge check failed:', err.message);
  }
}

function start() {
  // Run once shortly after startup, then on interval
  setTimeout(runNudgeCheck, 30_000);
  setInterval(runNudgeCheck, CHECK_INTERVAL_MS);
}

module.exports = { start, runNudgeCheck };
