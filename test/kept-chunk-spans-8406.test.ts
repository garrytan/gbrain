/**
 * #8406: unchanged chunks keep their row/vector but must take the new projected
 * UTF-8 spans after an earlier edit. Covers inline/no-embed/prepared imports and
 * the bounded replacement continuation; a fresh import is the span oracle.
 * PGLite always, optional isolated PostgreSQL; provider transport is synthetic.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { isolatedSharedSkillsEngine } from './helpers/shared-skills-engine.ts';
import { testBackends } from './helpers/test-backends.ts';

const paragraph = (word: string) => Array.from({ length: 300 }, (_, i) => `${word}${i}`).join(' ') + '.';
const section = (word: string) => `## Section ${word}\n\n${paragraph(word)}`;
const page = (words: string[]) => `---\ntype: note\ntitle: Span example\n---\n\n${words.map(section).join('\n\n')}\n`;
interface Row { id: number; chunk_index: number; chunk_text: string; chunk_source: string; start: string | null; end: string | null; vector: string | null; embedded_at: string | null }

for (const backend of testBackends()) describe(`#8406 kept chunk spans (${backend})`, () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;
  beforeAll(async () => {
    resetGateway();
    configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: 1536, env: { OPENAI_API_KEY: 'sk-test' } });
    __setEmbedTransportForTests((async ({ values }: { values: string[] }) => ({
      embeddings: values.map(() => Array.from({ length: 1536 }, (_, i) => i === 0 ? 1 : 0)), usage: { tokens: values.length },
    })) as never);
    ({ engine, close } = await isolatedSharedSkillsEngine(backend === 'postgres' ? process.env.DATABASE_URL : undefined));
  }, 120_000);
  afterAll(async () => { __setEmbedTransportForTests(null); resetGateway(); await close(); }, 60_000);
  const rows = (slug: string) => engine.executeRaw<Row>(`SELECT c.id,c.chunk_index,c.chunk_text,c.chunk_source,
    c.projected_byte_start::text AS start,c.projected_byte_end::text AS end,c.embedding::text AS vector,c.embedded_at::text AS embedded_at
    FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id='default' AND p.slug=$1 ORDER BY c.chunk_index`, [slug]);
  const spans = (list: Row[]) => list.map(({ chunk_index, chunk_text, chunk_source, start, end }) => ({ chunk_index, chunk_text, chunk_source, start, end }));

  for (const mode of ['embedded', 'no-embed', 'never-embedded', 'prepared', 'deferred', 'fenced', 'legacy-spans'] as const) {
    test(`${mode}: earlier Unicode edit refreshes stationary spans without replacing vectors`, async () => {
      const slug = `notes/spans-${mode}`;
      const words = Array.from({ length: 16 }, (_, i) => `word${String.fromCharCode(97 + i)}`);
      const fence = (claim: string) => `\n\n## Facts\n<!--- gbrain:facts:begin -->\n| # | claim | kind | confidence | visibility | notability | valid_from | valid_until | source | context |\n|---|-------|------|------------|------------|------------|------------|-------------|--------|---------|\n| 1 | ${claim} | fact | 1.0 | world | medium | 2017-01-01 |  | chat |  |\n<!--- gbrain:facts:end -->\n\n`;
      const fenced = (claim: string) => page(words).replace('## Section wordb', `${fence(claim)}## Section wordb`);
      await importFromContent(engine, slug, mode === 'fenced' ? fenced('The example is active') : page(words), { noEmbed: mode === 'never-embedded' });
      if (mode === 'legacy-spans') await engine.executeRaw(`UPDATE content_chunks SET projected_byte_start=NULL,projected_byte_end=NULL
        WHERE page_id=(SELECT id FROM pages WHERE source_id='default' AND slug=$1)`, [slug]);
      const before = await rows(slug);
      if (mode === 'deferred') words.splice(6, 0, 'inserted');
      const content = mode === 'fenced' ? fenced('The example is café') : page(words).replace('worda0', 'café東京 worda0');
      let pending = false;
      await importFromContent(engine, slug, content, {
        noEmbed: mode === 'no-embed' || mode === 'never-embedded',
        ...(mode === 'prepared' || mode === 'deferred' || mode === 'legacy-spans' ? {
          boundedChunkWrites: true as const,
          prepare: async ready => {
            await engine.executeRaw('CREATE TABLE probe_8406_writes (tx bigint)');
            await engine.executeRaw(`CREATE FUNCTION probe_8406_budget() RETURNS trigger LANGUAGE plpgsql AS $$
              BEGIN
                IF NEW.embedding IS NOT NULL THEN
                  INSERT INTO probe_8406_writes VALUES (txid_current());
                  IF (SELECT count(*) FROM probe_8406_writes WHERE tx=txid_current()) > 5 THEN
                    RAISE EXCEPTION 'probe_8406 vector write budget exceeded';
                  END IF;
                END IF;
                RETURN NEW;
              END $$`);
            await engine.executeRaw('CREATE TRIGGER probe_8406_budget BEFORE INSERT OR UPDATE ON content_chunks FOR EACH ROW EXECUTE FUNCTION probe_8406_budget()');
            try {
              const applied = await engine.transaction(tx => ready.apply(tx));
              pending = applied?.projectionPending === true;
              await ready.afterCommit?.(engine);
              const writes = await engine.executeRaw<{ n: number }>('SELECT count(*)::int AS n FROM probe_8406_writes GROUP BY tx');
              expect(writes.length).toBeGreaterThan(1);
              expect(writes.every(row => Number(row.n) <= 5)).toBe(true);
              const [state] = await engine.executeRaw<{ sealed: boolean }>(`SELECT text_projection_revision IS NOT DISTINCT FROM knowledge_revision AS sealed
                FROM pages WHERE source_id='default' AND slug=$1`, [slug]);
              expect(state!.sealed).toBe(true);
              return ready.result;
            } finally {
              await engine.executeRaw('DROP TRIGGER probe_8406_budget ON content_chunks');
              await engine.executeRaw('DROP FUNCTION probe_8406_budget()');
              await engine.executeRaw('DROP TABLE probe_8406_writes');
            }
          },
        } : {}),
      });
      expect(pending).toBe(mode === 'deferred' || mode === 'prepared' || mode === 'legacy-spans');
      const after = await rows(slug);
      const stationary = after.filter(row => before.some(old => old.id === row.id && old.chunk_index === row.chunk_index));
      expect(stationary.length).toBeGreaterThan(2);
      for (const row of stationary) {
        const old = before.find(old => old.id === row.id)!;
        expect(row.vector).toBe(old.vector);
        expect(row.embedded_at).toBe(old.embedded_at);
      }
      await importFromContent(engine, `${slug}-fresh`, content, { noEmbed: true });
      const reference = await rows(`${slug}-fresh`);
      const shifted = stationary.filter(row => reference.find(fresh => fresh.chunk_index === row.chunk_index)?.start !== before.find(old => old.id === row.id)!.start);
      expect(shifted.length).toBeGreaterThan(1);
      expect(spans(after)).toEqual(spans(reference));
      // A second unchanged import is idempotent, including metadata and vectors.
      await importFromContent(engine, slug, content, { noEmbed: true });
      expect(await rows(slug)).toEqual(after);
    }, 120_000);
  }
});
