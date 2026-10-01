import type { Migration } from './types.ts';
import { DECIDE_PROPOSALS_SCHEMA_SQL } from '../ai/decide/schema.ts';

// System One decide: S9 contradiction proposals (with before/after state for
// undo) and the sweep's deferred-retry table; DDL in src/core/ai/decide/schema.ts.
export const v186: Migration = {
  version: 186,
  name: 'decide_proposals',
  idempotent: true,
  sql: DECIDE_PROPOSALS_SCHEMA_SQL,
};
