import { describe, expect, test } from 'bun:test';
import {
  DerivedLinkEndpointChangedError, DerivedLinkSettingsChangedError,
  replaceDerivedLinksBatchOrReplay, type DerivedLinkBatchItem,
} from '../src/core/derived-links.ts';
import type { BrainEngine } from '../src/core/engine.ts';

const items: DerivedLinkBatchItem[] = ['endpoint', 'settings', 'healthy'].map(slug => ({
  origin: { slug, sourceId: 'default', expectedRevision: 'revision', sourceIncarnation: 'incarnation' }, links: [],
}));

function failingBatch(error: Error) {
  const visited: string[] = [];
  const engine: Pick<BrainEngine, 'replaceDerivedLinks' | 'replaceDerivedLinksBatch'> = {
    replaceDerivedLinksBatch: async () => { throw error; },
    replaceDerivedLinks: async origin => {
      visited.push(origin.slug);
      if (origin.slug === 'endpoint') throw error;
      if (origin.slug === 'settings') throw new DerivedLinkSettingsChangedError();
      return { created: 1, removed: 0 };
    },
  };
  return { engine, visited };
}

describe('derived-link batch endpoint deferral', () => {
  test('opt-in replay defers the endpoint, preserves settings skips and commits healthy siblings', async () => {
    const { engine, visited } = failingBatch(new DerivedLinkEndpointChangedError('endpoint moved'));
    const deferred: DerivedLinkBatchItem[] = [], errors: DerivedLinkBatchItem[] = [];
    expect(await replaceDerivedLinksBatchOrReplay(engine, items, item => { errors.push(item); }, item => { deferred.push(item); }))
      .toEqual([null, null, { created: 1, removed: 0 }]);
    expect(visited).toEqual(['endpoint', 'settings', 'healthy']);
    expect(deferred).toEqual([items[0]]);
    expect(errors).toEqual([]);
  });

  test('callers without opt-in still refuse changed endpoints', async () => {
    const error = new DerivedLinkEndpointChangedError('endpoint moved');
    const { engine, visited } = failingBatch(error);
    const errors: DerivedLinkBatchItem[] = [];
    await expect(replaceDerivedLinksBatchOrReplay(engine, items, item => { errors.push(item); })).rejects.toBe(error);
    expect(visited).toEqual(['endpoint']);
    expect(errors).toEqual([items[0]]);
  });

  test('plain revision conflicts remain fatal even with endpoint opt-in', async () => {
    const error = Object.assign(new Error('origin moved'), { code: 'revision_conflict' });
    const { engine, visited } = failingBatch(error);
    const deferred: DerivedLinkBatchItem[] = [], errors: DerivedLinkBatchItem[] = [];
    await expect(replaceDerivedLinksBatchOrReplay(engine, items, item => { errors.push(item); }, item => { deferred.push(item); }))
      .rejects.toBe(error);
    expect(visited).toEqual(['endpoint']);
    expect(deferred).toEqual([]);
    expect(errors).toEqual([items[0]]);
  });
});
