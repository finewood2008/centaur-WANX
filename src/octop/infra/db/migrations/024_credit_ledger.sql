-- Central ledger only: identities are WANX issuer/subject pairs, never local user IDs.
CREATE TABLE IF NOT EXISTS credit_accounts (
    account_key TEXT PRIMARY KEY,
    issuer TEXT NOT NULL,
    subject TEXT NOT NULL,
    revision BIGINT NOT NULL DEFAULT 0,
    UNIQUE (issuer, subject)
);
CREATE TABLE IF NOT EXISTS credit_lots (
    lot_id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL REFERENCES credit_accounts(account_key),
    kind TEXT NOT NULL CHECK (kind IN ('paid', 'gift')),
    amount BIGINT NOT NULL CHECK (amount > 0),
    available BIGINT NOT NULL CHECK (available >= 0),
    held BIGINT NOT NULL DEFAULT 0 CHECK (held >= 0),
    expires_at BIGINT,
    source_ref TEXT NOT NULL UNIQUE,
    CHECK (available + held <= amount),
    CHECK (kind = 'gift' OR expires_at IS NULL)
);
CREATE INDEX IF NOT EXISTS credit_lots_account ON credit_lots(account_key);
CREATE TABLE IF NOT EXISTS credit_reservations (
    reservation_id TEXT PRIMARY KEY,
    account_key TEXT NOT NULL REFERENCES credit_accounts(account_key),
    application_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    description TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('reserved', 'active', 'settled', 'released', 'expired')),
    budget BIGINT NOT NULL CHECK (budget > 0),
    charged BIGINT NOT NULL DEFAULT 0 CHECK (charged >= 0 AND charged <= budget),
    refunded BIGINT NOT NULL DEFAULT 0 CHECK (refunded >= 0 AND refunded <= charged),
    expires_at BIGINT NOT NULL,
    UNIQUE (account_key, application_id, task_id)
);
CREATE INDEX IF NOT EXISTS credit_reservations_account ON credit_reservations(account_key);
CREATE TABLE IF NOT EXISTS credit_allocations (
    reservation_id TEXT NOT NULL REFERENCES credit_reservations(reservation_id),
    lot_id TEXT NOT NULL REFERENCES credit_lots(lot_id),
    ordinal INTEGER NOT NULL,
    amount BIGINT NOT NULL CHECK (amount > 0),
    charged BIGINT NOT NULL DEFAULT 0 CHECK (charged >= 0 AND charged <= amount),
    refunded BIGINT NOT NULL DEFAULT 0 CHECK (refunded >= 0 AND refunded <= charged),
    PRIMARY KEY (reservation_id, lot_id)
);
CREATE TABLE IF NOT EXISTS credit_events (
    account_key TEXT NOT NULL REFERENCES credit_accounts(account_key),
    sequence BIGINT NOT NULL,
    event_id TEXT NOT NULL UNIQUE,
    kind TEXT NOT NULL,
    application_id TEXT,
    reservation_id TEXT,
    available_delta BIGINT NOT NULL,
    held_delta BIGINT NOT NULL,
    expired_amount BIGINT NOT NULL DEFAULT 0,
    actor TEXT NOT NULL,
    reference TEXT NOT NULL,
    created_at BIGINT NOT NULL,
    PRIMARY KEY (account_key, sequence)
);
CREATE TABLE IF NOT EXISTS credit_operations (
    operation_key TEXT PRIMARY KEY,
    fingerprint TEXT NOT NULL,
    response_json TEXT NOT NULL
);
UPDATE _schema_version SET version = 24;
