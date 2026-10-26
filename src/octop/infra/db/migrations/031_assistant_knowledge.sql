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
UPDATE _schema_version SET version = 31;
