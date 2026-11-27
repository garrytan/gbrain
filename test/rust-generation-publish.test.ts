/**
 * A whole publishGeneration (generations/publish.ts) on PGLite, Postgres and a Rust brain: the attempt counter, the
 * identical-replay select, the valve read and bump, the exhausted-hold read and heldForInput as typed engine members.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: the seven reads and writes send the statements publish.ts always sent, byte for byte, now that each is an
 *    engine member (engine-sql/derived-generations.ts), and a Rust brain answers the same walk: generation 1 then 2, an
 *    identical replay answers `unchanged` without a new generation, a retirement adds to the run's valve window and a
 *    later retirement past `generations.valve.max_per_run` holds `valve`, heldForInput sees that hold, three failed
 *    publications of one result hold it `attempts_exhausted` with their codes and the fourth stops there, and an
 *    activation deletes the key's attempt counters.
 *  - Regression: the statements went through `executeRaw`, which the Rust engine refuses (`raw_sql`), so every
 *    publishGeneration stopped at its first ledger read on a Rust brain (1a6511788d), and a failed publication was not
 *    counted there either.
 *  - Why existing coverage misses it: test/rust-derived-generations.test.ts walks publishFenceGeneration, which never
 *    calls these seven, and test/pathological/g1-*.test.ts runs the SQL engines only, through a page adapter whose reads
 *    are raw SQL.
 *  - Seam: an in-memory adapter (a Map of items per test) stands in for the item store, so only the ledger runs on the
 *    engine; its publishItems throws on request. The PGLite pin wraps PGLiteEngine.prototype.executeRaw to record each
 *    statement and restores it in `finally`. Postgres runs when DATABASE_URL is set (testBackends) and checks the database
 *    name first. The Rust half needs the addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *  - Not covered: the fact rows adapter's preimage read, which still reads through
 *    `executeRaw` (TODOS.md); the fence evidence and restore reads have their own
 *    three-engine walks (test/rust-generation-fence-evidence.test.ts,
 *    test/rust-generation-fence-restore.test.ts).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { GenerationAdapter, GenerationKey, ItemRow, ProposedItem } from '../src/core/generations/contract.ts';
import { heldForInput, publishGeneration, readValve, type PublishRequest } from '../src/core/generations/publish.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const postgresRun = testBackends().includes('postgres') ? test : test.skip;

const KEY: GenerationKey = { kind: 'publish_walk', sourceId: 'default', ownerKey: 'input:walk' };
const INPUT = { pin: 'pin-1', size: 100 };
const VALVE_KEY = 'generations.valve.max_per_run';

/** The statements publish.ts sent through executeRaw at 1a6511788d, byte for byte. */
const OLD = {
  heldForInput: `SELECT hold_id, item_set_hash, held_reason FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND input_pin=$4`,
  attemptUpsert: `INSERT INTO derived_generation_attempts (hold_id, source_id, kind, owner_key, attempts, codes) VALUES ($1,$2,$3,$4,1,jsonb_build_array($5::text))
       ON CONFLICT (hold_id) DO UPDATE SET attempts=derived_generation_attempts.attempts+1, codes=derived_generation_attempts.codes || jsonb_build_array($5::text), updated_at=now()
       RETURNING attempts, codes`,
  attemptDelete: `DELETE FROM derived_generation_attempts WHERE hold_id=$1`,
  heldContext: `SELECT held_context FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND hold_id=$4`,
  replay: `SELECT generation FROM derived_generations WHERE operation_id=$1 AND state = 'live'`,
  valveRead: `SELECT (SELECT retired FROM derived_generation_valve WHERE source_id=$1 AND kind=$2 AND window_key=$3) AS retired,
            (SELECT count(*)::int FROM derived_generation_items i JOIN derived_generations g ON g.id=i.generation_id
              WHERE g.source_id=$1 AND g.kind=$2 AND g.state='live' AND i.action IN ('published','kept','adopted','revived')) AS owned`,
  valveBump: `INSERT INTO derived_generation_valve (source_id, kind, window_key, retired) VALUES ($1,$2,$3,$4)
    ON CONFLICT (source_id, kind, window_key) DO UPDATE SET retired=derived_generation_valve.retired+EXCLUDED.retired, updated_at=now()`,
};
const NAME = new Map(Object.entries(OLD).map(([name, sql]) => [sql, name]));

