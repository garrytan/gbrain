/**
 * The fence restore reads (generations/fence-restore.ts) on PGLite, Postgres and a Rust brain: the recorded fence block
 * of each generation, the item keys each generation still owns, and the live generation id of a key.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: the three statements fence-restore.ts always sent, with the same parameters and byte order, now that they
 *    are engine members (engine-sql/generation-fence-restore.ts), and a Rust brain answers the same walk: a generation
 *    without a recorded fence reads null, a retired item is not owned, the plan revives what only the earlier generation
 *    owned and retires what only the live one owns, and the apply answers `changed` for a stale live id and the refusal
 *    for the current one.
 *  - Regression: the statements went through `executeRaw`, which the Rust engine refuses (`raw_sql`), so `gbrain repair
 *    generations --mode restore` of a fence generation stopped at planFenceRestore on a Rust brain (0120895e02).
 *  - Why existing coverage misses it: the fence restore tests drive the plan on the SQL engines only; this test calls
 *    the fence-restore.ts functions directly on all three.
 *  - Seam: the generations are made with the typed activateGenerationRows member. The PGLite pin wraps
 *    PGLiteEngine.prototype.executeRaw to record each statement and restores it in `finally`. Postgres runs when
 *    DATABASE_URL is set (testBackends) and checks the database name first. The Rust half needs the addon: skipped
 *    without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *  - Not covered: a plan that reaches the page (the walk has no page, so it refuses page_gone; the page reads are typed
 *    members other tests cover) and the write of an approved restore (submitPageMutation).
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { applyFenceRestore, planFenceRestore } from '../src/core/generations/fence-restore.ts';
import { fenceOwnerKey, FACT_FENCE_KIND } from '../src/core/generations/fence.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const postgresRun = testBackends().includes('postgres') ? test : test.skip;

/** The statements fence-restore.ts sent through executeRaw at 0120895e02, plus a byte-order ORDER BY. */
const OLD = {
  blocks: `SELECT id, completeness->'fence' AS fence FROM derived_generations WHERE id = ANY($1::bigint[]) ORDER BY id`,
  owned: `SELECT generation_id, item_key FROM derived_generation_items WHERE generation_id = ANY($1::bigint[]) AND action <> 'retired' ORDER BY generation_id, item_key COLLATE "C"`,
  live: `SELECT id FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`,
};
const NAME = new Map(Object.entries(OLD).map(([name, sql]) => [sql, name]));

const SRC = 'default';
const KEY = { sourceId: SRC, kind: FACT_FENCE_KIND, ownerKey: fenceOwnerKey('fence-restore-walk/alice') };
const BARE = { ...KEY, ownerKey: fenceOwnerKey('fence-restore-walk/bob') };
const ledger = (item_key: string, action: string) => ({ item_key, identity_hash: `id-${item_key}`, action, preimage: null, preimage_bytes: null, pending: false });
const activation = (generation: number, completeness: unknown) => ({ generation, runId: null, operationId: `op-${generation}`, inputPin: `pin-${generation}`,
  inputSize: 1, completeness: JSON.stringify(completeness), setHash: `set-${generation}`, restoreOf: null, activationId: null, locator: null });
const ctxOf = (engine: BrainEngine) => ({ engine, remote: false }) as unknown as OperationContext;

