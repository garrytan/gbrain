/**
 * loops_close `source_id` param (#4848) — coverage-audit additions to
 * test/ops-loops.test.ts. Two branches that file leaves unpinned:
 *
 *   1. trusted local caller + explicit source_id: the write is scoped to the
 *      named source (a loop in a sibling source is NOT closed), not unscoped.
 *   2. remote caller with the shipped SCALAR scope (ctx.sourceId, no
 *      allowedSources) + explicit source_id: denied outside the scalar grant
 *      with no write; allowed when it equals the grant.
 *
 * Synthetic data only.
 */
import { describe, expect, test, beforeAll, afterAll, beforeEach } from 'bun:test';

import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { resetPgliteState } from './helpers/reset-pglite.ts';
import { loopsOperations } from '../src/core/ops/loops.ts';
import type { OperationContext } from '../src/core/ops/contract.ts';
import { listOpenLoops, upsertOpenLoop, type OpenLoopUpsert } from '../src/core/loops/loops-store.ts';

let engine: PGLiteEngine;

beforeAll(async () => {
  engine = new PGLiteEngine();
  await engine.connect({});
  await engine.initSchema();
});

afterAll(async () => {
  await engine.disconnect();
});

beforeEach(async () => {
  await resetPgliteState(engine);
  // open_loops.source_id FKs sources(id): seed both sibling sources.
  await engine.executeRaw(
    `INSERT INTO sources (id, name, config, last_sync_at)
     VALUES ('g1', 'g1', '{"kind":"google"}'::jsonb, now()),
            ('g2', 'g2', '{"kind":"google"}'::jsonb, now())
     ON CONFLICT (id) DO NOTHING`,
  );
});

const loopsCloseOp = loopsOperations.find((o) => o.name === 'loops_close')!;

function ctx(over: Partial<OperationContext> = {}): OperationContext {
  return {
    engine,
    config: {} as OperationContext['config'],
    logger: { info() {}, warn() {}, error() {} },
    dryRun: false,
    remote: false,
    sourceId: 'g1',
    ...over,
  } as OperationContext;
}

function loop(over: Partial<OpenLoopUpsert> = {}): OpenLoopUpsert {
  return {
    sourceId: 'g1',
    dedupKey: `thread:${over.threadId ?? '18c2f4a9b3d21e07'}:${over.loopType ?? 'unanswered_inbound'}`,
    loopType: 'unanswered_inbound',
    counterpartyEmail: 'bob@example.com',
    summary: 'Reply owed to bob@example.com: "Quarterly plan" (2d)',
    evidence: [{ message_id: '18c2f4a9b3d21e07', quote: 'Can you review the plan?' }],
    threadId: '18c2f4a9b3d21e07',
    detector: 'deterministic_thread',
    ...over,
  };
}

async function openIn(sourceId: string): Promise<number> {
  return (await listOpenLoops(engine, { sourceIds: [sourceId], status: 'open' })).length;
}

describe('loops_close source_id (#4848)', () => {
  test('trusted local + explicit source_id scopes the write to that source, not the sibling', async () => {
    const { id: inG1 } = await upsertOpenLoop(engine, loop());
    const { id: inG2 } = await upsertOpenLoop(engine, loop({ sourceId: 'g2' }));

    // Naming g2 while pointing at the g1 loop: no row matches, nothing closes.
    const miss = (await loopsCloseOp.handler(ctx(), { id: inG1, status: 'done', source_id: 'g2' })) as {
      closed: boolean;
      reason?: string;
    };
    expect(miss.closed).toBe(false);
    expect(miss.reason).toBe('not_found_or_already_closed');
    expect(await openIn('g1')).toBe(1);
    expect(await openIn('g2')).toBe(1);

    // Naming g2 for the g2 loop closes it — and only it — even though the
    // routed ctx.sourceId is g1.
    const hit = (await loopsCloseOp.handler(ctx(), { id: inG2, status: 'done', source_id: 'g2' })) as {
      closed: boolean;
      id: number;
    };
    expect(hit.closed).toBe(true);
    expect(hit.id).toBe(inG2);
    expect(await openIn('g2')).toBe(0);
    expect(await openIn('g1')).toBe(1);
  });

  test('remote SCALAR-scoped caller: explicit source_id outside the scalar grant → permission_denied, no write; equal to the grant → closes', async () => {
    const { id: inG1 } = await upsertOpenLoop(engine, loop());
    const { id: inG2 } = await upsertOpenLoop(engine, loop({ sourceId: 'g2' }));

    // Shipped default transport shape: ctx.sourceId only, no allowedSources.
    await expect(
      loopsCloseOp.handler(ctx({ remote: true, sourceId: 'g1' }), { id: inG2, status: 'done', source_id: 'g2' }),
    ).rejects.toThrow(/permission_denied|outside the caller's scope/);
    expect(await openIn('g2')).toBe(1);

    const ok = (await loopsCloseOp.handler(ctx({ remote: true, sourceId: 'g1' }), {
      id: inG1,
      status: 'dropped',
      source_id: 'g1',
    })) as { closed: boolean; status: string };
    expect(ok.closed).toBe(true);
    expect(ok.status).toBe('dropped');
    expect(await openIn('g1')).toBe(0);
    expect(await openIn('g2')).toBe(1);
  });
});
