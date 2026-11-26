/**
 * The shadow compare after a replayed chunk seal (`sealChunks`, src/shadow/replay.ts SEAL_WRITES): the Rust copy and its
 * primary name the same chunk ids in their search answers.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  1. Protects: the shadow's row identity check (`extraIds` in src/shadow/child-checks.ts) keys every search row on its
 *     page and its chunk, as `<chunk id>:<text digest>`. A primary (PGLite) renumbers a page's chunks when a seal replaces
 *     them; the Rust store must too, or every row of a resealed page reads as a row the primary never returned.
 *  2. Fails when: after the same writes on both engines (a page sealed, then sealed again with new text), the Rust
 *     search rows carry chunk ids the PGLite rows do not (unidentified or extra rows), or the ids differ.
 *  3. Existing coverage: test/engine-parity/rechunk-chunk-ids.test.ts compares the ids in relative terms per arm; nothing
 *     runs the shadow's identity check over a Rust answer after a reseal.
 *  4. Seams: a PGLite engine in memory and a Rust engine on a temp store, written through the same typed members. It needs
 *     the addon `bun run rust:build` writes; it skips without it (GBRAIN_TEST_RUST_ADDON_REQUIRED=1 makes that an error).
 */
import { afterAll, describe, expect, test } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { openRustEngine } from '../src/core/rust-engine.ts';
import { loadRustAddon } from '../src/core/rust-engine/addon-loader.ts';
import { detectAddonTarget } from '../src/core/rust-engine/addon-target.ts';
import { extraIds, rowIdentities } from '../src/shadow/child-checks.ts';
import { encodeValue } from '../src/shadow/codec.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { basisEmbedding } from './engine-parity/harness.ts';

const ROOT = resolve(import.meta.dir, '..');
const TARGET = detectAddonTarget();
const ADDON = process.env.GBRAIN_TEST_RUST_ENGINE_ADDON || (TARGET ? join(ROOT, 'rust', 'target', 'addon', `gbrain_engine.${TARGET}.node`) : '');
const HAVE_ADDON = !!ADDON && existsSync(ADDON);
if (!HAVE_ADDON && process.env.GBRAIN_TEST_RUST_ADDON_REQUIRED === '1') throw new Error(`GBRAIN_TEST_RUST_ADDON_REQUIRED=1 but ${ADDON || 'no addon target'} does not exist`);

const dir = mkdtempSync(join(tmpdir(), 'gb-shadow-rechunk-'));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const chunk = (i: number, text: string) => ({ chunk_index: i, chunk_text: text, chunk_source: 'compiled_truth' as const, embedding: basisEmbedding(3 + i), model: 'test-model' });

/** The same writes on any engine: a page with three sealed chunks, then a seal that replaces them with new text. */
async function writes(engine: BrainEngine): Promise<unknown> {
  await engine.putPage('notes/harbour', { type: 'note' as never, title: 'Harbour', compiled_truth: 'x', timeline: '' });
  await engine.sealChunks('notes/harbour', [0, 1, 2].map(i => chunk(i, `quiet harbour ${i}`)));
  await engine.sealChunks('notes/harbour', [0, 1, 2].map(i => chunk(i, `stormy harbour ${i}`)));
  const rows = await engine.searchVector(basisEmbedding(3), { limit: 5 });
  return encodeValue(rows.map(r => ({ slug: r.slug, source_id: r.source_id, page_id: r.page_id, chunk_id: r.chunk_id, chunk_text: r.chunk_text })));
}

describe.skipIf(!HAVE_ADDON)('the shadow compare after a replayed chunk seal', () => {
  test('the Rust copy names the chunk ids its primary names, so no row reads as unidentified or extra', async () => {
    const pglite = new PGLiteEngine();
    await pglite.connect({});
    await pglite.initSchema();
    const rust = openRustEngine({ addon: await loadRustAddon({ env: { GBRAIN_RUST_ENGINE_ADDON: ADDON } }), databasePath: join(dir, 'db') });
    await rust.connect({ engine: 'pglite', database_path: join(dir, 'db') } as never);
    await rust.initSchema();
    try {
      const primary = rowIdentities(await writes(pglite));
      const copy = rowIdentities(await writes(rust));
      expect(primary.length).toBeGreaterThan(0);
      expect({ ids: copy.map(r => typeof r.chunk === 'object' ? r.chunk.id : null), extra: extraIds(primary, copy) })
        .toEqual({ ids: primary.map(r => typeof r.chunk === 'object' ? r.chunk.id : null), extra: { rows: [], unidentified: 0 } });
    } finally {
      await disposePersistenceConsumer(pglite);
      await pglite.disconnect();
      await rust.disconnect();
    }
  }, 120_000);
});
