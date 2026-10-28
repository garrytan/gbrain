import type { Migration } from './types.ts';
import { DECIDE_CLAIM_PROPOSALS_INDEX_SQL } from '../ai/decide/schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GBRA-216: the keyless claim-conflict lane (facts/claim-conflicts.ts) files one
// decide_proposals row per unordered fact pair. A partial unique index over its
// own sweep ids makes concurrent runs (the dream phase and decide sweep --claims)
// idempotent without touching any existing row, and two partial indexes on the
// pending proposal's fact ids serve recall's per-call contested lookup. DDL only.
export const v279: Migration = {
  version: 279,
  name: 'decide_proposals_claim_pair_index',
  idempotent: true,
  sql: DECIDE_CLAIM_PROPOSALS_INDEX_SQL,
};
