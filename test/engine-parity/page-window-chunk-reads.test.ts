/**
 * Parity for the two chunk reads of `get_page` (src/core/ops/get-page-body.ts): the chunk a `body: 'window'` read with
 * `around_chunk_id` centers on (`aroundChunk`), and the chunk and embedding counts of a `body: 'none'` read of an
 * unsegmented page (`noneResult`).
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on every engine arm (PGLite always; Postgres with DATABASE_URL; the Rust arm with GBRAIN_TEST_RUST_ARM=1)
 *    a window around a chunk of a sealed inline page returns the text around that chunk, anchored on its stored span;
 *    a chunk id that is not on the page is refused (revision_changed, reported as invalid_params); and `body: 'none'`
 *    reports the page's chunk count and how many of its chunks have a vector.
 *  - Regression: both reads were raw SQL (`SELECT chunk_text, ... FROM content_chunks WHERE id = $1 AND page_id = $2`
 *    and `SELECT count(*) AS total, count(*) FILTER (WHERE embedded_at IS NOT NULL) ...`), which the Rust engine refuses
 *    (engine_capability_missing, raw_sql), so on a Rust brain every window read around a search hit and every
 *    `body: 'none'` read of an inline page failed (N14: native window reads 0/40 on Rust, 40/40 on PGLite and Postgres).
 *  - Why existing coverage misses it: the get_page body tests run PGLite and Postgres only.
 *  - Seam: none. The cases call the get_page operation as a local caller on a page seeded through typed members.
 */
import { describe, expect } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { operations } from '../../src/core/operations.ts';
import { parityArms } from './harness.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { chunk, seedPage } from './chunk-fixtures.ts';

const { parityTest } = parityArms(testBackends());

const LINES = Array.from({ length: 30 }, (_, i) => `Line ${String(i + 1).padStart(2, '0')} of the window page talks about acme-example.`);
const BODY = LINES.join('\n');
const span = (line: number) => {
  const start = Buffer.byteLength(LINES.slice(0, line).map(l => l + '\n').join(''), 'utf8');
  return { projected_byte_start: start, projected_byte_end: start + Buffer.byteLength(LINES[line], 'utf8') };
};

/** A unit vector on its own axis, as the embedded chunk's stored vector. */
function unit(axis: number): Float32Array {
  const e = new Float32Array(1536);
  e[axis] = 1;
  return e;
}

/** The get_page operation as the local CLI calls it; the refusal's code when it refuses. */
async function getPage(engine: BrainEngine, params: Record<string, unknown>): Promise<Record<string, unknown>> {
  const op = operations.find(o => o.name === 'get_page')!;
  const ctx = { engine, sourceId: 'default', remote: false as const, dryRun: false,
    config: { engine: engine.kind, embedding_disabled: true }, logger: { info() {}, warn() {}, error() {}, debug() {} } };
  try {
    return await op.handler(ctx as never, params) as Record<string, unknown>;
  } catch (error) {
    return Object.defineProperty({ refused: (error as { code?: string }).code ?? String(error) }, 'error', { value: error, enumerable: false });
  }
}

/** Seeds the window page: 3 chunks with stored spans (lines 5, 15 and 25), the middle one with a vector. */
async function seedWindowPage(engine: BrainEngine): Promise<number[]> {
  await seedPage(engine, {
    slug: 'notes/window-example',
    input: { type: 'note', title: 'Window Example', compiled_truth: BODY, timeline: '' },
    chunks: [
      chunk(0, LINES[4], span(4)),
      chunk(1, LINES[14], { ...span(14), embedding: unit(7) }),
      chunk(2, LINES[24], span(24)),
    ],
  });
  const chunks = await engine.getChunks('notes/window-example', { sourceId: 'default' });
  return chunks.sort((a, b) => a.chunk_index - b.chunk_index).map(c => Number(c.id));
}

/** What a window read around a chunk shows, without the revision and cursor that differ per arm. */
function windowView(r: Record<string, unknown>) {
  if (r.refused) return { refused: r.refused };
  const w = r.window as { text: string; line_start: number; line_end: number; byte_start: number; byte_end: number };
  return { anchor: r.anchor, chunk_span: r.chunk_span, lines: [w.line_start, w.line_end], bytes: [w.byte_start, w.byte_end],
    hasChunkLine: w.text.includes(LINES[14]) };
}

describe('engine parity: the get_page chunk reads', () => {
  parityTest('a window around a chunk_id reads the text around that chunk; a chunk not on the page is refused', {
    methods: ['sealChunks', 'getChunks', 'readWindowChunk'],
    timeout: 60_000,
  }, async (engine) => {
    const ids = await seedWindowPage(engine);
    const around = await getPage(engine, { slug: 'notes/window-example', body: 'window', around_chunk_id: ids[1], context_lines: 2 });
    const missing = await getPage(engine, { slug: 'notes/window-example', body: 'window', around_chunk_id: ids[2] + 1000 });
    const out = { around: windowView(around), missing: (missing as { refused?: string }).refused ?? 'answered' };
    const start = span(14).projected_byte_start;
    expect(out).toEqual({
      around: { anchor: 'stored_span', chunk_span: { byte_start: start, byte_end: span(14).projected_byte_end },
        lines: [13, 17], bytes: [span(12).projected_byte_start, span(17).projected_byte_start], hasChunkLine: true },
      // A chunk id that is not on the page at its revision: revision_changed, which get_page reports as invalid_params.
      missing: 'invalid_params',
    });
    return out;
  });

  parityTest('body none reports the chunk count and the embedded count of an unsegmented page', {
    methods: ['sealChunks', 'getChunks', 'countPageChunks'],
    timeout: 60_000,
  }, async (engine) => {
    await seedWindowPage(engine);
    const r = await getPage(engine, { slug: 'notes/window-example', body: 'none' });
    const out = { refused: r.refused ?? null, chunks: r.chunks ?? null, embed_skip: r.embed_skip ?? null };
    expect(out).toEqual({ refused: null, chunks: { total: 3, embedded: 1 }, embed_skip: null });
    return out;
  });
});
