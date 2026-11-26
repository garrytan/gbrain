/**
 * Engine capabilities: what a storage engine can do, by name.
 *
 * `BrainEngine.capabilities` is the read-only set an engine reports. PGLite and
 * Postgres report everything they have today; a new engine (the optional Rust
 * engine, docs/designs/RUST_ENGINE.md "Capability gating") reports only what it
 * implements, and callers ask for a capability instead of branching on
 * `engine.kind`.
 *
 * `REQUIRED_CAPABILITIES` records what each operation, CLI command, cycle phase
 * and minion handler needs. Anything not listed needs `raw_sql`, so an engine
 * without raw SQL refuses it until its row says otherwise. On PGLite and
 * Postgres every lookup passes: both report every capability a row can name,
 * except the engine-specific `single_owner` and `postgres_admin` and the Rust-only `serialized_transactions`.
 */

import { rustMultiuserFromEnv } from './rust-engine/multiuser-switch.ts';

export const ENGINE_CAPABILITIES = [
  // Raw SQL entry points: executeRaw, executeRawDirect, withReservedConnection.
  // The Rust engine never reports it (D18: no SQL dialect).
  'raw_sql',

  // Subsystems that still reach the database through raw SQL.
  'persistence_journal',
  // The managed checkout side of a write: worktree admission (refresh fence, owner and binding checks), the refresh
  // barrier, writes held behind an import, grouped admission and the background owner check. The Rust engine never
  // reports it: it has no managed worktree, so a write to one refuses naming this capability.
  'managed_persistence',
  'minion_queue',
  'access_control',
  'belief_ledger',
  /** One owner process hosts the brain and other processes are its clients. */
  'single_owner',
  /** Postgres server administration: pooler, roles, server settings and statistics. */
  'postgres_admin',
  /**
   * Explicit transactions hold the store's whole writer, so no other commit lands inside one. A lock a SQL engine takes
   * (a row lock, an advisory lock, `SKIP LOCKED`, a page-key lock) is skipped on an engine that reports it, and every such
   * skip asserts it first (rust-engine/errors.ts `assertSerializedTransactions`, store-members/common.ts
   * `assertStoreSerializedTransactions`, the store's `Store::assert_serialized_transactions`), so an engine mode without it
   * refuses instead of racing. Only the Rust engine reports it (docs/designs/rust-engine/multi-user-server.md, G1).
   */
  'serialized_transactions',

  // Typed BrainEngine storage domains.
  'schema',
  'transactions',
  'sources',
  'config',
  'pages',
  'page_versions',
  'page_body',
  'tags',
  'chunks',
  'embeddings',
  'keyword_search',
  'vector_search',
  'links',
  'timeline',
  'graph',
  'facts',
  'takes',
  'files',
  'code_edges',
  'salience',
  'health',
  'raw_data',
  'eval_capture',
  /** Search telemetry, MCP usage, retrieval feedback and the budget ledger (key tag `a`). */
  'telemetry',
  /** Cross-source entity identity groups (migration v137; key tag `i`). */
  'entity_identities',
  'ingest_log',
  'dream_verdicts',
  'contradictions',
  'ontology',
  /** The session cursor and checkpoint manifest of context_pack and delta (`session_context_state`, key tag `y`). */
  'session_state',
  /**
   * The commit log and commit positions (`readCommitLog`, `lastCommitPosition`): a Rust store in multi-user mode with the
   * commit log on (rust/docs/store/commit-log.md). No SQL engine reports it; the Rust engine reports it only while its
   * store keeps a log, and refuses both members naming it otherwise.
   */
  'commit_log',
] as const;

/**
 * Capabilities of the multi-user program (docs/designs/rust-engine/multi-user-server.md, interface I-8.v2). They are
 * reported only while the multi-user switch is on (rust-engine/multiuser-switch.ts), so with it off every engine's capability
 * set, and the error catalogue that lists ENGINE_CAPABILITIES, stay exactly what they were.
 *
 * - `multi_writer`: explicit transactions on many connections run at once, each one validated at commit (Postgres:
 *   yes; PGLite: no, one connection; Rust: yes when its optimistic transactions are on).
 * - `served`: the engine is a client of a brain server over protocol v3 (rust-engine/served/); only a served Rust
 *   engine reports it.
 */
