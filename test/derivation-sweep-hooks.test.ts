/**
 * The sweep's test seams are read at each use, not once per call: a hook that removes itself while a call is running stops running,
 * and a hook installed meanwhile runs from the next batch. The sweep (`continueDerivationPurges`) reaches the engines through the
 * `continueDerivationSweep` member, and its hooks must follow the globals as they did when the walk read them directly.
 *
 * Authoring gate (docs/TESTING.md#authoring-gate):
 *  - Contract: on PGLite, a hook set with __setAfterDerivationSweepBatchForTests (after each batch) or
 *    __setBeforeUnreadDerivationDeleteForTests (before each unread delete) that clears itself on its first run runs once in a call of
 *    several batches; a hook installed by it runs on the batches after.
 *  - Regression: the member wrapper captured both hooks once, when the call began, so a hook that cleared itself kept running.
 *  - Why existing coverage misses it: the sweep suites install a hook for a whole call and clear it after.
 *  - Seam: the fault point `purge:derivation_batch` (a 57014) sends every batch down the unread-delete path.
 */
import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { __setAfterDerivationSweepBatchForTests, __setBeforeUnreadDerivationDeleteForTests, __setDerivationSweepLimitsForTests, continueDerivationPurges,
  recordDerivationPurge } from '../src/core/page-body/segment-derive.ts';
import { installFaultHook } from '../src/core/persistence/fault-points.ts';
import { publishSegmentedPage, segmentText } from './helpers/page-body-fixtures.ts';

let engine: PGLiteEngine;
beforeAll(async () => { engine = new PGLiteEngine(); await engine.connect({}); await engine.initSchema(); }, 120_000);
afterAll(async () => { await engine.disconnect(); });

let sequence = 0;
/** A recorded sweep over a page with five derivation rows (a row per batch of one), none holding the claim. */
async function recorded(): Promise<string> {
  const request = `f0000000-0000-4000-8000-${String(++sequence).padStart(12, '0')}`;
  const texts = Array.from({ length: 5 }, (_, i) => segmentText(`# part ${sequence}-${i}\nbody ${i}\n`));
  const page = await publishSegmentedPage(engine, `notes/hooks-${sequence}`, texts);
  await engine.upsertSegmentDerivations(texts.map((text, i) => ({ pageId: page.pageId, kind: 'links' as const, occurrenceId: page.occurrences[i]!, version: 1, segmentSha256: text.sha256,
    contextHash: new Uint8Array(32).fill(i + 1), state: 'done' as const, output: { excerpt: 'nothing' }, receipt: {} })));
  await engine.transaction(tx => recordDerivationPurge(tx, request, 'default', [page.pageId], ['Alice likes tea']));
  return request;
}
const timeout = () => Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' });

describe('the sweep reads its test hooks at each use', () => {
  test('an after-batch hook that clears itself runs once, and one it installs runs on the batches after', async () => {
    const request = await recorded();
    let first = 0, second = 0;
    __setDerivationSweepLimitsForTests({ batchRows: 1 });
    __setAfterDerivationSweepBatchForTests(async () => {
      first++;
      __setAfterDerivationSweepBatchForTests(async () => { second++; });
    });
    try { await continueDerivationPurges(engine, 'default', { first: request }); } finally {
      __setAfterDerivationSweepBatchForTests(null);
      __setDerivationSweepLimitsForTests(null);
    }
    expect(first).toBe(1);
    expect(second).toBeGreaterThan(3);
    expect(await engine.readDerivationPurgeState(request)).toBeNull();
  });

  test('a before-unread-delete hook that clears itself runs once', async () => {
    const request = await recorded();
    let runs = 0;
    __setDerivationSweepLimitsForTests({ batchRows: 1 });
    __setBeforeUnreadDerivationDeleteForTests(async () => { runs++; __setBeforeUnreadDerivationDeleteForTests(null); });
    installFaultHook(point => { if (point === 'purge:derivation_batch') throw timeout(); });
    try { await continueDerivationPurges(engine, 'default', { first: request }); } finally {
      installFaultHook(undefined);
      __setBeforeUnreadDerivationDeleteForTests(null);
      __setDerivationSweepLimitsForTests(null);
    }
    expect(runs).toBe(1);
  });
});
