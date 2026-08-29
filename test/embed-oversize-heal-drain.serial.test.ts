/**
 * SUP-3874 drain-integration pins — healOversizedPageChunks must be CALLED by
 * every --stale drain, not merely exist as a correct helper.
 *
 * test/embed-oversize-heal.test.ts covers the pure splitter; these tests seed
 * a REAL PGLite page whose stored chunk exceeds the active input cap and run
 * the actual drains. Deleting any heal call-site fails the matching test here:
 *   - `embedStaleForSource` (src/core/embed-stale.ts — shared CLI/minion drain)
 *   - `embedStalePages`     (src/core/embed-stale.ts — phase-end closure path)
 *   - `runEmbedCore({stale})` → embedAllStale (src/commands/embed.ts CLI drain)
 *
 * The invariants pinned per drain:
 *   1. the sweep COMPLETES (no permanent per-page failure loop),
 *   2. the embedder NEVER receives the oversized text (every input ≤ cap),
 *   3. the stored rows end up split, each ≤ cap,
 *   4. the untouched sibling's stored vector SURVIVES the heal upsert
 *      (upsertChunks COALESCE on unchanged (chunk_index, chunk_text)).
 *
 * Serial: sets GBRAIN_MAX_CHUNK_TOKENS and uses mock.module (module-registry
 * quarantine per docs/TESTING.md).
 */

import { describe, test, expect, beforeAll, afterAll, beforeEach, mock } from 'bun:test';

// The CLI drain (embed.ts) reaches the embedder through embedding.ts's
// embedBatch; mock it BEFORE importing embed.ts so runEmbedCore records what
// the model would have been asked to embed.
let embedBatchTexts: string[] = [];
mock.module('../src/core/embedding.ts', () => ({
  embedBatch: async (texts: string[]) => {
    embedBatchTexts.push(...texts);
    return texts.map(() => {
      const v = new Float32Array(1536);
      v[0] = 9;
      return v;
    });
  },
  // null signature: no invalidation pass, no provenance stamping — this suite
  // pins the heal wiring, not signature mechanics.
  currentEmbeddingSignature: () => null,
  embedMultimodal: async (inputs: unknown[]) => inputs.map(() => new Float32Array(512)),
}));

const { runEmbedCore } = await import('../src/commands/embed.ts');
const { embedStaleForSource, embedStalePages } = await import('../src/core/embed-stale.ts');
const { PGLiteEngine } = await import('../src/core/pglite-engine.ts');
const { resetPgliteState } = await import('./helpers/reset-pglite.ts');
const { estimateEmbedTokens } = await import('../src/core/chunkers/token-estimate.ts');
const { __setEmbedTransportForTests } = await import('../src/core/ai/gateway.ts');
const { resolveMaxChunkTokens } = await import('../src/core/embedding-input-limit.ts');
import type { ChunkInput } from '../src/core/types.ts';

// runEmbedCore preflights embedding credentials; the transport seam flags the
// preflight as ok without touching real env vars (same as embed.serial.test.ts).
__setEmbedTransportForTests(async () => ({ embeddings: [], usage: { tokens: 0 } } as never));

const CAP = 128;
const OVERSIZED =
  'The quarterly SEO implementation plan covers technical setup, content calendars, ' +
  'schema markup, and local keyword clusters that must remain searchable after re-embedding. '.repeat(40);
const SIBLING_TEXT = 'short sibling that already has a vector';

let engine: InstanceType<typeof PGLiteEngine>;

