import { assets } from './assets.js';

const timeout = 90_000;
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), n => n.toString(16).padStart(2, '0')).join('');
const codeAlphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const codeLifetime = 15 * 60_000;
const failureWindow = 10 * 60_000;
const failureLimit = 10;
function inviteCode() {
  let code = '';
  while (code.length < 6) {
    for (const byte of crypto.getRandomValues(new Uint8Array(12))) {
      if (byte < 248 && code.length < 6) code += codeAlphabet[byte % 31];
    }
  }
  return code;
}
const member = now => ({ token: token(), seen: now, cursor: 0, messages: [] });
const response = (data, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store' },
});
const error = (message, status) => response({ error: message }, status);
const expired = () => error('This room has ended or expired.', 410);

async function readSignal(request) {
  const reader = request.body?.getReader();
  if (!reader) throw new Error('Missing signal');
  const decoder = new TextDecoder();
  let size = 0;
  let text = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) return JSON.parse(text + decoder.decode());
    size += value.byteLength;
    if (size > 65_536) {
      await reader.cancel();
      throw new Error('Signal too large');
    }
    text += decoder.decode(value, { stream: true });
  }
}

function d1Store(database) {
  const db = database.withSession('first-primary');
  return {
    async create(id, now, expires, state) {
      const [, inserted] = await db.batch([
        db.prepare('DELETE FROM rooms WHERE expires <= ?').bind(now),
        db.prepare('INSERT INTO rooms (id, expires, state) SELECT ?, ?, ? WHERE (SELECT count(*) FROM rooms) < 500')
          .bind(id, expires, state),
      ]);
      return Boolean(inserted.meta.changes);
    },
    read(id) {
      return db.prepare('SELECT revision, expires, state FROM rooms WHERE id = ?').bind(id).first();
    },
    delete(id) {
      return db.prepare('DELETE FROM rooms WHERE id = ?').bind(id).run();
    },
    async update(id, revision, expires, state) {
      const result = await db.prepare('UPDATE rooms SET revision = revision + 1, expires = ?, state = ? WHERE id = ? AND revision = ?')
        .bind(expires, state, id, revision).run();
      return Boolean(result.meta.changes);
    },
  };
}

