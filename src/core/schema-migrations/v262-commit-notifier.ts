import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); the fresh-install
// copy in src/schema.sql carries the same tables.
//
// GBRA-133 PR 2a (commit triggers that never drop a commit; core in
// src/core/commit-notifier.ts and src/core/notifier/store.ts):
// - sync_wanted_markers: one row per source and intent class (freshness, pull,
//   full). A submitter (gbrain sync trigger, the GitHub webhook, a busy
//   delegated sync, a resident forwarding a HEAD move) upserts it and bumps
//   generation; a drainer deletes it only WHERE generation equals the value it
//   read, so a newer request survives the run that was already going.
// - sync_notifier_leases: the one notifier owner per host (conditional renew,
//   a fencing token bumped on every takeover, expiry after one missed lease).
// - sync_notifier_sources: per-source notifier state (due, running, retry with
//   next_retry_at, operator_blocked), first_due_at kept until verified
//   convergence, the last error and its trace file, the classic syncer host,
//   and the coverage record the freshness notice reads (observed HEAD, time,
//   detection mode, owner liveness). Written on change, never on every poll.
// DDL only, nothing to backfill: an absent row reads as "not monitored".
export const v262: Migration = {
  version: 262,
  name: 'commit_notifier',
  idempotent: true,
  sql: `
    CREATE TABLE IF NOT EXISTS sync_wanted_markers (
      source_id TEXT NOT NULL REFERENCES sources(id) ON DELETE CASCADE,
      intent TEXT NOT NULL CHECK (intent IN ('freshness','pull','full')),
      source_incarnation TEXT,
      wanted_head TEXT,
      generation BIGINT NOT NULL DEFAULT 1,
      first_due_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      requested_by TEXT NOT NULL,
      job_id BIGINT,
      PRIMARY KEY (source_id, intent)
    );
    CREATE TABLE IF NOT EXISTS sync_notifier_leases (
      host_id TEXT PRIMARY KEY,
      owner_id TEXT NOT NULL,
      fence BIGINT NOT NULL DEFAULT 1,
      resident_kind TEXT NOT NULL,
      pid INTEGER,
      renewed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
      expires_at TIMESTAMPTZ NOT NULL
    );
    CREATE TABLE IF NOT EXISTS sync_notifier_sources (
      source_id TEXT PRIMARY KEY REFERENCES sources(id) ON DELETE CASCADE,
      source_incarnation TEXT,
      syncer_host_id TEXT,
      syncer_recorded_at TIMESTAMPTZ,
      state TEXT NOT NULL DEFAULT 'idle' CHECK (state IN ('idle','due','running','retry','operator_blocked')),
      reason TEXT,
      first_due_at TIMESTAMPTZ,
      attempts INTEGER NOT NULL DEFAULT 0,
      next_retry_at TIMESTAMPTZ,
      last_progress_at TIMESTAMPTZ,
      last_error_code TEXT,
      last_error TEXT,
      last_error_at TIMESTAMPTZ,
      trace_path TEXT,
      observed_head TEXT,
      observed_at TIMESTAMPTZ,
      detection_mode TEXT CHECK (detection_mode IN ('watch','poll')),
      owner_host_id TEXT,
      owner_kind TEXT,
      owner_pid INTEGER,
      owner_seen_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
    );
  `,
};
