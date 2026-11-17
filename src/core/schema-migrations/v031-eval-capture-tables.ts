import type { Migration } from './types.ts';

export const v031: Migration = {
  version: 31,
  name: 'eval_capture_tables',
  // v0.25.0 — BrainBench-Real session capture substrate.
  // Two tables:
  //   eval_candidates: per-call capture from the op-layer wrapper around
  //     `query` and `search`. Captures MCP + CLI + subagent tool-bridge
  //     traffic via src/core/operations.ts. query column is CHECK-capped
  //     at 50KB; PII is scrubbed before insert by src/core/eval-capture-scrub.ts.
  //     remote distinguishes MCP callers (untrusted) from local CLI; job_id +
  //     subagent_id let gbrain-evals partition replay by run.
  //   eval_capture_failures: insert-side audit trail. When logEvalCandidate
  //     fails (DB down, RLS reject, CHECK violation, scrubber exception),
  //     the capture path records the reason here so `gbrain doctor` can
  //     surface silent drops cross-process. In-process counters don't work
  //     because doctor runs in a separate process from the MCP server.
  //
  // RLS enable matches the v24 / v29 posture: fail loudly via RAISE EXCEPTION
  // if current_user lacks BYPASSRLS, so the migration retries cleanly after
  // operator fixes the role instead of silently bumping schema_version.
  // PGLite ignores RLS; sqlFor carries the table+index DDL only.
  //
  // Renumbered v30→v31 on merge with master's v0.23.0 (dream_verdicts) which
  // claimed v30 first. Pre-existing brains that applied our v30 will see
  // version 31 as new on next initSchema and run the IF NOT EXISTS DDL —
  // the CREATE TABLE statements are idempotent so the rename is safe.
  sqlFor: {
    postgres: `
        DO $$
        DECLARE
          has_bypass BOOLEAN;
        BEGIN
          SELECT EXISTS (SELECT 1 FROM pg_roles pr WHERE pg_has_role(current_user, pr.oid, 'USAGE') AND (pr.rolbypassrls OR pr.rolsuper)) INTO has_bypass; -- #1385: superuser + inherited-role BYPASSRLS, not just the role's own rolbypassrls
          IF NOT has_bypass THEN
            RAISE EXCEPTION 'v31 eval_capture_tables: role % does not have BYPASSRLS privilege — cannot enable RLS safely. Grant it (as postgres or a managed-Postgres master user): ALTER ROLE % BYPASSRLS; then re-run. The migration will retry automatically on the next initSchema call.', current_user, current_user;
          END IF;

          CREATE TABLE IF NOT EXISTS eval_candidates (
            id SERIAL PRIMARY KEY,
            tool_name TEXT NOT NULL CHECK (tool_name IN ('query', 'search')),
            query TEXT NOT NULL CHECK (length(query) <= 51200),
            retrieved_slugs TEXT[] NOT NULL DEFAULT '{}',
            retrieved_chunk_ids INTEGER[] NOT NULL DEFAULT '{}',
            source_ids TEXT[] NOT NULL DEFAULT '{}',
            expand_enabled BOOLEAN,
            detail TEXT CHECK (detail IS NULL OR detail IN ('low', 'medium', 'high')),
            detail_resolved TEXT CHECK (detail_resolved IS NULL OR detail_resolved IN ('low', 'medium', 'high')),
            vector_enabled BOOLEAN NOT NULL,
            expansion_applied BOOLEAN NOT NULL,
            latency_ms INTEGER NOT NULL,
            remote BOOLEAN NOT NULL,
            job_id INTEGER,
            subagent_id INTEGER,
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          );
          CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates (created_at DESC);
          ALTER TABLE eval_candidates ENABLE ROW LEVEL SECURITY;

          CREATE TABLE IF NOT EXISTS eval_capture_failures (
            id SERIAL PRIMARY KEY,
            ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            reason TEXT NOT NULL CHECK (reason IN ('db_down', 'rls_reject', 'check_violation', 'scrubber_exception', 'other'))
          );
          CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures (ts DESC);
          ALTER TABLE eval_capture_failures ENABLE ROW LEVEL SECURITY;

          RAISE NOTICE 'v31: eval_capture tables ready (role % has BYPASSRLS)', current_user;
        END $$;
      `,
    pglite: `
        CREATE TABLE IF NOT EXISTS eval_candidates (
          id SERIAL PRIMARY KEY,
          tool_name TEXT NOT NULL CHECK (tool_name IN ('query', 'search')),
          query TEXT NOT NULL CHECK (length(query) <= 51200),
          retrieved_slugs TEXT[] NOT NULL DEFAULT '{}',
          retrieved_chunk_ids INTEGER[] NOT NULL DEFAULT '{}',
          source_ids TEXT[] NOT NULL DEFAULT '{}',
          expand_enabled BOOLEAN,
          detail TEXT CHECK (detail IS NULL OR detail IN ('low', 'medium', 'high')),
          detail_resolved TEXT CHECK (detail_resolved IS NULL OR detail_resolved IN ('low', 'medium', 'high')),
          vector_enabled BOOLEAN NOT NULL,
          expansion_applied BOOLEAN NOT NULL,
          latency_ms INTEGER NOT NULL,
          remote BOOLEAN NOT NULL,
          job_id INTEGER,
          subagent_id INTEGER,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        );
        CREATE INDEX IF NOT EXISTS idx_eval_candidates_created_at ON eval_candidates (created_at DESC);

        CREATE TABLE IF NOT EXISTS eval_capture_failures (
          id SERIAL PRIMARY KEY,
          ts TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reason TEXT NOT NULL CHECK (reason IN ('db_down', 'rls_reject', 'check_violation', 'scrubber_exception', 'other'))
        );
        CREATE INDEX IF NOT EXISTS idx_eval_capture_failures_ts ON eval_capture_failures (ts DESC);
      `,
  },
  sql: '',
};
