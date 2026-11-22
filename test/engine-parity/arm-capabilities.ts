/**
 * Which engine capabilities each parity arm has, and what a parity case that
 * needs a missing capability expects on that arm.
 *
 * Pure data: no engine and no `bun:test` import, so `coverage.ts` (a plain
 * script) and `harness.ts` share one table. The arm list includes `rust`
 * before the Rust arm exists, so the coverage list can already say what the
 * Rust arm must do for every method.
 *
 * Two kinds of missing capability (RUST_ENGINE.md, D18):
 *  - `refuses`: the arm must throw `engine_capability_missing` naming the
 *    capability. The Rust engine has no SQL dialect, so every raw-SQL entry
 *    point refuses with reason `raw_sql`.
 *  - `n/a`: the arm has no such member at all and the case does not run there.
 *    `holdSchemaMigrationLock` is an optional member only Postgres implements;
 *    PGLite (and Rust) serialize schema migrations in-process instead
 *    (src/core/schema-migration-lock.ts).
 *  - `managed_persistence` refuses: the Rust engine has no managed worktree, so a write to one refuses naming it
 *    (src/core/engine-capabilities.ts).
 *  - `oauth_write_grant` is n/a: the Rust store keeps no OAuth clients yet, so a remote write over HTTP is refused at
 *    admission (permission_denied) before it can commit. Lane 8 (bound-write-rust) serves the write grant; remove
 *    this capability, and the `requires` that name it, when the Rust engine serves readOAuthClientWriteGrant.
 *
 * When `BrainEngine.capabilities` and `src/core/engine-capabilities.ts` land
 * (plan PR 5), `armCapabilities` reads the engine's own set instead of this
 * table, and the parity cases keep their `requires` declarations.
 */

/** Every engine arm a parity case can run on, present or planned. */
export const PARITY_ARMS = ['pglite', 'postgres', 'rust'] as const;
export type ParityArmName = typeof PARITY_ARMS[number];

/** Capabilities a parity case can require (a subset of the planned engine capability set). */
export type EngineCapability = 'raw_sql' | 'schema_migration_lock' | 'managed_persistence' | 'oauth_write_grant';

export interface MissingCapability {
  /** `refuses`: the arm throws `engine_capability_missing`; `n/a`: the case does not run on the arm. */
  kind: 'refuses' | 'n/a';
  /** The coverage-list cell for an arm without the capability. */
  label: string;
}

export function missingCapability(capability: EngineCapability): MissingCapability {
  switch (capability) {
    case 'raw_sql': return { kind: 'refuses', label: 'refuses:raw_sql' };
    case 'schema_migration_lock': return { kind: 'n/a', label: 'n/a:postgres-only' };
    case 'managed_persistence': return { kind: 'refuses', label: 'refuses:managed_persistence' };
    case 'oauth_write_grant': return { kind: 'n/a', label: 'n/a:waiting-lane-8' };
    default: return assertNever(capability);
  }
}

export function armCapabilities(arm: ParityArmName): ReadonlySet<EngineCapability> {
  switch (arm) {
    case 'pglite': return new Set<EngineCapability>(['raw_sql', 'managed_persistence', 'oauth_write_grant']);
    case 'postgres': return new Set<EngineCapability>(['raw_sql', 'schema_migration_lock', 'managed_persistence', 'oauth_write_grant']);
    // No `oauth_write_grant` until lane 8 serves readOAuthClientWriteGrant on the Rust engine.
    case 'rust': return new Set<EngineCapability>();
    default: return assertNever(arm);
  }
}

export function armHas(arm: ParityArmName, capability: EngineCapability | undefined): boolean {
  return capability === undefined || armCapabilities(arm).has(capability);
}

/**
 * True when `error` is the typed refusal for `capability`: code
 * `engine_capability_missing` and that capability as its reason. The code and
 * reason may sit on the error, its `detail`, or a structured `envelope`
 * (src/core/errors.ts), because the Rust error class is not written yet.
 */
export function isCapabilityRefusal(error: unknown, capability: EngineCapability): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const holders = [error, (error as { detail?: unknown }).detail, (error as { envelope?: unknown }).envelope,
    ((error as { envelope?: { detail?: unknown } }).envelope)?.detail]
    .filter((h): h is Record<string, unknown> => typeof h === 'object' && h !== null);
  const code = holders.some((h) => h.code === 'engine_capability_missing');
  const reason = holders.some((h) => h.reason === capability || h.capability === capability);
  return code && reason;
}

function assertNever(value: never): never {
  throw new Error(`engine-parity: unhandled value ${String(value)}`);
}
