import type { Migration } from './types.ts';

export const v038: Migration = {
  version: 38,
  name: 'access_tokens_permissions',
  // v0.28: per-token allow-list for takes visibility (Codex P0 #3 partial fix).
  // The complementary fix (chunker strips fenced takes content from page chunks
  // so query results don't bypass the allow-list) lives in src/core/chunkers/takes-strip.ts.
  // Default permissions = {takes_holders: ['world']} keeps non-world takes (hunches,
  // private opinions) hidden from MCP-bound tokens until the operator explicitly
  // grants access via `gbrain auth permissions <id> set-takes-holders`.
  sql: `
      ALTER TABLE access_tokens
        ADD COLUMN IF NOT EXISTS permissions JSONB
          NOT NULL DEFAULT '{"takes_holders":["world"]}'::jsonb;

      -- Backfill existing tokens to the default. NOT NULL DEFAULT covers new rows;
      -- this UPDATE handles any pre-existing rows from before the column was added.
      UPDATE access_tokens
        SET permissions = '{"takes_holders":["world"]}'::jsonb
        WHERE permissions IS NULL OR permissions = '{}'::jsonb;
    `,
};
