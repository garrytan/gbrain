/**
 * v0.28.1: LongMemEval benchmark harness — reset-in-place over one in-memory PGLite.
 *
 * The benchmark is sequential: 500 questions × independent haystacks. Instead
 * of building a fresh PGLite per question (snapshot fast-path complexity, env
 * mutation, unverified restore semantics), we connect ONE in-memory engine
 * for the whole run and TRUNCATE all public tables between questions.
 *
 * Tables are enumerated at runtime via pg_tables so a future schema migration
 * (a new takes/oauth/dream table) doesn't silently leak across questions.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PGLiteEngine } from '../../core/pglite-engine.ts';
import type { BrainEngine } from '../../core/engine.ts';
import { openRustEngine } from '../../core/rust-engine.ts';
import type { RustEngineAddonLoad, RustEngineAddonRefusalCode } from '../../core/rust-engine/addon-loader.ts';

/** The addon loader seam of the benchmark brain; tests inject one. */
export type BenchmarkAddonLoader = () => Promise<RustEngineAddonLoad>;

/** `--engine rust` with no usable addon: the loader's refusal code, reason and message. Nothing was created. */
export class RustEngineAddonUnavailableError extends Error {
  readonly code: RustEngineAddonRefusalCode | 'rust_benchmark_unsupported';
  readonly reason: string;
  constructor(failure: { code: RustEngineAddonRefusalCode | 'rust_benchmark_unsupported'; reason: string; message: string }) {
    super(`${failure.code} (${failure.reason}): ${failure.message}`);
    this.name = 'RustEngineAddonUnavailableError';
    this.code = failure.code;
    this.reason = failure.reason;
  }
}

/** The engines an in-tree eval can build its benchmark brain on (`--engine`). PGLite is the default. */
export const BENCHMARK_ENGINE_KINDS = ['pglite', 'rust'] as const;
export type BenchmarkEngineKind = typeof BENCHMARK_ENGINE_KINDS[number];

/** Parses an `--engine` value, or throws naming the accepted values. */
export function parseBenchmarkEngineKind(flag: string, value: string): BenchmarkEngineKind {
  const kind = value.trim().toLowerCase();
  if ((BENCHMARK_ENGINE_KINDS as readonly string[]).includes(kind)) return kind as BenchmarkEngineKind;
  throw new Error(`${flag} must be ${BENCHMARK_ENGINE_KINDS.join('|')} (got: ${value})`);
}

interface PgTablesRow {
  tablename: string;
}

/**
 * Tables that initSchema() seeds rows into and FK-depends on. TRUNCATEing
 * them between benchmark questions either nukes seeded rows (sources.'default'
 * which pages.source_id FK-points to) or coordination state that should
 * survive across the run. Everything else is content + can be cleared.
 */
const PRESERVE_TABLES: ReadonlySet<string> = new Set([
  // FK target for pages.source_id; seeded as 'default' by pglite-schema.ts.
  'sources',
  // Key-value config; empty in a benchmark run, but config is infrastructure.
  'config',
  // Coordination locks; not content.
  'gbrain_cycle_locks',
  'subagent_rate_leases',
  // System One eval arms insert calibrations once per brain (configureDecideBrain); empty otherwise.
  'decide_calibrations',
  // The brain's identity and persistence-mode singleton (#6482): a brain without exactly one row refuses every write.
  'persistence_brain',
]);

/**
 * A fresh, isolated benchmark brain: an in-memory PGLite by default. `rust` loads the Rust engine addon with the
 * addon loader (src/core/rust-engine/addon-loader.ts; it never reaches the network) and builds the engine on a throwaway store directory removed at
 * disconnect, so the user's brain is never opened. A missing or mismatched addon throws
 * RustEngineAddonUnavailableError with its code and reason before anything is created. Until the Rust store runs raw
 * SQL (the table reset between fixtures), the brain is refused as `rust_benchmark_unsupported` before any work.
 */
export function createBenchmarkBrain(): Promise<PGLiteEngine>;
export function createBenchmarkBrain(kind: BenchmarkEngineKind, deps?: { loadAddon?: BenchmarkAddonLoader }): Promise<BrainEngine>;
export async function createBenchmarkBrain(
  kind: BenchmarkEngineKind = 'pglite',
  deps: { loadAddon?: BenchmarkAddonLoader } = {},
): Promise<BrainEngine> {
  if (kind === 'rust') return createRustBenchmarkBrain(deps.loadAddon ?? defaultAddonLoader);
  const engine = new PGLiteEngine();
  await engine.connect({}); // in-memory; no database_path, no file lock acquired
  await engine.initSchema();
  return engine;
}

