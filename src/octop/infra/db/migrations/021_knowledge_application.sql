-- Knowledge ownership is immutable through ordinary knowledge settings.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE knowledge_bases_application (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  knowledge_base_id TEXT NOT NULL UNIQUE,
  owner_user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  default_open INTEGER NOT NULL DEFAULT 0,
  shared INTEGER NOT NULL DEFAULT 0,
  icon_name TEXT NOT NULL DEFAULT '',
  embedding_model TEXT NOT NULL DEFAULT '',
  embedding_dim INTEGER NOT NULL DEFAULT 0,
  doc_count INTEGER NOT NULL DEFAULT 0,
  max_documents INTEGER NOT NULL DEFAULT 100,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  application_id TEXT NOT NULL DEFAULT 'wanx' CHECK (application_id IN ('wanx', 'zhijun')),
  UNIQUE(owner_user_id, application_id, name)
);
INSERT INTO knowledge_bases_application (
  id, knowledge_base_id, owner_user_id, name, description, default_open, shared,
  icon_name, embedding_model, embedding_dim, doc_count, max_documents,
  created_at, updated_at, application_id
)
SELECT id, knowledge_base_id, owner_user_id, name, description, default_open, shared,
  icon_name, embedding_model, embedding_dim, doc_count, max_documents,
  created_at, updated_at, 'wanx' FROM knowledge_bases;
DROP TABLE knowledge_bases;
ALTER TABLE knowledge_bases_application RENAME TO knowledge_bases;
CREATE INDEX idx_knowledge_bases_owner ON knowledge_bases(owner_user_id);
UPDATE _schema_version SET version = 21;
COMMIT;
PRAGMA foreign_keys = ON;
