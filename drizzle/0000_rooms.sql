CREATE TABLE rooms (
  id TEXT PRIMARY KEY,
  revision INTEGER NOT NULL DEFAULT 0,
  expires INTEGER NOT NULL,
  state TEXT NOT NULL
);
CREATE INDEX rooms_expires ON rooms(expires);
