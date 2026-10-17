CREATE TABLE IF NOT EXISTS credit_gateway_schedulers (
    id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL,
    device_id TEXT NOT NULL,
    token_hash TEXT NOT NULL UNIQUE,
    expires_at BIGINT NOT NULL,
    revoked INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS credit_box_scheduler (
    user_id BIGINT PRIMARY KEY,
    gateway_url TEXT NOT NULL,
    token TEXT NOT NULL,
    device_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_gateway_run_scheduler (
    task_id TEXT PRIMARY KEY REFERENCES credit_gateway_tasks(task_id),
    scheduler_id TEXT NOT NULL REFERENCES credit_gateway_schedulers(id)
);
UPDATE _schema_version SET version = 30;
