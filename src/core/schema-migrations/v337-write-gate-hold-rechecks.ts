import type { Migration } from './types.ts';
import { WRITE_GATE_HOLD_RECHECKS_SQL } from '../write-gate-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Held writes a purge kept only because the rename record still led to another page are noted here, so the
// maintenance sweep (write-gate-recheck.ts) can remove the ones two side-by-side purges leave behind. New table only;
// held writes left behind before this upgrade are not noted (`gbrain doctor` keeps listing them).
export const v337: Migration = {
  version: 337,
  name: 'write_gate_hold_rechecks',
  idempotent: true,
  sql: WRITE_GATE_HOLD_RECHECKS_SQL,
};
