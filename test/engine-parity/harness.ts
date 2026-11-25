/**
 * BrainEngine parity harness: one scenario, every engine arm, same answer.
 *
 * `parityArms(testBackends())` opens one engine per selected backend:
 * PGLite on every run, Postgres too when DATABASE_URL is set, and the Rust
 * engine last when GBRAIN_TEST_RUST_ARM=1 (rust-arm.ts says what it owes
 * each case). The Rust arm slots into `openArm()`/`resetArm()` (the
 * exhaustive switch below): no parity case changes.
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
import { capabilityMissing } from '../../src/core/rust-engine/errors.ts';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { enableBeliefLedger } from '../../src/core/belief/coverage.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { resetPgliteState, truncateCascade } from '../helpers/reset-pglite.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { TestBackend } from '../helpers/test-backends.ts';
import { armHas, isCapabilityRefusal, missingCapability, type EngineCapability } from './arm-capabilities.ts';
import {
  archiveRustSource, createRustSource, newRustBrain, openRustBrain, DIVERGENCE_NORMALIZERS, readDivergences, removeBrainDir, rustArmRequested, rustMemberCapability, rustRefusal, type DivergenceRow,
} from './rust-arm.ts';

/** The backends a parity arm can run on: the SQL ones every suite selects, and the opt-in Rust engine. */
export type ParityBackend = TestBackend | 'rust';

/** A callable BrainEngine member name. */
export type EngineMethod = {
  [K in keyof BrainEngine]-?: NonNullable<BrainEngine[K]> extends (...args: never[]) => unknown ? K : never;
}[keyof BrainEngine];

