import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { operations } from '../src/core/operations.ts';
import type { Operation, OperationContext } from '../src/core/operations.ts';
import { PGLiteEngine } from '../src/core/pglite-engine.ts';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';

function getOperation(name: string): Operation {
  const operation = operations.find((candidate) => candidate.name === name);
  if (!operation) throw new Error(`Operation not found: ${name}`);
  return operation;
}

async function createSqliteHarness(label: string): Promise<{
  engine: SQLiteEngine;
  ctx: (dryRun?: boolean) => OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-redaction-plan-ops-${label}-`));
  const databasePath = join(dir, 'brain.db');
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: databasePath });
  await engine.initSchema();
  return {
    engine,
    ctx: (dryRun = false) => ({
      engine,
      config: { engine: 'sqlite', database_path: databasePath },
      logger: console,
      dryRun,
    } as unknown as OperationContext),
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

async function createPgliteHarness(label: string): Promise<{
  engine: PGLiteEngine;
  ctx: (dryRun?: boolean) => OperationContext;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-redaction-plan-ops-${label}-`));
  const databasePath = join(dir, 'brain-pglite');
  const engine = new PGLiteEngine();
  await engine.connect({ engine: 'pglite', database_path: databasePath });
  await engine.initSchema();
  return {
    engine,
    ctx: (dryRun = false) => ({
      engine,
      config: { engine: 'pglite', database_path: databasePath },
      logger: console,
      dryRun,
    } as unknown as OperationContext),
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('memory redaction plan operations', () => {
  test('registers redaction plan operations with useful schemas', () => {
    const create = getOperation('create_memory_redaction_plan');
    const get = getOperation('get_memory_redaction_plan');
    const list = getOperation('list_memory_redaction_plans');
    const approve = getOperation('approve_memory_redaction_plan');
    const reject = getOperation('reject_memory_redaction_plan');
    const apply = getOperation('apply_memory_redaction_plan');

    expect(create.mutating).toBe(true);
    expect(create.params.scope_id.required).toBe(true);
    expect(create.params.query.required).toBe(true);
    expect(create.params.replacement_text.type).toBe('string');
    expect(create.params.source_refs.items?.type).toBe('string');

    expect(get.mutating).toBe(false);
    expect(get.params.id.required).toBe(true);

    expect(list.mutating).toBe(false);
    expect(list.params.status.enum).toEqual(['draft', 'approved', 'applied', 'rejected']);
    expect(list.params.limit.default).toBe(100);
    expect(list.params.offset.default).toBe(0);

    expect(approve.mutating).toBe(true);
    expect(approve.params.id.required).toBe(true);
    expect(reject.mutating).toBe(true);
    expect(reject.params.id.required).toBe(true);
    expect(apply.mutating).toBe(true);
    expect(apply.params.id.required).toBe(true);
    expect(apply.params.actor.type).toBe('string');
  });

  test('creates, gets, lists, approves, rejects, and applies through the operation layer', async () => {
    const harness = await createSqliteHarness('lifecycle');
    try {
      await harness.engine.putPage('concepts/redaction-operation-target', {
        type: 'concept',
        title: 'Redaction Operation Target',
        compiled_truth: 'gamma-secret appears here. [Source: Test, 2026-04-26 10:20 AM KST]',
        timeline: '- 2026-04-26 | gamma-secret appears in timeline. [Source: Test, 2026-04-26 10:20 AM KST]',
      });

      const create = getOperation('create_memory_redaction_plan');
      const get = getOperation('get_memory_redaction_plan');
      const list = getOperation('list_memory_redaction_plans');
      const approve = getOperation('approve_memory_redaction_plan');
      const reject = getOperation('reject_memory_redaction_plan');
      const apply = getOperation('apply_memory_redaction_plan');

      const plan = await create.handler(harness.ctx(), {
        id: 'redaction-plan:operation-apply',
        scope_id: 'workspace:default',
        query: 'gamma-secret',
        replacement_text: '[MASKED]',
        requested_by: 'agent:ops',
        source_refs: ['Source: operation create test, 2026-04-26 10:20 AM KST'],
      }) as any;
      expect(plan.status).toBe('draft');

      expect(await get.handler(harness.ctx(), { id: plan.id })).toMatchObject({
        id: plan.id,
        query: 'gamma-secret',
      });
      const listed = await list.handler(harness.ctx(), {
        scope_id: 'workspace:default',
        status: 'draft',
      }) as any[];
      expect(listed.map((entry) => entry.id)).toContain(plan.id);

      const rejectedPlan = await create.handler(harness.ctx(), {
        id: 'redaction-plan:operation-reject',
        scope_id: 'workspace:default',
        query: 'reject-through-ops',
      }) as any;
      expect(await reject.handler(harness.ctx(), {
        id: rejectedPlan.id,
        review_reason: 'Rejected through operation layer.',
      })).toMatchObject({
        id: rejectedPlan.id,
        status: 'rejected',
      });

      expect(await approve.handler(harness.ctx(), {
        id: plan.id,
        review_reason: 'Approved through operation layer.',
      })).toMatchObject({
        id: plan.id,
        status: 'approved',
      });
      expect(await apply.handler(harness.ctx(), {
        id: plan.id,
        actor: 'agent:ops-applier',
        source_refs: ['Source: operation apply test, 2026-04-26 10:21 AM KST'],
      })).toMatchObject({
        id: plan.id,
        status: 'applied',
      });

      const page = await harness.engine.getPage('concepts/redaction-operation-target');
      expect(page?.compiled_truth).toContain('[MASKED]');
      expect(page?.timeline).toContain('[MASKED]');
      expect(page?.compiled_truth).not.toContain('gamma-secret');
      expect(page?.timeline).not.toContain('gamma-secret');
    } finally {
      await harness.cleanup();
    }
  });

  test('dry-run mutating operations return previews without writing', async () => {
    const harness = await createSqliteHarness('dry-run');
    try {
      const create = getOperation('create_memory_redaction_plan');
      const approve = getOperation('approve_memory_redaction_plan');
      const reject = getOperation('reject_memory_redaction_plan');
      const apply = getOperation('apply_memory_redaction_plan');

      const preview = await create.handler(harness.ctx(true), {
        id: 'redaction-plan:dry-run-create',
        scope_id: 'workspace:default',
        query: 'dry-run-secret',
      }) as any;
      expect(preview).toMatchObject({
        action: 'create_memory_redaction_plan',
        dry_run: true,
        plan: {
          id: 'redaction-plan:dry-run-create',
          status: 'draft',
        },
      });
      expect(await harness.engine.getMemoryRedactionPlan('redaction-plan:dry-run-create')).toBeNull();

      await harness.engine.createMemoryRedactionPlan({
        id: 'redaction-plan:dry-run-existing',
        scope_id: 'workspace:default',
        query: 'dry-run-existing',
        status: 'draft',
      });
      expect(await approve.handler(harness.ctx(true), {
        id: 'redaction-plan:dry-run-existing',
      })).toMatchObject({
        action: 'approve_memory_redaction_plan',
        dry_run: true,
        plan: {
          id: 'redaction-plan:dry-run-existing',
          status: 'approved',
        },
      });
      expect((await harness.engine.getMemoryRedactionPlan('redaction-plan:dry-run-existing'))?.status).toBe('draft');

      expect(await reject.handler(harness.ctx(true), {
        id: 'redaction-plan:dry-run-existing',
      })).toMatchObject({
        action: 'reject_memory_redaction_plan',
        dry_run: true,
        plan: {
          id: 'redaction-plan:dry-run-existing',
          status: 'rejected',
        },
      });
      expect((await harness.engine.getMemoryRedactionPlan('redaction-plan:dry-run-existing'))?.status).toBe('draft');

      await harness.engine.updateMemoryRedactionPlanStatus('redaction-plan:dry-run-existing', {
        status: 'approved',
        expected_current_status: 'draft',
        reviewed_at: new Date('2026-04-26T01:30:00.000Z'),
      });
      expect(await apply.handler(harness.ctx(true), {
        id: 'redaction-plan:dry-run-existing',
      })).toMatchObject({
        action: 'apply_memory_redaction_plan',
        dry_run: true,
        plan: {
          id: 'redaction-plan:dry-run-existing',
          status: 'applied',
        },
      });
      expect((await harness.engine.getMemoryRedactionPlan('redaction-plan:dry-run-existing'))?.status).toBe('approved');
    } finally {
      await harness.cleanup();
    }
  });

  test('pglite engine supports redaction plan create and list through operations', async () => {
    const harness = await createPgliteHarness('pglite-create-list');
    try {
      const create = getOperation('create_memory_redaction_plan');
      const list = getOperation('list_memory_redaction_plans');

      const plan = await create.handler(harness.ctx(), {
        id: 'redaction-plan:pglite',
        scope_id: 'workspace:pglite',
        query: 'pglite-secret',
        source_refs: ['Source: pglite redaction operation test, 2026-04-26 10:30 AM KST'],
      }) as any;
      expect(plan).toMatchObject({
        id: 'redaction-plan:pglite',
        scope_id: 'workspace:pglite',
        status: 'draft',
      });

      const listed = await list.handler(harness.ctx(), {
        scope_id: 'workspace:pglite',
      }) as any[];
      expect(listed.map((entry) => entry.id)).toEqual(['redaction-plan:pglite']);
    } finally {
      await harness.cleanup();
    }
  }, 15_000);
});
