import { afterAll, beforeAll, beforeEach, describe, expect, spyOn, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { findCodeDef, probeFilteredSymbolTypes, runCodeDef } from '../src/commands/code-def.ts';
import { findCodeRefs, runCodeRefs } from '../src/commands/code-refs.ts';
import { runCodeCallers } from '../src/commands/code-callers.ts';
import { runCodeCallees } from '../src/commands/code-callees.ts';
import { resolveCodeReadiness } from '../src/core/code-graph-readiness.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  for (const source of ['source-a', 'source-b']) {
    await engine.executeRaw('INSERT INTO sources (id,name) VALUES ($1,$1)', [source]);
  }
});

async function seed(source = 'source-a', slug = 'src/shared.ts', symbolType = 'function', frontmatter = {}) {
  const [page] = await engine.executeRaw<{ id: number }>(
    `INSERT INTO pages (source_id,slug,title,type,page_kind,compiled_truth,frontmatter,chunker_version)
     VALUES ($1,$2,'Example','code','code','function sampleSymbol() {}',$3::text::jsonb,999) RETURNING id`,
    [source, slug, JSON.stringify(frontmatter)],
  );
  await engine.executeRaw(
    `INSERT INTO content_chunks(page_id,chunk_index,chunk_text,chunk_source,language,symbol_name,symbol_type)
     VALUES ($1,0,'function sampleSymbol() {}','compiled_truth','typescript','sampleSymbol',$2)`,
    [page.id, symbolType],
  );
  await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [page.id]);
  return page.id;
}

