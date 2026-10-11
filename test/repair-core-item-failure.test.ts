/**
 * Item failures continue the scan without checkpointing the failed item, like revision_conflict.
 * A catch that falls through to writeCursor breaks retries after an interrupted run.
 * Handler-specific tests do not compare these shared-loop checkpoints; use the existing handler/clock seams.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from 'bun:test';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { OperationError, type OperationContext } from '../src/core/ops/contract.ts';
import { afterCursor, resolveRepairScope, runRepair, type RepairHandler } from '../src/core/repair/core.ts';
import { renderRepairResult, repairExitVerdict } from '../src/commands/repair.ts';

let engine: PGLiteEngine;
beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
}, 60_000);
afterAll(async () => { await engine.disconnect(); });
beforeEach(async () => { await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'"); });

const ctx = (): OperationContext => ({ engine, sourceId: 'default', remote: false, config: { engine: 'pglite', embedding_disabled: true },
  dryRun: false, logger: { info() {}, warn() {}, error() {} } });

function fixture(error: unknown, outcomeItemsLimit?: number, itemCount = 3) {
  const attempted: number[] = [];
  const applied: number[] = [];
  const handler: RepairHandler = {
    kind: 'timeline', publication: 'projection', embeds: false, outcomeItemsLimit,
    async plan(_engine, _scope, after) {
      return { items: Array.from({ length: itemCount }, (_, i) => i + 1).map(id => ({ cursor: { phase: 0, id }, source_id: 'default', slug: `notes/item-${id}`,
        chars: 0, action: 'stub repair' })).filter(item => afterCursor(item.cursor, after)), residuals: {} };
    },
    async apply(_ctx, item) {
      attempted.push(item.cursor.id);
      if (item.cursor.id === 2) throw error;
      applied.push(item.cursor.id);
      return true;
    },
  };
  const run = async (opts: { limit?: number; stopAfter?: number } = {}) => runRepair(ctx(), handler, await resolveRepairScope(engine), {
    apply: true, limit: opts.limit,
    ...(opts.stopAfter !== undefined ? { deadline: 1, now: () => attempted.length >= opts.stopAfter! ? 1 : 0 } : {}),
  });
  return { handler, attempted, applied, run };
}

const checkpoints = () => engine.executeRaw<{ completed_keys: Array<{ cursor: { phase: number; id: number } }> }>(
  "SELECT completed_keys FROM op_checkpoints WHERE op='repair'");

describe('repair item failures', () => {
  for (const code of ['invalid_params', 'source_changed'] as const) {
    test(`${code}: records a redacted failure, applies the later item and completes`, async () => {
      const f = fixture(new OperationError(code, 'Rejected item: password=fixture-secret'));
      const pending = f.run();
      await expect(pending).resolves.toMatchObject({ applied: 2, skipped: 0, complete: true, outcomes: { failed: 1 } });
      const result = await pending;
      expect(f.applied).toEqual([1, 3]);
      expect(f.attempted).toEqual([1, 2, 3]);
      expect(result.outcome_items).toEqual([{ item: 'default:notes/item-2', outcome: 'failed', reason: code,
        detail: { message: expect.stringContaining('<REDACTED:password>') } }]);
      expect(JSON.stringify(result)).not.toContain('fixture-secret');
      expect(result.stopped).toBeUndefined();
      expect(await checkpoints()).toEqual([]);
      expect(renderRepairResult(result)).toContain('  failed 1');
      expect(repairExitVerdict([result])).toBe(1);
    });

    test(`${code}: interruption after a failure keeps the prior cursor and retries the failed item`, async () => {
      const f = fixture(new OperationError(code, 'Rejected item'));
      await expect(f.run({ stopAfter: 2 })).resolves.toMatchObject({ applied: 1, skipped: 0, complete: false,
        outcomes: { failed: 1 }, stopped: { reason: 'time_budget' } });
      expect(f.attempted).toEqual([1, 2]);
      expect((await checkpoints())[0]!.completed_keys[0]!.cursor).toEqual({ phase: 0, id: 1 });
      const resumed = await f.run();
      expect(resumed).toMatchObject({ resumed_from: { phase: 0, id: 1 }, applied: 1, skipped: 0, complete: true,
        outcomes: { failed: 1 } });
      expect(f.attempted).toEqual([1, 2, 2, 3]);
      expect(f.applied).toEqual([1, 3]);
      expect(await checkpoints()).toEqual([]);
    });

    test(`${code}: a limit ending at the failed item keeps the last successful cursor`, async () => {
      const f = fixture(new OperationError(code, 'Rejected item'));
      await expect(f.run({ limit: 2 })).resolves.toMatchObject({ applied: 1, complete: false, outcomes: { failed: 1 } });
      expect((await checkpoints())[0]!.completed_keys[0]!.cursor).toEqual({ phase: 0, id: 1 });
    });

    test(`${code}: a later success advances the cursor before interruption`, async () => {
      const f = fixture(new OperationError(code, 'Rejected item'), undefined, 4);
      await expect(f.run({ stopAfter: 3 })).resolves.toMatchObject({ applied: 2, skipped: 0, complete: false,
        outcomes: { failed: 1 }, stopped: { reason: 'time_budget' } });
      expect(f.attempted).toEqual([1, 2, 3]);
      expect(f.applied).toEqual([1, 3]);
      expect((await checkpoints())[0]!.completed_keys[0]!.cursor).toEqual({ phase: 0, id: 3 });
      await expect(f.run()).resolves.toMatchObject({ resumed_from: { phase: 0, id: 3 }, applied: 1, complete: true });
      expect(f.attempted).toEqual([1, 2, 3, 4]);
      expect(await checkpoints()).toEqual([]);
    });
  }

  test('invalid_params and revision_conflict preserve the same cursor on interruption', async () => {
    const cursors = [];
    for (const code of ['revision_conflict', 'invalid_params'] as const) {
      await engine.executeRaw("DELETE FROM op_checkpoints WHERE op='repair'");
      const f = fixture(new OperationError(code, 'Rejected item'));
      await expect(f.run({ stopAfter: 2 })).resolves.toMatchObject({ complete: false, stopped: { reason: 'time_budget' } });
      expect(f.attempted).toEqual([1, 2]);
      cursors.push((await checkpoints())[0]!.completed_keys[0]!.cursor);
    }
    expect(cursors[0]).toEqual({ phase: 0, id: 1 });
    expect(cursors[1]).toEqual(cursors[0]);
  });

  test('honors a zero outcome item limit while still counting failures', async () => {
    const f = fixture(new OperationError('invalid_params', 'Rejected item'), 0);
    await expect(f.run()).resolves.toMatchObject({ applied: 2, skipped: 0, outcomes: { failed: 1 }, outcome_items: [] });
  });

  test('failure counts accumulate while samples obey default and custom limits', async () => {
    for (const limit of [undefined, 1]) {
      const f = fixture(new OperationError('invalid_params', 'Rejected item'), limit);
      f.handler.plan = async () => ({ items: Array.from({ length: 22 }, (_, id) => ({ cursor: { phase: 0, id: id + 1 },
        source_id: 'default', slug: `notes/item-${id + 1}`, chars: 0, action: 'stub repair' })), residuals: {} });
      f.handler.apply = async () => { throw new OperationError('source_changed', 'Source changed'); };
      const result = await f.run();
      expect(result).toMatchObject({ applied: 0, skipped: 0, complete: true, outcomes: { failed: 22 } });
      expect(result.outcome_items).toHaveLength(limit ?? 20);
      expect(await checkpoints()).toEqual([]);
    }
  });

  test('CLI verdict preserves clean results and stops, and catches failures in any result', () => {
    expect(repairExitVerdict([])).toBe(0);
    expect(repairExitVerdict([{}, { outcomes: { failed: 0, repaired: 2 } }])).toBe(0);
    expect(repairExitVerdict([{ stopped: { reason: 'write_pending', message: 'Pending' } }])).toBe(1);
    expect(repairExitVerdict([{}, { outcomes: { failed: 1 } }, {}])).toBe(1);
  });

  test('revision_conflict remains skipped, without counting a failure', async () => {
    const f = fixture(new OperationError('revision_conflict', 'Page changed'));
    const result = await f.run();
    expect(result).toMatchObject({ applied: 2, skipped: 1, complete: true });
    expect(result.outcomes).toBeUndefined();
    expect(result.outcome_items).toBeUndefined();
    expect(f.applied).toEqual([1, 3]);
  });

  for (const error of [new OperationError('internal_error', 'Unexpected failure'), new Error('Unexpected failure'),
    { code: 'invalid_params', message: 'Not an OperationError' }]) {
    test(`rethrows an unhandled ${error instanceof Error ? error.name : 'plain object'} unchanged`, async () => {
      const f = fixture(error);
      await expect(f.run()).rejects.toBe(error);
      expect(f.attempted).toEqual([1, 2]);
      expect((await checkpoints())[0]!.completed_keys[0]!.cursor).toEqual({ phase: 0, id: 1 });
    });
  }

  for (const code of ['write_pending', 'owner_unavailable', 'writer_lock_unavailable', 'writer_busy'] as const) {
    test(`${code} still stops before the third item and preserves the prior cursor`, async () => {
      const f = fixture(new OperationError(code, 'Wait for writer'));
      const result = await f.run();
      expect(result).toMatchObject({ applied: 1, skipped: 0, complete: false, stopped: { reason: code } });
      expect(result.outcomes).toBeUndefined();
      expect(f.attempted).toEqual([1, 2]);
      expect((await checkpoints())[0]!.completed_keys[0]!.cursor).toEqual({ phase: 0, id: 1 });
    });
  }
});