/**
 * The run's first benchmark brain, or null after printing a `--engine rust` addon refusal (`[<tag>] --engine rust:
 * <code> (<reason>): <message>`) to stderr, so the command can exit 2. Any other error is re-thrown.
 */
export async function openFirstBenchmarkBrain(create: () => Promise<BrainEngine>, tag: string): Promise<BrainEngine | null> {
  try {
    return await create();
  } catch (err) {
    if (!(err instanceof RustEngineAddonUnavailableError)) throw err;
    process.stderr.write(`[${tag}] --engine rust: ${err.message}\n`);
    return null;
  }
}

/** The real loader, imported only when a run asks for the Rust engine, so PGLite runs never load it. */
async function defaultAddonLoader(): Promise<RustEngineAddonLoad> {
  const { loadRustEngineAddon } = await import('../../core/rust-engine/addon-loader.ts');
  return loadRustEngineAddon();
}

async function createRustBenchmarkBrain(loadAddon: BenchmarkAddonLoader): Promise<BrainEngine> {
  const load = await loadAddon();
  if (!load.ok) throw new RustEngineAddonUnavailableError(load);
  const store = mkdtempSync(join(tmpdir(), 'gbrain-bench-rust-'));
  const engine = openRustEngine({ addon: load.addon, databasePath: store });
  // The store directory and the owner lock the engine keeps beside it.
  const cleanup = (): void => { rmSync(store, { recursive: true, force: true }); rmSync(`${store}.gbrain-owner.lock`, { force: true }); };
  engine.registerBeforeDisconnect(async () => cleanup());
  try {
    await engine.connect({ database_path: store });
    await engine.initSchema();
    // Every fixture starts from `resetTables`, which is raw SQL: refuse now, before any work, if the store cannot run it yet.
    if (!engine.capabilities.has('raw_sql')) {
      throw new RustEngineAddonUnavailableError({ code: 'rust_benchmark_unsupported', reason: 'raw_sql_missing', message: 'the Rust store cannot reset tables between fixtures yet (it does not report raw_sql)' });
    }
  } catch (error) {
    await engine.disconnect();
    cleanup();
    throw error;
  }
  // RustEngine has every BrainEngine member; only its `kind` ('rust') is outside BrainEngine.kind until the addon PR
  // widens it together with the `rust` config value. This is the one cast in the eval harness.
  return engine as unknown as BrainEngine;
}

export async function resetTables(engine: BrainEngine): Promise<void> {
  const rows = await engine.executeRaw<PgTablesRow>(
    `SELECT tablename FROM pg_tables WHERE schemaname = 'public'`,
  );
  const targets = rows.map(r => r.tablename).filter(t => !PRESERVE_TABLES.has(t));
  if (targets.length === 0) return;
  // Quote each tablename as an identifier so reserved words and mixed-case
  // names work. RESTART IDENTITY resets serial sequences; CASCADE handles
  // FK dependencies so we don't have to topologically sort.
  const list = targets.map(t => `"${t.replace(/"/g, '""')}"`).join(', ');
  await engine.executeRaw(`TRUNCATE ${list} RESTART IDENTITY CASCADE`);
}

export async function withBenchmarkBrain<T>(
  fn: (engine: BrainEngine) => Promise<T>,
): Promise<T> {
  const engine = await createBenchmarkBrain();
  try {
    return await fn(engine);
  } finally {
    await engine.disconnect();
  }
}

/** #5092: questions per harness-owned benchmark brain before it is replaced. */
export const LME_BRAIN_RECYCLE_EVERY = 40;

/**
 * #5092 — TRUNCATE between questions never returns PGLite's WASM memory,
 * which grows with every question's vectors (~30 MB per 500-chunk question)
 * until a long single-process run stalls at 100% CPU around question 90-120.
 * `next()` hands out the brain for the next question, replacing it with a
 * fresh, re-configured one every `every` questions (0 = never). `close()`
 * disconnects a replacement; the first brain stays its owner's to close.
 */
export function brainRecycler<E extends BrainEngine>(
  first: E,
  every: number,
  create: () => Promise<E>,
  configure: (engine: E) => Promise<void>,
): { next(): Promise<E>; close(): Promise<void> } {
  let brain = first;
  let served = 0;
  return {
    async next() {
      if (every > 0 && served === every) {
        await brain.disconnect();
        brain = await create();
        await configure(brain);
        served = 0;
      }
      served++;
      return brain;
    },
    async close() {
      if (brain !== first) await brain.disconnect();
    },
  };
}
