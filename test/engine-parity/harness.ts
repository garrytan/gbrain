/**
 * BrainEngine parity harness: one scenario, every engine arm, same answer.
 *
 * `parityArms(testBackends())` opens one engine per selected backend:
 * PGLite on every run, Postgres too when DATABASE_URL is set. A future Rust
 * arm slots into `openArm()`/`resetArm()` (the exhaustive switch below): no
 * parity case changes.
 *
 * `const { parityTest } = parityArms(testBackends());` then
 * `parityTest(name, { methods }, scenario)` runs `scenario` on each arm in
 * turn, from a reset brain, and then:
 *   1. fails when a method named in `methods` was not called on the engine
 *      handle (a coverage declaration has to be backed by a real call);
 *   2. fails when two arms returned different observables (`toEqual`).
 * Scenarios assert engine-independent expectations inline and return only
 * stable, comparable data (no timestamps, no generated ids unless reset
 * makes them deterministic). Assertions go through typed BrainEngine
 * methods, never `executeRaw` (D18: the Rust engine has no SQL dialect).
 *
 * A case that needs a capability some arm lacks declares `requires`
 * (arm-capabilities.ts): raw SQL runs on the SQL arms and must be refused by
 * the Rust arm; the Postgres-only schema migration lock runs on Postgres only.
 *
 * `methods` is read statically by `test/engine-parity/coverage.ts` to build
 * `test/engine-parity/coverage.tsv`, so it must be an array literal of
 * string literals.
 */
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { resetPgliteState, truncateCascade } from '../helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { TestBackend } from '../helpers/test-backends.ts';
import { armHas, isCapabilityRefusal, missingCapability, type EngineCapability } from './arm-capabilities.ts';

/** A callable BrainEngine member name. */
export type EngineMethod = {
  [K in keyof BrainEngine]-?: NonNullable<BrainEngine[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof BrainEngine];

export interface ParityArm {
  backend: TestBackend;
  engine: BrainEngine;
  close: () => Promise<void>;
  /** Build a second, not yet connected engine of this arm and the config `connect` takes. */
  unconnected: () => { engine: BrainEngine; config: EngineConfig };
}

/** Per-case facilities beyond the arm's engine. */
export interface ParityContext {
  /**
   * A second engine of the case's arm, not connected yet, with the config to
   * connect it (PGLite: a new in-memory brain; Postgres: the arm's database).
   * Calls on it count toward `methods`. The harness disconnects it after the
   * case, so lifecycle cases (connect, disconnect) never touch the shared arm.
   */
  unconnectedEngine(): { engine: BrainEngine; config: EngineConfig };
}

export interface ParityCaseOpts {
  /** BrainEngine methods this case covers. Each must be called on every arm. */
  methods: readonly EngineMethod[];
  /**
   * A capability the scenario needs (test/engine-parity/arm-capabilities.ts).
   * Arms with it run the scenario and compare answers. On an arm without it,
   * a `refuses` capability means the scenario must throw the typed
   * `engine_capability_missing` refusal, and an `n/a` capability skips the arm.
   */
  requires?: EngineCapability;
  timeout?: number;
}

export type ParityScenario<T> = (engine: BrainEngine, backend: TestBackend, ctx: ParityContext) => Promise<T>;

function assertNever(value: never): never {
  throw new Error(`engine-parity: unhandled test backend ${String(value)}`);
}

async function openArm(backend: TestBackend): Promise<ParityArm> {
  switch (backend) {
    case 'pglite': {
      const engine = new PGLiteEngine();
      await engine.connect({ engine: 'pglite' } as never);
      await engine.initSchema();
      return { backend, engine, close: () => engine.disconnect(),
        unconnected: () => ({ engine: new PGLiteEngine(), config: { engine: 'pglite' } }) };
    }
    case 'postgres': {
      const { engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!);
      return { backend, engine, close,
        unconnected: () => ({ engine: new PostgresEngine(), // An instance pool, never the module-level singleton other code shares.
        config: { engine: 'postgres', database_url: databaseUrl, poolSize: 2 } as EngineConfig }) };
    }
    default:
      return assertNever(backend);
  }
}

/** Infrastructure rows every reset keeps (mirrors test/helpers/reset-pglite.ts). */
const PRESERVED_TABLES = ['schema_version', 'page_generation_clock', 'persistence_brain'];

/**
 * Postgres: the schema's enabled event trigger sends resetPgliteState down its
 * TRUNCATE path (~2.8 s a test). Delete every row under replica role instead
 * (truncateCascade, ~ms); sequences keep counting, so cases never compare ids.
 */
async function resetPostgres(engine: BrainEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  const tables = await engine.executeRaw<{ relname: string }>(
    `SELECT c.relname FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p') AND NOT (c.relname = ANY($1::text[]))`,
    [PRESERVED_TABLES],
  );
  if (tables.length > 0) await truncateCascade(engine, tables.map((t) => t.relname));
  await engine.executeRaw(
    `UPDATE persistence_brain SET brain_id = gen_random_uuid(), enabled = false, activated_at = NULL WHERE singleton = 1`,
  );
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config) VALUES ('default', 'default', '{"federated": true}'::jsonb) ON CONFLICT (id) DO NOTHING`,
  );
}

/** Return the arm to an empty brain (default source only). Harness-only SQL: cases never use it. */
async function resetArm(arm: ParityArm): Promise<void> {
  switch (arm.backend) {
    case 'pglite':
      await resetPgliteState(arm.engine as PGLiteEngine);
      return;
    case 'postgres':
      await resetPostgres(arm.engine);
      return;
    default:
      return assertNever(arm.backend);
  }
}

/**
 * Fixture: register a second source (BrainEngine has no typed "create source"
 * method). Harness-only SQL behind the backend switch; a Rust arm supplies its
 * own path here. Cases call this instead of executeRaw.
 */
export async function createSource(engine: BrainEngine, backend: TestBackend, id: string, config: Record<string, unknown> = {}): Promise<void> {
  switch (backend) {
    case 'pglite':
    case 'postgres':
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config) VALUES ($1, $1, $2::text::jsonb) ON CONFLICT (id) DO NOTHING`,
        [id, JSON.stringify(config)],
      );
      return;
    default:
      return assertNever(backend);
  }
}

