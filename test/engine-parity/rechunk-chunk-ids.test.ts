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
 *    (c) the code edges that leave a re-chunked calling page go with its old chunk ids, so the code walk finds no calls
 *        from it until its edges are written again;
 *  - Regression: the Rust store kept a chunk's id when a full replacement (sealChunks, its own putPage re-chunk) wrote new
 *    text at the same index, so a chunk_id from before still opened a window there (around the new text), a shadow
 *    copy kept other chunk ids than its primary, and a re-chunked calling page kept the call edges of its old chunks.
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
import type { CodeEdgeResult } from '../../src/core/types.ts';

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

  parityTest('a re-chunked calling page loses the call edges of its old chunks, so the code walk finds no calls from it', {
    methods: ['putPage', 'sealChunks', 'getChunks', 'addCodeEdges', 'getCalleesOf', 'getCallersOf', 'getEdgesByChunk'],
    timeout: 120_000,
  }, async (engine) => {
    const code = (slug: string, symbols: string[]) => symbols.map((s, i) => ({
      chunk_index: i, chunk_text: `function ${s}() {}`, chunk_source: 'compiled_truth' as const,
      language: 'typescript', symbol_name: s, symbol_type: 'function', symbol_name_qualified: s,
    }));
    const seed = async (slug: string, symbols: string[]) => {
      await engine.putPage(slug, { type: 'code', page_kind: 'code', title: slug, compiled_truth: symbols.map(s => `function ${s}() {}`).join('\n'), timeline: '' } as never);
      await installChunks(engine, slug, code(slug, symbols));
      return (await engine.getChunks(slug)).map(c => Number(c.id));
    };
    const [run] = await seed('src-caller-ts', ['run']);
    const [helper] = await seed('src-callee-ts', ['helper']);
    await engine.addCodeEdges([
      { from_chunk_id: run!, to_chunk_id: helper!, from_symbol_qualified: 'run', to_symbol_qualified: 'helper', edge_type: 'calls' },
      { from_chunk_id: run!, to_chunk_id: null, from_symbol_qualified: 'run', to_symbol_qualified: 'external.fetch', edge_type: 'calls' },
    ]);
    const walk = async () => ({
      callees: (await engine.getCalleesOf('run', { allSources: true })).map((e: CodeEdgeResult) => e.to_symbol_qualified).sort(),
      callers: (await engine.getCallersOf('helper', { allSources: true })).length,
      intoHelper: (await engine.getEdgesByChunk(helper!, { direction: 'in' })).length,
    });
    const before = await walk();
    // The calling page's chunks are replaced with the same text: every chunk gets a new id.
    await installChunks(engine, 'src-caller-ts', code('src-caller-ts', ['run']));
    const [runAfter] = (await engine.getChunks('src-caller-ts')).map(c => Number(c.id));
    const after = await walk();
    const value = { before, after, newId: runAfter! > run!, outOfNew: (await engine.getEdgesByChunk(runAfter!, { direction: 'out' })).length };
    expect(value).toEqual({
      before: { callees: ['external.fetch', 'helper'], callers: 1, intoHelper: 1 },
      after: { callees: [], callers: 0, intoHelper: 0 },
      newId: true, outOfNew: 0,
    });
    return value;
  });
});
