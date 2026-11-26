// Firebase Cloud Messaging (HTTP v1) from a Worker, using WebCrypto only.
import { toBase64Url } from './webpush.js';
const encoder = new TextEncoder();
const scope = 'https://www.googleapis.com/auth/firebase.messaging';
const configs = new Map();
const tokens = new Map();
const keys = new Map();
let warned = false;

// Parses the FCM_SERVICE_ACCOUNT secret. Returns null (and logs once, without contents) when unusable.
export function fcmConfig(env) {
  const raw = env?.FCM_SERVICE_ACCOUNT;
  if (!raw) return null;
  if (configs.has(raw)) return configs.get(raw);
  let config = null;
  try {
    const account = JSON.parse(raw);
    const tokenUri = new URL(account.token_uri || 'https://oauth2.googleapis.com/token');
    if (tokenUri.protocol !== 'https:' || !/^[a-z0-9-]+$/i.test(account.project_id) ||
        typeof account.client_email !== 'string' || !/-----BEGIN PRIVATE KEY-----/.test(account.private_key)) throw new Error('invalid');
    config = { projectId: account.project_id, email: account.client_email, privateKey: account.private_key, tokenUri: tokenUri.href };
  } catch {
    if (!warned) { warned = true; console.warn('FCM_SERVICE_ACCOUNT is invalid; FCM is disabled.'); }
  }
  configs.set(raw, config);
  return config;
}

async function signingKey(config) {
  if (!keys.has(config.privateKey)) {
    const der = Uint8Array.from(atob(config.privateKey.replace(/-----[A-Z ]+-----|\s+/g, '')), char => char.charCodeAt(0));
    keys.set(config.privateKey, crypto.subtle.importKey('pkcs8', der, { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']));
  }
  try { return await keys.get(config.privateKey); } catch (error) { keys.delete(config.privateKey); throw error; }
}

export async function createJwt(config, now = Date.now()) {
  const iat = Math.floor(now / 1000);
  const head = toBase64Url(encoder.encode(JSON.stringify({ alg: 'RS256', typ: 'JWT' })));
  const claims = toBase64Url(encoder.encode(JSON.stringify({ iss: config.email, scope, aud: config.tokenUri, iat, exp: iat + 3600 })));
  const signature = new Uint8Array(await crypto.subtle.sign('RSASSA-PKCS1-v1_5', await signingKey(config), encoder.encode(head + '.' + claims)));
  return head + '.' + claims + '.' + toBase64Url(signature);
}

export async function accessToken(config) {
  const cached = tokens.get(config.email);
  if (cached && cached.expires - 300_000 > Date.now()) return cached.token;
  const response = await fetch(config.tokenUri, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: await createJwt(config) }),
    signal: AbortSignal.timeout(8000),
  });
  if (!response.ok) { await response.body?.cancel(); throw new Error('FCM token exchange failed: ' + response.status); }
  const { access_token: token, expires_in: seconds } = await response.json();
  if (typeof token !== 'string') throw new Error('FCM token exchange returned no token');
  tokens.set(config.email, { token, expires: Date.now() + (Number(seconds) || 3600) * 1000 });
  return token;
}

// Sends a data message. Returns 'ok', 'gone' (token should be deleted) or 'error'.
export async function sendFcm(deviceToken, data, config) {
  try {
    const body = JSON.stringify({ message: {
      token: deviceToken,
      data: Object.fromEntries(Object.entries(data).map(([key, value]) => [key, String(value)])),
      android: { priority: 'HIGH', ttl: '45s' },
    } });
    const send = async () => fetch('https://fcm.googleapis.com/v1/projects/' + encodeURIComponent(config.projectId) + '/messages:send', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + await accessToken(config), 'Content-Type': 'application/json' },
      body,
      signal: AbortSignal.timeout(8000),
    });
    let response = await send();
    if (response.status === 401) { tokens.delete(config.email); await response.body?.cancel(); response = await send(); }
    if (response.ok) { await response.body?.cancel(); return 'ok'; }
    const text = await response.text().catch(() => '');
    return response.status === 404 || /UNREGISTERED|INVALID_ARGUMENT/.test(text) ? 'gone' : 'error';
  } catch {
    return 'error';
  }
}