export async function handleRooms(request, env, store) {
  const url = new URL(request.url);
  const method = request.method;
  const now = Date.now();
  try {
    const iceServers = JSON.parse(env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');
    if (url.pathname === '/api/rooms' && method === 'POST') {
      const id = token();
      const host = member(now);
      const state = JSON.stringify({ host, guest: null });
      if (!await store.create(id, now, now + timeout, state)) return error('All rooms are in use. Try again shortly.', 503);
      const created = { id, token: host.token, role: 'host', iceServers };
      if (store.createCode) {
        try {
          for (let attempt = 0; attempt < 8; attempt++) {
            const code = inviteCode();
            if (await store.createCode(code, id, now, now + codeLifetime)) { created.code = code; break; }
          }
        } catch (cause) {
          console.error('Invite code unavailable', cause.message);
        }
      }
      return response(created, 201);
    }
    if (url.pathname === '/api/code') {
      if (method !== 'POST') return error('Method unavailable.', 405);
      if (!store.readCode) return error('Invite codes are unavailable.', 404);
      const client = request.headers.get('CF-Connecting-IP') || 'unknown';
      if (await store.failures(client, now - failureWindow) >= failureLimit) return error('Too many attempts. Try again later.', 429);
      let body;
      try { body = await readSignal(request); }
      catch { return error('Invalid invite code.', 400); }
      const code = String(body?.code ?? '').toUpperCase().replace(/[\s-]/g, '');
      const found = new RegExp('^[' + codeAlphabet + ']{6}$').test(code) && await store.readCode(code, now);
      const live = found && await store.read(found);
      if (live && live.expires > now && !JSON.parse(live.state).guest) return response({ room: found });
      if (found) await store.deleteCodes(found);
      await store.addFailure(client, now, now - failureWindow);
      return error('That code isn\'t valid or has expired.', 404);
    }
    const route = /^\/api\/rooms\/([a-f0-9]{36})\/(join|signals|leave)$/.exec(url.pathname);
    if (!route) return error('Page unavailable.', 404);
    const [, id, action] = route;
    const postingSignal = action === 'signals' && method === 'POST';
    let signal;
    if (postingSignal) {
      try { signal = await readSignal(request); }
      catch { return error('Invalid call signal.', 400); }
      if (!['offer', 'answer', 'candidate', 'media'].includes(signal?.type)) return error('Invalid call signal.', 400);
    }
    for (let attempt = 0; attempt < 8; attempt++) {
      const row = await store.read(id);
      if (!row || row.expires <= now) return expired();
      const room = JSON.parse(row.state);
      const joining = action === 'join' && method === 'POST';
      let data;
      if (joining) {
        if (room.guest) return error('This room already has two participants.', 409);
        room.guest = member(now);
        data = { id, token: room.guest.token, role: 'guest', iceServers };
      } else {
        const authorization = request.headers.get('Authorization');
        const participant = [room.host, room.guest].find(person => person && authorization === 'Bearer ' + person.token);
        if (!participant) return error('Room access denied.', 403);
        const peer = participant === room.host ? room.guest : room.host;
        if (action === 'leave' && method === 'POST') {
          await store.delete(id);
          if (store.deleteCodes) await store.deleteCodes(id);
          return response({});
        }
        if (action === 'signals' && method === 'GET') {
          const after = Number(url.searchParams.get('after'));
          if (!Number.isSafeInteger(after) || after < 0 || after > participant.cursor) return error('Invalid signal cursor.', 400);
          const messages = participant.messages.filter(message => message.sequence > after);
          data = { paired: Boolean(peer), messages };
          if (now - participant.seen < 12_000 && messages.length === participant.messages.length) return response(data);
          participant.messages = messages;
        } else if (postingSignal) {
          if (!peer) return error('Invalid call signal.', 400);
          if (peer.messages.length >= 256) return error('Signal queue full.', 429);
          peer.messages.push({ sequence: ++peer.cursor, data: signal });
          data = {};
        } else {
          return error('Method unavailable.', 405);
        }
        participant.seen = now;
      }
      const expires = Math.min(room.host.seen, room.guest?.seen ?? room.host.seen) + timeout;
      if (await store.update(id, row.revision, expires, JSON.stringify(room))) {
        if (joining && store.deleteCodes) await store.deleteCodes(id);
        return response(data);
      }
    }
    return error('Room is busy. Try again shortly.', 503);
  } catch (cause) {
    console.error('Room service unavailable', cause.message);
    return error('Room service unavailable.', 503);
  }
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const asset = Object.hasOwn(assets, url.pathname) && assets[url.pathname];
    if (method === 'GET' && asset) {
      const body = url.pathname === '/' && env.ROOMS
        ? asset.body
          .replace('<html lang="en">', '<html lang="en" data-region="' + (/^[A-Z]{2}$/.test(request.cf?.country) ? request.cf.country : '') + '">')
          .replace('<!-- android-download -->', '<a class="android-download" id="android-download" href="https://chatlingua-download.pcarenza.workers.dev/ChatLingua-Cloudflare.apk">Download Android app</a>')
          .replace('class="contacts" aria-labelledby="contacts-title" hidden', 'class="contacts" aria-labelledby="contacts-title"')
        : asset.body;
      return new Response(body, { headers: {
        'Content-Type': asset.type + '; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        'Referrer-Policy': 'no-referrer',
      } });
    }
    if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) {
      return error('Room access denied.', 403);
    }
    if (env.ROOMS) return env.ROOMS.getByName('rooms').fetch(request);
    return handleRooms(request, env, d1Store(env.DB));
  },
};
