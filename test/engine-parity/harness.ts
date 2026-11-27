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
import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PostgresEngine } from '../../src/core/postgres-engine.ts';
import { enableBeliefLedger } from '../../src/core/belief/coverage.ts';
import type { EngineConfig } from '../../src/core/types.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { resetPgliteState, truncateCascade } from '../helpers/reset-pglite.ts';
import { WRITE_GATE_SCAN_BASELINE_KEY } from '../../src/core/write-gate-schema.ts';
import { disposePersistenceConsumer } from '../../src/core/persistence/service.ts';
import type { TestBackend } from '../helpers/test-backends.ts';
import { armHas, isCapabilityRefusal, missingCapability, type EngineCapability } from './arm-capabilities.ts';
import { checkRustTally } from './rust-tally.ts';
import { itemSetHash } from '../../src/core/generations/publish.ts';
import { IDENTITY_DOWNGRADE_OP } from '../../src/core/persistence/sync-status-sql.ts';
import {
  archiveRustSource, createRustSource, newRustBrain, putRustOpCheckpointRow, rustPageDeletedAt, rustAccessBrain, openRustBrain, DIVERGENCE_NORMALIZERS, readDivergences, removeBrainDir, rustArmRequested, rustMemberCapability, rustRefusal, type DivergenceRow, createRustMember, type MemberSeed,
} from './rust-arm.ts';
import { isEngineMember, readStopPins, refusalFacts, rustServes, rustServesCapability, setupRefusalStep, setupStep, today, type StopPin } from './rust-refusals.ts';

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
  /**
   * A named stop on the Rust arm: the scenario there ends on an error with this `code` that is not a capability
   * refusal (a refusal the store answers by design until a member lands elsewhere). The error must be an Error whose
   * message carries `pin`, which says why, who owns the gap and how to unpin it, and every member in `methods` must
   * have been called first. Counted as stopped. With a pin, the named stop is the only Rust outcome accepted: a case
   * that returns, or ends on a capability refusal, fails until the pin is removed. The SQL arms still compare.
   * One rule for a known Rust stop: a capability refusal uses the in-test pin (assert the refusal, rethrow it; the
   * sweep-reads case is the example); any other refusal code uses `rustStop`. There is no third form.
   */
  rustStop?: { code: string; pin: string };
  /**
   * Rust only: the case ends write_pending because the coordinator refused one typed capability inside the write and
   * released it to queued (the scenario sees no refusal to throw). It counts as stopped only while the case recorded
   * exactly this refusal: `capability`, and `member` as the refusal names it (`member=<member> capability=...`), and
   * `frame` in its stack when given. Any other outcome fails and says to update or remove the pin; `site`, `owner` and
   * `due` name the code and the lane whose fix removes it. PGLite and Postgres ignore it.
   */
  rustPendingStop?: { capability: string; member: string; site: string; frame?: string; owner: string; due: string };
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
      const { engine, databaseUrl, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!, 'instance', 4, { collation: 'en_US' });
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
 * The arm's database is its own (isolatedPersistencePostgres), so every other client transaction on it is work this process
 * started and did not finish: a write the previous case's apply mode left draining, say. Deleting rows under it can
 * deadlock (a reset `DELETE FROM sources` against such work failed a case on CI), so wait for those transactions to end.
 * A transaction still open after the bound is a leak: the reset fails and names it, rather than racing it.
 */
async function waitForOpenTransactions(engine: BrainEngine, timeoutMs = 30_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const open = await engine.executeRaw<{ pid: number; state: string; query: string }>(
      `SELECT pid, state, left(query, 160) AS query FROM pg_stat_activity
        WHERE datname = current_database() AND pid <> pg_backend_pid() AND backend_type = 'client backend' AND xact_start IS NOT NULL`,
    );
    if (open.length === 0) return;
    if (Date.now() > deadline) {
      throw new Error(`parity reset: ${open.length} transaction(s) the previous case left open did not end within ${timeoutMs} ms: `
        + open.map(t => `pid ${t.pid} (${t.state}): ${t.query}`).join('; '));
    }
    await new Promise(resolve => setTimeout(resolve, 25));
  }
}

/**
 * Postgres: the schema's enabled event trigger sends resetPgliteState down its
 * TRUNCATE path (~2.8 s a test). Delete every row under replica role instead
 * (truncateCascade, ~ms); sequences keep counting, so cases never compare ids.
 */
export async function resetPostgres(engine: BrainEngine): Promise<void> {
  await disposePersistenceConsumer(engine);
  await waitForOpenTransactions(engine);
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

/**
 * A fresh SQL brain holds the trust policy generation row its migration seeds (eligibility/generation-schema.ts);
 * the reset empties it like any table, so put the seed back, or `readTrustGeneration` reads a brain no install has.
 */
async function seedTrustPolicyState(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`INSERT INTO trust_policy_state (id) VALUES (1) ON CONFLICT (id) DO NOTHING`);
}

