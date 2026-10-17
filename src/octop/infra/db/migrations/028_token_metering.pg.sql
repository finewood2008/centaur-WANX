-- Shadow metering is separate from monetary credit balances.
CREATE TABLE IF NOT EXISTS credit_meter_tasks (
    id TEXT PRIMARY KEY,
    account_key TEXT,
    local_user_id INTEGER NOT NULL DEFAULT 0,
    application_id TEXT NOT NULL,
    task_key TEXT NOT NULL,
    tier TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'quoted',
    outcome TEXT,
    budget BIGINT NOT NULL CHECK (budget >= 0),
    price_version TEXT NOT NULL,
    quote_expires_at BIGINT NOT NULL,
    created_at BIGINT NOT NULL,
    ended_at BIGINT,
    authorized_at BIGINT,
    simulated_points BIGINT NOT NULL DEFAULT 0,
    reserved_cost BIGINT NOT NULL DEFAULT 0,
    total_cost BIGINT NOT NULL DEFAULT 0,
    billable_cost BIGINT NOT NULL DEFAULT 0,
    pending_calls INTEGER NOT NULL DEFAULT 0,
    would_exceed INTEGER NOT NULL DEFAULT 0,
    reservation_id TEXT,
    mode TEXT NOT NULL DEFAULT 'shadow' CHECK (mode = 'shadow'),
    UNIQUE(account_key, application_id, task_key)
);
CREATE INDEX IF NOT EXISTS credit_meter_owner ON credit_meter_tasks(account_key, created_at, id);
CREATE TABLE IF NOT EXISTS credit_meter_calls (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES credit_meter_tasks(id),
    model TEXT NOT NULL,
    provider TEXT NOT NULL,
    price_json TEXT,
    usage_json TEXT,
    status TEXT NOT NULL DEFAULT 'pending',
    reserved_cost BIGINT NOT NULL DEFAULT 0,
    cost BIGINT,
    billable INTEGER NOT NULL DEFAULT 1,
    created_at BIGINT NOT NULL,
    ended_at BIGINT
);
CREATE INDEX IF NOT EXISTS credit_meter_call_task ON credit_meter_calls(task_id, created_at);
CREATE TABLE IF NOT EXISTS credit_meter_sessions (
    token_hash TEXT PRIMARY KEY,
    account_key TEXT NOT NULL,
    application_id TEXT NOT NULL,
    expires_at BIGINT NOT NULL
);
CREATE TABLE IF NOT EXISTS credit_meter_authorizations (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES credit_meter_tasks(id),
    request_id TEXT NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    created_at BIGINT NOT NULL,
    UNIQUE(task_id, request_id)
);
CREATE TABLE IF NOT EXISTS credit_lot_finance (
    lot_id TEXT PRIMARY KEY REFERENCES credit_lots(lot_id),
    order_ref TEXT NOT NULL,
    funding TEXT NOT NULL CHECK (funding IN ('paid', 'trial', 'box', 'campaign')),
    net_revenue_nano BIGINT NOT NULL CHECK (net_revenue_nano >= 0),
    order_points BIGINT NOT NULL CHECK (order_points > 0)
);
CREATE TABLE IF NOT EXISTS credit_meter_automatic (
    account_key TEXT NOT NULL,
    application_id TEXT NOT NULL,
    per_task BIGINT NOT NULL CHECK (per_task > 0),
    per_day BIGINT NOT NULL CHECK (per_day > 0),
    enabled INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY(account_key, application_id)
);
UPDATE _schema_version SET version = 28;