export interface ParityArm {
  backend: ParityBackend;
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

export type ParityScenario<T> = (engine: BrainEngine, backend: ParityBackend, ctx: ParityContext) => Promise<T>;

function assertNever(value: never): never {
  throw new Error(`engine-parity: unhandled test backend ${String(value)}`);
}

/** The Rust arm: a new brain directory per case (reset), removed when the arm closes. */
async function openRustArm(): Promise<ParityArm> {
  const opened = await openRustBrain();
  const dirs = [opened.dir];
  const arm: ParityArm = {
    backend: 'rust',
    engine: opened.engine as unknown as BrainEngine,
    close: async () => {
      await arm.engine.disconnect();
      for (const dir of [...dirs, (arm.engine as unknown as { databasePath: string }).databasePath]) removeBrainDir(dir);
    },
    unconnected: () => {
      const brain = newRustBrain();
      dirs.push(brain.dir);
      return { engine: brain.engine as unknown as BrainEngine, config: { engine: 'pglite', database_path: brain.dir } as never };
    },
  };
  return arm;
}

async function resetRustArm(arm: ParityArm): Promise<void> {
  const previous = arm.engine as unknown as { databasePath: string };
  await arm.engine.disconnect();
  removeBrainDir(previous.databasePath);
  arm.engine = (await openRustBrain()).engine as unknown as BrainEngine;
  // The brain directories of every reset are removed here; the arm's own list only holds what `unconnected` made.
}

async function openArm(backend: ParityBackend): Promise<ParityArm> {
  switch (backend) {
    case 'rust':
      return openRustArm();
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
export async function resetArm(arm: ParityArm): Promise<void> {
  switch (arm.backend) {
    case 'rust':
      await resetRustArm(arm);
      return;
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
export async function createSource(engine: BrainEngine, backend: ParityBackend, id: string, config: Record<string, unknown> = {}, localPath?: string): Promise<void> {
  switch (backend) {
    case 'rust':
      await createRustSource(engine, id, config, localPath);
      return;
    case 'pglite':
    case 'postgres':
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config, local_path) VALUES ($1, $1, $2::text::jsonb, $3) ON CONFLICT (id) DO NOTHING`,
        [id, JSON.stringify(config), localPath ?? null],
      );
      return;
    default:
      return assertNever(backend);
  }
}

/** Fixture: archive a source (BrainEngine has no typed "archive source"). Harness-only SQL, as in `createSource`. */
export async function archiveSource(engine: BrainEngine, backend: ParityBackend, id: string): Promise<void> {
  switch (backend) {
    case 'rust':
      await archiveRustSource(engine, id);
      return;
    case 'pglite':
    case 'postgres':
      await engine.executeRaw(`UPDATE sources SET archived = true WHERE id = $1`, [id]);
      return;
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: start belief-ledger coverage on a source, so its ledger probe reports a coverage event. The ledger has no
 * typed enable method; this runs the production enable path behind the backend switch, as `createSource` does.
 */
export async function enableBeliefCoverage(engine: BrainEngine, backend: ParityBackend, sourceId: string): Promise<void> {
  switch (backend) {
    case 'rust':
      // The store has no belief ledger to start: the case stops here, on the typed refusal of the ledger member it was about to read.
      throw capabilityMissing('persistence_journal', 'enableBeliefCoverage');
    case 'pglite':
    case 'postgres':
      await enableBeliefLedger(engine, sourceId);
      return;
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: put a folder access rule (`kind: 'rule'`) or a pending coverage prefix (`kind: 'pending'`) on `prefix` of a
 * source, so the folder-restriction read has something to find. Harness-only SQL behind the backend switch.
 */
export async function restrictFolder(engine: BrainEngine, backend: ParityBackend, sourceId: string, prefix: string, kind: 'rule' | 'pending'): Promise<void> {
  switch (backend) {
    case 'rust':
      throw new Error('restrictFolder: the Rust store has no folder access rules; a case reaching this fixture on the Rust arm must stop on a typed refusal first');
    case 'pglite':
    case 'postgres':
      await engine.executeRaw('INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [sourceId]);
      if (kind === 'rule') {
        await engine.executeRaw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision) VALUES ($1, 'parity-rule', $2, ARRAY['member:parity'], 1)`, [sourceId, prefix]);
      } else {
        await engine.executeRaw(`INSERT INTO access_pending_coverage (source_id, prefix, reason) VALUES ($1, $2, 'pending')`, [sourceId, prefix]);
      }
      return;
    default:
      return assertNever(backend);
  }
}

/** Wrap an engine so every direct method call on the handle is recorded. */
function recordingEngine(engine: BrainEngine, calls: Set<string>, refusals: unknown[] = []): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        calls.add(prop);
        // The transaction handle is an engine too: record the calls made on it.
        if (prop === 'transaction' && typeof args[0] === 'function') {
          const fn = args[0] as (tx: BrainEngine) => unknown;
          args = [(tx: BrainEngine) => fn(recordingEngine(tx, calls, refusals)), ...args.slice(1)];
        }
        const result = (value as (...a: unknown[]) => unknown).apply(target, args);
        if (!(result instanceof Promise)) return result;
        // Keep every typed refusal a member raised: a case may catch one and carry on (the Rust arm reads them).
        return result.catch((error: unknown) => {
          if ((error as { code?: unknown } | null)?.code === 'engine_capability_missing') refusals.push(error);
          throw error;
        });
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
  const selected: ParityBackend[] = [...backends, ...(rustArmRequested() ? ['rust' as const] : [])];
  const testFile = callerTestFile(new Error().stack);
  const tally: RustTally = { compared: 0, refused: 0, diverged: 0 };
  beforeAll(async () => {
    const opened: ParityArm[] = [];
    try {
      for (const backend of selected) opened.push(await openArm(backend));
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
    if (closing.some((arm) => arm.backend === 'rust')) {
      console.log(`[rust arm] ${testFile}: ${tally.compared} equal to PGLite, ${tally.refused} stopped on a typed refusal, ${tally.diverged} expected divergences`);
    }
  }, 60_000);

  function parityTest<T>(name: string, opts: ParityCaseOpts, scenario: ParityScenario<T>): void {
    test(name, async () => {
      expect(arms.length).toBeGreaterThan(0);
      const results: Array<{ backend: ParityBackend; value: T }> = [];
      for (const arm of arms) {
        await resetArm(arm);
        const calls = new Set<string>();
        const refusals: unknown[] = [];
        const extra: BrainEngine[] = [];
        const ctx: ParityContext = {
          unconnectedEngine: () => {
            const { engine, config } = arm.unconnected();
            extra.push(engine);
            return { engine: recordingEngine(engine, calls, refusals), config };
          },
        };
        const runs = armHas(arm.backend, opts.requires);
        if (!runs && missingCapability(opts.requires!).kind === 'n/a') continue;
        if (arm.backend === 'rust') {
          const divergence = readDivergences().find((row) => row.file === testFile && row.name === name);
          try {
            await checkRustArm({ name, opts, run: () => scenario(recordingEngine(arm.engine, calls, refusals), arm.backend, ctx), calls, refusals,
              reference: results[0], divergence }, tally);
          } finally {
            for (const engine of extra) await engine.disconnect().catch(() => undefined);
          }
          continue;
        }
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

/** `test/engine-parity/x.test.ts`, the parity file that called `parityArms` (read off the stack), as a divergence row names it. */
function callerTestFile(stack: string | undefined): string {
  const found = /test\/engine-parity\/[\w.-]+\.test\.ts/.exec((stack ?? '').split('\n').slice(2).join('\n'));
  return found?.[0] ?? '';
}

/** What the Rust arm did with each case of one file, printed when the file finishes. */
export interface RustTally { compared: number; refused: number; diverged: number }

export interface RustCase<T> {
  name: string;
  opts: ParityCaseOpts;
  run: () => Promise<T>;
  calls: Set<string>;
  /** The typed refusals the engine raised during the case, including ones the case caught. */
  refusals: unknown[];
  /** What the first arm returned: the answer the Rust arm is compared with. */
  reference: { backend: ParityBackend; value: T } | undefined;
  divergence: DivergenceRow | undefined;
}

/**
 * The Rust arm's check for one case (rust-arm.ts). A case has exactly three acceptable outcomes on Rust:
 *  - it ends on the typed refusal of a capability it reaches (a member Rust does not serve, or an option a served
 *    member declines): counted as refused;
 *  - it returns the value the reference arm returned: counted as equal;
 *  - it returns a value that differs from the reference in exactly the way its row in test/rust-expected-divergence/
 *    names (a named normaliser maps both sides to one value, and the raw values must still differ so a stale row
 *    fails): counted as diverged.
 * Anything else fails: a refusal the case caught on its way to some other failure, or to a value, does not make it pass,
 * and a divergence row never excuses a thrown error.
 */
export async function checkRustArm<T>(c: RustCase<T>, tally: RustTally): Promise<void> {
  let outcome: { value: T } | { error: unknown };
  try {
    outcome = { value: await c.run() };
  } catch (error) {
    outcome = { error };
  }
  const reached = [...new Set([...c.calls, ...c.opts.methods])];
  const refusing = reached.filter((m) => rustRefusal(m) !== null);
  // A refusal is expected from a member Rust does not serve, or from a served member declining one option or input it
  // does not store (its capability is still the member's own); `requires` adds the capability a case needs.
  const capabilities = new Set(reached.map((m) => rustMemberCapability(m)).filter((x): x is string => x !== null));
  if (c.opts.requires !== undefined && !armHas('rust', c.opts.requires)) capabilities.add(c.opts.requires);
  const refusedBy = (e: unknown) => [...capabilities].some((capability) => isCapabilityRefusal(e, capability as EngineCapability));
  const caught = c.refusals.filter(refusedBy).length;

  if ('error' in outcome) {
    // Only the terminal outcome counts: a refusal caught earlier does not excuse a different failure.
    if (!refusedBy(outcome.error)) {
      if (outcome.error instanceof Error) {
        outcome.error.message = `[rust] ${outcome.error.message}${caught > 0 ? ` (the case had caught ${caught} typed refusal(s) before this)` : ''}`;
      }
      throw outcome.error;
    }
    if (c.divergence) {
      throw new Error(`[rust] "${c.name}" has a row in test/rust-expected-divergence/ (${c.divergence.reason}) but now stops on a typed refusal; remove the row`);
    }
    tally.refused++;
    return;
  }

  // It returned. A case that reaches a refusing member, or caught a refusal, must not finish as if nothing happened.
  expect({ backend: 'rust', case: c.name, reachesRefusingMember: refusing.length > 0 && capabilities.size > 0, caughtRefusals: caught })
    .toEqual({ backend: 'rust', case: c.name, reachesRefusingMember: false, caughtRefusals: 0 });
  const missing = c.opts.methods.filter((m) => !c.calls.has(m));
  expect({ backend: 'rust', declaredButNotCalled: missing }).toEqual({ backend: 'rust', declaredButNotCalled: [] });
  const reference = c.reference!;
  let same = true;
  try {
    expect({ backend: 'rust', value: outcome.value }).toEqual({ backend: 'rust', value: reference.value });
  } catch (error) {
    if (!c.divergence) throw error;
    same = false;
  }
  if (!c.divergence) {
    tally.compared++;
    return;
  }
  if (same) {
    throw new Error(`[rust] "${c.name}" has a row in test/rust-expected-divergence/ (${c.divergence.reason}) but now matches ${reference.backend}; remove the row`);
  }
  const normalize = DIVERGENCE_NORMALIZERS[c.divergence.normalizer];
  if (normalize === undefined) throw new Error(`[rust] "${c.name}": the divergence row names the normaliser "${c.divergence.normalizer}", which does not exist`);
  // Different, but only in what the row names: both sides must agree once that is set aside.
  expect({ backend: 'rust', case: c.name, normalizedBy: c.divergence.normalizer, value: normalize(outcome.value) })
    .toEqual({ backend: 'rust', case: c.name, normalizedBy: c.divergence.normalizer, value: normalize(reference.value) });
  tally.diverged++;
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
