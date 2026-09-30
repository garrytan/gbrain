import type { Migration } from './types.ts';

export const v036: Migration = {
  version: 36,
  name: 'subagent_provider_neutral_persistence_v0_27',
  // v0.27 multi-provider subagent. Codex F-OV-1 / D11: the subagent_messages
  // and subagent_tool_executions tables stored Anthropic-shaped tool_use /
  // tool_result blocks as JSONB. When a worker resumes a job mid-loop and
  // the live model is OpenAI/DeepSeek/etc, the persisted shape becomes the
  // runtime contract — translation at read time is lossy.
  //
  // Fix: add schema_version + provider_id columns. schema_version=1 is the
  // legacy Anthropic-shape (existing rows). schema_version=2 is the
  // provider-neutral ChatBlock format documented in src/core/ai/gateway.ts
  // (text / tool-call / tool-result blocks with normalized field names).
  // Subagent.ts (commit 2) writes schema_version=2 going forward and reads
  // both shapes via a versioned mapper.
  //
  // Renumbered v34→v35→v36 across master merges: master's v34
  // (destructive_guard_columns, v0.26.5 soft-delete) and v35
  // (auto_rls_event_trigger, v0.26.8) landed first.
  //
  // No data migration. Existing in-flight jobs continue to replay against
  // their original shape; new jobs use v2. ADD COLUMN IF NOT EXISTS makes
  // the migration idempotent.
  sql: `
      ALTER TABLE subagent_messages
        ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS provider_id TEXT;

      ALTER TABLE subagent_tool_executions
        ADD COLUMN IF NOT EXISTS schema_version INTEGER NOT NULL DEFAULT 1,
        ADD COLUMN IF NOT EXISTS provider_id TEXT;

      -- Lookup by provider for cost rollups + per-provider replay diagnostics.
      CREATE INDEX IF NOT EXISTS idx_subagent_messages_provider
        ON subagent_messages (job_id, provider_id);
    `,
};
