import { pushConfig, sendPush } from './webpush.js';
import { fcmConfig, sendFcm } from './fcm.js';

const randomHex = bytes => Array.from(crypto.getRandomValues(new Uint8Array(bytes)), byte => byte.toString(16).padStart(2, '0')).join('');
const json = (value, status = 200, headers = {}) => Response.json(value, { status, headers: { 'Cache-Control': 'no-store', ...headers } });
const error = (message, status) => json({ error: message }, status);
const cookieName = '__Host-chatlingua';
const codePattern = /^[a-f0-9]{12}$/;
const ringLifetime = 45_000;
const maxSubscriptions = 5;
const maxFcmTokens = 5;
const fcmTokenPattern = /^[A-Za-z0-9_:-]{100,300}$/;
const pushHosts = ['googleapis.com', 'mozilla.com', 'windows.com', 'apple.com'];
const validPushEndpoint = value => {
  try {
    const url = new URL(value);
    return value.length <= 1000 && url.protocol === 'https:' && !url.port && !url.username &&
      pushHosts.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
  } catch { return false; }
};

export class ContactService {
  constructor(sql, rooms, joinRoom, env = {}, waitUntil = promise => promise) {
    this.sql = sql;
    this.env = env;
    this.waitUntil = waitUntil;
    this.rooms = rooms;
    this.joinRoom = joinRoom;
    sql.exec('CREATE TABLE IF NOT EXISTS profiles (code TEXT PRIMARY KEY, token TEXT UNIQUE NOT NULL)');
    sql.exec('CREATE TABLE IF NOT EXISTS contacts (owner TEXT NOT NULL, code TEXT NOT NULL, label TEXT NOT NULL, PRIMARY KEY (owner, code))');
    sql.exec('CREATE TABLE IF NOT EXISTS rings (room TEXT PRIMARY KEY, caller TEXT NOT NULL, recipient TEXT NOT NULL, expires INTEGER NOT NULL, declined INTEGER NOT NULL DEFAULT 0)');
    sql.exec('CREATE INDEX IF NOT EXISTS rings_recipient ON rings(recipient, expires)');
    sql.exec('CREATE INDEX IF NOT EXISTS rings_expires ON rings(expires)');
    sql.exec('CREATE TABLE IF NOT EXISTS push_subscriptions (owner TEXT NOT NULL, endpoint TEXT PRIMARY KEY, p256dh TEXT NOT NULL, auth TEXT NOT NULL, created INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS push_subscriptions_owner ON push_subscriptions(owner, created)');
    sql.exec('CREATE TABLE IF NOT EXISTS fcm_tokens (owner TEXT NOT NULL, token TEXT PRIMARY KEY, created INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS fcm_tokens_owner ON fcm_tokens(owner, created)');
  }

  first(query, ...bindings) {
    return this.sql.exec(query, ...bindings).toArray()[0];
  }

  // Best-effort Web Push to every device of a profile; dead subscriptions are removed.
  push(owner, message, options) {
    this.pushFcm(owner, message);
    const config = pushConfig(this.env);
    if (!config) return;
    const subscriptions = this.sql.exec('SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE owner = ?', owner).toArray();
    if (!subscriptions.length) return;
    this.waitUntil(Promise.all(subscriptions.map(async subscription => {
      const status = await sendPush(subscription, message, config, options);
      if (status === 404 || status === 410) this.sql.exec('DELETE FROM push_subscriptions WHERE endpoint = ?', subscription.endpoint);
    })));
  }

  // Best-effort FCM data message to every Android device of a profile; dead tokens are removed.
  pushFcm(owner, message) {
    const config = fcmConfig(this.env);
    if (!config) return;
    const tokens = this.sql.exec('SELECT token FROM fcm_tokens WHERE owner = ?', owner).toArray();
    if (!tokens.length) return;
    this.waitUntil(Promise.all(tokens.map(async ({ token }) => {
      if (await sendFcm(token, message, config) === 'gone') this.sql.exec('DELETE FROM fcm_tokens WHERE token = ?', token);
    })));
  }

  // Tells the recipient's devices to dismiss a ring notification (accepted, declined or ended).
  cancelRing(room) {
    const ring = this.first('SELECT recipient FROM rings WHERE room = ? AND declined = 0 AND expires > ?', room, Date.now());
    if (ring) this.push(ring.recipient, { type: 'cancel', room }, { ttl: 30 });
  }

