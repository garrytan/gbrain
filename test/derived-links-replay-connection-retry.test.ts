import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { replaceDerivedLinksBatchOrReplay } from '../src/core/derived-links.ts';
import { withEnv } from './helpers/with-env.ts';

const item = { origin: { slug: 'notes/x', sourceId: 'default', expectedRevision: '00000000-0000-0000-0000-000000000000', sourceIncarnation: '00000000-0000-0000-0000-000000000000' }, links: [] };

// A transient connection loss during the one-by-one replay used to escape and end the whole extract walk.
test('the replay retries a transient connection error instead of aborting the walk', async () => {
  await withEnv({ GBRAIN_BULK_RETRY_BASE_MS: '1', GBRAIN_BULK_RETRY_MAX_MS: '2' }, async () => {
    let calls = 0;
    const engine = {
      replaceDerivedLinksBatch: async () => { throw new Error('batch failed'); },
      replaceDerivedLinks: async () => {
        if (++calls <= 2) throw Object.assign(new Error('getaddrinfo ENOTFOUND pooler.invalid'), { code: 'ENOTFOUND' });
        return { created: 1, removed: 0 };
      },
    } as unknown as BrainEngine;
    const outcome = await replaceDerivedLinksBatchOrReplay(engine, [item]).then(value => ({ value }), error => ({ error }));
    expect(outcome).toEqual({ value: [{ created: 1, removed: 0 }] });
    expect(calls).toBe(3);
  });
});

test('a connection error that never recovers still escapes after bounded attempts', async () => {
  await withEnv({ GBRAIN_BULK_RETRY_BASE_MS: '1', GBRAIN_BULK_RETRY_MAX_MS: '2', GBRAIN_BULK_MAX_RETRIES: '2' }, async () => {
    let calls = 0;
    const down = Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' });
    const engine = {
      replaceDerivedLinksBatch: async () => { throw down; },
      replaceDerivedLinks: async () => { calls++; throw down; },
    } as unknown as BrainEngine;
    const outcome = await replaceDerivedLinksBatchOrReplay(engine, [item]).then(() => null, error => error);
    expect(outcome).toBe(down);
    expect(calls).toBe(3);
  });
});
