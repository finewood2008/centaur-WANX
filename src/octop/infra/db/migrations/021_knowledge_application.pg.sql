-- Knowledge ownership is immutable through ordinary knowledge settings.
ALTER TABLE knowledge_bases ADD COLUMN IF NOT EXISTS application_id TEXT NOT NULL DEFAULT 'wanx'
    CHECK (application_id IN ('wanx', 'zhijun'));
ALTER TABLE knowledge_bases DROP CONSTRAINT IF EXISTS knowledge_bases_owner_user_id_name_key;
-- v7 created the replacement while the legacy index still existed.
ALTER TABLE knowledge_bases DROP CONSTRAINT IF EXISTS knowledge_bases_owner_user_id_name_key1;
CREATE UNIQUE INDEX IF NOT EXISTS idx_knowledge_bases_owner_application_name
    ON knowledge_bases(owner_user_id, application_id, name);
UPDATE _schema_version SET version = 21;
