import type { Migration } from './types.ts';
import { TRUST_ALLOW_RULES_SQL } from '../trust/allow-rules.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Memory trust (#5575 DX-14, ENG-20): `trust_allow_rules`, the owner's
// receipted allow rules for the write gate (`gbrain trust allow`). A rule
// names a source and optionally a server-stamped source URI prefix and one
// reason family; removal keeps the row with removed_at as its receipt. A new
// table with no backfill. No
// schema.sql mirror: like the trust tier schema (v226), it exists only
// through migrations.
export const v229: Migration = {
  version: 229,
  name: 'trust_allow_rules',
  idempotent: true,
  sql: TRUST_ALLOW_RULES_SQL,
};
