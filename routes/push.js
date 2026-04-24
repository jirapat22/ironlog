const express = require('express');
const { db } = require('../db');
const push = require('../push');

const router = express.Router();

router.get('/public-key', (req, res) => {
  res.json({ publicKey: push.getPublicKey() });
});

router.post('/subscribe', (req, res) => {
  const sub = req.body || {};
  if (!sub.endpoint || !sub.keys || !sub.keys.p256dh || !sub.keys.auth) {
    return res.status(400).json({ error: 'invalid subscription' });
  }
  const ua = req.get('user-agent') || null;
  db.prepare(
    `INSERT INTO push_subscriptions (endpoint, p256dh, auth, user_agent)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`
  ).run(sub.endpoint, sub.keys.p256dh, sub.keys.auth, ua);
  res.status(201).json({ ok: true });
});

router.post('/unsubscribe', (req, res) => {
  const { endpoint } = req.body || {};
  if (!endpoint) return res.status(400).json({ error: 'endpoint required' });
  db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(endpoint);
  res.json({ ok: true });
});

router.post('/test', async (req, res) => {
  const { title = 'IronLog', body = 'Push notifications are working!' } = req.body || {};
  const rows = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!rows.length) return res.status(404).json({ error: 'no subscriptions' });

  const payload = { title, body, tag: 'ironlog-test' };
  const results = await Promise.allSettled(
    rows.map((row) =>
      push.sendTo(
        { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
        payload
      )
    )
  );

  // Clean up subscriptions that returned 410 Gone
  for (let i = 0; i < results.length; i++) {
    const r = results[i];
    if (r.status === 'rejected' && r.reason?.statusCode === 410) {
      db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(rows[i].endpoint);
    }
  }
  const sent = results.filter((r) => r.status === 'fulfilled').length;
  res.json({ sent, total: rows.length });
});

// Schedule a rest-timer push to fire server-side N seconds from now.
// Used as backup when the main-thread setTimeout can't run (tab closed, OS throttled).
// Single-process design: one pending timer at a time — starting a new rest
// cancels any existing one, and /rest-timer/cancel clears it outright.
let pendingRestTimer = null;

function cancelRestTimer() {
  if (pendingRestTimer) {
    clearTimeout(pendingRestTimer);
    pendingRestTimer = null;
  }
}

router.post('/rest-timer', (req, res) => {
  const { seconds = 180 } = req.body || {};
  const delayMs = Math.max(5, Math.min(600, Number(seconds))) * 1000;
  const rows = db.prepare('SELECT * FROM push_subscriptions').all();
  if (!rows.length) return res.status(404).json({ error: 'no subscriptions' });

  cancelRestTimer();
  pendingRestTimer = setTimeout(async () => {
    pendingRestTimer = null;
    const payload = { title: 'Rest done', body: 'Time for your next set', tag: 'ironlog-rest' };
    const fresh = db.prepare('SELECT * FROM push_subscriptions').all();
    await Promise.allSettled(
      fresh.map((row) =>
        push
          .sendTo(
            { endpoint: row.endpoint, keys: { p256dh: row.p256dh, auth: row.auth } },
            payload
          )
          .catch((err) => {
            if (err?.statusCode === 410) {
              db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ?').run(row.endpoint);
            }
          })
      )
    );
  }, delayMs);

  res.json({ scheduled: true, delayMs });
});

router.post('/rest-timer/cancel', (req, res) => {
  const wasPending = !!pendingRestTimer;
  cancelRestTimer();
  res.json({ cancelled: wasPending });
});

module.exports = router;
