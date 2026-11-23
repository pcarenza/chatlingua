import { assets } from './assets.js';

const timeout = 90_000;
const token = () => Array.from(crypto.getRandomValues(new Uint8Array(18)), n => n.toString(16).padStart(2, '0')).join('');
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

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const method = request.method;
    const asset = Object.hasOwn(assets, url.pathname) && assets[url.pathname];
    if (method === 'GET' && asset) {
      return new Response(asset.body, { headers: {
        'Content-Type': asset.type + '; charset=utf-8',
        'X-Content-Type-Options': 'nosniff',
        'Content-Security-Policy': "default-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        'Referrer-Policy': 'no-referrer',
      } });
    }
    if (request.headers.has('Origin') && request.headers.get('Origin') !== url.origin) {
      return error('Room access denied.', 403);
    }
    const now = Date.now();
    try {
      const db = env.DB.withSession('first-primary');
      const iceServers = JSON.parse(env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');
      if (url.pathname === '/api/rooms' && method === 'POST') {
        const id = token();
        const host = member(now);
        const state = JSON.stringify({ host, guest: null });
        const [, inserted] = await db.batch([
          db.prepare('DELETE FROM rooms WHERE expires <= ?').bind(now),
          db.prepare('INSERT INTO rooms (id, expires, state) SELECT ?, ?, ? WHERE (SELECT count(*) FROM rooms) < 500').bind(id, now + timeout, state),
        ]);
        if (!inserted.meta.changes) return error('All rooms are in use. Try again shortly.', 503);
        return response({ id, token: host.token, role: 'host', iceServers }, 201);
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
        const row = await db.prepare('SELECT revision, expires, state FROM rooms WHERE id = ?').bind(id).first();
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
            await db.prepare('DELETE FROM rooms WHERE id = ?').bind(id).run();
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
        const result = await db.prepare('UPDATE rooms SET revision = revision + 1, expires = ?, state = ? WHERE id = ? AND revision = ?')
          .bind(expires, JSON.stringify(room), id, row.revision).run();
        if (result.meta.changes) return response(data);
      }
      return error('Room is busy. Try again shortly.', 503);
    } catch (cause) {
      console.error('Room service unavailable', cause.message);
      return error('Room service unavailable.', 503);
    }
  },
};
