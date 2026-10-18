import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import type { OperationContext } from '../src/core/operations.ts';
import { operationsByName } from '../src/core/operations.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { localHostId } from '../src/core/persistence/identity.ts';
import { disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { runPersistenceEffects } from '../src/core/persistence/effects.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const DIMS = 1536;
const words = 'amber basalt cobalt dune ember fjord granite harbor iris jade kelp lagoon marble nickel onyx pumice quartz reef slate tundra'.split(' ');
function paragraphs(seed: number, count: number): string[] {
  let state = seed;
  const next = () => (state = (state * 1103515245 + 12345) % 2147483648) / 2147483648;
  return Array.from({ length: count }, () => Array.from({ length: 260 }, () => words[Math.floor(next() * words.length)]).join(' ') + '.');
}
const page = (title: string, body: string[], tags: string[] = []) =>
  `---\ntitle: ${title}\ntype: note\n${tags.length ? `tags: [${tags.join(', ')}]\n` : ''}---\n\n${body.join('\n\n')}\n`;
function vector(text: string): Float32Array {
  const digest = createHash('sha256').update(text).digest();
  return Float32Array.from({ length: DIMS }, (_, i) => (digest[i % 32]! - 128) / 128 + Math.sin(i + digest[(i * 7) % 32]!));
}

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: a prepared page edit keeps unchanged chunks`, () => {
    let engine: BrainEngine;
    const sources: string[] = [];
    beforeAll(async () => {
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'synthetic-edit-reuse-fixture' } });
      __setEmbedTransportForTests(async () => { throw new Error('Provider called outside the effect worker'); });
    }, 120_000);
    afterAll(async () => {
      await disposePersistenceConsumer(engine);
      try {
        await engine.executeRaw('DELETE FROM persistence_effects WHERE source_id=ANY($1::text[])', [sources]);
        await engine.executeRaw('DELETE FROM persistence_requests WHERE source_id=ANY($1::text[])', [sources]);
        await engine.executeRaw('DELETE FROM sources WHERE id=ANY($1::text[])', [sources]);
      } finally {
        await engine.disconnect();
        __setEmbedTransportForTests(null); resetGateway();
      }
    }, 60_000);

    async function fixture() {
      const sourceId = `edit-reuse-${randomUUID().slice(0, 8)}`; sources.push(sourceId);
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1)', [sourceId]);
      const context: OperationContext = { engine, sourceId, config: { engine: kind, embedding_disabled: true }, remote: false, dryRun: false,
        logger: { info() {}, warn() {}, error() {} } };
      const embedded: string[] = [];
      const write = async (slug: string, content: string) => {
        const requestId = randomUUID();
        const revision = (await engine.readPageSnapshot(slug, { sourceId }))?.revision;
        await engine.executeRaw("ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT (now()+interval '1 hour')");
        try {
          const receipt = await operationsByName.put_page.handler(context, { slug, request_id: requestId, content, ...(revision ? { expected_revision: revision } : {}) });
          expect(receipt).toMatchObject({ state: 'committed' });
        } finally {
          await disposePersistenceConsumer(engine);
          await engine.executeRaw('ALTER TABLE persistence_effects ALTER COLUMN next_attempt_at SET DEFAULT now()');
        }
        const [row] = await engine.executeRaw<{ id: string }>('SELECT id FROM persistence_requests WHERE request_id=$1::uuid AND source_id=$2', [requestId, sourceId]);
        await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now()+interval '1 hour'");
        await engine.executeRaw("UPDATE persistence_effects SET next_attempt_at=now() WHERE request_id=$1::uuid AND kind='embedding'", [row!.id]);
        await runPersistenceEffects(engine, { engine: kind }, { hostId: localHostId(), limit: 1,
          embedding: { signature: `openai:text-embedding-3-large:${DIMS}`, model: 'openai:text-embedding-3-large', embed: async texts => { embedded.push(...texts); return texts.map(vector); } } });
      };
      const rows = (slug: string) => engine.executeRaw<Record<string, unknown>>(`SELECT c.id, c.chunk_index, c.chunk_text, c.chunk_source, c.embedding::text AS embedding,
          c.model, c.token_count, c.embedded_text_hash, c.embedding_input_hash, c.search_vector::text AS search_vector, c.modality
        FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY c.chunk_index`, [sourceId, slug]);
      return { write, rows, embedded };
    }
    const withoutId = (rows: Record<string, unknown>[]) => rows.map(({ id: _id, ...rest }) => rest);

    test('a one-paragraph edit embeds only the changed chunks and stores what a fresh write stores', async () => {
      const { write, rows, embedded } = await fixture();
      const body = paragraphs(11, 8);
      await write('notes/edited', page('Reuse Fixture', body));
      const before = await rows("notes/edited");
      expect(before.length).toBeGreaterThan(3);
      expect(before.every(row => row.embedding !== null)).toBe(true);
      embedded.length = 0;
      body[3] = paragraphs(97, 1)[0]!;
      await write('notes/edited', page('Reuse Fixture', body));
      const after = await rows('notes/edited');
      const unchanged = after.filter(row => before.some(old => old.chunk_index === row.chunk_index && old.chunk_text === row.chunk_text));
      expect(unchanged.length).toBeGreaterThan(0);
      expect(embedded.length).toBe(after.length - unchanged.length);
      for (const row of unchanged) expect(row).toEqual(before.find(old => old.chunk_index === row.chunk_index)!);
      // A page written once with the edited content is the reference for every stored column.
      await write('notes/reference', page('Reuse Fixture', body));
      expect(withoutId(after)).toEqual(withoutId(await rows('notes/reference')));
    }, 120_000);

    test('a tag-only edit embeds nothing and keeps every chunk row', async () => {
      const { write, rows, embedded } = await fixture();
      const body = paragraphs(23, 5);
      await write('notes/tagged', page('Tag Fixture', body));
      const before = await rows('notes/tagged');
      embedded.length = 0;
      await write('notes/tagged', page('Tag Fixture', body, ['synthetic-tag']));
      expect(embedded).toEqual([]);
      expect(await rows('notes/tagged')).toEqual(before);
    }, 120_000);

    test('a title change under the title wrapper re-embeds every chunk', async () => {
      const { write, rows, embedded } = await fixture();
      const body = paragraphs(31, 5);
      await write('notes/retitled', page('First Title', body));
      const before = await rows('notes/retitled');
      embedded.length = 0;
      await write('notes/retitled', page('Second Title', body));
      const after = await rows('notes/retitled');
      expect(embedded.length).toBe(after.length);
      expect(embedded.every(text => text.includes('Second Title'))).toBe(true);
      expect(after.every(row => !before.some(old => old.id === row.id))).toBe(true);
    }, 120_000);
  });
}
