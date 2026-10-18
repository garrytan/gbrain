/**
 * An inline (CLI import / classic sync) edit keeps every stored chunk row that
 * is identical to its new chunk and rewrites only the rest, with and without
 * --no-embed. The stored result must equal a fresh import of the same content
 * in every column but the row id, and a kept row keeps its id and vector.
 *
 * PGLite in-memory always; Postgres when DATABASE_URL is set. The embedding
 * transport is stubbed ($0).
 */

import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { PostgresEngine } from '../src/core/postgres-engine.ts';
import type { BrainEngine } from '../src/core/engine.ts';
import { configureGateway, resetGateway, __setEmbedTransportForTests } from '../src/core/ai/gateway.ts';
import { importFromContent } from '../src/core/import-file.ts';
import { assertSafeE2eDatabaseUrl } from './helpers/db-guard.ts';

const DIMS = 1536;
let embedded: string[] = [];
let counter = 0;

function gateway() {
  configureGateway({ embedding_model: 'openai:text-embedding-3-large', embedding_dimensions: DIMS, env: { OPENAI_API_KEY: 'sk-test' } });
  __setEmbedTransportForTests((async ({ values }: { values: string[] }) => {
    embedded.push(...values);
    return {
      embeddings: values.map(() => { const v = new Array(DIMS).fill(0); v[counter++ % DIMS] = 1; return v; }),
      usage: { tokens: values.length },
    };
  }) as never);
}

const paragraph = (word: string) => Array.from({ length: 400 }, (_, i) => `${word}${i}`).join(' ') + '.';
const page = (title: string, words: string[], extra = '') =>
  `---\ntype: note\ntitle: ${title}\n---\n\n${words.map(w => `## Section ${w}\n\n${paragraph(w)}`).join('\n\n')}\n${extra}`;

