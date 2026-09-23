import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../../src/core/engine.ts';
import { findCodeDef } from '../../src/commands/code-def.ts';
import { findCodeRefs } from '../../src/commands/code-refs.ts';
import { probeProjectionReadiness } from '../../src/core/search/projection-readiness.ts';
import { isolatedPersistencePostgres } from '../helpers/persistence-postgres.ts';
import { hasDatabase } from './helpers.ts';

const describePostgres = hasDatabase() ? describe : describe.skip;

describePostgres('Postgres code-read currency and scoped projection readiness', () => {
  let engine: BrainEngine;
  let close: () => Promise<void>;

  beforeAll(async () => {
    ({ engine, close } = await isolatedPersistencePostgres(process.env.DATABASE_URL!));
  }, 120_000);

  afterAll(async () => { await close?.(); });

  beforeEach(async () => {
    await engine.executeRaw('DELETE FROM pages');
    await engine.executeRaw("INSERT INTO sources(id,name) VALUES ('readiness-a','readiness-a'),('readiness-b','readiness-b') ON CONFLICT DO NOTHING");
    await engine.executeRaw('UPDATE sources SET archived=false');
  });

  async function seed(source: string, slug: string, kind = 'code', privatePage = false) {
    const [page] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO pages(source_id,slug,title,type,page_kind,compiled_truth,chunker_version,frontmatter)
       VALUES ($1,$2,'Example','code',$3,'function readExample() {}',999,$4::text::jsonb) RETURNING id`,
      [source, slug, kind, JSON.stringify(privatePage ? { visibility: 'private' } : {})],
    );
    const [chunk] = await engine.executeRaw<{ id: number }>(
      `INSERT INTO content_chunks(page_id,chunk_index,chunk_text,symbol_name,symbol_type,language)
       VALUES ($1,0,'function readExample() {}','readExample','function','typescript') RETURNING id`, [page.id],
    );
    await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [page.id]);
    return { page: page.id, chunk: chunk.id };
  }

  test('partial code and Markdown corpora stay pending independent of chunker version', async () => {
    await seed('readiness-a', 'src/current.ts');
    for (const kind of ['code', 'markdown']) {
      const stale = await seed('readiness-a', `pending-${kind}`, kind);
      await engine.executeRaw('UPDATE pages SET text_projection_revision=gen_random_uuid() WHERE id=$1', [stale.page]);
      expect((await probeProjectionReadiness(engine, { sourceId: 'readiness-a', pageKind: kind })).status).toBe('projection_pending');
      expect(await findCodeDef(engine, 'readExample', { sourceId: 'readiness-a' })).toHaveLength(kind === 'code' ? 1 : 2);
      await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [stale.page]);
    }
    expect((await probeProjectionReadiness(engine, { sourceId: 'readiness-a' })).status).toBe('ready');
  });

  test('private-only and out-of-grant pending rows do not disclose their existence', async () => {
    await seed('readiness-a', 'src/shared.ts');
    const hidden = await seed('readiness-b', 'src/shared.ts', 'code', true);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [hidden.page]);
    expect(await probeProjectionReadiness(engine, { sourceIds: ['readiness-a', 'readiness-b'], excludePrivate: true })).toEqual({ status: 'ready', ready: true });
    expect(await probeProjectionReadiness(engine, { sourceIds: ['readiness-a'] })).toEqual({ status: 'ready', ready: true });
    const defs = await findCodeDef(engine, 'readExample', { sourceId: 'readiness-b', sourceIds: ['readiness-a'], language: 'typescript' });
    const refs = await findCodeRefs(engine, 'readExample', { sourceIds: ['readiness-a', 'readiness-b'], excludePrivate: true });
    expect(defs.map(r => r.source_id)).toEqual(['readiness-a']);
    expect(refs.map(r => r.source_id)).toEqual(['readiness-a']);
  });

  test('resolved and unresolved caller queries require current live endpoints', async () => {
    const caller = await seed('readiness-a', 'src/caller.ts');
    const target = await seed('readiness-a', 'src/target.ts');
    await engine.addCodeEdges([
      { from_chunk_id: caller.chunk, to_chunk_id: target.chunk, from_symbol_qualified: 'callerExample', to_symbol_qualified: 'targetExample', edge_type: 'calls', source_id: 'readiness-a' },
      { from_chunk_id: caller.chunk, from_symbol_qualified: 'callerExample', to_symbol_qualified: 'externalExample', edge_type: 'calls', source_id: 'readiness-a' },
    ]);
    expect(await engine.getCallersOf('targetExample', { sourceId: 'readiness-a' })).toHaveLength(1);
    expect(await engine.getCalleesOf('callerExample', { sourceId: 'readiness-a' })).toHaveLength(2);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [target.page]);
    expect(await engine.getCallersOf('targetExample', { sourceId: 'readiness-a' })).toHaveLength(0);
    expect(await engine.getCalleesOf('callerExample', { sourceId: 'readiness-a' })).toHaveLength(1);
    await engine.executeRaw('UPDATE pages SET deleted_at=NOW() WHERE id=$1', [caller.page]);
    expect(await engine.getCalleesOf('callerExample', { sourceId: 'readiness-a' })).toHaveLength(0);
    expect(await findCodeDef(engine, 'readExample', { sourceId: 'readiness-a' })).toHaveLength(0);
  });
});
