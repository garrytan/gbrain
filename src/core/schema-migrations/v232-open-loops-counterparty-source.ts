import type { Migration } from './types.ts';
import { OPEN_LOOPS_COUNTERPARTY_SOURCE_COLUMN_SQL, OPEN_LOOPS_COUNTERPARTY_SOURCE_INDEX } from '../loops/loops-schema.ts';
import { buildIndexOnline, migrationNotice } from './helpers.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// #5504 (wave 14 P4.1): `open_loops.counterparty_source_id` names the source of
// the person page a loop's counterparty resolved to. loops_extract and the
// deterministic detector resolve a counterparty in the loop's own source first
// and, failing that, across sources by identity only (an entity_identities
// canonical member or an exact-email alias; google/counterparty.ts), so a
// Gmail source's loop can point at `default:people/<slug>`. Readers that join a
// loop to an entity page confine on both predicates (slug AND source), with a
// NULL (pre-v232 row) read as the loop's own source. Nullable, no default,
// metadata-only on Postgres 11+ and PGLite; not in schema.sql's CREATE TABLE,
// so fresh and upgraded brains share column ordinals (the v180/v221 pattern).
// The partial index serves the entity card's lookup; Postgres builds it
// CONCURRENTLY on a dedicated connection, PGLite inline (buildIndexOnline).
export const v232: Migration = {
  version: 232,
  name: 'open_loops_counterparty_source',
  idempotent: true,
  sql: `${OPEN_LOOPS_COUNTERPARTY_SOURCE_COLUMN_SQL};`,
  handler: async engine => {
    await buildIndexOnline(engine, 232, OPEN_LOOPS_COUNTERPARTY_SOURCE_INDEX, { notice: migrationNotice });
  },
};
