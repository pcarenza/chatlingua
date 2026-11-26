import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const files = new Map([
  ['/', ['index.html', 'text/html']],
  ['/style.css', ['style.css', 'text/css']],
  ['/app.js', ['app.js', 'text/javascript']],
  ['/i18n.js', ['i18n.js', 'text/javascript']],
  ['/android-bridge.js', ['android-bridge.js', 'text/javascript']],
  ['/ringer.js', ['ringer.js', 'text/javascript']],
  ['/sw.js', ['sw.js', 'text/javascript']],
  ['/vendor/qrcode.js', ['vendor/qrcode.js', 'text/javascript']],
  ['/vendor/jsQR.js', ['vendor/jsQR.js', 'text/javascript']],
]);
const rooms = new Map();
const timeout = 90_000;
const token = () => randomBytes(18).toString('hex');
const codes = new Map();
const failures = new Map();
const codeAlphabet = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const codeLifetime = 15 * 60_000;
const failureWindow = 10 * 60_000;
function inviteCode() {
  let code = '';
  while (code.length < 6) {
    for (const byte of randomBytes(12)) if (byte < 248 && code.length < 6) code += codeAlphabet[byte % 31];
  }
  return code;
}
function deleteCodes(room) {
  for (const [code, entry] of codes) if (entry.room === room) codes.delete(code);
}
const member = () => ({ token: token(), seen: Date.now(), cursor: 0, messages: [] });

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  response.end(JSON.stringify(data));
}

async function json(request) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request) {
    bytes += chunk.length;
    if (bytes > 65_536) throw new Error('Signal too large');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

const iceServers = JSON.parse(process.env.ICE_SERVERS || '[{"urls":"stun:stun.l.google.com:19302"}]');

const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, 'http://localhost');
    const file = files.get(url.pathname);
    if (request.method === 'GET' && file) {
      const [name, type] = file;
      const content = await readFile(new URL(name, import.meta.url));
      response.writeHead(200, { 'Content-Type': type + '; charset=utf-8', 'X-Content-Type-Options': 'nosniff' });
      return response.end(content);
    }
    if (request.method === 'GET' && url.pathname === '/api/contacts/push-key') return send(response, 200, { key: null });
    if (request.method === 'POST' && url.pathname === '/api/rooms') {
      if (rooms.size >= 500) return send(response, 503, { error: 'All rooms are in use. Try again shortly.' });
      const id = token();
      const host = member();
      rooms.set(id, { host, guest: null });
      const created = { id, token: host.token, role: 'host', iceServers };
      for (let attempt = 0; attempt < 8; attempt++) {
        const code = inviteCode();
        if (!codes.has(code)) {
          codes.set(code, { room: id, expires: Date.now() + codeLifetime });
          created.code = code;
          break;
        }
      }
      return send(response, 201, created);
    }
    if (url.pathname === '/api/code') {
      if (request.method !== 'POST') return send(response, 405, { error: 'Method unavailable.' });
      const client = request.socket.remoteAddress || 'unknown';
      const now = Date.now();
      const recent = (failures.get(client) || []).filter(at => now - at < failureWindow);
      failures.set(client, recent);
      if (recent.length >= 10) return send(response, 429, { error: 'Too many attempts. Try again later.' });
      const body = await json(request);
      const code = String(body?.code ?? '').toUpperCase().replace(/[\s-]/g, '');
      const entry = new RegExp('^[' + codeAlphabet + ']{6}$').test(code) && codes.get(code);
      const room = entry && entry.expires > now && rooms.get(entry.room);
      if (room && !room.guest) return send(response, 200, { room: entry.room });
      if (entry) codes.delete(code);
      recent.push(now);
      return send(response, 404, { error: 'That code isn\'t valid or has expired.' });
    }
    const route = /^\/api\/rooms\/([a-f0-9]{36})\/(join|signals|leave)$/.exec(url.pathname);
    if (!route) return send(response, 404, { error: 'Page unavailable.' });
    const [, id, action] = route;
    const room = rooms.get(id);
    if (!room) return send(response, 410, { error: 'This room has ended or expired.' });

    if (request.method === 'POST' && action === 'join') {
      if (room.guest) return send(response, 409, { error: 'This room already has two participants.' });
      room.guest = member();
      deleteCodes(id);
      return send(response, 200, { id, token: room.guest.token, role: 'guest', iceServers });
    }

    const authorization = request.headers.authorization;
    const participant = [room.host, room.guest].find(person => person && authorization === 'Bearer ' + person.token);
    if (!participant) return send(response, 403, { error: 'Room access denied.' });
    const peer = participant === room.host ? room.guest : room.host;
    participant.seen = Date.now();

    if (request.method === 'POST' && action === 'leave') {
      rooms.delete(id);
      deleteCodes(id);
      return send(response, 200, {});
    }
    if (request.method === 'GET' && action === 'signals') {
      const after = Number(url.searchParams.get('after'));
      if (!Number.isSafeInteger(after) || after < 0 || after > participant.cursor) {
        return send(response, 400, { error: 'Invalid signal cursor.' });
      }
      participant.messages = participant.messages.filter(message => message.sequence > after);
      return send(response, 200, { paired: Boolean(peer), messages: participant.messages });
    }
    if (request.method === 'POST' && action === 'signals') {
      const data = await json(request);
      if (!peer || !['offer', 'answer', 'candidate', 'media'].includes(data?.type)) {
        return send(response, 400, { error: 'Invalid call signal.' });
      }
      if (peer.messages.length >= 256) return send(response, 429, { error: 'Signal queue full.' });
      peer.messages.push({ sequence: ++peer.cursor, data });
      return send(response, 200, {});
    }
    return send(response, 405, { error: 'Method unavailable.' });
  } catch (error) {
    if (!response.headersSent) send(response, 400, { error: 'Could not process this request.' });
  }
});

setInterval(() => {
  for (const [id, room] of rooms) {
    if ([room.host, room.guest].some(person => person && Date.now() - person.seen > timeout)) { rooms.delete(id); deleteCodes(id); }
  }
  const now = Date.now();
  for (const [code, entry] of codes) if (entry.expires <= now) codes.delete(code);
  for (const [client, times] of failures) if (!times.some(at => now - at < failureWindow)) failures.delete(client);
}, 10_000).unref();

const port = Number(process.env.PORT || 3000);
server.listen(port, process.env.HOST || '127.0.0.1', () => console.log('ChatLingua is running at http://localhost:' + server.address().port));