describe('code definition and reference currency', () => {
  for (const [name, find] of [['definitions', findCodeDef], ['references', findCodeRefs]] as const) {
    for (const invalid of ['null', 'mismatched', 'deleted', 'archived']) {
      test(`${name} exclude ${invalid} rows even when their chunks remain`, async () => {
        const id = await seed();
        expect(await find(engine, 'sampleSymbol', { sourceId: 'source-a' })).toHaveLength(1);
        if (invalid === 'null') await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [id]);
        if (invalid === 'mismatched') await engine.executeRaw('UPDATE pages SET text_projection_revision=gen_random_uuid() WHERE id=$1', [id]);
        if (invalid === 'deleted') await engine.executeRaw('UPDATE pages SET deleted_at=NOW() WHERE id=$1', [id]);
        if (invalid === 'archived') await engine.executeRaw("UPDATE sources SET archived=true WHERE id='source-a'");
        expect(await find(engine, 'sampleSymbol', { sourceId: 'source-a' })).toHaveLength(0);
      });
    }

    test(`${name} distinguish duplicate slugs, compose bound filters and honor array grants`, async () => {
      await seed();
      await seed('source-b');
      const rows = await find(engine, 'sampleSymbol', { sourceId: 'source-b', sourceIds: ['source-a'], language: 'typescript', limit: 1 });
      expect(rows).toHaveLength(1);
      expect(rows[0].source_id).toBe('source-a');
      expect(await find(engine, 'sampleSymbol', { sourceIds: [] })).toHaveLength(0);
      expect(await find(engine, 'sampleSymbol', { sourceId: "source-a' OR TRUE--" })).toHaveLength(0);
      expect(await find(engine, 'sampleSymbol', { sourceIds: ['source-a', 'source-b'] })).toHaveLength(2);
    });

    test(`${name} apply private visibility without taking it from caller parameters`, async () => {
      await seed('source-a', 'src/shared.ts', 'function', { visibility: 'private' });
      expect(await find(engine, 'sampleSymbol', { excludePrivate: true })).toHaveLength(0);
      expect(await find(engine, 'sampleSymbol', { excludePrivate: false })).toHaveLength(1);
    });
  }

  test('filtered symbol diagnostics use the same currency and visibility guards', async () => {
    const id = await seed('source-a', 'src/shared.ts', 'unsupported_wrapper');
    expect(await probeFilteredSymbolTypes(engine, 'sampleSymbol', { sourceId: 'source-a' })).toEqual(['unsupported_wrapper']);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [id]);
    expect(await probeFilteredSymbolTypes(engine, 'sampleSymbol', { sourceId: 'source-a' })).toEqual([]);
  });

  for (const endpoint of ['caller', 'target']) {
    for (const invalid of ['null', 'mismatched', 'deleted', 'archived']) {
      test(`caller and callee queries reject a ${invalid} ${endpoint} projection`, async () => {
        const from = await seed('source-a', 'src/caller.ts');
        const target = await seed('source-b', 'src/target.ts');
        const chunks = await engine.executeRaw<{ id: number; page_id: number }>('SELECT id,page_id FROM content_chunks');
        await engine.addCodeEdges([{
          from_chunk_id: chunks.find(c => c.page_id === from)!.id,
          to_chunk_id: chunks.find(c => c.page_id === target)!.id,
          from_symbol_qualified: 'callerExample', to_symbol_qualified: 'sampleSymbol',
          edge_type: 'calls', source_id: 'source-a',
        }]);
        expect(await engine.getCallersOf('sampleSymbol', { sourceId: 'source-a' })).toHaveLength(1);
        expect(await engine.getCalleesOf('callerExample', { sourceId: 'source-a' })).toHaveLength(1);
        const id = endpoint === 'caller' ? from : target;
        if (invalid === 'null') await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [id]);
        if (invalid === 'mismatched') await engine.executeRaw('UPDATE pages SET text_projection_revision=gen_random_uuid() WHERE id=$1', [id]);
        if (invalid === 'deleted') await engine.executeRaw('UPDATE pages SET deleted_at=NOW() WHERE id=$1', [id]);
        if (invalid === 'archived') await engine.executeRaw('UPDATE sources SET archived=true WHERE id=$1', [endpoint === 'caller' ? 'source-a' : 'source-b']);
        expect(await engine.getCallersOf('sampleSymbol', { sourceId: 'source-a' })).toHaveLength(0);
        expect(await engine.getCalleesOf('callerExample', { sourceId: 'source-a' })).toHaveLength(0);
      });
    }
  }

  test('unresolved caller edges are withheld when their concrete origin is stale', async () => {
    const id = await seed();
    const [chunk] = await engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks WHERE page_id=$1', [id]);
    await engine.addCodeEdges([{
      from_chunk_id: chunk.id, from_symbol_qualified: 'callerExample', to_symbol_qualified: 'sampleSymbol',
      edge_type: 'calls', source_id: 'source-a',
    }]);
    expect(await engine.getCallersOf('sampleSymbol', { sourceId: 'source-a' })).toHaveLength(1);
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [id]);
    expect(await engine.getCallersOf('sampleSymbol', { sourceId: 'source-a' })).toHaveLength(0);
    expect(await engine.getCalleesOf('callerExample', { sourceId: 'source-a' })).toHaveLength(0);
  });

  test('trusted-local operation wrappers preserve brain-wide reads while excluding stale definitions', async () => {
    const id = await seed('source-b');
    const ctx = { engine, remote: false, sourceId: 'source-a' } as unknown as OperationContext;
    for (const name of ['code_def', 'code_refs']) {
      const current = await operationsByName[name].handler(ctx, { symbol: 'sampleSymbol' }) as any;
      expect(current.count).toBe(1);
      expect(current.status).toBe('ready');
    }
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [id]);
    for (const name of ['code_def', 'code_refs']) {
      const stale = await operationsByName[name].handler(ctx, { symbol: 'sampleSymbol' }) as any;
      expect(stale.count).toBe(0);
      expect(stale.status).toBe('projection_pending');
    }
  });

  for (const run of [runCodeDef, runCodeRefs]) {
    test(`${run.name} reports pending with partial nonempty results, then ready after recovery`, async () => {
      await seed();
      const pending = await seed('source-a', 'src/pending.ts');
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [pending]);
      const output: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((text) => { output.push(String(text)); });
      try {
        await run(engine, ['sampleSymbol', '--source', 'source-a', '--json']);
        const first = JSON.parse(output.pop()!);
        expect(first.count).toBe(1);
        expect(first.status).toBe('projection_pending');
        expect(first.ready).toBe(false);
        expect(first.hint).toContain('incomplete');
        await engine.executeRaw('UPDATE pages SET text_projection_revision=knowledge_revision WHERE id=$1', [pending]);
        await run(engine, ['sampleSymbol', '--source', 'source-a', '--json']);
        const recovered = JSON.parse(output.pop()!);
        expect(recovered.count).toBe(2);
        expect(recovered.status).toBe('ready');
      } finally {
        log.mockRestore();
      }
    });
  }

  for (const run of [runCodeCallers, runCodeCallees]) {
    test(`${run.name} gives recovery advice for partial and empty results, not scope widening`, async () => {
      const current = await seed();
      const pending = await seed('source-a', 'src/pending.ts');
      const [chunk] = await engine.executeRaw<{ id: number }>('SELECT id FROM content_chunks WHERE page_id=$1', [current]);
      await engine.addCodeEdges([{
        from_chunk_id: chunk.id, to_chunk_id: chunk.id, from_symbol_qualified: 'sampleSymbol', to_symbol_qualified: 'sampleSymbol',
        edge_type: 'calls', source_id: 'source-a',
      }]);
      await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [pending]);
      const output: string[] = [];
      const log = spyOn(console, 'log').mockImplementation((text) => { output.push(String(text)); });
      try {
        for (const count of [1, 0]) {
          await run(engine, ['sampleSymbol', '--source', 'source-a', '--json']);
          const result = JSON.parse(output.pop()!);
          expect(result.count).toBe(count);
          expect(result.status).toBe('projection_pending');
          expect(result.hint).toContain('incomplete');
          expect(result.hint).not.toContain('--all-sources');
          await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [current]);
        }
      } finally {
        log.mockRestore();
      }
    });
  }

  test('hidden-only pending code never changes remote readiness, and probe failure is unknown even with hits', async () => {
    const id = await seed('source-b', 'src/hidden.ts', 'function', { visibility: 'private' });
    await engine.executeRaw('UPDATE pages SET text_projection_revision=NULL WHERE id=$1', [id]);
    const result = await resolveCodeReadiness(engine, { kind: 'symbol', count: 0, sourceIds: ['source-a', 'source-b'], remote: true, excludePrivate: true });
    expect(result.status).toBe('not_built');
    expect(JSON.stringify(result)).not.toContain('hidden');
    const unknown = await resolveCodeReadiness({ executeRaw: async () => { throw new Error('unavailable'); } } as any,
      { kind: 'symbol', count: 1, remote: false, excludePrivate: false });
    expect(unknown.status).toBe('unknown');
    expect(unknown.ready).toBe(false);
  });

  for (const name of ['code_def', 'code_refs', 'code_callers', 'code_callees']) {
    test(`${name} remains suspended for remote and omitted trust before touching storage`, async () => {
      let reads = 0;
      const inaccessible = new Proxy({}, { get() { reads++; throw new Error('storage access'); } });
      for (const remote of [true, undefined]) {
        await expect(operationsByName[name].handler({ engine: inaccessible, remote,
          sourceId: 'source-a', auth: { allowedSources: ['source-a'] } } as unknown as OperationContext,
        { symbol: 'sampleSymbol' })).rejects.toThrow('temporarily unavailable');
      }
      expect(reads).toBe(0);
    });
  }
});
