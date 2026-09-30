import type { Migration } from './types.ts';

export const v140: Migration = {
  version: 140,
  name: 'chat_usage_log',
  // #4218 (revives the #3392 shape): durable per-call chat usage ledger.
  // gateway.chat() inserts one row per SUCCESSFUL call (fire-and-forget via
  // the chat-usage sink; see src/core/ai/chat-usage.ts) with the answering
  // model, best-effort phase attribution, token counts incl. prompt-cache
  // reads/writes, and a canonical-table cost estimate (NULL when the model
  // has no pricing — never a fake 0). Read back by the `get_usage` op.
  // Created empty; plain CREATE INDEX is instant — no CONCURRENTLY. RLS:
  // covered by the v35 auto_rls_on_create_table event trigger on Postgres.
  // Keep in sync with src/schema.sql, src/core/pglite-schema.ts,
  // src/core/schema-embedded.generated.ts.
  idempotent: true,
  sql: `
      CREATE TABLE IF NOT EXISTS chat_usage_log (
        id                 BIGSERIAL PRIMARY KEY,
        created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
        model              TEXT NOT NULL,
        provider           TEXT,
        phase              TEXT,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cache_write_tokens INTEGER NOT NULL DEFAULT 0,
        cost_usd           DOUBLE PRECISION
      );
      CREATE INDEX IF NOT EXISTS idx_chat_usage_log_created
        ON chat_usage_log (created_at);
      CREATE INDEX IF NOT EXISTS idx_chat_usage_log_model
        ON chat_usage_log (model, created_at);
    `,
};
