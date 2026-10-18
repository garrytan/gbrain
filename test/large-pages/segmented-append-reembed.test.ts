/**
 * An append to a segmented page re-embeds one chunk when it starts a new
 * section after a full last chunk (N14 large-page fidelity, Wave B PR 1: the
 * 2 MB chat's 1 KB append re-embedded 2 chunks).
 *
 * 1. Protects: the segment chunker keeps a Markdown heading with the piece
 *    after it (chunkProjectedText `headingsLead`), so a day appended after a
 *    last chunk with no room for the day's text leaves that chunk's text and
 *    vector unchanged: the append embeds exactly its own chunk.
 * 2. Fails when: the greedy merge packs the new day's heading into the
 *    previous chunk (it fits the word budget alone), which rewrites that
 *    chunk's text and re-embeds it next to the new day's chunk.
 * 3. Existing coverage: segment-chunks.test.ts pins a one-segment page
 *    against prepareMarkdownChunks; inline-chunks-golden.test.ts pins inline
 *    pages, which keep the plain greedy merge.
 * 4. Runs on PGLite, and on Postgres when DATABASE_URL is set.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../../src/core/ai/gateway.ts';
import { runEmbedCore } from '../../src/commands/embed.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { chunkProjectedText } from '../../src/core/chunkers/recursive.ts';
import { resolveActiveEmbeddingColumnFromEngine } from '../../src/core/search/embedding-column.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { testBackends } from '../helpers/test-backends.ts';

const WORDS = ['launch', 'pricing', 'roadmap', 'hiring', 'metrics', 'retention', 'design', 'latency', 'budget', 'customer'];
/** One paragraph of exactly 100 words, unique per day and paragraph. */
const paragraph = (day: number, k: number) =>
  [`day${day}`, `para${k}`, ...Array.from({ length: 98 }, (_, i) => WORDS[(day * 7 + k * 3 + i) % WORDS.length])].join(' ') + '.';
/** A day: its heading and four paragraphs (403 words), so a chunk holds one day and has room for the next heading alone. */
const day = (d: number) => `## Day ${d}\n\n${[1, 2, 3, 4].map(k => paragraph(d, k)).join('\n\n')}\n\n`;

describe('headingsLead (pure)', () => {
  test('the next section\'s heading starts the next chunk; without the option it ends the previous one', () => {
    const text = day(1) + day(2) + day(3);
    const plain = chunkProjectedText(text, { chunkOverlap: 1 }).map(c => c.text);
    const leading = chunkProjectedText(text, { chunkOverlap: 1, headingsLead: true }).map(c => c.text);
    expect(plain[0]!.trimEnd().endsWith('## Day 2')).toBe(true);
    expect(leading[0]!.trimEnd().endsWith('## Day 2')).toBe(false);
    expect(leading[1]).toContain('## Day 2\n\nday2 para1');
    expect(leading.length).toBe(plain.length);
  });
});

for (const kind of testBackends()) {
  describe(`segmented append re-embeds one chunk (${kind})`, () => {
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

    test('a day appended after a full last chunk embeds only its own chunk', async () => {
      let body = '';
      let days = 0;
      while (Buffer.byteLength(body) < 1_300_000) body += day(++days);
      const slug = 'notes/append-reembed';
      await importFromContent(engine, slug, `---\ntitle: Daily log\ntype: note\n---\n\n${body}`, { noEmbed: true });
      const [page] = await engine.executeRaw<{ body_storage: string; sealed: boolean }>(
        'SELECT body_storage, text_projection_revision = knowledge_revision AS sealed FROM pages WHERE slug = $1', [slug]);
      expect(page).toEqual({ body_storage: 'segmented', sealed: true });
      await runEmbedCore(engine, { stale: true, quiet: true });
      expect(embedded.length).toBeGreaterThan(100);

      embedded.length = 0;
      await importFromContent(engine, slug, `---\ntitle: Daily log\ntype: note\n---\n\n${body}${day(days + 1)}`, { noEmbed: true });
      await runEmbedCore(engine, { stale: true, quiet: true });
      expect(embedded.length).toBe(1);
      expect(embedded[0]).toContain(`## Day ${days + 1}`);
    }, 300_000);
  });
}
