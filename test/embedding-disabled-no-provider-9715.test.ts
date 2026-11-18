/**
 * #9715: `embedding_disabled` must stop every route that sends page or fact text to the embedding provider, with a
 * key configured. embedStalePages (the synthesize phase-end embed and the safe-chunks, contextual-mode and
 * secret-spans repairs) checked only that a provider was configured; so did the canonical import (the classic
 * concept, pattern and enrichment writers) and extract_facts' fence reconcile. A recording transport stands in for the
 * provider. PGLite and, with DATABASE_URL, Postgres. Synthetic data only.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { __setEmbedTransportForTests, configureGateway, resetGateway } from '../src/core/ai/gateway.ts';
import { runExtractFacts } from '../src/core/cycle/extract-facts.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { embedStalePages } from '../src/core/embed-stale.ts';
import { safeChunksRepair } from '../src/core/repair/safe-chunks.ts';
import { embedStaleForSource } from '../src/core/embed-stale.ts';
import { importCodeFile } from '../src/core/import-file.ts';
import { runEmbedCore } from '../src/commands/embed.ts';
import { registerPersistenceConsumerConfig } from '../src/core/embedding-disabled.ts';
import { persistenceConsumerConfig } from '../src/core/persistence/service.ts';
import { runBrainstorm } from '../src/core/brainstorm/orchestrator.ts';
import { runReindexMultimodal } from '../src/commands/reindex-multimodal.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { requirePostgresTestDatabase, testBackends } from './helpers/test-backends.ts';
import { withEnv } from './helpers/with-env.ts';

const DIMS = 1536;
const sent: string[] = [];
beforeAll(() => {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: '[redacted]' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    sent.push(...values);
    return { embeddings: values.map(() => new Array<number>(DIMS).fill(0.001)), usage: { tokens: 0 } };
  }) as never);
});
afterAll(() => { __setEmbedTransportForTests(null); resetGateway(); });

const FENCED = `# Page

Body.

## Facts

<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
| 1 | Founded a widget company | fact | 1.0 | world | high | 2017-01-01 |  | notes |  |
<!--- gbrain:facts:end -->
`;

type Plane = 'off' | 'database' | 'file';

async function world(databaseUrl: string | undefined, plane: Plane, run: (engine: BrainEngine) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'gbrain-9715-'));
  try {
    mkdirSync(join(home, '.gbrain'));
    if (plane === 'file') writeFileSync(join(home, '.gbrain', 'config.json'), JSON.stringify({ engine: databaseUrl ? 'postgres' : 'pglite', embedding_disabled: true }));
    await withEnv({ GBRAIN_HOME: home, DATABASE_URL: undefined, GBRAIN_DATABASE_URL: undefined }, async () => {
      const { engine, close } = await isolatedSharedSkillsEngine(databaseUrl);
      try {
        if (plane === 'database') await engine.setConfig('embedding_disabled', 'true');
        sent.length = 0;
        await run(engine);
      } finally { await close(); }
    });
  } finally { rmSync(home, { recursive: true, force: true }); }
}

/** A page whose chunks sit on its current sealed projection with no vectors: what a oneshot synthesis child leaves. */
async function stalePage(engine: BrainEngine, slug: string): Promise<void> {
  await engine.putPage(slug, { type: 'note', title: slug, compiled_truth: `# ${slug}\n\nA private planning note.` });
  await installFixtureChunks(engine, slug, [0, 1].map(i => ({ chunk_index: i, chunk_text: `chunk ${i} of ${slug}`, chunk_source: 'compiled_truth' as const, token_count: 4 })));
}

const vectors = async (engine: BrainEngine, slug: string) => Number((await engine.executeRaw<{ n: number }>(
  `SELECT count(*)::int AS n FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.slug=$1 AND c.embedding IS NOT NULL`, [slug]))[0]!.n);

const ctxFor = (engine: BrainEngine): OperationContext => ({ engine, config: { engine: engine.kind } as never, sourceId: 'default', remote: false, dryRun: false,
  logger: { info() {}, warn() {}, error() {} } });

