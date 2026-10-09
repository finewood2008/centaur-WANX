-- Personal self-model: always scoped to both an agent and its human subject.
CREATE TABLE IF NOT EXISTS self_model_settings (
    agent_id TEXT NOT NULL, subject_user_id INTEGER NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1,
    PRIMARY KEY (agent_id, subject_user_id)
);
CREATE TABLE IF NOT EXISTS self_model_claims (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_user_id INTEGER NOT NULL,
    fingerprint TEXT NOT NULL, version INTEGER NOT NULL, document TEXT NOT NULL,
    UNIQUE (agent_id, subject_user_id, fingerprint)
);
CREATE INDEX IF NOT EXISTS self_model_claim_scope ON self_model_claims(agent_id, subject_user_id);
CREATE TABLE IF NOT EXISTS self_model_evidence (
    claim_id TEXT NOT NULL REFERENCES self_model_claims(id) ON DELETE CASCADE,
    event_id TEXT NOT NULL, document TEXT NOT NULL,
    PRIMARY KEY (claim_id, event_id)
);
CREATE TABLE IF NOT EXISTS self_model_events (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_user_id INTEGER NOT NULL,
    claim_id TEXT, action TEXT NOT NULL, document TEXT NOT NULL, created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS self_model_sources (
    agent_id TEXT NOT NULL, subject_user_id INTEGER NOT NULL,
    source_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    PRIMARY KEY (agent_id, subject_user_id, source_id)
);
CREATE TABLE IF NOT EXISTS self_model_jobs (
    id TEXT PRIMARY KEY, agent_id TEXT NOT NULL, subject_user_id INTEGER NOT NULL,
    document TEXT NOT NULL
);

UPDATE _schema_version SET version = 19;
