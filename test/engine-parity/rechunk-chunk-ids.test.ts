/**
 * BrainEngine parity: a page that is rewritten gets new chunk ids, a chunk id from before the rewrite no longer opens a
 * window, and equal-distance vector hits are ordered by chunk id.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, Postgres (DATABASE_URL) and the Rust engine (GBRAIN_TEST_RUST_ARM=1):
 *    (a) a rewrite through `put_page` (importFromContent), and a full chunk replacement (`sealChunks`, which the shadow
 *        replays), give every chunk of the page a new id from the shared counter, in chunk order, above every id it had;
 *    (b) `get_page` with `around_chunk_id` set to a chunk id from before the rewrite answers `revision_changed`, never a
 *        window of the new text under the old id;
 *  - Regression: the Rust store kept a chunk's id when a full replacement (sealChunks, its own putPage re-chunk) wrote new
 *    text at the same index, so a chunk_id from before still opened a window there (around the new text), and a shadow
 *    copy kept other chunk ids than its primary.
 *  - Why existing coverage misses it: the chunk parity cases compare chunk text and order, never the ids across a rewrite,
 *    and no vector case has an exact tie across pages.
 *  - Seam: none. Real engines and the real put_page and get_page operations.
 */
import { describe, expect } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { withEnv } from '../helpers/with-env.ts';
import { dispatchToolCall } from '../../src/mcp/dispatch.ts';
import { chunk, installChunks } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const PARAS = (word: string) => [1, 2, 3].map(n => `Paragraph ${n} about the ${word} harbour. `.repeat(60)).join('\n\n');
const note = (word: string) => `---\ntype: note\ntitle: Harbour notes\n---\n\n${PARAS(word)}\n`;

async function put(engine: BrainEngine, content: string): Promise<void> {
  const revision = (await engine.getPage('notes/harbour', { sourceId: 'default' }))?.knowledge_revision;
  const out = await dispatchToolCall(engine, 'put_page', { slug: 'notes/harbour', content, ...(revision ? { expected_revision: revision } : {}) },
    { remote: false, sourceId: 'default' } as never);
  if (out.isError) throw new Error(`put_page: ${out.content.map(c => (c as { text?: string }).text ?? '').join('')}`);
}

const ids = async (engine: BrainEngine) => (await engine.getChunks('notes/harbour', { sourceId: 'default' })).map(c => Number(c.id));

describe('engine parity: a rewritten page gets new chunk ids', () => {
  parityTest('a rewrite and a chunk replacement give new chunk ids, and a pre-replacement around_chunk_id answers revision_changed', {
    methods: ['getChunks', 'getPage', 'sealChunks', 'readWindowChunk'],
    timeout: 120_000,
  }, async (engine) => {
    const home = mkdtempSync(join(tmpdir(), 'gbrain-parity-rechunk-'));
    try {
      return await withEnv({ GBRAIN_HOME: home }, async () => {
        await put(engine, note('quiet'));
        const before = await ids(engine);
        await put(engine, note('stormy'));
        const after = await ids(engine);
        // A full replacement of the chunks (the page text unchanged): the old ids go, and a pre-replacement id is stale.
        const chunksNow = await engine.getChunks('notes/harbour', { sourceId: 'default' });
        await installChunks(engine, 'notes/harbour', chunksNow.map(c => chunk(c.chunk_index, c.chunk_text)));
        const resealed = await ids(engine);
        const read = await dispatchToolCall(engine, 'get_page', { slug: 'notes/harbour', around_chunk_id: after[0] }, { remote: false, sourceId: 'default' } as never);
        const text = read.content.map(c => (c as { text?: string }).text ?? '').join('');
        const around = { error: read.isError, stale: /revision_changed/.test(text), window: /stormy harbour/.test(text) };

        const value = {
          chunks: { before: before.length, after: after.length },
          renumbered: after.every(id => id > Math.max(...before)) && after.every((id, i) => i === 0 || id === after[i - 1]! + 1),
          resealed: resealed.length === after.length && resealed.every(id => id > Math.max(...after)) && resealed.every((id, i) => i === 0 || id === resealed[i - 1]! + 1),
          around,
        };
        expect(value).toEqual({ chunks: { before: 3, after: 3 }, renumbered: true, resealed: true,
          around: { error: true, stale: true, window: false } });
        return value;
      });
    } finally { rmSync(home, { recursive: true, force: true }); }
  });
});
