import type { Migration } from './types.ts';

export const v005: Migration = {
  version: 5,
  name: 'minion_jobs_table',
  sql: `
      CREATE TABLE IF NOT EXISTS minion_jobs (
        id               SERIAL PRIMARY KEY,
        name             TEXT        NOT NULL,
        queue            TEXT        NOT NULL DEFAULT 'default',
        status           TEXT        NOT NULL DEFAULT 'waiting',
        priority         INTEGER     NOT NULL DEFAULT 0,
        data             JSONB       NOT NULL DEFAULT '{}',
        max_attempts     INTEGER     NOT NULL DEFAULT 3,
        attempts_made    INTEGER     NOT NULL DEFAULT 0,
        attempts_started INTEGER     NOT NULL DEFAULT 0,
        backoff_type     TEXT        NOT NULL DEFAULT 'exponential',
        backoff_delay    INTEGER     NOT NULL DEFAULT 1000,
        backoff_jitter   REAL        NOT NULL DEFAULT 0.2,
        stalled_counter  INTEGER     NOT NULL DEFAULT 0,
        max_stalled      INTEGER     NOT NULL DEFAULT 5,
        lock_token       TEXT,
        lock_until       TIMESTAMPTZ,
        delay_until      TIMESTAMPTZ,
        parent_job_id    INTEGER     REFERENCES minion_jobs(id) ON DELETE SET NULL,
        on_child_fail    TEXT        NOT NULL DEFAULT 'fail_parent',
        result           JSONB,
        progress         JSONB,
        error_text       TEXT,
        stacktrace       JSONB       DEFAULT '[]',
        created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        started_at       TIMESTAMPTZ,
        finished_at      TIMESTAMPTZ,
        updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
        CONSTRAINT chk_status CHECK (status IN ('waiting','active','completed','failed','delayed','dead','cancelled','waiting-children')),
        CONSTRAINT chk_backoff_type CHECK (backoff_type IN ('fixed','exponential')),
        CONSTRAINT chk_on_child_fail CHECK (on_child_fail IN ('fail_parent','remove_dep','ignore','continue')),
        CONSTRAINT chk_jitter_range CHECK (backoff_jitter >= 0.0 AND backoff_jitter <= 1.0),
        CONSTRAINT chk_attempts_order CHECK (attempts_made <= attempts_started),
        CONSTRAINT chk_nonnegative CHECK (attempts_made >= 0 AND attempts_started >= 0 AND stalled_counter >= 0 AND max_attempts >= 1 AND max_stalled >= 0)
      );
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_claim ON minion_jobs (queue, priority ASC, created_at ASC) WHERE status = 'waiting';
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_status ON minion_jobs(status);
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_stalled ON minion_jobs (lock_until) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_delayed ON minion_jobs (delay_until) WHERE status = 'delayed';
      CREATE INDEX IF NOT EXISTS idx_minion_jobs_parent ON minion_jobs(parent_job_id);
    `,
};