export const MULTIUSER_CAPABILITIES = ['multi_writer', 'served'] as const;

export type Capability = (typeof ENGINE_CAPABILITIES)[number] | (typeof MULTIUSER_CAPABILITIES)[number];

/** The read-only capability set an engine reports. */
export type EngineCapabilities = ReadonlySet<Capability>;

/** Engine kinds whose capability set is known without opening the engine. */
export type SqlEngineKind = 'pglite' | 'postgres';

const ENGINE_ONLY: Readonly<Record<SqlEngineKind, readonly Capability[]>> = {
  pglite: ['single_owner'],
  postgres: ['postgres_admin'],
};

/** Capabilities only a Rust engine can report: no SQL engine kind gets them. PGLite and Postgres take the locks
 * `serialized_transactions` skips, and keep no commit log. */
const RUST_ONLY: readonly Capability[] = ['commit_log', 'serialized_transactions'];

const ENGINE_SPECIFIC = new Set<Capability>([...Object.values(ENGINE_ONLY).flat(), ...RUST_ONLY]);

/** What each SQL engine adds while the multi-user switch is on (MULTIUSER_CAPABILITIES). */
const MULTIUSER_ONLY: Readonly<Record<SqlEngineKind, readonly Capability[]>> = {
  pglite: [],
  postgres: ['multi_writer'],
};

/**
 * The full capability set PGLite or Postgres reports: every shared capability
 * plus its own engine-specific ones. Returns a fresh set, so one engine can
 * never change another engine's answer.
 */
export function capabilitiesForEngineKind(kind: SqlEngineKind): EngineCapabilities {
  const caps = new Set<Capability>(ENGINE_CAPABILITIES.filter(c => !ENGINE_SPECIFIC.has(c)));
  for (const c of ENGINE_ONLY[kind]) caps.add(c);
  // Multi-user mode only (environment switch; the SQL engines read no Rust config).
  if (rustMultiuserFromEnv()) for (const c of MULTIUSER_ONLY[kind]) caps.add(c);
  return caps;
}

export function hasCapability(engine: { readonly capabilities: EngineCapabilities }, capability: Capability): boolean {
  return engine.capabilities.has(capability);
}

/** The surfaces that dispatch work onto an engine. */
export type CapabilityConsumer = 'operation' | 'command' | 'phase' | 'handler';

/**
 * What each operation (`src/core/operations.ts` name), CLI command record
 * (`src/cli/command-table.ts` name), cycle phase and minion handler needs.
 * An entry is added only once its whole path is proven to run without raw SQL;
 * until then it is absent and needs `raw_sql`.
 */
export const REQUIRED_CAPABILITIES: Readonly<Record<CapabilityConsumer, Readonly<Record<string, readonly Capability[]>>>> = {
  operation: {},
  command: {},
  phase: {},
  handler: {},
};

const RAW_SQL_ONLY: readonly Capability[] = Object.freeze(['raw_sql'] as Capability[]);

/** The capabilities `name` needs. An unlisted name needs `raw_sql`. */
export function requiredCapabilities(consumer: CapabilityConsumer, name: string): readonly Capability[] {
  const table = REQUIRED_CAPABILITIES[consumer];
  return Object.prototype.hasOwnProperty.call(table, name) ? table[name]! : RAW_SQL_ONLY;
}

/** The capabilities `name` needs that `engine` does not report, in table order. Empty means it can run. */
export function missingCapabilities(
  engine: { readonly capabilities: EngineCapabilities },
  consumer: CapabilityConsumer,
  name: string,
): Capability[] {
  return requiredCapabilities(consumer, name).filter(c => !engine.capabilities.has(c));
}

/**
 * True only when `engine` reports a capability set without `raw_sql` (the Rust engine, D18). Reads of tables such an
 * engine does not have (persistence custody, planner statistics) skip with their "nothing there" answer instead of
 * refusing. An object without a capability set, such as a transaction handle, counts as raw SQL, so PGLite and
 * Postgres always run their SQL.
 */
export function lacksRawSql(engine: object): boolean {
  const caps = (engine as { capabilities?: EngineCapabilities }).capabilities;
  return !!caps && !caps.has('raw_sql');
}
