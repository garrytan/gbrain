import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { prepareEmbeddingProjections } from '../src/core/embedding-readiness.ts';
import { mockEmbedProjectionEngine } from './helpers/embed-projection-mock.ts';

test('projection fixture count models its sealed snapshots', async () => {
  const engine = mockEmbedProjectionEngine();
  const snapshot = await engine.readPageSnapshot('synthetic-fixture');
  expect(snapshot?.page.text_projection_revision).toBe(snapshot?.page.knowledge_revision);
  expect(await prepareEmbeddingProjections(engine)).toEqual({ rebuilt: 0, blocked: 0 });
});

test.each([undefined, null, NaN, -1, 'unknown'])('projection readiness rejects an unknown or invalid count: %s', async n => {
  const engine = { executeRaw: async (sql: string) => sql.startsWith('SELECT count(') ? [{ n }] : [] } as unknown as BrainEngine;
  await expect(prepareEmbeddingProjections(engine)).rejects.toThrow('Cannot determine pending embedding projections');
});

test('projection readiness rejects missing count rows', async () => {
  const engine = { executeRaw: async () => [] } as unknown as BrainEngine;
  await expect(prepareEmbeddingProjections(engine)).rejects.toThrow('Cannot determine pending embedding projections');
});

test('projection readiness propagates count failures', async () => {
  const engine = { executeRaw: async (sql: string) => {
    if (sql.startsWith('SELECT count(')) throw new Error('synthetic count failure');
    return [];
  } } as unknown as BrainEngine;
  await expect(prepareEmbeddingProjections(engine)).rejects.toThrow('synthetic count failure');
});

test('projection recovery stops after a batch makes no progress', async () => {
  let batches = 0;
  const engine = mockEmbedProjectionEngine({
    readPageSnapshot: async () => null,
    executeRaw: async (sql: string) => {
      if (sql.startsWith('SELECT count(')) return [{ n: 1 }];
      if (sql.startsWith('SELECT p.slug,p.source_id')) {
        batches++;
        return [{ slug: 'synthetic-unavailable', source_id: 'default' }];
      }
      return [];
    },
  });
  expect(await prepareEmbeddingProjections(engine, { repair: true })).toEqual({ rebuilt: 0, blocked: 1 });
  expect(batches).toBe(1);
});
