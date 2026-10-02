import type { Migration } from './types.ts';

export const v016: Migration = {
  version: 16,
  name: 'cycle_locks_table',
  // v0.17 brain maintenance cycle (runCycle primitive).
  // PgBouncer transaction pooling strips session-scoped advisory locks
  // (pg_try_advisory_lock) across connection checkouts, so we can't use
  // them as the cycle-coordination primitive. A row with a TTL works
  // through every pooler: any backend can SELECT/UPDATE/DELETE it, no
  // session state required.
  //
  // Acquire: INSERT ... ON CONFLICT (id) DO UPDATE ... WHERE ttl_expires_at < NOW()
  //          returning ... — empty RETURNING = lock held by live holder.
  // Refresh: UPDATE ... SET ttl_expires_at = NOW() + interval '30 min'
  //          WHERE id = 'gbrain-cycle' AND holder_pid = <my pid> — between phases.
  // Release: DELETE WHERE id = 'gbrain-cycle' AND holder_pid = <my pid>.
  sql: `
      CREATE TABLE IF NOT EXISTS gbrain_cycle_locks (
        id TEXT PRIMARY KEY,
        holder_pid INT NOT NULL,
        holder_host TEXT,
        acquired_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        ttl_expires_at TIMESTAMPTZ NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cycle_locks_ttl ON gbrain_cycle_locks(ttl_expires_at);
    `,
};
