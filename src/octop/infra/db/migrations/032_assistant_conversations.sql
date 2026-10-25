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
UPDATE _schema_version SET version = 32;
