import type { Migration } from './types.ts';
import { FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL } from '../facts/withdrawal-schema.ts';
import { FACT_INSERT_GUARD_FUNCTION_SQL } from '../facts/insert-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// GST-2346: a member's save on its own member page no longer reveals that a claim it never read was withdrawn. The two
// insert guards that stamp a row matching a withdrawal as withdrawn (gbrain_preserve_fact_withdrawal per row,
// gbrain_guard_inserted_facts per statement) mark a row on a member page (memory/members/<id>) only by that page's own
// withdrawals; the member's save checks the withdrawals of claims that member reads instead (facts/single-prepare.ts).
// A withdrawal still expires every matching row, member pages included, when it is made. Replaces only the functions: their triggers already call them,
// and re-creating a trigger would take an ACCESS EXCLUSIVE lock on facts. The migration run's search_path hardening
// (function-search-path.ts) appends pg_temp again. No row is read or written.
export const v306: Migration = {
  version: 306,
  name: 'member_page_withdrawal_scope',
  idempotent: true,
  sql: `${FACT_WITHDRAWAL_PRESERVE_FUNCTION_SQL};\n${FACT_INSERT_GUARD_FUNCTION_SQL}`,
};
