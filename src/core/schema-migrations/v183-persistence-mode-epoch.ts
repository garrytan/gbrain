import type { Migration } from './types.ts';

export const v183: Migration = {
  // #5455/#5628: `gbrain sources writer deactivate`. mode_epoch counts managed
  // mode changes: activation and deactivation each increment it, it is part of
  // the writer admin-state hash, and managed-root markers and registry records
  // carry it so a later process removes only markers of a retired epoch. A
  // deactivated worktree becomes 'retired' (the row is kept so receipt and
  // effect foreign keys stay valid). persistence_brain and
  // persistence_worktrees are migration-created on PGLite and no index
  // references these columns (bootstrap-coverage: column-only exemptions).
  version: 183,
  name: 'persistence_mode_epoch',
  idempotent: true,
  sql: `
      ALTER TABLE persistence_brain ADD COLUMN IF NOT EXISTS mode_epoch bigint NOT NULL DEFAULT 1;
      ALTER TABLE persistence_worktrees DROP CONSTRAINT IF EXISTS persistence_worktrees_state_check;
      ALTER TABLE persistence_worktrees ADD CONSTRAINT persistence_worktrees_state_check
        CHECK (state IN ('active','draining','recovering','retired'));
    `,
};
