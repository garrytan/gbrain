/**
 * Protects explicit atom retries from cancellation, deadline expiry and lease loss.
 * Regression: the retry handler/early return drops controls, or a retry crosses an
 * awaited read and starts model/publication work after cancellation. Existing
 * managed-atoms-retry tests cover replay/holds, not these stop boundaries.
 * No production-only seam: mocked storage/model/lease boundaries, real retry and handler.
 */
import { afterAll, beforeEach, expect, mock, test } from 'bun:test';
import type { BrainEngine } from '../src/core/engine.ts';
import type { MinionJobContext } from '../src/core/minions/types.ts';
import type { WriteReceipt } from '../src/core/persistence/types.ts';

let lock: AbortController;
let sessions = 0, phases = 0, publications = 0;
let read = async () => ({ page: { compiled_truth: 'Synthetic origin' } });
let phase: (opts: any) => Promise<any>;
let publish: () => Promise<WriteReceipt[]>;
let saved = false;
const origin = { kind: 'page', locator: 'notes/example', contentHash: 'same' };
let session: any;
mock.module('../src/core/db-lock.ts', () => ({
  withRefreshingLock: async (_engine: unknown, _id: string, work: (signal: AbortSignal) => Promise<unknown>) => work(lock.signal),
}));
mock.module('../src/core/cycle.ts', () => ({ cycleLockIdFor: (source: string) => `cycle:${source}` }));
mock.module('../src/core/persistence/atom-maintenance.ts', () => ({
  managedAtomSession: async (_engine: unknown, _source: string, _retry: unknown, wait: unknown) => {
    sessions++;
    session = { wait, retry: { origin, expectedCheckpoint: [{ failure: 'malformed' }], rows: saved
      ? [{ slug: 'atoms/example', state: 'failed', page_id: null, intent: { kind: 'managed_atom_page', content: 'Retained', expected_revision: null } }]
      : [{ outcome: { failure: 'malformed' } }] } };
    return session;
  },
  readAtomOrigin: async () => origin,
  atomRetryInputKey: () => 'same',
  resumeManagedAtoms: async () => 'run',
  publishManagedAtoms: async () => { publications++; return publish(); },
}));
mock.module('../src/core/cycle/extract-atoms.ts', () => ({
  runPhaseExtractAtoms: async (_engine: unknown, opts: unknown) => { phases++; return phase(opts); },
}));
const { retryManagedAtomBatch } = await import('../src/core/persistence/atom-retry.ts');
const { makeExtractAtomsDrainHandler } = await import('../src/core/minions/handlers/extract-atoms-drain.ts');
const engine = { readPageSnapshot: async (slug: string) => slug === 'atoms/example' ? null : read() } as unknown as BrainEngine;
const job = (signal: AbortSignal, deadlineAtMs?: number) => ({ id: 42, data: { sourceId: 'default', retryRequestId: 'synthetic-retry' }, signal, deadlineAtMs }) as unknown as MinionJobContext;
const receipt = (state: 'queued' | 'committed'): WriteReceipt => ({ request_id: '11111111-1111-4111-8111-111111111111', state, retry_after_ms: state === 'queued' ? 100 : null });
beforeEach(() => {
  lock = new AbortController(); sessions = phases = publications = 0; saved = false;
  read = async () => ({ page: { compiled_truth: 'Synthetic origin' } });
  phase = async () => ({ status: 'ok' }); publish = async () => [];
});
afterAll(() => mock.restore());

