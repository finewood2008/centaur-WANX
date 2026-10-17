CREATE TABLE IF NOT EXISTS loops (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 loop_id TEXT NOT NULL UNIQUE,
 user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
 agent_id TEXT NOT NULL REFERENCES agents(agent_id) ON DELETE CASCADE,
 source_cron_id TEXT UNIQUE REFERENCES cron_jobs(cron_id) ON DELETE RESTRICT,
 version INTEGER NOT NULL DEFAULT 1,
 definition_json TEXT NOT NULL,
 status TEXT NOT NULL DEFAULT 'draft',
 enabled INTEGER NOT NULL DEFAULT 0,
 reason TEXT,
 progress_json TEXT NOT NULL DEFAULT '{}',
 round_count INTEGER NOT NULL DEFAULT 0,
 failures INTEGER NOT NULL DEFAULT 0,
 next_run_at INTEGER,
 thread_id TEXT,
 created_at INTEGER NOT NULL,
 updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS loops_owner ON loops(user_id, status);
CREATE TABLE IF NOT EXISTS loop_versions (
 loop_id TEXT NOT NULL REFERENCES loops(loop_id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 definition_json TEXT NOT NULL,
 created_at INTEGER NOT NULL,
 PRIMARY KEY(loop_id, version)
);
CREATE TABLE IF NOT EXISTS loop_rounds (
 id INTEGER PRIMARY KEY AUTOINCREMENT,
 round_id TEXT NOT NULL UNIQUE,
 loop_id TEXT NOT NULL REFERENCES loops(loop_id) ON DELETE CASCADE,
 version INTEGER NOT NULL,
 number INTEGER NOT NULL,
 status TEXT NOT NULL,
 trial INTEGER NOT NULL DEFAULT 0,
 result_json TEXT NOT NULL DEFAULT '{}',
 pending_json TEXT,
 started_at INTEGER NOT NULL,
 finished_at INTEGER,
 FOREIGN KEY(loop_id, version) REFERENCES loop_versions(loop_id, version)
);
CREATE INDEX IF NOT EXISTS loop_rounds_history ON loop_rounds(loop_id, id);
CREATE UNIQUE INDEX IF NOT EXISTS loop_one_running_round ON loop_rounds(loop_id)
 WHERE status IN ('running', 'awaiting_approval');
UPDATE _schema_version SET version = 25;
