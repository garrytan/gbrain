import type { Migration } from './types.ts';

export const v087: Migration = {
  version: 87,
  name: 'takes_kind_drop_check',
  // v0.39.0.0 schema-cathedral wave (T3 + codex T10 fix). Renumbered
  // v80→v81→v82→v87 across successive master merges. Final renumber
  // landed it after master's v0.38.1.0 agent-loop bundle (v81-v85).
  //
  // Pre-v0.38: `takes.kind` was enforced by a DB CHECK constraint
  // CHECK (kind IN ('fact','take','bet','hunch')) at the original
  // table-creation migration (v41 / v48 in pre-renumber numbering).
  // The same closed enum was duplicated as a TS type union.
  //
  // v0.38 opens the type surface so schema packs declare allowed kinds
  // at runtime against the active pack's `annotation` primitive
  // `takes_kinds:` field. This migration drops the DB CHECK; runtime
  // validation in src/core/schema-pack/registry.ts takes over.
  //
  // Codex F10: dropping the DB CHECK without also widening the TS
  // type "moves inconsistency around" — old clients and raw SQL could
  // poison rows that runtime-validate cleanly. Both layers move
  // together: this migration + src/core/engine.ts + src/core/takes-fence.ts
  // already widened to `string`.
  //
  // Idempotent: `IF EXISTS` on both engines. PGLite supports
  // ALTER TABLE DROP CONSTRAINT IF EXISTS (standard SQL).
  idempotent: true,
  sql: `
      ALTER TABLE takes DROP CONSTRAINT IF EXISTS takes_kind_check;
    `,
};
