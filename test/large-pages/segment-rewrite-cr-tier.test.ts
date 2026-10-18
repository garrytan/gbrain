/**
 * A fence rewrite of a segmented page reuses vectors under the page's contextual-retrieval mode (Wave B PR 2, lane A).
 *
 * 1. Protects: on a page imported with contextual retrieval on (title tier, its corpus generation stamped), a
 *    withdrawal's fence rewrite (rewriteLiveSegmentedFences, also run by fact purge and reseal) carries each stored
 *    vector of an unchanged chunk in the rewritten segment onto its new row, as an import of the same body does.
 * 2. Fails when: the rewrite stages its chunks under tier 'none' and no corpus generation, so no title-tier vector
 *    passes the input-hash gate and every chunk of the rewritten segment loses its vector until re-embedded.
 * 3. Runs on PGLite, and on Postgres when DATABASE_URL is set. Vectors are written as a completed embedding pass
 *    records them (constant vector, title-tier embedding_input_hash); no provider runs.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BrainEngine } from '../../src/core/engine.ts';
import { PGLiteEngine } from '../../src/core/pglite-engine.ts';
import { importFromContent } from '../../src/core/import-file.ts';
import { embeddingInputHash } from '../../src/core/embedding-input-hash.ts';
import { embeddingInputContext, embeddingWriteTarget } from '../../src/core/page-state/projections.ts';
import { registerLocalWriter } from '../../src/core/persistence/identity.ts';
import { withCoordinatedWrite } from '../../src/core/persistence/context.ts';
import { recordFactWithdrawal } from '../../src/core/facts/withdrawal.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { fakeEmbedPage, segmentedPageRow } from '../helpers/segmented-page-checks.ts';
import { testBackends } from '../helpers/test-backends.ts';
import { TEST_WRITE_ATTRIBUTION } from '../helpers/write-attribution.ts';
import { withEnv } from '../helpers/with-env.ts';

const CLAIM = 'Prefers the aisle seat';
const home = mkdtempSync(join(tmpdir(), 'gbrain-rewrite-cr-tier-'));
const env = { GBRAIN_HOME: home, OPENAI_API_KEY: undefined, VOYAGE_API_KEY: undefined, ANTHROPIC_API_KEY: undefined };
const fence = (rows: string[]) => `<!--- gbrain:facts:begin -->
| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |
|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|
${rows.join('\n')}
<!--- gbrain:facts:end -->`;
const row = (n: number, claim: string) => `| ${n} | ${claim} | preference | 1.0 | world | medium | 2026-01-01 |  | chat |  |`;
function filler(tag: string, bytes: number): string {
  const parts: string[] = [];
  for (let i = 0, n = 0; n < bytes; i++) {
    const part = `## ${tag} ${i}\n\n${`Meeting notes on hiring, budget and the design review, item ${i}. `.repeat(30)}\n\n`;
    parts.push(part);
    n += part.length;
  }
  return parts.join('');
}
const TITLE = 'Seating plan';
const body = `---\ntitle: ${TITLE}\ntype: note\n---\n\n# ${TITLE}\n\n${filler('Part one', 700_000)}`
  + `## Facts\n\n${fence([row(1, CLAIM), row(2, 'Walks to work')])}\n\n${filler('Part two', 700_000)}`;
const coordinated = <T>(engine: BrainEngine, fn: (tx: BrainEngine) => Promise<T>) =>
  engine.transaction(tx => withCoordinatedWrite(tx, ['default'], () => fn(tx), TEST_WRITE_ATTRIBUTION));

afterAll(() => { rmSync(home, { recursive: true, force: true }); });

for (const kind of testBackends()) {
  describe(`fence rewrite vector reuse under contextual retrieval (${kind})`, () => {
    let engine: BrainEngine;
    let close: () => Promise<void>;
    beforeAll(async () => withEnv(env, async () => {
      if (kind === 'postgres') ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
      else { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); close = () => engine.disconnect(); }
      await registerLocalWriter(engine, 'cli');
      await engine.setConfig('pages.segmented_storage', 'on');
      await engine.executeRaw("UPDATE sources SET contextual_retrieval_mode = 'title' WHERE id = 'default'");
    }), 120_000);
    afterAll(async () => { await close?.(); });

    test('a withdrawal keeps the title-tier vectors of unchanged chunks in the rewritten segment', async () => withEnv(env, async () => {
      const slug = 'notes/seating-plan';
      await importFromContent(engine, slug, body, { noEmbed: true, sourceId: 'default' });
      const page = await segmentedPageRow(engine, slug);
      expect(page.body_storage).toBe('segmented');
      const [state] = await engine.executeRaw<{ mode: string | null; generation: string | null }>(
        'SELECT contextual_retrieval_mode AS mode, corpus_generation AS generation FROM pages WHERE id = $1', [page.id]);
      expect(state).toMatchObject({ mode: 'title' });
      expect(state!.generation).not.toBeNull();
      await fakeEmbedPage(engine, page.id);
      const provenance = embeddingInputContext(await embeddingWriteTarget(engine), TITLE, state!.generation, []);
      const stored = await engine.executeRaw<{ id: number; chunk_text: string; chunk_source: string }>('SELECT id, chunk_text, chunk_source FROM content_chunks WHERE page_id = $1', [page.id]);
      for (const chunk of stored) {
        await engine.executeRaw('UPDATE content_chunks SET embedding_input_hash = $2, embedded_at = now(), embedded_text_hash = md5(chunk_text) WHERE id = $1',
          [chunk.id, embeddingInputHash(provenance, 'title', chunk)]);
      }
      const [fact] = await coordinated(engine, tx => tx.executeRaw<{ id: number }>(`INSERT INTO facts(source_id,fact,entity_slug,visibility,source,source_markdown_slug,row_num)
        VALUES ('default',$1,NULL,'world','test',$2,1) RETURNING id`, [CLAIM, slug]));
      expect((await coordinated(engine, tx => recordFactWithdrawal(tx, Number(fact!.id), 'default'))).withdrawn).toBe(true);
      const after = await segmentedPageRow(engine, slug);
      expect(after.body_generation).toBe(page.body_generation + 1);
      const [rewritten] = await engine.executeRaw<{ total: number; same_text: number; reused: number }>(`SELECT count(*)::int AS total,
          count(*) FILTER (WHERE c.chunk_text = ANY($3::text[]))::int AS same_text,
          count(*) FILTER (WHERE c.chunk_text = ANY($3::text[]) AND c.embedding IS NOT NULL)::int AS reused
        FROM content_chunks c WHERE c.page_id = $1 AND c.body_generation = $2`, [page.id, after.body_generation, stored.map(chunk => chunk.chunk_text)]);
      expect(rewritten!.same_text).toBeGreaterThan(0);
      expect(rewritten!.reused).toBe(rewritten!.same_text);
    }), 300_000);
  });
}
