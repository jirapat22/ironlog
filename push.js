const fs = require('fs');
const path = require('path');
const webpush = require('web-push');

// VAPID keys come from env (Railway) or a local file (dev). Auto-generated if missing.
const KEYS_FILE = process.env.VAPID_KEYS_FILE || path.join(__dirname, 'data', 'vapid.json');
// Push services use this as the JWT `sub` claim and can reject placeholder
// domains like example.com. Defaults to the owner's address for this
// single-tenant app; override with VAPID_CONTACT in any other deployment.
const CONTACT = process.env.VAPID_CONTACT || 'mailto:jirapat.pp22@gmail.com';

let keys = null;

function loadKeys() {
  if (process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY) {
    return {
      publicKey: process.env.VAPID_PUBLIC_KEY,
      privateKey: process.env.VAPID_PRIVATE_KEY
    };
  }
  if (fs.existsSync(KEYS_FILE)) {
    try {
      return JSON.parse(fs.readFileSync(KEYS_FILE, 'utf8'));
    } catch {
      /* fall through and regenerate */
    }
  }
  const generated = webpush.generateVAPIDKeys();
  try {
    fs.mkdirSync(path.dirname(KEYS_FILE), { recursive: true });
    fs.writeFileSync(KEYS_FILE, JSON.stringify(generated, null, 2));
  } catch (err) {
    console.warn('Could not persist VAPID keys:', err.message);
  }
  return generated;
}

function init() {
  keys = loadKeys();
  webpush.setVapidDetails(CONTACT, keys.publicKey, keys.privateKey);
  return keys;
}

function getPublicKey() {
  if (!keys) init();
  return keys.publicKey;
}

async function sendTo(subscription, payload) {
  if (!keys) init();
  const body = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return webpush.sendNotification(subscription, body);
}

module.exports = { init, getPublicKey, sendTo };
