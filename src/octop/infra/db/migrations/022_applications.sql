-- Product management and unrestricted registered application identifiers.
PRAGMA foreign_keys = OFF;
BEGIN IMMEDIATE;
CREATE TABLE agents_registered (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  agent_id        TEXT NOT NULL UNIQUE,
  user_id         INTEGER REFERENCES users(id) ON DELETE CASCADE,
  name            TEXT NOT NULL,
  description     TEXT,
  persona_mbti    TEXT,
  default_model   TEXT,
  system_prompt   TEXT,
  enabled         INTEGER NOT NULL DEFAULT 1,
  config_json     TEXT,
  last_state      TEXT,
  last_error      TEXT,
  icon            TEXT,
  template_name   TEXT,
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL
, is_shared INTEGER NOT NULL DEFAULT 0, color TEXT, icon_name TEXT, icon_url TEXT, skill_package_ids TEXT, published_expert_id TEXT, welcome_message TEXT, knowledge_base_ids TEXT, mcp_servers TEXT, kind TEXT NOT NULL DEFAULT 'expert', application_id TEXT NOT NULL DEFAULT 'wanx');
INSERT INTO agents_registered ("id", "agent_id", "user_id", "name", "description", "persona_mbti", "default_model", "system_prompt", "enabled", "config_json", "last_state", "last_error", "icon", "template_name", "created_at", "updated_at", "is_shared", "color", "icon_name", "icon_url", "skill_package_ids", "published_expert_id", "welcome_message", "knowledge_base_ids", "mcp_servers", "kind", "application_id") SELECT "id", "agent_id", "user_id", "name", "description", "persona_mbti", "default_model", "system_prompt", "enabled", "config_json", "last_state", "last_error", "icon", "template_name", "created_at", "updated_at", "is_shared", "color", "icon_name", "icon_url", "skill_package_ids", "published_expert_id", "welcome_message", "knowledge_base_ids", "mcp_servers", "kind", "application_id" FROM agents;
DROP TABLE agents;
ALTER TABLE agents_registered RENAME TO agents;
CREATE INDEX idx_agents_shared ON agents(is_shared) WHERE is_shared = 1;
CREATE UNIQUE INDEX agents_zhijun_owner ON agents(user_id) WHERE application_id = 'zhijun';
CREATE UNIQUE INDEX idx_agents_user_name ON agents(user_id, application_id, name) WHERE user_id IS NOT NULL;
CREATE TABLE knowledge_bases_registered (
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
  application_id TEXT NOT NULL DEFAULT 'wanx',
  UNIQUE(owner_user_id, application_id, name)
);
INSERT INTO knowledge_bases_registered ("id", "knowledge_base_id", "owner_user_id", "name", "description", "default_open", "shared", "icon_name", "embedding_model", "embedding_dim", "doc_count", "max_documents", "created_at", "updated_at", "application_id") SELECT "id", "knowledge_base_id", "owner_user_id", "name", "description", "default_open", "shared", "icon_name", "embedding_model", "embedding_dim", "doc_count", "max_documents", "created_at", "updated_at", "application_id" FROM knowledge_bases;
DROP TABLE knowledge_bases;
ALTER TABLE knowledge_bases_registered RENAME TO knowledge_bases;
CREATE INDEX idx_knowledge_bases_owner ON knowledge_bases(owner_user_id);


CREATE UNIQUE INDEX IF NOT EXISTS agents_product_owner ON agents(user_id, application_id) WHERE application_id != 'wanx';
CREATE TABLE IF NOT EXISTS applications (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 application_id TEXT NOT NULL UNIQUE,
 name TEXT NOT NULL,
 description TEXT NOT NULL DEFAULT '',
 capabilities_json TEXT NOT NULL DEFAULT '[]',
 agent_template_json TEXT NOT NULL DEFAULT '{}',
 resource_requirements_json TEXT NOT NULL DEFAULT '{}',
 created_by INTEGER NOT NULL REFERENCES users(id),
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS application_deployments (
 application_id TEXT PRIMARY KEY REFERENCES applications(application_id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 0,
 resource_bindings_json TEXT NOT NULL DEFAULT '{}',
 configuration_json TEXT NOT NULL DEFAULT '{}',
 updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS application_releases (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 application_id TEXT NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
 version TEXT NOT NULL,
 platform TEXT NOT NULL CHECK (platform IN ('macos', 'windows')),
 arch TEXT NOT NULL CHECK (arch IN ('arm64', 'x64')),
 url TEXT NOT NULL,
 sha256 TEXT NOT NULL,
 min_wanx_version TEXT NOT NULL,
 min_sdk_version TEXT NOT NULL,
 recommended INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,
 UNIQUE(application_id, version, platform, arch)
);
CREATE UNIQUE INDEX IF NOT EXISTS application_releases_recommended
 ON application_releases(application_id, platform, arch) WHERE recommended = 1;
CREATE TABLE IF NOT EXISTS application_access (
 application_id TEXT NOT NULL REFERENCES applications(application_id) ON DELETE CASCADE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 enabled INTEGER NOT NULL DEFAULT 1,
 updated_at INTEGER NOT NULL,
 PRIMARY KEY(application_id, user_id)
);

UPDATE _schema_version SET version = 22;
COMMIT;
PRAGMA foreign_keys = ON;