/**
 * Config rows a fresh brain is created with (src/schema.sql seeds them, migration v227 records the write gate's scan
 * baseline; the Rust store writes them on create).
 * The SQL arms' reset empties config, so it puts back what the arm's own fresh brain recorded.
 */
const SEED_CONFIG_KEYS = ['version', 'embedding_model', 'embedding_dimensions', 'chunk_strategy', WRITE_GATE_SCAN_BASELINE_KEY] as const;
const seededConfig = new WeakMap<ParityArm, Array<[string, string]>>();

async function withSeededConfig(arm: ParityArm, reset: () => Promise<void>): Promise<void> {
  let seed = seededConfig.get(arm);
  if (!seed) {
    // The first reset runs on the arm's freshly initialized brain, before any case wrote to it.
    seed = [];
    for (const key of SEED_CONFIG_KEYS) {
      const value = await arm.engine.getConfig(key);
      if (value !== null) seed.push([key, value]);
    }
    seededConfig.set(arm, seed);
  }
  await reset();
  for (const [key, value] of seed) await arm.engine.setConfig(key, value);
}

/**
 * The v322 held flag is a table comment, so the row reset does not clear it: a case that made an owner-only source would
 * leave `gbrain_owner_only_lineage()` true for every later case on the same database, while a reset Rust brain reads false.
 * A reset brain holds no owner-only data, so the comment goes with the rows.
 */
async function clearOwnerOnlyHold(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`COMMENT ON TABLE public.owner_only_marks IS NULL`);
}

