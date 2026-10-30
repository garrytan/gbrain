import type { Migration } from './types.ts';
import { GIT_CANONICAL_SCHEMA_SQL } from '../persistence/git-canonical-schema.ts';
import { MANAGED_WRITER_GUARD_FUNCTION_SQL } from '../persistence/writer-guard-schema.ts';

// Applied by src/core/migrate.ts on the next initSchema(); see docs/ENGINES.md
// ("Canonical schema sources") for when schema.sql or a TS fragment also changes.
//
// Git-canonical memory, wave G7a (docs/designs/GIT_CANONICAL_MEMORY.md): the
// strict-source counter (git_canonical_brain, kept by row triggers on sources)
// and the git-canonical fence branch of the managed writer guard, which refuses a
// row of a source with config.canonical = "git" from a writer that does not
// declare gbrain.git_protocol (an older gbrain). Replaces only the guard
// function: its triggers already call it, and re-creating them would take
// ACCESS EXCLUSIVE locks on the largest tables. Additive: no source is strict
// until conversion, so the fence refuses nothing; no page row is read or changed.
// Provisional number: renumbered at the merge slot.
export const v272: Migration = {
  version: 272,
  name: 'git_canonical_declared',
  idempotent: true,
  sql: `${GIT_CANONICAL_SCHEMA_SQL}\n${MANAGED_WRITER_GUARD_FUNCTION_SQL}`,
};
