import { opError } from '../ops/contract.ts';
import { buildIndexOnline, migrationNotice, runMigrationStatement } from './helpers.ts';
import type { Migration } from './types.ts';

const TOKEN_INDEX = {
  name: 'idx_mcp_log_token_time',
  table: 'mcp_request_log',
  sql: 'CREATE INDEX IF NOT EXISTS idx_mcp_log_token_time ON mcp_request_log(token_name, created_at DESC)',
};

// The admin request list and usage counts filter on token_name. The resolved
// agent_name is a display label and can be shared by multiple credentials.
// Build the replacement before removing the old non-unique index. Keep the
// build out of schema.sql, which is also replayed on populated databases.
export const v338: Migration = {
  version: 338,
  name: 'mcp_request_log_token_index',
  idempotent: true,
  transaction: false,
  sql: '',
  handler: async engine => {
    const built = await buildIndexOnline(engine, 338, TOKEN_INDEX, { notice: migrationNotice });
    if (built === 'building') {
      throw opError('migrations_pending', `${TOKEN_INDEX.name} is being built by another session.`,
        'Wait for the index build to finish, then rerun the migration.');
    }
    await runMigrationStatement(engine, 338, 'DROP INDEX CONCURRENTLY IF EXISTS idx_mcp_log_agent_time');
  },
};