/** A test-local item store: the adapter keeps items in a Map, so only the ledger runs on the engine. */
function memoryAdapter() {
  const items = new Map<string, { identityHash: string; live: boolean }>();
  const failing = { code: null as string | null };
  const row = (key: string): ItemRow => {
    const item = items.get(key)!;
    return { key, identityHash: item.identityHash, live: item.live, owned: true, segmented: false,
      preimage: () => ({ json: { key, identityHash: item.identityHash }, bytes: 32 }) };
  };
  const adapter: GenerationAdapter<undefined> = {
    kind: KEY.kind, retiredBy: 'projection' as GenerationAdapter['retiredBy'], modelProduced: false,
    lockKeys: () => [],
    readInput: async () => INPUT,
    readItems: async (_db, _key, itemKeys) => new Map([...new Set([...itemKeys, ...[...items].filter(([, i]) => i.live).map(([k]) => k)])]
      .filter(key => items.has(key)).map(key => [key, row(key)])),
    legacyEvidence: async () => new Set<string>(),
    publishItems: async (_tx, _key, puts: readonly ProposedItem[]) => {
      if (failing.code) throw Object.assign(new Error(`publish failed: ${failing.code}`), { code: failing.code });
      for (const item of puts) items.set(item.key, { identityHash: item.identityHash, live: true });
    },
    retireItems: async (_tx, _key, keys) => { for (const key of keys) items.get(key)!.live = false; },
    restoreItem: async () => {},
    preimageIdentity: preimage => String(preimage.identityHash),
  };
  return { adapter, items, failing };
}

const request = (keys: string[]): PublishRequest<undefined> => ({ key: KEY, items: keys.map(key => ({ key, content: key, identityHash: key })),
  input: INPUT, runId: 'r1' });

const brief = (outcome: Awaited<ReturnType<typeof publishGeneration>>) => {
  const o = outcome as Record<string, unknown>;
  return o.state === 'held' ? { state: o.state, reason: o.reason, context: (o.reason === 'attempts_exhausted' ? o.context : undefined) }
    : { state: o.state, generation: o.generation, retired: o.retired };
};

/** The publication walk each engine runs; every engine must answer the same EXPECTED. */
async function walk(engine: BrainEngine) {
  const { adapter, failing } = memoryAdapter();
  const first = brief(await publishGeneration(engine, adapter, request(['a', 'b', 'c'])));
  const replay = brief(await publishGeneration(engine, adapter, request(['a', 'b', 'c'])));
  const second = brief(await publishGeneration(engine, adapter, request(['a', 'b'])));
  const valve = await readValve(engine, KEY, 'r1');
  const otherWindow = await readValve(engine, KEY, 'r2');
  await engine.setConfig(VALVE_KEY, '1');
  const valveHold = brief(await publishGeneration(engine, adapter, request(['a'])));
  const heldNow = await heldForInput(engine, KEY, INPUT.pin);
  const heldOtherPin = await heldForInput(engine, KEY, 'pin-2');
  await engine.unsetConfig(VALVE_KEY);
  failing.code = 'boom';
  const failures: string[] = [];
  for (let i = 0; i < 3; i++) {
    failures.push(await publishGeneration(engine, adapter, request(['a', 'b', 'd'])).then(() => 'published', (e: { code?: string }) => String(e.code)));
  }
  failing.code = null;
  const stopped = brief(await publishGeneration(engine, adapter, request(['a', 'b', 'd'])));
  // A counter of this key before an activation, and the same counter after it: the activation deleted it.
  const probeBefore = await engine.countGenerationAttempt(KEY, 'probe', 'x');
  const third = brief(await publishGeneration(engine, adapter, request(['a', 'b', 'e'])));
  const probeAfter = await engine.countGenerationAttempt(KEY, 'probe', 'y');
  await engine.clearGenerationAttempts('probe');
  const probeCleared = await engine.countGenerationAttempt(KEY, 'probe', 'z');
  await engine.clearGenerationAttempts('probe');
  return { first, replay, second, valve, otherWindow, valveHold, heldNow, heldOtherPin, failures, stopped, probeBefore, third, probeAfter, probeCleared,
    replayOfFirst: await engine.liveGenerationForOperation('no-such-operation') };
}

const EXPECTED: Record<string, unknown> = {
  first: { state: 'published', generation: 1, retired: [] },
  replay: { state: 'unchanged', generation: 1, retired: [] },
  second: { state: 'published', generation: 2, retired: ['c'] },
  valve: { windowRetired: 1, ownedTotal: 2 },
  otherWindow: { windowRetired: 0, ownedTotal: 2 },
  valveHold: { state: 'held', reason: 'valve', context: undefined },
  heldNow: true,
  heldOtherPin: false,
  failures: ['boom', 'boom', 'boom'],
  stopped: { state: 'held', reason: 'attempts_exhausted', context: { attempts: 3, codes: ['boom', 'boom', 'boom'], partial: false } },
  probeBefore: { attempts: 1, codes: ['x'] },
  third: { state: 'published', generation: 3, retired: [] },
  probeAfter: { attempts: 1, codes: ['y'] },
  probeCleared: { attempts: 1, codes: ['z'] },
  replayOfFirst: null,
};

