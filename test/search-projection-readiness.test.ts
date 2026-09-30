import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { operationsByName, type OperationContext } from '../src/core/operations.ts';
import { installFixtureChunks } from './helpers/page-projection.ts';

describe('search operations disclose visible projection gaps', () => {
  let engine: PGLiteEngine;
  let retrieval: Record<string, unknown>;
  const sourceId = 'readiness-visible-example';
  const foreign = 'readiness-foreign-example';

  beforeAll(async () => {
    engine = new PGLiteEngine();
    await engine.connect({});
    await engine.initSchema();
    for (const id of [sourceId, foreign]) {
      await engine.executeRaw('INSERT INTO sources(id, name) VALUES ($1, $1)', [id]);
    }
    await engine.setConfig('search.mcp_keyword_only', 'true');
  }, 60_000);

  beforeEach(async () => {
    retrieval = {};
    await engine.executeRaw('DELETE FROM pages WHERE source_id = ANY($1::text[])', [[sourceId, foreign]]);
  });

  afterAll(async () => { await engine?.disconnect(); });

  function context(remote: boolean): OperationContext {
    return {
      engine, config: { engine: 'pglite' }, dryRun: false, remote, sourceId,
      logger: { info() {}, warn() {}, error() {} },
      emitResponseMeta: (key, value) => { if (key === 'retrieval') retrieval = value as Record<string, unknown>; },
    } as OperationContext;
  }

  async function sealed(): Promise<void> {
    await engine.putPage('notes/current', { type: 'note', title: 'Synthetic current', compiled_truth: 'readinessmarker' }, { sourceId });
    await installFixtureChunks(engine, 'notes/current', [{
      chunk_index: 0, chunk_source: 'compiled_truth', chunk_text: 'readinessmarker',
    }], { sourceId });
  }

  test.each([false, true])('a nonempty result still discloses current-revision pending work, remote=%s', async remote => {
    await sealed();
    await engine.putPage('notes/pending', { type: 'note', title: 'Synthetic pending', compiled_truth: 'readinessmarker' }, { sourceId });
    const rows = await operationsByName.search.handler(context(remote), { query: 'readinessmarker', source_id: sourceId });
    expect(rows).toHaveLength(1);
    expect(retrieval.degraded).toContainEqual({ stage: 'projection_pending' });
    expect(retrieval.projection_readiness).toMatchObject({ status: 'projection_pending', ready: false });
  });

  test('pending pages outside the requested source do not affect readiness', async () => {
    await sealed();
    await engine.putPage('notes/foreign-pending', { type: 'note', title: 'Foreign example', compiled_truth: 'readinessmarker' }, { sourceId: foreign });
    await operationsByName.search.handler(context(true), { query: 'readinessmarker', source_id: sourceId });
    expect(retrieval.projection_readiness).toEqual({ status: 'ready', ready: true });
    expect(retrieval.degraded).toBeUndefined();
    expect(JSON.stringify(retrieval)).not.toContain(foreign);
  });

  test('private-only pending pages cannot be disclosed by an empty remote search', async () => {
    await engine.putPage('notes/private-pending', {
      type: 'note', title: 'Private synthetic example', compiled_truth: 'readinessmarker', frontmatter: { visibility: 'private' },
    }, { sourceId });
    await operationsByName.search.handler(context(true), { query: 'missingtoken', source_id: sourceId });
    expect(retrieval.projection_readiness).toEqual({ status: 'ready', ready: true });
    expect(retrieval.degraded).toBeUndefined();
  });

  test('the current-projection diagnostic honors the public type filter', async () => {
    await sealed();
    await engine.putPage('articles/pending', { type: 'article', title: 'Synthetic article', compiled_truth: 'readinessmarker' }, { sourceId });
    const rows = await operationsByName.search.handler(context(true), { query: 'readinessmarker', source_id: sourceId, types: ['note'] });
    expect(rows).toHaveLength(1);
    expect(retrieval.projection_readiness).toEqual({ status: 'ready', ready: true });
    expect(retrieval.degraded).toBeUndefined();
  });
});