for (const backend of testBackends()) {
  const databaseUrl = backend === 'postgres' ? requirePostgresTestDatabase() : undefined;
  describe(`#9715 embedding_disabled sends nothing to the embedding provider (${backend})`, () => {
    test('control: with embedding on, the phase-end embed sends the stale chunks', async () => {
      await world(databaseUrl, 'off', async engine => {
        await stalePage(engine, 'notes/written');
        expect((await embedStalePages(engine, ['notes/written'], 'default')).embedded).toBe(2);
        expect(sent.length).toBe(2);
      });
    }, 120_000);

    for (const plane of ['database', 'file'] as const) {
      test(`embedStalePages (synthesize phase-end embed) sends nothing when the ${plane} plane disables embedding`, async () => {
        await world(databaseUrl, plane, async engine => {
          await stalePage(engine, 'notes/written');
          expect(await embedStalePages(engine, ['notes/written'], 'default')).toEqual({ embedded: 0, pagesProcessed: 0, aborted: false });
          expect(sent).toEqual([]);
          expect(await vectors(engine, 'notes/written')).toBe(0);
        });
      }, 120_000);
    }

    test('a failed read of the database row counts as disabled, so nothing is sent', async () => {
      await world(databaseUrl, 'database', async engine => {
        await stalePage(engine, 'notes/written');
        const original = engine.getConfig.bind(engine);
        let failed = false;
        engine.getConfig = async (key: string) => {
          if (key === 'embedding_disabled' && !failed) { failed = true; throw new Error('synthetic config read failure'); }
          return original(key);
        };
        try {
          expect((await embedStalePages(engine, ['notes/written'], 'default')).embedded).toBe(0);
        } finally { engine.getConfig = original; }
        expect(failed).toBe(true);
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('the safe-chunks repair re-seals a page without embedding it', async () => {
      await world(databaseUrl, 'database', async engine => {
        await stalePage(engine, 'notes/old-seal');
        await engine.executeRaw("UPDATE pages SET chunker_version=0 WHERE slug='notes/old-seal'");
        expect(await safeChunksRepair.apply(ctxFor(engine), { cursor: { phase: 0, id: 0 }, source_id: 'default', slug: 'notes/old-seal', chars: 0, action: 're-seal' }, { embed: true })).toBe(true);
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('an import without --no-embed (a classic derived writer) stores the page without sending its chunks', async () => {
      await world(databaseUrl, 'database', async engine => {
        const result = await importFromContent(engine, 'concepts/storage-example', '---\ntitle: storage example\ntype: concept\n---\nA narrative about storage.', { noEmbed: false });
        expect(result.status).toBe('imported');
        expect(sent).toEqual([]);
        expect(await vectors(engine, 'concepts/storage-example')).toBe(0);
      });
    }, 120_000);

    test('the source-wide stale sweep (doctor --remediate) sends nothing', async () => {
      await world(databaseUrl, 'database', async engine => {
        await stalePage(engine, 'notes/backlog');
        expect(await embedStaleForSource(engine, 'default')).toMatchObject({ embedded: 0, done: true });
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('embed --stale and its sync, connector and auto-fix callers refuse when only the database plane disables embedding', async () => {
      await world(databaseUrl, 'database', async engine => {
        await stalePage(engine, 'notes/backlog');
        await expect(runEmbedCore(engine, { stale: true })).rejects.toMatchObject({ name: 'EmbeddingDisabledError' });
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('embed follows the brain, not a consumer: consumer disabled with the row on embeds; the row disabled refuses whatever the consumer says', async () => {
      const consumer = (embedding_disabled: boolean) => registerPersistenceConsumerConfig(() => ({ engine: 'pglite', embedding_disabled }) as never);
      try {
        consumer(true);
        await world(databaseUrl, 'off', async engine => {
          await stalePage(engine, 'notes/backlog');
          expect((await runEmbedCore(engine, { stale: true })).embedded).toBe(2);
          expect(sent.length).toBe(2);
        });
        consumer(false);
        await world(databaseUrl, 'database', async engine => {
          await stalePage(engine, 'notes/backlog');
          await expect(runEmbedCore(engine, { stale: true })).rejects.toMatchObject({ name: 'EmbeddingDisabledError' });
          expect(sent).toEqual([]);
        });
      } finally { registerPersistenceConsumerConfig(persistenceConsumerConfig); }
    }, 120_000);

    test('a code import without --no-embed stores its chunks without sending them', async () => {
      await world(databaseUrl, 'database', async engine => {
        expect((await importCodeFile(engine, 'src/example.ts', 'export const answer = 42;\n', {})).status).toBe('imported');
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('reindex-multimodal refuses before reading a chunk', async () => {
      await world(databaseUrl, 'database', async engine => {
        await stalePage(engine, 'notes/backlog');
        await expect(runReindexMultimodal(engine, { yes: true })).rejects.toMatchObject({ name: 'EmbeddingDisabledError' });
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('brainstorm does not embed the question', async () => {
      await world(databaseUrl, 'database', async engine => {
        const asked: string[] = [];
        await runBrainstorm(engine, {}, { question: 'battery recycling question', skipCostPreview: true, stderrWrite: () => {},
          embedQueryFn: async q => { asked.push(q); return new Float32Array(DIMS); },
          chatFn: async () => { throw new Error('no chat in this test'); } }).catch(() => undefined);
        expect(asked).toEqual([]);
        expect(sent).toEqual([]);
      });
    }, 120_000);

    test('extract_facts inserts fence facts without sending their text', async () => {
      await world(databaseUrl, 'database', async engine => {
        await engine.putPage('people/alice-example', { title: 'alice-example', type: 'person', compiled_truth: FENCED, frontmatter: {}, timeline: '' });
        expect((await runExtractFacts(engine, { slugs: ['people/alice-example'] })).factsInserted).toBe(1);
        expect(sent).toEqual([]);
      });
    }, 120_000);
  });
}