beforeAll(async () => {
  process.env.GBRAIN_MAX_CHUNK_TOKENS = String(CAP);
  // Sanity: the env knob is live and the seeded text really is oversized.
  expect(resolveMaxChunkTokens()).toBe(CAP);
  expect(estimateEmbedTokens(OVERSIZED)).toBeGreaterThan(CAP);
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 30000);

afterAll(async () => {
  delete process.env.GBRAIN_MAX_CHUNK_TOKENS;
  __setEmbedTransportForTests(null);
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  embedBatchTexts = [];
});

/**
 * Seed a page whose chunk 0 is a normal, ALREADY-EMBEDDED sibling (marker
 * vector v[0]=0.5) and chunk 1 is a stored oversized row with no embedding
 * (the pre-#4530 legacy shape the heal exists for).
 */
async function seedOversizedPage(slug: string): Promise<void> {
  await engine.putPage(slug, {
    type: 'note',
    title: slug,
    compiled_truth: `# ${slug}\n\nseeded`,
  });
  const siblingVec = new Float32Array(1536);
  siblingVec[0] = 0.5;
  const chunks: ChunkInput[] = [
    {
      chunk_index: 0,
      chunk_text: SIBLING_TEXT,
      chunk_source: 'compiled_truth',
      token_count: 8,
      embedding: siblingVec,
    },
    {
      chunk_index: 1,
      chunk_text: OVERSIZED,
      chunk_source: 'compiled_truth',
      token_count: 5000,
      embedding: undefined, // NULL = stale
    },
  ];
  await engine.upsertChunks(slug, chunks);
}

/** Shared post-drain assertions: split-in-DB, cap respected, sibling vector alive. */
async function assertHealedState(slug: string, embeddedTexts: string[]): Promise<void> {
  // 2. The embedder never saw the oversized text; every input fits the cap.
  expect(embeddedTexts.length).toBeGreaterThan(0);
  for (const t of embeddedTexts) {
    expect(t).not.toBe(OVERSIZED);
    expect(estimateEmbedTokens(t)).toBeLessThanOrEqual(CAP);
  }

  // 3. Stored rows are split pieces, each ≤ cap; the page has MORE rows now.
  const after = await engine.getChunks(slug, { includeEmbedding: true });
  expect(after.length).toBeGreaterThan(2);
  for (const c of after) {
    expect(estimateEmbedTokens(c.chunk_text)).toBeLessThanOrEqual(CAP);
  }

  // 4. The untouched sibling kept its position, text, and STORED vector.
  const sibling = after.find((c) => c.chunk_index === 0);
  expect(sibling).toBeDefined();
  expect(sibling!.chunk_text).toBe(SIBLING_TEXT);
  expect(sibling!.embedding_is_null).toBe(false);
  const firstDim = Number(String(sibling!.embedding).replace(/^\[/, '').split(',')[0]);
  expect(firstDim).toBeCloseTo(0.5, 3);

  // 1b. Nothing left stale — the sweep converged instead of re-failing forever.
  expect(await engine.countStaleChunks({ sourceId: 'default' })).toBe(0);
}

function recordingEmbedFn(seen: string[]) {
  return async (texts: string[]): Promise<Float32Array[]> => {
    seen.push(...texts);
    return texts.map(() => {
      const v = new Float32Array(1536);
      v[0] = 9;
      return v;
    });
  };
}

describe('SUP-3874: --stale drains heal oversized stored chunks in place', () => {
  test('embedStaleForSource heals, completes, and preserves the embedded sibling', async () => {
    await seedOversizedPage('notes/heal-source');
    const seen: string[] = [];

    const result = await embedStaleForSource(engine, 'default', {
      embedFn: recordingEmbedFn(seen),
    });

    expect(result.done).toBe(true);
    expect(result.aborted).toBe(false);
    expect(result.embedded).toBeGreaterThanOrEqual(2); // ≥2 split pieces landed
    await assertHealedState('notes/heal-source', seen);
  });

  test('embedStalePages (phase-end closure path) heals its explicit page list', async () => {
    await seedOversizedPage('notes/heal-pages');
    const seen: string[] = [];

    const result = await embedStalePages(engine, ['notes/heal-pages'], 'default', {
      embedFn: recordingEmbedFn(seen),
    });

    expect(result.aborted).toBe(false);
    expect(result.embedded).toBeGreaterThanOrEqual(2);
    expect(result.pagesProcessed).toBe(1);
    await assertHealedState('notes/heal-pages', seen);
  });

  test('runEmbedCore({stale}) — the CLI drain (embedAllStale) heals through the mocked embedBatch', async () => {
    await seedOversizedPage('notes/heal-cli');

    const result = await runEmbedCore(engine, { stale: true, quiet: true });

    expect(result.failures).toBe(0);
    expect(result.reason).toBeUndefined();
    expect(result.embedded).toBeGreaterThanOrEqual(2);
    await assertHealedState('notes/heal-cli', embedBatchTexts);
  });
});
