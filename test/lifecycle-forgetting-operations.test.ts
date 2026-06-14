import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { MBrainConfig } from '../src/core/config.ts';
import {
  createLifecycleForgettingStoreForEngine,
  lifecycleSnapshotHash,
} from '../src/core/maintenance/lifecycle-forgetting.ts';
import { type OperationContext, operationsByName } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { createLifecycleForgettingService } from '../src/core/services/lifecycle-forgetting-service.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

const tempPaths: string[] = [];
const NOW = '2026-05-20T12:00:00.000Z';

afterEach(() => {
  while (tempPaths.length > 0) {
    const path = tempPaths.pop();
    if (path) rmSync(path, { recursive: true, force: true });
  }
});

describe('lifecycle forgetting operations', () => {
  test('shared lifecycle operations execute against SQLite local runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-lifecycle-operations-'));
    tempPaths.push(dir);
    const engine = new SQLiteEngine();
    await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
    await engine.initSchema();

    const config: MBrainConfig = {
      engine: 'sqlite',
      database_path: join(dir, 'brain.db'),
      offline: true,
      embedding_provider: 'none',
      query_rewrite_provider: 'none',
    };
    const ctx: OperationContext = {
      engine,
      config,
      dryRun: false,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const store = createLifecycleForgettingStoreForEngine(engine);
    const service = createLifecycleForgettingService({
      store,
      now: () => NOW,
      transaction: (fn) => engine.transaction(async () => fn(store)),
    });
    const policy = await store.upsertForgettingPolicy({
      id: 'forgetting-policy:sqlite-operation-purge',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    await service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:sqlite-operation',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'sqlite operation retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });

    await expect(operationsByName.get_lifecycle_forgetting_report.handler(ctx, { now: NOW }))
      .resolves.toMatchObject({ purge_candidate_count: 1 });
    const plan = await operationsByName.plan_lifecycle_purge.handler(ctx, {
      reason: 'sqlite operation review',
      now: NOW,
    });
    expect(plan).toMatchObject({ items: [{ entity_id: 'assertion:sqlite-operation' }] });
    await expect(operationsByName.restore_lifecycle_memory.handler(ctx, {
      entity_type: 'assertion',
      entity_id: 'assertion:sqlite-operation',
      reason: 'sqlite operation restore',
      now: NOW,
    })).resolves.toMatchObject({ state: { lifecycle_state: 'active' } });
    await service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:sqlite-operation',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'sqlite operation retention elapsed again',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    await expect(operationsByName.purge_lifecycle_memory.handler(ctx, {
      entity_type: 'assertion',
      entity_id: 'assertion:sqlite-operation',
      reason: 'sqlite operation purge without approval',
      now: NOW,
    })).rejects.toThrow('purge_plan_id');
    const approvedPlan = await createApprovedPurgePlan(store, 'assertion', 'assertion:sqlite-operation');
    await expect(operationsByName.purge_lifecycle_memory.handler(ctx, {
      entity_type: 'assertion',
      entity_id: 'assertion:sqlite-operation',
      reason: 'sqlite operation purge',
      purge_plan_id: approvedPlan.id,
      now: NOW,
    })).resolves.toMatchObject({ state: { lifecycle_state: 'purged' } });

    await service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:sqlite-reviewed-operation',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'sqlite reviewed operation retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });
    const reviewedPlan = await operationsByName.plan_lifecycle_purge.handler(ctx, {
      reason: 'sqlite reviewed operation review',
      now: NOW,
    }) as { plan: { id: string }; items: Array<{ entity_id: string }> };
    expect(reviewedPlan.items.map((item) => item.entity_id)).toContain('assertion:sqlite-reviewed-operation');
    await expect(operationsByName.purge_lifecycle_memory.handler(ctx, {
      entity_type: 'assertion',
      entity_id: 'assertion:sqlite-reviewed-operation',
      reason: 'sqlite reviewed operation purge before review',
      purge_plan_id: reviewedPlan.plan.id,
      now: NOW,
    })).rejects.toThrow('approved purge plan');
    await expect(operationsByName.review_lifecycle_purge_plan.handler(ctx, {
      purge_plan_id: reviewedPlan.plan.id,
      decision: 'approve',
      review_reason: 'operator approved reviewed purge plan',
      now: NOW,
    })).resolves.toMatchObject({
      plan: { status: 'approved', reviewed_at: NOW },
      items: expect.arrayContaining([
        expect.objectContaining({ entity_id: 'assertion:sqlite-reviewed-operation', status: 'approved' }),
      ]),
    });
    await expect(operationsByName.purge_lifecycle_memory.handler(ctx, {
      entity_type: 'assertion',
      entity_id: 'assertion:sqlite-reviewed-operation',
      reason: 'sqlite reviewed operation purge',
      purge_plan_id: reviewedPlan.plan.id,
      now: NOW,
    })).resolves.toMatchObject({ state: { lifecycle_state: 'purged' } });

    await engine.disconnect();
  });

  test('shared lifecycle operations execute against PGLite local runtime', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'mbrain-lifecycle-operations-pglite-'));
    tempPaths.push(dir);
    const engine = new PGLiteEngine();
    await engine.connect({ engine: 'pglite', database_path: dir });
    await engine.initSchema();

    const ctx: OperationContext = {
      engine,
      config: {
        engine: 'pglite',
        database_path: dir,
        offline: false,
        embedding_provider: 'none',
        query_rewrite_provider: 'none',
      },
      dryRun: false,
      logger: { info: () => {}, warn: () => {}, error: () => {} },
    };
    const store = createLifecycleForgettingStoreForEngine(engine);
    const service = createLifecycleForgettingService({
      store,
      now: () => NOW,
      transaction: (fn) => engine.transaction(async (txEngine) => fn(createLifecycleForgettingStoreForEngine(txEngine))),
    });
    const policy = await store.upsertForgettingPolicy({
      id: 'forgetting-policy:pglite-operation-purge',
      scope_id: 'workspace:default',
      entity_type: 'assertion',
      purge_eligible: true,
      now: NOW,
    });
    await service.transitionEntity({
      entity_type: 'assertion',
      entity_id: 'assertion:pglite-operation',
      to_lifecycle_state: 'expired',
      policy_id: policy.id,
      reason: 'pglite operation retention elapsed',
      purge_after: '2026-05-20T11:00:00.000Z',
      now: NOW,
    });

    await expect(operationsByName.get_lifecycle_forgetting_report.handler(ctx, { now: NOW }))
      .resolves.toMatchObject({ purge_candidate_count: 1 });
    const reviewedPlan = await operationsByName.plan_lifecycle_purge.handler(ctx, {
      reason: 'pglite operation review',
      now: NOW,
    }) as { plan: { id: string }; items: Array<{ entity_id: string }> };
    await expect(operationsByName.review_lifecycle_purge_plan.handler(ctx, {
      purge_plan_id: reviewedPlan.plan.id,
      decision: 'approve',
      review_reason: 'operator approved pglite purge plan',
      now: NOW,
    })).resolves.toMatchObject({
      plan: { status: 'approved', reviewed_at: NOW },
      items: expect.arrayContaining([
        expect.objectContaining({ entity_id: 'assertion:pglite-operation', status: 'approved' }),
      ]),
    });
    await expect(operationsByName.purge_lifecycle_memory.handler(ctx, {
      entity_type: 'assertion',
      entity_id: 'assertion:pglite-operation',
      reason: 'pglite operation purge without approval',
      now: NOW,
    })).rejects.toThrow('purge_plan_id');
    await expect(operationsByName.purge_lifecycle_memory.handler(ctx, {
      entity_type: 'assertion',
      entity_id: 'assertion:pglite-operation',
      reason: 'pglite operation purge',
      purge_plan_id: reviewedPlan.plan.id,
      now: NOW,
    })).resolves.toMatchObject({ state: { lifecycle_state: 'purged' } });

    await engine.disconnect();
    // PGLite schema/migration replay can exceed 20s on macOS CI runners.
  }, 60_000);
});

async function createApprovedPurgePlan(
  store: ReturnType<typeof createLifecycleForgettingStoreForEngine>,
  entityType: string,
  entityId: string,
) {
  const state = await store.getLifecycleState(entityType, entityId);
  const plan = await store.createPurgePlan({
    id: `purge-plan:operation:${entityType}:${entityId}:${crypto.randomUUID()}`,
    scope_id: 'workspace:default',
    status: 'approved',
    reason: 'approved operation purge review',
    requested_by: 'test',
    created_at: NOW,
  });
  await store.createPurgePlanItem({
    plan_id: plan.id,
    entity_type: entityType,
    entity_id: entityId,
    lifecycle_state: 'expired',
    status: 'approved',
    purge_after: '2026-05-20T11:00:00.000Z',
    before_hash: state ? lifecycleSnapshotHash(state) : null,
    created_at: NOW,
  });
  return plan;
}
