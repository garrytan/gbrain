/**
 * An aborted `gbrain embed` stops claiming pages: after the caller's signal
 * fires during one page's embed call, no later page is read or embedded, on
 * both the --stale path (embedAllStale) and the --all path (embedAll). Drives
 * the real embed -> gateway path with one worker and an embed transport that
 * aborts the run on its first call.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from 'bun:test';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { mockEmbedProjectionEngine as mockEngine } from './helpers/embed-projection-mock.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const slugs = Array.from({ length: 5 }, (_, i) => `notes/abort-${i}`);

let controller: AbortController;
let embeddedTexts: string[][] = [];

beforeEach(() => {
  controller = new AbortController();
  embeddedTexts = [];
  resetGateway();
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embeddedTexts.push(values);
    controller.abort();
    return {
      embeddings: values.map(() => Array.from({ length: DIMS }, (_, j) => (j === 0 ? 1 : 0))),
      usage: { tokens: values.length },
    };
  }) as never);
});

afterEach(() => __setEmbedTransportForTests(null));

afterAll(() => resetGateway());

const chunk = (slug: string) => ({ chunk_index: 0, chunk_text: `Synthetic text for ${slug}.`, chunk_source: 'compiled_truth', embedded_at: null, token_count: 4 });

const pagesRead = (engine: unknown) => [...new Set(
  (engine as { _calls: { method: string; args: unknown[] }[] })._calls
    .filter(call => call.method === 'readPageSnapshot')
    .map(call => call.args[0]),
)];

describe('embed abort stops the page pool', () => {
  test('--stale: no page after the aborting one is read or embedded', async () => {
    const stale = slugs.map((slug, i) => ({
      slug, chunk_index: 0, chunk_text: `Synthetic text for ${slug}.`, chunk_source: 'compiled_truth' as const,
      model: null, token_count: 4, source_id: 'default', page_id: i + 1,
    }));
    let served = false;
    const engine = mockEngine({
      countStaleChunks: async () => (served ? 0 : slugs.length),
      listStaleChunks: async () => { if (served) return []; served = true; return stale; },
      getChunks: async (slug: string) => [chunk(slug)],
      upsertChunks: async () => {},
    });

    await withEnv({ GBRAIN_EMBED_CONCURRENCY: '1' }, () => runEmbedCore(engine, { stale: true, signal: controller.signal }));

    expect(embeddedTexts).toHaveLength(1);
    expect(pagesRead(engine)).toEqual([slugs[0]]);
  });

  test('--all: no page after the aborting one is read or embedded', async () => {
    const engine = mockEngine({
      listPages: async () => slugs.map(slug => ({ slug })),
      getChunks: async (slug: string) => [chunk(slug)],
      upsertChunks: async () => {},
    });

    await withEnv({ GBRAIN_EMBED_CONCURRENCY: '1' }, () => runEmbedCore(engine, { all: true, signal: controller.signal }));

    expect(embeddedTexts).toHaveLength(1);
    expect(pagesRead(engine)).toEqual([slugs[0]]);
  });
});
