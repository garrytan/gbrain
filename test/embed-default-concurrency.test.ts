/**
 * `gbrain embed` runs 20 page workers when GBRAIN_EMBED_CONCURRENCY is unset,
 * on both the --all path (embedAll) and the --stale path (embedAllStale).
 * Drives the real embed -> embedBatch -> gateway path with a barrier embed
 * transport that holds every request until arrivals go quiet, so the peak
 * in-flight count equals the worker count.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { mockEmbedProjectionEngine as mockEngine } from './helpers/embed-projection-mock.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const PAGES = 30;
const QUIET_MS = 150;

let inFlight = 0;
let peak = 0;
let calls = 0;
let waiters: Array<() => void> = [];
let quietTimer: ReturnType<typeof setTimeout> | null = null;

function releaseWhenQuiet() {
  if (quietTimer) clearTimeout(quietTimer);
  quietTimer = setTimeout(() => {
    const release = waiters;
    waiters = [];
    for (const go of release) go();
  }, QUIET_MS);
}

const barrierTransport = (async ({ values }: { values: string[] }) => {
  calls++;
  inFlight++;
  peak = Math.max(peak, inFlight);
  await new Promise<void>(resolve => { waiters.push(resolve); releaseWhenQuiet(); });
  inFlight--;
  return {
    embeddings: values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0))),
    usage: { tokens: values.length },
  };
}) as never;

beforeEach(() => {
  inFlight = 0;
  peak = 0;
  calls = 0;
  waiters = [];
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests(barrierTransport);
});

afterEach(() => {
  if (quietTimer) clearTimeout(quietTimer);
  __setEmbedTransportForTests(null);
});

afterAll(() => resetGateway());

const slugs = Array.from({ length: PAGES }, (_, i) => `notes/concurrency-${i}`);
const staleChunk = (slug: string) => ({ chunk_index: 0, chunk_text: `Synthetic text for ${slug}.`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 });

describe('embed default concurrency', () => {
  test('--all runs 20 page workers when GBRAIN_EMBED_CONCURRENCY is unset', async () => {
    const engine = mockEngine({
      listPages: async () => slugs.map(slug => ({ slug })),
      getChunks: async (slug: string) => [staleChunk(slug)],
      upsertChunks: async () => {},
    });

    const result = await withEnv({ GBRAIN_EMBED_CONCURRENCY: undefined }, () => runEmbedCore(engine, { all: true }));

    expect(calls).toBe(PAGES);
    expect(result.embedded).toBe(PAGES);
    expect(peak).toBe(20);
  });

  test('--stale runs 20 page workers when GBRAIN_EMBED_CONCURRENCY is unset', async () => {
    const stale = slugs.map((slug, i) => ({
      slug, chunk_index: 0, chunk_text: `Synthetic text for ${slug}.`, chunk_source: 'compiled_truth' as const,
      model: null, token_count: 4, source_id: 'default', page_id: i + 1,
    }));
    let served = false;
    const engine = mockEngine({
      countStaleChunks: async () => (served ? 0 : PAGES),
      listStaleChunks: async () => { if (served) return []; served = true; return stale; },
      getChunks: async (slug: string) => [staleChunk(slug)],
      upsertChunks: async () => {},
    });

    await withEnv({ GBRAIN_EMBED_CONCURRENCY: undefined }, () => runEmbedCore(engine, { stale: true }));

    expect(calls).toBe(PAGES);
    expect(peak).toBe(20);
  });
});
