/**
 * GBRA-156: search-time writes start after the response inside a request that defers them (the warm CLI socket), and
 * at once everywhere else (a cold CLI drains them before exit). Fails when: a sink starts mid-request inside a scope,
 * a write deferred by a scope never starts, or a sink outside any scope waits for a release that never comes.
 */
import { describe, expect, test } from 'bun:test';
import { deferUntilResponse, withResponseDeferral } from '../src/core/background-work.ts';
import { bumpLastRetrievedAt, BUMP_LAST_RETRIEVED_SQL, _resetTrackRetrievalCacheForTests } from '../src/core/last-retrieved.ts';
import type { BrainEngine } from '../src/core/engine.ts';

describe('response deferral', () => {
  test('outside a scope a write starts at once; inside one it waits for release, and one deferred after release starts at once', async () => {
    const started: string[] = [];
    deferUntilResponse(() => started.push('outside'));
    expect(started).toEqual(['outside']);
    const { value, release } = await withResponseDeferral(async () => {
      deferUntilResponse(() => started.push('first'));
      await Promise.resolve();
      deferUntilResponse(() => started.push('second'));
      expect(started).toEqual(['outside']);
      return 'answer';
    });
    expect(value).toBe('answer');
    expect(started).toEqual(['outside']);
    expect(release()).toBe(2);
    expect(started).toEqual(['outside', 'first', 'second']);
  });

  test('the page_retrievals bump issued mid-request reaches the database only after release', async () => {
    _resetTrackRetrievalCacheForTests();
    const statements: string[] = [];
    const engine = { getConfig: async () => null, executeRaw: async (sql: string) => { statements.push(sql); return []; } } as unknown as BrainEngine;
    const { release } = await withResponseDeferral(async () => { bumpLastRetrievedAt(engine, [1, 2]); await new Promise(r => setTimeout(r, 20)); });
    expect(statements).toEqual([]);
    release();
    await new Promise(r => setTimeout(r, 20));
    expect(statements).toEqual([BUMP_LAST_RETRIEVED_SQL]);
  });
});
