import type { Migration } from './types.ts';
import { TRUST_GENERATION_SCHEMA_SQL } from '../eligibility/generation-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Trust policy generation counter (#5575 ENG-11): the one-row
// trust_policy_state table and the deferred, WHEN-guarded row triggers that
// bump it on a trust tier change, a quarantine transition, a read floor or
// `trust.%` config change, a purge ledger insert and a needs_rederive insert
// (eligibility/generation-schema.ts). Hot memory and the OpenClaw core lane
// key their caches on it. No schema.sql mirror: the triggers read columns
// that exist only through the trust tiers migration, so a fresh install
// replays this migration like that one.
export const v230: Migration = {
  version: 230,
  name: 'trust_generation',
  idempotent: true,
  sql: TRUST_GENERATION_SCHEMA_SQL,
};