test('handler rejects a pre-aborted explicit retry before storage/model work', async () => {
  const stop = new AbortController(); stop.abort(new Error('caller stopped'));
  await expect(makeExtractAtomsDrainHandler(engine)(job(stop.signal))).rejects.toThrow('caller stopped');
  expect(sessions).toBe(0); expect(phases).toBe(0);
});
test('handler rejects an expired retry deadline before storage/model work', async () => {
  await expect(makeExtractAtomsDrainHandler(engine)(job(new AbortController().signal, Date.now() - 1))).rejects.toThrow(/deadline/i);
  expect(sessions).toBe(0); expect(phases).toBe(0);
});
for (const cause of ['caller', 'lease'] as const) test(`cancellation during the origin read (${cause}) prevents the model rerun`, async () => {
  const caller = new AbortController();
  read = async () => { (cause === 'caller' ? caller : lock).abort(new Error(`${cause} stopped`)); return { page: { compiled_truth: 'Synthetic origin' } }; };
  await expect(makeExtractAtomsDrainHandler(engine)(job(caller.signal))).rejects.toThrow(`${cause} stopped`);
  expect(phases).toBe(0); expect(publications).toBe(0);
});
test('model receives caller/lease cancellation and the deadline-bound shared wait', async () => {
  const caller = new AbortController(); const deadline = Date.now() + 2_000;
  phase = async opts => {
    expect(opts.signal).toBeInstanceOf(AbortSignal);
    expect(opts.attempt.writeWait).toBe(session.wait);
    expect(opts.attempt.writeWait.ms()).toBeLessThanOrEqual(2_000);
    lock.abort(new Error('lease stopped'));
    expect(opts.signal.aborted).toBe(true);
    return { status: 'warn', details: {} };
  };
  await expect(makeExtractAtomsDrainHandler(engine)(job(caller.signal, deadline))).rejects.toThrow('lease stopped');
  expect(phases).toBe(1);
});
// The minion worker aborts job.signal at the deadline (worker.ts timeout timer);
// the retry reports that stop as the deadline and never completes.
test('the worker deadline abort stops an in-flight model and does not complete the retry', async () => {
  const worker = new AbortController(); const deadline = Date.now() + 100;
  const timer = setTimeout(() => worker.abort(new Error('timeout')), deadline - Date.now());
  phase = opts => new Promise(resolve => opts.signal.addEventListener('abort', () => resolve({ status: 'warn', details: {} }), { once: true }));
  await expect(makeExtractAtomsDrainHandler(engine)(job(worker.signal, deadline))).rejects.toThrow(/deadline/i);
  clearTimeout(timer);
  expect(phases).toBe(1);
});
test('a model that returns after the deadline does not complete the retry', async () => {
  const deadline = Date.now() + 50;
  phase = async () => { await new Promise(resolve => setTimeout(resolve, 100)); return { status: 'ok' }; };
  await expect(makeExtractAtomsDrainHandler(engine)(job(new AbortController().signal, deadline))).rejects.toThrow(/deadline/i);
  expect(phases).toBe(1);
});
for (const branch of ['model', 'retained'] as const) for (const state of ['queued', 'committed'] as const) test(`${branch} cancellation retains ${state} write receipts`, async () => {
  const caller = new AbortController(); const receipts = [receipt(state)];
  saved = branch === 'retained';
  phase = async () => { caller.abort(new Error('caller stopped')); return { status: 'ok', details: { write_requests: receipts } }; };
  publish = async () => { caller.abort(new Error('caller stopped')); return receipts; };
  const error = await makeExtractAtomsDrainHandler(engine)(job(caller.signal)).catch(e => e) as Error &
    { write_requests: WriteReceipt[]; code?: string; writeRequest?: WriteReceipt };
  expect(error).toBeInstanceOf(Error);
  expect(error.write_requests).toEqual(receipts);
  if (state === 'queued') { expect(error.code).toBe('write_pending'); expect(error.writeRequest).toEqual(receipts[0]); }
  else { expect(error.name).toBe('AbortError'); expect(error.code).not.toBe('cancelled'); }
});
test('four-argument retry remains compatible and removes caller listeners on success', async () => {
  expect(await retryManagedAtomBatch(engine, 'default', 'synthetic-retry', 'job:old')).toMatchObject({ model_rerun: true });
  const caller = new AbortController();
  const added = mock(caller.signal.addEventListener.bind(caller.signal));
  const removed = mock(caller.signal.removeEventListener.bind(caller.signal));
  caller.signal.addEventListener = added; caller.signal.removeEventListener = removed;
  expect(await makeExtractAtomsDrainHandler(engine)(job(caller.signal))).toMatchObject({ model_rerun: true });
  expect(added.mock.calls.length).toBeGreaterThan(0);
  expect(removed.mock.calls.length).toBe(added.mock.calls.length);
});
