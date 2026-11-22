/**
 * Narrow an engine kind to the two SQL engines before a SQL-only path picks
 * per-dialect values. A Rust brain has no SQL dialect (decision D18), so it is
 * refused with `engine_capability_missing` (reason `raw_sql`) instead of
 * falling silently into the Postgres or PGLite branch.
 */
import type { SqlEngineKind } from './engine-capabilities.ts';
import { capabilityMissing } from './rust-engine/errors.ts';

/** Every engine kind. `BrainEngine.kind` widens to it with the `rust` config value (the addon PR); until then SQL-only paths take this type so their Rust refusal is already in place. */
export type EngineKind = SqlEngineKind | 'rust';

export function isRustEngineKind(kind: EngineKind | undefined | null): boolean {
  return kind === 'rust';
}

export function isSqlEngineKind(kind: EngineKind | undefined | null): kind is SqlEngineKind {
  return kind === 'pglite' || kind === 'postgres';
}

/** `kind` when it is pglite or postgres; otherwise throws `engine_capability_missing` naming `member`. */
export function sqlEngineKind(kind: EngineKind, member: string): SqlEngineKind {
  if (isSqlEngineKind(kind)) return kind;
  throw capabilityMissing('raw_sql', member);
}
