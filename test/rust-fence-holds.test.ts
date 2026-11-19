/**
 * The held fence results that `gbrain get`, doctor and `gbrain sync status` list answer on a Rust brain.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Protects: listFenceHolds and fenceHoldEntries (generations/fence.ts) answer on a Rust brain, which holds no fence
 *    results, and PGLite sends the statement it always sent, byte for byte.
 *  - Regression: listFenceHolds read `derived_generations` through `executeRaw`, which the Rust engine refuses, so
 *    get_page swallowed a refusal on every read of a Rust brain and the doctor generations check failed.
 *  - Why existing coverage misses it: test/pathological/g2-fence-generations.test.ts runs on PGLite and Postgres only.
 *  - Seam: on PGLite the engine's own executeRaw is wrapped to record the statement; nothing else is replaced.
 *    The Rust half needs the addon: skipped without it unless GBRAIN_TEST_RUST_ADDON_REQUIRED=1.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { fenceHoldEntries, listFenceHolds } from '../src/core/generations/fence.ts';
import { openRustBrain, removeBrainDir, rustArmAddonPath } from './engine-parity/rust-arm.ts';

const required = process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1';
const rustRun = existsSync(rustArmAddonPath()) || required ? test : test.skip;

/** The statement listFenceHolds has always sent: `slug` adds the owner-key filter as $3. */
const OLD_SQL = (slug: boolean) => `SELECT source_id, kind, owner_key, held_reason, held_context, created_at::text AS created_at FROM derived_generations
      WHERE source_id = ANY($1::text[]) AND kind = ANY($2::text[]) AND state = 'held'${slug ? ' AND owner_key = $3' : ''}
      ORDER BY created_at, id`;

describe('held fence results', () => {
  let pg: PGLiteEngine;
  let pgHome: string;

  beforeAll(async () => {
    pgHome = mkdtempSync(join(tmpdir(), 'gbrain-fence-holds-'));
    pg = new PGLiteEngine();
    await pg.connect({ database_path: join(pgHome, 'db') } as never);
    await pg.initSchema();
  }, 60_000);

  afterAll(async () => {
    await pg.disconnect();
    rmSync(pgHome, { recursive: true, force: true });
  });

  test('PGLite sends the statement it always sent, with and without a slug', async () => {
    const sent: Array<{ sql: string; params: unknown[] | undefined }> = [];
    const original = pg.executeRaw.bind(pg);
    pg.executeRaw = (async (sql: string, params?: unknown[]) => { sent.push({ sql, params }); return original(sql, params); }) as typeof pg.executeRaw;
    try {
      expect(await listFenceHolds(pg, ['default'])).toEqual([]);
      expect(await listFenceHolds(pg, ['default', 'other'], 'people/alice-example')).toEqual([]);
    } finally {
      pg.executeRaw = original;
    }
    expect(sent).toEqual([
      { sql: OLD_SQL(false), params: [['default'], ['fact_fence', 'take_fence']] },
      { sql: OLD_SQL(true), params: [['default', 'other'], ['fact_fence', 'take_fence'], 'page:people/alice-example'] },
    ]);
  });

  rustRun('a Rust brain answers that nothing is held', async () => {
    const brain = await openRustBrain();
    const engine = brain.engine as unknown as BrainEngine;
    try {
      await engine.putPage('people/alice-example', { type: 'person', title: 'Alice', compiled_truth: 'body' });
      expect(await listFenceHolds(engine, ['default'])).toEqual([]);
      expect(await listFenceHolds(engine, ['default'], 'people/alice-example')).toEqual([]);
      expect(await fenceHoldEntries(engine, ['default'], { slug: 'people/alice-example' })).toEqual([]);
    } finally {
      await engine.disconnect().catch(() => {});
      removeBrainDir(brain.dir);
    }
  });
});
