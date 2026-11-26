import { ContactService } from './contacts.js';
import { DurableObject } from 'cloudflare:workers';
import worker, { handleRooms } from './dist/server/index.js';

export class RoomService extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, state TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS rooms_expires ON rooms(expires)');
    sql.exec('CREATE TABLE IF NOT EXISTS codes (code TEXT PRIMARY KEY, room TEXT NOT NULL, expires INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS codes_room ON codes(room)');
    sql.exec('CREATE TABLE IF NOT EXISTS code_failures (client TEXT NOT NULL, at INTEGER NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS code_failures_client ON code_failures(client, at)');
    this.rooms = {
      createCode(code, room, now, expires) {
        return ctx.storage.transactionSync(() => {
          sql.exec('DELETE FROM codes WHERE expires <= ? OR room NOT IN (SELECT id FROM rooms)', now);
          return sql.exec('INSERT OR IGNORE INTO codes (code, room, expires) VALUES (?, ?, ?)', code, room, expires).rowsWritten > 0;
        });
      },
      readCode(code, now) {
        return sql.exec('SELECT room FROM codes WHERE code = ? AND expires > ?', code, now).toArray()[0]?.room;
      },
      deleteCodes(room) {
        sql.exec('DELETE FROM codes WHERE room = ?', room);
      },
      failures(client, since) {
        return sql.exec('SELECT count(*) AS n FROM code_failures WHERE client = ? AND at > ?', client, since).one().n;
      },
      addFailure(client, now, since) {
        sql.exec('DELETE FROM code_failures WHERE at <= ?', since);
        sql.exec('INSERT INTO code_failures (client, at) VALUES (?, ?)', client, now);
      },
      create(id, now, expires, state) {
        return ctx.storage.transactionSync(() => {
          sql.exec('DELETE FROM rooms WHERE expires <= ?', now);
          return sql.exec('INSERT INTO rooms (id, expires, state) SELECT ?, ?, ? WHERE (SELECT count(*) FROM rooms) < 500',
            id, expires, state).rowsWritten > 0;
        });
      },
      read(id) {
        return sql.exec('SELECT revision, expires, state FROM rooms WHERE id = ?', id).toArray()[0];
      },
      delete(id) {
        sql.exec('DELETE FROM rooms WHERE id = ?', id);
      },
      update(id, revision, expires, state) {
        return sql.exec('UPDATE rooms SET revision = revision + 1, expires = ?, state = ? WHERE id = ? AND revision = ?',
          expires, state, id, revision).rowsWritten > 0;
      },
    };
    this.contacts = new ContactService(sql, this.rooms, request => handleRooms(request, this.env, this.rooms),
      this.env, promise => ctx.waitUntil(promise));
  }

  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/contacts' || path.startsWith('/api/contacts/')) return this.contacts.fetch(request);
    const leaving = request.method === 'POST' && /^\/api\/rooms\/([a-f0-9]{36})\/leave$/.exec(path);
    // The caller hung up: dismiss the ring on the recipient's devices before the room disappears.
    if (leaving) this.contacts.cancelRing(leaving[1]);
    return handleRooms(request, this.env, this.rooms);
  }
}

export default worker;
