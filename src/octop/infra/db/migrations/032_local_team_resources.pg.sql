-- Native objects explicitly published into one local box/epoch; ACL remains in authority.
CREATE TABLE IF NOT EXISTS local_team_resources (
    box_id TEXT NOT NULL,
    ownership_epoch BIGINT NOT NULL,
    resource_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    owner_user_id BIGINT NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    PRIMARY KEY(box_id, ownership_epoch, resource_id),
    UNIQUE(kind, object_id)
);
CREATE TABLE IF NOT EXISTS team_applications (
    application_id TEXT PRIMARY KEY REFERENCES applications(application_id),
    box_id TEXT NOT NULL,
    ownership_epoch BIGINT NOT NULL,
    created_by BIGINT NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL
);
UPDATE _schema_version SET version = 32;
