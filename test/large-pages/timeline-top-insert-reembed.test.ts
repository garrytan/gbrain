/**
 * An entry added at the top of a segmented page's timeline re-embeds at most two passages (Wave B PR 4 lane recall,
 * #7172 follow-up; pure coverage in timeline-bullet-chunks.test.ts).
 *
 * 1. Protects: timeline passages break at bullet starts chosen by the bullet alone (chunkers/bullet-chunks.ts), so when
 *    a write adds an entry above a 55-bullet descending timeline the rewritten timeline segment keeps every other
 *    passage's text, segment vector reuse copies their vectors, and the embedder is sent at most 2 inputs. The truth
 *    region (1.3 MB) is untouched and embeds nothing.
 * 2. Fails when: the timeline packs greedily with overlap (chunkProjectedText): every boundary moves under a top entry
 *    and all 4 timeline passages are embedded again.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. The embedder is a counting fake; nothing is paid.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { TIMELINE_SEPARATOR } from '../../src/core/page-window/document.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { descendingTimeline } from '../helpers/timeline-bullets.ts';

const WORDS = ['launch', 'pricing', 'roadmap', 'hiring', 'metrics', 'retention', 'design', 'latency', 'budget', 'customer'];
const paragraph = (k: number) => [`para${k}`, ...Array.from({ length: 98 }, (_, i) => WORDS[(k * 7 + i) % WORDS.length])].join(' ') + '.';

for (const kind of testBackends()) {
  describe(`timeline top entry re-embeds at most two passages (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    const embedded: string[] = [];

    beforeAll(async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else {
        engine = new PGLiteEngine();
        await engine.connect({});
        await engine.initSchema();
        close = () => engine.disconnect();
      }
      const dims = (await resolveActiveEmbeddingColumnFromEngine(engine)).dimensions;
      await engine.setConfig('pages.segmented_storage', 'on');
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: dims, env: { OPENAI_API_KEY: 'sk-test' } });
      __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
        embedded.push(...values);
        return { embeddings: values.map(() => Array.from({ length: dims }, (_, j) => (j === 0 ? 1 : 0))), usage: { tokens: values.length } };
      }) as never);
    }, 120_000);
    afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close?.(); });

    test('a 55-bullet timeline gains a top entry: at most 2 embedder inputs, all timeline passages', async () => {
      let truth = '';
      for (let k = 0; Buffer.byteLength(truth) < 1_300_000; k++) truth += paragraph(k) + '\n\n';
      const { bullets, top } = descendingTimeline(3);
      const page = (entries: string[]) => `---\ntitle: Acme example\ntype: company\n---\n\n${truth.trimEnd()}${TIMELINE_SEPARATOR}${entries.join('\n')}\n`;
      const slug = 'companies/acme-example-timeline';
      await importFromContent(engine, slug, page(bullets), { noEmbed: true });
      const [row] = await engine.executeRaw<{ body_storage: string }>('SELECT body_storage FROM pages WHERE slug = $1', [slug]);
      expect(row!.body_storage).toBe('segmented');
      await runEmbedCore(engine, { stale: true, quiet: true });
      expect(embedded.filter(t => t.includes('| source-a —')).length).toBeGreaterThanOrEqual(4);

      embedded.length = 0;
      await importFromContent(engine, slug, page([top, ...bullets]), { noEmbed: true });
      await runEmbedCore(engine, { stale: true, quiet: true });
      expect(embedded.length).toBeGreaterThanOrEqual(1);
      expect(embedded.length).toBeLessThanOrEqual(2);
      expect(embedded.some(t => t.includes(top.slice(2, 40)))).toBe(true);
      for (const t of embedded) expect(t).toContain('| source-a —');
    }, 300_000);
  });
}