for (const kind of ['pglite', 'postgres'] as const) {
  const suite = kind === 'postgres' && !process.env.DATABASE_URL ? describe.skip : describe;
  suite(`${kind}: an inline edit keeps unchanged chunk rows`, () => {
    let engine: BrainEngine;
    const sourceId = `inline-keep-${kind}-${process.pid}`;

    beforeAll(async () => {
      resetGateway();
      gateway();
      engine = kind === 'postgres' ? new PostgresEngine() : new PGLiteEngine();
      if (kind === 'postgres') assertSafeE2eDatabaseUrl(process.env.DATABASE_URL!);
      await engine.connect(kind === 'postgres' ? { database_url: process.env.DATABASE_URL! } : {});
      await engine.initSchema();
      await engine.executeRaw('INSERT INTO sources(id,name) VALUES($1,$1) ON CONFLICT DO NOTHING', [sourceId]);
    }, 120_000);

    afterAll(async () => {
      try {
        await engine.executeRaw('DELETE FROM pages WHERE source_id=$1', [sourceId]);
        await engine.executeRaw('DELETE FROM sources WHERE id=$1', [sourceId]);
      } finally {
        __setEmbedTransportForTests(null);
        resetGateway();
        await engine.disconnect();
      }
    }, 60_000);

    beforeEach(() => { embedded = []; gateway(); });

    const rows = (slug: string) => engine.executeRaw<Record<string, unknown>>(`SELECT c.id, c.chunk_index, c.chunk_text, c.chunk_source, c.embedding::text AS embedding,
        c.model, c.token_count, c.embedded_text_hash, c.embedding_input_hash, c.search_vector::text AS search_vector, c.modality
      FROM content_chunks c JOIN pages p ON p.id=c.page_id WHERE p.source_id=$1 AND p.slug=$2 ORDER BY c.chunk_index`, [sourceId, slug]);
    const withoutId = (list: Record<string, unknown>[]) => list.map(({ id: _id, ...rest }) => rest);
    const write = (slug: string, content: string, noEmbed = false) => importFromContent(engine, slug, content, { sourceId, noEmbed });

    test('an embedded edit keeps unchanged rows in place and stores what a fresh import stores', async () => {
      const words = ['alpha', 'bravo', 'charlie', 'delta', 'foxtrot'];
      await write('notes/edit', page('Keep', words));
      const before = await rows('notes/edit');
      expect(before.length).toBeGreaterThanOrEqual(4);
      embedded = [];
      words[2] = 'echo';
      await write('notes/edit', page('Keep', words));
      const after = await rows('notes/edit');
      const kept = after.filter(row => before.some(old => old.id === row.id));
      expect(kept.length).toBeGreaterThan(0);
      expect(embedded.length).toBe(after.length - kept.length);
      for (const row of kept) expect(row).toEqual(before.find(old => old.id === row.id)!);
      for (const text of embedded) expect(text).toContain('echo');
      expect(after.every(row => row.embedding !== null)).toBe(true);
      // A fresh import of the edited content stores the same rows (its vectors come from new stub calls).
      await write('notes/reference', page('Keep', words));
      expect(withoutId(await rows('notes/reference')).map(({ embedding: _e, ...rest }) => rest))
        .toEqual(withoutId(after).map(({ embedding: _e, ...rest }) => rest));
    }, 120_000);

    test('a --no-embed edit keeps unchanged rows with their vectors and leaves only changed chunks stale', async () => {
      const words = ['golf', 'hotel', 'india', 'juliet', 'kilo'];
      await write('notes/no-embed', page('NoEmbed', words));
      const before = await rows('notes/no-embed');
      expect(before.every(row => row.embedding !== null)).toBe(true);
      embedded = [];
      words[1] = 'lima';
      await write('notes/no-embed', page('NoEmbed', words), true);
      expect(embedded).toEqual([]);
      const after = await rows('notes/no-embed');
      const kept = after.filter(row => before.some(old => old.id === row.id));
      expect(kept.length).toBeGreaterThan(0);
      for (const row of kept) expect(row).toEqual(before.find(old => old.id === row.id)!);
      const stale = after.filter(row => row.embedding === null);
      expect(stale.length).toBeGreaterThan(0);
      expect(stale.every(row => String(row.chunk_text).includes('lima'))).toBe(true);
      // A fresh --no-embed import of the edited content stores the same text rows.
      await write('notes/no-embed-reference', page('NoEmbed', words), true);
      const strip = (list: Record<string, unknown>[]) => withoutId(list).map(({ embedding: _e, model: _m, token_count: _t, embedded_text_hash: _h, embedding_input_hash: _i, ...rest }) => rest);
      expect(strip(await rows('notes/no-embed-reference'))).toEqual(strip(after));
    }, 120_000);

    test('a --no-embed edit of a never-embedded page keeps its identical rows; an embedding import embeds them all', async () => {
      const words = ['quebec', 'romeo', 'sierra', 'tango', 'uniform'];
      await write('notes/keyless', page('Keyless', words), true);
      const before = await rows('notes/keyless');
      expect(before.every(row => row.embedding === null)).toBe(true);
      words[3] = 'victor';
      await write('notes/keyless', page('Keyless', words), true);
      const after = await rows('notes/keyless');
      const kept = after.filter(row => before.some(old => old.id === row.id));
      const unchanged = after.filter(row => before.some(old => old.chunk_index === row.chunk_index && old.chunk_text === row.chunk_text));
      expect(kept.length).toBeGreaterThan(0);
      expect(kept.map(row => row.id)).toEqual(unchanged.map(row => row.id));
      for (const row of kept) expect(row).toEqual(before.find(old => old.id === row.id)!);
      await write('notes/keyless-reference', page('Keyless', words), true);
      expect(withoutId(await rows('notes/keyless-reference'))).toEqual(withoutId(after));
      embedded = [];
      words[0] = 'whiskey';
      await write('notes/keyless', page('Keyless', words));
      const embeddedRows = await rows('notes/keyless');
      expect(embedded.length).toBe(embeddedRows.length);
      expect(embeddedRows.every(row => row.embedding !== null)).toBe(true);
    }, 120_000);

    test('an unchanged re-import with a protected fence keeps nothing', async () => {
      const fence = '\n<!--- gbrain:takes:begin -->\nPRIVATE_CANARY\n<!--- gbrain:takes:end -->\n';
      await write('notes/protected', page('Protected', ['mike', 'november', 'oscar'], fence));
      const before = await rows('notes/protected');
      await write('notes/protected', page('Protected', ['mike', 'november', 'papa'], fence), true);
      const after = await rows('notes/protected');
      expect(after.some(row => before.some(old => old.id === row.id))).toBe(false);
      expect(after.every(row => row.embedding === null)).toBe(true);
    }, 120_000);
  });
}
