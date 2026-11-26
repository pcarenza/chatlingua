// Web Push (RFC 8030) with VAPID (RFC 8292) and aes128gcm encryption (RFC 8291), using WebCrypto only.
const encoder = new TextEncoder();

export const toBase64Url = bytes => {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
};
export const fromBase64Url = text => {
  const padded = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  return Uint8Array.from(atob(padded), char => char.charCodeAt(0));
};
const concat = (...parts) => {
  const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
  let offset = 0;
  for (const part of parts) { out.set(part, offset); offset += part.length; }
  return out;
};

async function hkdf(salt, ikm, info, length) {
  const key = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, key, length * 8));
}

export async function encryptPayload(payload, p256dh, auth) {
  const bytes = typeof payload === 'string' ? encoder.encode(payload) : payload;
  if (bytes.length > 3993) throw new Error('Push payload too large');
  const userPublic = fromBase64Url(p256dh);
  const authSecret = fromBase64Url(auth);
  if (userPublic.length !== 65 || userPublic[0] !== 4 || authSecret.length !== 16) throw new Error('Invalid push subscription keys');
  const ephemeral = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const serverPublic = new Uint8Array(await crypto.subtle.exportKey('raw', ephemeral.publicKey));
  const userKey = await crypto.subtle.importKey('raw', userPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const shared = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: userKey }, ephemeral.privateKey, 256));
  const ikm = await hkdf(authSecret, shared, concat(encoder.encode('WebPush: info\0'), userPublic, serverPublic), 32);
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode('Content-Encoding: nonce\0'), 12);
  const aes = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['encrypt']);
  const record = new Uint8Array(await crypto.subtle.encrypt({ name: 'AES-GCM', iv: nonce }, aes, concat(bytes, new Uint8Array([2]))));
  const header = new Uint8Array(21);
  header.set(salt);
  new DataView(header.buffer).setUint32(16, 4096);
  header[20] = serverPublic.length;
  return concat(header, serverPublic, record);
}

export async function vapidHeader(endpoint, { publicKey, privateKey, subject }) {
  const pub = fromBase64Url(publicKey);
  const key = await crypto.subtle.importKey('jwk', {
    kty: 'EC', crv: 'P-256', d: privateKey, x: toBase64Url(pub.slice(1, 33)), y: toBase64Url(pub.slice(33, 65)),
  }, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const head = toBase64Url(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const claims = toBase64Url(encoder.encode(JSON.stringify({
    aud: new URL(endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: subject,
  })));
  const signature = new Uint8Array(await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(head + '.' + claims)));
  return 'vapid t=' + head + '.' + claims + '.' + toBase64Url(signature) + ', k=' + publicKey;
}

export const pushConfig = env => env?.VAPID_PUBLIC_KEY && env?.VAPID_PRIVATE_KEY ? {
  publicKey: env.VAPID_PUBLIC_KEY,
  privateKey: env.VAPID_PRIVATE_KEY,
  subject: env.VAPID_SUBJECT || 'https://chatlingua.pcarenza.workers.dev',
} : null;

// Returns the push service's HTTP status (404/410 mean the subscription is gone), or 0 on failure.
export async function sendPush(subscription, message, config, { ttl = 60, urgency = 'high' } = {}) {
  try {
    const body = await encryptPayload(JSON.stringify(message), subscription.p256dh, subscription.auth);
    const response = await fetch(subscription.endpoint, {
      method: 'POST',
      headers: {
        Authorization: await vapidHeader(subscription.endpoint, config),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: String(ttl),
        Urgency: urgency,
      },
      body,
      signal: AbortSignal.timeout(8000),
    });
    await response.body?.cancel();
    return response.status;
  } catch {
    return 0;
  }
}
