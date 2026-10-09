-- Application ownership is immutable through ordinary Agent configuration.
ALTER TABLE agents ADD COLUMN application_id TEXT NOT NULL DEFAULT 'wanx'
    CHECK (application_id IN ('wanx', 'zhijun'));
CREATE UNIQUE INDEX IF NOT EXISTS agents_zhijun_owner
    ON agents(user_id) WHERE application_id = 'zhijun';
DROP INDEX IF EXISTS idx_agents_user_name;
CREATE UNIQUE INDEX idx_agents_user_name ON agents(user_id, application_id, name)
    WHERE user_id IS NOT NULL;
UPDATE _schema_version SET version = 20;
