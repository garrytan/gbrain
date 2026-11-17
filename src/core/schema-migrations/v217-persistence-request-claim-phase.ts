import type { Migration } from './types.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #6176: a running write request records which phase its claim is in
// (persistence/claim-phase.ts): the consumer's claim renewal stamps the phase,
// the claim start and the phase start, keyed to the execution token, so
// `gbrain sources writer status` and the `persistence_write_stall` doctor check
// can name a stuck phase and its age. Column-only and nullable, no backfill;
// like v178 and v198 it is migration-created on PGLite and no index references it.
export const v217: Migration = {
  version: 217,
  name: 'persistence_request_claim_phase',
  idempotent: true,
  sql: `
    ALTER TABLE persistence_requests ADD COLUMN IF NOT EXISTS claim_phase jsonb;
  `,
};
