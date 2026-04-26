import { describe, expect, test } from 'bun:test';
import { mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { SQLiteEngine } from '../src/core/sqlite-engine.ts';
import {
  approveMemoryRedactionPlan,
  applyMemoryRedactionPlan,
  createMemoryRedactionPlan,
  rejectMemoryRedactionPlan,
} from '../src/core/services/memory-redaction-plan-service.ts';

async function createHarness(label: string): Promise<{
  engine: SQLiteEngine;
  cleanup: () => Promise<void>;
}> {
  const dir = mkdtempSync(join(tmpdir(), `mbrain-redaction-plan-service-${label}-`));
  const engine = new SQLiteEngine();
  await engine.connect({ engine: 'sqlite', database_path: join(dir, 'brain.db') });
  await engine.initSchema();
  return {
    engine,
    cleanup: async () => {
      await engine.disconnect().catch(() => undefined);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe('memory redaction plan service', () => {
  test('creates a draft plan with page items and approves it from draft', async () => {
    const harness = await createHarness('create-approve');
    try {
      await harness.engine.putPage('concepts/redaction-target', {
        type: 'concept',
        title: 'Redaction Target',
        compiled_truth: 'The token alpha-secret appears here. [Source: Test, 2026-04-26 10:00 AM KST]',
        timeline: '- 2026-04-26 | alpha-secret was observed. [Source: Test, 2026-04-26 10:00 AM KST]',
      });

      const plan = await createMemoryRedactionPlan(harness.engine, {
        id: 'redaction-plan:test-create',
        scope_id: 'workspace:default',
        query: 'alpha-secret',
        requested_by: 'agent:test',
        source_refs: ['Source: service create test, 2026-04-26 10:00 AM KST'],
      });

      expect(plan).toMatchObject({
        id: 'redaction-plan:test-create',
        scope_id: 'workspace:default',
        query: 'alpha-secret',
        replacement_text: '[REDACTED]',
        status: 'draft',
        requested_by: 'agent:test',
      });
      expect(plan.created_at).toBeInstanceOf(Date);

      const items = await harness.engine.listMemoryRedactionPlanItems({
        plan_id: plan.id,
      });
      expect(items.map((item) => item.field_path).sort()).toEqual(['compiled_truth', 'timeline']);
      expect(items.every((item) => item.target_object_type === 'page')).toBe(true);
      expect(items.every((item) => item.target_object_id === 'concepts/redaction-target')).toBe(true);
      expect(items.every((item) => item.status === 'planned')).toBe(true);
      expect(items.every((item) => item.before_hash && item.after_hash === null)).toBe(true);

      const approved = await approveMemoryRedactionPlan(harness.engine, {
        id: plan.id,
        review_reason: 'Approved by reviewer.',
      });
      expect(approved).toMatchObject({
        id: plan.id,
        status: 'approved',
        review_reason: 'Approved by reviewer.',
      });
      expect(approved.reviewed_at).toBeInstanceOf(Date);

      const events = await harness.engine.listMemoryMutationEvents({
        operation: 'create_redaction_plan',
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        operation: 'create_redaction_plan',
        target_kind: 'ledger_event',
        target_id: plan.id,
        result: 'staged_for_review',
      });
    } finally {
      await harness.cleanup();
    }
  });

  test('rejects blank required fields and supports rejected draft lifecycle', async () => {
    const harness = await createHarness('reject');
    try {
      await expect(createMemoryRedactionPlan(harness.engine, {
        scope_id: 'workspace:default',
        query: '   ',
      })).rejects.toThrow(/query/i);
      await expect(createMemoryRedactionPlan(harness.engine, {
        scope_id: '   ',
        query: 'secret',
      })).rejects.toThrow(/scope_id/i);

      const plan = await createMemoryRedactionPlan(harness.engine, {
        id: 'redaction-plan:test-reject',
        scope_id: 'workspace:default',
        query: 'reject-me',
      });
      const rejected = await rejectMemoryRedactionPlan(harness.engine, {
        id: plan.id,
        review_reason: 'Not enough evidence.',
      });
      expect(rejected).toMatchObject({
        id: plan.id,
        status: 'rejected',
        review_reason: 'Not enough evidence.',
      });
      expect(rejected.reviewed_at).toBeInstanceOf(Date);
      await expect(approveMemoryRedactionPlan(harness.engine, {
        id: plan.id,
      })).rejects.toThrow(/draft/i);
    } finally {
      await harness.cleanup();
    }
  });

  test('apply requires approval and fails closed on unsupported planned items', async () => {
    const harness = await createHarness('unsupported');
    try {
      const unapproved = await createMemoryRedactionPlan(harness.engine, {
        id: 'redaction-plan:test-unapproved',
        scope_id: 'workspace:default',
        query: 'not-approved',
      });
      await expect(applyMemoryRedactionPlan(harness.engine, {
        id: unapproved.id,
      })).rejects.toThrow(/approved/i);

      const unsupported = await createMemoryRedactionPlan(harness.engine, {
        id: 'redaction-plan:test-unsupported',
        scope_id: 'workspace:default',
        query: 'unsupported-secret',
      });
      await harness.engine.createMemoryRedactionPlanItem({
        id: 'redaction-item:test-unsupported',
        plan_id: unsupported.id,
        target_object_type: 'profile_memory',
        target_object_id: 'profile:unsupported',
        field_path: 'content',
        status: 'planned',
        preview_text: 'unsupported-secret',
      });
      await approveMemoryRedactionPlan(harness.engine, { id: unsupported.id });

      await expect(applyMemoryRedactionPlan(harness.engine, {
        id: unsupported.id,
      })).rejects.toThrow(/unsupported/i);
      expect((await harness.engine.getMemoryRedactionPlan(unsupported.id))?.status).toBe('approved');
    } finally {
      await harness.cleanup();
    }
  });

  test('applies page redactions, updates item hashes, and records execute ledger event', async () => {
    const harness = await createHarness('apply-page');
    try {
      await harness.engine.putPage('concepts/redaction-apply-target', {
        type: 'concept',
        title: 'Redaction Apply Target',
        compiled_truth: 'beta-secret appears twice: beta-secret. [Source: Test, 2026-04-26 10:10 AM KST]',
        timeline: '- 2026-04-26 | beta-secret in timeline. [Source: Test, 2026-04-26 10:10 AM KST]',
      });
      const plan = await createMemoryRedactionPlan(harness.engine, {
        id: 'redaction-plan:test-apply',
        scope_id: 'workspace:default',
        query: 'beta-secret',
        replacement_text: '[REMOVED]',
        requested_by: 'agent:test',
        source_refs: ['Source: service apply test, 2026-04-26 10:10 AM KST'],
      });
      await approveMemoryRedactionPlan(harness.engine, {
        id: plan.id,
        review_reason: 'Ready to apply.',
      });

      const applied = await applyMemoryRedactionPlan(harness.engine, {
        id: plan.id,
        actor: 'agent:executor',
        source_refs: ['Source: service apply execution, 2026-04-26 10:11 AM KST'],
      });
      expect(applied.status).toBe('applied');
      expect(applied.applied_at).toBeInstanceOf(Date);

      const page = await harness.engine.getPage('concepts/redaction-apply-target');
      expect(page?.compiled_truth).toContain('[REMOVED] appears twice: [REMOVED].');
      expect(page?.timeline).toContain('[REMOVED] in timeline.');
      expect(page?.compiled_truth).not.toContain('beta-secret');
      expect(page?.timeline).not.toContain('beta-secret');

      const items = await harness.engine.listMemoryRedactionPlanItems({
        plan_id: plan.id,
      });
      expect(items).toHaveLength(2);
      expect(items.every((item) => item.status === 'applied')).toBe(true);
      expect(items.every((item) => item.before_hash && item.after_hash && item.before_hash !== item.after_hash)).toBe(true);

      const events = await harness.engine.listMemoryMutationEvents({
        operation: 'execute_redaction_plan',
        target_id: plan.id,
      });
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        operation: 'execute_redaction_plan',
        target_kind: 'ledger_event',
        target_id: plan.id,
        actor: 'agent:executor',
        result: 'redacted',
        source_refs: ['Source: service apply execution, 2026-04-26 10:11 AM KST'],
        metadata: {
          plan_id: plan.id,
          applied_item_count: 2,
          page_count: 1,
        },
      });
    } finally {
      await harness.cleanup();
    }
  });
});