  async fetch(request) {
    const url = new URL(request.url);
    const path = url.pathname.slice('/api/contacts'.length);
    const token = request.headers.get('Cookie')?.split(/;\s*/).find(item => item.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
    let profile = token && this.first('SELECT code FROM profiles WHERE token = ?', token);
    if (path === '/profile' && request.method === 'POST') {
      if (profile) return json(profile);
      const code = randomHex(6);
      const secret = randomHex(24);
      this.sql.exec('INSERT INTO profiles (code, token) VALUES (?, ?)', code, secret);
      return json({ code }, 201, { 'Set-Cookie': cookieName + '=' + secret + '; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=31536000' });
    }
    if (path === '/push-key' && request.method === 'GET') return json({ key: pushConfig(this.env)?.publicKey ?? null });
    if (!profile) return error('Set up your contact code first.', 401);
    const owner = profile.code;
    const now = Date.now();
    if (path === '' && request.method === 'GET') {
      const contacts = this.sql.exec('SELECT code, label FROM contacts WHERE owner = ? ORDER BY label COLLATE NOCASE', owner).toArray();
      const incoming = this.sql.exec(`
        SELECT rings.room, rings.expires, rings.caller AS code, COALESCE(contacts.label, rings.caller) AS label
        FROM rings LEFT JOIN contacts ON contacts.owner = ? AND contacts.code = rings.caller
        WHERE rings.recipient = ? AND rings.expires > ? AND rings.declined = 0 ORDER BY rings.expires
      `, owner, owner, now).toArray();
      return json({ code: owner, contacts, incoming: incoming.filter(ring => {
        const room = this.rooms.read(ring.room);
        return room && room.expires > now && !JSON.parse(room.state).guest;
      }) });
    }
    if (request.method !== 'POST') return error('Method unavailable.', 405);
    const reader = request.body?.getReader();
    if (!reader) return error('Invalid contact request.', 400);
    let input;
    try {
      const chunks = [];
      let length = 0;
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        length += value.byteLength;
        if (length > 4096) { await reader.cancel(); return error('Contact request is too large.', 413); }
        chunks.push(value);
      }
      const bytes = new Uint8Array(length);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      input = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return error('Invalid contact request.', 400);
    }

    if (path === '/save' || path === '/remove') {
      const code = input?.code;
      if (typeof code !== 'string' || !codePattern.test(code) || code === owner) return error('Enter your contact’s code.', 400);
      if (path === '/remove') {
        this.sql.exec('DELETE FROM contacts WHERE owner = ? AND code = ?', owner, code);
      } else {
        const label = typeof input.label === 'string' ? input.label.trim() : '';
        if (!label || label.length > 60) return error('Enter a name for this contact.', 400);
        if (!this.first('SELECT code FROM profiles WHERE code = ?', code)) return error('Contact code not found.', 404);
        const count = this.first('SELECT count(*) AS total FROM contacts WHERE owner = ?', owner).total;
        if (count >= 100 && !this.first('SELECT code FROM contacts WHERE owner = ? AND code = ?', owner, code)) {
          return error('Your contact list is full.', 409);
        }
        if (input.keepLabel === true) {
          this.sql.exec('INSERT INTO contacts VALUES (?, ?, ?) ON CONFLICT(owner, code) DO NOTHING', owner, code, label);
        } else {
          this.sql.exec('INSERT INTO contacts VALUES (?, ?, ?) ON CONFLICT(owner, code) DO UPDATE SET label = excluded.label', owner, code, label);
        }
      }
      return json({});
    }

    if (path === '/push-subscribe' || path === '/push-unsubscribe') {
      const { endpoint, keys } = input ?? {};
      if (!validPushEndpoint(endpoint)) return error('Invalid push subscription.', 400);
      if (path === '/push-unsubscribe') {
        this.sql.exec('DELETE FROM push_subscriptions WHERE owner = ? AND endpoint = ?', owner, endpoint);
        return json({});
      }
      if (typeof keys?.p256dh !== 'string' || typeof keys?.auth !== 'string' || keys.p256dh.length > 100 || keys.auth.length > 40) {
        return error('Invalid push subscription.', 400);
      }
      this.sql.exec('INSERT OR REPLACE INTO push_subscriptions (owner, endpoint, p256dh, auth, created) VALUES (?, ?, ?, ?, ?)',
        owner, endpoint, keys.p256dh, keys.auth, now);
      this.sql.exec(`DELETE FROM push_subscriptions WHERE owner = ? AND endpoint NOT IN
        (SELECT endpoint FROM push_subscriptions WHERE owner = ? ORDER BY created DESC, rowid DESC LIMIT ?)`, owner, owner, maxSubscriptions);
      return json({}, 201);
    }

    if (path === '/fcm-register' || path === '/fcm-unregister') {
      const fcmToken = input?.token;
      if (typeof fcmToken !== 'string' || !fcmTokenPattern.test(fcmToken)) return error('Invalid device token.', 400);
      if (path === '/fcm-unregister') {
        this.sql.exec('DELETE FROM fcm_tokens WHERE owner = ? AND token = ?', owner, fcmToken);
        return json({});
      }
      this.sql.exec('INSERT OR REPLACE INTO fcm_tokens (owner, token, created) VALUES (?, ?, ?)', owner, fcmToken, now);
      this.sql.exec(`DELETE FROM fcm_tokens WHERE owner = ? AND token NOT IN
        (SELECT token FROM fcm_tokens WHERE owner = ? ORDER BY created DESC, rowid DESC LIMIT ?)`, owner, owner, maxFcmTokens);
      return json({}, 201);
    }

    if (path === '/ring') {
      const { code, room, hostToken } = input ?? {};
      if (typeof code !== 'string' || typeof room !== 'string' || !/^[a-f0-9]{36}$/.test(room) ||
          !this.first('SELECT code FROM contacts WHERE owner = ? AND code = ?', owner, code)) {
        return error('Choose a saved contact.', 400);
      }
      const row = this.rooms.read(room);
      if (!row || row.expires <= now || JSON.parse(row.state).host.token !== hostToken) {
        return error('Call room unavailable.', 410);
      }
      this.sql.exec('DELETE FROM rings WHERE expires <= ?', now);
      if (this.first(`
        SELECT rings.room FROM rings JOIN rooms ON rooms.id = rings.room
        WHERE (rings.caller = ? OR rings.recipient = ?) AND rings.declined = 0
          AND rooms.expires > ? AND json_extract(rooms.state, '$.guest') IS NULL
      `, owner, code, now)) {
        return error('A call is already ringing. Try again shortly.', 409);
      }
      this.sql.exec('INSERT INTO rings (room, caller, recipient, expires) VALUES (?, ?, ?, ?)', room, owner, code, now + ringLifetime);
      const label = this.first('SELECT label FROM contacts WHERE owner = ? AND code = ?', code, owner)?.label ?? owner;
      this.push(code, { type: 'ring', room, name: label, expires: now + ringLifetime }, { ttl: 45 });
      return json({ expires: now + ringLifetime }, 201);
    }
    if (['/accept', '/decline', '/status'].includes(path)) {
      const room = input?.room;
      if (typeof room !== 'string' || !/^[a-f0-9]{36}$/.test(room)) return error('Invalid call.', 400);
      if (path === '/accept') {
        const ring = this.first('SELECT room FROM rings WHERE room = ? AND recipient = ? AND expires > ? AND declined = 0', room, owner, now);
        if (!ring) return error('This call is no longer ringing.', 410);
        const joined = await this.joinRoom(new Request(new URL('/api/rooms/' + room + '/join', url), { method: 'POST' }));
        if (joined.ok) this.push(owner, { type: 'cancel', room }, { ttl: 30 });
        return joined;
      }
      if (path === '/decline') {
        this.sql.exec('UPDATE rings SET declined = 1 WHERE room = ? AND recipient = ?', room, owner);
        this.push(owner, { type: 'cancel', room }, { ttl: 30 });
        return json({});
      }
      const ring = this.first('SELECT declined, expires FROM rings WHERE room = ? AND caller = ?', room, owner);
      return json({ state: !ring || ring.expires <= now ? 'expired' : ring.declined ? 'declined' : 'ringing' });
    }
    return error('Contact action unavailable.', 404);
  }
}
