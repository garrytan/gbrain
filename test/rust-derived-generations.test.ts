/**
 * The derived generation ledger of generations/publish.ts (readLiveGeneration, activateGeneration, recordHeld) as typed
 * engine members, on PGLite, Postgres and a Rust brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: the three functions send the statements they always sent, in byte order, now that each is an engine
 *    member (engine-sql/derived-generations.ts), and a Rust brain keeps the same ledger: a fence publish activates
 *    generation 1 and then 2, a result that may not publish keeps one held row (the same hold counts an attempt, another
 *    hold replaces it), and of two writers of one key only the first sees and clears the held row. A throw after the
 *    activation leaves the old live generation.
 *  - Regression: the statements went through `executeRaw`, which the Rust engine refuses, so every fence publish (a
 *    forget, a put_page, a sync) stopped at readLiveGeneration on a Rust brain, and the Rust store held no held rows: its
 *    two writers saw [0, 0] where PGLite and Postgres see [1, 0].
 *  - Why existing coverage misses it: test/rust-fence-generations.test.ts pins fence.ts's own statements, and
 *    test/pathological/g2-fence-generations.test.ts runs the SQL engines only.
 *  - Seam: the transaction engine's own executeRaw (PGLite) is wrapped to record each statement and restored with
 *    `delete`; nothing else is replaced. Postgres runs when DATABASE_URL is set (testBackends) and checks the database
 *    name first. The Rust half needs the addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *  - Not covered: publishGeneration's attempt counter, replay select, valve and exhausted-hold reads, which
 *    test/rust-generation-publish.test.ts pins.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { clearFenceHold, fenceOwnerKey, fenceReadOf, publishFenceGeneration, FACT_FENCE_KIND, FENCE_GENERATION_KINDS, type FenceGenerationKind } from '../src/core/generations/fence.ts';
import { generationKeyLock, readLiveGeneration } from '../src/core/generations/publish.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const postgresRun = testBackends().includes('postgres') ? test : test.skip;

const SLUG = 'people/charlie-example';
const KEY: { kind: FenceGenerationKind; sourceId: string; ownerKey: string } = { kind: FACT_FENCE_KIND, sourceId: 'default', ownerKey: fenceOwnerKey(SLUG) };

/** The statements publish.ts has always sent through executeRaw (73d950614e), plus a byte-order ORDER BY. */
const OLD = {
  liveRow: `SELECT id, generation, input_pin, input_size, locator FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='live'`,
  liveItems: `SELECT item_key, identity_hash FROM derived_generation_items WHERE generation_id=$1 AND action IN ('published','kept','adopted','revived') ORDER BY item_key COLLATE "C"`,
  supersede: `UPDATE derived_generations SET state='superseded', updated_at=now() WHERE id=$1 AND state='live'`,
  activate: `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, run_id, operation_id, input_pin, input_size, completeness, item_set_hash, restore_of,
       activation_id, locator)
     VALUES ($1,$2,$3,$4,'live',$5,$6,$7,$8,$9::text::jsonb,$10,$11,$12,$13) RETURNING id`,
  supersededBy: `UPDATE derived_generations SET superseded_by=$1 WHERE id=$2`,
  ledgerItems: `INSERT INTO derived_generation_items (generation_id, item_key, identity_hash, action, preimage, preimage_bytes, pending)
      SELECT $1, i.item_key, i.identity_hash, i.action, i.preimage, i.preimage_bytes, i.pending
      FROM jsonb_to_recordset($2::text::jsonb) AS i(item_key text, identity_hash text, action text, preimage jsonb, preimage_bytes integer, pending boolean)`,
  clearHeld: `WITH held AS (DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' RETURNING 1)
    DELETE FROM derived_generation_attempts WHERE source_id=$1 AND kind=$2 AND owner_key=$3`,
  heldRow: `SELECT id, hold_id FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held'`,
  bumpAttempts: 'UPDATE derived_generations SET attempts=attempts+1, updated_at=now() WHERE id=$1',
  deleteRow: 'DELETE FROM derived_generations WHERE id=$1',
  insertHeld: `INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, run_id, operation_id, hold_id, input_pin, input_size, item_set_hash,
       held_reason, held_context, proposal, proposal_bytes, attempts)
     VALUES ($1,$2,$3,0,'held',$4,$5,$6,$7,$8,$9,$10,$11::text::jsonb,$12::text::jsonb,$13,1)`,
};
const NAME = new Map(Object.entries(OLD).map(([name, sql]) => [sql, name]));

