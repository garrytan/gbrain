import type { Migration } from './types.ts';
import { WORKTREE_REFRESH_SCHEMA_SQL } from '../persistence/worktree-refresh-schema.ts';

// F0 `gbrain sources refresh`: the durable checkpoint of a worktree-wide
// coordinated fast-forward (draining -> fenced -> merged -> syncing ->
// completed), with a partial unique index for one active refresh per worktree.
// DDL in src/core/persistence/worktree-refresh-schema.ts.
export const v194: Migration = {
  version: 194,
  name: 'f0_worktree_refreshes',
  idempotent: true,
  sql: WORKTREE_REFRESH_SCHEMA_SQL,
};
