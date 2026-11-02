/**
 * GBRA-218: work a remote request spawns does not run under that caller's
 * access record. The spawn sites:
 *  - the persistence consumer's tick timer (publication, post-commit effects,
 *    recovery scans): a request's wake() schedules it (consumer.ts schedule);
 *  - the facts queue pump (facts/queue.ts enqueue), fed by post-write
 *    extraction backstops;
 * Each is entered through withoutCallerAccess, so a tick or job runs with the
 * empty identity and the process's privacy default, never with the member
 * identity (or relaxation) of whichever request woke it.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { currentCallerAccess, withCallerAccess } from '../src/core/search/private-visibility.ts';
import { startPersistenceConsumer, disposePersistenceConsumer } from '../src/core/persistence/service.ts';
import { FactsQueue } from '../src/core/facts/queue.ts';

const ALICE = { identity: ['member:alice-example', 'group:team-a'], hidePrivate: false, privateReadableSources: ['source-a'] };
const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

describe('spawned work runs outside the caller access record', () => {
  let engine: BrainEngine;
  beforeAll(async () => {
    engine = new PGLiteEngine(); await engine.connect({ engine: 'pglite' } as never); await engine.initSchema();
  }, 120_000);
  afterAll(async () => { await disposePersistenceConsumer(engine); await engine.disconnect(); });

  test('the persistence consumer, started and woken inside a member request, runs its ticks with no caller record', async () => {
    const seen: string[][] = [];
    await withCallerAccess(ALICE, async () => {
      const consumer = startPersistenceConsumer(engine, { engine: 'pglite' } as never) as unknown as { tick(afterProgress?: boolean): Promise<void>; wake(progress?: boolean): void };
      const tick = consumer.tick.bind(consumer);
      consumer.tick = (afterProgress?: boolean) => { seen.push([...currentCallerAccess().identity]); return tick(afterProgress); };
      consumer.wake(true);
    });
    await sleep(800);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.filter(identity => identity.length > 0)).toEqual([]);
  }, 60_000);

  test('a facts job enqueued inside a member request runs with no caller record', async () => {
    const queue = new FactsQueue();
    let inside: ReturnType<typeof currentCallerAccess> | undefined;
    const outside = currentCallerAccess();
    withCallerAccess(ALICE, () => queue.enqueue(async () => { inside = currentCallerAccess(); }, 'session-a'));
    await queue.drainPending({ timeout: 2000 });
    expect(inside).toEqual(outside);
    expect(inside?.identity).toEqual([]);
  }, 30_000);
});
