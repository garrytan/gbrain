/**
 * The fence generation statements (generations/fence.ts) as typed engine members, on PGLite, Postgres and a Rust brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: publishFenceGeneration, clearFenceHold and fenceHoldEntries send the statements they always sent, byte
 *    for byte, now that each is an engine member (engine-sql/fence-holds.ts). The generation key lock still makes two
 *    writers of one key run one after the other, so only one of them sees and clears a held row; on a Rust brain the
 *    store's writer gate does the same, and a fence publish there runs to the end without a raw statement.
 *  - Regression: the four statements went through `executeRaw`, which the Rust engine refuses, so a fence publish (the
 *    projection a forget, a put_page or a sync runs), a readable fence clearing its hold, and the held list's file read
 *    all stopped at fence.ts on a Rust brain.
 *  - Why existing coverage misses it: test/pathological/g2-fence-generations.test.ts runs the SQL engines only, and the
 *    parity cases in test/engine-parity/persistence.test.ts run one writer at a time.
 *  - Seam: the engine's own executeRaw (PGLite) or the transaction's (Rust) is wrapped to record each statement; nothing
 *    else is replaced. Postgres runs when DATABASE_URL is set (testBackends). The Rust half needs the addon: skipped
 *    without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 *  - Not covered: the generation ledger statements of publish.ts, which test/rust-derived-generations.test.ts pins.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import { clearFenceHold, fenceHoldEntries, fenceOwnerKey, fenceReadOf, publishFenceGeneration, FACT_FENCE_KIND, FENCE_GENERATION_KINDS, type FenceGenerationKind } from '../src/core/generations/fence.ts';
import { generationKeyLock } from '../src/core/generations/publish.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';
import { testBackends } from './helpers/test-backends.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;
const postgresRun = testBackends().includes('postgres') ? test : test.skip;

const SLUG = 'people/alice-example';
const KEY: { kind: FenceGenerationKind; sourceId: string; ownerKey: string } = { kind: FACT_FENCE_KIND, sourceId: 'default', ownerKey: fenceOwnerKey(SLUG) };

/** The statements fence.ts has always sent through executeRaw. */
const OLD = {
  lock: 'SELECT pg_advisory_xact_lock(hashtext($1)::bigint)',
  clear: `DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3 AND state='held' AND held_reason IN ('fence_absent','no_proof')`,
  origin: 'SELECT deleted_at IS NOT NULL AS deleted FROM pages WHERE source_id=$1 AND slug=$2',
  files: `SELECT source_id, slug, NULLIF(btrim(source_path), '') IS NULL AS database_only FROM pages
      WHERE source_id = ANY($1::text[]) AND slug = ANY($2::text[]) AND deleted_at IS NULL`,
};

