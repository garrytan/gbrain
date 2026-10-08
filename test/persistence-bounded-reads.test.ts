/**
 * #6278 (plan item 1.4): `boundedReads`, the engine view a preparer reads
 * through. Protects: a raw statement runs with `timeoutMs` set to the clock's
 * remaining budget and the clock's signal (which ends only the wait for a
 * connection); a caller's own signal keeps its statement unbounded; the view
 * is the engine itself without a deadline or on PGLite; a statement the
 * server ends at the bound (57014, or a 55P03 lock timeout) surfaces as the
 * member's `preparation_deadline` (the signal's reason once it aborted, the
 * typed error naming the step before that), which `preparationAbortReason`
 * classifies as the deadline, never a terminal failure; any other error
 * passes through; and a group's shared read (`preparationReads`) answers a
 * bounded read once with the bound and signal dropped. Fails when the bound
 * stops reaching the statement, when a server timeout is left as a raw
 * Postgres error (a `storage_error` receipt), or when a member's bound leaks
 * into a sibling's shared read.
 */
import { expect, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import { boundedReads, isStatementTimeout, PreparationDeadlineError } from '../src/core/persistence/bounded-reads.ts';
import { startClaimPhase, enterClaimStep } from '../src/core/persistence/claim-phase.ts';
import { preparationAbortReason } from '../src/core/persistence/coordinator.ts';
import { preparationReads } from '../src/core/persistence/group-publish.ts';

type Call = { sql: string; opts?: { signal?: AbortSignal; timeoutMs?: number } };
function fakeEngine(kind: 'postgres' | 'pglite', respond: (call: Call) => Promise<unknown[]>) {
  const calls: Call[] = [];
  const engine = { kind, executeRaw: (sql: string, _params?: unknown[], opts?: Call['opts']) => { const call = { sql, opts }; calls.push(call); return respond(call); },
    getConfig: async () => null } as unknown as BrainEngine;
  return { engine, calls };
}
const pgError = (code: string, message: string) => Object.assign(new Error(message), { code });

test('a raw statement runs with the remaining budget and the clock\'s signal; a caller\'s signal keeps it unbounded', async () => {
  const { engine, calls } = fakeEngine('postgres', async () => [{ ok: true }]);
  const cancel = new AbortController();
  const clock = startClaimPhase(Date.now(), cancel.signal, 10_000);
  const reads = boundedReads(engine, clock);
  expect(await reads.executeRaw('SELECT 1 FROM pages')).toEqual([{ ok: true }]);
  expect(calls[0]!.opts!.timeoutMs).toBeGreaterThan(9_000);
  expect(calls[0]!.opts!.timeoutMs).toBeLessThanOrEqual(10_000);
  expect(calls[0]!.opts!.signal).toBe(cancel.signal);
  const own = new AbortController();
  await reads.executeRaw('SELECT 1 FROM pages', [], { signal: own.signal });
  expect(calls[1]!.opts).toEqual({ signal: own.signal });
  // Other members are the engine's own.
  expect(typeof reads.getConfig).toBe('function');
});

test('without a deadline, or on PGLite, the view is the engine itself', () => {
  const { engine } = fakeEngine('postgres', async () => []);
  expect(boundedReads(engine, undefined)).toBe(engine);
  expect(boundedReads(engine, startClaimPhase(Date.now(), new AbortController().signal))).toBe(engine);
  const pglite = fakeEngine('pglite', async () => []).engine;
  expect(boundedReads(pglite, startClaimPhase(Date.now(), undefined, 5_000))).toBe(pglite);
});

test('a statement the server ends at the bound is the member\'s preparation_deadline; the signal\'s reason once it aborted; other errors pass through', async () => {
  let fail: unknown = pgError('57014', 'canceling statement due to statement timeout');
  const { engine } = fakeEngine('postgres', async () => { throw fail; });
  const cancel = new AbortController();
  const clock = startClaimPhase(Date.now(), cancel.signal, 10_000);
  enterClaimStep(clock, 'origin_check', undefined, 'db');
  const reads = boundedReads(engine, clock);
  const error = await reads.executeRaw('SELECT id FROM pages').catch(e => e);
  expect(error).toBeInstanceOf(PreparationDeadlineError);
  expect(error).toMatchObject({ code: 'preparation_deadline', step: 'origin_check', sqlstate: '57014' });
  expect(error.message).toContain('step origin_check');
  expect(preparationAbortReason(error, cancel.signal)).toBe('preparation_deadline');
  // A shorter session lock_timeout raised by the same lock wait is the same deadline.
  fail = pgError('55P03', 'canceling statement due to lock timeout');
  expect(await reads.executeRaw('SELECT id FROM pages').catch(e => e)).toMatchObject({ code: 'preparation_deadline', sqlstate: '55P03' });
  // Any other failure is the preparer's own.
  fail = pgError('42P01', 'relation "pages" does not exist');
  expect(await reads.executeRaw('SELECT id FROM pages').catch(e => e)).toBe(fail);
  expect(isStatementTimeout(fail)).toBe(false);
  // The budget passed on this side first: the error is the abort reason the consumer already knows.
  fail = pgError('57014', 'canceling statement due to statement timeout');
  cancel.abort({ code: 'group_member_waiting' });
  expect(await reads.executeRaw('SELECT id FROM pages').catch(e => e)).toEqual({ code: 'group_member_waiting' });
});

test('a group\'s shared read answers a bounded read once, with the member\'s bound and signal dropped', async () => {
  const STABLE = 'SELECT local_path FROM sources WHERE id=$1';
  const { engine, calls } = fakeEngine('postgres', async () => [{ local_path: '/brain' }]);
  const shared = preparationReads(engine);
  const a = startClaimPhase(Date.now(), new AbortController().signal, 10_000), b = startClaimPhase(Date.now(), new AbortController().signal, 10_000);
  const [readA, readB] = await Promise.all([boundedReads(shared, a).executeRaw(STABLE, ['default']), boundedReads(shared, b).executeRaw(STABLE, ['default'])]);
  expect(readA).toEqual([{ local_path: '/brain' }]);
  expect(readB).toEqual([{ local_path: '/brain' }]);
  expect(calls).toEqual([{ sql: STABLE, opts: undefined }]);
  // An unmemoized read keeps its own bound.
  await boundedReads(shared, a).executeRaw('SELECT id FROM pages WHERE source_id=$1', ['default']);
  expect(calls[1]!.opts!.timeoutMs).toBeGreaterThan(0);
  expect(calls[1]!.opts!.signal).toBe(a.signal);
});
