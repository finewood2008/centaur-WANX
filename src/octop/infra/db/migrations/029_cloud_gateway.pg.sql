-- Central dispatch authority. No payment or spendable-wallet mutations.
CREATE TABLE IF NOT EXISTS credit_gateway_tasks (
    task_id TEXT PRIMARY KEY REFERENCES credit_meter_tasks(id),
    grant_hash TEXT,
    expires_at BIGINT NOT NULL,
    day_start BIGINT,
    closing INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS credit_gateway_calls (
    call_id TEXT PRIMARY KEY REFERENCES credit_meter_calls(id),
    task_id TEXT NOT NULL REFERENCES credit_gateway_tasks(task_id),
    request_id TEXT NOT NULL,
    fingerprint TEXT NOT NULL,
    input_bound BIGINT NOT NULL,
    output_bound BIGINT NOT NULL,
    UNIQUE(task_id, request_id)
);
CREATE TABLE IF NOT EXISTS credit_gateway_quarantine (
    route TEXT PRIMARY KEY,
    reason TEXT NOT NULL,
    created_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_gateway_automatic (
    account_key TEXT NOT NULL,
    application_id TEXT NOT NULL,
    per_task BIGINT NOT NULL,
    per_day BIGINT NOT NULL,
    enabled INTEGER NOT NULL,
    PRIMARY KEY(account_key, application_id)
);
UPDATE _schema_version SET version = 29;