/** The fence restore walk each engine runs; every engine must answer the same EXPECTED. */
async function walk(engine: BrainEngine) {
  const ids = await engine.transaction(async tx => {
    const prev = await tx.activateGenerationRows(KEY, null, activation(1, { complete: true, fence: { body: 'B1', timeline: null } }),
      [ledger('row:a', 'published'), ledger('row:b', 'published')]);
    const live = await tx.activateGenerationRows(KEY, prev, activation(2, { complete: true, fence: { body: 'B2', timeline: 'T2' } }),
      [ledger('row:a', 'kept'), ledger('row:b', 'retired'), ledger('row:c', 'published')]);
    const bare = await tx.activateGenerationRows(BARE, null, activation(1, { complete: true }), [ledger('row:z', 'published')]);
    return { prev, live, bare };
  });
  const name = new Map([[ids.prev, 'prev'], [ids.live, 'live'], [ids.bare, 'bare']]);
  const named = <T extends { id?: number | string; generation_id?: number | string }>(rows: T[]) =>
    rows.map(row => ({ ...row, ...('id' in row ? { id: name.get(Number(row.id)) } : {}),
      ...('generation_id' in row ? { generation_id: name.get(Number(row.generation_id)) } : {}) }));
  // Neither statement has an ORDER BY; the walk compares them in (generation, key) order.
  const order = ['prev', 'live', 'bare'];
  const byId = <T extends { id?: unknown; generation_id?: unknown; item_key?: string }>(rows: T[]) => [...rows].sort((a, b) =>
    order.indexOf(String(a.id ?? a.generation_id)) - order.indexOf(String(b.id ?? b.generation_id)) || String(a.item_key).localeCompare(String(b.item_key)));
  const blocks = byId(named(await engine.readGenerationFenceBlocks([ids.live, ids.prev, ids.bare, ids.live, 987654321])));
  const blocksNone = await engine.readGenerationFenceBlocks([]);
  const owned = byId(named(await engine.listOwnedGenerationItems([ids.bare, ids.live, ids.prev])));
  const liveId = name.get(Number((await engine.readLiveGenerationId(KEY))?.id));
  const liveMissing = await engine.readLiveGenerationId({ ...KEY, ownerKey: fenceOwnerKey('fence-restore-walk/nobody') });
  const plan = await planFenceRestore(engine, KEY, ids.live, ids.prev);
  const planBare = await planFenceRestore(engine, BARE, ids.bare, ids.prev);
  const stale = await applyFenceRestore(ctxOf(engine), KEY, { id: ids.prev, restore_to_id: ids.prev, revive: [], retire: [], refused: [] });
  const applied = await applyFenceRestore(ctxOf(engine), KEY, { id: ids.live, restore_to_id: ids.prev, ...plan });
  return { blocks, blocksNone, owned, liveId, liveMissing, plan, planBare, stale, applied };
}

const EXPECTED: Record<string, unknown> = {
  blocks: [{ id: 'prev', fence: { body: 'B1', timeline: null } }, { id: 'live', fence: { body: 'B2', timeline: 'T2' } }, { id: 'bare', fence: null }],
  blocksNone: [],
  owned: [{ generation_id: 'prev', item_key: 'row:a' }, { generation_id: 'prev', item_key: 'row:b' }, { generation_id: 'live', item_key: 'row:a' },
    { generation_id: 'live', item_key: 'row:c' }, { generation_id: 'bare', item_key: 'row:z' }],
  liveId: 'live',
  liveMissing: null,
  plan: { revive: ['row:b'], retire: ['row:c'], refused: [`${KEY.ownerKey}: page_gone`], content: null, revision: null },
  planBare: { revive: ['row:a', 'row:b'], retire: ['row:z'], refused: [`${BARE.ownerKey}: no_preimage`], content: null, revision: null },
  stale: 'changed',
  applied: [`${KEY.ownerKey}: page_gone`],
};

async function clean(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key LIKE 'page:fence-restore-walk/%'`, [SRC, FACT_FENCE_KIND]);
}

describe('fence restore reads on every engine', () => {
  let pg: PGLiteEngine;
  let pgHome: string;
  const quiet = console.error;

  beforeAll(async () => {
    console.error = () => {};
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-generation-fence-restore-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    console.error = quiet;
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statements fence-restore.ts always sent', async () => {
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
      await planFenceRestore(pg, KEY, 11, 7);
      await applyFenceRestore(ctxOf(pg), KEY, { id: 11, restore_to_id: 7, revive: [], retire: [], refused: [] });
      expect(sent).toEqual([
        { name: 'blocks', params: [[11, 7]] },
        { name: 'owned', params: [[11, 7]] },
        { name: 'live', params: [SRC, FACT_FENCE_KIND, KEY.ownerKey] },
      ]);
    } finally {
      proto.executeRaw = original;
      await clean(pg);
    }
  });

  test('PGLite walks a fence restore', async () => {
    await clean(pg);
    expect(await walk(pg)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
    await clean(pg);
  });

  postgresRun('Postgres walks a fence restore', async () => {
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

  rustRun('Rust walks a fence restore', async () => {
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
