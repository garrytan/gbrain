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
 *  - `multi_writer` (I-8 name) is the engine's own report that many writers can use one brain at once. Postgres has it;
 *    PGLite is one connection and the Rust engine reports it only with the multi-user switch on and optimistic explicit
 *    transactions active, so neither has it here. A missing `multi_writer` is `n/a` (the case does not run on that arm). The
 *    multi-writer conformance cases (multi-writer-cases.ts) are decided per arm by their support matrix instead of by
 *    `requires`; the Rust labels check the capability on the engine itself at run time.
 *  - `managed_persistence` refuses on an arm without it, naming it (src/core/engine-capabilities.ts). The Rust engine does
 *    not report it until the managed-persistence program is done (rust-engine/store-capabilities.ts holds it), so a write
 *    to a managed worktree, and the first write to a rooted source that would claim one, refuse naming it there.
 *
 *    With `GBRAIN_TEST_RUST_MANAGED=1` (test/engine-parity/rust-managed.ts) the Rust arm lifts that hold on every engine
 *    it opens and reports `managed_persistence` here too, so a `requires: 'managed_persistence'` case runs its body on
 *    Rust and is pinned in rust-managed-tally.tsv instead of rust-tally.tsv. Users never see the lift.
 *
 * When `BrainEngine.capabilities` and `src/core/engine-capabilities.ts` land
 * (plan PR 5), `armCapabilities` reads the engine's own set instead of this
 * table, and the parity cases keep their `requires` declarations.
 */

/** Every engine arm a parity case can run on, present or planned. */
export const PARITY_ARMS = ['pglite', 'postgres', 'rust'] as const;
export type ParityArmName = typeof PARITY_ARMS[number];

/** Capabilities a parity case can require (a subset of the planned engine capability set). */
export type EngineCapability = 'raw_sql' | 'schema_migration_lock' | 'managed_persistence' | 'multi_writer';

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
    case 'multi_writer': return { kind: 'n/a', label: 'n/a:multi_writer' };
    default: return assertNever(capability);
  }
}

/** The lifted-hold test mode (rust-managed.ts): the Rust arm runs managed persistence with the user-facing hold kept. */
export const RUST_MANAGED_FLAG = 'GBRAIN_TEST_RUST_MANAGED';

export function rustManagedRequested(env: Record<string, string | undefined> = process.env): boolean {
  return env[RUST_MANAGED_FLAG] === '1';
}

export function armCapabilities(arm: ParityArmName, env: Record<string, string | undefined> = process.env): ReadonlySet<EngineCapability> {
  switch (arm) {
    case 'pglite': return new Set<EngineCapability>(['raw_sql', 'managed_persistence']);
    case 'postgres': return new Set<EngineCapability>(['raw_sql', 'schema_migration_lock', 'managed_persistence', 'multi_writer']);
    // No `managed_persistence` while store-capabilities.ts holds it: a Rust brain refuses managed mode with the typed refusal.
    case 'rust': return new Set<EngineCapability>(rustManagedRequested(env) ? ['managed_persistence'] : []);
    default: return assertNever(arm);
  }
}

export function armHas(arm: ParityArmName, capability: EngineCapability | undefined, env: Record<string, string | undefined> = process.env): boolean {
  return capability === undefined || armCapabilities(arm, env).has(capability);
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