/** Wrap an engine so every direct method call on the handle is recorded. */
function recordingEngine(engine: BrainEngine, calls: Set<string>): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        calls.add(prop);
        // The transaction handle is an engine too: record the calls made on it.
        if (prop === 'transaction' && typeof args[0] === 'function') {
          const fn = args[0] as (tx: BrainEngine) => unknown;
          args = [(tx: BrainEngine) => fn(recordingEngine(tx, calls)), ...args.slice(1)];
        }
        return (value as (...a: unknown[]) => unknown).apply(target, args);
      };
    },
  });
}

export interface ParitySuite {
  /** Run `scenario` on every arm from a reset brain; compare the returned observables. */
  parityTest<T>(name: string, opts: ParityCaseOpts, scenario: ParityScenario<T>): void;
  /** The open arms (valid inside tests). */
  arms(): readonly ParityArm[];
}

/**
 * Register arm setup/teardown for the current test file and return its
 * `parityTest`. Call once at the top level of a parity file:
 * `const { parityTest } = parityArms(testBackends());`
 * Each file makes the zero-argument `testBackends()` call itself, so
 * `scripts/check-postgres-lane-coverage.ts` sees the file's Postgres arm and
 * requires its row in `test/postgres-unit-arms.txt` (the lane that runs the
 * Postgres arm in CI). `test/engine-parity/coverage.test.ts` pins that call.
 */
export function parityArms(backends: readonly TestBackend[]): ParitySuite {
  let arms: ParityArm[] = [];
  beforeAll(async () => {
    const opened: ParityArm[] = [];
    try {
      for (const backend of backends) opened.push(await openArm(backend));
    } catch (error) {
      for (const arm of opened) await arm.close();
      throw error;
    }
    arms = opened;
  }, 120_000);
  afterAll(async () => {
    const closing = arms;
    arms = [];
    for (const arm of closing) await arm.close();
  }, 60_000);

  function parityTest<T>(name: string, opts: ParityCaseOpts, scenario: ParityScenario<T>): void {
    test(name, async () => {
      expect(arms.length).toBeGreaterThan(0);
      const results: Array<{ backend: TestBackend; value: T }> = [];
      for (const arm of arms) {
        await resetArm(arm);
        const calls = new Set<string>();
        const extra: BrainEngine[] = [];
        const ctx: ParityContext = {
          unconnectedEngine: () => {
            const { engine, config } = arm.unconnected();
            extra.push(engine);
            return { engine: recordingEngine(engine, calls), config };
          },
        };
        const runs = armHas(arm.backend, opts.requires);
        if (!runs && missingCapability(opts.requires!).kind === 'n/a') continue;
        let value: T;
        try {
          if (!runs) {
            // The arm lacks a `refuses` capability: the scenario must stop on the typed refusal.
            const refusal = await scenario(recordingEngine(arm.engine, calls), arm.backend, ctx).then(() => null, (e: unknown) => e);
            expect({ backend: arm.backend, refused: isCapabilityRefusal(refusal, opts.requires!) })
              .toEqual({ backend: arm.backend, refused: true });
            continue;
          }
          value = await scenario(recordingEngine(arm.engine, calls), arm.backend, ctx);
        } catch (error) {
          if (error instanceof Error) error.message = `[${arm.backend}] ${error.message}`;
          throw error;
        } finally {
          // A case may already have disconnected it; a second disconnect is harmless or refused.
          for (const engine of extra) await engine.disconnect().catch(() => undefined);
        }
        const missing = opts.methods.filter((m) => !calls.has(m));
        expect({ backend: arm.backend, declaredButNotCalled: missing }).toEqual({ backend: arm.backend, declaredButNotCalled: [] });
        results.push({ backend: arm.backend, value });
      }
      const [first, ...rest] = results;
      for (const other of rest) {
        expect({ backend: other.backend, value: other.value }).toEqual({ backend: other.backend, value: first!.value });
      }
    }, opts.timeout ?? 60_000);
  }

  return { parityTest, arms: () => arms };
}

/** Sorted copy, for order-free comparisons. */
export function sorted<T>(values: Iterable<T>, key: (v: T) => string = (v) => String(v)): T[] {
  return [...values].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}

/** Pick listed keys from a row, mapping Dates to a fixed marker so arms compare. */
export function pick<T extends object, K extends keyof T>(row: T, keys: readonly K[]): Pick<T, K> {
  const out = {} as Pick<T, K>;
  for (const k of keys) {
    const v = row[k];
    (out as Record<K, unknown>)[k] = v instanceof Date ? '<date>' : v;
  }
  return out;
}

/** A 1536-d unit vector on axis `idx`: deterministic, engine-independent. */
export function basisEmbedding(idx: number, dim = 1536): Float32Array {
  const emb = new Float32Array(dim);
  emb[idx % dim] = 1;
  return emb;
}
