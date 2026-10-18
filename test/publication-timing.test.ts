/**
 * #6712 PR 3 (L6): publication step timing.
 *
 * Protects: each timed step adds to its process-local total whether it
 * resolves or throws (the error still reaches the caller); nothing is printed
 * unless GBRAIN_SYNC_TRACE is set, and then one line per step names the step and
 * the page. The wiring into the publication transaction is pinned by
 * test/managed-import-statement-budget.test.ts.
 */
import { afterEach, expect, spyOn, test } from 'bun:test';
import { publicationStepTotals, timePublicationStep } from '../src/core/persistence/publication-timing.ts';
import { withEnv } from './helpers/with-env.ts';

const writes: string[] = [];
const spy = spyOn(process.stderr, 'write').mockImplementation(((chunk: string | Uint8Array) => { writes.push(String(chunk)); return true; }) as typeof process.stderr.write);
afterEach(() => { writes.length = 0; });

test('a timed step adds to its total and prints nothing by default', async () => {
  const before = publicationStepTotals();
  await withEnv({ GBRAIN_SYNC_TRACE: undefined }, async () => {
    expect(await timePublicationStep('apply', 'notes/a', async () => { await Bun.sleep(5); return 7; })).toBe(7);
  });
  const after = publicationStepTotals();
  expect(after.apply.count).toBe(before.apply.count + 1);
  expect(after.apply.ms - before.apply.ms).toBeGreaterThanOrEqual(4);
  expect(after.effects).toEqual(before.effects);
  expect(writes.filter(line => line.startsWith('[sync] publish'))).toEqual([]);
});

test('a step that throws still counts and rethrows; GBRAIN_SYNC_TRACE prints one line per step', async () => {
  const before = publicationStepTotals();
  await withEnv({ GBRAIN_SYNC_TRACE: '1' }, async () => {
    await expect(timePublicationStep('effects', 'notes/b', async () => { throw new Error('refused'); })).rejects.toThrow('refused');
  });
  expect(publicationStepTotals().effects.count).toBe(before.effects.count + 1);
  expect(writes.filter(line => line.startsWith('[sync] publish'))).toEqual([expect.stringMatching(/^\[sync\] publish effects notes\/b: \d+ms\n$/)]);
  spy.mockRestore();
});
