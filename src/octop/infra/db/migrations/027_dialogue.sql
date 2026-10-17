CREATE TABLE IF NOT EXISTS dialogue_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL UNIQUE,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    application_id TEXT NOT NULL,
    title TEXT NOT NULL,
    payload TEXT NOT NULL,
    updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS dialogue_sessions_owner ON dialogue_sessions(user_id, application_id, updated_at);
UPDATE _schema_version SET version = 27;