const publish = (engine: BrainEngine, rows: string[]) => engine.transaction(tx => publishFenceGeneration(tx, { ...KEY, slug: SLUG,
  read: fenceReadOf({ body: `## Facts\n${rows.join('\n')}`, timeline: null }), items: rows.map(row => ({ key: `row:${row}`, identityHash: row })),
  retire: [], writer: 'projection' }));
/** The page is live, so `originGone` has no proof: the result holds `no_proof`. `rows` changes the hold's item set. */
const holdNoProof = (engine: BrainEngine, rows: string[]) => engine.transaction(tx => publishFenceGeneration(tx, { ...KEY, slug: SLUG,
  read: fenceReadOf({ body: null, timeline: null }), items: rows.map(row => ({ key: `row:${row}`, identityHash: row })),
  retire: [{ key: 'row:a', identityHash: 'a' }], originGone: true, writer: 'deleted_page' }));
const live = async (engine: BrainEngine) => {
  const row = await readLiveGeneration(engine, KEY);
  return row && { generation: row.generation, items: Object.fromEntries([...row.items].sort()) };
};
const heldCount = async (engine: BrainEngine) => (await engine.listFenceHoldRows([KEY.sourceId], FENCE_GENERATION_KINDS, KEY.ownerKey)).length;

/** Two writers of KEY: A takes the key lock and waits; B starts while A holds it. Each counts the held rows it sees, then clears them. */
async function twoWriters(engine: BrainEngine): Promise<[number, number]> {
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let aLocked!: () => void;
  const lockedA = new Promise<void>(resolve => { aLocked = resolve; });
  const writer = (hold: Promise<void> | null) => engine.transaction(async tx => {
    await tx.lockGenerationKey(generationKeyLock(KEY));
    if (hold) { aLocked(); await hold; }
    const seen = (await tx.listFenceHoldRows([KEY.sourceId], FENCE_GENERATION_KINDS, KEY.ownerKey)).length;
    await clearFenceHold(tx, KEY);
    return seen;
  });
  const a = writer(released);
  await lockedA;
  const b = writer(null);
  await new Promise(resolve => setTimeout(resolve, 250));
  release();
  return await Promise.all([a, b]) as [number, number];
}

/** The ledger walk each engine runs; every engine must answer the same EXPECTED. */
async function walk(engine: BrainEngine) {
  await engine.putPage(SLUG, { type: 'person', title: 'Charlie', compiled_truth: 'body' });
  const first = await publish(engine, ['a']);
  const second = await publish(engine, ['a', 'b']);
  const afterPublish = await live(engine);
  const held = await holdNoProof(engine, []);
  const sameHold = await holdNoProof(engine, []);
  const otherHold = await holdNoProof(engine, ['c']);
  const heldRows = await heldCount(engine);
  const writers = await twoWriters(engine);
  // A throw after the activation inside the caller's transaction leaves generation 2 live.
  const thrown = await engine.transaction(async tx => {
    await publishFenceGeneration(tx, { ...KEY, slug: SLUG, read: fenceReadOf({ body: '## Facts\nz', timeline: null }), items: [{ key: 'row:z', identityHash: 'z' }],
      retire: [], writer: 'projection' });
    throw new Error('after activate');
  }).then(() => 'committed', (e: Error) => e.message);
  const afterThrow = await live(engine);
  // A new held row, then a publish: the activation answers the hold.
  await holdNoProof(engine, []);
  const heldBeforeThird = await heldCount(engine);
  const third = await publish(engine, ['b']);
  return { first, second, afterPublish, held: held.state, sameHoldId: (sameHold as { holdId?: string }).holdId === (held as { holdId?: string }).holdId,
    otherHoldId: (otherHold as { holdId?: string }).holdId !== (held as { holdId?: string }).holdId, heldRows, writers, thrown,
    afterThrow, heldBeforeThird, third, heldAfterThird: await heldCount(engine), afterThird: await live(engine) };
}

const EXPECTED: Record<string, unknown> = {
  first: { state: 'published', generation: 1 },
  second: { state: 'published', generation: 2 },
  afterPublish: { generation: 2, items: { 'row:a': 'a', 'row:b': 'b' } },
  held: 'held', sameHoldId: true, otherHoldId: true, heldRows: 1,
  writers: [1, 0],
  thrown: 'after activate',
  afterThrow: { generation: 2, items: { 'row:a': 'a', 'row:b': 'b' } },
  heldBeforeThird: 1,
  third: { state: 'published', generation: 3 },
  heldAfterThird: 0,
  afterThird: { generation: 3, items: { 'row:b': 'b' } },
};

