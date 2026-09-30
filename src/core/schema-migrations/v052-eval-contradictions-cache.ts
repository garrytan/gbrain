import type { Migration } from './types.ts';

export const v052: Migration = {
  version: 52,
  name: 'eval_contradictions_cache',
  // v0.32.6 — P2 persistent judge cache for the contradiction probe.
  //
  // Composite primary key includes prompt_version + truncation_policy
  // (Codex outside-voice fix). Without these, a prompt edit would silently
  // serve stale verdicts to consumers. The cache key is the FULL
  // configuration that produced the verdict; bumping any component
  // invalidates prior entries cleanly.
  //
  // TTL via expires_at — readers can WHERE expires_at > now() to ignore
  // stale rows; an explicit DELETE WHERE expires_at <= now() sweep runs
  // periodically (lives in cache.ts orchestration, not here).
  //
  // verdict JSONB carries the full JudgeVerdict shape (contradicts,
  // severity, axis, confidence, resolution_kind) so a cache hit is a
  // complete answer without needing a second column.
  //
  // Idempotent across PGLite and Postgres; engine-agnostic DDL.
  sql: `
      CREATE TABLE IF NOT EXISTS eval_contradictions_cache (
        chunk_a_hash       TEXT         NOT NULL,
        chunk_b_hash       TEXT         NOT NULL,
        model_id           TEXT         NOT NULL,
        prompt_version     TEXT         NOT NULL,
        truncation_policy  TEXT         NOT NULL,
        verdict            JSONB        NOT NULL,
        created_at         TIMESTAMPTZ  NOT NULL DEFAULT now(),
        expires_at         TIMESTAMPTZ  NOT NULL,
        PRIMARY KEY (chunk_a_hash, chunk_b_hash, model_id, prompt_version, truncation_policy)
      );
      CREATE INDEX IF NOT EXISTS eval_contradictions_cache_expires_idx
        ON eval_contradictions_cache (expires_at);
    `,
};
