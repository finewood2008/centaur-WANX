-- v22 installations already exist locally; separate the entry point from members.
ALTER TABLE agents ADD COLUMN is_application_profile INTEGER NOT NULL DEFAULT 0;
UPDATE agents SET is_application_profile = 1
 WHERE application_id != 'wanx' AND id IN
 (SELECT MIN(id) FROM agents WHERE application_id != 'wanx' GROUP BY user_id, application_id);
DROP INDEX IF EXISTS agents_product_owner;
CREATE UNIQUE INDEX agents_product_owner ON agents(user_id, application_id)
 WHERE application_id != 'wanx' AND is_application_profile = 1;
UPDATE _schema_version SET version = 23;