async function clean(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3`, [KEY.sourceId, KEY.kind, KEY.ownerKey]);
}

describe('derived generation ledger', () => {
  let pg: PGLiteEngine;
  let pgHome: string;

  beforeAll(async () => {
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-derived-generations-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statements publish.ts always sent', async () => {
    await pg.putPage(SLUG, { type: 'person', title: 'Charlie', compiled_truth: 'body' });
    const sent: Array<{ name: string; params: unknown[] | undefined }> = [];
    // Each transaction engine records on itself and is restored with `delete`: the base engine is never wrapped.
    const recorded = <T>(work: (tx: BrainEngine) => Promise<T>) => pg.transaction(async tx => {
      const original = tx.executeRaw.bind(tx);
      tx.executeRaw = (async (sql: string, params?: unknown[]) => {
        const name = NAME.get(sql);
        if (name) sent.push({ name, params });
        return original(sql, params);
      }) as typeof tx.executeRaw;
      try { return await work(tx); } finally { delete (tx as { executeRaw?: unknown }).executeRaw; }
    });
    const fence = (rows: string[]) => (tx: BrainEngine) => publishFenceGeneration(tx, { ...KEY, slug: SLUG,
      read: fenceReadOf({ body: `## Facts\n${rows.join('\n')}`, timeline: null }), items: rows.map(row => ({ key: `row:${row}`, identityHash: row })), retire: [], writer: 'projection' });
    const noProof = (rows: string[]) => (tx: BrainEngine) => publishFenceGeneration(tx, { ...KEY, slug: SLUG, read: fenceReadOf({ body: null, timeline: null }),
      items: rows.map(row => ({ key: `row:${row}`, identityHash: row })), retire: [{ key: 'row:a', identityHash: 'a' }], originGone: true, writer: 'deleted_page' });
    const k = [KEY.sourceId, KEY.kind, KEY.ownerKey];

    await recorded(fence(['a']));
    const one = (await readLiveGeneration(pg, KEY))!;
    expect(sent.map(s => s.name)).toEqual(['liveRow', 'activate', 'ledgerItems', 'clearHeld']);
    expect(sent[0]!.params).toEqual(k);
    expect(sent[1]!.params!.slice(0, 4)).toEqual([...k, 1]);
    expect(sent[2]!.params).toEqual([one.id, JSON.stringify([{ item_key: 'row:a', identity_hash: 'a', action: 'published', preimage: null, preimage_bytes: null, pending: false }])]);
    expect(sent[3]!.params).toEqual(k);

    sent.length = 0;
    await recorded(fence(['a', 'b']));
    const two = (await readLiveGeneration(pg, KEY))!;
    expect(sent.map(s => s.name)).toEqual(['liveRow', 'liveItems', 'supersede', 'activate', 'supersededBy', 'ledgerItems', 'clearHeld']);
    expect(sent[1]!.params).toEqual([one.id]);
    expect(sent[2]!.params).toEqual([one.id]);
    expect(sent[4]!.params).toEqual([two.id, one.id]);

    sent.length = 0;
    const held = await recorded(noProof([])) as { holdId: string };
    await recorded(noProof([]));
    await recorded(noProof(['c']));
    expect(sent.map(s => s.name)).toEqual(['liveRow', 'liveItems', 'heldRow', 'insertHeld', 'liveRow', 'liveItems', 'heldRow', 'bumpAttempts',
      'liveRow', 'liveItems', 'heldRow', 'deleteRow', 'insertHeld']);
    expect(sent[3]!.params!.slice(0, 6)).toEqual([...k, null, `held:${held.holdId}`, held.holdId]);
    expect(sent[3]!.params![9]).toBe('no_proof');
    expect(JSON.parse(sent[3]!.params![10] as string)).toMatchObject({ slug: SLUG, writer: 'deleted_page', rows: 1, partial: false });
    expect(sent[3]!.params!.slice(11)).toEqual(['[]', 2]);
    await clean(pg);
    await pg.deletePage(SLUG).catch(() => {});
  });

  test('PGLite walks the ledger', async () => {
    await clean(pg);
    expect(await walk(pg)).toEqual(EXPECTED as Awaited<ReturnType<typeof walk>>);
  });

  postgresRun('Postgres walks the ledger', async () => {
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

  rustRun('Rust walks the ledger', async () => {
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
