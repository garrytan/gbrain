/**
 * #6278: the memo rule (group-publish.ts). Protects: a claimed group's shared
 * preparation reads (`preparationReads`) stay shared when one member is cut
 * off: the member's cancellation lands at its own `enterClaimStep` boundary
 * and a signalled statement bypasses the memo, so an aborted member can never
 * reject a sibling's read. Fails when a member's signal is threaded into a
 * memoized statement (the memo would skip itself, costing GBRA-45's shared
 * read, or the abort would reject the shared promise).
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { preparationReads } from '../src/core/persistence/group-publish.ts';
import { enterClaimStep, startClaimPhase } from '../src/core/persistence/claim-phase.ts';

const STABLE = 'SELECT local_path FROM sources WHERE id=$1';

test('an aborted member never rejects a sibling\'s shared read, and the shared read goes out once', async () => {
  const gate = Promise.withResolvers<Array<{ local_path: string }>>();
  const calls: Array<{ sql: string; signal: boolean }> = [];
  const engine = { executeRaw: (sql: string, _params?: unknown[], opts?: { signal?: AbortSignal }) => {
    calls.push({ sql, signal: !!opts?.signal });
    return gate.promise;
  } } as unknown as BrainEngine;
  const reads = preparationReads(engine);
  const a = new AbortController(), b = new AbortController();
  const clockA = startClaimPhase(Date.now(), a.signal), clockB = startClaimPhase(Date.now(), b.signal);
  // Both members start the same read; member A's statement takes no signal (the clock carries it), so the memo answers both.
  const readA = reads.executeRaw(STABLE, ['default']);
  const readB = reads.executeRaw(STABLE, ['default']);
  expect(calls).toEqual([{ sql: STABLE, signal: false }]);
  // A's budget passes: its next boundary throws, B is untouched.
  a.abort({ code: 'preparation_deadline' });
  expect(() => enterClaimStep(clockA, 'configured_root', undefined, 'db')).toThrow();
  expect(() => enterClaimStep(clockB, 'configured_root', undefined, 'db')).not.toThrow();
  gate.resolve([{ local_path: '/brain' }]);
  expect(await readB).toEqual([{ local_path: '/brain' }]);
  expect(await readA).toEqual([{ local_path: '/brain' }]);
  // A statement that does take a signal bypasses the memo and reaches the engine on its own.
  const own = reads.executeRaw(STABLE, ['default'], { signal: b.signal });
  expect(calls).toHaveLength(2);
  expect(calls[1]).toEqual({ sql: STABLE, signal: true });
  await own;
});
