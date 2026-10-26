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

-- Repair databases where the device branch used version 31 before the assistant migration.
CREATE TABLE IF NOT EXISTS assistant_knowledge_access (
    box_id TEXT NOT NULL,
    warehouse_id TEXT NOT NULL,
    audience TEXT NOT NULL CHECK (audience IN ('none','all','selected')),
    members_json TEXT NOT NULL DEFAULT '[]',
    revision BIGINT NOT NULL,
    updated_by BIGINT NOT NULL REFERENCES users(id),
    updated_at BIGINT NOT NULL,
    PRIMARY KEY (box_id, warehouse_id)
);
CREATE TABLE IF NOT EXISTS assistant_knowledge_access_audit (
    id TEXT PRIMARY KEY,
    box_id TEXT NOT NULL,
    warehouse_id TEXT NOT NULL,
    actor_id BIGINT NOT NULL REFERENCES users(id),
    before_json TEXT NOT NULL,
    after_json TEXT NOT NULL,
    created_at BIGINT NOT NULL
);

UPDATE _schema_version SET version = 33;