async function clean(engine: BrainEngine): Promise<void> {
  await engine.unsetConfig(VALVE_KEY).catch(() => {});
  await engine.executeRaw(`DELETE FROM derived_generation_attempts WHERE source_id=$1 AND kind=$2`, [KEY.sourceId, KEY.kind]);
  await engine.executeRaw(`DELETE FROM derived_generation_valve WHERE source_id=$1 AND kind=$2`, [KEY.sourceId, KEY.kind]);
  await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2`, [KEY.sourceId, KEY.kind]);
}

describe('publishGeneration on every engine', () => {
  let pg: PGLiteEngine;
  let pgHome: string;
  const quiet = console.error;

  beforeAll(async () => {
    console.error = () => {};
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-generation-publish-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    console.error = quiet;
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statements publish.ts always sent', async () => {
    await clean(pg);
    const sent: Array<{ name: string; params: unknown[] | undefined }> = [];
    const proto = PGLiteEngine.prototype as unknown as { executeRaw: BrainEngine['executeRaw'] };
    const original = proto.executeRaw;
    proto.executeRaw = async function (this: BrainEngine, sql: string, params?: unknown[]) {
      const name = NAME.get(sql);
      if (name) sent.push({ name, params });
      return original.call(this, sql, params);
    } as BrainEngine['executeRaw'];
    try {
      const { adapter, failing } = memoryAdapter();
      const k = [KEY.sourceId, KEY.kind, KEY.ownerKey];
      await publishGeneration(pg, adapter, request(['a', 'b', 'c']));
      expect(sent.map(s => s.name)).toEqual(['heldContext', 'replay', 'valveRead']);
      expect(sent[0]!.params!.slice(0, 3)).toEqual(k);
      expect(sent[2]!.params).toEqual([KEY.sourceId, KEY.kind, 'run:r1']);
      const operation = sent[1]!.params![0];

      sent.length = 0;
      await publishGeneration(pg, adapter, request(['a', 'b', 'c']));
      expect(sent.map(s => s.name)).toEqual(['heldContext', 'replay']);
      expect(sent[1]!.params).toEqual([operation]);

      sent.length = 0;
      await publishGeneration(pg, adapter, request(['a', 'b']));
      expect(sent.map(s => s.name)).toEqual(['heldContext', 'replay', 'valveRead', 'valveBump']);
      expect(sent[3]!.params).toEqual([KEY.sourceId, KEY.kind, 'run:r1', 1]);

      sent.length = 0;
      failing.code = 'boom';
      for (let i = 0; i < 3; i++) await publishGeneration(pg, adapter, request(['a', 'b', 'd'])).catch(() => {});
      failing.code = null;
      expect(sent.map(s => s.name)).toEqual(['heldContext', 'replay', 'valveRead', 'attemptUpsert', 'heldContext', 'replay', 'valveRead', 'attemptUpsert',
        'heldContext', 'replay', 'valveRead', 'attemptUpsert', 'attemptDelete']);
      const hold = sent[3]!.params![0];
      expect(sent[3]!.params).toEqual([hold, ...k, 'boom']);
      expect(sent[12]!.params).toEqual([hold]);
      expect(sent[8]!.params).toEqual([...k, hold]);

      sent.length = 0;
      expect(await heldForInput(pg, KEY, INPUT.pin)).toBe(true);
      expect(sent.map(s => s.name)).toEqual(['heldForInput']);
      expect(sent[0]!.params).toEqual([...k, INPUT.pin]);
    } finally {
      proto.executeRaw = original;
      await clean(pg);
    }
  });

  test('PGLite walks a publication', async () => {
    await clean(pg);
    expect(await walk(pg)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    await clean(pg);
  });

  postgresRun('Postgres walks a publication', async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL!, poolSize: 4 } as never);
    try {
      await engine.initSchema();
      await clean(engine);
      expect(await walk(engine)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    } finally {
      await clean(engine).catch(() => {});
      await engine.disconnect();
    }
  }, 60_000);

  rustRun('Rust walks a publication', async () => {
    const brain = await openRustBrain();
    const engine = brain.engine as unknown as BrainEngine;
    try {
      expect(await walk(engine)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    } finally {
      await engine.disconnect().catch(() => {});
      removeBrainDir(brain.dir);
    }
  }, 60_000);
});
