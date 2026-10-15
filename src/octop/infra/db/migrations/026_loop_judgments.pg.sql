CREATE TABLE IF NOT EXISTS loop_controls (
 loop_id TEXT PRIMARY KEY REFERENCES loops(loop_id) ON DELETE CASCADE,
 checkpoint_index INTEGER NOT NULL DEFAULT 0,
 review_rounds INTEGER NOT NULL DEFAULT 0,
 review_seconds DOUBLE PRECISION NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS loop_judgments (
 id BIGSERIAL PRIMARY KEY,
 judgment_id TEXT NOT NULL UNIQUE,
 loop_id TEXT NOT NULL REFERENCES loops(loop_id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 round_id TEXT REFERENCES loop_rounds(round_id),
 kind TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'pending',
 payload_json TEXT NOT NULL,
 decision_json TEXT,
 created_at INTEGER NOT NULL,
 resolved_at INTEGER,
 FOREIGN KEY(loop_id,version) REFERENCES loop_versions(loop_id,version)
);
CREATE UNIQUE INDEX IF NOT EXISTS loop_one_pending_judgment ON loop_judgments(loop_id) WHERE status='pending';
CREATE TABLE IF NOT EXISTS loop_channel_bindings (
 id BIGSERIAL PRIMARY KEY,
 binding_id TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
 channel_id TEXT REFERENCES channels(channel_id) ON DELETE SET NULL,
 fingerprint TEXT NOT NULL,
 challenge_hash TEXT NOT NULL UNIQUE,
 status TEXT NOT NULL DEFAULT 'awaiting_message',
 expires_at INTEGER NOT NULL,
 subject_id TEXT,
 display_name TEXT,
 routing_json TEXT,
 created_at INTEGER NOT NULL,
 confirmed_at INTEGER
);
CREATE INDEX IF NOT EXISTS loop_binding_owner ON loop_channel_bindings(user_id,agent_id);
CREATE TABLE IF NOT EXISTS loop_notifications (
 notification_id TEXT PRIMARY KEY,
 loop_id TEXT NOT NULL REFERENCES loops(loop_id) ON DELETE CASCADE,
 binding_id TEXT NOT NULL REFERENCES loop_channel_bindings(binding_id) ON DELETE CASCADE,
 event_key TEXT NOT NULL UNIQUE,
 message TEXT NOT NULL,
 reference_json TEXT NOT NULL DEFAULT '{}',
 status TEXT NOT NULL DEFAULT 'queued',
 attempts INTEGER NOT NULL DEFAULT 0,
 next_at INTEGER NOT NULL,
 error TEXT,
 created_at INTEGER NOT NULL,
 sent_at INTEGER
);
UPDATE _schema_version SET version = 26;
