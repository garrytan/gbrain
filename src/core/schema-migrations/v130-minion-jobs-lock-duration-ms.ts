import type { Migration } from './types.ts';

export const v130: Migration = {
  version: 130,
  name: 'minion_jobs_lock_duration_ms',
  // #4145: per-job lock lease. A single worker-global 30s lockDuration
  // cannot serve both 2s shell jobs and 173s-average LLM subagent jobs —
  // under host CPU saturation the renewal window was missed and healthy
  // long-running handlers were force-evicted. The column carries an
  // optional per-job lease; NULL means "worker default" (the pre-#4145
  // behavior), so NO backfill is needed — the claim-time COALESCE against
  // HANDLER_DEFAULT_LOCK_DURATION_MS (handler-timeouts.ts) owns all
  // defaulting from here on. CHECK added via the idempotent drop-then-add
  // pattern (v7 precedent) so migrated brains carry the same DB bound as
  // fresh installs; the operative [5s,1h] range clamp lives app-side in
  // clampLockDurationMs. No index: only per-row reads on already-indexed
  // access paths (bootstrap-coverage: column-only, no probe needed).
  // (Authored as v129; renumbered to v130 when #4152's
  // dream_verdicts_triage_v1_columns landed the number first.)
  idempotent: true,
  sql: `
      ALTER TABLE minion_jobs ADD COLUMN IF NOT EXISTS lock_duration_ms INTEGER;
      ALTER TABLE minion_jobs DROP CONSTRAINT IF EXISTS chk_lock_duration_positive;
      ALTER TABLE minion_jobs ADD CONSTRAINT chk_lock_duration_positive CHECK (lock_duration_ms IS NULL OR (lock_duration_ms >= 5000 AND lock_duration_ms <= 3600000));
    `,
};
