-- Dedicated local principals never adopt cloud or operator user identities.
ALTER TABLE users ADD COLUMN local_data_marker TEXT;
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_local_data_marker ON users(local_data_marker);
CREATE TABLE IF NOT EXISTS local_data_principals (
    namespace TEXT PRIMARY KEY,
    box_key_thumbprint TEXT NOT NULL,
    ownership_epoch INTEGER NOT NULL,
    principal_id TEXT NOT NULL,
    native_user_id INTEGER NOT NULL UNIQUE REFERENCES users(id),
    identity_marker TEXT NOT NULL UNIQUE,
    created_at BIGINT NOT NULL,
    UNIQUE(box_key_thumbprint, ownership_epoch, principal_id)
);

UPDATE _schema_version SET version = 31;
