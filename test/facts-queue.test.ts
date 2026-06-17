/**
 * v0.31 Phase 6 — bounded queue tests.
 *
 * Pins: cap-100 drop-oldest, per-session in-flight=1, AbortSignal grace
 * shutdown, drop counter under overflow + shutdown.
 */

import { describe, test, expect, beforeEach } from 'bun:test';
import { FactsQueue, __resetFactsQueueForTests } from '../src/core/facts/queue.ts';

beforeEach(() => {
  __resetFactsQueueForTests();
});

const sleep = (ms: number) => new Promise<void>(r => setTimeout(r, ms));

describe('FactsQueue.enqueue', () => {
  test('runs jobs in FIFO order within a single session', async () => {
    const q = new FactsQueue({ cap: 10 });
    const seen: number[] = [];
    for (let i = 0; i < 3; i++) {
      q.enqueue(async () => { seen.push(i); }, 'sess');
    }
    await sleep(50);
    expect(seen).toEqual([0, 1, 2]);
    expect(q.getCounters().completed).toBe(3);
  });

  test('drop-oldest on cap overflow', async () => {
    const q = new FactsQueue({ cap: 3, perSessionInflightCap: 1 });
    const seen: number[] = [];
    // First job blocks for a while so the queue accumulates.
    q.enqueue(async () => { await sleep(40); seen.push(0); }, 'sess');
    // 4 more — capacity is 3 and one is in-flight, so 1 of these gets dropped.
    q.enqueue(async () => { seen.push(1); }, 'sess');
    q.enqueue(async () => { seen.push(2); }, 'sess');
    q.enqueue(async () => { seen.push(3); }, 'sess');
    q.enqueue(async () => { seen.push(4); }, 'sess'); // oldest pending (1) drops here
    await sleep(200);
    expect(q.getCounters().dropped_overflow).toBeGreaterThanOrEqual(1);
    // The dropped job was NOT run (its handler never executed).
    expect(seen.length).toBeLessThan(5);
  });

  test('per-session in-flight cap=1 serializes the same session', async () => {
    const q = new FactsQueue({ cap: 10, perSessionInflightCap: 1 });
    const log: string[] = [];
    q.enqueue(async () => {
      log.push('a-start');
      await sleep(40);
      log.push('a-end');
    }, 'sess');
    q.enqueue(async () => {
      log.push('b-start');
      await sleep(20);
      log.push('b-end');
    }, 'sess');
    await sleep(100);
    // a must finish before b starts within the same session.
    expect(log).toEqual(['a-start', 'a-end', 'b-start', 'b-end']);
  });

  test('different sessions run in parallel', async () => {
    const q = new FactsQueue({ cap: 10, perSessionInflightCap: 1 });
    const log: string[] = [];
    q.enqueue(async () => { log.push('a-start'); await sleep(40); log.push('a-end'); }, 'sess-A');
    q.enqueue(async () => { log.push('b-start'); await sleep(40); log.push('b-end'); }, 'sess-B');
    await sleep(80);
    // Both started before either ended.
    const aStart = log.indexOf('a-start');
    const bStart = log.indexOf('b-start');
    const aEnd = log.indexOf('a-end');
    expect(bStart).toBeLessThan(aEnd);
    expect(aStart).toBeLessThan(aEnd);
  });

  test('failed jobs increment failed counter', async () => {
    const q = new FactsQueue({ cap: 10 });
    q.enqueue(async () => { throw new Error('boom'); }, 'sess');
    await sleep(50);
    expect(q.getCounters().failed).toBe(1);
    expect(q.getCounters().completed).toBe(0);
  });
});

describe('FactsQueue.shutdown', () => {
  test('drains in-flight within grace window', async () => {
    const q = new FactsQueue({ cap: 10, perSessionInflightCap: 5, shutdownGraceMs: 200 });
    let aFinished = false;
    q.enqueue(async () => {
      await sleep(30);
      aFinished = true;
    }, 'sess');
    await sleep(5);
    await q.shutdown();
    expect(aFinished).toBe(true);
    expect(q.getCounters().completed).toBe(1);
  });

  test('drops pending entries with dropped_shutdown counter', async () => {
    const q = new FactsQueue({ cap: 10, perSessionInflightCap: 1, shutdownGraceMs: 30 });
    q.enqueue(async () => { await sleep(20); }, 'sess');
    q.enqueue(async () => { /* never runs */ }, 'sess');
    q.enqueue(async () => { /* never runs */ }, 'sess');
    await sleep(2);
    await q.shutdown();
    expect(q.getCounters().dropped_shutdown).toBeGreaterThanOrEqual(2);
  });

  test('rejects new enqueues after shutdown', async () => {
    const q = new FactsQueue({ cap: 10 });
    await q.shutdown();
    const result = q.enqueue(async () => {}, 'sess');
    expect(result).toBe(-1);
  });

  test('external abort signal triggers shutdown', async () => {
    const ac = new AbortController();
    const q = new FactsQueue({ cap: 10, abortSignal: ac.signal, shutdownGraceMs: 30 });
    q.enqueue(async () => { /* never runs */ }, 'sess');
    ac.abort();
    await sleep(60);
    expect(q.getCounters().dropped_shutdown).toBeGreaterThanOrEqual(1);
    // New enqueues are rejected.
    expect(q.enqueue(async () => {}, 'sess')).toBe(-1);
  });
});