/** One held `fence_absent` row for KEY (columns of src/schema.sql derived_generations). */
async function seedHold(engine: BrainEngine): Promise<void> {
  await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3`, [KEY.sourceId, KEY.kind, KEY.ownerKey]);
  await engine.executeRaw(`INSERT INTO derived_generations (source_id, kind, owner_key, generation, state, operation_id, item_set_hash, held_reason, held_context)
    VALUES ($1, $2, $3, 0, 'held', 'held:two-writers', 'h', 'fence_absent', $4::text::jsonb)`,
  [KEY.sourceId, KEY.kind, KEY.ownerKey, JSON.stringify({ slug: SLUG, fence: 'facts', writer: 'projection', read: 'absent', rows: 1 })]);
}

/**
 * Two writers of KEY. Writer A takes the generation key lock and waits; writer B starts while A holds it. Each counts
 * the held rows it sees under the lock, then clears them. Returns each writer's count and the order things happened in.
 */
async function twoWriters(engine: BrainEngine): Promise<{ counts: [number, number]; events: string[] }> {
  const events: string[] = [];
  let release!: () => void;
  const released = new Promise<void>(resolve => { release = resolve; });
  let aLocked!: () => void;
  const lockedA = new Promise<void>(resolve => { aLocked = resolve; });
  const writer = (name: string, hold: Promise<void> | null) => engine.transaction(async tx => {
    await tx.lockGenerationKey(generationKeyLock(KEY));
    events.push(`${name}-locked`);
    if (hold) { aLocked(); await hold; }
    const seen = (await tx.listFenceHoldRows([KEY.sourceId], FENCE_GENERATION_KINDS, KEY.ownerKey)).length;
    await clearFenceHold(tx, KEY);
    events.push(`${name}-done`);
    return seen;
  });
  const a = writer('A', released);
  await lockedA;
  const b = writer('B', null);
  // A window for B to get past the lock if the lock did not hold it.
  await new Promise(resolve => setTimeout(resolve, 250));
  release();
  const counts = await Promise.all([a, b]) as [number, number];
  return { counts, events };
}

describe('fence generation statements', () => {
  let pg: PGLiteEngine;
  let pgHome: string;

  beforeAll(async () => {
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-fence-generations-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statements fence.ts always sent', async () => {
    await pg.putPage(SLUG, { type: 'person', title: 'Alice', compiled_truth: 'body', source_path: 'people/alice-example.md' });
    await seedHold(pg);
    const sent: Array<{ sql: string; params: unknown[] | undefined }> = [];
    // Each engine records on itself: a transaction engine inherits from `pg`, so it must not reach `pg`'s own wrapper.
    const record = (engine: BrainEngine) => {
      const original = engine.executeRaw.bind(engine);
      engine.executeRaw = (async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return original(sql, params); }) as typeof engine.executeRaw;
      return () => { delete (engine as { executeRaw?: unknown }).executeRaw; };
    };
    const restore = record(pg);
    try {
      const [hold] = await fenceHoldEntries(pg, ['default']);
      expect(hold).toMatchObject({ slug: SLUG, reason: 'fence_absent', rows: 1 });
    } finally {
      restore();
    }
    // A deleted page's rows retire on originGone, which the publish rechecks; the page is live, so it holds `no_proof`.
    expect(await pg.transaction(tx => { record(tx); return publishFenceGeneration(tx, { ...KEY, slug: SLUG, read: fenceReadOf({ body: null, timeline: null }), items: [],
      retire: [{ key: 'fact:1', identityHash: 'x' }], originGone: true, writer: 'deleted_page' }); })).toMatchObject({ state: 'held', reason: 'no_proof' });
    await pg.transaction(tx => { record(tx); return clearFenceHold(tx, KEY); });
    const fenceSql = new Set(Object.values(OLD));
    expect(sent.filter(s => fenceSql.has(s.sql))).toEqual([
      { sql: OLD.files, params: [['default'], [SLUG]] },
      { sql: OLD.lock, params: [generationKeyLock(KEY)] },
      { sql: OLD.origin, params: ['default', SLUG] },
      { sql: OLD.clear, params: ['default', FACT_FENCE_KIND, KEY.ownerKey] },
    ]);
    expect(await fenceHoldEntries(pg, ['default'])).toEqual([]);
  });

  test('PGLite: of two writers of one key, only one sees and clears the held row', async () => {
    await seedHold(pg);
    expect(await twoWriters(pg)).toEqual({ counts: [1, 0], events: ['A-locked', 'A-done', 'B-locked', 'B-done'] });
  });

  postgresRun('Postgres: the advisory lock holds the second writer until the first commits', async () => {
    assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
    const engine = new PostgresEngine();
    await engine.connect({ database_url: process.env.DATABASE_URL!, poolSize: 4 } as never);
    try {
      await engine.initSchema();
      await seedHold(engine);
      expect(await twoWriters(engine)).toEqual({ counts: [1, 0], events: ['A-locked', 'A-done', 'B-locked', 'B-done'] });
    } finally {
      await engine.executeRaw(`DELETE FROM derived_generations WHERE source_id=$1 AND kind=$2 AND owner_key=$3`, [KEY.sourceId, KEY.kind, KEY.ownerKey]).catch(() => {});
      await engine.disconnect();
    }
  }, 60_000);

  rustRun('Rust: the store write is the lock, and a fence publish runs without a raw statement', async () => {
    const brain = await openRustBrain();
    const engine = brain.engine as unknown as BrainEngine;
    try {
      await engine.putPage(SLUG, { type: 'person', title: 'Alice', compiled_truth: 'body' });
      // The page is live, so a deleted-page retire has no proof: the store keeps one held `no_proof` row.
      expect(await engine.transaction(tx => publishFenceGeneration(tx, { ...KEY, slug: SLUG, read: fenceReadOf({ body: null, timeline: null }), items: [],
        retire: [{ key: 'fact:1', identityHash: 'x' }], originGone: true, writer: 'deleted_page' }))).toMatchObject({ state: 'held', reason: 'no_proof' });
      // The writer gate runs the two writers one after the other: only the first sees and clears the held row.
      expect(await twoWriters(engine)).toEqual({ counts: [1, 0], events: ['A-locked', 'A-done', 'B-locked', 'B-done'] });
      const reached: string[] = [];
      const outcome = await engine.transaction(async tx => {
        const lock = tx.lockGenerationKey.bind(tx);
        const raw = tx.executeRaw.bind(tx);
        tx.lockGenerationKey = (async (k: string) => { reached.push('lockGenerationKey'); return lock(k); }) as typeof tx.lockGenerationKey;
        tx.executeRaw = (async (sql: string, params?: unknown[]) => { reached.push(sql); return raw(sql, params); }) as typeof tx.executeRaw;
        return publishFenceGeneration(tx, { ...KEY, slug: SLUG, read: fenceReadOf({ body: '## Facts block', timeline: null }),
          items: [{ key: 'row:1:abc', identityHash: 'abc' }], retire: [], writer: 'projection' });
      });
      expect(outcome).toEqual({ state: 'published', generation: 1 });
      expect(reached).toEqual(['lockGenerationKey']);
      expect(await fenceHoldEntries(engine, ['default'])).toEqual([]);
    } finally {
      await engine.disconnect().catch(() => {});
      removeBrainDir(brain.dir);
    }
  });
});
