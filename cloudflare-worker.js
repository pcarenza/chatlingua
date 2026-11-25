import { ContactService } from './contacts.js';
import { DurableObject } from 'cloudflare:workers';
import worker, { handleRooms } from './dist/server/index.js';

export class RoomService extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    const sql = ctx.storage.sql;
    sql.exec('CREATE TABLE IF NOT EXISTS rooms (id TEXT PRIMARY KEY, revision INTEGER NOT NULL DEFAULT 0, expires INTEGER NOT NULL, state TEXT NOT NULL)');
    sql.exec('CREATE INDEX IF NOT EXISTS rooms_expires ON rooms(expires)');
    this.rooms = {
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
    this.contacts = new ContactService(sql, this.rooms, request => handleRooms(request, this.env, this.rooms));
  }

  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === '/api/contacts' || path.startsWith('/api/contacts/')) return this.contacts.fetch(request);
    return handleRooms(request, this.env, this.rooms);
  }
}

export default worker;