/** Return the arm to an empty brain (default source and the seeded config only). Harness-only SQL: cases never use it. */
export async function resetArm(arm: ParityArm): Promise<void> {
  switch (arm.backend) {
    case 'rust':
      await resetRustArm(arm);
      return;
    case 'pglite':
      await withSeededConfig(arm, () => resetPgliteState(arm.engine as PGLiteEngine));
      await clearOwnerOnlyHold(arm.engine);
      await seedTrustPolicyState(arm.engine);
      return;
    case 'postgres':
      await withSeededConfig(arm, () => resetPostgres(arm.engine));
      await clearOwnerOnlyHold(arm.engine);
      await seedTrustPolicyState(arm.engine);
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
async function createSourceImpl(engine: BrainEngine, backend: ParityBackend, id: string, config: Record<string, unknown> = {}, localPath?: string): Promise<void> {
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

/**
 * Fixture: seed an access member (enabled, disabled or removed) with the groups it joins. BrainEngine has no member
 * write in this stack, so the SQL arms insert the rows with harness-only SQL and the Rust arm writes the store's
 * member records. A removed member is disabled too and declares no email and joins no group, as a tombstone leaves it.
 */
export async function createMember(engine: BrainEngine, backend: ParityBackend, seed: MemberSeed): Promise<void> {
  switch (backend) {
    case 'rust':
      await createRustMember(engine, seed);
      return;
    case 'pglite':
    case 'postgres': {
      const removed = seed.state === 'removed';
      await engine.executeRaw(
        `INSERT INTO access_members (id, email, kind, disabled_at, tombstoned_at) VALUES ($1, $2, $3, CASE WHEN $4::boolean THEN now() END, CASE WHEN $5::boolean THEN now() END)`,
        [seed.id, removed ? null : seed.email ?? null, seed.kind ?? 'person', seed.state !== undefined, removed],
      );
      for (const group of removed ? [] : seed.groups ?? []) {
        await engine.executeRaw('INSERT INTO access_groups (id) VALUES ($1) ON CONFLICT (id) DO NOTHING', [group]);
        await engine.executeRaw('INSERT INTO access_group_members (group_id, member_id) VALUES ($1, $2)', [group, seed.id]);
      }
      return;
    }
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: set a page's `updated_at` to an exact microsecond time (`iso`), for cases that need two pages written in the
 * same millisecond. BrainEngine has no write that takes a page time, so the SQL arms set it with harness-only SQL. The
 * Rust store has no such write either: its arm keeps the microsecond time of each write, so a case writes the pages in
 * the order its stamps put them, and the Rust order matches.
 */
export async function stampUpdatedAt(engine: BrainEngine, backend: ParityBackend, sourceId: string, slug: string, iso: string): Promise<void> {
  switch (backend) {
    case 'rust':
      return;
    case 'pglite':
    case 'postgres':
      await engine.executeRaw('UPDATE pages SET updated_at = $3::text::timestamptz WHERE source_id = $1 AND slug = $2', [sourceId, slug, iso]);
      return;
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: write an op checkpoint row stamped `iso`. BrainEngine's checkpoint writes stamp the database clock, so the
 * SQL arms insert the stamp with harness-only SQL. The Rust store stamps each write with its own clock, as in
 * `stampUpdatedAt`: a case writes its rows in the order their stamps put them, and reads a stamp it asserts back through
 * readOpCheckpointRecord rather than comparing it with `iso`.
 */
export async function writeCheckpointAt(engine: BrainEngine, backend: ParityBackend, op: string, fingerprint: string, keys: unknown[], iso: string): Promise<void> {
  switch (backend) {
    case 'rust':
      await engine.writeOpCheckpointRecord(op, fingerprint, keys);
      return;
    case 'pglite':
    case 'postgres':
      await engine.executeRaw('INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, $4::timestamptz)',
        [op, fingerprint, JSON.stringify(keys), iso]);
      return;
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: create a source whose last sync finished at `syncedAt` (ISO, ending in Z). BrainEngine has no typed write
 * of a sync time, so the SQL arms insert it with harness-only SQL and the Rust arm passes it to the store's upsert.
 */
export async function createSyncedSource(engine: BrainEngine, backend: ParityBackend, id: string, config: Record<string, unknown>, syncedAt: string): Promise<void> {
  switch (backend) {
    case 'rust':
      await createRustSource(engine, id, config, undefined, syncedAt);
      return;
    case 'pglite':
    case 'postgres':
      await engine.executeRaw(
        `INSERT INTO sources (id, name, config, last_sync_at) VALUES ($1, $1, $2::text::jsonb, $3::text::timestamptz) ON CONFLICT (id) DO NOTHING`,
        [id, JSON.stringify(config), syncedAt],
      );
      return;
    default:
      return assertNever(backend);
  }
}

/** Fixture: archive a source (BrainEngine has no typed "archive source"). Harness-only SQL, as in `createSource`. */
async function archiveSourceImpl(engine: BrainEngine, backend: ParityBackend, id: string): Promise<void> {
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
async function enableBeliefCoverageImpl(engine: BrainEngine, backend: ParityBackend, sourceId: string): Promise<void> {
  switch (backend) {
    // The Rust arm runs the same production path, a page's baseline included.
    case 'rust':
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
 * source, so the folder-access reads have something to find. The policy writes have no typed member (they stay raw SQL
 * in policy.ts), so this is harness-only SQL behind the backend switch, and the Rust arm writes its store directly.
 */
async function restrictFolderImpl(
  engine: BrainEngine, backend: ParityBackend, sourceId: string, prefix: string, kind: 'rule' | 'pending',
  opts: { ruleId?: string; readers?: string[] } = {},
): Promise<void> {
  const ruleId = opts.ruleId ?? 'parity-rule';
  const readers = opts.readers ?? ['member:parity'];
  switch (backend) {
    case 'rust':
      await seedAccessPolicy(engine, backend, sourceId);
      if (kind === 'rule') {
        await rustAccessBrain(engine).putAccessRule({ source_id: sourceId, rule_id: ruleId, prefix, readable_by: readers, revision: 1 });
      } else {
        await rustAccessBrain(engine).putAccessPendingCoverage({ source_id: sourceId, prefix, reason: 'pending' });
      }
      return;
    case 'pglite':
    case 'postgres':
      await seedAccessPolicy(engine, backend, sourceId);
      if (kind === 'rule') {
        await engine.executeRaw(`INSERT INTO access_rules (source_id, rule_id, prefix, readable_by, revision) VALUES ($1, $2, $3, $4::text[], 1)`, [sourceId, ruleId, prefix, readers]);
      } else {
        await engine.executeRaw(`INSERT INTO access_pending_coverage (source_id, prefix, reason) VALUES ($1, $2, 'pending')`, [sourceId, prefix]);
      }
      return;
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: give a source access state, and record each `revisions` entry as a policy revision (applied or not), so the
 * applied-revision read has something to find. Harness-only SQL behind the backend switch, as in `restrictFolder`.
 */
export async function seedAccessPolicy(
  engine: BrainEngine, backend: ParityBackend, sourceId: string, revisions: ReadonlyArray<{ revision: number; applied: boolean }> = [],
): Promise<void> {
  switch (backend) {
    case 'rust': {
      const brain = rustAccessBrain(engine);
      await brain.putAccessPolicyState(sourceId);
      for (const r of revisions) await brain.putAccessPolicyRevision({ source_id: sourceId, revision: r.revision, applied: r.applied });
      return;
    }
    case 'pglite':
    case 'postgres':
      await engine.executeRaw('INSERT INTO access_policy_state (source_id) VALUES ($1) ON CONFLICT (source_id) DO NOTHING', [sourceId]);
      for (const r of revisions) {
        await engine.executeRaw(
          `INSERT INTO access_policy_revisions (source_id, revision, rules, digest, change_kind, origin, applied_at)
           VALUES ($1, $2, '[]'::jsonb, 'd', 'narrowing', 'parity', ${r.applied ? 'now()' : 'NULL'})`, [sourceId, r.revision]);
      }
      return;
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: store one calibration profile for a holder of the default source, so the calibration admin routes have a
 * profile to read. It writes through the typed `insertCalibrationProfile` (rust-engine/main c1c524c7be), which every
 * engine serves, the Rust store included; the backend argument is kept for the callers.
 */
export async function seedCalibrationProfile(engine: BrainEngine, _backend: ParityBackend, holder: string, patterns: readonly [string, string]): Promise<void> {
  await engine.insertCalibrationProfile({
    sourceId: 'default', holder, generatedAt: new Date('2026-10-01T12:00:00Z'), totalResolved: 6, brier: 0.125, accuracy: 0.75,
    partialRate: 0.25, gradeCompletion: 1, domainScorecards: {}, patternStatements: [patterns[0], patterns[1]], voiceGatePassed: true,
    voiceGateAttempts: 1, activeBiasTags: ['overconfidence'], modelId: 'parity-model',
  });
}

/**
 * Fixture: a `page_purges` tombstone, as the page purge sweep (`persistence/page-purge.ts`) and the restore replay
 * (`belief/purge-mirror.ts`) write it inside the write journal's transaction. Neither has a typed writer, so this is
 * harness-only SQL behind the backend switch; `purgedAt` (ISO) replaces the default `now()`, and `requestId` stamps the
 * purge request the row belongs to. `contentHash` may name several hashes (one row each).
 *
 * Without a `purgedAt` the row goes through the typed `upsertPagePurges`, which every arm serves and stamps `now()`: with a
 * `purgedAt` the Rust arm runs the same SQL and stops on the engine's typed raw_sql refusal.
 */
async function recordPagePurgeImpl(
  engine: BrainEngine, backend: ParityBackend, sourceId: string, slug: string, contentHash: string | string[], purgedAt?: string, requestId: string | null = null,
): Promise<void> {
  const hashes = Array.isArray(contentHash) ? contentHash : [contentHash];
  // Without a stamped time every arm stores the tombstone through the typed `upsertPagePurges` the page purge sweep uses.
  if (purgedAt === undefined) {
    await engine.upsertPagePurges({ sourceId, contentHashes: hashes, slug, requestId });
    return;
  }
  switch (backend) {
    case 'rust':
    // falls through: a stamped time has no Rust writer; the SQL below ends in the typed refusal.
    case 'pglite':
    case 'postgres':
      for (const hash of hashes) {
        await engine.executeRaw(
          'INSERT INTO page_purges (source_id, content_hash, slug, request_id, purged_at) VALUES ($1, $2, $3, $4::uuid, COALESCE($5::timestamptz, now())) ON CONFLICT (source_id, content_hash) DO UPDATE SET slug = EXCLUDED.slug, request_id = EXCLUDED.request_id, purged_at = EXCLUDED.purged_at',
          [sourceId, hash, slug, requestId, purgedAt ?? null]);
      }
      return;
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: a `page_facts_reconcile` watermark row in any state, including ones the typed `settleFactsReconcile` cannot
 * reach (a reconciled revision older than the page, an attempt older than the reconcile). Harness-only SQL behind the
 * backend switch. `reconciled` and `attempted` name the revision each column holds: the page's `current`
 * `knowledge_revision`, an `older` one, or null.
 */
async function recordFactsReconcileImpl(
  engine: BrainEngine, backend: ParityBackend, sourceId: string, slug: string,
  outcome: 'complete' | 'deferred' | 'invalid' | 'cancelled', reconciled: 'current' | 'older' | null, attempted: 'current' | 'older' | null,
): Promise<void> {
  switch (backend) {
    // The Rust store writes the watermark only through settle and drain: the same SQL stops on the engine's typed raw_sql refusal.
    case 'rust':
    case 'pglite':
    case 'postgres':
      await engine.executeRaw(`INSERT INTO page_facts_reconcile (page_id, reconciled_revision, reconciled_at, outcome, attempted_revision, attempted_at)
        SELECT p.id, CASE $3 WHEN 'current' THEN p.knowledge_revision WHEN 'older' THEN $6::uuid END, now(), $5,
               CASE $4 WHEN 'current' THEN p.knowledge_revision WHEN 'older' THEN $6::uuid END, now()
          FROM pages p WHERE p.source_id = $1 AND p.slug = $2`,
        [sourceId, slug, reconciled, attempted, outcome, '00000000-0000-4000-8000-000000000000']);
      return;
    default:
      return assertNever(backend);
  }
}

/**
 * Fixture: a facts-fence generation of page `slug` that retired the fact `factId`, written through the typed ledger
 * writer the fence publish uses (`activateGenerationRows`, generations/publish.ts `activateGeneration`): it
 * supersedes the page's live generation and records one `retired` item whose preimage is the row as it stood, with the
 * completeness and item set hash `publishFenceGeneration` (generations/fence.ts) writes for a fence that parsed empty.
 * `preimage` overrides the preimage fields. `state: 'held'` records the page's held row instead
 * (`recordHeldGenerationRow`, publish.ts `recordHeld`), which, as in production, records no item.
 */
async function recordFenceRetirementImpl(
  engine: BrainEngine, sourceId: string, slug: string, factId: number,
  opts: { fact: string; visibility: string; state?: 'live' | 'held'; generation?: number; preimage?: Record<string, unknown> },
): Promise<void> {
  const key = { sourceId, kind: 'fact_fence', ownerKey: `page:${slug}` };
  const setHash = itemSetHash([]);
  if (opts.state === 'held') {
    const context = { slug, fence: 'facts', writer: 'parity', read: 'absent', rows: 1, partial: false };
    await engine.transaction(tx => tx.recordHeldGenerationRow(key, { holdId: `parity-hold-${factId}`, runId: null, inputPin: null, inputSize: null,
      setHash, reason: 'fence_absent', context: JSON.stringify(context), proposal: '[]', proposalBytes: 2 }));
    return;
  }
  const preimage = { id: factId, fact: opts.fact, visibility: opts.visibility, row_num: 1, expired_at: null, ...opts.preimage };
  const completeness = { complete: true, writer: 'parity', proof: 'fenceParsedEmpty', fence: null, fence_bytes: null };
  await engine.transaction(async tx => {
    const live = await tx.readLiveGenerationRow(key);
    await tx.activateGenerationRows(key, live?.id ?? null, { generation: opts.generation ?? 1, runId: null, operationId: `parity-fence-${factId}`,
      inputPin: null, inputSize: null, completeness: JSON.stringify(completeness), setHash, restoreOf: null, activationId: null, locator: null },
    [{ item_key: `fact:${factId}`, identity_hash: `fact-identity-${factId}`, action: 'retired', preimage,
      preimage_bytes: Buffer.byteLength(JSON.stringify(preimage), 'utf8'), pending: false }]);
  });
}

/**
 * Fixture: an identity-downgrade record (sync-identity-downgrades.ts) for the soft-deleted page `slug` of `sourceId`, keyed
 * by that page's id, as `recordIdentityDowngrades` writes it through executeRaw. `old_deleted_at` is the page's
 * `deleted_at` as the engine keeps it (Postgres text, or the Rust store's ISO form with microseconds) unless `record` replaces it.
 * Harness-only SQL behind the backend switch; the Rust store takes the row through its checkpoint-row primitive.
 * Returns the old page's id.
 */
export async function recordIdentityDowngrade(
  engine: BrainEngine, backend: ParityBackend, sourceId: string, slug: string, record: Record<string, unknown>,
): Promise<number> {
  const origin = await engine.readPageOrigin({ sourceId, slug });
  if (!origin) throw new Error(`recordIdentityDowngrade: no page ${sourceId}/${slug}`);
  const id = Number(origin.id);
  switch (backend) {
    case 'rust': {
      const full = { source_id: sourceId, old_slug: slug, old_page_id: id, old_deleted_at: await rustPageDeletedAt(engine, sourceId, slug), ...record };
      await putRustOpCheckpointRow(engine, IDENTITY_DOWNGRADE_OP, String(id), [full]);
      return id;
    }
    case 'pglite':
    case 'postgres': {
      const [row] = await engine.executeRaw<{ deleted_at: string | null }>('SELECT deleted_at::text AS deleted_at FROM pages WHERE id = $1', [id]);
      const full = { source_id: sourceId, old_slug: slug, old_page_id: id, old_deleted_at: row?.deleted_at ?? null, ...record };
      await engine.executeRaw(`INSERT INTO op_checkpoints (op, fingerprint, completed_keys, updated_at) VALUES ($1, $2, $3::text::jsonb, now())
        ON CONFLICT (op, fingerprint) DO UPDATE SET completed_keys = EXCLUDED.completed_keys, updated_at = now()`,
        [IDENTITY_DOWNGRADE_OP, String(id), JSON.stringify([full])]);
      return id;
    }
    default:
      return assertNever(backend);
  }
}

/**
 * The fixtures above run as setup steps: a typed refusal one raises is tagged (rust-refusals.ts `setupStep`), so the Rust
 * arm fails a case whose setup the engine refused instead of counting it as stopped (checkRustArm).
 */
export const createSource: typeof createSourceImpl = (...args) => setupStep('createSource', () => createSourceImpl(...args));
export const archiveSource: typeof archiveSourceImpl = (...args) => setupStep('archiveSource', () => archiveSourceImpl(...args));
export const enableBeliefCoverage: typeof enableBeliefCoverageImpl = (...args) => setupStep('enableBeliefCoverage', () => enableBeliefCoverageImpl(...args));
export const restrictFolder: typeof restrictFolderImpl = (...args) => setupStep('restrictFolder', () => restrictFolderImpl(...args));
export const recordPagePurge: typeof recordPagePurgeImpl = (...args) => setupStep('recordPagePurge', () => recordPagePurgeImpl(...args));
export const recordFactsReconcile: typeof recordFactsReconcileImpl = (...args) => setupStep('recordFactsReconcile', () => recordFactsReconcileImpl(...args));
export const recordFenceRetirement: typeof recordFenceRetirementImpl = (...args) => setupStep('recordFenceRetirement', () => recordFenceRetirementImpl(...args));

/** Wrap an engine so every direct method call on the handle is recorded. */
function recordingEngine(engine: BrainEngine, calls: Set<string>, refusals: unknown[] = []): BrainEngine {
  return new Proxy(engine, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || typeof prop !== 'string') return value;
      return (...args: unknown[]) => {
        calls.add(prop);
        // The transaction handle is an engine too: record the calls made on it.
        if ((prop === 'transaction' || prop === 'transactionDirect') && typeof args[0] === 'function') {
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

/**
 * Stop the persistence write queue a case started, before the next reset or the arm's close. A write operation starts a
 * consumer keyed on the engine object the case receives (the recording wrapper `given`, which no arm lifecycle or reset
 * knows), and the reset does not stop it: its projection and effect work ran into the next case's reset, a Postgres
 * deadlock on `DELETE FROM sources` in 1 of 10 stress runs of the slug parity file before it stopped the queue by hand.
 * So every case, on every arm, stops the consumer of the wrapper and of the arm's own engine here, in a finally block.
 * Disposing an engine with no consumer does nothing.
 */
async function stopWriteQueue(...engines: BrainEngine[]): Promise<void> {
  let failure: unknown;
  for (const engine of engines) {
    try { await disposePersistenceConsumer(engine); } catch (error) { failure ??= error; }
  }
  if (failure !== undefined) throw failure;
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
  const tally: RustTally = { compared: 0, refused: 0, diverged: 0, stops: [] };
  // Cases this file declared, and the ones the Rust arm skipped on an `n/a` capability (rust-tally.ts).
  let registered = 0;
  let skipped = 0;
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
      // The ledger: each case that stopped, with the member that refused it (the tally above only counts them).
      for (const stop of tally.stops ?? []) console.log(`[rust arm] ${testFile} ${stop.caught ? 'caught (answer equal)' : 'stopped'}: "${stop.name}" on ${stop.member} (${stop.capability})${stop.pinned ? ` pinned until ${stop.pinned.due} (${stop.pinned.owner})` : ''}`);
      const better = checkRustTally(testFile, { ...tally, skipped }, registered);
      if (better !== null) console.log(better);
    }
  }, 60_000);

  function parityTest<T>(name: string, opts: ParityCaseOpts, scenario: ParityScenario<T>): void {
    registered++;
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
        if (!runs && missingCapability(opts.requires!).kind === 'n/a') {
          if (arm.backend === 'rust') skipped++;
          continue;
        }
        // The engine object the scenario receives. Write operations key their persistence consumer on it, so it is the
        // one the harness stops when the case ends (stopWriteQueue).
        const given = recordingEngine(arm.engine, calls, refusals);
        let scenarioFailed = false;
        try {
          if (arm.backend === 'rust') {
            const divergence = readDivergences().find((row) => row.file === testFile && row.name === name);
            const rows = readStopPins().filter((row) => row.file === testFile && row.name === name);
            const pin = rows.find((row) => !row.member.includes('@'));
            const caughtPins = rows.filter((row) => row.member.includes('@'));
            try {
              await checkRustArm({ name, opts, run: () => scenario(given, arm.backend, ctx), calls, refusals,
                reference: results[0], divergence, pin, caughtPins }, tally);
            } finally {
              for (const engine of extra) await engine.disconnect().catch(() => undefined);
            }
            continue;
          }
          let value: T;
          try {
            if (!runs) {
              // The arm lacks a `refuses` capability: the scenario must stop on the typed refusal.
              const refusal = await scenario(given, arm.backend, ctx).then(() => null, (e: unknown) => e);
              expect({ backend: arm.backend, refused: isCapabilityRefusal(refusal, opts.requires!) })
                .toEqual({ backend: arm.backend, refused: true });
              continue;
            }
            value = await scenario(given, arm.backend, ctx);
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
        } catch (error) {
          scenarioFailed = true;
          throw error;
        } finally {
          // A failed stop must not hide the case's own failure; on its own it fails the case.
          await stopWriteQueue(given, arm.engine).catch((error: unknown) => { if (!scenarioFailed) throw error; });
        }
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
export interface RustTally {
  compared: number; refused: number; diverged: number;
  /** The per-case ledger of stopped cases (optional: a caller that only wants the counts leaves it out). */
  stops?: Array<{ name: string; member: string; capability: string; pinned?: StopPin; caught?: true }>;
}

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
  /** The row of test/rust-stop-pins/ for this case, when it has one. */
  pin?: StopPin | undefined;
  /** Rows of test/rust-stop-pins/ for refusals the case catches on its way (member `name@src/...` file). */
  caughtPins?: StopPin[];
}

/** `member@site` of a caught refusal: the member it names and the first src/ file outside the engine that called it. */
export function caughtSite(error: unknown): string {
  const member = refusalFacts(error).member ?? 'unknown';
  const frames = String((error as { stack?: unknown } | null)?.stack ?? '').split('\n');
  for (const frame of frames) {
    const at = /\/(src\/[^\s:()]+\.ts):\d+/.exec(frame);
    if (!at) continue;
    const file = at[1]!;
    if (file.startsWith('src/core/rust-engine') || file === 'src/core/ops/contract.ts' || file === 'src/core/engine-capability-refusal.ts') continue;
    return `${member}@${file}`;
  }
  return `${member}@unknown`;
}

interface RefusalVerdict {
  /** The member the refusal names (or the setup step, or the capability when it names none). */
  member: string;
  capability: string;
  /** Why the refusal fails the case, or null when it is an honest stop on a member the engine does not serve. */
  failure: string | null;
}

/**
 * Decide what a case's terminal typed refusal means (rust-refusals.ts has the rule). A fixture step the case ran in its
 * setup that the engine refused fails the case when every member the case declares is served (the case's own members
 * never ran: a served member went untested); a case that declares a member the engine refuses is a stop anyway. A
 * refusal by a served member (its own option or input) fails the case; so does a step refusal that names a capability the
 * engine reports as served.
 */
function classifyRefusal<T>(c: RustCase<T>, error: unknown): RefusalVerdict {
  const facts = refusalFacts(error);
  const member = facts.member ?? facts.capability ?? 'an unnamed member';
  const capability = facts.capability ?? 'unknown';
  const pinHint = `fix the member, or pin the case in test/rust-stop-pins/<family>.tsv with an owner and a due date (${c.name})`;
  const step = setupRefusalStep(error);
  if (step !== undefined) {
    const declaredServed = c.opts.methods.filter((m) => rustRefusal(m) === null);
    if (declaredServed.length === c.opts.methods.length) {
      return { member, capability, failure: `[rust] "${c.name}": the setup step ${step} was refused (${facts.text ?? member}, capability ${capability}), so the case never reached its own members ` +
        `(${declaredServed.join(', ')}), which the Rust engine serves; ${pinHint}` };
    }
    return { member, capability, failure: null };
  }
  if (facts.member !== null && rustServes(facts.member)) {
    return { member, capability, failure: `[rust] "${c.name}": the Rust engine serves ${facts.member} but it refused (${facts.text}, capability ${capability}); ${pinHint}` };
  }
  if (facts.member !== null && !isEngineMember(facts.member) && facts.capability !== null && rustServesCapability(facts.capability)) {
    return { member, capability, failure: `[rust] "${c.name}": ${facts.text} was refused for capability ${capability}, which the Rust engine reports as served; ${pinHint}` };
  }
  return { member, capability, failure: null };
}

/** A pin must name the member that refused, and must not be past its due date. */
function checkPin<T>(c: RustCase<T>, member: string): void {
  const pin = c.pin!;
  if (pin.member !== member) {
    throw new Error(`[rust] "${c.name}" has a row in test/rust-stop-pins/ for ${pin.member}, but the refusal names ${member}; update the row`);
  }
  if (pin.due < today()) {
    throw new Error(`[rust] "${c.name}": the stop pin for ${pin.member} (${pin.owner}) was due ${pin.due} and has passed (${pin.reason}); fix the member or move the date`);
  }
}

/**
 * The Rust arm's check for one case (rust-arm.ts). A case has exactly three acceptable outcomes on Rust:
 *  - it ends on the typed refusal of a capability it reaches (a member Rust does not serve, or an option a served
 *    member declines), or on the error its `rustStop` pin names: counted as refused. A refusal by a member the engine
 *    serves, or by a fixture step of the case's setup whose own members are all served, fails the case with that member
 *    named, unless the case has a row in test/rust-stop-pins/ (owner and due date): such a row stops the case without
 *    hiding the gap;
 *  - it returns the value the reference arm returned: counted as equal;
 *  - it returns a value that differs from the reference in exactly the way its row in test/rust-expected-divergence/
 *    names (a named normaliser maps both sides to one value, and the raw values must still differ so a stale row
 *    fails): counted as diverged.
 * A case with a `rustPendingStop` pin has one outcome instead: write_pending behind exactly the pinned refusal.
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
  const pin = c.opts.rustStop;
  if (pin !== undefined && pin.pin.trim() === '') throw new Error(`[rust] "${c.name}": its rustStop needs a pin`);
  if (pin?.code === 'engine_capability_missing') {
    throw new Error(`[rust] "${c.name}": a capability refusal takes the in-test pin (assert the refusal, rethrow it), not rustStop`);
  }
  const namedStop = (e: unknown) => pin !== undefined && e instanceof Error
    && (e as { code?: unknown }).code === pin.code && e.message.includes(pin.pin);

  if (pin !== undefined && !('error' in outcome)) {
    throw new Error(`[rust] ${c.name} has a rustStop pin (${pin.code}) but now returns; remove the pin and expect equal`);
  }
  if (pin !== undefined && 'error' in outcome && !namedStop(outcome.error)) {
    const why = refusedBy(outcome.error) ? 'a typed capability refusal' : 'another error';
    if (outcome.error instanceof Error) {
      outcome.error.message = `[rust] ${c.name} has a rustStop pin (${pin.code}) but ended on ${why}: ${outcome.error.message}`;
      throw outcome.error;
    }
    throw new Error(`[rust] ${c.name} has a rustStop pin (${pin.code}) but ended on ${why}`);
  }

  const pendingPin = c.opts.rustPendingStop;
  const pinText = pendingPin && `${pendingPin.capability} at ${pendingPin.member} (${pendingPin.site}); owner ${pendingPin.owner}, due ${pendingPin.due}`;
  if ('error' in outcome) {
    if (pendingPin && !refusedBy(outcome.error)) {
      checkPendingStop(c.name, pendingPin, pinText!, outcome.error, c.refusals);
      tally.refused++;
      return;
    }
    if (pendingPin) throw new Error(`[rust] "${c.name}" now throws a typed refusal, not write_pending; update or remove its rustPendingStop pin (${pinText})`);
    // Only the terminal outcome counts: a refusal caught earlier does not excuse a different failure.
    if (!refusedBy(outcome.error) && !namedStop(outcome.error)) {
      if (outcome.error instanceof Error) {
        outcome.error.message = `[rust] ${outcome.error.message}${caught > 0 ? ` (the case had caught ${caught} typed refusal(s) before this)` : ''}`;
      }
      throw outcome.error;
    }
    if (pin !== undefined) {
      // A named stop comes after the members the case covers: each must have been called before it.
      const notReached = c.opts.methods.filter((m) => !c.calls.has(m));
      expect({ backend: 'rust', case: c.name, rustStop: pin.code, declaredButNotCalled: notReached })
        .toEqual({ backend: 'rust', case: c.name, rustStop: pin.code, declaredButNotCalled: [] });
    }
    if (c.divergence) {
      throw new Error(`[rust] "${c.name}" has a row in test/rust-expected-divergence/ (${c.divergence.reason}) but now stops on a typed refusal; remove the row`);
    }
    const stop = classifyRefusal(c, outcome.error);
    if (stop.failure !== null) {
      if (c.pin === undefined) throw new Error(stop.failure);
      checkPin(c, stop.member);
    } else if (c.pin !== undefined) {
      throw new Error(`[rust] "${c.name}" has a row in test/rust-stop-pins/ (${c.pin.owner}, due ${c.pin.due}) but its refusal (${stop.member}) is no longer one the pin covers; remove the row`);
    }
    tally.refused++;
    tally.stops?.push({ name: c.name, member: stop.member, capability: stop.capability, ...(stop.failure !== null ? { pinned: c.pin! } : {}) });
    return;
  }
  if (c.pin !== undefined) {
    throw new Error(`[rust] "${c.name}" has a row in test/rust-stop-pins/ (${c.pin.owner}, due ${c.pin.due}) but the case no longer stops on a refusal; remove the row`);
  }

  if (pendingPin) throw new Error(`[rust] "${c.name}" no longer stops; remove its rustPendingStop pin (${pinText})`);
  // It returned. A case that reaches a refusing member, or caught a refusal, must not finish as if nothing happened,
  // unless every refusal it caught is pinned by member and calling file (test/rust-stop-pins/, owner and due date).
  const caughtPins = c.caughtPins ?? [];
  const sites = c.refusals.filter(refusedBy).map(caughtSite);
  const unpinned = sites.filter((site) => !caughtPins.some((p) => p.member === site));
  for (const p of caughtPins) {
    if (p.due < today()) throw new Error(`[rust] "${c.name}": the stop pin for ${p.member} (${p.owner}) was due ${p.due} and has passed (${p.reason}); fix the member or move the date`);
    if (!sites.includes(p.member)) throw new Error(`[rust] "${c.name}" has a row in test/rust-stop-pins/ for ${p.member} (${p.owner}, due ${p.due}) but no longer catches ${p.member}; remove the row`);
  }
  const pinnedMembers = new Set(caughtPins.map((p) => p.member.split('@')[0]!));
  const stillRefusing = refusing.filter((m) => !pinnedMembers.has(m));
  expect({ backend: 'rust', case: c.name, reachesRefusingMember: stillRefusing.length > 0 && capabilities.size > 0, caughtRefusals: unpinned.length, unpinned: [...new Set(unpinned)] })
    .toEqual({ backend: 'rust', case: c.name, reachesRefusingMember: false, caughtRefusals: 0, unpinned: [] });
  for (const p of caughtPins) tally.stops?.push({ name: c.name, member: p.member, capability: refusalFacts(c.refusals.find((e) => caughtSite(e) === p.member)).capability ?? 'unknown', pinned: p, caught: true });
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

/** A pinned Rust case passes only when it ended write_pending and recorded exactly the pinned typed refusal. */
function checkPendingStop(name: string, pin: NonNullable<ParityCaseOpts['rustPendingStop']>, pinText: string, error: unknown,
  refusals: unknown[]): void {
  const message = String((error as Error | null)?.message ?? error);
  const detail = (e: unknown) => String((e as { detail?: unknown } | null)?.detail ?? '');
  const named = refusals.some((e) => isCapabilityRefusal(e, pin.capability as EngineCapability) && detail(e).includes(`member=${pin.member} capability=${pin.capability}`)
    && (pin.frame === undefined || String((e as Error).stack ?? '').includes(pin.frame)));
  if (message.includes('write_pending') && named) return;
  throw new Error(`[rust] "${name}" does not stop as its rustPendingStop pin says (${pinText}); update or remove the pin. `
    + `write_pending: ${message.includes('write_pending')}; typed refusals: ${JSON.stringify([...new Set(refusals.map(detail))])}; error: ${message}`);
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
