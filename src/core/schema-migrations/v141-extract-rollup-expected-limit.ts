import type { Migration } from './types.ts';

export const v141: Migration = {
  version: 141,
  name: 'extract_rollup_expected_limit',
  // #4482: orthogonal counter for EXPECTED-limit stops (per-source budget /
  // walltime caps working as designed). halt_count keeps its historical
  // meaning — rows written before this migration conflate error halts and
  // cap stops and are deliberately NOT reclassified (they read as 0 caps,
  // i.e. "unknown"). New writers record error halts in halt_count and cap
  // stops here, so doctor's extract_health failure rate can exclude
  // self-imposed capacity limits while keeping them observable.
  idempotent: true,
  sql: `
      ALTER TABLE extract_rollup_7d
        ADD COLUMN IF NOT EXISTS expected_limit_count INTEGER NOT NULL DEFAULT 0;
    `,
};
