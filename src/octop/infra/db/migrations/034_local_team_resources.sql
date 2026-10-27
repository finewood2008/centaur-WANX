-- Native objects explicitly published into one local box/epoch; ACL remains in authority.
CREATE TABLE IF NOT EXISTS local_team_resources (
    box_id TEXT NOT NULL,
    ownership_epoch BIGINT NOT NULL,
    resource_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    object_id TEXT NOT NULL,
    owner_user_id INTEGER NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL,
    PRIMARY KEY(box_id, ownership_epoch, resource_id),
    UNIQUE(kind, object_id)
);
CREATE TABLE IF NOT EXISTS team_applications (
    application_id TEXT PRIMARY KEY REFERENCES applications(application_id),
    box_id TEXT NOT NULL,
    ownership_epoch BIGINT NOT NULL,
    created_by INTEGER NOT NULL REFERENCES users(id),
    created_at BIGINT NOT NULL
);

-- The former team branch used version 32 before the assistant conversation migration.
CREATE TABLE IF NOT EXISTS assistant_conversations (
    id TEXT PRIMARY KEY,
    user_id BIGINT NOT NULL REFERENCES users(id),
    agent_id TEXT NOT NULL,
    active_thread_id TEXT NOT NULL,
    context_json TEXT NOT NULL DEFAULT '{}',
    revision BIGINT NOT NULL DEFAULT 0,
    updated_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_conversations_owner ON assistant_conversations(user_id, agent_id);
CREATE TABLE IF NOT EXISTS assistant_conversation_versions (
    thread_id TEXT PRIMARY KEY,
    conversation_id TEXT NOT NULL REFERENCES assistant_conversations(id),
    parent_thread_id TEXT,
    target_message_id TEXT,
    kind TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE INDEX IF NOT EXISTS assistant_versions_conversation ON assistant_conversation_versions(conversation_id);

UPDATE _schema_version SET version = 34;
